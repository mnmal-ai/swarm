/**
 * A worker session carries only what swarm gives it. Every API call re-sends
 * the system prompt and every tool definition, so each unused tool and each
 * MCP server the session did not ask for costs context on every call:
 *
 * - `tools` lists the built-in tools the session gets (BackendConfig.tools, or
 *   the backend's default set); tools not listed are not defined at all.
 * - `settingSources: []`: no user/project/local settings, plugins or CLAUDE.md.
 * - The account's claude.ai connectors (mail, drive, calendar…) are switched
 *   off and denied: swarm never configured them, and a worker must not reach them.
 * - A tool from an MCP server swarm did not configure is refused.
 *
 * Mocks the SDK and asserts on what reaches `sdk.query({ options })`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

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

const { ClaudeCodeBackend, DEFAULT_WORKER_TOOLS } = await import("../src/claude-code.js");
const { instantiateFallback } = await import("../src/index.js");

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };

describe("ClaudeCodeBackend: lean sessions", () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });

  describe("built-in tools", () => {
    it("gives a session only the default worker tools when none are configured", async () => {
      await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

      expect(queryCalls[0].tools).toEqual(DEFAULT_WORKER_TOOLS);
      expect(DEFAULT_WORKER_TOOLS).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash"]);
    });

    it("gives a session exactly the configured tools", async () => {
      await new ClaudeCodeBackend({ type: "claude-code", tools: ["Read", "Grep", "Bash"] }).execute(INPUT);

      expect(queryCalls[0].tools).toEqual(["Read", "Grep", "Bash"]);
    });

    it("accepts an empty list: a session with no built-in tools", async () => {
      await new ClaudeCodeBackend({ type: "claude-code", tools: [] }).execute(INPUT);

      expect(queryCalls[0].tools).toEqual([]);
    });

    it("keeps the primary's tools when the factory builds a Claude Code fallback", async () => {
      const readOnly = ["Read", "Glob", "Grep", "Bash"];
      const fallback = instantiateFallback({ type: "api", fallback: "claude-code", tools: readOnly });
      readOnly.push("Write"); // the fallback holds its own copy

      await fallback!.execute(INPUT);

      expect(queryCalls[0].tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    });

    it("refuses a tool entry that is a permission pattern or holds shell metacharacters", () => {
      // Patterns such as Bash(git *) belong in permissions.allowedTools.
      expect(() => new ClaudeCodeBackend({ type: "claude-code", tools: ["Bash(git *)"] })).toThrow(/tools entry/);
      expect(() => new ClaudeCodeBackend({ type: "claude-code", tools: ["Read;rm"] })).toThrow(/tools entry/);
      expect(() => new ClaudeCodeBackend({ type: "claude-code", tools: [""] })).toThrow(/tools entry/);
    });
  });

  it("loads no settings files, whatever the SDK's default", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    expect(queryCalls[0].settingSources).toEqual([]);
  });

  describe("the account's claude.ai connectors", () => {
    it("are switched off in the session's environment", async () => {
      await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

      const env = queryCalls[0].env as Record<string, string | undefined>;
      expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    });

    it("are denied as well, alongside the configured denials", async () => {
      await new ClaudeCodeBackend({
        type: "claude-code",
        permissions: { deniedTools: ["Bash(git push:*)"] },
      }).execute(INPUT);

      expect(queryCalls[0].disallowedTools).toEqual(["Bash(git push:*)", "mcp__claude_ai_*"]);
    });

    it("are denied once, even when the config already denies them", async () => {
      await new ClaudeCodeBackend({
        type: "claude-code",
        permissions: { deniedTools: ["mcp__claude_ai_*"] },
      }).execute(INPUT);

      expect(queryCalls[0].disallowedTools).toEqual(["mcp__claude_ai_*"]);
    });
  });

  describe("tool approval", () => {
    const NO_OPTIONS = { signal: new AbortController().signal, toolUseID: "t1" };

    it("refuses a tool from an MCP server swarm did not configure", async () => {
      const canUseTool = new ClaudeCodeBackend({ type: "claude-code" }).buildCanUseTool();

      const result = await canUseTool("mcp__claude_ai_Gmail__send_message", {}, NO_OPTIONS);

      expect(result.behavior).toBe("deny");
    });

    it("refuses an unconfigured server even when a configured one shares its prefix", async () => {
      const canUseTool = new ClaudeCodeBackend({
        type: "claude-code",
        mcpServers: { docs: { command: "docs-mcp" } },
      }).buildCanUseTool();

      expect((await canUseTool("mcp__docs_admin__drop", {}, NO_OPTIONS)).behavior).toBe("deny");
    });

    it("lets a tool from a configured MCP server through", async () => {
      const canUseTool = new ClaudeCodeBackend({
        type: "claude-code",
        mcpServers: { "figma-dev": { command: "figma-mcp" } },
      }).buildCanUseTool();

      expect((await canUseTool("mcp__figma-dev__get_file", {}, NO_OPTIONS)).behavior).toBe("allow");
      // Claude Code may normalise a server name's punctuation to underscores.
      expect((await canUseTool("mcp__figma_dev__get_file", {}, NO_OPTIONS)).behavior).toBe("allow");
    });

    it("leaves every other tool's approval as it was", async () => {
      const canUseTool = new ClaudeCodeBackend({ type: "claude-code" }).buildCanUseTool();

      expect((await canUseTool("Bash", { command: "pnpm test" }, NO_OPTIONS)).behavior).toBe("allow");
    });
  });
});
