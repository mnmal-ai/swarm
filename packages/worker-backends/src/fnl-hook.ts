/**
 * Route a claude-code session's Bash commands through fnl
 * (https://github.com/mnmal-ai/fnl), which runs a build, test or lint command
 * and hands back a short digest of its output instead of the whole log.
 *
 * The session gets one Agent SDK PreToolUse hook on Bash. For each command:
 *
 * 1. A command that calls fnl itself (`fnl run -- '…'`) is denied. swarm adds
 *    fnl on its own, and a model-typed wrapper would hide the inner command
 *    from prefix deny rules such as `Bash(git push:*)`.
 * 2. Otherwise swarm asks `fnl rewrite` whether to wrap it, passing the
 *    session's Bash deny rules (`--deny`), so a denied command is never
 *    rewritten and the SDK's disallowedTools still refuses it, and the
 *    project's wrap patterns (`--wrap`).
 * 3. A rewrite comes back as `updatedInput` with no permission decision, so the
 *    normal permission evaluation still applies to the rewritten command.
 *
 * Apart from step 1, the hook never blocks a command: if fnl fails, hangs
 * past the timeout or wraps nothing, the command runs unchanged. Step 1 fails
 * closed: when fnl can't answer whether a command calls it, a text check
 * (CALLS_FNL, fnl in command position) decides, so an fnl call is still
 * denied. Command text is never logged.
 *
 * With an fnl that explains its decisions (`rewrite --json`, see
 * FnlBackendConfig.json), step 2 asks for the decision as JSON and reports it
 * through `onDecision`: wrapped or left alone, fnl's reason, and the build
 * tool fnl recognised, so the session can count its coverage
 * (FnlCoverageCounter). Only a tool name and a reason leave the hook. Both a
 * missing answer and an unreadable one count as unanswered: after a missing
 * one the command runs unchanged, after an unreadable one it is asked about
 * the old way.
 *
 * Hook shapes are the Agent SDK's (sdk.d.ts): `HookCallback` receives
 * `PreToolUseHookInput` (tool_name, tool_input, cwd) and returns a
 * `SyncHookJSONOutput` whose `hookSpecificOutput` is a
 * `PreToolUseHookSpecificOutput` (permissionDecision,
 * permissionDecisionReason, updatedInput); the callbacks go in
 * `Options.hooks` as `HookCallbackMatcher`s.
 */

import { execFile } from "node:child_process";
import type { FnlCoverage } from "@mnmal-ai/swarm-types";
import type { FnlSavingsMeter } from "./fnl-savings.js";

/** How a session reaches fnl; see BackendConfig.fnl. */
export interface FnlHookOptions {
  /** Absolute path to an fnl that supports `rewrite --deny` and `--check-invokes-fnl`. */
  bin: string;
  /** Command patterns to wrap, from the project's config (trusted). */
  wrap: string[];
  /** The session's Bash deny rules (see bashDenyRules). */
  denyRules: string[];
  /** Working directory when the hook input carries none. */
  cwd?: string;
  /** How long to wait for fnl before running the command unchanged. Default 3000 ms. */
  timeoutMs?: number;
  /** This fnl explains its decisions (`rewrite --json`); see FnlBackendConfig.json. */
  json?: boolean;
  /** Told each decision fnl made, when it explains them. Never given command text. */
  onDecision?: (decision: FnlDecision) => void;
  /** Told each call fnl wrapped, when it explains its decisions, so the
   *  session's savings hook can measure it (fnl-savings.ts). */
  savings?: FnlSavingsMeter;
}

/**
 * One of fnl's decisions about a Bash command, as `rewrite --json` explains
 * it: wrapped or left alone, fnl's reason, and the build tool it recognised
 * (a tool name, never command text). "unanswered": fnl gave no answer in
 * time, or one swarm couldn't read, and the command ran as written.
 */
export interface FnlDecision {
  decision: "wrapped" | "left-alone" | "unanswered";
  reason: string;
  buildTool: string | null;
}

/** A tool name fnl may report: one short word, so no command text gets through. */
const TOOL_NAME = /^[A-Za-z0-9_.+-]{1,64}$/;
/** A reason fnl may report. */
const REASON = /^[a-z][a-z-]{0,39}$/;

/** The decision in `rewrite --json` output, or null when it isn't one. */
function parseDecision(stdout: string): { rewritten: string | null; decision: FnlDecision } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().split("\n")[0] ?? "");
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.decision !== "wrapped" && p.decision !== "left-alone") return null;
  if (p.rewritten !== null && typeof p.rewritten !== "string") return null;
  return {
    rewritten: typeof p.rewritten === "string" ? p.rewritten : null,
    decision: {
      decision: p.decision,
      reason: typeof p.reason === "string" && REASON.test(p.reason) ? p.reason : "other",
      buildTool: typeof p.buildTool === "string" && TOOL_NAME.test(p.buildTool) ? p.buildTool : null,
    },
  };
}

/** Counts one session's fnl decisions into its FnlCoverage. */
export class FnlCoverageCounter {
  private coverage: FnlCoverage = { buildCommands: 0, wrapped: 0, leftAlone: {}, byTool: {}, unanswered: 0 };

  add(d: FnlDecision): void {
    const c = this.coverage;
    if (d.decision === "unanswered") {
      c.unanswered++;
      return;
    }
    if (d.buildTool === null) return;
    c.buildCommands++;
    const tool = (c.byTool[d.buildTool] ??= { wrapped: 0, leftAlone: 0 });
    if (d.decision === "wrapped") {
      c.wrapped++;
      tool.wrapped++;
    } else {
      c.leftAlone[d.reason] = (c.leftAlone[d.reason] ?? 0) + 1;
      tool.leftAlone++;
    }
  }

  snapshot(): FnlCoverage {
    const c = this.coverage;
    return {
      buildCommands: c.buildCommands,
      wrapped: c.wrapped,
      leftAlone: { ...c.leftAlone },
      byTool: Object.fromEntries(Object.entries(c.byTool).map(([tool, n]) => [tool, { ...n }])),
      unanswered: c.unanswered,
    };
  }
}

/** Subset of the SDK's SyncHookJSONOutput this hook returns. */
export type FnlHookOutput =
  | { hookSpecificOutput?: undefined }
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision?: "deny";
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
      };
    };

/** The hook callback, shaped like the SDK's HookCallback. */
export type FnlHookCallback = (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<FnlHookOutput>;

/**
 * Appended to the system prompt of a session whose Bash goes through fnl. fnl
 * digests a build, test or lint command only when it runs on its own: one
 * chained with `;` or `&&`, or piped into grep or head, runs as written.
 * Left alone, agents tend to write `build … | grep … | head; cd ..; git
 * status`, which keeps the raw log out of context but loses a failure in the
 * middle of it.
 */
export const FNL_INSTRUCTION = [
  "## Build and test output",
  "Run each build, test or lint command as its own Bash call: don't chain other commands with `;` or `&&` after it, and don't pipe it into `grep` or `head`. " +
    "Put environment variables on the command itself (`JAVA_HOME=/path ./gradlew test`), not in a separate `export`. A leading `cd <dir> &&`, and `2>&1 | tail -N`, are fine.",
  "The output then comes back as a short digest: errors with file and line, failing tests with their messages, and counts. The full log stays one `fnl show <id>` away; the digest names the id.",
].join("\n");

const DEFAULT_TIMEOUT_MS = 3000;
const DENY_REASON = "swarm adds fnl itself; run the command directly";

/** A direct call of `fnl run` or `fnl shim-exec`, for when fnl itself can't answer. */
const CALLS_FNL = /(?:^|[\s;&|(`]|\$\()\s*(?:\S*\/)?fnl\s+(?:run|shim-exec)\b/;

/** The Bash rules in a deniedTools list: `Bash` and `Bash(…)`. */
export function bashDenyRules(deniedTools: readonly string[]): string[] {
  return deniedTools.filter((rule) => rule === "Bash" || /^Bash\(.*\)$/.test(rule));
}

interface FnlResult {
  code: number | null;
  stdout: string;
}

/**
 * Run fnl with a minimal environment; resolves with code null on error,
 * timeout, abort or output over maxBuffer (default 1 MiB).
 */
export function runFnl(
  bin: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  limits: { maxBuffer?: number; signal?: AbortSignal } = {},
): Promise<FnlResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // The rewritten command calls fnl by this absolute path. A bare `fnl` would
  // fail with "command not found" when fnl's directory isn't on the agent
  // shell's PATH, which swarm doesn't control.
  env.FNL_BIN = bin;
  const maxBuffer = limits.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer, signal: limits.signal }, (err, stdout) => {
      if (err && typeof (err as { code?: unknown }).code !== "number") return resolve({ code: null, stdout: "" });
      resolve({ code: err ? ((err as { code: number }).code) : 0, stdout: String(stdout) });
    });
  });
}

/** The PreToolUse hook callback; see the file header for what it decides. */
export function fnlPreToolUse(opts: FnlHookOptions): FnlHookCallback {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const denyArgs = opts.denyRules.flatMap((rule) => ["--deny", rule]);
  const wrapArgs = opts.wrap.flatMap((pattern) => ["--wrap", pattern]);

  return async (input, toolUseID): Promise<FnlHookOutput> => {
    const hook = input as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; cwd?: unknown };
    if (hook.tool_name !== "Bash") return {};
    const toolInput = hook.tool_input as Record<string, unknown> | undefined;
    const command = toolInput?.command;
    if (typeof command !== "string" || command.trim() === "") return {};
    const cwd = typeof hook.cwd === "string" && hook.cwd !== "" ? hook.cwd : opts.cwd;

    const check = await runFnl(opts.bin, ["rewrite", "--check-invokes-fnl", "--", command], cwd, timeoutMs);
    const callsFnl = check.code === 0 || check.code === 1 ? check.code === 0 : CALLS_FNL.test(command);
    if (callsFnl) {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON },
      };
    }

    const rewriteTo = (rewritten: string | null): FnlHookOutput =>
      rewritten === null || rewritten === "" || rewritten === command
        ? {}
        : { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: rewritten } } };

    if (opts.json) {
      // fnl explains its decision; the session counts it. An answer that
      // doesn't come, or can't be read, is counted as unanswered.
      const answer = await runFnl(opts.bin, ["rewrite", "--json", ...denyArgs, ...wrapArgs, "--", command], cwd, timeoutMs);
      if (answer.code !== 0 && answer.code !== 1) {
        opts.onDecision?.({ decision: "unanswered", reason: "no-answer", buildTool: null });
        return {};
      }
      const parsed = parseDecision(answer.stdout);
      if (parsed) {
        opts.onDecision?.(parsed.decision);
        if (parsed.decision.decision !== "wrapped") return {};
        const out = rewriteTo(parsed.rewritten?.trim() ?? null);
        // The session measures what each wrapped call saved, after it runs.
        const rewritten = out.hookSpecificOutput?.updatedInput?.command;
        if (opts.savings && typeof rewritten === "string") {
          opts.savings.wrapped(typeof hook.tool_use_id === "string" ? hook.tool_use_id : toolUseID, rewritten);
        }
        return out;
      }
      opts.onDecision?.({ decision: "unanswered", reason: "unreadable", buildTool: null });
    }

    const rewrite = await runFnl(opts.bin, ["rewrite", ...denyArgs, ...wrapArgs, "--", command], cwd, timeoutMs);
    return rewrite.code === 0 ? rewriteTo(rewrite.stdout.trim()) : {};
  };
}
