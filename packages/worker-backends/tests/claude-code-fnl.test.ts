/**
 * A claude-code session routes Bash through fnl only when its config carries a
 * resolved fnl (BackendConfig.fnl) and the session has the Bash tool. Mocks the
 * SDK and asserts on the hooks that reach `sdk.query({ options })`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
const FNL = { bin: "/opt/fnl/bin/fnl", wrap: ["make build"] };

type Hooks = { PreToolUse?: Array<{ matcher?: string; hooks: unknown[] }> } | undefined;

describe("ClaudeCodeBackend: fnl", () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });

  it("adds one PreToolUse hook on Bash when fnl is configured", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL }).execute(INPUT);

    const hooks = queryCalls[0].hooks as Hooks;
    expect(hooks?.PreToolUse).toHaveLength(1);
    expect(hooks?.PreToolUse?.[0].matcher).toBe("Bash");
    expect(hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
    expect(typeof hooks?.PreToolUse?.[0].hooks[0]).toBe("function");
  });

  it("adds no hooks when fnl isn't configured", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(queryCalls[0].hooks).toBeUndefined();
  });

  it("adds no hooks when the session has no Bash tool", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL, tools: ["Read", "Grep"] }).execute(INPUT);

    expect(queryCalls[0].hooks).toBeUndefined();
  });

  it("keeps the primary's fnl when the factory builds a Claude Code fallback", async () => {
    const fallback = instantiateFallback({ type: "api", fallback: "claude-code", fnl: FNL });
    await fallback!.execute(INPUT);

    expect((queryCalls[0].hooks as Hooks)?.PreToolUse?.[0].matcher).toBe("Bash");
  });

  it("tells a session with fnl to run build and test commands on their own, after swarm's context", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL }).execute({ ...INPUT, swarmContext: "SWARM CONTEXT" });

    const append = (queryCalls[0].systemPrompt as { append: string }).append;
    expect(append.startsWith("SWARM CONTEXT\n\n")).toBe(true);
    expect(append).toContain("Run each build, test or lint command as its own Bash call");
    expect(append).toContain("fnl show <id>");
  });

  it("adds the instruction alone when there is no swarm context", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL }).execute(INPUT);

    const append = (queryCalls[0].systemPrompt as { append: string }).append;
    expect(append.startsWith("## Build and test output")).toBe(true);
  });

  it("leaves the system prompt alone without fnl or without Bash", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute({ ...INPUT, swarmContext: "SWARM CONTEXT" });
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL, tools: ["Read", "Grep"] }).execute({ ...INPUT, swarmContext: "SWARM CONTEXT" });

    for (const call of queryCalls) expect((call.systemPrompt as { append: string }).append).toBe("SWARM CONTEXT");
  });

  it("refuses an fnl path that isn't absolute", () => {
    expect(() => new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: "fnl", wrap: [] } })).toThrow(/fnl/);
  });
});
