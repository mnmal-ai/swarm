/**
 * BackendConfig.gitIdentity — a worker's own `git commit` (Claude Code running
 * git in the work repo or a worktree) must be authored AND committed as the
 * project's source_control.git_identity. The backend forwards exactly the four
 * GIT_AUTHOR_* / GIT_COMMITTER_* variables to the Agent SDK process when an
 * identity is configured, and nothing new otherwise.
 *
 * Mocks the SDK module and asserts on what reaches `sdk.query({ options })`,
 * as claude-code-model.test.ts does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryCalls: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args.options);
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        modelUsage: { "claude-x": { inputTokens: 1, outputTokens: 1 } },
      };
    })();
  },
}));

const { ClaudeCodeBackend } = await import("../src/claude-code.js");
const { instantiateFallback } = await import("../src/index.js");

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };
const IDENTITY = { name: "Example Bot", email: "bot@example.com" };
const GIT_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

function envOf(call: Record<string, unknown>): Record<string, string | undefined> {
  return call.env as Record<string, string | undefined>;
}

describe("ClaudeCodeBackend git identity", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    queryCalls.length = 0;
    for (const k of [...GIT_VARS, "GIT_DIR", "GIT_SSH_COMMAND"]) saved[k] = process.env[k];
    // Values inherited from the shell swarm runs in must never leak through.
    process.env.GIT_AUTHOR_NAME = "Shell Author";
    process.env.GIT_COMMITTER_EMAIL = "shell@example.com";
    process.env.GIT_DIR = "/somewhere/else/.git";
    process.env.GIT_SSH_COMMAND = "ssh -i /secret";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("forwards the four GIT_AUTHOR_*/GIT_COMMITTER_* vars when an identity is configured", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", gitIdentity: IDENTITY }).execute(INPUT);

    const env = envOf(queryCalls[0]);
    expect(env.GIT_AUTHOR_NAME).toBe(IDENTITY.name);
    expect(env.GIT_AUTHOR_EMAIL).toBe(IDENTITY.email);
    expect(env.GIT_COMMITTER_NAME).toBe(IDENTITY.name);
    expect(env.GIT_COMMITTER_EMAIL).toBe(IDENTITY.email);
    // Only those four: no other GIT_* reaches the worker.
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_")).sort()).toEqual([...GIT_VARS].sort());
  });

  it("forwards no GIT_* vars when no identity is configured (unchanged)", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    const env = envOf(queryCalls[0]);
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_"))).toEqual([]);
  });

  it("carries the identity onto a claude-code fallback backend", async () => {
    const fallback = instantiateFallback({ type: "api", fallback: "claude-code", gitIdentity: IDENTITY });
    expect(fallback).not.toBeNull();
    await fallback!.execute(INPUT);

    expect(envOf(queryCalls[0]).GIT_COMMITTER_NAME).toBe(IDENTITY.name);
  });
});
