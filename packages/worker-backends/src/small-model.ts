/**
 * One turn with a small model, for swarm's own bookkeeping (section
 * synopses, goal labels). The call runs on the Claude subscription the
 * workers use: no ANTHROPIC_API_KEY is passed, no settings are loaded, the
 * session has no tools, no account connectors and no GitHub access, and it
 * gets one turn. Callers treat any error as "fall back".
 */

import { execFileSync } from "node:child_process";
import { defaultWorkerGhConfigDir, withoutGitHubAccess } from "@mnmal-ai/swarm-types";

/** Variables the session gets from swarm's environment; nothing that selects billing or carries a token. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "SHELL", "TERM"];

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

export interface SmallModelOptions {
  model: string;
  timeoutMs: number;
  /** The `claude` executable; found on PATH when omitted. */
  claudePath?: string;
  /** The Agent SDK's `query`; injected by tests. */
  query?: QueryFn;
}

function resolveClaude(): string | undefined {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf-8", stdio: "pipe" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The text of the session's result, or of its last assistant message. */
function replyText(message: unknown, current: string): string {
  const m = message as { type?: string; result?: unknown; message?: { content?: Array<{ type?: string; text?: unknown }> } };
  if (m.type === "result" && typeof m.result === "string") return m.result;
  if (m.type === "assistant" && Array.isArray(m.message?.content)) {
    const text = m.message.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    return text || current;
  }
  return current;
}

/** A function that sends one prompt to the model and resolves to its reply text. `signal` ends the call early. */
export function smallModel(opts: SmallModelOptions): (prompt: string, signal?: AbortSignal) => Promise<string> {
  let claudePath: string | null | undefined = opts.claudePath;
  return async (prompt, signal) => {
    const query: QueryFn = opts.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn);
    if (claudePath === undefined) claudePath = resolveClaude() ?? null;

    const env: Record<string, string | undefined> = {};
    for (const name of ENV_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
    const isolated = withoutGitHubAccess(env, defaultWorkerGhConfigDir());
    isolated.ENABLE_CLAUDEAI_MCP_SERVERS = "false";

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), opts.timeoutMs);
    const onAbort = () => abortController.abort();
    if (signal?.aborted) abortController.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let text = "";
    try {
      for await (const message of query({
        prompt,
        options: {
          ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
          model: opts.model,
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
          disallowedTools: ["mcp__claude_ai_*"],
          env: isolated,
          abortController,
        },
      })) {
        text = replyText(message, text);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    return text;
  };
}
