/**
 * ClaudeCodeBackend's model report — which models actually served a session,
 * as the Agent SDK reported them, as opposed to what swarm asked for.
 *
 * Mocks the SDK module (see claude-code-model.test.ts for why) and scripts the
 * message stream a real session produces: an init message naming the session
 * model, assistant messages carrying each API response's `model`, and a result
 * with per-model usage.
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

function init(model: string) {
  return { type: "system", subtype: "init", model, tools: [], cwd: "/tmp", permissionMode: "default" };
}

function assistant(model: string | undefined) {
  return { type: "assistant", message: { model, content: [{ type: "text", text: "working" }] } };
}

function result(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number }>) {
  return { type: "result", subtype: "success", result: "done", duration_ms: 1, modelUsage };
}

beforeEach(() => {
  script = [];
});

describe("ClaudeCodeBackend model report", () => {
  it("reports the model swarm asked for", async () => {
    script = [init("claude-opus-5-5"), result({ "claude-opus-5-5": { inputTokens: 1, outputTokens: 1 } })];

    const out = await new ClaudeCodeBackend({ type: "claude-code", model: "claude-opus-5-5" }).execute(INPUT);

    expect(out.modelReport?.requested).toBe("claude-opus-5-5");
  });

  it("reports the model the session started on", async () => {
    script = [init("claude-sonnet-5-5"), result({ "claude-sonnet-5-5": { inputTokens: 1, outputTokens: 1 } })];

    const out = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(out.modelReport?.requested).toBeUndefined();
    expect(out.modelReport?.sessionModel).toBe("claude-sonnet-5-5");
  });

  it("counts assistant responses by the model each API response names", async () => {
    script = [
      init("claude-fable-5-1"),
      assistant("claude-fable-5-1"),
      assistant("claude-fable-5-1"),
      assistant("claude-haiku-4-5-20251001"),
      assistant(undefined),
      result({ "claude-fable-5-1": { inputTokens: 1, outputTokens: 1 } }),
    ];

    const out = await new ClaudeCodeBackend({ type: "claude-code", model: "claude-fable-5-1" }).execute(INPUT);

    expect(out.modelReport?.responses).toEqual({ "claude-fable-5-1": 2, "claude-haiku-4-5-20251001": 1 });
  });

  it("reports tokens per model from the result, cached input included", async () => {
    script = [
      init("claude-sonnet-5-5"),
      result({
        "claude-sonnet-5-5": { inputTokens: 10, cacheReadInputTokens: 90, outputTokens: 5 },
        "claude-haiku-4-5-20251001": { inputTokens: 3, outputTokens: 1 },
      }),
    ];

    const out = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(out.modelReport?.usage).toEqual({
      "claude-sonnet-5-5": { input: 100, output: 5 },
      "claude-haiku-4-5-20251001": { input: 3, output: 1 },
    });
  });

  it("exposes the model it asks for, so callers can label the session honestly", () => {
    expect(new ClaudeCodeBackend({ type: "claude-code", model: "claude-opus-5-5" }).model).toBe("claude-opus-5-5");
    expect(new ClaudeCodeBackend({ type: "claude-code" }).model).toBeUndefined();
  });
});
