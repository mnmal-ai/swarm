import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveMetaEndpointWithSource,
  resolveSubstrateEndpoint,
  resolveSubstrateEndpointWithSource,
} from "./endpoint.js";

const KEYS = [
  "HOME",
  "SWARM_SUBSTRATE_ENDPOINT",
  "SWARM_SUBSTRATE_PORT",
  "SWARM_META_ENDPOINT",
  "SWARM_META_PORT",
] as const;

describe("endpoint resolution", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "substrate-endpoint-home-"));
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

  it("resolves in order: explicit, env endpoint, saved substrate_url, env port, default 32338", () => {
    expect(resolveSubstrateEndpointWithSource()).toEqual({ url: "http://localhost:32338", source: "default" });

    process.env.SWARM_SUBSTRATE_PORT = "45338";
    expect(resolveSubstrateEndpointWithSource()).toEqual({
      url: "http://localhost:45338",
      source: "SWARM_SUBSTRATE_PORT",
    });

    saveSubstrateUrl("http://127.0.0.1:46338");
    const fromConfig = resolveSubstrateEndpointWithSource();
    expect(fromConfig.url).toBe("http://127.0.0.1:46338");
    expect(fromConfig.source).toBe(`substrate_url in ${join(home, ".swarm", "config.json")}`);

    process.env.SWARM_SUBSTRATE_ENDPOINT = "http://127.0.0.1:47338";
    expect(resolveSubstrateEndpointWithSource()).toEqual({
      url: "http://127.0.0.1:47338",
      source: "SWARM_SUBSTRATE_ENDPOINT",
    });

    expect(resolveSubstrateEndpointWithSource("http://127.0.0.1:48338")).toEqual({
      url: "http://127.0.0.1:48338",
      source: "explicit endpoint",
    });
    expect(resolveSubstrateEndpoint("http://127.0.0.1:48338")).toBe("http://127.0.0.1:48338");
  });

  it("ignores a saved legacy url key and an unparseable config", () => {
    mkdirSync(join(home, ".swarm"), { recursive: true });
    writeFileSync(join(home, ".swarm", "config.json"), JSON.stringify({ legacy_url: "http://127.0.0.1:31338" }));
    expect(resolveSubstrateEndpoint()).toBe("http://localhost:32338");
    writeFileSync(join(home, ".swarm", "config.json"), "{ not json");
    expect(resolveSubstrateEndpoint()).toBe("http://localhost:32338");
  });

  it("never writes ~/.swarm/config.json while resolving", () => {
    resolveSubstrateEndpoint();
    resolveMetaEndpointWithSource();
    expect(existsSync(join(home, ".swarm"))).toBe(false);
  });

  it("resolves the meta endpoint: SWARM_META_ENDPOINT, SWARM_META_PORT, default 32341", () => {
    expect(resolveMetaEndpointWithSource()).toEqual({ url: "http://localhost:32341", source: "default" });
    process.env.SWARM_META_PORT = "45341";
    expect(resolveMetaEndpointWithSource()).toEqual({ url: "http://localhost:45341", source: "SWARM_META_PORT" });
    process.env.SWARM_META_ENDPOINT = "http://127.0.0.1:47341";
    expect(resolveMetaEndpointWithSource()).toEqual({
      url: "http://127.0.0.1:47341",
      source: "SWARM_META_ENDPOINT",
    });
  });
});
