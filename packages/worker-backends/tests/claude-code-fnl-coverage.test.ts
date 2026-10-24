/**
 * A claude-code session whose fnl explains its decisions counts them and
 * returns the counts as the session's fnlCoverage. The SDK is mocked: it
 * calls the session's PreToolUse hook for a few Bash commands, as Claude Code
 * would, before returning its result. A fake fnl answers `rewrite --json`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commands: string[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    const hooks = args.options.hooks as { PreToolUse?: Array<{ hooks: Array<(input: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>> }> } | undefined;
    return (async function* () {
      const hook = hooks?.PreToolUse?.[0]?.hooks[0];
      for (const command of commands) {
        await hook?.({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, "t", { signal: new AbortController().signal });
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-fnl-coverage-"));
  fnl = join(dir, "fnl");
  writeFileSync(
    fnl,
    `#!/bin/sh
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
  "cd ios && xcodebuild test -scheme App") echo '{"rewritten":"cd ios \\u0026\\u0026 fnl run -- x","decision":"wrapped","reason":"wrapped","buildTool":"xcodebuild"}'; exit 0 ;;
  xcodebuild*) echo '{"rewritten":null,"decision":"left-alone","reason":"structure","buildTool":"xcodebuild"}'; exit 1 ;;
  *) echo '{"rewritten":null,"decision":"left-alone","reason":"not-a-build-command","buildTool":null}'; exit 1 ;;
esac
`,
  );
  chmodSync(fnl, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  commands.length = 0;
});

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };

describe("ClaudeCodeBackend: fnl coverage", () => {
  it("returns the session's counted decisions", async () => {
    commands.push("cd ios && xcodebuild test -scheme App", "xcodebuild build 2>&1 | grep error | head", "git status");
    const out = await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [], json: true } }).execute(INPUT);
    expect(out.fnlCoverage).toEqual({
      buildCommands: 2,
      wrapped: 1,
      leftAlone: { structure: 1 },
      byTool: { xcodebuild: { wrapped: 1, leftAlone: 1 } },
      unanswered: 0,
      // This mock never runs the wrapped call, so its savings went unmeasured
      // (claude-code-fnl-savings.test.ts measures them).
      savings: { calls: 0, rawTokens: 0, sentTokens: 0, withoutFnlTokens: 0, savedTokens: 0, unmeasured: 1, oversized: 0 },
    });
  });

  it("returns zero counts for a session that ran no build commands", async () => {
    commands.push("git status");
    const out = await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [], json: true } }).execute(INPUT);
    expect(out.fnlCoverage).toMatchObject({ buildCommands: 0, wrapped: 0 });
  });

  it("returns no coverage when fnl doesn't explain its decisions, or there is no fnl", async () => {
    commands.push("cd ios && xcodebuild test -scheme App");
    expect((await new ClaudeCodeBackend({ type: "claude-code", fnl: { bin: fnl, wrap: [] } }).execute(INPUT)).fnlCoverage).toBeUndefined();
    expect((await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT)).fnlCoverage).toBeUndefined();
  });
});
