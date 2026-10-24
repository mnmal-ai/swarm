import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs (existsSync) and node:fs/promises (readFile) before importing
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    throw new Error("not found");
  }),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveDbConfig, forcePollFallback } from "../src/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReadFile = vi.mocked(readFile);

const DEFAULT_DOCKER_URL = "postgresql://swarm:swarm@localhost:32337/swarm";

beforeEach(() => {
  delete process.env.SWARM_SUBSTRATE_POSTGRES_URL;
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReset();
  mockReadFileSync.mockReturnValue("");
  mockReadFile.mockReset();
  mockReadFile.mockRejectedValue(new Error("not found"));
});

describe("resolveDbConfig", () => {
  it("returns env source when SWARM_SUBSTRATE_POSTGRES_URL is set", async () => {
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = "postgresql://env-host:5432/mydb";

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("env");
    expect(result!.postgresUrl).toBe("postgresql://env-host:5432/mydb");
  });

  it("returns project source when .swarm/config.json has postgres_url", async () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === "/project/.swarm/config.json";
    });
    mockReadFile.mockImplementation(async (p) => {
      if (String(p) === "/project/.swarm/config.json") {
        return JSON.stringify({ postgres_url: "postgresql://project-host:5432/projectdb" });
      }
      throw new Error("not found");
    });

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("project");
    expect(result!.postgresUrl).toBe("postgresql://project-host:5432/projectdb");
  });

  it("returns global source when ~/.swarm/config.json has postgres_url", async () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === "/home/testuser/.swarm/config.json";
    });
    mockReadFile.mockImplementation(async (p) => {
      if (String(p) === "/home/testuser/.swarm/config.json") {
        return JSON.stringify({ postgres_url: "postgresql://global-host:5432/globaldb" });
      }
      throw new Error("not found");
    });

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("global");
    expect(result!.postgresUrl).toBe("postgresql://global-host:5432/globaldb");
  });

  it("promotes global config to docker source when compose file is also present", async () => {
    // This is the scenario `swarm init` / `swarm db setup` leaves behind:
    // both ~/.swarm/config.json (with postgres_url) and
    // ~/.swarm/infrastructure/docker-compose.yml exist. The caller needs
    // the compose dir to bootstrap Postgres on a fresh project dir.
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === "/home/testuser/.swarm/config.json"
        || s === "/home/testuser/.swarm/infrastructure/docker-compose.yml";
    });
    mockReadFile.mockImplementation(async (p) => {
      if (String(p) === "/home/testuser/.swarm/config.json") {
        return JSON.stringify({
          postgres_url: "postgresql://swarm:swarm@localhost:32337/swarm",
          db_mode: "docker",
        });
      }
      throw new Error("not found");
    });
    mockReadFileSync.mockReturnValue("services:\n  swarm-substrate:\n    image: pgvector/pgvector:pg17\n");

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("docker");
    expect(result!.dockerComposeDir).toBe("/home/testuser/.swarm/infrastructure");
    expect(result!.postgresUrl).toBe("postgresql://swarm:swarm@localhost:32337/swarm");
  });

  it("returns docker source when ~/.swarm/infrastructure/docker-compose.yml exists", async () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === "/home/testuser/.swarm/infrastructure/docker-compose.yml";
    });
    mockReadFileSync.mockReturnValue("services:\n  swarm-substrate:\n    image: pgvector/pgvector:pg17\n");

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("docker");
    expect(result!.postgresUrl).toBe(DEFAULT_DOCKER_URL);
  });

  it("does not take a pre-Substrate compose file (no swarm-substrate service) for swarm's", async () => {
    mockExistsSync.mockImplementation((p) => String(p) === "/home/testuser/.swarm/infrastructure/docker-compose.yml");
    mockReadFileSync.mockReturnValue("services:\n  swarm-old:\n    image: pgvector/pgvector:pg17\n    ports:\n      - \"31337:5432\"\n");

    expect(await resolveDbConfig({ swarmDir: "/project/.swarm" })).toBeNull();
  });

  it("returns docker source when ./docker-compose.yml in cwd exists", async () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === "docker-compose.yml";
    });
    mockReadFileSync.mockReturnValue("services:\n  swarm-substrate:\n    image: pgvector/pgvector:pg17\n");

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("docker");
    expect(result!.postgresUrl).toBe(DEFAULT_DOCKER_URL);
  });

  it("returns null when nothing is configured", async () => {
    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).toBeNull();
  });

  it("skips corrupted project config.json and falls through", async () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === "/project/.swarm/config.json";
    });
    mockReadFile.mockImplementation(async (p) => {
      if (String(p) === "/project/.swarm/config.json") {
        return "not valid json {{{{";
      }
      throw new Error("not found");
    });

    // Nothing else configured, so should return null
    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).toBeNull();
  });

  it("skips project config.json with no postgres_url and checks global", async () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === "/project/.swarm/config.json" || s === "/home/testuser/.swarm/config.json";
    });
    mockReadFile.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/project/.swarm/config.json") {
        return JSON.stringify({ some_other_key: "value" });
      }
      if (s === "/home/testuser/.swarm/config.json") {
        return JSON.stringify({ postgres_url: "postgresql://global-host:5432/globaldb" });
      }
      throw new Error("not found");
    });

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("global");
    expect(result!.postgresUrl).toBe("postgresql://global-host:5432/globaldb");
  });

  it("env var takes priority over project config", async () => {
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = "postgresql://env-wins:5432/db";
    mockExistsSync.mockImplementation((p) => {
      return String(p) === "/project/.swarm/config.json";
    });
    mockReadFile.mockImplementation(async () =>
      JSON.stringify({ postgres_url: "postgresql://project:5432/db" }),
    );

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result!.source).toBe("env");
    expect(result!.postgresUrl).toBe("postgresql://env-wins:5432/db");
  });
});

// ---------------------------------------------------------------------------
// Port-isolation regression tests.
//
// Guards the self-modifying swarm-on-swarm run: when SWARM_SUBSTRATE_POSTGRES_URL
// is unset, resolveDbConfig must resolve to the default 32337 docker Postgres
// (the live orchestrator/dev instance); when the env override is set (e.g. the
// alt-port 42337 test stack from docker-compose.test.yml), resolveDbConfig must
// honor it so test runs never touch the live default-port Substrate/Postgres.
//
// The outer beforeEach already deletes SWARM_SUBSTRATE_POSTGRES_URL, but these
// cases additionally save and restore the original key so nothing leaks into
// sibling tests regardless of the host shell's environment.
// ---------------------------------------------------------------------------
describe("resolveDbConfig — port isolation", () => {
  const ALT_PORT_TEST_URL = "postgresql://swarm:swarm@localhost:42337/swarm";
  let savedEnvUrl: string | undefined;

  // This block has its own save/restore around the outer `beforeEach` that
  // already deletes SWARM_SUBSTRATE_POSTGRES_URL — redundant in the common case,
  // but the inner guard preserves a value set BEFORE this describe runs
  // (e.g. when this block runs in isolation via `vitest -t "port isolation"`
  // or when the suite order changes). Cheap to keep; saves a surprise later
  // if a future describe sets the var in its own `beforeAll`.
  beforeEach(() => {
    savedEnvUrl = process.env.SWARM_SUBSTRATE_POSTGRES_URL;
    delete process.env.SWARM_SUBSTRATE_POSTGRES_URL;
  });

  afterEach(() => {
    if (savedEnvUrl === undefined) {
      delete process.env.SWARM_SUBSTRATE_POSTGRES_URL;
    } else {
      process.env.SWARM_SUBSTRATE_POSTGRES_URL = savedEnvUrl;
    }
  });

  it("falls back to the default 32337 docker Postgres URL when SWARM_SUBSTRATE_POSTGRES_URL is unset", async () => {
    // A swarm docker-compose.yml in cwd is the dev-mode resolution path.
    mockExistsSync.mockImplementation((p) => String(p) === "docker-compose.yml");
    mockReadFileSync.mockReturnValue("services:\n  swarm-substrate:\n    image: postgres:17\n");

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("docker");
    expect(result!.postgresUrl).toBe(DEFAULT_DOCKER_URL);
    expect(result!.postgresUrl).toContain(":32337/");
  });

  it("honors the SWARM_SUBSTRATE_POSTGRES_URL override and returns the alt-port 42337 test-stack URL", async () => {
    process.env.SWARM_SUBSTRATE_POSTGRES_URL = ALT_PORT_TEST_URL;
    // Even with the docker-compose default present, the env override wins and
    // the default 32337 instance is never selected.
    mockExistsSync.mockImplementation((p) => String(p) === "docker-compose.yml");
    mockReadFileSync.mockReturnValue("services:\n  swarm-substrate:\n    image: postgres:17\n");

    const result = await resolveDbConfig({ swarmDir: "/project/.swarm" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("env");
    expect(result!.postgresUrl).toBe(ALT_PORT_TEST_URL);
    expect(result!.postgresUrl).toContain(":42337/");
  });
});

// ---------------------------------------------------------------------------
// forcePollFallback — the env-flag escape hatch that forces consumers off the
// WS subscribe() push path and back onto polling, regardless of transport.
// Guards the swarm constraint that the poll fallback may never be removed
// without an env-flag override (goal-10).
// ---------------------------------------------------------------------------
describe("forcePollFallback", () => {
  let savedDisable: string | undefined;
  let savedPoll: string | undefined;

  beforeEach(() => {
    savedDisable = process.env.SWARM_DISABLE_SUBSCRIBE;
    savedPoll = process.env.SWARM_POLL_FALLBACK;
    delete process.env.SWARM_DISABLE_SUBSCRIBE;
    delete process.env.SWARM_POLL_FALLBACK;
  });

  afterEach(() => {
    if (savedDisable === undefined) delete process.env.SWARM_DISABLE_SUBSCRIBE;
    else process.env.SWARM_DISABLE_SUBSCRIBE = savedDisable;
    if (savedPoll === undefined) delete process.env.SWARM_POLL_FALLBACK;
    else process.env.SWARM_POLL_FALLBACK = savedPoll;
  });

  it("returns false when neither flag is set", () => {
    expect(forcePollFallback()).toBe(false);
  });

  it("returns true when SWARM_DISABLE_SUBSCRIBE is a truthy string", () => {
    process.env.SWARM_DISABLE_SUBSCRIBE = "1";
    expect(forcePollFallback()).toBe(true);
  });

  it("returns true when SWARM_POLL_FALLBACK is a truthy string", () => {
    process.env.SWARM_POLL_FALLBACK = "true";
    expect(forcePollFallback()).toBe(true);
  });

  it("treats empty string, 0, false, and off as disabled", () => {
    for (const falsy of ["", "0", "false", "FALSE", "off", "Off"]) {
      process.env.SWARM_DISABLE_SUBSCRIBE = falsy;
      expect(forcePollFallback()).toBe(false);
    }
  });

  it("treats an arbitrary non-falsy string as enabled", () => {
    process.env.SWARM_POLL_FALLBACK = "yes";
    expect(forcePollFallback()).toBe(true);
  });
});
