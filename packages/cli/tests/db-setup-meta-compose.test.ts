/**
 * `swarm db setup` must provision BOTH compose files.
 *
 * Before this fix runDbSetup wrote only docker-compose.yml (the cold store) to
 * ~/.swarm/infrastructure/. Fresh installs then hit ensurePostgres
 * failures because meta-pg had no docker-compose.meta.yml at the global infra
 * path. ensureInfraComposeFiles() now writes both, idempotently.
 *
 * These tests run the provisioning step against a temp HOME using the real
 * filesystem (no fs mocks) and assert both files land and that a re-run on a
 * dir missing only the meta file backfills it without clobbering the cold one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db.ts derives its path constants from os.homedir() at import time, and
// os.homedir() honors $HOME on POSIX. Set HOME to a temp dir, reset the module
// registry, then import dynamically so INFRA_DIR/COMPOSE_FILE re-bind inside
// the sandbox for each test.
async function loadModuleWithHome(home: string) {
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows parity, harmless on POSIX
  vi.resetModules();
  return import("../src/cli/db.js");
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = mkdtempSync(join(tmpdir(), "swarm-db-setup-"));
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("ensureInfraComposeFiles", () => {
  it("provisions BOTH the cold-store and meta-store compose files on a fresh install", async () => {
    const { ensureInfraComposeFiles } = await loadModuleWithHome(tmpHome);

    const infraDir = join(tmpHome, ".swarm", "infrastructure");
    const coldFile = join(infraDir, "docker-compose.yml");
    const metaFile = join(infraDir, "docker-compose.meta.yml");

    expect(existsSync(coldFile)).toBe(false);
    expect(existsSync(metaFile)).toBe(false);

    ensureInfraComposeFiles();

    expect(existsSync(coldFile)).toBe(true);
    expect(existsSync(metaFile)).toBe(true);

    // Sanity: each file describes its own service / port.
    const cold = readFileSync(coldFile, "utf-8");
    const meta = readFileSync(metaFile, "utf-8");
    expect(cold).toContain("swarm-substrate");
    expect(cold).toContain("127.0.0.1:32337:5432");
    expect(meta).toContain("swarm-meta");
    expect(meta).toContain("127.0.0.1:32340:5432");
  });

  it("writes Substrate-era files: pgvector, the swarm and swarm_meta databases, loopback-only ports, one compose project each", async () => {
    const { ensureInfraComposeFiles } = await loadModuleWithHome(tmpHome);
    ensureInfraComposeFiles();
    const infraDir = join(tmpHome, ".swarm", "infrastructure");
    const cold = readFileSync(join(infraDir, "docker-compose.yml"), "utf-8");
    const meta = readFileSync(join(infraDir, "docker-compose.meta.yml"), "utf-8");

    expect(cold).toMatch(/^name: swarm-substrate$/m);
    expect(cold).toMatch(/^  swarm-substrate:$/m);
    expect(cold).toMatch(/POSTGRES_DB: swarm$/m);
    expect(meta).toMatch(/^name: swarm-meta$/m);
    expect(meta).toMatch(/^  swarm-meta:$/m);
    expect(meta).toMatch(/POSTGRES_DB: swarm_meta$/m);
    for (const file of [cold, meta]) {
      expect(file).toContain("image: pgvector/pgvector:pg17");
      // Published on loopback only, never on every interface.
      for (const line of file.split("\n").filter((l) => /:5432"/.test(l))) expect(line).toMatch(/"127\.0\.0\.1:\d+:5432"/);
      expect(file).not.toMatch(/3133\d/);
    }
    // The lifecycle brings this directory up: it must read as a Substrate-era compose dir.
    const { isSubstrateComposeDir } = await import("@mnmal-ai/swarm-substrate");
    expect(isSubstrateComposeDir(infraDir)).toBe(true);
  });

  it("backfills a missing meta file on re-run without clobbering the cold-store file", async () => {
    const { ensureInfraComposeFiles } = await loadModuleWithHome(tmpHome);

    const infraDir = join(tmpHome, ".swarm", "infrastructure");
    const coldFile = join(infraDir, "docker-compose.yml");
    const metaFile = join(infraDir, "docker-compose.meta.yml");

    // Simulate an install from before the meta store: infra dir + cold compose only, no meta.
    mkdirSync(infraDir, { recursive: true });
    const sentinel = "services:\n  swarm-substrate:\n    image: custom-do-not-touch\n";
    writeFileSync(coldFile, sentinel);
    expect(existsSync(metaFile)).toBe(false);

    ensureInfraComposeFiles();

    // Meta file is backfilled...
    expect(existsSync(metaFile)).toBe(true);
    expect(readFileSync(metaFile, "utf-8")).toContain("swarm-meta");

    // ...and the cold file IS refreshed to the canonical content (stale rewrite),
    // not left as the divergent sentinel. The cold store is swarm-owned infra.
    expect(readFileSync(coldFile, "utf-8")).toContain("swarm-substrate");
    expect(readFileSync(coldFile, "utf-8")).not.toContain("custom-do-not-touch");
  });

  it("is idempotent: a second run leaves an up-to-date pair untouched", async () => {
    const { ensureInfraComposeFiles } = await loadModuleWithHome(tmpHome);

    const infraDir = join(tmpHome, ".swarm", "infrastructure");
    const coldFile = join(infraDir, "docker-compose.yml");
    const metaFile = join(infraDir, "docker-compose.meta.yml");

    ensureInfraComposeFiles();
    const coldAfterFirst = readFileSync(coldFile, "utf-8");
    const metaAfterFirst = readFileSync(metaFile, "utf-8");

    ensureInfraComposeFiles();

    expect(readFileSync(coldFile, "utf-8")).toBe(coldAfterFirst);
    expect(readFileSync(metaFile, "utf-8")).toBe(metaAfterFirst);
  });
});

describe("resetColdStore", () => {
  it("drops the cold store's volume only, and never touches the meta compose file", async () => {
    const { resetColdStore, ensureInfraComposeFiles } = await loadModuleWithHome(tmpHome);
    ensureInfraComposeFiles();
    const calls: string[][] = [];
    resetColdStore((args) => {
      calls.push(args);
    });
    const coldFile = join(tmpHome, ".swarm", "infrastructure", "docker-compose.yml");
    expect(calls).toEqual([
      ["compose", "-f", coldFile, "down", "-v"],
      ["compose", "-f", coldFile, "up", "-d"],
    ]);
    expect(calls.flat().some((a) => a.includes("meta"))).toBe(false);
    // Its own compose project, so `down -v` cannot reach the meta volume or network.
    expect(readFileSync(coldFile, "utf-8")).toMatch(/^name: swarm-substrate$/m);
  });
});

describe("db setup with an existing Postgres", () => {
  it("saves the sidecar URL as substrate_url when one is given, and nothing when it is blank", async () => {
    const { connectionStringConfig } = await loadModuleWithHome(tmpHome);
    const url = "postgresql://u:p@db.internal:5432/swarm";
    expect(connectionStringConfig(url, "http://localhost:32338")).toEqual({
      postgres_url: url,
      db_mode: "connection_string",
      substrate_url: "http://localhost:32338",
    });
    expect(connectionStringConfig(url, "  ")).toEqual({ postgres_url: url, db_mode: "connection_string" });
  });
});
