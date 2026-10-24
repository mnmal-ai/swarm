/**
 * Vitest globalSetup, and the shared test-sidecar helper: isolate swarm's own
 * test runs from the live Substrate stack by spawning private `substrate serve`
 * processes for the test run.
 *
 * `setup()` (the default export) is a no-op unless `SWARM_SDK_E2E=1`: a plain
 * run starts no process and sets no variable. With it, it starts two sidecars
 * from the workspace's own Substrate install and points the TEST PROCESS ONLY
 * at them, by setting on `process.env`:
 *
 *   SWARM_SUBSTRATE_ENDPOINT / SWARM_SUBSTRATE_PORT   the cold sidecar (swarm, swarm-docs, cortext)
 *   SWARM_META_ENDPOINT / SWARM_META_PORT             the meta sidecar (swarm_meta)
 *   SWARM_SUBSTRATE_TEST_RECALL                       "ollama" or "none" (see below)
 *   SWARM_SUBSTRATE_TEST_CORTEXT                      "1" when cortext is loaded in the cold sidecar
 *
 * Nothing is exported to a shell, written to a dotfile, or read from ~/.swarm:
 * each sidecar runs with HOME set to the run's temp directory, and the stack
 * layout below is written there, never under ~/.swarm/substrate.
 *
 * Store: `SUBSTRATE_DATABASE_URL=memory` by default. With `SWARM_SDK_PG=1` the
 * sidecars run on the alt-port docker test stack instead (docker-compose.test.yml:
 * Postgres on 42337 and 42340, brought up with `docker compose up -d --wait`).
 * The URLs come from `testPostgresUrl()` (`./test-postgres.ts`): only
 * `SWARM_TEST_POSTGRES_URL` / `SWARM_TEST_META_POSTGRES_URL` can override them,
 * and only with a loopback URL on the test stack's port. The production
 * `SWARM_SUBSTRATE_POSTGRES_URL` / `SWARM_META_POSTGRES_URL` are never read.
 *
 * Ports: always ephemeral (bind 127.0.0.1:0, read, close). Never 31337-31341
 * (the pre-Substrate live stack), 32337-32341 (the live Substrate stack), or the
 * alt-port test ranges 41337-41341 / 42337-42341.
 *
 * Layout of one run (`<tmp>/swarm-substrate-test-XXXXXX/`):
 *
 *   home/                     HOME for both sidecars
 *   cold/                     SUBSTRATE_PLUGIN_DIR of the cold sidecar
 *     package.json            dependencies: @mnmal-ai/substrate, @mnmal-ai/swarm-substrate-plugin
 *                             (+ @mnmal-ai/cortext when it is installed in the workspace)
 *     swarm.config.json       { scope: "cold", namespace: "swarm", contextNamespace: "cortext" }
 *     substrate-recall.config.json   only when an embedder is wired (see Recall)
 *     node_modules/@mnmal-ai/substrate              -> <repo>/node_modules/@mnmal-ai/substrate
 *     node_modules/@mnmal-ai/swarm-substrate-plugin -> <repo>/packages/substrate-plugin (built)
 *     node_modules/@mnmal-ai/cortext                -> <repo>/node_modules/@mnmal-ai/cortext
 *     server.log, server.pid
 *   meta/                     the same for the meta sidecar (scope "meta", no cortext, no recall)
 *
 * Each sidecar is `node <cold|meta>/node_modules/@mnmal-ai/substrate/dist/substrate.js serve`
 * with `SUBSTRATE_SYSTEM_ACTOR=swarm-test`, `HOST=127.0.0.1`, an ephemeral
 * `PORT` and no auth. It counts as ready once ITS OWN log says it is listening
 * on that port and the port answers `/health` and publishes the expected
 * namespaces; a sidecar that lost its port to a sibling is started again on a
 * new one.
 *
 * Orphan safety: every child is tracked the moment it is spawned. Each
 * `startTestSubstrate()` arms SIGINT/SIGTERM handlers and an `exit` hook BEFORE
 * it spawns, so an interrupted run kills its sidecars; `stopTestSubstrate()`
 * with no argument stops every pair this module started, including one whose
 * boot is still in flight (a suite's `afterAll` after a `beforeAll` timeout).
 * Teardown sends SIGTERM, then SIGKILL after 5 s.
 *
 * Recall: when `http://127.0.0.1:11434/api/tags` answers within 1 s and lists
 * `nomic-embed-text`, the cold sidecar gets an Ollama embedder
 * (`nomic-embed-text`, dimension 768). Otherwise there is no recall config
 * (`none`), and suites that need recall skip with {@link RECALL_SKIP_REASON}.
 * `SWARM_TEST_RECALL=none` forces `none`.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveNode, type SidecarSpec, sidecarEnv, sidecarHealthy } from "@mnmal-ai/swarm-substrate";
import { testPostgresUrl } from "./test-postgres.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
/** tests/setup/isolated-substrate.ts -> the repo root is two levels up. */
export const REPO_ROOT = resolve(HERE, "..", "..");
const COMPOSE_FILE = join(REPO_ROOT, "docker-compose.test.yml");
const SUBSTRATE_PACKAGE = join(REPO_ROOT, "node_modules", "@mnmal-ai", "substrate");
const PLUGIN_PACKAGE = join(REPO_ROOT, "packages", "substrate-plugin");
const CORTEXT_PACKAGE = join(REPO_ROOT, "node_modules", "@mnmal-ai", "cortext");

/** The message recall-dependent suites skip with when the run has no embedder. */
export const RECALL_SKIP_REASON = "recall suites need Ollama";

/** The message sidecar-backed suites skip with outside an E2E run. */
export const E2E_SKIP_REASON = "needs SWARM_SDK_E2E=1";

const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = "nomic-embed-text";
const OLLAMA_DIMENSION = 768;
const OLLAMA_PROBE_MS = 1_000;

/** Ports a test sidecar must never take: the live stacks and the alt-port test stacks. */
export const RESERVED_PORTS: ReadonlySet<number> = new Set<number>(
  [31337, 32337, 41337, 42337].flatMap((base) => [0, 1, 2, 3, 4].map((offset) => base + offset)),
);

const BOOT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 30;
/** How often a sidecar is started again on a new port when a sibling took its port. */
const PORT_RACE_RETRIES = 3;

export interface OllamaRecall {
  baseUrl: string;
  model: string;
  dimension: number;
}

export interface TestSubstrateOptions {
  /**
   * The cold sidecar's embedder: `"auto"` (default) wires local Ollama when it
   * answers, `"none"` runs without one, an object wires that Ollama exactly.
   */
  recall?: "auto" | "none" | OllamaRecall;
  /** Start the meta sidecar too. Default true. */
  meta?: boolean;
  /** Load cortext into the cold sidecar when the workspace has it installed. Default true. */
  cortext?: boolean;
  /**
   * Postgres URLs for the sidecars instead of the memory store (meta stays on
   * memory when omitted). Each must pass `testPostgresUrl`'s checks: loopback,
   * on the test stack's port.
   */
  postgres?: { cold: string; meta?: string };
  /** How long each sidecar gets to answer `/health` and publish its schema. Default 30 s. */
  bootTimeoutMs?: number;
}

export interface TestSidecar {
  label: "cold" | "meta";
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  /** The sidecar's SUBSTRATE_PLUGIN_DIR (also its cwd, log and pid directory). */
  dir: string;
  pid: number;
  logFile: string;
  /** Milliseconds from spawn to a published swarm schema. */
  bootMs: number;
}

export interface TestSubstrate {
  /** The run's temp directory (see the module doc for its layout). */
  root: string;
  cold: TestSidecar;
  meta: TestSidecar | null;
  recall: "ollama" | "none";
  cortext: boolean;
  /** Stop both sidecars and remove the temp directory. Idempotent, never rejects. */
  stop(): Promise<void>;
}

/** One spawned sidecar process, tracked from the moment it exists. */
interface Child {
  process: ChildProcess;
  exited: Promise<void>;
  /** Set once the process has exited (or failed to spawn): the reason. */
  exit?: string;
}

/**
 * One `startTestSubstrate()` call: its temp root and every child it spawned,
 * registered before the first spawn so it can be stopped while still booting.
 */
interface Session {
  root: string;
  children: Set<Child>;
  stopped: boolean;
  stop(): Promise<void>;
}

const sessions = new Set<Session>();

// --- Orphan safety: signal and exit hooks, armed while any session lives ------

let armed = false;

/** SIGKILL every tracked child and remove the temp roots, synchronously. */
function killAllNow(): void {
  for (const session of sessions) {
    session.stopped = true;
    for (const child of session.children) {
      try {
        child.process.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    if (process.env.SWARM_E2E_KEEP !== "1") rmSync(session.root, { recursive: true, force: true });
  }
}

function onSignal(signal: NodeJS.Signals): void {
  killAllNow();
  disarm();
  // Our listener suppressed the default action; re-raise when nobody else
  // handles the signal, so the process still ends the way it was asked to.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
const onSigint = (): void => onSignal("SIGINT");
const onSigterm = (): void => onSignal("SIGTERM");

function arm(): void {
  if (armed) return;
  armed = true;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", killAllNow);
}

function disarm(): void {
  if (!armed) return;
  armed = false;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.removeListener("exit", killAllNow);
}

// --- Helpers ------------------------------------------------------------------

/** A free loopback port outside {@link RESERVED_PORTS}. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((done) => server.close(() => done()));
    if (port > 0 && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("isolated-substrate: no free ephemeral port outside the reserved ranges after 20 tries");
}

/** Whether local Ollama answers `/api/tags` within 1 s and has the embedding model. */
export async function probeOllama(baseUrl = OLLAMA_URL, model = OLLAMA_MODEL): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_PROBE_MS) });
    if (!response.ok) return false;
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (body.models ?? []).some((m) => (m.name ?? m.model ?? "").split(":")[0] === model);
  } catch {
    return false;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "dir");
}

/** Write one sidecar's SUBSTRATE_PLUGIN_DIR. */
function writePluginDir(
  dir: string,
  scope: "cold" | "meta",
  opts: { cortext: boolean; recall: OllamaRecall | null },
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(join(dir, "package.json"), {
    private: true,
    dependencies: {
      "@mnmal-ai/substrate": "*",
      "@mnmal-ai/swarm-substrate-plugin": "*",
      ...(opts.cortext ? { "@mnmal-ai/cortext": "*" } : {}),
    },
  });
  writeJson(join(dir, "swarm.config.json"), { scope, namespace: "swarm", contextNamespace: "cortext" });
  if (opts.recall !== null) {
    writeJson(join(dir, "substrate-recall.config.json"), {
      embedder: {
        kind: "ollama",
        baseUrl: opts.recall.baseUrl,
        model: opts.recall.model,
        dimension: opts.recall.dimension,
      },
      writeEmbedTimeoutMs: 120_000,
      queryEmbedTimeoutMs: 15_000,
    });
  }
  link(SUBSTRATE_PACKAGE, join(dir, "node_modules", "@mnmal-ai", "substrate"));
  link(PLUGIN_PACKAGE, join(dir, "node_modules", "@mnmal-ai", "swarm-substrate-plugin"));
  if (opts.cortext) link(CORTEXT_PACKAGE, join(dir, "node_modules", "@mnmal-ai", "cortext"));
}

function readLog(logFile: string): string {
  try {
    return readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
}

function logTail(logFile: string): string {
  const text = readLog(logFile).trimEnd();
  return text === "" ? "(no log)" : text.split("\n").slice(-LOG_TAIL_LINES).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** GET `<url>/substrate/v1/schema/<ns>` answered 200. */
async function servesNamespace(url: string, ns: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/substrate/v1/schema/${encodeURIComponent(ns)}`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function stopChild(child: Child): Promise<void> {
  if (child.exit !== undefined) return;
  try {
    child.process.kill("SIGTERM");
  } catch {
    /* gone */
  }
  const gone = await Promise.race([child.exited.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
  if (!gone) {
    try {
      child.process.kill("SIGKILL");
    } catch {
      /* gone */
    }
    await Promise.race([child.exited, sleep(2_000)]);
  }
}

// --- Spawning -----------------------------------------------------------------

interface SpawnArgs {
  session: Session;
  label: "cold" | "meta";
  dir: string;
  home: string;
  node: string;
  databaseUrl: string;
  namespaces: string[];
  bootTimeoutMs: number;
}

/** The port was taken between {@link freePort} and the bind: start again on another. */
class PortTakenError extends Error {}

/**
 * {@link spawnOnce} on a fresh ephemeral port, again when a sibling took the
 * port between pick and bind (parallel suites pick ports at the same time).
 */
async function spawnSidecar(args: SpawnArgs): Promise<TestSidecar> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await spawnOnce(args);
    } catch (err) {
      if (!(err instanceof PortTakenError) || attempt >= PORT_RACE_RETRIES) throw err;
    }
  }
}

/**
 * Spawn one sidecar and wait until its own log says it is listening on the
 * port, the port answers `/health`, and it publishes `namespaces`. A child that
 * exits on the way (or right after looking ready) because the port was in use
 * throws {@link PortTakenError}; any other exit fails with the log tail.
 */
async function spawnOnce(args: SpawnArgs): Promise<TestSidecar> {
  const { label, dir, session } = args;
  if (session.stopped) throw new Error(`isolated-substrate: stopped before the ${label} sidecar started`);
  const port = await freePort();
  const spec: SidecarSpec = {
    label,
    port,
    namespace: label === "cold" ? "swarm" : "swarm_meta",
    scope: label,
    postgresUrl: args.databaseUrl,
  };
  // sidecarEnv strips every inherited SUBSTRATE_*,
  // HOST and PORT, then sets the store, plugin dir, actor, host and port.
  const env = sidecarEnv(spec, dir);
  env.SUBSTRATE_SYSTEM_ACTOR = "swarm-test";
  env.HOME = args.home;
  for (const key of Object.keys(env)) {
    if (key === "NODE_OPTIONS" || key.startsWith("VITEST") || key.startsWith("SWARM_")) delete env[key];
  }

  const bin = realpathSync(join(dir, "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js"));
  const logFile = join(dir, "server.log");
  const fd = openSync(logFile, "w", 0o600);
  const startedAt = Date.now();
  let proc: ChildProcess;
  try {
    proc = spawn(args.node, [bin, "serve"], { cwd: dir, env, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  // Tracked before anything can await, so a stop (or a signal) mid-boot reaches it.
  const child: Child = { process: proc, exited: Promise.resolve() };
  child.exited = new Promise<void>((done) => {
    proc.once("exit", (code, signal) => {
      child.exit = signal ?? `code ${code}`;
      done();
    });
    proc.once("error", (err) => {
      child.exit = `spawn error: ${err.message}`;
      done();
    });
  });
  session.children.add(child);
  if (session.stopped) {
    await stopChild(child);
    throw new Error(`isolated-substrate: stopped while the ${label} sidecar was starting`);
  }
  if (proc.pid !== undefined) writeFileSync(join(dir, "server.pid"), `${proc.pid}\n`, { mode: 0o600 });

  const url = `http://127.0.0.1:${port}`;
  const listening = `listening at ${url}`;
  const failed = (why: string): Error => {
    const tail = logTail(logFile);
    const message = `isolated-substrate: the ${label} sidecar ${why}. Last lines of ${logFile}:\n${tail}`;
    return tail.includes("EADDRINUSE") ? new PortTakenError(message) : new Error(message);
  };

  const deadline = startedAt + args.bootTimeoutMs;
  while (Date.now() < deadline) {
    if (session.stopped) break;
    if (child.exit !== undefined) {
      session.children.delete(child);
      throw failed(`exited during startup (${child.exit})`);
    }
    // Our own child bound the port: a sibling answering on it would not have
    // written this line to our log.
    if (readLog(logFile).includes(listening) && (await sidecarHealthy(url))) {
      const missing: string[] = [];
      for (const ns of args.namespaces) if (!(await servesNamespace(url, ns))) missing.push(ns);
      if (missing.length === 0) {
        if (child.exit !== undefined) {
          // It looked ready, but it is gone: what answered was a sibling.
          session.children.delete(child);
          throw new PortTakenError(`isolated-substrate: the ${label} sidecar lost port ${port} (${child.exit})`);
        }
        return { label, url, port, dir, pid: proc.pid ?? -1, logFile, bootMs: Date.now() - startedAt };
      }
    }
    await sleep(100);
  }
  await stopChild(child);
  session.children.delete(child);
  if (session.stopped) throw new Error(`isolated-substrate: stopped while the ${label} sidecar was starting`);
  throw failed(`did not serve ${args.namespaces.join(", ")} within ${args.bootTimeoutMs} ms`);
}

async function bringUpDockerStack(): Promise<void> {
  await execFileAsync("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--wait"], { cwd: REPO_ROOT });
}

function requireBuilt(path: string, what: string, fix: string): void {
  if (!existsSync(path)) throw new Error(`isolated-substrate: ${what} is missing (${path}). ${fix}`);
}

/**
 * Start a private cold (and, by default, meta) Substrate sidecar for a test
 * run. The caller owns the handle; its `stop`, or {@link stopTestSubstrate},
 * takes it down. The signal and exit hooks are armed before anything spawns.
 */
export async function startTestSubstrate(opts: TestSubstrateOptions = {}): Promise<TestSubstrate> {
  requireBuilt(join(SUBSTRATE_PACKAGE, "dist", "substrate.js"), "the workspace's @mnmal-ai/substrate", "Run `pnpm install`.");
  requireBuilt(
    join(PLUGIN_PACKAGE, "dist", "bootstrap.js"),
    "the built swarm Substrate plugin",
    "Run `pnpm --filter @mnmal-ai/swarm-substrate-plugin build`.",
  );
  const stores = {
    cold: opts.postgres?.cold ?? "memory",
    meta: opts.postgres?.meta ?? "memory",
  };
  // A Postgres store must be the local test stack's, whoever passed it.
  if (stores.cold !== "memory") testPostgresUrl("cold", { SWARM_TEST_POSTGRES_URL: stores.cold });
  if (stores.meta !== "memory") testPostgresUrl("meta", { SWARM_TEST_META_POSTGRES_URL: stores.meta });

  const node = (await resolveNode()).path;
  const cortext = (opts.cortext ?? true) && existsSync(join(CORTEXT_PACKAGE, "package.json"));
  let recall: OllamaRecall | null = null;
  if (typeof opts.recall === "object") {
    recall = opts.recall;
  } else if ((opts.recall ?? "auto") === "auto" && (await probeOllama())) {
    recall = { baseUrl: OLLAMA_URL, model: OLLAMA_MODEL, dimension: OLLAMA_DIMENSION };
  }
  const withMeta = opts.meta ?? true;
  const bootTimeoutMs = opts.bootTimeoutMs ?? BOOT_TIMEOUT_MS;

  // realpath: macOS's tmpdir is a /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-substrate-test-")));
  const session: Session = {
    root,
    children: new Set(),
    stopped: false,
    async stop() {
      if (session.stopped && !sessions.has(session)) return;
      session.stopped = true;
      await Promise.all([...session.children].map((c) => stopChild(c).catch(() => {})));
      session.children.clear();
      sessions.delete(session);
      if (sessions.size === 0) disarm();
      if (process.env.SWARM_E2E_KEEP !== "1") rmSync(root, { recursive: true, force: true });
    },
  };
  sessions.add(session);
  arm();

  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writePluginDir(join(root, "cold"), "cold", { cortext, recall });
    if (withMeta) writePluginDir(join(root, "meta"), "meta", { cortext: false, recall: null });

    const boots: Array<Promise<TestSidecar>> = [
      spawnSidecar({
        session,
        label: "cold",
        dir: join(root, "cold"),
        home,
        node,
        databaseUrl: stores.cold,
        namespaces: ["swarm", "swarm-docs", ...(cortext ? ["cortext"] : [])],
        bootTimeoutMs,
      }),
    ];
    if (withMeta) {
      boots.push(
        spawnSidecar({
          session,
          label: "meta",
          dir: join(root, "meta"),
          home,
          node,
          databaseUrl: stores.meta,
          namespaces: ["swarm_meta"],
          bootTimeoutMs,
        }),
      );
    }
    const settled = await Promise.allSettled(boots);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    const sidecars = settled.map((s) => (s as PromiseFulfilledResult<TestSidecar>).value);
    return {
      root,
      cold: sidecars.find((s) => s.label === "cold") as TestSidecar,
      meta: sidecars.find((s) => s.label === "meta") ?? null,
      recall: recall === null ? "none" : "ollama",
      cortext,
      stop: () => session.stop(),
    };
  } catch (err) {
    await session.stop();
    throw err;
  }
}

/**
 * Stop `handle`, or, with no argument, every sidecar pair this module started
 * — including one whose boot is still in flight.
 */
export async function stopTestSubstrate(handle?: TestSubstrate): Promise<void> {
  if (handle !== undefined) return handle.stop();
  await Promise.all([...sessions].map((s) => s.stop()));
}

export default async function setup(): Promise<() => Promise<void>> {
  // Only the E2E suites talk to a real sidecar; every other run starts nothing.
  if (process.env.SWARM_SDK_E2E !== "1") {
    return async () => {
      // Nothing was started, nothing was redirected.
    };
  }

  let postgres: TestSubstrateOptions["postgres"];
  if (process.env.SWARM_SDK_PG === "1") {
    // Checked before docker is touched: loopback, test-stack ports only.
    postgres = { cold: testPostgresUrl("cold"), meta: testPostgresUrl("meta") };
    await bringUpDockerStack();
  }

  const startedAt = Date.now();
  const substrate = await startTestSubstrate({
    recall: process.env.SWARM_TEST_RECALL === "none" ? "none" : "auto",
    ...(postgres !== undefined ? { postgres } : {}),
  });
  const meta = substrate.meta as TestSidecar;

  // Redirect the test process only, after both sidecars answer.
  process.env.SWARM_SUBSTRATE_ENDPOINT = substrate.cold.url;
  process.env.SWARM_SUBSTRATE_PORT = String(substrate.cold.port);
  process.env.SWARM_META_ENDPOINT = meta.url;
  process.env.SWARM_META_PORT = String(meta.port);
  process.env.SWARM_SUBSTRATE_TEST_RECALL = substrate.recall;
  process.env.SWARM_SUBSTRATE_TEST_CORTEXT = substrate.cortext ? "1" : "0";

  console.log(
    `[isolated-substrate] ${postgres !== undefined ? "postgres" : "memory"} store; ` +
      `cold ${substrate.cold.url} (${substrate.cold.bootMs} ms, recall ${substrate.recall}, cortext ${substrate.cortext ? "on" : "off"}), ` +
      `meta ${meta.url} (${meta.bootMs} ms); ready in ${Date.now() - startedAt} ms; dir ${substrate.root}`,
  );

  return async () => {
    await substrate.stop();
  };
}
