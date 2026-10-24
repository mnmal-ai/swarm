/**
 * The decisions behind `swarm codex-hook`: deny by the role's rules, keep
 * read-only roles read-only, deny tools it does not know, route allowed
 * commands through fnl, take everything it trusts from its own command line,
 * and deny on any error of its own, since Codex runs a command whose hook
 * crashed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISIONS_FILE,
  HOOK_FAILURE_DENY,
  codexHookArgs,
  decidePreToolUse,
  parseCodexHookArgs,
  readDecisions,
  runCodexHook,
  type CodexHookPolicy,
} from "../src/codex-hook.js";

const POLICY: CodexHookPolicy = { version: 1, deniedTools: ["Bash(git push:*)"], canRunCommands: true, canEdit: true };
const pre = (tool: string, command: string, id = "call-1") => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, tool_use_id: id, cwd: "/tmp" });
const denied = (o: { output?: object }) =>
  (o.output as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision === "deny";
const isDeny = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.permissionDecision === "deny";

let dir: string;
let fnl: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-codex-hook-"));
  fnl = join(dir, "fnl");
  // A fake fnl: wraps "pnpm test", explains itself with --json, and is never called by the command.
  writeFileSync(
    fnl,
    `#!/bin/sh
[ "$1" = rewrite ] || exit 2; shift
json=0; check=0
while [ "$#" -gt 0 ]; do case "$1" in --check-invokes-fnl) check=1; shift;; --json) json=1; shift;; --deny|--wrap) shift 2;; --) shift; break;; *) break;; esac; done
[ "$check" = 1 ] && exit 1
if [ "$*" = "pnpm test" ]; then
  if [ "$json" = 1 ]; then echo '{"decision":"wrapped","rewritten":"fnl run -- '"'"'pnpm test'"'"'","reason":"build-tool","buildTool":"pnpm"}'; else echo "fnl run -- 'pnpm test'"; fi; exit 0
fi
[ "$json" = 1 ] && echo '{"decision":"left-alone","rewritten":null,"reason":"not-build","buildTool":null}'; exit 1
`,
  );
  chmodSync(fnl, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("decidePreToolUse", () => {
  it("denies a denied command, by rule, without its text in the log", async () => {
    const r = await decidePreToolUse(pre("Bash", "sh -c 'git push origin topsecret'"), POLICY);
    expect(denied(r)).toBe(true);
    expect(r.log).toEqual([{ event: "PreToolUse", tool: "Bash", toolUseId: "call-1", decision: "deny", reason: "denied by Bash(git push:*)" }]);
    expect(JSON.stringify(r.log)).not.toContain("topsecret");
  });

  it("allows an ordinary command with no output", async () => {
    const r = await decidePreToolUse(pre("Bash", "git status"), POLICY);
    expect(r.output).toBeUndefined();
    expect(r.log[0].decision).toBe("allow");
  });

  it("denies edits for a role that may not edit, or whose rules deny editing, and commands for one that may not run them", async () => {
    expect(denied(await decidePreToolUse(pre("apply_patch", "*** Begin Patch"), { ...POLICY, canEdit: false }))).toBe(true);
    expect(denied(await decidePreToolUse(pre("apply_patch", "*** Begin Patch"), { ...POLICY, deniedTools: ["Edit"] }))).toBe(true);
    expect(denied(await decidePreToolUse(pre("Bash", "ls"), { ...POLICY, canRunCommands: false }))).toBe(true);
  });

  it.each(["exec_command", "shell", "local_shell", "write_stdin", "mcp__unconfigured__x"])("denies a tool it does not know: %s", async (tool) => {
    expect(denied(await decidePreToolUse(pre(tool, "git push"), POLICY))).toBe(true);
  });

  it("matches MCP tools by the role's exact server name, double underscores included", async () => {
    const policy = { ...POLICY, mcpServers: ["my__docs"] };
    expect(denied(await decidePreToolUse(pre("mcp__my__docs__search", ""), policy))).toBe(false);
    expect(denied(await decidePreToolUse(pre("mcp__my__other__search", ""), policy))).toBe(true);
  });

  it("allows Codex's own harmless tools and the role's MCP servers' tools", async () => {
    expect(denied(await decidePreToolUse(pre("update_plan", ""), POLICY))).toBe(false);
    expect(denied(await decidePreToolUse(pre("mcp__docs__search", ""), { ...POLICY, mcpServers: ["docs"] }))).toBe(false);
  });

  it("denies a call that names no tool", async () => {
    expect(denied(await decidePreToolUse({ hook_event_name: "PreToolUse" }, POLICY))).toBe(true);
  });

  it("rewrites through fnl, marks the rewrite allowed, and logs fnl's decision", async () => {
    const r = await decidePreToolUse(pre("Bash", "pnpm test"), { ...POLICY, fnl: { bin: fnl, wrap: ["pnpm test"], json: true } });
    expect(r.output).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "fnl run -- 'pnpm test'" } },
    });
    expect(r.log[0]).toMatchObject({ decision: "rewrite", fnl: { decision: "wrapped", buildTool: "pnpm" } });
  });

  it("logs fnl leaving a command alone", async () => {
    const r = await decidePreToolUse(pre("Bash", "ls"), { ...POLICY, fnl: { bin: fnl, wrap: ["pnpm test"], json: true } });
    expect(r.output).toBeUndefined();
    expect(r.log[0]).toMatchObject({ decision: "allow", fnl: { decision: "left-alone" } });
  });

  it("does not ask fnl about a denied command", async () => {
    const r = await decidePreToolUse(pre("Bash", "git push"), { ...POLICY, fnl: { bin: fnl, wrap: ["git push"], json: true } });
    expect(denied(r)).toBe(true);
    expect(r.log[0].fnl).toBeUndefined();
  });
});

describe("the hook's command line", () => {
  it("round-trips the event, policy and log directory", () => {
    const args = codexHookArgs("PreToolUse", POLICY, "/logs/s1");
    expect(args[0]).toBe("pre-tool-use");
    expect(parseCodexHookArgs(args)).toEqual({ event: "PreToolUse", policy: POLICY, logDir: "/logs/s1" });
    expect(parseCodexHookArgs(codexHookArgs("SessionStart", POLICY, "/l")).event).toBe("SessionStart");
  });

  it("reports anything it cannot trust, answering as PreToolUse", () => {
    expect(parseCodexHookArgs([])).toMatchObject({ event: "PreToolUse", error: expect.stringMatching(/unknown hook event/) });
    expect(parseCodexHookArgs(["post-tool-use"])).toMatchObject({ event: "PreToolUse", error: expect.any(String) });
    expect(parseCodexHookArgs(["pre-tool-use", "--policy", "not-base64-json"])).toMatchObject({ error: expect.stringMatching(/policy/) });
    expect(parseCodexHookArgs(["pre-tool-use", "--policy", Buffer.from(JSON.stringify({ version: 2 })).toString("base64")])).toMatchObject({ error: expect.any(String) });
    expect(parseCodexHookArgs(["pre-tool-use"])).toMatchObject({ error: "no session policy" });
    expect(parseCodexHookArgs(["pre-tool-use", "--extra", "x"])).toMatchObject({ error: expect.stringMatching(/unexpected/) });
  });
});

describe("runCodexHook", () => {
  const args = (logDir = mkdtempSync(join(dir, "log-"))) => parseCodexHookArgs(codexHookArgs("PreToolUse", POLICY, logDir));

  it("answers and logs one line per decision", async () => {
    const logDir = mkdtempSync(join(dir, "log-"));
    const r = await runCodexHook(JSON.stringify(pre("Bash", "git push")), args(logDir));
    expect(r.exitCode).toBe(0);
    expect(isDeny(r.stdout)).toBe(true);
    expect(readFileSync(join(logDir, DECISIONS_FILE), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("allows with no output", async () => {
    expect(await runCodexHook(JSON.stringify(pre("Bash", "ls")), args())).toEqual({ stdout: "", exitCode: 0 });
  });

  it("decides as PreToolUse whatever the input says its event is", async () => {
    const r = await runCodexHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } }), args());
    expect(isDeny(r.stdout)).toBe(true);
    const renamed = await runCodexHook(JSON.stringify({ ...pre("Bash", "git push"), hook_event_name: "BeforeTool" }), args());
    expect(isDeny(renamed.stdout)).toBe(true);
  });

  it("denies when its command line cannot be trusted", async () => {
    expect(isDeny((await runCodexHook(JSON.stringify(pre("Bash", "ls")), parseCodexHookArgs([]))).stdout)).toBe(true);
    expect(isDeny((await runCodexHook(JSON.stringify(pre("Bash", "ls")), parseCodexHookArgs(["pre-tool-use"]))).stdout)).toBe(true);
  });

  it("denies input it cannot read", async () => {
    expect(isDeny((await runCodexHook("not json", args())).stdout)).toBe(true);
    expect(isDeny((await runCodexHook("[1,2]", args())).stdout)).toBe(true);
  });

  it("records the model on SessionStart and stays quiet", async () => {
    const logDir = mkdtempSync(join(dir, "log-"));
    const r = await runCodexHook(JSON.stringify({ hook_event_name: "SessionStart", model: "some-model" }), parseCodexHookArgs(codexHookArgs("SessionStart", POLICY, logDir)));
    expect(r).toEqual({ stdout: "", exitCode: 0 });
    expect(readDecisions(join(logDir, DECISIONS_FILE))).toEqual([{ event: "SessionStart", decision: "record", model: "some-model" }]);
    expect(await runCodexHook("garbage", parseCodexHookArgs(codexHookArgs("SessionStart", POLICY, logDir)))).toEqual({ stdout: "", exitCode: 0 });
  });

  it("has a deny reply for when swarm itself fails", () => {
    expect(isDeny(HOOK_FAILURE_DENY)).toBe(true);
    expect(HOOK_FAILURE_DENY).not.toContain("'");
  });

  it("reads the log back without self-test entries or unreadable lines", () => {
    const logDir = mkdtempSync(join(dir, "log-"));
    writeFileSync(
      join(logDir, DECISIONS_FILE),
      [
        JSON.stringify({ event: "PreToolUse", toolUseId: "swarm-self-test-0", decision: "deny" }),
        JSON.stringify({ event: "SessionStart", decision: "record", model: "m" }),
        "garbage",
      ].join("\n") + "\n",
    );
    expect(readDecisions(join(logDir, DECISIONS_FILE))).toEqual([{ event: "SessionStart", decision: "record", model: "m" }]);
    expect(readDecisions(join(logDir, "missing.jsonl"))).toEqual([]);
  });
});
