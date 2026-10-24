/**
 * Turns `codex exec --json` output into what swarm records for a session:
 * progress events (in the shapes the claude-code backend emits, so the
 * dashboard and the tool-wedge watcher read them the same way), tokens,
 * changed files, the agent's messages and a failure. Only `turn.failed`
 * fails a session: Codex also prints `error` events for reconnects it
 * recovers from, which become status lines.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { ProgressEvent } from "@mnmal-ai/swarm-types";
import { redactSecrets } from "./codex-redact.js";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  exit_code?: number | null;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
}

/** Codex's notice that swarm's own flag is on; swarm set it, so it is not news. */
const HOOK_TRUST_NOTICE = /^`--dangerously-bypass-hook-trust` is enabled/;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The command inside Codex's `/bin/zsh -lc '…'` wrapper, cut to 60 characters. */
export function commandPreview(command: string): string {
  const m = /^\S*\/(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command);
  return (m ? m[2] : command).slice(0, 60);
}

export class CodexEventCollector {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private readonly files: string[] = [];
  private readonly messages: string[] = [];
  /** Tool calls started and not yet completed, by item id. */
  private readonly open = new Map<string, string>();
  private failed: string | undefined;
  private lastTransient: string | undefined;
  /** Numbers tool calls that come without an id, so no two share a key. */
  private anonymous = 0;

  constructor(
    private readonly cwd: string,
    private readonly onProgress?: (e: ProgressEvent) => void,
  ) {}

  get tokens(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    return { input: this.input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite };
  }
  get filesChanged(): string[] {
    return [...this.files];
  }
  get lastMessage(): string {
    return this.messages.at(-1) ?? "";
  }
  get responses(): number {
    return this.messages.length;
  }
  /** Why the session failed, from `turn.failed`; undefined when it did not. */
  get failure(): string | undefined {
    return this.failed;
  }
  /** The last `error` event, which Codex may have recovered from. */
  get lastError(): string | undefined {
    return this.lastTransient;
  }

  push(line: string): void {
    let e: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      e = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const now = Date.now();
    switch (e.type) {
      case "thread.started":
        this.emit({
          type: "session_init",
          detail: `Session started — codex, cwd: ${this.cwd}`,
          timestamp: now,
          meta: { threadId: str(e.thread_id), cwd: this.cwd },
        });
        return;
      case "item.started":
        this.started(e.item as CodexItem | undefined, now);
        return;
      case "item.completed":
        this.completed(e.item as CodexItem | undefined, now);
        return;
      case "turn.completed": {
        const u = (e.usage ?? {}) as Record<string, unknown>;
        this.input += num(u.input_tokens);
        this.cacheRead += num(u.cached_input_tokens);
        this.cacheWrite += num(u.cache_write_input_tokens);
        this.output += num(u.output_tokens);
        this.closeOpen(now);
        return;
      }
      case "turn.failed":
        this.failed = redactSecrets(str((e.error as { message?: unknown } | undefined)?.message) ?? "the turn failed");
        this.closeOpen(now);
        return;
      case "error": {
        const message = redactSecrets(str(e.message) ?? "error");
        this.lastTransient = message;
        this.emit({ type: "status_change", detail: `Codex: ${message.slice(0, 200)}`, timestamp: now, meta: { status: "codex-error" } });
        return;
      }
    }
  }

  /** Close every tool call still open, so nothing looks in flight after the session. */
  finish(): void {
    this.closeOpen(Date.now());
  }

  private started(item: CodexItem | undefined, now: number): void {
    if (!item) return;
    if (item.type === "command_execution") this.toolCall("Bash", item.id, commandPreview(item.command ?? ""), now);
    else if (item.type === "file_change") this.toolCall("apply_patch", item.id, item.changes?.[0]?.path ?? "", now);
    else if (item.type === "mcp_tool_call") this.toolCall(`mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`, item.id, "", now);
  }

  private completed(item: CodexItem | undefined, now: number): void {
    if (!item) return;
    switch (item.type) {
      case "command_execution":
        this.toolDone(item.id, `exit ${item.exit_code ?? "?"}`, now);
        return;
      case "file_change":
        for (const c of item.changes ?? []) if (c.path) this.addFile(c.path);
        this.toolDone(item.id, `${item.changes?.length ?? 0} file(s)`, now);
        return;
      case "mcp_tool_call":
        this.toolDone(item.id, "done", now);
        return;
      case "agent_message":
        if (item.text) {
          this.messages.push(item.text);
          this.emit({ type: "model_response", detail: item.text.slice(0, 120), timestamp: now });
        }
        return;
      case "error":
        if (item.message && !HOOK_TRUST_NOTICE.test(item.message)) {
          this.emit({ type: "status_change", detail: `Codex: ${redactSecrets(item.message).slice(0, 200)}`, timestamp: now, meta: { status: "codex-warning" } });
        }
        return;
    }
  }

  private toolCall(name: string, id: string | undefined, preview: string, now: number): void {
    this.open.set(id ?? `anonymous-${++this.anonymous}`, name);
    this.emit({
      type: "tool_call",
      detail: `Calling: ${name}`,
      timestamp: now,
      meta: { tools: [name], count: 1, inputs: [{ tool: name, preview }], toolUseIds: [id ?? ""] },
    });
  }

  private toolDone(id: string | undefined, summary: string, now: number): void {
    if (id === undefined) return;
    const name = this.open.get(id);
    if (name === undefined) return;
    this.open.delete(id);
    this.emit({ type: "tool_summary", detail: `${name}: ${summary}`, timestamp: now, meta: { toolUseId: id } });
  }

  private closeOpen(now: number): void {
    for (const [id, name] of [...this.open]) {
      this.open.delete(id);
      this.emit({ type: "tool_summary", detail: `${name}: no result`, timestamp: now, meta: { toolUseId: id } });
    }
  }

  /** A changed file, relative to the task directory when it is inside it
   *  (by either spelling of the directory: /var and /private/var are one
   *  directory on macOS), absolute otherwise. */
  private addFile(path: string): void {
    let name = path;
    if (isAbsolute(path)) {
      for (const dir of [this.cwd, this.realCwd()]) {
        const rel = relative(dir, path);
        if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
          name = rel;
          break;
        }
      }
    }
    if (!this.files.includes(name)) this.files.push(name);
  }

  private resolvedCwd: string | undefined;
  private realCwd(): string {
    if (this.resolvedCwd === undefined) {
      try {
        this.resolvedCwd = realpathSync(this.cwd);
      } catch {
        this.resolvedCwd = this.cwd;
      }
    }
    return this.resolvedCwd;
  }

  private emit(e: ProgressEvent): void {
    this.onProgress?.(e);
  }
}
