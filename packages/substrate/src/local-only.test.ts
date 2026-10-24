import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLocalOnly, resolveSubstrateEndpointWithSource } from "./lifecycle/endpoint.js";
import { ensureSidecar, sidecarEnv } from "./lifecycle/sidecar.js";
import { SIDECAR_SPECS, type SidecarSpec } from "./lifecycle/specs.js";
import {
  collectLocalOnlyViolations,
  isLoopbackHost,
  LocalOnlyViolation,
  loopbackViolation,
} from "./local-only.js";

describe("isLoopbackHost", () => {
  it("accepts localhost, 127/8 and ::1", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("rejects everything else, including lookalikes", () => {
    for (const h of ["10.0.0.5", "203.0.113.7", "substrate.example.invalid", "0.0.0.0", "128.0.0.1", "127.0.0.1.nip.io", "::"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("loopbackViolation / collectLocalOnlyViolations", () => {
  const local = {
    endpoint: "http://127.0.0.1:47338",
    endpointSource: "SWARM_SUBSTRATE_ENDPOINT",
    metaEndpoint: "http://localhost:47341",
    postgresUrl: "postgresql://swarm:swarm@127.0.0.1:47337/swarm",
    metaPostgresUrl: "postgresql://swarm:swarm@localhost:47340/swarm_meta",
    ollamaUrl: "http://127.0.0.1:11434",
  };

  it("passes an all-loopback stack", () => {
    expect(collectLocalOnlyViolations(local)).toEqual([]);
    expect(loopbackViolation("x", undefined)).toBeNull();
  });

  it("names every off-machine endpoint and where it came from", () => {
    const v = collectLocalOnlyViolations({
      ...local,
      endpoint: "https://substrate.example.invalid:3100",
      endpointSource: "substrate_url in ~/.swarm/config.json",
      metaPostgresUrl: "postgresql://swarm:swarm@10.0.0.9:5432/swarm_meta",
      ollamaUrl: "http://gpu-box:11434",
    });
    expect(v).toHaveLength(3);
    expect(v[0]).toMatch(/substrate_url in ~\/\.swarm\/config\.json.*substrate\.example\.invalid/);
    expect(v[1]).toMatch(/meta Postgres URL.*10\.0\.0\.9/);
    expect(v[2]).toMatch(/ollama.*gpu-box/);
  });

  it("refuses a non-loopback ollama embedder even when everything else is loopback", () => {
    expect(collectLocalOnlyViolations({ ...local, ollamaUrl: "http://203.0.113.7:11434" })).toEqual([
      expect.stringMatching(/ollama.*203\.0\.113\.7/),
    ]);
  });
});

describe("assertLocalOnly (the CLI's check, over resolveSubstrateEndpoint's whole chain)", () => {
  const KEYS = [
    "HOME",
    "SWARM_SUBSTRATE_ENDPOINT",
    "SWARM_SUBSTRATE_PORT",
    "SWARM_SUBSTRATE_POSTGRES_URL",
    "SWARM_META_ENDPOINT",
    "SWARM_META_PORT",
    "SWARM_META_POSTGRES_URL",
    "SWARM_EMBEDDER_KIND",
    "SWARM_EMBEDDER_OLLAMA_URL",
  ];
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "local-only-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  function saveSubstrateUrl(url: string): void {
    mkdirSync(join(home, ".swarm"), { recursive: true });
    writeFileSync(join(home, ".swarm", "config.json"), JSON.stringify({ substrate_url: url }));
  }

  it("passes a loopback stack (defaults, or a dedicated set of loopback ports)", () => {
    expect(() => assertLocalOnly()).not.toThrow();
    process.env.SWARM_SUBSTRATE_PORT = "47338";
    process.env.SWARM_META_PORT = "47341";
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = "postgresql://swarm:swarm@127.0.0.1:47337/swarm";
    process.env.SWARM_META_POSTGRES_URL = "postgresql://swarm:swarm@127.0.0.1:47340/swarm_meta";
    expect(() => assertLocalOnly()).not.toThrow();
  });

  it("fails closed on SWARM_SUBSTRATE_ENDPOINT pointing elsewhere", () => {
    process.env.SWARM_SUBSTRATE_ENDPOINT = "http://203.0.113.7:32338";
    expect(() => assertLocalOnly()).toThrow(LocalOnlyViolation);
    expect(() => assertLocalOnly()).toThrow(/SWARM_SUBSTRATE_ENDPOINT.*203\.0\.113\.7/);
  });

  it("fails closed on a saved user-wide substrate_url pointing elsewhere", () => {
    saveSubstrateUrl("https://substrate.example.invalid:3100");
    expect(resolveSubstrateEndpointWithSource().source).toMatch(/substrate_url/);
    expect(() => assertLocalOnly()).toThrow(/substrate_url.*substrate\.example\.invalid/);
  });

  it("fails closed on an ollama embedder off this machine, naming ollama", () => {
    process.env.SWARM_EMBEDDER_OLLAMA_URL = "https://gpu.example.invalid:11434";
    expect(() => assertLocalOnly()).toThrow(LocalOnlyViolation);
    expect(() => assertLocalOnly()).toThrow(/ollama.*gpu\.example\.invalid/);
    // With no embedder the Ollama URL is never contacted, so it is not a target.
    process.env.SWARM_EMBEDDER_KIND = "none";
    expect(() => assertLocalOnly()).not.toThrow();
  });

  it("fails closed on a postgres_url saved in ~/.swarm/config.json that is off this machine", () => {
    mkdirSync(join(home, ".swarm"), { recursive: true });
    writeFileSync(
      join(home, ".swarm", "config.json"),
      JSON.stringify({ postgres_url: "postgresql://swarm:swarm@db.internal:5432/swarm", db_mode: "connection_string" }),
    );
    expect(() => assertLocalOnly()).toThrow(/Substrate Postgres URL.*db\.internal/);
  });

  it("fails closed on a meta Postgres off this machine", () => {
    process.env.SWARM_META_POSTGRES_URL = "postgresql://swarm:swarm@db.internal:5432/swarm_meta";
    expect(() => assertLocalOnly()).toThrow(/meta Postgres URL.*db\.internal/);
  });
});

describe("ensureSidecar under SWARM_SUBSTRATE_LOCAL_ONLY", () => {
  const keys = ["SWARM_SUBSTRATE_LOCAL_ONLY", "HOME"] as const;
  const saved: Record<string, string | undefined> = {};
  let home: string;
  let stackDir: string;
  const cold = SIDECAR_SPECS.find((s) => s.label === "cold") as SidecarSpec;
  // Port 9 (discard) is never served by a sidecar; nothing below reaches it anyway.
  const spec = (postgresUrl: string): SidecarSpec => ({ ...cold, port: 9, postgresUrl });
  const runtime = { runtimeDir: "/nonexistent", substrateBin: "/nonexistent/substrate.js", installedMarker: "/nonexistent/.installed-x" };

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.SWARM_SUBSTRATE_LOCAL_ONLY = "1";
    home = mkdtempSync(join(tmpdir(), "local-only-sidecar-"));
    process.env.HOME = home;
    stackDir = join(home, "stack");
    mkdirSync(stackDir, { recursive: true });
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses an off-machine Postgres before spawning anything", async () => {
    await expect(
      ensureSidecar(spec("postgresql://swarm:swarm@10.1.2.3:5432/swarm"), { node: "/nonexistent/node", runtime, stackDir, quiet: true }),
    ).rejects.toThrow(LocalOnlyViolation);
  });

  it("binds the sidecar to loopback only, with no inherited SUBSTRATE_* variable", () => {
    const env = sidecarEnv(spec("postgresql://swarm:swarm@127.0.0.1:1/none"), stackDir, {
      PATH: "/usr/bin",
      HOST: "0.0.0.0",
      SUBSTRATE_AUTH_MODE: "required",
    });
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("9");
    expect(env.SUBSTRATE_PLUGIN_DIR).toBe(stackDir);
    expect(env.SUBSTRATE_DATABASE_URL).toBe("postgresql://swarm:swarm@127.0.0.1:1/none");
    expect(env.SUBSTRATE_SYSTEM_ACTOR).toBe("swarm");
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.keys(env).filter((k) => k.startsWith("SUBSTRATE_")).sort()).toEqual([
      "SUBSTRATE_DATABASE_URL",
      "SUBSTRATE_PLUGIN_DIR",
      "SUBSTRATE_SYSTEM_ACTOR",
    ]);
    expect(env.SUBSTRATE_AUTH_MODE).toBeUndefined();
  });

  it("refuses an off-machine ollama embedder in the stack's recall config", async () => {
    writeFileSync(
      join(stackDir, "substrate-recall.config.json"),
      JSON.stringify({ embedder: { kind: "ollama", baseUrl: "https://gpu.example.invalid:11434", model: "m", dimension: 8 } }),
    );
    await expect(
      ensureSidecar(spec("postgresql://swarm:swarm@127.0.0.1:1/none"), { node: "/nonexistent/node", runtime, stackDir, quiet: true }),
    ).rejects.toThrow(/ollama.*gpu\.example\.invalid/);
  });
});
