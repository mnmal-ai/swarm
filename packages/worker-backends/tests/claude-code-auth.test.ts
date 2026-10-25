/**
 * BackendConfig.auth — with "subscription" the Agent SDK process must not see
 * ANTHROPIC_API_KEY even when swarm's own shell exports one (the SDK would
 * bill the API instead of the logged-in Claude account). The default keeps
 * forwarding it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryCalls: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args.options);
    return (async function* () {
      yield { type: "result", subtype: "success", result: "ok", duration_ms: 1, modelUsage: { "claude-x": { inputTokens: 1, outputTokens: 1 } } };
    })();
  },
}));

const { ClaudeCodeBackend } = await import("../src/claude-code.js");

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };

function envOf(call: Record<string, unknown>): Record<string, string | undefined> {
  return call.env as Record<string, string | undefined>;
}

describe("BackendConfig.auth", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { queryCalls.length = 0; process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real"; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("withholds ANTHROPIC_API_KEY from the session with auth: subscription", async () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code", auth: "subscription" });
    expect(backend.auth).toBe("subscription");
    await backend.execute(INPUT);
    expect(queryCalls).toHaveLength(1);
    expect(envOf(queryCalls[0]!)).not.toHaveProperty("ANTHROPIC_API_KEY");
    // The rest of the allowlist still goes through.
    expect(envOf(queryCalls[0]!).PATH).toBe(process.env.PATH);
  });

  it("forwards ANTHROPIC_API_KEY by default", async () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });
    expect(backend.auth).toBe("api_key");
    await backend.execute(INPUT);
    expect(envOf(queryCalls[0]!).ANTHROPIC_API_KEY).toBe("sk-ant-test-not-real");
  });
});
