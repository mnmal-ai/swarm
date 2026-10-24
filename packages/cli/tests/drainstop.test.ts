/**
 * `swarm drainstop` fires the swarm plugin's drainstop trigger on the cold
 * Substrate sidecar the project resolves to — the same resolution `swarm
 * substrate` uses — and a local_only project is checked before any request. fetch is stubbed (in this
 * process, and in the CLI process the dispatch tests run): nothing here
 * reaches a real sidecar.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DrainstopResult, LocalOnlyViolation, TRIGGER_DRAINSTOP_PATH } from "@mnmal-ai/swarm-substrate";
import { runDrainstop } from "../src/cli/drainstop.js";
import {
  swarmDir,
  dedicatedProject,
  isolateSubstrateProject,
  projectConfig,
  saveGlobalConfig,
  sharedProject,
} from "./substrate-project-fixture.js";

isolateSubstrateProject();

const RESULT: DrainstopResult = {
  promoted: { todos: 1, decisions: 2, agentRules: 0 },
  absorbed: 0,
  expired: 4,
  anchorSeeded: false,
  failures: [
    { phase: "promote_decision", observationId: "obs-9", code: "missing_referent", name: "PromotionWriteError", message: "no such session" },
  ],
  truncated: false,
};

let urls: string[];
let inits: Array<RequestInit | undefined>;
beforeEach(() => {
  urls = [];
  inits = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      inits.push(init);
      return new Response(JSON.stringify(RESULT), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runDrainstop", () => {
  it("fires the trigger on the project's dedicated sidecar, whatever the global config says", async () => {
    saveGlobalConfig({ substrate_url: "http://localhost:32338" });
    await runDrainstop([], {}, dedicatedProject());
    expect(urls).toEqual([`http://127.0.0.1:45002/health`, `http://127.0.0.1:45002${TRIGGER_DRAINSTOP_PATH}`]);
  });

  it("sends a JSON body with its JSON content type", async () => {
    // A server may refuse an empty body sent as application/json; "{}" is
    // valid JSON either way.
    await runDrainstop([], {}, dedicatedProject());
    const trigger = inits[urls.indexOf(`http://127.0.0.1:45002${TRIGGER_DRAINSTOP_PATH}`)];
    expect(trigger?.method).toBe("POST");
    expect(new Headers(trigger?.headers).get("content-type")).toBe("application/json");
    expect(trigger?.body).toBe("{}");
  });

  it("follows the saved substrate_url for a project on the shared stack", async () => {
    saveGlobalConfig({ substrate_url: "http://localhost:45100" });
    await runDrainstop([], {}, sharedProject());
    expect(urls).toEqual([`http://localhost:45100/health`, `http://localhost:45100${TRIGGER_DRAINSTOP_PATH}`]);
  });

  it("refuses an off-machine endpoint for a local_only project, before any request", async () => {
    saveGlobalConfig({ substrate_url: "http://10.1.2.3:32338" });
    await expect(runDrainstop([], {}, projectConfig({ local_only: true }))).rejects.toThrow(LocalOnlyViolation);
    expect(urls).toEqual([]);
  });

  it("prints what was promoted, expired and failed", async () => {
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((line?: unknown) => {
      lines.push(String(line ?? ""));
    });
    await runDrainstop([], {}, dedicatedProject());
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes.
    const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toMatch(/3 observations promoted/);
    expect(out).toMatch(/todos:\s+1/);
    expect(out).toMatch(/decisions:\s+2/);
    expect(out).toMatch(/agent rules:\s+0/);
    expect(out).toMatch(/expired:?\s+4/);
    expect(out).toMatch(/1 failure/);
    expect(out).toContain("promote_decision");
    expect(out).toContain("obs-9");
    expect(out).toContain("no such session");
  });
});

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli/main.ts");
const TSX_LOADER = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "loader.mjs"),
).href;

/**
 * Run `swarm <args>` through main.ts from the fixture's project directory, as a
 * user would. fetch is replaced before the CLI loads: every request is
 * recorded and answered, and none leaves the process.
 */
function swarm(...args: string[]) {
  const projectDir = dirname(swarmDir());
  const log = join(projectDir, "requests.log");
  const stub = join(projectDir, "fetch-stub.mjs");
  writeFileSync(
    stub,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  appendFileSync(${JSON.stringify(log)}, url + "\\n");
  const body = url.endsWith("/health") ? "ok" : ${JSON.stringify(JSON.stringify(RESULT))};
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};
`,
  );
  const run = spawnSync(process.execPath, ["--import", TSX_LOADER, "--import", pathToFileURL(stub).href, MAIN, ...args], {
    cwd: projectDir,
    env: process.env,
    encoding: "utf-8",
    timeout: 60_000,
  });
  const requests = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, requests };
}

describe("swarm drainstop (dispatched by main.ts)", () => {
  it("in a dedicated project, fires the trigger on the project's own sidecar", () => {
    dedicatedProject();
    saveGlobalConfig({ substrate_url: "http://localhost:32338" });
    const run = swarm("drainstop");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Drainstop complete");
    // Exactly these two: no startup path (sync, sidecar probes) runs first.
    expect(run.requests).toEqual([`http://127.0.0.1:45002/health`, `http://127.0.0.1:45002${TRIGGER_DRAINSTOP_PATH}`]);
  }, 60_000);

  it("in a local_only project, refuses an off-machine endpoint before any request", () => {
    projectConfig({ local_only: true });
    saveGlobalConfig({ substrate_url: "http://10.1.2.3:32338" });
    const run = swarm("drainstop");
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/local_only/);
    expect(run.requests).toEqual([]);
  }, 60_000);
});
