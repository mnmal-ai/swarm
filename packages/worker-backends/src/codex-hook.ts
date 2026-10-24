/**
 * The decisions behind `swarm codex-hook`, which Codex runs before each tool
 * a codex session uses (codex.ts passes it as a hook setting). Codex hooks
 * speak Claude Code's hook format: stdin carries hook_event_name, tool_name,
 * tool_input, tool_use_id, cwd and model, and a PreToolUse reply carries
 * hookSpecificOutput.permissionDecision and updatedInput.
 *
 * Everything the hook trusts comes on its own command line, which the agent
 * cannot change: which event it answers, the session's policy (base64
 * JSON), and where to log. The log directory is outside every directory the
 * session's sandbox may write.
 *
 * Codex treats a hook that crashes as "allow", so this fails closed: on
 * PreToolUse any error of its own produces a deny with the reason, and a
 * tool it does not know is denied. Each decision is appended to the
 * session's decisions.jsonl, without command text, for the backend to read
 * when the session ends.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deniesEditing, matchDenied } from "./deny-matcher.js";
import { bashDenyRules, fnlPreToolUse, type FnlDecision } from "./fnl-hook.js";

export const DECISIONS_FILE = "decisions.jsonl";
/** tool_use_id prefix of the backend's self-test calls; never counted. */
export const SELF_TEST_ID_PREFIX = "swarm-self-test";

/** The hook events swarm registers, by their command-line names. */
const EVENTS = { "pre-tool-use": "PreToolUse", "session-start": "SessionStart" } as const;
export type CodexHookEvent = (typeof EVENTS)[keyof typeof EVENTS];

/** Codex's own tools the hook lets through, besides those the policy names. */
const KNOWN_TOOLS = new Set(["Bash", "apply_patch", "update_plan", "view_image"]);

/** What a session's hook enforces; built by the backend before the session starts. */
export interface CodexHookPolicy {
  version: 1;
  /** The role's permissions.deniedTools, as written. */
  deniedTools: string[];
  /** The role's tools include Bash. */
  canRunCommands: boolean;
  /** The role's tools include Edit or Write. */
  canEdit: boolean;
  /** MCP servers the role configured; their tools are allowed unless denied. */
  mcpServers?: string[];
  /** Route allowed shell commands through fnl; see BackendConfig.fnl. */
  fnl?: { bin: string; wrap: string[]; json?: boolean };
}

/** One line of decisions.jsonl. Never holds command text. */
export interface CodexHookLogEntry {
  event: string;
  tool?: string;
  toolUseId?: string;
  decision: "allow" | "deny" | "rewrite" | "record";
  reason?: string;
  fnl?: FnlDecision;
  model?: string;
}

/** The hook's command line, parsed; `error` when it cannot be trusted. */
export interface CodexHookArgs {
  event: CodexHookEvent;
  policy?: CodexHookPolicy;
  logDir?: string;
  error?: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

const denyOutput = (reason: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** The reply a PreToolUse hook gives when swarm itself fails; the backend puts it after `||`. */
export const HOOK_FAILURE_DENY = JSON.stringify(denyOutput("the swarm hook failed, so the call is denied"));

/** The arguments after `codex-hook` for one event of one session. */
export function codexHookArgs(event: CodexHookEvent, policy: CodexHookPolicy, logDir: string): string[] {
  const name = event === "PreToolUse" ? "pre-tool-use" : "session-start";
  return [name, "--policy", Buffer.from(JSON.stringify(policy)).toString("base64"), "--log", logDir];
}

/** Read the arguments after `codex-hook`. Anything wrong with them is reported, never thrown. */
export function parseCodexHookArgs(argv: readonly string[]): CodexHookArgs {
  const name = argv[0] as keyof typeof EVENTS | undefined;
  // An unknown event name is answered as PreToolUse: refusing is the safe answer.
  const event: CodexHookEvent = name !== undefined && name in EVENTS ? EVENTS[name] : "PreToolUse";
  if (name === undefined || !(name in EVENTS)) return { event, error: `unknown hook event "${name ?? ""}"` };
  let policy: CodexHookPolicy | undefined;
  let logDir: string | undefined;
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === "--policy" && value !== undefined) {
      try {
        policy = checkPolicy(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
      } catch (err) {
        return { event, error: `the session policy could not be read: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else if (argv[i] === "--log" && value !== undefined) {
      logDir = value;
    } else {
      return { event, error: `unexpected argument "${argv[i]}"` };
    }
  }
  if (!policy) return { event, error: "no session policy" };
  return { event, policy, ...(logDir ? { logDir } : {}) };
}

function checkPolicy(p: unknown): CodexHookPolicy {
  const q = p as Partial<CodexHookPolicy> | null;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
  if (
    q === null ||
    typeof q !== "object" ||
    q.version !== 1 ||
    !strings(q.deniedTools) ||
    typeof q.canRunCommands !== "boolean" ||
    typeof q.canEdit !== "boolean" ||
    (q.mcpServers !== undefined && !strings(q.mcpServers)) ||
    (q.fnl !== undefined && (typeof q.fnl.bin !== "string" || !strings(q.fnl.wrap)))
  ) {
    throw new Error("it is not one swarm wrote");
  }
  return q as CodexHookPolicy;
}

/** The reply and log entries for one PreToolUse call. Errors propagate; runCodexHook turns them into denies. */
export async function decidePreToolUse(
  input: Record<string, unknown>,
  policy: CodexHookPolicy,
): Promise<{ output?: object; log: CodexHookLogEntry[] }> {
  const tool = typeof input.tool_name === "string" ? input.tool_name : undefined;
  const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : undefined;
  const base = { event: "PreToolUse", ...(tool ? { tool } : {}), ...(toolUseId ? { toolUseId } : {}) };
  const refuse = (reason: string) => ({ output: denyOutput(reason), log: [{ ...base, decision: "deny" as const, reason }] });

  if (tool === undefined) return refuse("swarm could not tell which tool this is");
  const fromRoleServer = (policy.mcpServers ?? []).some((server) => tool.startsWith(`mcp__${server}__`));
  if (!KNOWN_TOOLS.has(tool) && !fromRoleServer) {
    return refuse(`swarm does not know the tool "${tool}", so it is denied`);
  }
  if (tool === "Bash" && !policy.canRunCommands) return refuse("this role does not run commands");
  if (tool === "apply_patch" && (!policy.canEdit || deniesEditing(policy.deniedTools))) return refuse("this role does not edit files");
  const match = matchDenied(tool, input.tool_input, policy.deniedTools);
  if (match.denied) return refuse(match.reason ?? "denied");

  if (tool === "Bash" && policy.fnl) {
    const decisions: FnlDecision[] = [];
    const hook = fnlPreToolUse({
      bin: policy.fnl.bin,
      wrap: policy.fnl.wrap,
      denyRules: bashDenyRules(policy.deniedTools),
      ...(typeof input.cwd === "string" && input.cwd !== "" ? { cwd: input.cwd } : {}),
      ...(policy.fnl.json ? { json: true, onDecision: (d: FnlDecision) => decisions.push(d) } : {}),
    });
    const out = await hook(input, toolUseId, { signal: new AbortController().signal });
    const fnl = decisions[0] ? { fnl: decisions[0] } : {};
    const spec = out.hookSpecificOutput;
    if (spec?.permissionDecision === "deny") {
      return {
        output: out,
        log: [{ ...base, decision: "deny", ...(spec.permissionDecisionReason ? { reason: spec.permissionDecisionReason } : {}), ...fnl }],
      };
    }
    if (spec?.updatedInput) {
      // Codex runs a rewritten command when the reply also says allow.
      return {
        output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: spec.updatedInput } },
        log: [{ ...base, decision: "rewrite", ...fnl }],
      };
    }
    return { log: [{ ...base, decision: "allow", ...fnl }] };
  }
  return { log: [{ ...base, decision: "allow" }] };
}

/** Answer one hook call: Codex's event on stdin, the reply for stdout. Never throws. */
export async function runCodexHook(stdin: string, args: CodexHookArgs): Promise<{ stdout: string; exitCode: number }> {
  const deny = (reason: string) => ({ stdout: JSON.stringify(denyOutput(reason.slice(0, 300))), exitCode: 0 });
  const quiet = { stdout: "", exitCode: 0 };
  if (args.event === "SessionStart") {
    // Recording the model is all SessionStart does; a failure only loses that.
    try {
      const input = JSON.parse(stdin) as Record<string, unknown>;
      if (args.logDir && typeof input.model === "string") {
        appendLog(args.logDir, [{ event: "SessionStart", decision: "record", model: input.model }]);
      }
    } catch {
      // nothing to record
    }
    return quiet;
  }
  if (args.error || !args.policy) return deny(`swarm hook error: ${args.error ?? "no session policy"}`);
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdin) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    return deny("swarm could not read the hook input");
  }
  try {
    const { output, log } = await decidePreToolUse(input, args.policy);
    if (args.logDir) appendLog(args.logDir, log);
    return { stdout: output ? JSON.stringify(output) : "", exitCode: 0 };
  } catch (err) {
    return deny(`swarm hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function appendLog(dir: string, entries: CodexHookLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    appendFileSync(join(dir, DECISIONS_FILE), entries.map((e) => JSON.stringify(e) + "\n").join(""));
  } catch {
    // The log only feeds counts; the decision stands without it.
  }
}

/** The session's decisions, without the backend's self-test calls or unreadable lines. */
export function readDecisions(file: string): CodexHookLogEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: CodexHookLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as CodexHookLogEntry;
      if (e.toolUseId?.startsWith(SELF_TEST_ID_PREFIX)) continue;
      out.push(e);
    } catch {
      // An unreadable line is skipped.
    }
  }
  return out;
}
