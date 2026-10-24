/**
 * ClaudeCodeBackend turns an expired login into a LoginExpiredError, whether
 * the SDK throws it or reports it as an error result, so `swarm run` can stop
 * the whole run rather than fail one task after another. Mocks the SDK module
 * the same way claude-code-token-split.test.ts does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LoginExpiredError, RateLimitError } from "@mnmal-ai/swarm-types";

let script: unknown[] = [];
let thrown: Error | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      if (thrown) throw thrown;
      for (const message of script) yield message;
    })(),
}));

const { ClaudeCodeBackend } = await import("../src/claude-code.js");

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };

beforeEach(() => {
  script = [];
  thrown = null;
});

describe("ClaudeCodeBackend and an expired login", () => {
  it("throws LoginExpiredError when the SDK throws a login failure", async () => {
    thrown = new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed");

    const err = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LoginExpiredError);
    expect((err as LoginExpiredError).detail).toBe(
      "Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed",
    );
  });

  it("throws LoginExpiredError for an error result that says to log in", async () => {
    script = [
      { type: "result", subtype: "error_during_execution", errors: ["Invalid API key · Please run /login"], duration_ms: 1, modelUsage: { "model-a": { inputTokens: 1, outputTokens: 1 } } },
    ];

    await expect(new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT)).rejects.toBeInstanceOf(LoginExpiredError);
  });

  it("keeps a rate limit from an error result a RateLimitError", async () => {
    script = [
      { type: "result", subtype: "error_during_execution", errors: ["You've hit your limit · resets 11pm (UTC)"], duration_ms: 1, modelUsage: { "model-a": { inputTokens: 1, outputTokens: 1 } } },
    ];

    // It used to come out wrapped in a generic error, so the caller never
    // paused for the reset.
    const err = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).waitMs).toBeGreaterThan(0);
  });

  it("leaves other failures as they were", async () => {
    thrown = new Error("spawn claude ENOENT");

    const err = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(LoginExpiredError);
    expect((err as Error).message).toContain("Claude Agent SDK query failed");
  });
});
