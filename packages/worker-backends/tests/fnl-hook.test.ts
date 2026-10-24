/**
 * The PreToolUse hook that routes a worker's Bash commands through fnl.
 *
 * A fake `fnl` script stands in for the real binary: `rewrite
 * --check-invokes-fnl -- CMD` exits 0 when CMD calls fnl, `rewrite --deny R…
 * --wrap W… -- CMD` prints `fnl run -- 'CMD'` for commands it wraps and exits 1
 * for denied or unwrapped ones. A `mode` file beside it ("hang" / "error") makes
 * it misbehave (the hook passes fnl a minimal environment, so no env var).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashDenyRules, fnlPreToolUse } from "../src/fnl-hook.js";

let dir: string;
let fnl: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-fnl-hook-"));
  fnl = join(dir, "fnl");
  writeFileSync(
    fnl,
    `#!/bin/sh
case "$(cat "$(dirname "$0")/mode" 2>/dev/null)" in
  hang) sleep 10 ;;
  error) echo "boom" >&2; exit 3 ;;
esac
[ "$1" = rewrite ] || exit 2
shift
check=0; denies=""; wraps=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-invokes-fnl) check=1; shift ;;
    --deny) denies="$denies|$2"; shift 2 ;;
    --wrap) wraps="$wraps|$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
cmd="$*"
if [ "$check" = 1 ]; then
  case "$cmd" in *"fnl run"*|*"fnl shim-exec"*) exit 0 ;; *) exit 1 ;; esac
fi
case "$denies" in *"Bash(git push:*)"*) case "$cmd" in "git push"*) exit 1 ;; esac ;; esac
case "$wraps|" in *"|$cmd|"*) printf "%s run -- '%s'\\n" "\${FNL_BIN:-fnl}" "$cmd"; exit 0 ;; esac
exit 1
`,
  );
  chmodSync(fnl, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIGNAL = { signal: new AbortController().signal };
const setMode = (mode: "hang" | "error" | null) => {
  const file = join(dir, "mode");
  if (mode === null) {
    try { unlinkSync(file); } catch { /* already gone */ }
  } else {
    writeFileSync(file, mode);
  }
};
const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "run it", ...extra },
  tool_use_id: "toolu_1",
  session_id: "s1",
  transcript_path: "/dev/null",
  cwd: dir,
});

describe("fnlPreToolUse: routing a worker's Bash commands through fnl", () => {
  const hook = () =>
    fnlPreToolUse({ bin: fnl, wrap: ["make build", "git push origin main"], denyRules: ["Bash(git push:*)"], timeoutMs: 2000 });

  it("hands back the command fnl rewrites, keeping the rest of the tool input, with no permission decision", async () => {
    const out = await hook()(bash("make build"), "toolu_1", SIGNAL);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: `${fnl} run -- 'make build'`, description: "run it" },
      },
    });
  });

  it("makes the rewritten command call fnl by the absolute path swarm resolved, not whatever the agent's PATH holds", async () => {
    // Without FNL_BIN, fnl writes a bare `fnl run …`, which fails with
    // "command not found" when fnl's directory isn't on the agent shell's PATH.
    const out = await hook()(bash("make build"), "toolu_1", SIGNAL);
    const command = (out as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput.updatedInput.command;
    expect(command.startsWith(`${fnl} run -- `)).toBe(true);
  });

  it("leaves a command fnl doesn't wrap alone", async () => {
    expect(await hook()(bash("ls -la"), "toolu_1", SIGNAL)).toEqual({});
  });

  it("does not rewrite a command this backend's deniedTools deny, even when a wrap entry names it", async () => {
    // Left unrewritten, the SDK's own disallowedTools still refuses it.
    expect(await hook()(bash("git push origin main"), "toolu_1", SIGNAL)).toEqual({});
  });

  it("denies a command that calls fnl itself, which would hide it from prefix deny rules", async () => {
    const out = await hook()(bash("fnl run -- 'git push origin main'"), "toolu_1", SIGNAL);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "swarm adds fnl itself; run the command directly",
      },
    });
  });

  it("ignores tools other than Bash and inputs without a command", async () => {
    expect(await hook()({ ...bash("make build"), tool_name: "Read" }, "toolu_1", SIGNAL)).toEqual({});
    expect(await hook()({ ...bash("make build"), tool_input: { description: "no command" } }, "toolu_1", SIGNAL)).toEqual({});
  });

  it("never blocks: fnl failing leaves the command alone", async () => {
    setMode("error");
    try {
      expect(await hook()(bash("make build"), "toolu_1", SIGNAL)).toEqual({});
    } finally {
      setMode(null);
    }
  });

  it("still denies a direct fnl call when fnl itself can't answer", async () => {
    setMode("error");
    try {
      const out = await hook()(bash("FOO=1 fnl run -- 'git push'"), "toolu_1", SIGNAL);
      expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      // Only fnl in command position counts: text that mentions it runs.
      expect(await hook()(bash('grep "fnl run" README.md'), "toolu_1", SIGNAL)).toEqual({});
      expect(await hook()(bash("cat fnl.json"), "toolu_1", SIGNAL)).toEqual({});
    } finally {
      setMode(null);
    }
  });

  it("never blocks: fnl hanging is given up on within the timeout", async () => {
    setMode("hang");
    try {
      const quick = fnlPreToolUse({ bin: fnl, wrap: ["make build"], denyRules: [], timeoutMs: 300 });
      const started = Date.now();
      expect(await quick(bash("make build"), "toolu_1", SIGNAL)).toEqual({});
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      setMode(null);
    }
  });
});

describe("bashDenyRules: the Bash rules in a deniedTools list", () => {
  it("keeps Bash rules and drops other tools' rules", () => {
    expect(bashDenyRules(["Bash(git push:*)", "mcp__claude_ai_*", "Bash", "WebFetch", "Bash(fly:*)"])).toEqual([
      "Bash(git push:*)",
      "Bash",
      "Bash(fly:*)",
    ]);
  });
});
