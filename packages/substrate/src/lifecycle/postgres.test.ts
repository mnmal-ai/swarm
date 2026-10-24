import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ensurePostgres,
  infrastructureDir,
  isSubstrateComposeDir,
  probePostgresReachable,
  resolveComposeDir,
} from "./postgres.js";

// Ported from the previous engine package's tests/probe-postgres.test.ts.
describe("probePostgresReachable", () => {
  let server: Server;
  let listeningPort: number;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const addr = server.address();
    if (typeof addr === "object" && addr) listeningPort = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("returns reachable=true for a listening socket", async () => {
    const result = await probePostgresReachable(
      `postgresql://swarm:swarm@127.0.0.1:${listeningPort}/swarm`,
      1_000,
    );
    expect(result.reachable).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(listeningPort);
  });

  it("returns reachable=false when nothing is listening on the port", async () => {
    // Pick a port we just released by closing a temporary listener
    const tmp = createServer();
    const freePort: number = await new Promise((resolvePromise) => {
      tmp.listen(0, "127.0.0.1", () => {
        const addr = tmp.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        tmp.close(() => resolvePromise(port));
      });
    });

    const result = await probePostgresReachable(
      `postgresql://swarm:swarm@127.0.0.1:${freePort}/swarm`,
      500,
    );
    expect(result.reachable).toBe(false);
    expect(result.port).toBe(freePort);
  });

  it("tolerates a malformed URL and returns reachable=false", async () => {
    const result = await probePostgresReachable("not a url", 200);
    expect(result.reachable).toBe(false);
  });
});

describe("compose directory detection", () => {
  let savedHome: string | undefined;
  let home: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "substrate-pg-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const writeCompose = (dir: string, service: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "docker-compose.yml"), `services:\n  ${service}:\n    image: pgvector/pgvector:pg17\n`);
  };

  it("uses ~/.swarm/infrastructure only when its compose file names swarm-substrate", () => {
    expect(infrastructureDir()).toBe(join(home, ".swarm", "infrastructure"));
    writeCompose(infrastructureDir(), "swarm-legacy");
    expect(isSubstrateComposeDir(infrastructureDir())).toBe(false);
    expect(resolveComposeDir()).not.toBe(infrastructureDir());

    writeCompose(infrastructureDir(), "swarm-substrate");
    expect(isSubstrateComposeDir(infrastructureDir())).toBe(true);
    expect(resolveComposeDir()).toBe(infrastructureDir());
    expect(resolveComposeDir("/explicit/dir")).toBe("/explicit/dir");
  });

  it("ensurePostgres refuses a pre-Substrate compose directory before running docker", async () => {
    const dir = join(home, "old");
    writeCompose(dir, "swarm-legacy");
    await expect(ensurePostgres(dir, true)).rejects.toThrow(/no 'swarm-substrate' service.*swarm db setup/s);
  });
});
