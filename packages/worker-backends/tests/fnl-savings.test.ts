/**
 * How many tokens fnl's digests save a session. The PreToolUse hook tells the
 * meter which Bash calls it wrapped (by tool_use_id) and what the command's
 * kept suffix does to its output; after each call, the savings hook reads the
 * digest's footer from the result Claude Code returned, asks `fnl show <id>`
 * for the run's full output, and works out what the agent's own command would
 * have shown without fnl: that output through the same `| tail`, as Claude
 * Code hands it to the model (whole within its Bash output limit, a 2,000
 * character preview over it; a failed command's text cut to 10,000).
 *
 * A fake `fnl` wraps any `make …` command (keeping `2>&1` and `| tail …`
 * outside, as fnl does) and answers `fnl show <id>` from a file under
 * runs/, failing for an id it has no file for.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fnlPreToolUse } from "../src/fnl-hook.js";
import {
  FnlSavingsMeter,
  applyTail,
  bashOutputLimit,
  fnlSavingsHook,
  footerRunId,
  keptTail,
  sentText,
  withoutFnl,
} from "../src/fnl-savings.js";

let dir: string;
let fnl: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-fnl-savings-"));
  mkdirSync(join(dir, "runs"));
  fnl = join(dir, "fnl");
  writeFileSync(
    fnl,
    `#!/bin/sh
runs="$(dirname "$0")/runs"
if [ "$1" = show ]; then
  [ -f "$runs/$2" ] || { echo "fnl: no run $2" >&2; exit 1; }
  cat "$runs/$2"; exit 0
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
cmd="$*"
case "$cmd" in
  make*)
    inner="\${cmd%% 2>&1*}"; inner="\${inner%% |*}"; suffix="\${cmd#"$inner"}"
    printf '{"rewritten":"%s run -- '"'"'%s'"'"'%s","decision":"wrapped","reason":"wrapped","buildTool":"make"}\\n' "$FNL_BIN" "$inner" "$suffix"
    exit 0 ;;
  *) echo '{"rewritten":null,"decision":"left-alone","reason":"not-a-build-command","buildTool":null}'; exit 1 ;;
esac
`,
  );
  chmodSync(fnl, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIGNAL = { signal: new AbortController().signal };

/** 1,000 lines of 49 characters: 50,000 characters with their newlines. */
const BIG = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(39)}`).join("\n") + "\n";

/** A run fnl can show, and the digest that names it. */
function run(id: string, output: string): string {
  writeFileSync(join(dir, "runs", id), output);
  return `✗ make test · exit 1 · 2.1s\nFAIL src/a.test.ts:3 expected 1 to be 2\n[fnl ${id} · 998 lines not shown · fnl show ${id}]`;
}

const pre = (command: string, id: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id, cwd: dir });
const failed = (id: string, error: string, interrupted = false) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "(as rewritten)" },
  tool_use_id: id,
  error,
  is_interrupt: interrupted,
  cwd: dir,
});
const post = (id: string, stdout: string, stderr = "") => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "(as rewritten)" },
  tool_use_id: id,
  tool_response: { stdout, stderr, interrupted: false, isImage: false },
  cwd: dir,
});

/** A session's two hooks, sharing one meter. */
function session(outputLimit?: number) {
  const meter = new FnlSavingsMeter();
  const before = fnlPreToolUse({ bin: fnl, wrap: [], denyRules: [], json: true, timeoutMs: 2000, savings: meter });
  const after = fnlSavingsHook({ bin: fnl, meter, ...(outputLimit === undefined ? {} : { outputLimit }) });
  return { meter, before, after };
}

describe("keptTail: what the command's kept suffix does to its output", () => {
  it("reads `| tail -40`", () => {
    expect(keptTail("cd app && /bin/fnl run -- 'make test' | tail -40")).toEqual({ last: 40 });
  });

  it("reads `| tail -n 40` and `| tail -n40`", () => {
    expect(keptTail("/bin/fnl run -- 'make test' | tail -n 40")).toEqual({ last: 40 });
    expect(keptTail("/bin/fnl run -- 'make test' | tail -n40")).toEqual({ last: 40 });
  });

  it("reads `2>&1 | tail -5`, where 2>&1 changes nothing", () => {
    expect(keptTail("/bin/fnl run -- 'make test' 2>&1 | tail -5")).toEqual({ last: 5 });
    expect(keptTail("/bin/fnl run -- 'make test' 2>&1")).toBeNull();
  });

  it("reads no suffix as the whole output", () => {
    expect(keptTail("/bin/fnl run -- 'make test'")).toBeNull();
    expect(keptTail("/bin/fnl run -- 'make test -k '\\''a b'\\'''")).toBeNull();
  });

  it("reads a command fnl left unquoted, being one plain word", () => {
    expect(keptTail("cd app && /bin/fnl run -- ./build.sh 2>&1 | tail -40")).toEqual({ last: 40 });
    expect(keptTail("/bin/fnl run -- make")).toBeNull();
  });

  it("reads past a quoted fnl path", () => {
    expect(keptTail("'/opt/my tools/fnl' run -- 'make test' | tail -5")).toEqual({ last: 5 });
  });

  it("reads a bare `| tail` as its default 10 lines, and `| tail -n +5` as from line 5", () => {
    expect(keptTail("/bin/fnl run -- 'make test' | tail")).toEqual({ last: 10 });
    expect(keptTail("/bin/fnl run -- 'make test' 2>&1 | tail -n +5")).toEqual({ from: 5 });
  });

  it("can't follow any other suffix", () => {
    expect(keptTail("/bin/fnl run -- 'make test' | grep FAIL")).toBeUndefined();
    expect(keptTail("/bin/fnl run -- 'make test' | tail -c 100")).toBeUndefined();
    expect(keptTail("make test")).toBeUndefined();
  });
});

describe("applyTail", () => {
  it("keeps the last lines, or the lines from one on", () => {
    expect(applyTail("a\nb\nc\nd\n", { last: 2 })).toBe("c\nd");
    expect(applyTail("a\nb\nc\nd", { last: 2 })).toBe("c\nd");
    expect(applyTail("a\nb\nc\nd\n", { from: 3 })).toBe("c\nd");
    expect(applyTail("a\nb\n", { last: 0 })).toBe("");
    expect(applyTail("a\nb\n", null)).toBe("a\nb\n");
  });
});

describe("bashOutputLimit: Claude Code's Bash output limit", () => {
  it("is 30,000 characters by default", () => {
    expect(bashOutputLimit(undefined)).toBe(30_000);
    expect(bashOutputLimit("")).toBe(30_000);
  });

  it("follows BASH_MAX_OUTPUT_LENGTH as Claude Code reads it: a positive number, at most 150,000", () => {
    expect(bashOutputLimit("40000")).toBe(40_000);
    expect(bashOutputLimit("500000")).toBe(150_000);
    expect(bashOutputLimit("lots")).toBe(30_000);
    expect(bashOutputLimit("-5")).toBe(30_000);
  });
});

describe("footerRunId: the run a digest names", () => {
  it("reads the id from the footer on the digest's last line", () => {
    expect(footerRunId("✗ make test · exit 1\nFAIL a.test.ts:3\n[fnl k3x9qa · 998 lines not shown · fnl show k3x9qa]\n")).toBe("k3x9qa");
    expect(footerRunId("boom\n[fnl egr4zd · 2 lines]")).toBe("egr4zd");
  });

  it("reads a footer at the end of a one-line digest", () => {
    expect(footerRunId("✓ make build · exit 0 · 0.2s [fnl c2cfs4 · 5000 lines not shown · fnl show c2cfs4]")).toBe("c2cfs4");
  });

  it("finds none when the result doesn't end with one", () => {
    expect(footerRunId("plain output\n")).toBeNull();
    expect(footerRunId("[fnl k3x9qa · 2 lines]\nmore output after it")).toBeNull();
    expect(footerRunId("[fnl -rf · 2 lines]")).toBeNull();
  });
});

describe("sentText: the result as Claude Code sends it to the model", () => {
  it("is stdout without leading blank lines or trailing space, then stderr", () => {
    expect(sentText({ stdout: "\n\nout\n", stderr: "err\n", interrupted: false })).toBe("out\nerr");
    expect(sentText({ stdout: "out\n", stderr: "", interrupted: false })).toBe("out");
  });

  it("is Claude Code's compressed output when it sent that instead", () => {
    expect(sentText({ stdout: "long out", stderr: "", interrupted: false, tokenSaverOutput: "short" })).toBe("short");
  });

  it("is unknown for an interrupted call, one whose output went to a file, or an unexpected shape", () => {
    expect(sentText({ stdout: "out", stderr: "", interrupted: true })).toBeNull();
    expect(sentText({ stdout: "out", stderr: "", interrupted: false, persistedOutputPath: "/tmp/x" })).toBeNull();
    expect(sentText("out")).toBeNull();
    expect(sentText(undefined)).toBeNull();
  });
});

describe("withoutFnl: what the agent's own command would have shown it", () => {
  const text = (n: number) => "y".repeat(n);

  it("is the whole output, through the kept tail, when it is within the limit", () => {
    expect(withoutFnl(text(30_000), null, { failed: false, outputLimit: 30_000 })).toEqual({ chars: 30_000, oversized: false });
    expect(withoutFnl("a\nb\nc\n", { last: 2 }, { failed: false, outputLimit: 30_000 })).toEqual({ chars: 3, oversized: false });
  });

  it("is a 2,000-character preview of a successful result over the limit", () => {
    expect(withoutFnl(text(30_001), null, { failed: false, outputLimit: 30_000 })).toEqual({ chars: 2_000, oversized: true });
    expect(withoutFnl(text(30_001), null, { failed: false, outputLimit: 40_000 })).toEqual({ chars: 30_001, oversized: false });
  });

  it("is a failed command's text cut to 10,000 characters", () => {
    expect(withoutFnl(text(10_000), null, { failed: true, outputLimit: 30_000 })).toEqual({ chars: 10_000, oversized: false });
    expect(withoutFnl(text(25_000), null, { failed: true, outputLimit: 30_000 })).toEqual({ chars: 10_000, oversized: true });
  });
});

describe("fnlSavingsHook", () => {
  it("measures a wrapped call: the digest sent, fnl's full output, and the 2,000-character preview a log over 30,000 would have got", async () => {
    const { meter, before, after } = session();
    const digest = run("r1nosfx", BIG);
    const wrapped = await before(pre("make test", "call-1"), "call-1", SIGNAL);
    expect(wrapped.hookSpecificOutput?.updatedInput?.command).toBe(`${fnl} run -- 'make test'`);
    expect(await after(post("call-1", digest + "\n"), "call-1", SIGNAL)).toEqual({});
    expect(meter.snapshot()).toEqual({
      calls: 1,
      rawTokens: Math.ceil(50_000 / 4),
      sentTokens: Math.ceil(digest.length / 4),
      withoutFnlTokens: Math.ceil(2_000 / 4),
      savedTokens: Math.ceil((2_000 - digest.length) / 4),
      unmeasured: 0,
      oversized: 1,
    });
  });

  it("applies the kept `| tail -40` to the output the command would have shown", async () => {
    const { meter, before, after } = session();
    const digest = run("r2tail", BIG);
    await before(pre("make test 2>&1 | tail -40", "call-2"), "call-2", SIGNAL);
    await after(post("call-2", digest), "call-2", SIGNAL);
    // 40 lines of 49 characters and the 39 newlines between them, within the limit.
    expect(meter.snapshot()).toMatchObject({ calls: 1, withoutFnlTokens: Math.ceil(1999 / 4), savedTokens: Math.ceil((1999 - digest.length) / 4), oversized: 0 });
  });

  it("follows the session's BASH_MAX_OUTPUT_LENGTH when it set one", async () => {
    const { meter, before, after } = session(bashOutputLimit("60000"));
    const digest = run("r3limit", BIG);
    await before(pre("make test", "call-3"), "call-3", SIGNAL);
    await after(post("call-3", digest), "call-3", SIGNAL);
    // The whole log, its final newline trimmed as Claude Code trims output.
    expect(meter.snapshot()).toMatchObject({ withoutFnlTokens: Math.ceil(49_999 / 4), oversized: 0 });
  });

  it("never counts a saving below zero", async () => {
    const { meter, before, after } = session();
    const digest = run("r4tiny", "ok\n");
    await before(pre("make test", "call-4"), "call-4", SIGNAL);
    await after(post("call-4", digest), "call-4", SIGNAL);
    expect(meter.snapshot()).toMatchObject({ calls: 1, rawTokens: 1, withoutFnlTokens: 1, savedTokens: 0, oversized: 0 });
  });

  it("counts a wrapped call as unmeasured when fnl show fails", async () => {
    const { meter, before, after } = session();
    await before(pre("make test", "call-5"), "call-5", SIGNAL);
    await after(post("call-5", "✗ make test · exit 1\n[fnl gone00 · 3 lines]"), "call-5", SIGNAL);
    expect(meter.snapshot()).toEqual({ calls: 0, rawTokens: 0, sentTokens: 0, withoutFnlTokens: 0, savedTokens: 0, unmeasured: 1, oversized: 0 });
  });

  it("counts a wrapped call as unmeasured when its result has no footer", async () => {
    const { meter, before, after } = session();
    await before(pre("make test", "call-6"), "call-6", SIGNAL);
    await after(post("call-6", "fnl: command not found"), "call-6", SIGNAL);
    expect(meter.snapshot()).toMatchObject({ calls: 0, unmeasured: 1 });
  });

  it("measures a failed wrapped call: its error text sent, and a large log cut as Claude Code cuts failure text", async () => {
    const { meter, before, after } = session();
    const error = `Exit code 1\n${run("r7fail", BIG)}`;
    await before(pre("make test", "call-7"), "call-7", SIGNAL);
    expect(await after(failed("call-7", error), "call-7", SIGNAL)).toEqual({});
    expect(meter.snapshot()).toEqual({
      calls: 1,
      rawTokens: Math.ceil(50_000 / 4),
      sentTokens: Math.ceil(error.length / 4),
      withoutFnlTokens: Math.ceil(10_000 / 4),
      savedTokens: Math.ceil((10_000 - error.length) / 4),
      unmeasured: 0,
      oversized: 1,
    });
  });

  it("measures a failed wrapped call whose log fits Claude Code's failure text whole", async () => {
    const { meter, before, after } = session();
    const error = `Exit code 2\n${run("r7small", "e".repeat(5_999) + "\n")}`;
    await before(pre("make test", "call-7b"), "call-7b", SIGNAL);
    await after(failed("call-7b", error), "call-7b", SIGNAL);
    expect(meter.snapshot()).toMatchObject({ calls: 1, withoutFnlTokens: Math.ceil(5_999 / 4), oversized: 0, unmeasured: 0 });
  });

  it("counts an interrupted call, or a failure with no footer, as unmeasured", async () => {
    const { meter, before, after } = session();
    await before(pre("make test", "call-7c"), "call-7c", SIGNAL);
    await before(pre("make test", "call-7d"), "call-7d", SIGNAL);
    await after(failed("call-7c", `Exit code 130\n${run("r7int", BIG)}`, true), "call-7c", SIGNAL);
    await after(failed("call-7d", "Exit code 127\nsh: fnl: not found"), "call-7d", SIGNAL);
    expect(meter.snapshot()).toMatchObject({ calls: 0, unmeasured: 2 });
  });

  it("counts a wrapped call whose suffix it can't follow as unmeasured", async () => {
    const meter = new FnlSavingsMeter();
    meter.wrapped("call-8", "/bin/fnl run -- 'make test' | grep FAIL");
    await fnlSavingsHook({ bin: fnl, meter })(post("call-8", run("r8grep", BIG)), "call-8", SIGNAL);
    expect(meter.snapshot()).toMatchObject({ calls: 0, unmeasured: 1 });
  });

  it("counts a wrapped call that never finished as unmeasured", async () => {
    const { meter, before } = session();
    await before(pre("make test", "call-9"), "call-9", SIGNAL);
    expect(meter.snapshot()).toMatchObject({ calls: 0, unmeasured: 1 });
  });

  it("doesn't measure a command fnl left alone", async () => {
    const { meter, before, after } = session();
    run("r10", BIG);
    expect(await before(pre("git status", "call-10"), "call-10", SIGNAL)).toEqual({});
    await after(post("call-10", "[fnl r10 · 2 lines]"), "call-10", SIGNAL);
    expect(meter.snapshot()).toBeUndefined();
  });

  it("adds up a session's calls, converting the totals to tokens", async () => {
    const { meter, before, after } = session();
    const d1 = run("r11a", BIG);
    const d2 = run("r11b", BIG);
    await before(pre("make test", "a"), "a", SIGNAL);
    await before(pre("make test | tail -n 40", "b"), "b", SIGNAL);
    await before(pre("make lint", "c"), "c", SIGNAL);
    await after(post("a", d1), "a", SIGNAL);
    await after(post("b", d2), "b", SIGNAL);
    await after(post("c", "no footer"), "c", SIGNAL);
    const sent = d1.length + d2.length;
    // A 2,000-character preview of the first log, the last 40 lines of the second.
    expect(meter.snapshot()).toEqual({
      calls: 2,
      rawTokens: Math.ceil(100_000 / 4),
      sentTokens: Math.ceil(sent / 4),
      withoutFnlTokens: Math.ceil(3_999 / 4),
      savedTokens: Math.ceil((3_999 - sent) / 4),
      unmeasured: 1,
      oversized: 1,
    });
  });

  it("leaves other tools alone, and never changes a result", async () => {
    const { meter, after } = session();
    expect(await after({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "x", tool_response: {} }, "x", SIGNAL)).toEqual({});
    expect(await after(null, undefined, SIGNAL)).toEqual({});
    expect(meter.snapshot()).toBeUndefined();
  });
});
