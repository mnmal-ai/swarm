/**
 * A claude-code session given indexed documents (WorkerTaskInput.documents)
 * guards their reads with a PreToolUse hook on Read and Bash, ahead of fnl's,
 * and reports how it read them. Mocks the SDK and asserts on the hooks that
 * reach `sdk.query({ options })`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentGuard } from "@mnmal-ai/swarm-types";

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

const dir = mkdtempSync(join(tmpdir(), "swarm-doc-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Two sections, the second far over the read limit, so a whole read is refused.
const text = ["# Guide", "What it is for.", "## Long", ..."long line of text ".repeat(2000).match(/.{1,80}/g)!].join("\n");
writeFileSync(join(dir, "guide.md"), text);

const GUARD: DocumentGuard = {
  maxReadTokens: 4000,
  documents: [
    {
      absolutePath: join(dir, "guide.md"),
      displayPath: "guide.md",
      contentHash: "stale",
      sections: [],
    },
  ],
};
const INPUT = { task: "do a thing", workingDirectory: dir, swarmContext: "", maxTurns: 1 };
const FNL = { bin: "/opt/fnl/bin/fnl", wrap: ["make build"] };

type Hook = (input: unknown, id: string | undefined, opts: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
type Hooks = { PreToolUse?: Array<{ matcher?: string; hooks: Hook[] }> } | undefined;

describe("ClaudeCodeBackend: indexed documents", () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });

  it("guards Read and Bash with one hook when given documents", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute({ ...INPUT, documents: GUARD });

    const hooks = queryCalls[0].hooks as Hooks;
    expect(hooks?.PreToolUse).toHaveLength(1);
    expect(hooks?.PreToolUse?.[0].matcher).toBe("Read|Bash");
    expect(hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
    expect(typeof hooks?.PreToolUse?.[0].hooks[0]).toBe("function");
  });

  it("puts the guard ahead of fnl's hook", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL }).execute({ ...INPUT, documents: GUARD });

    const hooks = queryCalls[0].hooks as Hooks;
    expect(hooks?.PreToolUse?.map((m) => m.matcher)).toEqual(["Read|Bash", "Bash"]);
  });

  it("leaves hooks as they were with no documents, or an empty guard", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);
    await new ClaudeCodeBackend({ type: "claude-code" }).execute({ ...INPUT, documents: { maxReadTokens: 4000, documents: [] } });
    await new ClaudeCodeBackend({ type: "claude-code", fnl: FNL }).execute({ ...INPUT, documents: { maxReadTokens: 4000, documents: [] } });

    expect(queryCalls[0].hooks).toBeUndefined();
    expect(queryCalls[1].hooks).toBeUndefined();
    expect((queryCalls[2].hooks as Hooks)?.PreToolUse?.map((m) => m.matcher)).toEqual(["Bash"]);
  });

  it("adds no guard to a session without Read or Bash", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", tools: ["Grep", "Glob"] }).execute({ ...INPUT, documents: GUARD });

    expect(queryCalls[0].hooks).toBeUndefined();
  });

  it("reports documentReads only when the guard was installed", async () => {
    const guarded = await new ClaudeCodeBackend({ type: "claude-code" }).execute({ ...INPUT, documents: GUARD });
    const plain = await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);
    const noTools = await new ClaudeCodeBackend({ type: "claude-code", tools: ["Grep"] }).execute({ ...INPUT, documents: GUARD });

    expect(guarded.documentReads).toEqual({ bounded: 0, refused: 0, whole: 0, ranges: [] });
    expect("documentReads" in plain).toBe(false);
    expect("documentReads" in noTools).toBe(false);
  });

  it("resolves paths against the task's working directory", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute({ ...INPUT, documents: GUARD });

    const hook = (queryCalls[0].hooks as Hooks)!.PreToolUse![0].hooks[0];
    const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat guide.md" } }, "t1", {
      signal: new AbortController().signal,
    });
    expect(out).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  });
});
