import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gateCwd, gateEnv, mergeEligibility, normalizeLabel, redactGateOutput, runMergeGate, tailLines } from "../src/source-control/merge.js";
import { validateSourceControlConfig } from "../src/source-control/commit-policy.js";

const SKIP = ["swarm_merge: false"];

describe("mergeEligibility", () => {
  it("allows a goal whose every task passed review", () => {
    expect(
      mergeEligibility({ verdicts: ["approved", "completed_with_notes", "completed_with_deferrals"], labels: [], skipLabels: SKIP }),
    ).toEqual({ eligible: true });
  });

  it.each([["rejected"], ["failed"], ["skipped"], ["escalate"], ["none"]])("refuses a goal with a %s task", (bad) => {
    const r = mergeEligibility({ verdicts: ["approved", bad], labels: [], skipLabels: SKIP });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toContain(`1 of 2 task(s) did not pass review (${bad})`);
  });

  it("refuses a goal with no verdicts", () => {
    const r = mergeEligibility({ verdicts: [], labels: [], skipLabels: SKIP });
    expect(r).toEqual({ eligible: false, reason: "no task of this goal has a review verdict" });
  });

  it.each([["swarm_merge: false"], ["swarm_merge:false"], ["Swarm_Merge : FALSE"], ["  swarm_merge  :  false "]])(
    "refuses a goal labelled %j",
    (label) => {
      const r = mergeEligibility({ verdicts: ["approved"], labels: ["Feature", label], skipLabels: SKIP });
      expect(r).toEqual({ eligible: false, reason: 'the card is labelled "swarm_merge: false", so a person merges it' });
    },
  );

  it("ignores labels that only look alike", () => {
    expect(mergeEligibility({ verdicts: ["approved"], labels: ["swarm_merge: true", "swarm_split: false"], skipLabels: SKIP })).toEqual({
      eligible: true,
    });
  });

  it("uses the configured skip labels", () => {
    const r = mergeEligibility({ verdicts: ["approved"], labels: ["hold"], skipLabels: ["Hold"] });
    expect(r.eligible).toBe(false);
  });
});

describe("normalizeLabel and tailLines", () => {
  it("normalizes case and spaces around a colon", () => {
    expect(normalizeLabel("  Swarm_Merge :  False ")).toBe("swarm_merge:false");
  });
  it("keeps the last non-empty lines", () => {
    expect(tailLines("a\n\nb\nc\n", 2)).toBe("b\nc");
  });
});

describe("runMergeGate", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-gate-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "marker.txt"), "x");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("passes on exit 0, in the configured cwd, with the configured env", async () => {
    const r = await runMergeGate(root, { command: 'test -f marker.txt && test "$GATE_FLAG" = on && echo done', cwd: "sub", env: { GATE_FLAG: "on" } });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.tail).toBe("done");
  });

  it("keeps all of a failing gate's output", async () => {
    const r = await runMergeGate(root, { command: "for i in $(seq 1 2000); do echo line-$i; done; echo the-real-error >&2; exit 2" });
    expect(r.exitCode).toBe(2);
    expect(r.tail.split("\n").at(-1)).toBe("the-real-error");
  });

  it("fails with the exit code and the output's tail", async () => {
    const r = await runMergeGate(root, { command: "echo one; echo two >&2; exit 3" });
    expect(r).toMatchObject({ passed: false, exitCode: 3, timedOut: false });
    expect(r.tail).toContain("one");
    expect(r.tail).toContain("two");
  });

  it("fails on timeout", async () => {
    const r = await runMergeGate(root, { command: "sleep 5", timeout_ms: 200 });
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("times out on schedule and kills children that hold the pipes open", async () => {
    const pidFile = join(root, "child.pid");
    const started = Date.now();
    // A background child that inherits stdout keeps the pipe open after sh is signalled.
    const r = await runMergeGate(root, { command: `sleep 60 & echo $! > ${pidFile}; wait`, timeout_ms: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
    expect(Date.now() - started).toBeLessThan(8_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does not wait for a background child left running by a gate that exits", async () => {
    const pidFile = join(root, "left.pid");
    const started = Date.now();
    const r = await runMergeGate(root, { command: `sleep 60 & echo $! > ${pidFile}; echo ok`, timeout_ms: 30_000 });
    expect(r.passed).toBe(true);
    expect(r.tail).toBe("ok");
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("refuses a cwd outside the repo", async () => {
    expect(() => gateCwd(root, "../elsewhere")).toThrow(/outside the work repo/);
    const r = await runMergeGate(root, { command: "true", cwd: "../elsewhere" });
    expect(r.passed).toBe(false);
  });
});

describe("the gate's environment", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    GH_TOKEN: "ghp_x",
    GITHUB_TOKEN: "ghs_x",
    GH_CONFIG_DIR: "/home/x/.config/gh",
    AWS_SECRET_ACCESS_KEY: "aws",
    JAVA_HOME: "/jdk",
  };

  it("inherits only the allowlist, adds gate.env, and points gh at an empty config dir", () => {
    const env = gateEnv(base, { CI: "1", DATABASE_URL: "postgres://localhost/test" }, "/tmp/empty-gh");
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      JAVA_HOME: "/jdk",
      CI: "1",
      DATABASE_URL: "postgres://localhost/test",
      GH_CONFIG_DIR: "/tmp/empty-gh",
    });
  });

  it("is what the gate command actually sees", async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.SWARM_TEST_SECRET_TOKEN = "should-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-value";
    try {
      const r = await runMergeGate(tmpdir(), { command: 'echo "[${SWARM_TEST_SECRET_TOKEN:-none}] [${ANTHROPIC_API_KEY:-none}] [$GH_CONFIG_DIR]"' });
      expect(r.passed).toBe(true);
      expect(r.tail).toMatch(/^\[none\] \[none\] \[.+swarm-worker-gh-.+\]$/);
    } finally {
      delete process.env.SWARM_TEST_SECRET_TOKEN;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it("redacts secret shapes in the output's tail", async () => {
    expect(redactGateOutput("key sk-ant-abc123def456 and ghp_0123456789abcdefghijABCDEFGHIJ0123 token=supersecretvalue")).toBe(
      "key sk-ant-*** and ghX_*** token=***",
    );
    const r = await runMergeGate(tmpdir(), { command: "echo leaked sk-ant-abcdefghijklmnop; exit 1" });
    expect(r.tail).toBe("leaked sk-ant-***");
  });
});

describe("validateSourceControlConfig: merge_prs", () => {
  const ok = { strategy: "remote_pr", github_account: "example-bot", merge_prs: { enabled: true, gate: { command: "make test" } } };

  it("accepts a complete config", () => {
    expect(validateSourceControlConfig(ok)).toEqual([]);
    expect(
      validateSourceControlConfig({
        ...ok,
        merge_prs: { enabled: true, gate: { command: "make test", cwd: "app", env: { CI: "1" }, timeout_ms: 1000 }, skip_labels: ["hold"], after_merge: "review" },
      }),
    ).toEqual([]);
  });

  it("does not require anything while disabled", () => {
    expect(validateSourceControlConfig({ strategy: "ephemeral", merge_prs: { enabled: false } })).toEqual([]);
  });

  it.each([
    [{ ...ok, strategy: "local_branch" }, /strategy is 'local_branch'/],
    [{ ...ok, github_account: undefined }, /github_account is unset/],
    [{ ...ok, merge_prs: { enabled: true } }, /has no gate/],
    [{ ...ok, stack_prs: true }, /merge_prs and source_control.stack_prs are both on/],
    [{ ...ok, auto_push: false }, /auto_push or pr_on_goal_complete is false/],
    [{ ...ok, pr_on_goal_complete: false }, /auto_push or pr_on_goal_complete is false/],
    [{ ...ok, merge_prs: { ...ok.merge_prs, extra: 1 } }, /unknown key "extra"/],
    [{ ...ok, merge_prs: { enabled: true, gate: { command: "x", shell: "zsh" } } }, /gate has an unknown key "shell"/],
    [{ ...ok, merge_prs: { enabled: true, gate: { command: "" } } }, /gate.command must be a non-empty/],
    [{ ...ok, merge_prs: { enabled: true, gate: { command: "x", cwd: "../up" } } }, /gate.cwd must be a path inside/],
    [{ ...ok, merge_prs: { enabled: true, gate: { command: "x", cwd: "/abs" } } }, /gate.cwd must be a path inside/],
    [{ ...ok, merge_prs: { enabled: true, gate: { command: "x", env: { A: 1 } } } }, /gate.env must be an object of string values/],
    [{ ...ok, merge_prs: { enabled: true, gate: { command: "x", timeout_ms: -1 } } }, /timeout_ms must be a positive whole number/],
    [{ ...ok, merge_prs: { ...ok.merge_prs, after_merge: "closed" } }, /after_merge must be "done" or "review"/],
    [{ ...ok, merge_prs: { ...ok.merge_prs, skip_labels: "hold" } }, /skip_labels must be a list/],
    [{ ...ok, merge_prs: { ...ok.merge_prs, enabled: "yes" } }, /enabled must be true or false/],
    [{ ...ok, merge_prs: true }, /merge_prs must be an object/],
  ])("refuses %j", (config, message) => {
    const errors = validateSourceControlConfig(config);
    expect(errors.some((e) => message.test(e))).toBe(true);
  });
});
describe("merge_prs: queue settings", () => {
  const base = {
    strategy: "remote_pr",
    github_account: "bot",
    merge_prs: { enabled: true, gate: { command: "make check" } },
  };
  it("accepts max_rounds, resolve_conflicts and max_conflict_rounds", () => {
    expect(
      validateSourceControlConfig({
        ...base,
        merge_prs: { ...base.merge_prs, max_rounds: 5, resolve_conflicts: false, max_conflict_rounds: 1 },
      }),
    ).toEqual([]);
  });
  it("refuses a max_rounds that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, "3"]) {
      expect(validateSourceControlConfig({ ...base, merge_prs: { ...base.merge_prs, max_rounds: bad } })).toEqual([
        `source_control.merge_prs.max_rounds must be a positive whole number (got ${JSON.stringify(bad)})`,
      ]);
    }
  });
  it("refuses a max_conflict_rounds that is negative or not whole, and accepts 0", () => {
    expect(validateSourceControlConfig({ ...base, merge_prs: { ...base.merge_prs, max_conflict_rounds: 0 } })).toEqual([]);
    expect(validateSourceControlConfig({ ...base, merge_prs: { ...base.merge_prs, max_conflict_rounds: -1 } })).toEqual([
      "source_control.merge_prs.max_conflict_rounds must be a whole number, 0 or more (got -1)",
    ]);
  });
  it("refuses a resolve_conflicts that is not a boolean", () => {
    expect(validateSourceControlConfig({ ...base, merge_prs: { ...base.merge_prs, resolve_conflicts: "yes" } })).toEqual([
      'source_control.merge_prs.resolve_conflicts must be true or false (got "yes")',
    ]);
  });
});
