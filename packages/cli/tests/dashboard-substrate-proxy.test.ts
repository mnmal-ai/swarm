/**
 * The live dashboard's Substrate proxy reaches the run's own Substrate — the
 * endpoint of the SubstrateClient the run hands the dashboard (a dedicated
 * project's stack, or the shared one) — never a hard-coded port.
 * Only the ops the dashboard needs are forwarded (POST query, POST mutate,
 * GET schema/<namespace>[/<Type>]), as `/api/substrate/<op>` or the sidecar's
 * own `/substrate/v1/<op>`; everything else, encoded or not, is refused. A LAN
 * dashboard warns what it exposes.
 *
 * Upstreams are fake HTTP servers on ephemeral loopback ports and dashboards
 * bind 127.0.0.1 on made-up ports: nothing here reaches a real sidecar.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { runDashboard, previewBanner } from "../src/cli/dashboard.js";
import { resolveSubstrateStack } from "../src/cli/substrate.js";
import { dashboardBanner } from "../src/cli/run.js";
import WebSocket from "ws";
import {
  DashboardServer,
  isDashboardHost,
  isDashboardOrigin,
  lanWarning,
  PROXIED_SUBSTRATE_OPS,
  substrateProxyPath,
} from "../src/server/index.js";
import { dedicatedProject, isolateSubstrateProject, saveGlobalConfig, sharedProject } from "./substrate-project-fixture.js";

isolateSubstrateProject();

let nextPort = 17141;
const upstreams: Server[] = [];
const dashboards: DashboardServer[] = [];

afterEach(async () => {
  for (const d of dashboards.splice(0)) await d.stop();
  for (const u of upstreams.splice(0)) await new Promise((r) => u.close(r));
});

interface Seen {
  method: string;
  url: string;
  body: string;
}

/** A fake Substrate sidecar: records every request and answers JSON naming itself. */
async function fakeSubstrate(name: string) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: name, data: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstreams.push(server);
  const port = (server.address() as AddressInfo).port;
  return { seen, port, url: `http://127.0.0.1:${port}` };
}

/**
 * A dashboard for a run whose Substrate client talks to `endpoint` — what
 * ensureSubstrateReady handed `swarm run` — or for a run with no Substrate at all.
 */
async function dashboard(endpoint?: string): Promise<string> {
  const port = nextPort++;
  const client =
    endpoint === undefined ? undefined : ({ endpoint, query: async () => [] } as unknown as SubstrateClient);
  dashboards.push(new DashboardServer(new SwarmEventBus(), port, undefined, false, client));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/`)).ok) return base;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("dashboard did not start");
}

const FRAME = JSON.stringify({ "swarm/Goal": { params: {}, fields: { id: true } } });

const query = (base: string, path = "/api/substrate/query") =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: FRAME });

describe("dashboard Substrate proxy", () => {
  it("forwards to a dedicated project's own sidecar, not the shared one", async () => {
    const own = await fakeSubstrate("dedicated");
    const shared = await fakeSubstrate("shared");
    saveGlobalConfig({ substrate_url: shared.url });
    const stack = resolveSubstrateStack(dedicatedProject({ port: own.port }));
    const base = await dashboard(stack.cold.endpoint);

    const res = await query(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "dedicated" });
    expect(own.seen).toEqual([{ method: "POST", url: "/substrate/v1/query", body: FRAME }]);
    expect(shared.seen).toEqual([]);
  });

  it("forwards to the shared stack for a project without its own", async () => {
    const own = await fakeSubstrate("dedicated");
    const shared = await fakeSubstrate("shared");
    saveGlobalConfig({ substrate_url: shared.url });
    const base = await dashboard(resolveSubstrateStack(sharedProject()).cold.endpoint);

    const res = await fetch(`${base}/api/substrate/schema/swarm`);
    expect(await res.json()).toMatchObject({ from: "shared" });
    expect(shared.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /substrate/v1/schema/swarm"]);
    expect(own.seen).toEqual([]);
  });

  it("accepts the sidecar's own /substrate/v1/<op> paths for the same ops", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    expect(await (await fetch(`${base}/substrate/v1/schema/swarm`)).json()).toMatchObject({ from: "dedicated" });
    expect(await (await query(base, "/substrate/v1/query")).json()).toMatchObject({ from: "dedicated" });
    expect(own.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /substrate/v1/schema/swarm", "POST /substrate/v1/query"]);
  });

  it("answers 503 and reaches nothing when the run has no Substrate (file-only run, preview)", async () => {
    const base = await dashboard(undefined);
    const res = await fetch(`${base}/api/substrate/schema/swarm`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/no Substrate/i);
  });

  it("refuses every other op, admin routes and encoded escapes with 403, and forwards nothing", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    const host = `127.0.0.1:${new URL(base).port}`;
    const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    const get = { method: "GET" };
    for (const [path, init] of [
      ["/api/substrate/_system/drop-namespace", post],
      ["/api/substrate/%5Fsystem/drop-namespace", post], // a router decodes %5F to _ before matching
      ["/api/substrate/%5fsystem/keys", get],
      ["/substrate/v1/_system/keys", get],
      ["/substrate/v1/%5Fsystem/keys", get],
      ["/api/substrate/schema/%5Fsystem", get],
      ["/api/substrate/schema/swarm%2F..%2F_system", get],
      ["/api/substrate/../../health", get],
      ["/api/substrate/%2e%2e/%2e%2e/health", get],
      ["/substrate/v1/%2E%2E/%2E%2E/health", get],
      ["/api/substrate/query/%2e%2e", post],
      ["/api/substrate/%E0%A4%A", get], // does not decode
      ["/api/substrate/federated-schema", get],
      ["/api/substrate/query", get], // right op, wrong method
      ["/api/substrate/schema/swarm", post],
      ["/api/substrate/query?x=1", post],
      ["/substrate/other", get],
    ] as const) {
      const res = await raw(base, path, host, init);
      expect(res.status, path).toBe(403);
      expect(JSON.parse(res.body).error, path).toContain(PROXIED_SUBSTRATE_OPS);
    }
    expect(own.seen).toEqual([]);
  });
});

describe("substrateProxyPath", () => {
  it("maps exactly the dashboard's ops to the sidecar's v1 API", () => {
    expect(substrateProxyPath("POST", "/api/substrate/query")).toBe("/substrate/v1/query");
    expect(substrateProxyPath("POST", "/api/substrate/mutate")).toBe("/substrate/v1/mutate");
    expect(substrateProxyPath("POST", "/substrate/v1/query")).toBe("/substrate/v1/query");
    expect(substrateProxyPath("GET", "/api/substrate/schema/swarm")).toBe("/substrate/v1/schema/swarm");
    expect(substrateProxyPath("GET", "/api/substrate/schema/swarm-docs/Section")).toBe("/substrate/v1/schema/swarm-docs/Section");
    expect(substrateProxyPath("GET", "/substrate/v1/schema/swarm_meta")).toBe("/substrate/v1/schema/swarm_meta");
    // Decoded before matching, and rebuilt from the decoded segments.
    expect(substrateProxyPath("POST", "/api/substrate/%71uery")).toBe("/substrate/v1/query");
  });

  it("refuses everything else, however it is spelled", () => {
    for (const [method, url] of [
      ["POST", "/api/substrate/%5Fsystem/drop-namespace"],
      ["GET", "/api/substrate/schema/%5Fsystem"],
      ["GET", "/api/substrate/schema/_system"],
      ["GET", "/api/substrate/%2e%2e/health"],
      ["GET", "/api/substrate/schema/swarm/%2e%2e"],
      ["GET", "/api/substrate/schema/swarm%2FWorkerResult"],
      ["GET", "/api/substrate/schema"],
      ["GET", "/api/substrate/schema/swarm/Type/extra"],
      ["GET", "/api/substrate/schema//swarm"],
      ["GET", "/api/substrate/%"],
      ["POST", "/api/substrate/query/"],
      ["GET", "/api/substrate/federated-schema"],
      ["GET", "/api/substrate/onboard"],
      ["POST", "/api/substrate/stream/ticket"],
      ["GET", "/substrate/v2/query"],
      ["POST", "/api/substrate/query#x"],
    ] as const) {
      expect(substrateProxyPath(method, url), `${method} ${url}`).toBeNull();
    }
  });
});

describe("the page's Substrate panel", () => {
  const html = readFileSync(join(process.cwd(), "src", "server", "dashboard.html"), "utf8");
  const pages: JSDOM[] = [];
  afterEach(() => {
    for (const dom of pages.splice(0)) dom.window.close();
  });

  it("hard-codes no Substrate address and carries no explorer", () => {
    for (const port of ["32337", "32338", "32340", "32341", "31337", "31338", "31340", "31341"]) expect(html).not.toContain(port);
    expect(html).not.toMatch(/localhost:\d/);
    expect(html).not.toMatch(/explore/i);
  });

  /** Load the page; `/api/substrate/query` answers `data`, everything else fails. */
  async function loadPage(data: Record<string, unknown>) {
    const requests: Array<{ url: string; body: string | undefined }> = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "http://127.0.0.1:47141/",
      beforeParse(window) {
        const w = window as unknown as Record<string, unknown>;
        w.WebSocket = class {
          send(): void {}
          close(): void {}
        };
        w.fetch = async (url: string, init?: { body?: string }) => {
          requests.push({ url: String(url), body: init?.body });
          if (String(url) === "/api/substrate/query") {
            return { ok: true, status: 200, json: async () => ({ data }) };
          }
          return { ok: false, status: 503, json: async () => ({}) };
        };
      },
    });
    pages.push(dom);
    await new Promise((r) => setTimeout(r, 30));
    return { requests, doc: dom.window.document };
  }

  it("issues namespaced swarm/<Type> frames at /api/substrate/query and renders the counts", async () => {
    const { requests, doc } = await loadPage({
      "swarm/WorkerResult": [{ id: "w1" }, { id: "w2" }],
      "swarm/ReviewVerdict": [{ verdict: "approved", timestamp: "2026-10-23T10:00:00Z" }],
      "swarm/SessionEvent": [{ inputTokens: 10, outputTokens: 5, role: "worker", latencyMs: 1200, timestamp: "2026-10-23T10:00:00Z" }],
    });
    const call = requests.find((r) => r.url === "/api/substrate/query");
    expect(call).toBeDefined();
    const frame = JSON.parse(call?.body ?? "{}") as Record<string, { params: Record<string, unknown> }>;
    const keys = Object.keys(frame);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(/^swarm\/[A-Z]\w+$/);
    expect(keys).toContain("swarm/WorkerResult");
    expect(keys).toContain("swarm/SessionEvent");
    // Counts come from one read per type: ask for a full page, not the 100-row default.
    expect(frame["swarm/WorkerResult"].params.limit).toBe(1000);
    expect(doc.getElementById("substrateStatus")?.textContent).toMatch(/^4 entities/);
    expect(requests.some((r) => r.url.includes("explore"))).toBe(false);
  });
});

describe("no cross-origin access to the dashboard", () => {
  const CORS = "access-control-allow-origin";

  it("sends no CORS allow header on any Substrate proxy response", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    for (const res of [
      await fetch(`${base}/api/substrate/schema/swarm`),
      await query(base),
      await fetch(`${base}/substrate/v1/schema/swarm`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get(CORS)).toBeNull();
    }
    const withoutSubstrate = await fetch(`${await dashboard(undefined)}/api/substrate/schema/swarm`);
    expect(withoutSubstrate.status).toBe(503);
    expect(withoutSubstrate.headers.get(CORS)).toBeNull();
  });

  it("rejects a proxied POST that is not JSON with 415, and never forwards it", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    const form = new FormData();
    form.append("a", "b");
    // The CORS-simple bodies a hostile page could send without a preflight, and none at all.
    const posts: RequestInit[] = [
      { body: "{}", headers: { "Content-Type": "text/plain" } },
      { body: "a=b", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      { body: form },
      { body: new Uint8Array([123, 125]) },
    ];
    for (const path of ["/api/substrate/query", "/api/substrate/mutate", "/substrate/v1/mutate"]) {
      for (const post of posts) {
        const res = await fetch(`${base}${path}`, { method: "POST", ...post });
        expect(res.status).toBe(415);
        expect(res.headers.get(CORS)).toBeNull();
      }
    }
    expect(own.seen).toEqual([]);
  });

  it("still forwards a JSON POST, with or without a charset", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    const res = await fetch(`${base}/api/substrate/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(own.seen).toEqual([{ method: "POST", url: "/substrate/v1/mutate", body: "{}" }]);
  });

  it("answers 413 to a JSON POST over 1 MiB, declared or streamed, and forwards nothing", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    const MiB = 1024 * 1024;

    // Declared up front by Content-Length.
    const declared = await fetch(`${base}/api/substrate/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `"${"x".repeat(MiB - 1)}"`,
    });
    expect(declared.status).toBe(413);

    // Chunked, with no length: refused once the running total passes the cap.
    const { port } = new URL(base);
    const streamed = await new Promise<number>((done, fail) => {
      const req = request(
        { host: "127.0.0.1", port: Number(port), method: "POST", path: "/api/substrate/mutate", headers: { "Content-Type": "application/json" } },
        (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 20; i++) req.write(chunk);
      req.end();
    });
    expect(streamed).toBe(413);
    expect(own.seen).toEqual([]);
  });

  it("forwards a JSON POST of exactly 1 MiB", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    const body = `"${"x".repeat(1024 * 1024 - 2)}"`;
    const res = await fetch(`${base}/api/substrate/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(own.seen[0]?.body.length).toBe(1024 * 1024);
  });

  it("grants no other route to another origin either", async () => {
    const base = await dashboard(undefined);
    const preflight = await fetch(`${base}/api/tasks/task-1`, {
      method: "OPTIONS",
      headers: { Origin: "http://elsewhere.example", "Access-Control-Request-Method": "PATCH" },
    });
    expect(preflight.headers.get(CORS)).toBeNull();
    expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
    for (const res of [
      await fetch(`${base}/api/tasks`, { headers: { Origin: "http://elsewhere.example" } }),
      await fetch(`${base}/api/tasks/missing-task`),
    ]) {
      expect(res.headers.get(CORS)).toBeNull();
    }
  });
});

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("LAN warning", () => {
  it("says what a LAN dashboard exposes, and to use it only on a trusted network", () => {
    const text = plain(lanWarning(false));
    expect(text).toMatch(/all network interfaces/);
    expect(text).toMatch(/no login/);
    expect(text).toMatch(/live events and task text/);
    expect(text).toMatch(/read and change everything in this project's Substrate store/);
    expect(text).toMatch(/Substrate proxy/);
    expect(text).not.toMatch(/Explorer/);
    expect(text).toMatch(/network you trust/);
    expect(text).not.toMatch(/local_only/);
  });

  it("says so explicitly for a local_only project", () => {
    const text = plain(lanWarning(true));
    expect(text).toMatch(/local_only/);
    expect(text).toMatch(/meant to stay on this machine/);
  });

  it("is printed by swarm run with --dashboard-lan, and only then", () => {
    expect(plain(dashboardBanner(47141, true, "192.168.1.20", false))).toContain(plain(lanWarning(false)));
    expect(plain(dashboardBanner(47141, true, "192.168.1.20", true))).toContain(plain(lanWarning(true)));
    expect(plain(dashboardBanner(47141, false, null, false))).not.toMatch(/no login/);
  });

  it("is printed by swarm dashboard preview with --lan, and only then", () => {
    expect(plain(previewBanner(47141, true, false))).toContain(plain(lanWarning(false)));
    expect(plain(previewBanner(47141, true, true))).toContain(plain(lanWarning(true)));
    expect(plain(previewBanner(47141, false, false))).not.toMatch(/no login/);
  });
});

describe("--help", () => {
  it("swarm dashboard's --lan line says what it exposes", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      lines.push(String(line ?? ""));
    });
    try {
      await runDashboard({}, []);
    } finally {
      log.mockRestore();
    }
    const help = lines.join("\n");
    expect(help).toMatch(/--lan[^\n]*no login/);
    expect(help).toMatch(/read and change this project's Substrate store/);
  });

  it("swarm --help's --dashboard-lan line says what it exposes", () => {
    const main = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli/main.ts");
    const tsx = pathToFileURL(
      join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "loader.mjs"),
    ).href;
    const run = spawnSync(process.execPath, ["--import", tsx, main, "--help"], { encoding: "utf-8", timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/--dashboard-lan[^\n]*no login/);
    expect(run.stdout).toMatch(/read and change this project's Substrate store/);
  }, 60_000);
});

/** An HTTP request with exactly the Host header given (none when null). */
function raw(
  base: string,
  path: string,
  host: string | null,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (host !== null) headers.host = host;
    const req = request(
      { hostname: u.hostname, port: u.port, path, method: init.method ?? "GET", headers, setHost: false },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** Try a WebSocket upgrade; resolves 101 when it opens, else the refusing status. */
function upgrade(base: string, opts: { host?: string; origin?: string } = {}): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", {
      headers: opts.host !== undefined ? { Host: opts.host } : {},
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    });
    ws.on("open", () => {
      ws.close();
      resolvePromise(101);
    });
    ws.on("unexpected-response", (req, res) => {
      resolvePromise(res.statusCode ?? 0);
      req.destroy();
    });
    ws.on("error", reject);
  });
}

/** A pretend machine on a LAN and a tailnet. */
const MACHINE = () => ({
  hostname: "Test-Mac.local",
  interfaces: {
    lo0: [
      { address: "127.0.0.1", family: "IPv4" },
      { address: "::1", family: "IPv6" },
    ],
    en0: [
      { address: "192.168.1.20", family: "IPv4" },
      { address: "fe80::1c", family: "IPv6" },
    ],
    utun4: [
      { address: "100.101.102.103", family: "IPv4" },
      { address: "fd7a:115c:a1e0::3", family: "IPv6" },
    ],
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>,
});

describe("Host header: the dashboard answers only to its own names (DNS rebinding)", () => {
  it("accepts loopback, with the dashboard's port or none, on and off the LAN", () => {
    for (const lan of [false, true]) {
      for (const host of ["localhost:17141", "127.0.0.1:17141", "[::1]:17141", "localhost", "LOCALHOST:17141"]) {
        expect(isDashboardHost(host, 17141, lan, MACHINE), `${host} lan=${lan}`).toBe(true);
      }
    }
  });

  it("on the LAN, also accepts this machine's hostnames and its current addresses", () => {
    for (const host of [
      "test-mac.local:17141",
      "test-mac:17141",
      "192.168.1.20:17141",
      "100.101.102.103:17141", // tailnet
      "[fd7a:115c:a1e0::3]:17141",
      "[fe80::1c]:17141",
      "192.168.1.20",
    ]) {
      expect(isDashboardHost(host, 17141, true, MACHINE), host).toBe(true);
    }
  });

  it("refuses every other name, another port, and the LAN names when not on the LAN", () => {
    for (const lan of [false, true]) {
      for (const host of [
        "evil.example:17141",
        "evil.example",
        "127.0.0.1.evil.example:17141",
        "test-mac.evil.example:17141",
        "192.168.1.99:17141", // another machine
        "127.0.0.1:9999",
        "::1:17141",
        "",
        undefined,
      ]) {
        expect(isDashboardHost(host, 17141, lan, MACHINE), `${host} lan=${lan}`).toBe(false);
      }
    }
    for (const host of ["test-mac.local:17141", "192.168.1.20:17141", "100.101.102.103:17141"]) {
      expect(isDashboardHost(host, 17141, false, MACHINE), host).toBe(false);
    }
  });

  it("answers loopback hosts over HTTP", async () => {
    const base = await dashboard(undefined);
    const port = new URL(base).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      expect((await raw(base, "/", host)).status, host).toBe(200);
    }
  });

  it("refuses any other Host with 421 on every route, and never reaches Substrate", async () => {
    const own = await fakeSubstrate("dedicated");
    const base = await dashboard(own.url);
    const port = new URL(base).port;
    const json = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    for (const host of [`evil.example:${port}`, `192.168.1.20:${port}`, null]) {
      for (const [path, init] of [
        ["/", {}],
        ["/api/tasks", {}],
        ["/api/transcript/s1", {}],
        ["/api/substrate/schema/swarm", {}],
        ["/api/substrate/query", json],
        ["/substrate/v1/mutate", json],
      ] as const) {
        const res = await raw(base, path, host, init);
        if (host === null) {
          // No Host at all: Node's HTTP server refuses it (400) before any handler.
          expect(res.status, path).toBe(400);
        } else {
          expect(res.status, `${host} ${path}`).toBe(421);
          expect(res.body).toMatch(/misdirected/i);
        }
      }
    }
    expect(own.seen).toEqual([]);
  });
});

describe("WebSocket: only the dashboard's own page may connect", () => {
  it("accepts an Origin that is the dashboard's own origin, or none (non-browser clients)", () => {
    expect(isDashboardOrigin(undefined, "127.0.0.1:17141")).toBe(true);
    expect(isDashboardOrigin("http://127.0.0.1:17141", "127.0.0.1:17141")).toBe(true);
    expect(isDashboardOrigin("http://192.168.1.20:17141", "192.168.1.20:17141")).toBe(true);
    expect(isDashboardOrigin("http://[::1]:17141", "[::1]:17141")).toBe(true);
  });

  it("refuses any other Origin", () => {
    for (const origin of [
      "http://evil.example",
      "http://evil.example:17141",
      "https://127.0.0.1:17141",
      "http://localhost:17141", // another origin, even if it is this machine
      "http://127.0.0.1:9999",
      "null",
    ]) {
      expect(isDashboardOrigin(origin, "127.0.0.1:17141"), origin).toBe(false);
    }
  });

  it("opens for the page's own origin or no origin, and refuses another origin or host", async () => {
    const base = await dashboard(undefined);
    const port = new URL(base).port;
    expect(await upgrade(base)).toBe(101);
    expect(await upgrade(base, { origin: `http://127.0.0.1:${port}` })).toBe(101);
    expect(await upgrade(base, { origin: "http://evil.example" })).toBe(403);
    expect(await upgrade(base, { origin: `http://localhost:${port}` })).toBe(403);
    expect(await upgrade(base, { host: `evil.example:${port}` })).toBe(421);
    // DNS rebinding: to the browser this is same-origin, so only Host gives it away.
    expect(await upgrade(base, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(421);
  });
});
