/**
 * A claude-code session whose fnl explains its decisions measures what each
 * wrapped Bash call saved, with PostToolUse and PostToolUseFailure hooks
 * beside the fnl PreToolUse hook, and returns the totals in its fnlCoverage.
 * The SDK is mocked: for each Bash call it runs the session's PreToolUse
 * hooks, then its PostToolUse hooks with the result Claude Code would return
 * (or, for a call that failed, its PostToolUseFailure hooks with the error
 * text), before its result. A fake fnl wraps `make test` and shows one run's
 * full output.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Hook = (input: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>;
type Matchers = Array<{ matcher?: string; hooks: Hook[] }>;

const calls: Array<{ command: string; stdout?: string; error?: string }> = [];
let hooksSeen: Record<string, Matchers> | undefined;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    const hooks = args.options.hooks as Record<string, Matchers> | undefined;
    hooksSeen = hooks;
    const signal = new AbortController().signal;
    return (async function* () {
      for (const [n, call] of calls.entries()) {
        const id = `toolu_${n}`;
        for (const m of hooks?.PreToolUse ?? []) for (const hook of m.hooks) {
          await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: call.command }, tool_use_id: id }, id, { signal });
        }
        if (call.error !== undefined) {
          for (const m of hooks?.PostToolUseFailure ?? []) for (const hook of m.hooks) {
            await hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: call.command }, tool_use_id: id, error: call.error, is_interrupt: false }, id, { signal });
          }
          continue;
        }
        for (const m of hooks?.PostToolUse ?? []) for (const hook of m.hooks) {
          const tool_response = { stdout: call.stdout, stderr: "", interrupted: false, isImage: false };
          await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: call.command }, tool_use_id: id, tool_response }, id, { signal });
        }
      }
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

let dir: string;
let fnl: string;

/** 2,000 lines of 49 characters: 100,000 characters with their newlines. */
const LOG = Array.from({ length: 2000 }, (_, i) => `test ${String(i).padStart(4, "0")} ${"x".repeat(39)}`).join("\n") + "\n";
const DIGEST = "✗ make test · exit 1 · 9.0s\nFAIL src/a.test.ts:3 expected 1 to be 2\n[fnl run001 · 1998 lines not shown · fnl show run001]";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-fnl-savings-session-"));
  mkdirSync(join(dir, "runs"));
  writeFileSync(join(dir, "runs", "run001"), LOG);
  fnl = join(dir, "fnl");
  writeFileSync(
    fnl,
    `#!/bin/sh
if [ "$1" = show ]; then
  f="$(dirname "$0")/runs/$2"
  [ -f "$f" ] || exit 1
  cat "$f"; exit 0
fi
[ "$1" = rewrite ] || exit 2
shift
check=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-invokes-fnl) check=1; shift ;;
    --json) shift ;;
    --deny|--wrap) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ "$check" = 1 ] && exit 1
case "$*" in
  "make test 2>&1 | tail -40") printf '{"rewritten":"%s run -- '"'"'make test'"'"' 2>&1 | tail -40","decision":"wrapped","reason":"wrapped","buildTool":"make"}\\n' "$FNL_BIN"; exit 0 ;;
  "make test") printf '{"rewritten":"%s run -- '"'"'make test'"'"'","decision":"wrapped","reason":"wrapped","buildTool":"make"}\\n' "$FNL_BIN"; exit 0 ;;
  *) echo '{"rewritten":null,"decision":"left-alone","reason":"not-a-build-command","buildTool":null}'; exit 1 ;;
esac
`,
  );
  chmodSync(fnl, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  calls.length = 0;
  hooksSeen = undefined;
});

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };

describe("ClaudeCodeBackend: fnl savings", () => {
  it("measures each wrapped call after it runs, failed ones too, and returns the session's savings with its coverage", async () => {
    const error = `Exit code 1\n${DIGEST}`;
    calls.push(
      { command: "make test", stdout: DIGEST },
      { command: "make test 2>&1 | tail -40", stdout: DIGEST },
      { command: "make test", error },
      { command: "git status", stdout: "On branch main" },
    );
    const out = await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [], json: true } }).execute(INPUT);
    // Without fnl: a 2,000-character preview of the first call's 100,000
    // characters; the second's last 40 lines, 40 × 49 characters and 39
    // newlines; the failed third's error text cut to 10,000.
    const sent = 2 * DIGEST.length + error.length;
    expect(out.fnlCoverage?.savings).toEqual({
      calls: 3,
      rawTokens: Math.ceil(300_000 / 4),
      sentTokens: Math.ceil(sent / 4),
      withoutFnlTokens: Math.ceil(13_999 / 4),
      savedTokens: Math.ceil((13_999 - sent) / 4),
      unmeasured: 0,
      oversized: 2,
    });
    expect(out.fnlCoverage).toMatchObject({ buildCommands: 3, wrapped: 3 });
  });

  it("installs the savings hook on Bash, after calls and after failed ones", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [], json: true } }).execute(INPUT);
    expect(hooksSeen?.PostToolUse?.map((m) => m.matcher)).toEqual(["Bash"]);
    expect(hooksSeen?.PostToolUseFailure?.map((m) => m.matcher)).toEqual(["Bash"]);
  });

  it("has no savings for a session that wrapped nothing", async () => {
    calls.push({ command: "git status", stdout: "On branch main" });
    const out = await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [], json: true } }).execute(INPUT);
    expect(out.fnlCoverage).toBeDefined();
    expect(out.fnlCoverage).not.toHaveProperty("savings");
  });

  it("installs no savings hook when fnl doesn't explain its decisions, or there is no fnl", async () => {
    calls.push({ command: "make test", stdout: DIGEST });
    await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [] } }).execute(INPUT);
    expect(hooksSeen?.PostToolUse).toBeUndefined();
    expect(hooksSeen?.PostToolUseFailure).toBeUndefined();
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);
    expect(hooksSeen).toBeUndefined();
  });
});
