/**
 * ClaudeCodeBackend's token split — how much of a session's input came from
 * the prompt cache.
 *
 * `tokensUsed.input` stays the whole input (fresh + cache reads + cache
 * writes), because the token budgets count it that way. The
 * cache parts ride alongside so the dashboard can show fresh input apart from
 * cached input. Mocks the SDK module the same way claude-code-model-report.test.ts
 * does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let script: unknown[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const message of script) yield message;
    })(),
}));

const { ClaudeCodeBackend } = await import("../src/claude-code.js");

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };

beforeEach(() => {
  script = [];
});

describe("ClaudeCodeBackend token split", () => {
  it("reports cache reads and writes summed across models, inside the input total", async () => {
    script = [
      {
        type: "result",
        subtype: "success",
        result: "done",
        duration_ms: 1,
        modelUsage: {
          "model-a": { inputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 60, outputTokens: 5 },
          "model-b": { inputTokens: 3, cacheReadInputTokens: 40, outputTokens: 1 },
        },
      },
    ];

    const out = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(out.tokensUsed).toEqual({ input: 1_013, output: 6, cacheRead: 940, cacheWrite: 60 });
  });

  it("reads the split from top-level usage when there is no per-model usage", async () => {
    script = [
      {
        type: "result",
        subtype: "success",
        result: "done",
        duration_ms: 1,
        usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 500, cache_creation_input_tokens: 30 },
        modelUsage: {},
      },
    ];

    const out = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(out.tokensUsed).toEqual({ input: 537, output: 2, cacheRead: 500, cacheWrite: 30 });
  });
});

describe("ClaudeCodeBackend reports no dollar figure", () => {
  it("leaves the SDK's cost out of its result", async () => {
    script = [
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.42, duration_ms: 1, modelUsage: { "model-a": { inputTokens: 1, outputTokens: 1 } } },
    ];

    const out = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(out).not.toHaveProperty("costUsd");
  });

  it("describes an error with no messages by its tokens, not a dollar amount", async () => {
    script = [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: [],
        total_cost_usd: 0.01,
        duration_ms: 3000,
        modelUsage: { "model-a": { inputTokens: 50, cacheReadInputTokens: 1_000, outputTokens: 10 } },
      },
    ];

    const out = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(out.output).toContain("error_during_execution");
    expect(out.output).toContain("1,050 input");
    expect(out.output).toContain("10 output");
    expect(out.output).not.toMatch(/\$/);
  });
});
