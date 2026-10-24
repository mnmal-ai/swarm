import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalOnlyViolation, resolveSidecarSpecs, specFor } from "@mnmal-ai/swarm-substrate";
import {
  applyProjectSubstrateConfig,
  composeEnv,
  dedicatedEnv,
  prepareProjectSubstrate,
  ProjectSubstrateConfigError,
  readProjectSubstrateConfig,
} from "../src/project-substrate.js";

const STACK = {
  port: 47338,
  postgres_url: "postgresql://swarm:swarm@127.0.0.1:47337/swarm",
  meta_port: 47341,
  meta_postgres_url: "postgresql://swarm:swarm@127.0.0.1:47340/swarm_meta",
};

let swarmDir: string;
beforeEach(() => {
  swarmDir = join(mkdtempSync(join(tmpdir(), "project-substrate-")), ".swarm");
  mkdirSync(join(swarmDir, "domains", "project-a"), { recursive: true });
});
afterEach(() => rmSync(join(swarmDir, ".."), { recursive: true, force: true }));

function writeSwarmConfig(cfg: unknown): void {
  writeFileSync(join(swarmDir, "config.json"), JSON.stringify(cfg));
}
function writeDomainConfig(cfg: unknown): void {
  writeFileSync(join(swarmDir, "domains", "project-a", "config.json"), JSON.stringify(cfg));
}

describe("readProjectSubstrateConfig", () => {
  it("is a no-op for a project with no substrate block (the shared stack)", () => {
    writeDomainConfig({ name: "project-a" });
    const cfg = readProjectSubstrateConfig(swarmDir, "project-a");
    expect(cfg).toMatchObject({ localOnly: false, sources: [] });
    expect(cfg.dedicated).toBeUndefined();
  });

  it("reads a dedicated stack and local_only from the domain config", () => {
    writeDomainConfig({ substrate: { local_only: true, ...STACK } });
    const cfg = readProjectSubstrateConfig(swarmDir, "project-a");
    expect(cfg.localOnly).toBe(true);
    expect(cfg.dedicated).toEqual({
      port: 47338,
      postgresUrl: STACK.postgres_url,
      metaPort: 47341,
      metaPostgresUrl: STACK.meta_postgres_url,
      stack: "swarm-dedicated-47338",
    });
  });

  it("names the dedicated stack by its compose project, which may stand without a compose file", () => {
    writeDomainConfig({ substrate: { ...STACK, compose_project: "swarm-project-a" } });
    const cfg = readProjectSubstrateConfig(swarmDir, "project-a");
    expect(cfg.dedicated?.stack).toBe("swarm-project-a");
    expect(cfg.compose).toBeUndefined();
  });

  it("refuses a compose project that is not a compose project name, or one without a dedicated stack", () => {
    writeDomainConfig({ substrate: { ...STACK, compose_project: "../escape" } });
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/substrate\.compose_project must be/);
    writeDomainConfig({ substrate: { compose_project: "swarm-project-a" } });
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/needs the dedicated stack keys/);
  });

  it("turns the guard on for local_only: true in a block of any name, in either file or another domain", () => {
    writeDomainConfig({ legacy: { local_only: true } });
    expect(readProjectSubstrateConfig(swarmDir, "project-a").localOnly).toBe(true);
    rmSync(join(swarmDir, "domains", "project-a", "config.json"));
    writeSwarmConfig({ legacy: { local_only: true } });
    expect(readProjectSubstrateConfig(swarmDir, "project-a").localOnly).toBe(true);
    rmSync(join(swarmDir, "config.json"));
    mkdirSync(join(swarmDir, "domains", "project-b"), { recursive: true });
    writeFileSync(join(swarmDir, "domains", "project-b", "config.json"), JSON.stringify({ other: { local_only: true } }));
    expect(readProjectSubstrateConfig(swarmDir, "project-a").localOnly).toBe(true);
  });

  it("does not take stack keys from a block that is not named substrate", () => {
    writeDomainConfig({ legacy: { local_only: true, ...STACK } });
    const cfg = readProjectSubstrateConfig(swarmDir, "project-a");
    expect(cfg.localOnly).toBe(true);
    expect(cfg.dedicated).toBeUndefined();
  });

  it("lets either file turn local_only on and neither turn it off", () => {
    writeSwarmConfig({ substrate: { local_only: true } });
    writeDomainConfig({ substrate: { local_only: false } });
    expect(readProjectSubstrateConfig(swarmDir, "project-a").localOnly).toBe(true);
  });

  it("refuses a partial stack, which would still share the missing store", () => {
    writeDomainConfig({ substrate: { port: 47338, postgres_url: STACK.postgres_url } });
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(
      /substrate\.meta_port.*substrate\.meta_postgres_url/,
    );
  });

  it("resolves compose_file relative to the config file that names it", () => {
    writeDomainConfig({
      substrate: { ...STACK, compose_file: "substrate/docker-compose.yml", compose_project: "swarm-project-a" },
    });
    const cfg = readProjectSubstrateConfig(swarmDir, "project-a");
    expect(cfg.compose).toEqual({
      file: join(swarmDir, "domains", "project-a", "substrate", "docker-compose.yml"),
      project: "swarm-project-a",
    });
  });

  it("reports telemetry sharing so local_only can refuse it", () => {
    writeDomainConfig({ substrate: { local_only: true }, telemetry_sharing: { enabled: true } });
    expect(readProjectSubstrateConfig(swarmDir, "project-a").telemetrySharing).toBe(true);
  });

  it("honours local_only from another domain, whatever project was resolved", () => {
    mkdirSync(join(swarmDir, "domains", "other"), { recursive: true });
    writeFileSync(join(swarmDir, "domains", "other", "config.json"), JSON.stringify({ substrate: { local_only: true } }));
    expect(readProjectSubstrateConfig(swarmDir, "project-a").localOnly).toBe(true);
  });

  it("rejects another domain's local_only that is not a boolean, as it would for this project's", () => {
    mkdirSync(join(swarmDir, "domains", "other"), { recursive: true });
    writeFileSync(join(swarmDir, "domains", "other", "config.json"), JSON.stringify({ substrate: { local_only: "yes" } }));
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/local_only must be true or false/);
  });

  it("refuses to fall back to the shared stack when another domain declares a dedicated one", () => {
    mkdirSync(join(swarmDir, "domains", "other"), { recursive: true });
    writeFileSync(join(swarmDir, "domains", "other", "config.json"), JSON.stringify({ substrate: STACK }));
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/resolved the project as 'project-a'/);
  });

  it("requires each Postgres URL to name a host", () => {
    for (const bad of ["postgresql:///", "postgresql://", "postgres:///swarm", "not a url", "http://127.0.0.1:47337/swarm"]) {
      writeDomainConfig({ substrate: { ...STACK, postgres_url: bad } });
      expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(ProjectSubstrateConfigError);
      expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/substrate\.postgres_url must be/);
    }
    writeDomainConfig({ substrate: { ...STACK, meta_postgres_url: "postgresql:///" } });
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/substrate\.meta_postgres_url must be/);
  });

  it("accepts postgres:// and postgresql:// URLs that name a host", () => {
    for (const good of ["postgresql://swarm:swarm@127.0.0.1:47337/swarm", "postgres://swarm@localhost/swarm"]) {
      writeDomainConfig({ substrate: { ...STACK, postgres_url: good } });
      expect(readProjectSubstrateConfig(swarmDir, "project-a").dedicated?.postgresUrl).toBe(good);
    }
  });

  it("rejects malformed values", () => {
    writeDomainConfig({ substrate: { ...STACK, meta_port: STACK.port } });
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(ProjectSubstrateConfigError);
    writeDomainConfig({ substrate: { local_only: "yes" } });
    expect(() => readProjectSubstrateConfig(swarmDir, "project-a")).toThrow(/local_only/);
  });
});

describe("applyProjectSubstrateConfig", () => {
  function dedicated() {
    writeDomainConfig({ substrate: { local_only: true, ...STACK } });
    return readProjectSubstrateConfig(swarmDir, "project-a");
  }

  it("puts the project's stack into the environment every consumer reads", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProjectSubstrateConfig(dedicated(), env);
    expect(env).toMatchObject({
      SWARM_SUBSTRATE_PORT: "47338",
      SWARM_SUBSTRATE_ENDPOINT: "http://127.0.0.1:47338",
      SWARM_SUBSTRATE_POSTGRES_URL: STACK.postgres_url,
      SWARM_META_PORT: "47341",
      SWARM_META_ENDPOINT: "http://127.0.0.1:47341",
      SWARM_META_POSTGRES_URL: STACK.meta_postgres_url,
      SWARM_SUBSTRATE_LOCAL_ONLY: "1",
      SWARM_SUBSTRATE_DEDICATED: "1",
    });
  });

  it("refuses an environment that points at another stack", () => {
    const env: NodeJS.ProcessEnv = { SWARM_SUBSTRATE_PORT: "32338" };
    expect(() => applyProjectSubstrateConfig(dedicated(), env)).toThrow(/SWARM_SUBSTRATE_PORT=32338/);
    expect(() =>
      applyProjectSubstrateConfig(dedicated(), { SWARM_META_POSTGRES_URL: "postgresql://swarm:swarm@localhost:32340/swarm_meta" }),
    ).toThrow(/SWARM_META_POSTGRES_URL/);
  });

  it("refuses a stray SWARM_SUBSTRATE_ENDPOINT that points at another stack, naming both", () => {
    const stray = "http://127.0.0.1:32338";
    let err: unknown;
    try {
      applyProjectSubstrateConfig(dedicated(), { SWARM_SUBSTRATE_ENDPOINT: stray });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectSubstrateConfigError);
    const message = (err as Error).message;
    // The stray endpoint and the stack the project's config declares.
    expect(message).toContain(`SWARM_SUBSTRATE_ENDPOINT=${stray}`);
    expect(message).toContain("http://127.0.0.1:47338");
    // Nothing was applied: the stray value is never silently followed or overwritten.
    const env: NodeJS.ProcessEnv = { SWARM_SUBSTRATE_ENDPOINT: stray };
    expect(() => applyProjectSubstrateConfig(dedicated(), env)).toThrow(ProjectSubstrateConfigError);
    expect(env).toEqual({ SWARM_SUBSTRATE_ENDPOINT: stray });
  });

  it("refuses a stray SWARM_META_ENDPOINT the same way", () => {
    expect(() => applyProjectSubstrateConfig(dedicated(), { SWARM_META_ENDPOINT: "http://127.0.0.1:32341" })).toThrow(
      /SWARM_META_ENDPOINT=http:\/\/127\.0\.0\.1:32341.*http:\/\/127\.0\.0\.1:47341/,
    );
  });

  it("accepts a matching environment, including localhost for 127.0.0.1", () => {
    const env: NodeJS.ProcessEnv = { SWARM_SUBSTRATE_ENDPOINT: "http://localhost:47338", SWARM_SUBSTRATE_PORT: "47338" };
    expect(() => applyProjectSubstrateConfig(dedicated(), env)).not.toThrow();
    for (const endpoint of ["http://127.0.0.1:47338", "http://[::1]:47338"]) {
      expect(() => applyProjectSubstrateConfig(dedicated(), { SWARM_SUBSTRATE_ENDPOINT: endpoint })).not.toThrow();
    }
  });

  it("refuses an endpoint on the right host and port but the wrong scheme", () => {
    for (const endpoint of ["https://localhost:47338", "https://127.0.0.1:47338"]) {
      expect(() => applyProjectSubstrateConfig(dedicated(), { SWARM_SUBSTRATE_ENDPOINT: endpoint })).toThrow(
        /SWARM_SUBSTRATE_ENDPOINT=https:/,
      );
    }
  });

  it("folds only localhost, 127.0.0.1 and ::1 together, not the rest of 127.0.0.0/8", () => {
    // Distinct loopback addresses can be different services.
    expect(() =>
      applyProjectSubstrateConfig(dedicated(), { SWARM_SUBSTRATE_ENDPOINT: "http://127.0.0.2:47338" }),
    ).toThrow(/SWARM_SUBSTRATE_ENDPOINT=http:\/\/127\.0\.0\.2:47338/);
  });

  it("derives the compose ports from the Postgres URLs", () => {
    const cfg = dedicated();
    expect(composeEnv(cfg.dedicated!)).toEqual({ SWARM_DEDICATED_PG_PORT: "47337", SWARM_DEDICATED_META_PG_PORT: "47340" });
    expect(dedicatedEnv(cfg.dedicated!).SWARM_SUBSTRATE_ENDPOINT).toBe("http://127.0.0.1:47338");
  });
});

describe("prepareProjectSubstrate (what the CLI preamble and swarm init run)", () => {
  const KEYS = [
    "HOME",
    "SWARM_SUBSTRATE_PORT",
    "SWARM_SUBSTRATE_ENDPOINT",
    "SWARM_SUBSTRATE_POSTGRES_URL",
    "SWARM_META_PORT",
    "SWARM_META_ENDPOINT",
    "SWARM_META_POSTGRES_URL",
    "SWARM_SUBSTRATE_LOCAL_ONLY",
    "SWARM_SUBSTRATE_DEDICATED",
    "SWARM_EMBEDDER_KIND",
    "SWARM_EMBEDDER_OLLAMA_URL",
    "SWARM_EMBEDDER_MODEL",
    "SWARM_EMBEDDER_DIMENSION",
    "SWARM_EMBED_ON_WRITE",
    "SWARM_EMBEDDER_TIMEOUT_MS",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // No real ~/.swarm/config.json (its substrate_url) may leak in.
    process.env.HOME = join(swarmDir, "..", "home");
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("with a postgres_url saved by `swarm db setup` (bring your own Postgres)", () => {
    const BYO = "postgresql://app:secret@127.0.0.1:55432/swarm";
    function saveGlobalPostgres(url: string): void {
      const home = process.env.HOME as string;
      mkdirSync(join(home, ".swarm"), { recursive: true });
      writeFileSync(join(home, ".swarm", "config.json"), JSON.stringify({ postgres_url: url, db_mode: "connection_string" }));
    }
    const coldPostgres = () => specFor(resolveSidecarSpecs(), "cold").postgresUrl;

    it("hands the saved URL to the cold sidecar of a shared-stack project", async () => {
      saveGlobalPostgres(BYO);
      await prepareProjectSubstrate(swarmDir, "project-a");
      expect(coldPostgres()).toBe(BYO);
    });

    it("lets the project's substrate.postgres_url outrank it", async () => {
      saveGlobalPostgres(BYO);
      writeSwarmConfig({ substrate: STACK });
      await prepareProjectSubstrate(swarmDir, "project-a");
      expect(coldPostgres()).toBe(STACK.postgres_url);
    });

    it("lets SWARM_SUBSTRATE_POSTGRES_URL outrank it", async () => {
      saveGlobalPostgres(BYO);
      process.env.SWARM_SUBSTRATE_POSTGRES_URL = "postgresql://swarm:swarm@127.0.0.1:46337/swarm";
      await prepareProjectSubstrate(swarmDir, "project-a");
      expect(coldPostgres()).toBe("postgresql://swarm:swarm@127.0.0.1:46337/swarm");
    });

    it("refuses it for a local_only project when it is off this machine", async () => {
      saveGlobalPostgres("postgresql://app:secret@db.internal:5432/swarm");
      writeDomainConfig({ substrate: { local_only: true } });
      await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(LocalOnlyViolation);
      await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/Substrate Postgres URL.*db\.internal/);
    });
  });

  it("returns the isolated bring-up for a dedicated, local_only project", async () => {
    writeSwarmConfig({
      substrate: { local_only: true, ...STACK, compose_file: "substrate/dc.yml", compose_project: "swarm-project-a" },
    });
    const { isolated } = await prepareProjectSubstrate(swarmDir, "project-a");
    expect(isolated).toEqual({
      composeFile: join(swarmDir, "substrate", "dc.yml"),
      composeProject: "swarm-project-a",
      composeEnv: { SWARM_DEDICATED_PG_PORT: "47337", SWARM_DEDICATED_META_PG_PORT: "47340" },
    });
    expect(process.env.SWARM_SUBSTRATE_LOCAL_ONLY).toBe("1");
  });

  it("names a dedicated stack without a compose file for the lifecycle's stack directories", async () => {
    writeSwarmConfig({ substrate: { ...STACK } });
    const { isolated } = await prepareProjectSubstrate(swarmDir, "project-a");
    expect(isolated).toEqual({ composeProject: "swarm-dedicated-47338" });
  });

  it("gives the sidecars this project's embedder when context.ranking is on", async () => {
    writeDomainConfig({ substrate: { local_only: true }, context: { sections: { enabled: true }, ranking: { enabled: true } } });
    await prepareProjectSubstrate(swarmDir, "project-a");
    expect(process.env.SWARM_EMBEDDER_MODEL).toBe("bge-m3");
    expect(process.env.SWARM_EMBEDDER_DIMENSION).toBe("1024");
    expect(process.env.SWARM_EMBEDDER_OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(process.env.SWARM_EMBEDDER_KIND).toBe("ollama");
    expect(process.env.SWARM_EMBED_ON_WRITE).toBe("1");
  });

  it("reads context.ranking from the domain config only, as swarm run does", async () => {
    writeSwarmConfig({ context: { sections: { enabled: true }, ranking: { enabled: true } } });
    await prepareProjectSubstrate(swarmDir, "project-a");
    expect(process.env.SWARM_EMBED_ON_WRITE).toBeUndefined();
  });

  it("leaves the embedder alone when ranking is off", async () => {
    writeDomainConfig({ context: { sections: { enabled: true } } });
    await prepareProjectSubstrate(swarmDir, "project-a");
    expect(process.env.SWARM_EMBED_ON_WRITE).toBeUndefined();
    expect(process.env.SWARM_EMBEDDER_MODEL).toBeUndefined();
  });

  it("refuses an environment that names another embedder, and a non-loopback Ollama for a local_only project", async () => {
    writeDomainConfig({ context: { sections: { enabled: true }, ranking: { enabled: true } } });
    process.env.SWARM_EMBEDDER_MODEL = "nomic-embed-text";
    await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/SWARM_EMBEDDER_MODEL=nomic-embed-text/);
    delete process.env.SWARM_EMBEDDER_MODEL;
    process.env.SWARM_EMBEDDER_KIND = "none";
    await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/SWARM_EMBEDDER_KIND=none/);
    delete process.env.SWARM_EMBEDDER_KIND;
    writeDomainConfig({
      substrate: { local_only: true },
      context: { sections: { enabled: true }, ranking: { enabled: true, ollamaUrl: "http://gpu-box.lan:11434" } },
    });
    await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/SWARM_EMBEDDER_OLLAMA_URL/);
  });

  it("refuses a malformed context.ranking before starting anything", async () => {
    writeDomainConfig({ context: { ranking: { enabled: true } } });
    await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/context.ranking needs context.sections.enabled/);
  });

  it("refuses a local_only project with telemetry sharing or an off-machine Substrate endpoint", async () => {
    writeDomainConfig({ substrate: { local_only: true }, telemetry_sharing: { enabled: true } });
    await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/telemetry_sharing/);
    writeDomainConfig({ substrate: { local_only: true } });
    process.env.SWARM_SUBSTRATE_ENDPOINT = "https://substrate.example.invalid:32338";
    await expect(prepareProjectSubstrate(swarmDir, "project-a")).rejects.toThrow(/SWARM_SUBSTRATE_ENDPOINT/);
  });
});
