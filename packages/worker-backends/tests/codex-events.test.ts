/**
 * Reading `codex exec --json` into swarm's progress events, tokens, changed
 * files and messages. Only a failed turn fails a session.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProgressEvent } from "@mnmal-ai/swarm-types";
import { CodexEventCollector, commandPreview } from "../src/codex-events.js";

const SESSION = [
  { type: "thread.started", thread_id: "t1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation." } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I'll fix the rounding." } },
  { type: "item.started", item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc 'node --test'", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "/bin/zsh -lc 'node --test'", aggregated_output: "# pass 4", exit_code: 0, status: "completed" } },
  { type: "item.started", item: { id: "item_3", type: "file_change", changes: [{ path: "/work/src/discount.js", kind: "update" }], status: "in_progress" } },
  { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "/work/src/discount.js", kind: "update" }], status: "completed" } },
  { type: "error", message: "Reconnecting... 2/5 (stream disconnected)" },
  { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Fixed: rounds to the nearest cent." } },
  { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 90, reasoning_output_tokens: 10 } },
].map((e) => JSON.stringify(e));

function collect(lines: string[]) {
  const events: ProgressEvent[] = [];
  const c = new CodexEventCollector("/work", (e) => events.push(e));
  for (const l of lines) c.push(l);
  c.finish();
  return { c, events };
}

describe("CodexEventCollector", () => {
  it("collects output, tokens and changed files", () => {
    const { c } = collect(SESSION);
    expect(c.lastMessage).toBe("Fixed: rounds to the nearest cent.");
    expect(c.responses).toBe(2);
    expect(c.tokens).toEqual({ input: 1000, output: 90, cacheRead: 800, cacheWrite: 0 });
    expect(c.filesChanged).toEqual(["src/discount.js"]);
    expect(c.failure).toBeUndefined();
  });

  it("sums tokens over several turns", () => {
    const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } });
    expect(collect([turn, turn]).c.tokens).toEqual({ input: 20, output: 4, cacheRead: 10, cacheWrite: 0 });
  });

  it("emits progress events the tool-wedge watcher understands", () => {
    const { events } = collect(SESSION);
    expect(events.map((e) => e.type)).toEqual([
      "session_init", "model_response", "tool_call", "tool_summary", "tool_call", "tool_summary", "status_change", "model_response",
    ]);
    const call = events.find((e) => e.type === "tool_call")!;
    expect(call.meta).toEqual({ tools: ["Bash"], count: 1, inputs: [{ tool: "Bash", preview: "node --test" }], toolUseIds: ["item_2"] });
  });

  it("only a failed turn fails the session; transient errors are status lines", () => {
    const { c } = collect([...SESSION, JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } })]);
    expect(c.failure).toBe("unexpected status 401 Unauthorized");
    expect(collect(SESSION).c.lastError).toBe("Reconnecting... 2/5 (stream disconnected)");
  });

  it("ignores lines that are not JSON events", () => {
    const { c } = collect(["Reading additional input from stdin...", "{", "42", "null", "[]", ...SESSION]);
    expect(c.lastMessage).toBe("Fixed: rounds to the nearest cent.");
  });

  it("closes a tool call that never completed when the session finishes", () => {
    const events: ProgressEvent[] = [];
    const c = new CodexEventCollector("/work", (e) => events.push(e));
    c.push(JSON.stringify({ type: "item.started", item: { id: "x", type: "command_execution", command: "sleep 9" } }));
    c.finish();
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_summary"]);
  });

  it("keeps every call without an id open until the session ends", () => {
    const events: ProgressEvent[] = [];
    const c = new CodexEventCollector("/work", (e) => events.push(e));
    const started = (command: string) => JSON.stringify({ type: "item.started", item: { type: "command_execution", command } });
    c.push(started("a"));
    c.push(started("b"));
    c.push(started("c"));
    c.finish();
    expect(events.filter((e) => e.type === "tool_summary")).toHaveLength(3);
  });

  it("keeps a changed file outside the task directory as an absolute path", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "/elsewhere/x.js" }] } });
    expect(collect([line]).c.filesChanged).toEqual(["/elsewhere/x.js"]);
  });

  it("treats both spellings of the task directory as the same directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-events-"));
    const real = realpathSync(dir);
    const c = new CodexEventCollector(dir);
    c.push(JSON.stringify({ type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: join(real, "src/a.js") }] } }));
    expect(c.filesChanged).toEqual(["src/a.js"]);
  });

  it("redacts tokens from Codex's error text before it reaches the live feed", () => {
    const events: ProgressEvent[] = [];
    const c = new CodexEventCollector("/work", (e) => events.push(e));
    c.push(JSON.stringify({ type: "error", message: "401 with Bearer abcdefghijklmnopqrstuvwxyz0123456789" }));
    c.push(JSON.stringify({ type: "turn.failed", error: { message: "rejected key=sk-abcdefghijklmnopqrstuvwxyz0123" } }));
    expect(JSON.stringify(events)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(c.lastError).toContain("Bearer ***");
    expect(c.failure).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
  });

  it("previews the command inside Codex's shell wrapper", () => {
    expect(commandPreview(`/bin/zsh -lc "git status --short"`)).toBe("git status --short");
    expect(commandPreview("ls -la")).toBe("ls -la");
    expect(commandPreview("x".repeat(100))).toHaveLength(60);
  });
});
