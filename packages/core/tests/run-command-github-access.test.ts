/**
 * Workers get no GitHub access on the API path too: Swarm's agentic loop runs
 * the model's commands through run_command, a shell in the work repo. That
 * shell gets no GitHub token variable, and GH_CONFIG_DIR points at an empty
 * directory (BackendConfig.ghConfigDir, else a per-process default), so gh in
 * it has no login. No test here runs gh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Prints what a gh inside the shell would see.
const PROBE = `printf '%s|%s|%s|%s|%s' "\${GH_CONFIG_DIR-unset}" "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" "\${GH_ENTERPRISE_TOKEN-unset}" "\${GITHUB_ENTERPRISE_TOKEN-unset}"`;
const MACHINE_GH_CONFIG = "/home/example/.config/gh";
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

let providerTurn = 0;
vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      execute: async () => { throw new Error("single-shot path not expected"); },
      executeWithTools: async () => {
        providerTurn++;
        if (providerTurn === 1) {
          return {
            inputTokens: 1, outputTokens: 1, outputText: "", stopReason: "tool_use",
            toolUseBlocks: [{ id: "tu1", name: "run_command", input: { command: `${PROBE} > probe.txt` } }],
            assistantMessage: { role: "assistant", content: [] },
          };
        }
        return {
          inputTokens: 1, outputTokens: 1, outputText: "done", stopReason: "end_turn",
          toolUseBlocks: [], assistantMessage: { role: "assistant", content: "done" },
        };
      },
    }),
  };
});

const { executeTool, Swarm } = await import("../src/index.js");

function mockQueryClient() {
  return {
    query: vi.fn(async (typeName: string) => {
      if (typeName === "SwarmRoute") {
        return [{ intent: "implementation", description: "Implement.", keywords: "[]", contentPaths: "[]" }];
      }
      return [];
    }),
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

describe("run_command has no GitHub access", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    providerTurn = 0;
    dir = await mkdtemp(join(tmpdir(), "swarm-run-command-gh-"));
    await writeFile(join(dir, ".keep"), "");
    for (const k of [...TOKEN_VARS, "GH_CONFIG_DIR"]) {
      saved[k] = process.env[k];
      process.env[k] = k === "GH_CONFIG_DIR" ? MACHINE_GH_CONFIG : "ambient-token";
    }
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("executeTool: no token variable, and the configured empty GH_CONFIG_DIR", async () => {
    const result = await executeTool("run_command", { command: PROBE }, dir, { ghConfigDir: "/tmp/swarm-worker-gh-run" });
    expect(result.is_error).toBe(false);
    expect(result.content).toBe("/tmp/swarm-worker-gh-run|unset|unset|unset|unset");
  });

  it("executeTool: with no directory configured, an empty default — never the machine's", async () => {
    const result = await executeTool("run_command", { command: PROBE }, dir);
    const [ghConfigDir, ...tokens] = result.content.split("|");
    expect(tokens).toEqual(["unset", "unset", "unset", "unset"]);
    expect(ghConfigDir).not.toBe(MACHINE_GH_CONFIG);
    expect(ghConfigDir).not.toBe("unset");
    expect(existsSync(ghConfigDir)).toBe(true);
    expect(readdirSync(ghConfigDir)).toEqual([]);
  });

  it("Swarm's agentic loop passes backendConfig.ghConfigDir to run_command", async () => {
    const swarm = new Swarm(
      {
        swarmPath: dir,
        provider: "anthropic",
        model: "mock-model",
        apiKey: "test-key-not-used",
        backendConfig: { type: "api", ghConfigDir: "/tmp/swarm-worker-gh-run" },
      },
      { queryClient: mockQueryClient() as never },
    );

    await swarm.run("Probe the shell", { intentOverride: "implementation", workingDirectory: dir, maxTurns: 3 });

    expect(providerTurn).toBe(2);
    expect(readFileSync(join(dir, "probe.txt"), "utf-8")).toBe("/tmp/swarm-worker-gh-run|unset|unset|unset|unset");
  });
});
