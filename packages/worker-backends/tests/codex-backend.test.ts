/**
 * The codex backend end to end, against a fake `codex` (tests/fixtures/
 * fake-codex.mjs) that calls the real hook (tests/fixtures/run-hook.ts):
 * output, tokens, files and model; the environment and flags Codex gets;
 * separate sessions; and the ways a session must not start or must stop.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProgressEvent, WorkerTaskInput } from "@mnmal-ai/swarm-types";
import { CodexBackend, isCodexLoginFailure, parseCodexUsageLimit, placeContext } from "../src/codex.js";
import { CodexHookSelfTestError } from "../src/codex-selftest.js";

const FAKE = resolve(__dirname, "fixtures/fake-codex.mjs");
const REAL_HOOK = `npx tsx ${resolve(__dirname, "fixtures/run-hook.ts")}`;
let work: string;
let record: string;

beforeAll(() => {
  chmodSync(FAKE, 0o755);
  work = realpathSync(mkdtempSync(join(tmpdir(), "swarm-codex-backend-")));
  record = join(work, "record.jsonl");
  process.env.SWARM_CODEX_SESSIONS_DIR = join(work, "sessions");
});
afterAll(() => {
  delete process.env.SWARM_CODEX_SESSIONS_DIR;
  rmSync(work, { recursive: true, force: true });
});

const INPUT: WorkerTaskInput = { task: "fix the rounding", workingDirectory: "", swarmContext: "## Rules\nbe careful", maxTurns: 10 };
// The backend passes Codex only allowlisted variables, so each mode gets a
// small launcher that sets the fake's own variables.
const fakeCodex = (mode: string) => {
  const launcher = join(work, `codex-${mode}`);
  writeFileSync(launcher, `#!/bin/sh\nFAKE_CODEX_MODE=${mode} FAKE_CODEX_RECORD='${record}' exec node '${FAKE}' "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
};
const backend = (over: Record<string, unknown> = {}, events?: ProgressEvent[]) =>
  new CodexBackend({
    type: "codex",
    binaryPath: fakeCodex("ok"),
    codexHookCommand: REAL_HOOK,
    timeout: 60,
    permissions: { deniedTools: ["Bash(git push:*)"] },
    gitIdentity: { name: "Agent", email: "agent@example.invalid" },
    ...(events ? { interactionHandler: { onProgress: (e: ProgressEvent) => events.push(e) } } : {}),
    ...over,
  });
const records = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
/** The PreToolUse hook command Codex was given, and the session's log directory in it. */
const hookOf = (args: string[]) => {
  const setting = args.find((a) => a.startsWith("hooks.PreToolUse="))!;
  const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(setting)![1]) as string;
  return { command, logDir: /--log (\S+)/.exec(command)![1] };
};

describe("CodexBackend", () => {
  it("runs a session: output, tokens, files, model, and the hook denies the push", async () => {
    const events: ProgressEvent[] = [];
    const out = await backend({}, events).execute({ ...INPUT, workingDirectory: work });
    expect(out.output).toBe("task=fix the rounding push=deny");
    expect(out.backendUsed).toBe("codex");
    expect(out.exitCode).toBe(0);
    expect(out.tokensUsed).toEqual({ input: 500, output: 50, cacheRead: 400, cacheWrite: 0 });
    expect(out.filesChanged).toEqual(["src/discount.js"]);
    expect(out.modelReport).toEqual({
      requested: undefined,
      sessionModel: "fake-codex-model",
      responses: { "fake-codex-model": 1 },
      usage: { "fake-codex-model": { input: 500, output: 50 } },
    });
    expect(out.fnlCoverage).toBeUndefined();
    expect(events.map((e) => e.type)).toContain("tool_call");
  }, 120_000);

  it("gives Codex the isolation flags, swarm's context and a clean environment", async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.GH_TOKEN = "ghp_should_not_reach";
    process.env.OPENAI_API_KEY = "sk-should-not-reach";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-reach";
    try {
      await backend({ model: "some-model" }).execute({ ...INPUT, workingDirectory: work });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const { args, env } = records().filter((r) => r.args).at(-1);
    expect(args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ephemeral", "-m", "some-model"]));
    expect(args).toContain(`developer_instructions="## Rules\\nbe careful"`);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBeTruthy();
    expect(env.GIT_AUTHOR_EMAIL).toBe("agent@example.invalid");
    // git in the session cannot authenticate to a remote.
    expect(env.GIT_CONFIG_PARAMETERS).toBe("'credential.helper=' 'core.sshCommand=false'");
    expect(env.GIT_SSH_COMMAND).toBe("false");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // Everything the hook trusts is on its command line, and a failure of swarm still answers deny.
    const hook = hookOf(args);
    expect(hook.command).toMatch(/pre-tool-use --policy [A-Za-z0-9+/=]+ --log /);
    expect(hook.command).toMatch(/\|\| printf '%s' '\{"hookSpecificOutput"/);
    // The log lives outside the sandbox's writable directories, and is removed after the session.
    expect(hook.logDir.startsWith(join(work, "sessions"))).toBe(true);
    expect(existsSync(hook.logDir)).toBe(false);
  }, 120_000);

  it("gives two sessions at once separate session directories", async () => {
    rmSync(record, { force: true });
    await Promise.all([backend().execute({ ...INPUT, workingDirectory: work }), backend().execute({ ...INPUT, workingDirectory: work })]);
    const dirs = records().filter((r) => r.args).map((r) => hookOf(r.args).logDir);
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs).size).toBe(2);
  }, 120_000);

  it("refuses a deny rule a codex session cannot enforce, before starting", async () => {
    rmSync(record, { force: true });
    await expect(
      backend({ permissions: { deniedTools: ["Bash(git push:*)", "Read(.env)"] } }).execute({ ...INPUT, workingDirectory: work }),
    ).rejects.toThrow(/cannot enforce these deny rules: Read\(\.env\)/);
    expect(existsSync(record)).toBe(false);
  });

  it("fails a session that changed the repository's git hooks, and removes what it planted", async () => {
    const repo = join(work, "repo");
    execFileSync("git", ["init", "-q", repo]);
    await expect(backend({ binaryPath: fakeCodex("tamper") }).execute({ ...INPUT, workingDirectory: repo })).rejects.toThrow(
      /changed the repository's git hooks or config \(hooks\/pre-push\)/,
    );
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(false);
  }, 60_000);

  it("still checks git's hooks when Codex fails", async () => {
    const repo = join(work, "repo-fail");
    execFileSync("git", ["init", "-q", repo]);
    await expect(backend({ binaryPath: fakeCodex("tamper-fail") }).execute({ ...INPUT, workingDirectory: repo })).rejects.toThrow(/git hooks or config/);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(false);
  }, 60_000);

  it("refuses to start without a hook command", async () => {
    await expect(backend({ codexHookCommand: undefined }).execute({ ...INPUT, workingDirectory: work })).rejects.toThrow(/hook command/);
  });

  it("does not start Codex when the hook self-test fails", async () => {
    rmSync(record, { force: true });
    await expect(backend({ codexHookCommand: "cat >/dev/null" }).execute({ ...INPUT, workingDirectory: work })).rejects.toThrow(
      CodexHookSelfTestError,
    );
    expect(existsSync(record)).toBe(false);
  }, 60_000);

  it("stops a login failure as a codex login expiry", async () => {
    await expect(backend({ binaryPath: fakeCodex("login") }).execute({ ...INPUT, workingDirectory: work })).rejects.toMatchObject({
      name: "LoginExpiredError",
      runtime: "codex",
    });
  }, 60_000);

  it("fails a session that produced no output", async () => {
    await expect(backend({ binaryPath: fakeCodex("silent") }).execute({ ...INPUT, workingDirectory: work })).rejects.toThrow(/no output/);
  }, 60_000);

  it("times out, and stops Codex too", async () => {
    rmSync(record, { force: true });
    await expect(backend({ binaryPath: fakeCodex("hang"), timeout: 3 }).execute({ ...INPUT, workingDirectory: work })).rejects.toThrow(/timed out/);
    const hung = records().find((r) => r.hung);
    expect(() => process.kill(hung.hung, 0)).toThrow();
  }, 60_000);

  it("is available only when its binary exists", async () => {
    expect(await backend().isAvailable()).toBe(true);
    expect(await backend({ binaryPath: join(work, "nope") }).isAvailable()).toBe(false);
  });

  it("derives its hook policy from the role", () => {
    expect(backend().policy()).toEqual({ version: 1, deniedTools: ["Bash(git push:*)"], canRunCommands: true, canEdit: true });
    expect(backend({ tools: ["Read", "Glob", "Grep", "Bash"] }).policy()).toMatchObject({ canRunCommands: true, canEdit: false });
    expect(backend({ fnl: { bin: "/x/fnl", wrap: ["pnpm test"], json: true } }).policy().fnl).toEqual({ bin: "/x/fnl", wrap: ["pnpm test"], json: true });
    expect(backend({ tools: ["Read"], fnl: { bin: "/x/fnl", wrap: [] } }).policy().fnl).toBeUndefined();
  });
});

describe("placeContext", () => {
  it("gives Codex swarm's context as developer instructions when it fits in one argument", () => {
    expect(placeContext("rules", "the task")).toEqual({ developer: "rules", stdin: "the task" });
  });
  it("measures the context as escaped, so text that grows when escaped still fits", () => {
    const escapesToDouble = "\n".repeat(40 * 1024); // 40 KiB raw, 80 KiB once each newline is written as \\n
    expect(placeContext(escapesToDouble, "the task").stdin.startsWith("<swarm-context>")).toBe(true);
  });

  it("puts a context too large for one argument ahead of the task on stdin", () => {
    const big = "x".repeat(70 * 1024);
    const placed = placeContext(big, "the task");
    expect(placed.developer.length).toBeLessThan(300);
    expect(placed.stdin.startsWith("<swarm-context>\n")).toBe(true);
    expect(placed.stdin.endsWith("\n\nthe task")).toBe(true);
  });
});

describe("codex errors", () => {
  it("recognises a missing or expired login", () => {
    expect(isCodexLoginFailure("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header")).toBe(true);
    expect(isCodexLoginFailure("Not signed in. Please run codex login")).toBe(true);
    expect(isCodexLoginFailure("tests failed: 2 of 4")).toBe(false);
  });

  it("reads a usage limit's reset time when it says one", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    const err = parseCodexUsageLimit("You've hit your usage limit. Try again in 45 minutes.", now);
    expect(err?.waitMs).toBe(45 * 60_000);
    expect(err?.resetAt.toISOString()).toBe("2026-10-04T12:45:00.000Z");
    // No readable reset time: a default wait, not a failure.
    expect(parseCodexUsageLimit("usage limit reached", now)?.waitMs).toBe(30 * 60_000);
    expect(parseCodexUsageLimit("all good, try again in 5 minutes", now)).toBeNull();
  });
});
