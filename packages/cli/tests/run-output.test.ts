/**
 * `swarm run` banner / preflight output must describe what the run will
 * actually do: the Substrate endpoint in use, and whether (and how) swarm pushes.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { describePushBehaviour, formatMergeOutcome, formatMergeSummary, printSwarmTree } from "../src/cli/run.js";

describe("describePushBehaviour", () => {
  it("is on for stacked PRs when remote_pr + stack_prs", () => {
    expect(describePushBehaviour({ strategy: "remote_pr", stack_prs: true })).toBe("on (stacked PRs)");
    expect(describePushBehaviour({ strategy: "remote_pr", merge_prs: { enabled: true, gate: { command: "make test" } } })).toBe(
      "on (merge-as-you-go: each done goal's PR merges when its gate passes)",
    );
    expect(describePushBehaviour({ strategy: "remote_pr", stack_prs: true, auto_push: true })).toBe("on (stacked PRs)");
  });

  it("pushes branches without PRs when pr_on_goal_complete is false", () => {
    expect(
      describePushBehaviour({ strategy: "remote_pr", stack_prs: true, pr_on_goal_complete: false }),
    ).toBe("on (stacked branches, no PRs)");
  });

  it("is off when auto_push is false", () => {
    expect(describePushBehaviour({ strategy: "remote_pr", stack_prs: true, auto_push: false })).toBe(
      "off (auto_push is false)",
    );
  });

  it("is off for remote_pr without stack_prs: swarm run has no session-PR push step", () => {
    expect(describePushBehaviour({ strategy: "remote_pr" })).toBe("off (remote_pr pushes only with stack_prs)");
    expect(describePushBehaviour({ strategy: "remote_pr", stack_prs: false })).toBe(
      "off (remote_pr pushes only with stack_prs)",
    );
  });

  it("is off for every other strategy, and with no source_control", () => {
    expect(describePushBehaviour(undefined)).toBe("off");
    expect(describePushBehaviour({ strategy: "ephemeral", stack_prs: true })).toBe("off");
    expect(describePushBehaviour({ strategy: "local_branch", stack_prs: true })).toBe("off");
  });
});

describe("printSwarmTree — Substrate header", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the endpoint the Substrate client actually uses", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    const client = { endpoint: "http://127.0.0.1:55771", query: async () => [] };

    await printSwarmTree("/swarm", "project-a", client);

    const out = lines.join("\n");
    expect(out).toContain("(from Substrate)");
    expect(out).toContain("http://127.0.0.1:55771");
    expect(out).not.toContain("31338");
  });
});

describe("printSwarmTree — project scoping", () => {
  afterEach(() => vi.restoreAllMocks());

  // On a shared Substrate every project has its own copy of a path, and
  // older syncs left a legacy "global" copy. The tree lists this project's
  // files once.
  it("lists each of the project's files once on a shared Substrate", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    const rows = [
      { path: "core/values.md", tier: "core", tokenEstimate: "10", projectId: "global" },
      { path: "core/values.md", tier: "core", tokenEstimate: "20", projectId: "project-a" },
      { path: "core/values.md", tier: "core", tokenEstimate: "30", projectId: "project-b" },
      { path: "core/other-only.md", tier: "core", tokenEstimate: "40", projectId: "project-b" },
    ];
    const client = { endpoint: "http://127.0.0.1:1", query: async () => rows };

    await printSwarmTree("/swarm", "project-a", client);

    const out = lines.join("\n");
    expect(out).toContain("1 files, ~20 tokens");
    expect(out).not.toContain("other-only.md");
  });
});

describe("merge-as-you-go output", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colours
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const merged = { goalId: "g1", branch: "swarm/goal-g1", base: "main", prUrl: "https://example.test/pull/1", merged: true, mergeCommit: "abcdef0123456789", gate: { passed: true, exitCode: 0, timedOut: false, durationMs: 61000, tail: "" } };
  const open = { goalId: "g2", branch: "swarm/goal-g2", base: "main", prUrl: "https://example.test/pull/2", merged: false, reason: "the merge gate failed (exit 1); its output is in the run log", gate: { passed: false, exitCode: 1, timedOut: false, durationMs: 2000, tail: "1 failed\nexit 1" } };

  it("reports a merged goal and a goal left open, with the failing gate's tail", () => {
    expect(plain(formatMergeOutcome(merged))).toEqual(["    Merge gate passed (61s)", "    Merged https://example.test/pull/1 into main (abcdef012345)"]);
    expect(plain(formatMergeOutcome(open))).toEqual([
      "    Merge gate failed (2s)",
      "      1 failed",
      "      exit 1",
      "    Left open https://example.test/pull/2: the merge gate failed (exit 1); its output is in the run log",
    ]);
  });

  it("summarises the run", () => {
    expect(plain(formatMergeSummary([merged, open]))).toEqual([
      "  Merge-as-you-go: merged 1, left open 1",
      "    merged   g1: https://example.test/pull/1",
      "    open     g2: https://example.test/pull/2 (the merge gate failed (exit 1); its output is in the run log)",
    ]);
  });
});

describe("merge queue output", () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const base = { goalId: "g", branch: "b", base: "main", prUrl: "https://github.com/o/r/pull/9" };
  it("says how many rounds, how long it waited and that a worker resolved a conflict", () => {
    const lines = formatMergeOutcome({ ...base, merged: true, mergeCommit: "c".repeat(40), rounds: 2, waitedMs: 360_000, conflictsResolved: 1 }).map(plain);
    expect(lines).toContain("    Merged https://github.com/o/r/pull/9 into main (cccccccccccc), 2 rounds, waited 6m, conflict resolved by a worker");
  });
  it("says nothing extra for a one-round merge without a wait", () => {
    const lines = formatMergeOutcome({ ...base, merged: true, mergeCommit: "c".repeat(40), rounds: 1, waitedMs: 2_000 }).map(plain);
    expect(lines).toContain("    Merged https://github.com/o/r/pull/9 into main (cccccccccccc)");
  });
  it("warns when a merge ran without a merge turn, merged or not", () => {
    const warning = "the merge queue could not be used (EACCES: permission denied); merging without a turn";
    for (const merged of [true, false]) {
      const lines = formatMergeOutcome({ ...base, merged, reason: "x", queueWarning: warning }).map(plain);
      expect(lines).toContain(`    ⚠ ${warning}`);
    }
  });
  it("totals the waiting, the extra rounds and the conflicts in the summary", () => {
    const lines = formatMergeSummary([
      { ...base, merged: true, rounds: 2, waitedMs: 120_000, conflictsResolved: 1 },
      { ...base, goalId: "h", merged: false, reason: "x", kind: "gate_failed", rounds: 1, waitedMs: 60_000 },
    ]).map(plain);
    expect(lines).toContain("    waited 3m for the merge turn · 1 extra round · 1 conflict resolved by a worker");
  });
});
