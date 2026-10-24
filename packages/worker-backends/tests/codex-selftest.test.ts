/**
 * The hook self-test: before a codex session starts, the exact hook command
 * must deny a call the policy denies and allow an ordinary one. A hook that
 * crashes, hangs, cannot be found, allows everything or denies everything
 * stops the session.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHookSelfTestError, selfTestCodexHook, selfTestProbes } from "../src/codex-selftest.js";
import type { CodexHookPolicy } from "../src/codex-hook.js";

const POLICY: CodexHookPolicy = { version: 1, deniedTools: ["Bash(git push:*)"], canRunCommands: true, canEdit: true };
const DENY = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}`;
let dir: string;
const script = (name: string, body: string) => {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-selftest-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("selfTestProbes", () => {
  it("probes the first Bash rule and an ordinary command", () => {
    expect(selfTestProbes(POLICY)).toEqual([
      { tool: "Bash", command: "git push", expect: "deny" },
      { tool: "Bash", command: "true", expect: "allow" },
    ]);
  });
  it("probes an edit for a read-only role with no rules", () => {
    expect(selfTestProbes({ ...POLICY, deniedTools: [], canEdit: false })[0]).toMatchObject({ tool: "apply_patch", expect: "deny" });
  });
  it("probes a command for a role that may not run them, or that denies all of them", () => {
    expect(selfTestProbes({ ...POLICY, canRunCommands: false })).toEqual([{ tool: "Bash", command: "true", expect: "deny" }]);
    expect(selfTestProbes({ ...POLICY, deniedTools: ["Bash"] })).toEqual([{ tool: "Bash", command: "true", expect: "deny" }]);
  });
  it("probes a wildcard rule with the wildcard taken out", () => {
    expect(selfTestProbes({ ...POLICY, deniedTools: ["Bash(git push*)"] })[0]).toEqual({ tool: "Bash", command: "git push", expect: "deny" });
  });
  it("still probes an ordinary command when nothing is denied", () => {
    expect(selfTestProbes({ ...POLICY, deniedTools: [] })).toEqual([{ tool: "Bash", command: "true", expect: "allow" }]);
  });
});

describe("selfTestCodexHook", () => {
  const run = (hook: string, timeoutMs = 5000) =>
    selfTestCodexHook({ hookCommand: hook, env: { PATH: process.env.PATH }, cwd: dir, policy: POLICY, timeoutMs });

  it("passes a hook that denies the push and allows the rest", async () => {
    const hook = script("good", `input=$(cat); case "$input" in *"git push"*) echo '${DENY}';; esac`);
    await expect(run(hook)).resolves.toBeUndefined();
  });
  it("fails a hook that allows everything", async () => {
    await expect(run(script("lax", "cat >/dev/null"))).rejects.toThrow(CodexHookSelfTestError);
  });
  it("fails a hook that crashes", async () => {
    await expect(run(script("crash", "cat >/dev/null; exit 1"))).rejects.toThrow(/exited 1/);
  });
  it("fails a hook that cannot be found", async () => {
    await expect(run(join(dir, "missing"))).rejects.toThrow(CodexHookSelfTestError);
  });
  it("fails a hook that denies everything", async () => {
    await expect(run(script("strict", `cat >/dev/null; echo '${DENY}'`))).rejects.toThrow(/allow/);
  });
  it("fails a hook that answers with something other than JSON", async () => {
    await expect(run(script("chatty", "cat >/dev/null; echo hello"))).rejects.toThrow(/not JSON/);
  });
  it("fails a hook that hangs", async () => {
    await expect(run(script("hang", "sleep 30"), 500)).rejects.toThrow(/did not answer/);
  });
});
