/**
 * With an fnl that explains its decisions (`rewrite --json`), the PreToolUse
 * hook reports each one (wrapped or left alone, the reason, the build tool)
 * so a session can count its fnl coverage, and still never sees or logs more
 * than a tool's name. FnlCoverageCounter turns those reports into the
 * session's counts.
 *
 * A fake `fnl` speaks the --json contract: one JSON line, exit 0 when it
 * rewrote the command and 1 when it left it alone. "make build" is wrapped,
 * a piped xcodebuild is left alone for its shell structure, "ls -la" isn't a
 * build command, and "garbled" gets a line that isn't JSON. Without --json it
 * behaves like an older fnl.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FnlCoverageCounter, fnlPreToolUse, type FnlDecision } from "../src/fnl-hook.js";

let dir: string;
let fnl: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-fnl-json-"));
  fnl = join(dir, "fnl");
  writeFileSync(
    fnl,
    `#!/bin/sh
[ "$(cat "$(dirname "$0")/mode" 2>/dev/null)" = error ] && exit 3
[ "$1" = rewrite ] || exit 2
shift
json=0; check=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json=1; shift ;;
    --check-invokes-fnl) check=1; shift ;;
    --deny|--wrap) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
cmd="$*"
if [ "$check" = 1 ]; then
  case "$cmd" in *"fnl run"*) exit 0 ;; *) exit 1 ;; esac
fi
if [ "$json" = 0 ]; then
  [ "$cmd" = "make build" ] && { printf "%s run -- '%s'\\n" "$FNL_BIN" "$cmd"; exit 0; }
  exit 1
fi
case "$cmd" in
  "make build") printf '{"rewritten":"%s run -- '"'"'make build'"'"'","decision":"wrapped","reason":"wrapped","buildTool":"make"}\\n' "$FNL_BIN"; exit 0 ;;
  xcodebuild*"|"*) echo '{"rewritten":null,"decision":"left-alone","reason":"structure","buildTool":"xcodebuild"}'; exit 1 ;;
  garbled) echo 'not json'; exit 1 ;;
  *) echo '{"rewritten":null,"decision":"left-alone","reason":"not-a-build-command","buildTool":null}'; exit 1 ;;
esac
`,
  );
  chmodSync(fnl, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIGNAL = { signal: new AbortController().signal };
const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dir });
const setMode = (mode: "error" | null) => {
  const file = join(dir, "mode");
  if (mode === null) {
    try { unlinkSync(file); } catch { /* already gone */ }
  } else writeFileSync(file, mode);
};

function hookWith(json: boolean) {
  const decisions: FnlDecision[] = [];
  const hook = fnlPreToolUse({ bin: fnl, wrap: ["make build"], denyRules: [], json, onDecision: (d) => decisions.push(d), timeoutMs: 2000 });
  return { hook, decisions };
}

describe("fnlPreToolUse with an fnl that explains its decisions", () => {
  it("rewrites from the JSON answer and reports the decision", async () => {
    const { hook, decisions } = hookWith(true);
    const out = await hook(bash("make build"), "t", SIGNAL);
    expect(out.hookSpecificOutput?.updatedInput?.command).toBe(`${fnl} run -- 'make build'`);
    expect(decisions).toEqual([{ decision: "wrapped", reason: "wrapped", buildTool: "make" }]);
  });

  it("reports a build command it left alone, with fnl's reason, and runs it unchanged", async () => {
    const { hook, decisions } = hookWith(true);
    const out = await hook(bash("xcodebuild test -scheme App 2>&1 | grep error | head"), "t", SIGNAL);
    expect(out).toEqual({});
    expect(decisions).toEqual([{ decision: "left-alone", reason: "structure", buildTool: "xcodebuild" }]);
  });

  it("reports commands that aren't builds too, with no tool", async () => {
    const { hook, decisions } = hookWith(true);
    await hook(bash("ls -la"), "t", SIGNAL);
    expect(decisions).toEqual([{ decision: "left-alone", reason: "not-a-build-command", buildTool: null }]);
  });

  it("falls back to the plain rewrite when the answer isn't readable, and reports it as unanswered", async () => {
    const { hook, decisions } = hookWith(true);
    const out = await hook(bash("garbled"), "t", SIGNAL);
    expect(out).toEqual({});
    expect(decisions).toEqual([{ decision: "unanswered", reason: "unreadable", buildTool: null }]);
  });

  it("reports fnl failing as unanswered and runs the command unchanged", async () => {
    setMode("error");
    try {
      const { hook, decisions } = hookWith(true);
      expect(await hook(bash("make build"), "t", SIGNAL)).toEqual({});
      expect(decisions).toEqual([{ decision: "unanswered", reason: "no-answer", buildTool: null }]);
    } finally {
      setMode(null);
    }
  });

  it("asks an older fnl the old way and reports nothing", async () => {
    const { hook, decisions } = hookWith(false);
    const out = await hook(bash("make build"), "t", SIGNAL);
    expect(out.hookSpecificOutput?.updatedInput?.command).toBe(`${fnl} run -- 'make build'`);
    expect(decisions).toEqual([]);
  });

  it("reports nothing for a command it denies for calling fnl itself", async () => {
    const { hook, decisions } = hookWith(true);
    const out = await hook(bash("fnl run -- 'make build'"), "t", SIGNAL);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decisions).toEqual([]);
  });
});

describe("FnlCoverageCounter", () => {
  it("counts build commands, wrapped and left alone by reason and by tool, and unanswered ones", () => {
    const c = new FnlCoverageCounter();
    c.add({ decision: "wrapped", reason: "wrapped", buildTool: "xcodebuild" });
    c.add({ decision: "left-alone", reason: "structure", buildTool: "xcodebuild" });
    c.add({ decision: "left-alone", reason: "structure", buildTool: "gradlew" });
    c.add({ decision: "left-alone", reason: "deny-rule", buildTool: "gradlew" });
    c.add({ decision: "left-alone", reason: "not-a-build-command", buildTool: null });
    c.add({ decision: "unanswered", reason: "no-answer", buildTool: null });
    expect(c.snapshot()).toEqual({
      buildCommands: 4,
      wrapped: 1,
      leftAlone: { structure: 2, "deny-rule": 1 },
      byTool: { xcodebuild: { wrapped: 1, leftAlone: 1 }, gradlew: { wrapped: 0, leftAlone: 2 } },
      unanswered: 1,
    });
  });

  it("starts at zero", () => {
    expect(new FnlCoverageCounter().snapshot()).toEqual({ buildCommands: 0, wrapped: 0, leftAlone: {}, byTool: {}, unanswered: 0 });
  });
});
