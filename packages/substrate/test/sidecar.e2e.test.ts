/**
 * A real sidecar, end to end: install the runtime from npmjs into a temp HOME,
 * write a stack directory, boot `substrate serve` on the memory store on an
 * ephemeral port, check the schema and one write, and stop it.
 *
 * Gated: runs only with SWARM_SDK_E2E=1, because it downloads Substrate and
 * cortext from npmjs (the one test allowed the network). No Docker, no
 * Postgres. The plugin tarball is the CLI's asset; build it first with
 * `bash scripts/pack-substrate-plugin.sh` (the CLI's prebuild does too).
 *
 * SWARM_E2E_KEEP=1 keeps the temp HOME for inspection.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubstrateClient } from "../src/client.js";
import type { EmbedderSettings } from "../src/embedder-settings.js";
import { ensureTypesRegistered, DEFAULT_CONTEXT_NAMESPACE } from "../src/lifecycle/ready.js";
import {
  CORTEXT_VERSION,
  defaultRuntimeDir,
  ensureRuntimeInstalled,
  resolveNode,
  SUBSTRATE_VERSION,
} from "../src/lifecycle/runtime.js";
import { ensureSidecar, processInfo, stopSidecar } from "../src/lifecycle/sidecar.js";
import { SIDECAR_SPECS, type SidecarSpec, sidecarUrl } from "../src/lifecycle/specs.js";
import { ensureStackDir } from "../src/lifecycle/stacks.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const TARBALL = join(HERE, "..", "..", "cli", "assets", "swarm-substrate-plugin.tgz");
const DEFAULT_PORTS = [32337, 32338, 32339, 32340, 32341];

/** A port nothing listens on: bind 0, read it, close. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!RUN_E2E)("a real Substrate sidecar from an npm-installed runtime", () => {
  let savedHome: string | undefined;
  let home: string;
  let spec: SidecarSpec;
  let pid: number | null = null;

  beforeAll(async () => {
    savedHome = process.env.HOME;
    // realpath: macOS's tmpdir is a /var -> /private/var symlink.
    home = realpathSync(mkdtempSync(join(tmpdir(), "swarm-substrate-e2e-")));
    process.env.HOME = home;
    const cold = SIDECAR_SPECS.find((s) => s.label === "cold") as SidecarSpec;
    spec = { ...cold, port: await freePort(), postgresUrl: "memory" };
    expect(DEFAULT_PORTS).not.toContain(spec.port);
  });

  afterAll(async () => {
    if (pid !== null && processInfo(pid).alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (process.env.SWARM_E2E_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  });

  it(
    "installs the runtime, boots the cold sidecar on memory, serves swarm's schema, and stops leaving no process",
    async () => {
      expect(existsSync(TARBALL), `${TARBALL} — run bash scripts/pack-substrate-plugin.sh`).toBe(true);
      const node = await resolveNode();

      const installStarted = Date.now();
      const runtime = await ensureRuntimeInstalled({
        runtimeDir: defaultRuntimeDir(),
        pluginTarball: TARBALL,
        substrateVersion: SUBSTRATE_VERSION,
        cortextVersion: CORTEXT_VERSION,
        quiet: false,
        nodePath: node.path,
      });
      const installMs = Date.now() - installStarted;
      console.log(`[e2e] runtime install took ${(installMs / 1000).toFixed(1)}s (node ${node.version} at ${node.path})`);
      expect(runtime.runtimeDir).toBe(join(home, ".swarm", "substrate", "runtime"));
      expect(existsSync(runtime.substrateBin)).toBe(true);
      expect(existsSync(runtime.installedMarker)).toBe(true);
      expect(existsSync(join(runtime.runtimeDir, ".npmrc"))).toBe(false);

      // Resolved from npmjs: the GitHub Packages scope rule never applied (no 401).
      const lock = JSON.parse(readFileSync(join(runtime.runtimeDir, "package-lock.json"), "utf8")) as {
        packages: Record<string, { version?: string; resolved?: string }>;
      };
      for (const [pkg, version] of [
        ["@mnmal-ai/substrate", SUBSTRATE_VERSION],
        ["@mnmal-ai/cortext", CORTEXT_VERSION],
      ] as const) {
        const entry = lock.packages[`node_modules/${pkg}`];
        expect(entry?.version, pkg).toBe(version);
        expect(entry?.resolved, pkg).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      }

      // A second call is the marker no-op.
      const again = Date.now();
      expect(
        await ensureRuntimeInstalled({
          runtimeDir: defaultRuntimeDir(),
          pluginTarball: TARBALL,
          substrateVersion: SUBSTRATE_VERSION,
          cortextVersion: CORTEXT_VERSION,
          quiet: true,
          nodePath: node.path,
        }),
      ).toEqual(runtime);
      expect(Date.now() - again).toBeLessThan(5_000);

      // An Ollama nobody serves: the recall config must still be one Substrate accepts at boot.
      const embedder: EmbedderSettings = {
        kind: "ollama",
        baseUrl: `http://127.0.0.1:${await freePort()}`,
        model: "nomic-embed-text",
        dimension: 768,
        timeoutMs: 15_000,
        embedOnWrite: false,
      };
      const stackDir = ensureStackDir(spec, {
        runtimeDir: runtime.runtimeDir,
        embedder,
        contextNamespace: DEFAULT_CONTEXT_NAMESPACE,
      });
      expect(stackDir).toBe(join(home, ".swarm", "substrate", "stacks", "cold"));

      const bootStarted = Date.now();
      const status = await ensureSidecar(spec, { node: node.path, runtime, stackDir, quiet: false });
      console.log(`[e2e] sidecar boot took ${((Date.now() - bootStarted) / 1000).toFixed(1)}s`);
      pid = status.pid;
      expect(status).toMatchObject({ label: "cold", endpoint: sidecarUrl(spec), started: true });
      expect(pid).toBeGreaterThan(0);

      // The loader followed the node_modules symlink: swarm, swarm-docs and the four ops are served.
      const client = new SubstrateClient(sidecarUrl(spec));
      await ensureTypesRegistered(client, [spec], false);
      // cortext loaded beside it (the drainstop's promotion target).
      const cortext = await fetch(`${sidecarUrl(spec)}/substrate/v1/schema/${DEFAULT_CONTEXT_NAMESPACE}`);
      expect(cortext.status).toBe(200);
      // One real write through the shared op-key.
      const observed = await client.observe({ kind: "architectural", content: "e2e observation", tags: ["e2e"] });
      expect(observed?.id).toBeTruthy();

      // Substrate pages an unlimited list read; the client follows the cursor.
      const frames = Array.from({ length: 105 }, (_, i) => ({
        params: { key: `e2e_${i}`, value: String(i), category: "e2e" },
        fields: { id: true },
      }));
      const created = (await (
        await fetch(`${sidecarUrl(spec)}/substrate/v1/mutate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ "swarm/createSwarmConfig": frames }),
        })
      ).json()) as { errors?: unknown[] };
      expect(created.errors ?? []).toEqual([]);
      const onePage = (await (
        await fetch(`${sidecarUrl(spec)}/substrate/v1/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ "swarm/SwarmConfig": { params: { where: { category: { eq: "e2e" } } }, fields: { id: true } } }),
        })
      ).json()) as { data: Record<string, unknown[]>; _pagination?: Record<string, { hasMore: boolean }> };
      expect(onePage.data["swarm/SwarmConfig"].length).toBeLessThan(105);
      expect(onePage._pagination?.["swarm/SwarmConfig"]?.hasMore).toBe(true);
      const all = await client.query<{ key: string }>("SwarmConfig", { where: { category: { eq: "e2e" } } }, { key: true });
      expect(all).toHaveLength(105);
      expect(new Set(all.map((r) => r.key)).size).toBe(105);

      // Idempotency: the same mutate sent twice with the same idempotencyKey (beside
      // params, as the client sends it) writes one row and answers the first id.
      const idempotent = {
        "swarm/createSwarmConfig": {
          params: { key: "idem", value: "1", category: "e2e-idem" },
          fields: { id: true },
          idempotencyKey: randomUUID(),
        },
      };
      const send = async () =>
        (await (
          await fetch(`${sidecarUrl(spec)}/substrate/v1/mutate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(idempotent),
          })
        ).json()) as { data: Record<string, { id: string }>; errors?: unknown[] };
      const firstWrite = await send();
      const replay = await send();
      expect(firstWrite.errors ?? []).toEqual([]);
      expect(replay.errors ?? []).toEqual([]);
      expect(replay.data["swarm/createSwarmConfig"].id).toBe(firstWrite.data["swarm/createSwarmConfig"].id);
      expect(await client.query("SwarmConfig", { where: { category: { eq: "e2e-idem" } } }, { id: true })).toHaveLength(1);
      // The client's batchMutate puts ONE key on every entry; the engine accepts it.
      const batch = await client.batchMutate([
        { mutationName: "createSwarmConfig", params: { key: "batch", value: "1", category: "e2e-batch" } },
        {
          mutationName: "createLearningEntry",
          params: { projectId: "e2e", goalId: "g", category: "e2e", content: "c", timestamp: new Date().toISOString() },
        },
      ]);
      expect(Object.keys(batch).sort()).toEqual(["swarm/createLearningEntry", "swarm/createSwarmConfig"]);

      const tree = execFileSync(
        "find",
        [home, "(", "-path", `${runtime.runtimeDir}/node_modules`, "-o", "-path", join(home, ".npm"), ")", "-prune", "-o", "-print"],
        {
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n")
        .map((p) => relative(home, p) || ".")
        .sort();
      console.log(`[e2e] temp HOME tree:\n${tree.join("\n")}`);

      const stopped = await stopSidecar(spec);
      expect(stopped).toEqual({ stopped: true, pid });
      // kill -0 fails: no process is left. This test process spawned the
      // sidecar, so the exited child lingers as a zombie until Node reaps it on
      // a later event-loop turn; give that up to 2 s.
      const reapDeadline = Date.now() + 2_000;
      while (Date.now() < reapDeadline && processAlive(pid as number)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(() => process.kill(pid as number, 0)).toThrow();
      expect(existsSync(join(stackDir, "server.pid"))).toBe(false);
    },
    900_000,
  );
});
