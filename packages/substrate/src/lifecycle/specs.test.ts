import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_META_POSTGRES_URL, DEFAULT_POSTGRES_URL, resolveSidecarSpecs, specFor } from "./specs.js";

// `swarm db setup` saves a bring-your-own Postgres as `postgres_url` in
// ~/.swarm/config.json. HOME is a temp directory, so no real config is read.
describe("resolveSidecarSpecs: the cold store's Postgres", () => {
  const BYO = "postgresql://app:secret@127.0.0.1:55432/swarm";
  const ENV_URL = "postgresql://swarm:swarm@127.0.0.1:47337/swarm";
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "substrate-specs-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function saveGlobalConfig(cfg: unknown): void {
    mkdirSync(join(home, ".swarm"), { recursive: true });
    writeFileSync(join(home, ".swarm", "config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  }
  const cold = (opts: Parameters<typeof resolveSidecarSpecs>[0]) => specFor(resolveSidecarSpecs(opts), "cold");

  it("is the docker-compose Postgres when nothing is configured", () => {
    expect(cold({ env: {} })).toMatchObject({ postgresUrl: DEFAULT_POSTGRES_URL, postgresUrlSource: "default" });
  });

  it("is the postgres_url saved in ~/.swarm/config.json, which reaches the cold spec", () => {
    saveGlobalConfig({ postgres_url: BYO, db_mode: "connection_string" });
    expect(cold({ env: {} })).toMatchObject({
      postgresUrl: BYO,
      postgresUrlSource: `postgres_url in ${join(home, ".swarm", "config.json")}`,
    });
  });

  it("ignores a postgres_url saved in docker mode or with no db_mode, even a loopback one on another port", () => {
    // A config copied from elsewhere can carry a docker-mode URL for some other
    // Postgres on this machine; local_only cannot catch it (it is loopback), so
    // only a URL the user gave `swarm db setup` (connection_string) is honoured.
    const ELSEWHERE = "postgresql://swarm:swarm@localhost:55433/swarm";
    saveGlobalConfig({ postgres_url: ELSEWHERE, db_mode: "docker" });
    expect(cold({ env: {} })).toMatchObject({ postgresUrl: DEFAULT_POSTGRES_URL, postgresUrlSource: "default" });
    saveGlobalConfig({ postgres_url: ELSEWHERE });
    expect(cold({ env: {} })).toMatchObject({ postgresUrl: DEFAULT_POSTGRES_URL, postgresUrlSource: "default" });
    saveGlobalConfig({ postgres_url: ELSEWHERE, db_mode: "connection_string" });
    expect(cold({ env: {} }).postgresUrl).toBe(ELSEWHERE);
  });

  it("SWARM_SUBSTRATE_POSTGRES_URL outranks the saved postgres_url", () => {
    saveGlobalConfig({ postgres_url: BYO, db_mode: "connection_string" });
    expect(cold({ env: { SWARM_SUBSTRATE_POSTGRES_URL: ENV_URL } })).toMatchObject({
      postgresUrl: ENV_URL,
      postgresUrlSource: "SWARM_SUBSTRATE_POSTGRES_URL",
    });
  });

  it("ignores a saved postgres_url that is not a postgres URL, and an unparseable config", () => {
    saveGlobalConfig({ postgres_url: "mysql://x@127.0.0.1/db", db_mode: "connection_string" });
    expect(cold({ env: {} }).postgresUrl).toBe(DEFAULT_POSTGRES_URL);
    saveGlobalConfig("{ not json");
    expect(cold({ env: {} }).postgresUrl).toBe(DEFAULT_POSTGRES_URL);
  });

  it("never gives a dedicated stack the machine-wide saved postgres_url", () => {
    saveGlobalConfig({ postgres_url: BYO, db_mode: "connection_string" });
    expect(cold({ env: {}, stack: "swarm-project-a" }).postgresUrl).toBe(DEFAULT_POSTGRES_URL);
  });

  it("leaves the meta store's Postgres to SWARM_META_POSTGRES_URL and its default", () => {
    saveGlobalConfig({ postgres_url: BYO, db_mode: "connection_string" });
    expect(specFor(resolveSidecarSpecs({ env: {} }), "meta")).toMatchObject({
      postgresUrl: DEFAULT_META_POSTGRES_URL,
      postgresUrlSource: "default",
    });
  });
});
