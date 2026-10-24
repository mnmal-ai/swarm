/**
 * BackendConfig.model — the Agent SDK query option.
 *
 * Mocks the SDK module rather than reimplementing `execute()`, because the
 * whole contract lives in what reaches `sdk.query({ options })`. A test that
 * rebuilds the method body would keep passing while the real call regressed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Captures the options of the most recent sdk.query() call. */
const queryCalls: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args.options);
    return (async function* () {
      // `modelUsage` must be non-empty: execute() only reads `result.usage`
      // when modelUsage is absent or empty, and an empty object sends it down
      // that branch to dereference a `usage` the real SDK would have supplied.
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        modelUsage: {
          "claude-x": { inputTokens: 1, outputTokens: 1 },
        },
      };
    })();
  },
}));

const { ClaudeCodeBackend } = await import("../src/claude-code.js");

const INPUT = {
  task: "do a thing",
  workingDirectory: "/tmp",
  swarmContext: "",
  maxTurns: 1,
};

beforeEach(() => {
  queryCalls.length = 0;
});

describe("ClaudeCodeBackend model selection", () => {
  it("omits the model key entirely when none is configured", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(queryCalls).toHaveLength(1);
    // Absent, not `model: undefined` — the SDK distinguishes "not specified"
    // from an explicit undefined, and existing callers must keep inheriting
    // the operator's configured model exactly as before.
    expect(queryCalls[0]).not.toHaveProperty("model");
  });

  it("passes the configured model through to the SDK", async () => {
    await new ClaudeCodeBackend({
      type: "claude-code",
      model: "claude-haiku-4-5-20251001",
    }).execute(INPUT);

    expect(queryCalls[0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("stores the model on the instance without disturbing timeout defaults", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      model: "claude-opus-4-1",
    });

    expect((backend as unknown as { model: string | undefined }).model).toBe(
      "claude-opus-4-1",
    );
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(
      600_000,
    );
  });

  it("leaves model undefined on the instance when unset", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });

    expect((backend as unknown as { model: string | undefined }).model).toBeUndefined();
  });
});
