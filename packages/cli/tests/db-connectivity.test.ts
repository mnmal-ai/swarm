/**
 * db status Postgres fallback
 *
 * Tests checkPostgresConnectivity() exported from db.ts:
 *   1. pg_isready exists and succeeds → returns true
 *   2. pg_isready missing, docker exec succeeds → returns true
 *   3. Both fail, TCP probe succeeds → returns true
 *   4. All three fail → returns false
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process and node:fs before importing the module
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("node:net", () => ({
  createConnection: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { checkPostgresConnectivity } from "../src/cli/db.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockCreateConnection = vi.mocked(createConnection);

const TEST_URL = "postgresql://swarm:swarm@localhost:5432/swarm";

// ---------------------------------------------------------------------------
// TCP mock helper
// ---------------------------------------------------------------------------

function setupTcpProbe(succeeds: boolean): void {
  mockCreateConnection.mockImplementation((_port: unknown, _host: unknown) => {
    const handlers: Record<string, (() => void) | undefined> = {};
    const sock = {
      on: (event: string, cb: () => void) => {
        handlers[event] = cb;
        return sock;
      },
      destroy: () => {},
    };

    // Schedule the connect/error event in the next microtask
    Promise.resolve().then(() => {
      if (succeeds) {
        handlers["connect"]?.();
      } else {
        handlers["error"]?.();
      }
    });

    return sock;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkPostgresConnectivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns true when pg_isready exists and succeeds", async () => {
    // pg_isready --version succeeds (installed), pg_isready -d <url> succeeds
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown[]) => {
      const cmdArgs = args as string[];
      if (cmdArgs.includes("--version")) return Buffer.from("pg_isready 15.0");
      if (cmdArgs.includes("-d")) return Buffer.from("localhost:5432 - accepting connections");
      return Buffer.from("");
    });

    const result = await checkPostgresConnectivity(TEST_URL);
    expect(result).toBe(true);
  });

  it("returns true when pg_isready missing but docker exec succeeds", async () => {
    // pg_isready --version fails (not installed)
    // docker compose exec pg_isready succeeds
    // compose file exists
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p).endsWith("docker-compose.yml");
    });

    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown[]) => {
      const cmdArgs = args as string[];
      if (cmdArgs.includes("--version")) {
        const err = new Error("pg_isready not found");
        throw err;
      }
      // docker compose exec call succeeds
      if (cmdArgs.includes("exec")) return Buffer.from("localhost:5432 - accepting connections");
      return Buffer.from("");
    });

    const result = await checkPostgresConnectivity(TEST_URL);
    expect(result).toBe(true);
  });

  it("returns true when pg_isready and docker both fail but TCP probe succeeds", async () => {
    // Both execFileSync calls fail
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not available");
    });
    mockExistsSync.mockReturnValue(false); // no compose file

    // TCP probe succeeds
    setupTcpProbe(true);

    const result = await checkPostgresConnectivity(TEST_URL);
    expect(result).toBe(true);
  });

  it("returns false when all three methods fail", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not available");
    });
    mockExistsSync.mockReturnValue(false);

    // TCP probe fails
    setupTcpProbe(false);

    const result = await checkPostgresConnectivity(TEST_URL);
    expect(result).toBe(false);
  });

  it("falls through to TCP when pg_isready is installed but returns error exit code", async () => {
    // pg_isready --version succeeds but -d throws (non-zero exit)
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown[]) => {
      const cmdArgs = args as string[];
      if (cmdArgs.includes("--version")) return Buffer.from("pg_isready 15.0");
      const err = new Error("pg_isready: connection rejected");
      throw err;
    });

    // No compose file — skip docker path
    mockExistsSync.mockReturnValue(false);

    // TCP probe succeeds
    setupTcpProbe(true);

    const result = await checkPostgresConnectivity(TEST_URL);
    expect(result).toBe(true);
  });
});
