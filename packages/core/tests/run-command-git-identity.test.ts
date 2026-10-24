/**
 * BackendConfig.gitIdentity on the API path: a role without a direct-execution
 * backend runs in Swarm's own agentic loop, whose run_command tool is a shell
 * in the work repo. A `git commit` there must be authored AND committed as the
 * configured identity, like one made by a Claude Code worker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const IDENTITY = { name: "Example Bot", email: "bot@example.com" };
const COMMIT = "git commit --allow-empty -m 'worker commit'";

// The model asks for one run_command (the commit), then finishes.
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
            toolUseBlocks: [{ id: "tu1", name: "run_command", input: { command: COMMIT } }],
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

const execFile = promisify(execFileCb);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

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

describe("run_command and the configured git identity", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    providerTurn = 0;
    root = await mkdtemp(join(tmpdir(), "swarm-run-command-identity-"));
    repo = join(root, "work");
    await execFile("git", ["init", "-b", "main", repo]);
    await git(repo, ["config", "user.name", "Repo User"]);
    await git(repo, ["config", "user.email", "repo@example.com"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("executeTool: a commit made through run_command uses the identity", async () => {
    const result = await executeTool("run_command", { command: COMMIT }, repo, { gitIdentity: IDENTITY });
    expect(result.is_error).toBe(false);
    expect(await git(repo, ["log", "-1", "--format=%an|%ae|%cn|%ce"])).toBe(
      `${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`,
    );
  });

  it("executeTool: without an identity, git resolves it as before", async () => {
    await executeTool("run_command", { command: COMMIT }, repo);
    expect(await git(repo, ["log", "-1", "--format=%an|%ae"])).toBe("Repo User|repo@example.com");
  });

  it("Swarm's agentic loop passes backendConfig.gitIdentity to run_command", async () => {
    const swarm = new Swarm(
      {
        swarmPath: root, // not a git repo; the sha lookup quietly says "unknown"
        provider: "anthropic",
        model: "mock-model",
        apiKey: "test-key-not-used",
        backendConfig: { type: "api", gitIdentity: IDENTITY },
      },
      { queryClient: mockQueryClient() as never },
    );

    await swarm.run("Make a commit", { intentOverride: "implementation", workingDirectory: repo, maxTurns: 3 });

    expect(providerTurn).toBe(2);
    expect(await git(repo, ["log", "-1", "--format=%an|%ae|%cn|%ce"])).toBe(
      `${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`,
    );
  });
});
