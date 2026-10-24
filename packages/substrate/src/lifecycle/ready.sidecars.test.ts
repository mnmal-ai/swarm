/**
 * `ensureAllSidecars` orchestration, with the process and install layers
 * replaced by recorders: what runs, and in which order. The real layers are
 * covered by runtime.test.ts, sidecar.test.ts and the gated e2e.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedderSettings } from "../embedder-settings.js";
import type { EnsureRuntimeOptions, RuntimeInfo } from "./runtime.js";
import type { SidecarSpec } from "./specs.js";

const calls = vi.hoisted(() => ({ order: [] as string[], healthy: new Set<number>(), reinstall: true }));

const RUNTIME: RuntimeInfo = {
  runtimeDir: "/fake/runtime",
  substrateBin: "/fake/runtime/node_modules/@mnmal-ai/substrate/dist/substrate.js",
  installedMarker: "/fake/runtime/.installed-x",
};

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  resolveNode: vi.fn(async () => {
    calls.order.push("resolveNode");
    return { path: "/fake/node", version: "26.10.0" };
  }),
  ensureRuntimeInstalled: vi.fn(async (opts: EnsureRuntimeOptions) => {
    // The real one calls the hook only when replacing an existing install.
    if (calls.reinstall) await opts.beforeReinstall?.();
    calls.order.push("install");
    return RUNTIME;
  }),
  findInstalledRuntime: vi.fn(() => {
    calls.order.push("findInstalledRuntime");
    return RUNTIME;
  }),
}));

vi.mock("./sidecar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidecar.js")>()),
  sidecarHealthy: vi.fn(async (url: string) => calls.healthy.has(Number(new URL(url).port))),
  readSidecarPid: vi.fn(() => null),
  stopSidecar: vi.fn(async (spec: SidecarSpec) => {
    calls.order.push(`stop ${spec.label}`);
    return { stopped: true, pid: 1 };
  }),
  ensureSidecar: vi.fn(async (spec: SidecarSpec) => {
    calls.order.push(`ensure ${spec.label}`);
    return { label: spec.label, endpoint: `http://127.0.0.1:${spec.port}`, pid: 2, started: true };
  }),
}));

vi.mock("./stacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stacks.js")>()),
  ensureStackDir: vi.fn((spec: SidecarSpec) => {
    calls.order.push(`stack ${spec.label}`);
    return `/fake/stacks/${spec.label}`;
  }),
}));

const { ensureAllSidecars, ensureSubstrateReady } = await import("./ready.js");
const { SIDECAR_SPECS } = await import("./specs.js");

const EMBEDDER: EmbedderSettings = {
  kind: "none",
  baseUrl: "http://127.0.0.1:11434",
  model: "nomic-embed-text",
  dimension: 768,
  timeoutMs: 15_000,
  embedOnWrite: false,
};
// Ports nothing is asked to bind: every probe and spawn is a recorder.
const specs: SidecarSpec[] = SIDECAR_SPECS.map((s, i) => ({ ...s, port: 50_001 + i, postgresUrl: "memory" }));

describe("ensureAllSidecars", () => {
  beforeEach(() => {
    calls.order.length = 0;
    calls.healthy.clear();
    calls.reinstall = true;
  });

  it("stops the stacks' sidecars inside the reinstall hook, before node_modules is replaced, then starts them", async () => {
    calls.healthy.add(specs[0].port); // cold up, meta down: something to ensure
    await ensureAllSidecars(true, { specs, pluginTarball: "/abs/swarm-substrate-plugin.tgz", embedder: EMBEDDER });
    expect(calls.order).toEqual([
      "resolveNode",
      "stop cold",
      "stop meta",
      "install",
      "stack cold",
      "ensure cold",
      "stack meta",
      "ensure meta",
    ]);
  });

  it("runs the caller's beforeReinstall in place of stopping only these stacks", async () => {
    const hook = vi.fn(async () => {
      calls.order.push("caller hook");
    });
    await ensureAllSidecars(true, {
      specs,
      pluginTarball: "/abs/swarm-substrate-plugin.tgz",
      embedder: EMBEDDER,
      beforeReinstall: hook,
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(calls.order.slice(0, 3)).toEqual(["resolveNode", "caller hook", "install"]);
    expect(calls.order.filter((c) => c.startsWith("stop"))).toEqual([]);
  });

  it("stops nothing when the install is already done", async () => {
    calls.reinstall = false;
    await ensureAllSidecars(true, { specs, pluginTarball: "/abs/swarm-substrate-plugin.tgz", embedder: EMBEDDER });
    expect(calls.order.filter((c) => c.startsWith("stop"))).toEqual([]);
  });

  it("uses the installed runtime when no tarball is given", async () => {
    await ensureAllSidecars(true, { specs, embedder: EMBEDDER });
    expect(calls.order).toEqual(["resolveNode", "findInstalledRuntime", "stack cold", "ensure cold", "stack meta", "ensure meta"]);
  });

  it("touches neither Node nor the runtime when every sidecar is healthy", async () => {
    for (const s of specs) calls.healthy.add(s.port);
    const statuses = await ensureAllSidecars(true, { specs, embedder: EMBEDDER });
    expect(calls.order).toEqual([]);
    expect(statuses.map((s) => s.started)).toEqual([false, false]);
  });
});

describe("ensureSubstrateReady", () => {
  const KEYS = ["HOME", "SWARM_SUBSTRATE_ENDPOINT", "SWARM_SUBSTRATE_PORT", "SWARM_SUBSTRATE_POSTGRES_URL", "SWARM_META_ENDPOINT", "SWARM_META_PORT", "SWARM_META_POSTGRES_URL", "SWARM_SUBSTRATE_LOCAL_ONLY"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    calls.order.length = 0;
    calls.healthy.clear();
    calls.reinstall = true;
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    // A HOME with no ~/.swarm/config.json, memory stores, and made-up ports nothing binds.
    process.env.HOME = "/nonexistent-swarm-home";
    process.env.SWARM_SUBSTRATE_PORT = String(specs[0].port);
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = "memory";
    process.env.SWARM_META_PORT = String(specs[1].port);
    process.env.SWARM_META_POSTGRES_URL = "memory";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("hands the caller's beforeReinstall to the runtime install", async () => {
    const hook = vi.fn(async () => {
      calls.order.push("caller hook");
    });
    // The schema check after bring-up fails (fetch answers 503): only the order matters here.
    await expect(
      ensureSubstrateReady({ quiet: true, pluginTarball: "/abs/swarm-substrate-plugin.tgz", embedder: EMBEDDER, beforeReinstall: hook }),
    ).rejects.toThrow(/does not serve the namespaces/);
    expect(hook).toHaveBeenCalledOnce();
    expect(calls.order.slice(0, 3)).toEqual(["resolveNode", "caller hook", "install"]);
    expect(calls.order.filter((c) => c.startsWith("stop"))).toEqual([]);
  });
});
