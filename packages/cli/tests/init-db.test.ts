/**
 * Init passes dockerComposeDir to the Substrate bring-up
 *
 * Verifies that when dbMode is "docker", startSidecarAndSeed calls
 * ensureProjectSubstrate (the CLI's one way into ensureSubstrateReady) with a
 * dockerComposeDir pointing to ~/.swarm/infrastructure.
 *
 * This exercises the real exported `startSidecarAndSeed` function from init.ts
 * — not a simulated re-implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before imports
// ---------------------------------------------------------------------------

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/fakehome"),
  networkInterfaces: vi.fn(() => ({})),
  tmpdir: vi.fn(() => "/tmp"),
  hostname: vi.fn(() => "testhost"),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
  realpathSync: vi.fn((p: string) => p),
  appendFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  statSync: vi.fn(() => ({ isFile: () => true, isDirectory: () => false })),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => "{}"),
  writeFile: vi.fn(async () => {}),
  readdir: vi.fn(async () => []),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

const mockEnsureSubstrate = vi.fn(async () => null);
const mockSeedSwarmContent = vi.fn(async () => ({ configs: 0, content: 0, routes: 0 }));
const mockResolveDbConfig = vi.fn(async () => null);

vi.mock("@mnmal-ai/swarm-substrate", () => ({
  LocalOnlyViolation: class MockLocalOnlyViolation extends Error {},
}));

vi.mock("../src/substrate/ready.js", () => ({
  ensureProjectSubstrate: (...args: unknown[]) => mockEnsureSubstrate(...(args as [])),
}));

// The project's `substrate` block (dedicated stack / local_only). Default: none.
const mockPrepareProjectSubstrate = vi.fn(async (): Promise<{ isolated?: Record<string, unknown> }> => ({}));
vi.mock("../src/project-substrate.js", () => ({
  prepareProjectSubstrate: (...args: unknown[]) => mockPrepareProjectSubstrate(...(args as [])),
  ProjectSubstrateConfigError: class MockProjectSubstrateConfigError extends Error {},
}));

vi.mock("../src/cli/seed.js", () => ({
  seedSwarmContent: (...args: unknown[]) => mockSeedSwarmContent(...args),
}));

vi.mock("../src/config.js", () => ({
  resolveDbConfig: (...args: unknown[]) => mockResolveDbConfig(...args),
}));

import { existsSync } from "node:fs";
import { startSidecarAndSeed } from "../src/cli/init.js";

const mockExistsSync = vi.mocked(existsSync);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startSidecarAndSeed — real function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureSubstrate.mockResolvedValue(null);
    mockSeedSwarmContent.mockResolvedValue({ configs: 0, content: 0, routes: 0 });
    mockResolveDbConfig.mockResolvedValue(null);
  });

  it("returns immediately without starting Substrate when mode is 'file'", async () => {
    await startSidecarAndSeed("file", "/project/.swarm", "myproject");

    expect(mockEnsureSubstrate).not.toHaveBeenCalled();
    expect(mockSeedSwarmContent).not.toHaveBeenCalled();
  });

  it("passes dockerComposeDir=/fakehome/.swarm/infrastructure when compose file exists at standard location", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "/fakehome/.swarm/infrastructure/docker-compose.yml";
    });

    await startSidecarAndSeed("docker", "/project/.swarm", "myproject");

    expect(mockEnsureSubstrate).toHaveBeenCalledOnce();
    expect(mockEnsureSubstrate).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerComposeDir: "/fakehome/.swarm/infrastructure",
      }),
    );
  });

  it("falls back to resolveDbConfig when compose file is not at standard location", async () => {
    mockExistsSync.mockReturnValue(false); // standard location missing
    mockResolveDbConfig.mockResolvedValue({
      source: "docker" as const,
      postgresUrl: "postgresql://swarm:swarm@localhost:32337/swarm",
      dockerComposeDir: "/custom/path",
    });

    await startSidecarAndSeed("docker", "/project/.swarm", "myproject");

    expect(mockResolveDbConfig).toHaveBeenCalledWith({ swarmDir: "/project/.swarm" });
    expect(mockEnsureSubstrate).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerComposeDir: "/custom/path",
      }),
    );
  });

  it("passes undefined dockerComposeDir for connection_string mode", async () => {
    await startSidecarAndSeed("connection_string", "/project/.swarm", "myproject");

    expect(mockEnsureSubstrate).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerComposeDir: undefined,
      }),
    );
  });

  it("brings up a project's dedicated stack instead of the shared one", async () => {
    mockPrepareProjectSubstrate.mockResolvedValueOnce({ isolated: { composeProject: "swarm-project-a" } });
    await startSidecarAndSeed("docker", "/project/.swarm", "project-a");

    expect(mockPrepareProjectSubstrate).toHaveBeenCalledWith("/project/.swarm", "project-a");
    const opts = (mockEnsureSubstrate.mock.calls.at(-1) as unknown[] | undefined)?.[0] as Record<string, unknown>;
    expect(opts.isolated).toEqual({ composeProject: "swarm-project-a" });
    expect(opts).not.toHaveProperty("dockerComposeDir");
  });

  it("calls seedSwarmContent with the scaffolded .swarm dir after sidecar is ready", async () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p) === "/fakehome/.swarm/infrastructure/docker-compose.yml",
    );
    // Return a client — this triggers the seed path
    mockEnsureSubstrate.mockResolvedValue({ query: vi.fn(), ingest: vi.fn() } as any);

    await startSidecarAndSeed("docker", "/project/.swarm", "myproject");

    expect(mockSeedSwarmContent).toHaveBeenCalledWith(
      expect.any(Object),
      "/project/.swarm",
      "myproject",
    );
  });

  it("does not call seedSwarmContent when the Substrate bring-up returns null", async () => {
    mockEnsureSubstrate.mockResolvedValue(null);

    await startSidecarAndSeed("docker", "/project/.swarm", "myproject");

    expect(mockEnsureSubstrate).toHaveBeenCalledOnce();
    expect(mockSeedSwarmContent).not.toHaveBeenCalled();
  });

  it("swallows errors from the Substrate bring-up and warns instead of throwing", async () => {
    mockEnsureSubstrate.mockRejectedValue(new Error("Docker not running"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      startSidecarAndSeed("docker", "/project/.swarm", "myproject"),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
