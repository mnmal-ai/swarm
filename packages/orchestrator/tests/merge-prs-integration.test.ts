import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { SourceControlConfig } from "@mnmal-ai/swarm-types";

/**
 * source_control.merge_prs against a real git remote (a local bare repo) and a
 * fake `gh` that keeps PR state and performs real merges into that remote.
 * git runs for real; only `gh` is replaced.
 */

interface FakePr {
  n: number;
  base: string;
  head: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit?: string;
  comments: string[];
}

const fake = vi.hoisted(() => ({ remote: "", scratch: "", prs: [] as unknown[], failViews: 0, mergeThenFail: false, beforeMerge: undefined as undefined | (() => void), unknownPolls: 0, refuseOnce: undefined as undefined | string, creates: 0, beforeMergeability: undefined as undefined | (() => void) }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = (args: string[], cwd: string) => actual.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const prs = () => fake.prs as FakePr[];
  const findPr = (target: string) =>
    prs().find((p) => target.endsWith(`/pull/${p.n}`) || p.head === target);
  const ghImpl = (args: string[]): string => {
    const [cmd, sub, ...rest] = args;
    if (cmd !== "pr") throw new Error(`fake gh: unsupported ${args.join(" ")}`);
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    if (sub === "create") {
      fake.creates++;
      const base = flag("--base")!;
      const head = flag("--head")!;
      if (prs().some((p) => p.head === head && p.state === "OPEN")) throw new Error("a pull request for branch already exists");
      const pr: FakePr = { n: prs().length + 1, base, head, state: "OPEN", comments: [] };
      prs().push(pr);
      return `https://github.com/test/repo/pull/${pr.n}\n`;
    }
    if (sub === "view") {
      // failViews: the post-merge state reads (`--json state,mergeCommit`) fail; the
      // mergeability read before the merge is not one of them.
      if (fake.failViews > 0 && rest.includes("state,mergeCommit")) {
        fake.failViews--;
        throw new Error("HTTP 502 from api.github.com");
      }
      if (fake.beforeMergeability && rest.includes("mergeable,headRefOid")) {
        const hook = fake.beforeMergeability;
        fake.beforeMergeability = undefined;
        hook();
      }
      const pr = findPr(rest[0]);
      if (!pr) throw new Error("no pull requests found");
      const mergeable = fake.unknownPolls > 0 ? (fake.unknownPolls--, "UNKNOWN") : "MERGEABLE";
      return JSON.stringify({
        url: `https://github.com/test/repo/pull/${pr.n}`,
        state: pr.state,
        baseRefName: pr.base,
        mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
        mergeable,
        headRefOid: run(["rev-parse", `refs/heads/${pr.head}`], fake.remote),
      });
    }
    if (sub === "comment") {
      const pr = findPr(rest[0]);
      if (!pr) throw new Error("no pull requests found");
      pr.comments.push(flag("--body") ?? "");
      return "";
    }
    if (sub === "merge") {
      const pr = findPr(rest[0]);
      if (!pr || pr.state !== "OPEN") throw new Error("pull request is not open");
      if (fake.beforeMerge) {
        const hook = fake.beforeMerge;
        fake.beforeMerge = undefined;
        hook();
      }
      if (fake.refuseOnce) {
        const msg = fake.refuseOnce;
        fake.refuseOnce = undefined;
        throw new Error(msg);
      }
      const pinned = flag("--match-head-commit");
      const head = run(["rev-parse", `refs/heads/${pr.head}`], fake.remote);
      if (pinned && pinned !== head) throw new Error("Head branch was modified. Review and try the merge again.");
      // A real merge commit on the remote's base, as GitHub's --merge makes.
      rmSync(fake.scratch, { recursive: true, force: true });
      actual.execFileSync("git", ["clone", "-q", fake.remote, fake.scratch]);
      run(["-c", "user.name=GitHub", "-c", "user.email=noreply@example.com", "checkout", "-q", pr.base], fake.scratch);
      run(["-c", "user.name=GitHub", "-c", "user.email=noreply@example.com", "merge", "--no-ff", "-m", `Merge pull request #${pr.n}`, `origin/${pr.head}`], fake.scratch);
      run(["push", "-q", "origin", pr.base], fake.scratch);
      pr.state = "MERGED";
      pr.mergeCommit = run(["rev-parse", "HEAD"], fake.scratch);
      if (fake.mergeThenFail) {
        fake.mergeThenFail = false;
        throw new Error("merged, but the follow-up request failed");
      }
      return "";
    }
    throw new Error(`fake gh: unsupported pr ${sub}`);
  };
  return {
    ...actual,
    execFile: vi.fn((cmd: string, args: string[], opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      if (cmd === "gh") {
        try {
          cb(null, ghImpl(args), "");
        } catch (err) {
          cb(err as Error, "", (err as Error).message);
        }
        return undefined as never;
      }
      return actual.execFile(cmd, args, opts as never, cb as never);
    }),
  };
});

import { SourceControlManager } from "../src/source-control/index.js";
import { materializeGoalBranch } from "../src/source-control/stack.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

let root: string;
let repo: string;
let other: string;
const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
let manager: SourceControlManager;

const config: SourceControlConfig = {
  strategy: "remote_pr",
  base_branch: "main",
  branch_prefix: "swarm/",
  git_identity: { name: "Swarm Bot", email: "swarm@example.com" },
};
const skipLabels = ["swarm_merge: false"];
const prs = () => fake.prs as FakePr[];

async function startGoal(goalId: string, files: Record<string, string>): Promise<string> {
  await manager.syncBaseBranch();
  const branch = `swarm/goal-${goalId}`;
  await materializeGoalBranch(repo, branch, "main");
  git(["switch", "-q", branch], repo);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", `work for ${goalId}`], repo);
  return branch;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "swarm-merge-prs-"));
  fake.remote = join(root, "remote.git");
  fake.scratch = join(root, "scratch");
  repo = join(root, "work");
  other = join(root, "other");
  git(["init", "-q", "--bare", "-b", "main", fake.remote], root);
  git(["clone", "-q", fake.remote, repo], root);
  git(["switch", "-q", "-c", "main"], repo);
  writeFileSync(join(repo, "README.md"), "line one\n");
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", "initial"], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);
  git(["clone", "-q", fake.remote, other], root);
  const bus = new SwarmEventBus();
  bus.onAny((name, payload) => events.push({ name, payload: payload as Record<string, unknown> }));
  manager = new SourceControlManager(repo, config, bus);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("merge_prs: merge-as-you-go against a real remote", () => {
  it("merges goal 1, and goal 2 starts from the updated base", async () => {
    const b1 = await startGoal("g1", { "a.txt": "a\n" });
    const r1 = await manager.mergeGoal(
      { goalId: "g1", goalDescription: "Add a", branch: b1, verdicts: ["approved", "completed_with_notes"], labels: [] },
      { gate: { command: "test -f a.txt" }, skipLabels },
    );
    expect(r1.merged).toBe(true);
    expect(r1.prUrl).toBe("https://github.com/test/repo/pull/1");
    expect(r1.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(prs()[0]).toMatchObject({ base: "main", head: b1, state: "MERGED" });
    // The remote's main has the goal's work, and the work repo is back on main at the remote.
    expect(git(["show", "origin/main:a.txt"], repo)).toBe("a");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(git(["rev-parse", "main"], repo)).toBe(git(["rev-parse", "origin/main"], repo));
    expect(events.some((e) => e.name === "source_control:pr_merged" && e.payload.goalId === "g1")).toBe(true);
    expect(events.some((e) => e.name === "source_control:merge_gate_finished" && e.payload.passed === true)).toBe(true);

    const b2 = await startGoal("g2", { "b.txt": "b\n" });
    // Goal 2 branched from main as merged: goal 1's file is there.
    expect(git(["show", `${b2}:a.txt`], repo)).toBe("a");
    expect(git(["merge-base", "--is-ancestor", r1.mergeCommit as string, b2], repo)).toBe("");
  });

  it("leaves a PR open when the gate fails, and the next goal still runs from the base", async () => {
    const b2 = "swarm/goal-g2";
    const before = git(["rev-parse", "origin/main"], repo);
    const r2 = await manager.mergeGoal(
      { goalId: "g2", goalDescription: "Add b", branch: b2, verdicts: ["approved"] },
      { gate: { command: "echo broken; exit 3" }, skipLabels },
    );
    expect(r2.merged).toBe(false);
    expect(r2.reason).toBe("the merge gate failed (exit 3); its output is in the run log");
    expect(r2.gate?.tail).toContain("broken");
    const pr = prs().find((p) => p.head === b2)!;
    expect(pr.state).toBe("OPEN");
    expect(pr.comments[0]).toContain("the merge gate failed (exit 3)");
    expect(pr.comments[0]).not.toContain("broken");
    git(["fetch", "-q", "origin"], repo);
    expect(git(["rev-parse", "origin/main"], repo)).toBe(before);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(git(["status", "--porcelain"], repo)).toBe("");
    expect(events.some((e) => e.name === "source_control:merge_skipped" && e.payload.goalId === "g2")).toBe(true);

    // The next goal runs, from main without goal 2's work, and merges.
    const b3 = await startGoal("g3", { "c.txt": "c\n" });
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    const r3 = await manager.mergeGoal(
      { goalId: "g3", goalDescription: "Add c", branch: b3, verdicts: ["completed_with_deferrals"] },
      { gate: { command: "test -f c.txt && test -f a.txt" }, skipLabels },
    );
    expect(r3.merged).toBe(true);
    expect(git(["show", "origin/main:c.txt"], repo)).toBe("c");
  });

  it("leaves a PR open when the branch conflicts with the base", async () => {
    const b4 = await startGoal("g4", { "README.md": "line one, by goal 4\n" });
    // Someone else changes the same line on main meanwhile.
    git(["pull", "-q", "origin", "main"], other);
    writeFileSync(join(other, "README.md"), "line one, by someone else\n");
    git(["add", "-A"], other);
    git([...ID, "commit", "-q", "-m", "elsewhere"], other);
    git(["push", "-q", "origin", "main"], other);

    const r4 = await manager.mergeGoal(
      { goalId: "g4", goalDescription: "Edit readme", branch: b4, verdicts: ["approved"] },
      { gate: { command: "true" }, skipLabels },
    );
    expect(r4.merged).toBe(false);
    expect(r4.reason).toBe("the branch conflicts with main; a person needs to resolve it");
    expect(r4.gate).toBeUndefined();
    expect(prs().find((p) => p.head === b4)?.state).toBe("OPEN");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(git(["status", "--porcelain"], repo)).toBe("");
    // The base the next goal starts from is the remote's, including the other change.
    expect(git(["show", "main:README.md"], repo)).toBe("line one, by someone else");
  });

  it("leaves a PR open for a skip label, without running the gate", async () => {
    const b5 = await startGoal("g5", { "d.txt": "d\n" });
    const r5 = await manager.mergeGoal(
      { goalId: "g5", goalDescription: "Spec", branch: b5, verdicts: ["approved"], labels: ["Feature", "Swarm_Merge : false"] },
      { gate: { command: "exit 99" }, skipLabels },
    );
    expect(r5.merged).toBe(false);
    // The comment names the configured label, not the card's own text.
    expect(r5.reason).toBe('the card is labelled "swarm_merge: false", so a person merges it');
    expect(r5.gate).toBeUndefined();
    expect(prs().find((p) => p.head === b5)?.state).toBe("OPEN");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
  });

  it("leaves a PR open when a task was not reviewed", async () => {
    const b6 = await startGoal("g6", { "e.txt": "e\n" });
    const r6 = await manager.mergeGoal(
      { goalId: "g6", goalDescription: "Partly reviewed", branch: b6, verdicts: ["approved", "skipped"] },
      { gate: { command: "true" }, skipLabels },
    );
    expect(r6.merged).toBe(false);
    expect(r6.reason).toBe("1 of 2 task(s) did not pass review (skipped)");
  });

  it("finds the open PR a previous attempt left, instead of failing to open one", async () => {
    // g6's PR is open; a re-run of the same goal now passes.
    const r = await manager.mergeGoal(
      { goalId: "g6", goalDescription: "Partly reviewed", branch: "swarm/goal-g6", verdicts: ["approved"] },
      { gate: { command: "test -f e.txt" }, skipLabels },
    );
    expect(r.merged).toBe(true);
    expect(r.prUrl).toBe(`https://github.com/test/repo/pull/${prs().find((p) => p.head === "swarm/goal-g6")!.n}`);
  });

  it("merges an advanced base into the branch as git_identity, then merges the PR", async () => {
    const b7 = await startGoal("g7", { "f.txt": "f\n" });
    // The base moves on under the goal, in a file the goal does not touch.
    git(["pull", "-q", "origin", "main"], other);
    writeFileSync(join(other, "other.txt"), "other\n");
    git(["add", "-A"], other);
    git([...ID, "commit", "-q", "-m", "unrelated change"], other);
    git(["push", "-q", "origin", "main"], other);

    const r7 = await manager.mergeGoal(
      { goalId: "g7", goalDescription: "Add f", branch: b7, verdicts: ["approved"] },
      // The gate sees both the goal's work and the base's new commit.
      { gate: { command: "test -f f.txt && test -f other.txt" }, skipLabels },
    );
    expect(r7.merged).toBe(true);
    const merge = git(["log", "-1", "--merges", "--format=%an <%ae>|%cn <%ce>", "origin/swarm/goal-g7"], repo);
    expect(merge).toBe("Swarm Bot <swarm@example.com>|Swarm Bot <swarm@example.com>");
    expect(git(["show", "origin/main:f.txt"], repo)).toBe("f");
  });
  it("reports a merge GitHub completed even when the merge call errors and the first state reads fail", async () => {
    const b8 = await startGoal("g8", { "g.txt": "g\n" });
    fake.mergeThenFail = true;
    fake.failViews = 1; // the first `pr view` after the merge fails; a retry succeeds
    const r8 = await manager.mergeGoal(
      { goalId: "g8", goalDescription: "Add g", branch: b8, verdicts: ["approved"] },
      { gate: { command: "test -f g.txt" }, skipLabels },
    );
    expect(r8.merged).toBe(true);
    expect(prs().find((p) => p.head === b8)?.comments).toEqual([]);
    expect(git(["show", "origin/main:g.txt"], repo)).toBe("g");
  });

  it("never claims a refusal when GitHub's answer can't be read", async () => {
    const b9 = await startGoal("g9", { "h.txt": "h\n" });
    fake.failViews = 3;
    const r9 = await manager.mergeGoal(
      { goalId: "g9", goalDescription: "Add h", branch: b9, verdicts: ["approved"] },
      { gate: { command: "true" }, skipLabels },
    );
    expect(r9.merged).toBe(false);
    expect(r9.reason).toBe("swarm could not read the pull request's state after merging; check it by hand");
    expect(r9.error).toContain("HTTP 502");
  });

  it("leaves a PR open when its head moves after the gated commit", async () => {
    const b10 = await startGoal("g10", { "i.txt": "i\n" });
    // Simulate a push that lands between swarm's push and its merge: the
    // remote's head moves to a commit the gate never ran on.
    fake.beforeMerge = () => {
      git(["fetch", "-q", "origin"], other);
      git(["switch", "-q", "-C", "sneak", `origin/${b10}`], other);
      writeFileSync(join(other, "sneak.txt"), "x\n");
      git(["add", "-A"], other);
      git([...ID, "commit", "-q", "-m", "sneak"], other);
      git(["push", "-q", "origin", `sneak:${b10}`], other);
    };
    const r10 = await manager.mergeGoal(
      { goalId: "g10", goalDescription: "Add i", branch: b10, verdicts: ["approved"] },
      { gate: { command: "test -f i.txt" }, skipLabels },
    );
    expect(r10.merged).toBe(false);
    expect(r10.reason).toBe("the pull request's branch changed after the gate ran; a person needs to check it");
    expect(r10.kind).toBe("head_changed");
    expect(r10.error).toContain("Head branch was modified");
    expect(prs().find((p) => p.head === b10)?.state).toBe("OPEN");
    git(["fetch", "-q", "origin"], repo);
    expect(() => git(["show", "origin/main:sneak.txt"], repo)).toThrow();
  });
  it("does not reuse an open PR into another base", async () => {
    const b11 = await startGoal("g11", { "j.txt": "j\n" });
    git(["push", "-q", "origin", b11], repo);
    // A stale PR from an earlier setup targets another branch.
    prs().push({ n: prs().length + 1, base: "release", head: b11, state: "OPEN", comments: [] });
    const r11 = await manager.mergeGoal(
      { goalId: "g11", goalDescription: "Add j", branch: b11, verdicts: ["approved"] },
      { gate: { command: "true" }, skipLabels },
    );
    expect(r11.merged).toBe(false);
    expect(r11.reason).toBe(`no pull request could be opened for ${b11}`);
    expect(prs().filter((p) => p.head === b11).map((p) => p.state)).toEqual(["OPEN"]);
  });
});

describe("merge_prs: rounds", () => {
  /** A commit pushed to the remote's main from the other clone, as another run's merge would. */
  const moveBase = (file: string) => {
    git(["fetch", "-q", "origin", "main"], other);
    git(["checkout", "-q", "-B", "main", "origin/main"], other);
    writeFileSync(join(other, file), `${file}\n`);
    git(["add", "-A"], other);
    git([...ID, "commit", "-q", "-m", `move base: ${file}`], other);
    git(["push", "-q", "origin", "main"], other);
  };

  it("gates again when the base moves during the gate, then merges what it gated", async () => {
    const b = await startGoal("r1", { "r1.txt": "r1\n" });
    // The gate moves the base the first time it runs, as a merge by another run would.
    const marker = join(root, "r1-gated-once");
    const gate = { command: `if [ ! -f ${marker} ]; then touch ${marker}; cd ${other} && git fetch -q origin main && git checkout -q -B main origin/main && echo x > moved.txt && git add -A && git -c user.name=T -c user.email=t@e commit -q -m moved && git push -q origin main; fi` };
    events.length = 0;
    const r = await manager.mergeGoal({ goalId: "r1", goalDescription: "r1", branch: b, verdicts: ["approved"] }, { gate, skipLabels });
    const gates = events.filter((e) => e.name === "source_control:merge_gate_finished").length;
    expect(r.merged).toBe(true);
    expect(r.rounds).toBe(2);
    expect(gates).toBe(2);
    expect(events.some((e) => e.name === "source_control:merge_round" && e.payload.reason === "base_moved" && e.payload.round === 2)).toBe(true);
    // What landed contains the moved base: it was gated with it.
    expect(git(["show", "origin/main:moved.txt"], repo)).toBe("x");
  });

  it("goes round again when GitHub refuses because the base was modified", async () => {
    const b = await startGoal("r2", { "r2.txt": "r2\n" });
    fake.beforeMerge = () => moveBase("r2-moved.txt");
    fake.refuseOnce = "Base branch was modified. Review and try the merge again.";
    events.length = 0;
    const r = await manager.mergeGoal({ goalId: "r2", goalDescription: "r2", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels });
    expect(r.merged).toBe(true);
    expect(r.rounds).toBe(2);
    expect(events.some((e) => e.name === "source_control:merge_round" && e.payload.reason === "refused")).toBe(true);
  });

  it("leaves the PR open as refused, without another gate, when GitHub refuses and the base did not move (branch protection)", async () => {
    const b = await startGoal("r8", { "r8.txt": "r8\n" });
    fake.refuseOnce = "Pull request test/repo#12 is not mergeable: the base branch policy prohibits the merge.";
    events.length = 0;
    const r = await manager.mergeGoal({ goalId: "r8", goalDescription: "r8", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels });
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("refused");
    expect(r.rounds).toBe(1);
    expect(r.reason).toBe("GitHub refused to merge the pull request");
    expect(r.error).toContain("base branch policy prohibits the merge");
    expect(events.filter((e) => e.name === "source_control:merge_gate_finished")).toHaveLength(1);
  });

  it("never merges when the remote base cannot be read after the gate", async () => {
    const b = await startGoal("r9", { "r9.txt": "r9\n" });
    // The push still reaches the remote (its push URL); reading the base (ls-remote, the fetch URL) fails.
    const gate = { command: `git remote set-url --push origin ${fake.remote} && git remote set-url origin ${join(root, "gone.git")}` };
    try {
      const r = await manager.mergeGoal({ goalId: "r9", goalDescription: "r9", branch: b, verdicts: ["approved"] }, { gate, skipLabels });
      expect(r.merged).toBe(false);
      expect(r.kind).toBe("refused");
      expect(r.reason).toBe("swarm could not read main on origin to check it had not moved since the gate; swarm tries again later");
      expect(prs().find((p) => p.head === b)!.state).toBe("OPEN");
    } finally {
      git(["remote", "set-url", "origin", fake.remote], repo);
      git(["config", "--unset", "remote.origin.pushurl"], repo);
      git(["switch", "-q", "main"], repo);
    }
  });

  it("leaves the PR open as base_kept_moving after max_rounds", async () => {
    const b = await startGoal("r3", { "r3.txt": "r3\n" });
    // Every round, the base moves while the gate runs.
    const r = await manager.mergeGoal(
      { goalId: "r3", goalDescription: "r3", branch: b, verdicts: ["approved"] },
      { gate: { command: `cd ${other} && git fetch -q origin main && git checkout -q -B main origin/main && echo $RANDOM >> churn.txt && git add -A && git -c user.name=T -c user.email=t@e commit -q -m churn && git push -q origin main` }, skipLabels, maxRounds: 2 },
    );
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("base_kept_moving");
    expect(r.reason).toBe("main kept moving while the gate ran (2 rounds); swarm tries again later");
    expect(prs().find((p) => p.head === b)!.state).toBe("OPEN");
  });

  it("waits while GitHub is still computing mergeability", async () => {
    const b = await startGoal("r4", { "r4.txt": "r4\n" });
    fake.unknownPolls = 2;
    const r = await manager.mergeGoal({ goalId: "r4", goalDescription: "r4", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels, mergeablePollMs: 10 });
    expect(r.merged).toBe(true);
    expect(fake.unknownPolls).toBe(0);
  });

  it("leaves the PR open as head_changed (finished), without another round, when its head changed after the gate", async () => {
    const b = await startGoal("r5", { "r5.txt": "r5\n" });
    fake.beforeMerge = () => {
      // A person pushes to the PR branch after the gate: GitHub's head is not the gated head.
      git(["fetch", "-q", "origin", b], other);
      git(["switch", "-q", "-c", "r5-person", `origin/${b}`], other);
      writeFileSync(join(other, "person.txt"), "p\n");
      git(["add", "-A"], other);
      git([...ID, "commit", "-q", "-m", "a person's change"], other);
      git(["push", "-q", "origin", `r5-person:${b}`], other);
      git(["switch", "-q", "main"], other);
    };
    const r = await manager.mergeGoal({ goalId: "r5", goalDescription: "r5", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels });
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("head_changed");
    expect(r.rounds).toBe(1);
  });

  it("leaves the PR open as head_changed when the host already sees another head before the merge", async () => {
    const b = await startGoal("r10", { "r10.txt": "r10\n" });
    fake.beforeMergeability = () => {
      git(["fetch", "-q", "origin", b], other);
      git(["switch", "-q", "-c", "r10-person", `origin/${b}`], other);
      writeFileSync(join(other, "person10.txt"), "p\n");
      git(["add", "-A"], other);
      git([...ID, "commit", "-q", "-m", "a person's change"], other);
      git(["push", "-q", "origin", `r10-person:${b}`], other);
      git(["switch", "-q", "main"], other);
    };
    const r = await manager.mergeGoal({ goalId: "r10", goalDescription: "r10", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels });
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("head_changed");
    expect(r.rounds).toBe(1);
  });

  it("takes and releases a turn from the queue around the merge", async () => {
    const calls: string[] = [];
    const queue = {
      repoKey: "local/x#main",
      take: async () => {
        calls.push("take");
        return { waitedMs: 7, release: async () => { calls.push("release"); } };
      },
    };
    const b = await startGoal("r6", { "r6.txt": "r6\n" });
    const r = await manager.mergeGoal({ goalId: "r6", goalDescription: "r6", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels, queue, project: "p" });
    expect(r.merged).toBe(true);
    expect(r.waitedMs).toBe(7);
    expect(calls).toEqual(["take", "release"]);
  });

  it("merges without a turn, and says so once, when the queue cannot be used", async () => {
    const queue = { repoKey: "local/x#main", take: async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } };
    const b = await startGoal("r7", { "r7.txt": "r7\n" });
    events.length = 0;
    const r = await manager.mergeGoal({ goalId: "r7", goalDescription: "r7", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels, queue, project: "p" });
    expect(r.merged).toBe(true);
    expect(r.queueWarning).toBe("the merge queue could not be used (EACCES: permission denied); merging without a turn");
    expect(events.some((e) => e.name === "source_control:merge_waiting")).toBe(false);
  });
});

describe("merge_prs: conflicts", () => {
  /** main and the goal branch both change README.md's one line. */
  async function conflicting(id: string): Promise<string> {
    const b = await startGoal(id, { "README.md": `goal ${id}\n` });
    git(["fetch", "-q", "origin", "main"], other);
    git(["checkout", "-q", "-B", "main", "origin/main"], other);
    writeFileSync(join(other, "README.md"), `base for ${id}\n`);
    git(["add", "-A"], other);
    git([...ID, "commit", "-q", "-m", `base change for ${id}`], other);
    git(["push", "-q", "origin", "main"], other);
    return b;
  }

  it("hands the conflict to the resolver with the files and the base commits, then merges", async () => {
    const b = await conflicting("c1");
    let seen: Record<string, unknown> | undefined;
    events.length = 0;
    const r = await manager.mergeGoal(
      { goalId: "c1", goalDescription: "c1", branch: b, verdicts: ["approved"] },
      {
        gate: { command: "grep -q 'goal c1' README.md && grep -q 'base for c1' README.md" },
        skipLabels,
        resolveConflict: async (ctx) => {
          seen = ctx as unknown as Record<string, unknown>;
          // A good resolution keeps both sides.
          writeFileSync(join(repo, "README.md"), "goal c1\nbase for c1\n");
          git(["add", "README.md"], repo);
          git([...ID, "commit", "-q", "--no-edit"], repo);
          return { resolved: true };
        },
      },
    );
    expect(r.merged).toBe(true);
    expect(r.conflictsResolved).toBe(1);
    expect(seen?.files).toEqual(["README.md"]);
    expect((seen?.baseCommits as Array<{ subject: string }>)[0].subject).toBe("base change for c1");
    expect(events.some((e) => e.name === "source_control:merge_conflict_handed_back")).toBe(true);
    expect(git(["show", "origin/main:README.md"], repo)).toBe("goal c1\nbase for c1");
  });

  it("leaves the PR open as conflict, with the branch untouched, when the resolution is not approved", async () => {
    const b = await conflicting("c2");
    const before = git(["rev-parse", b], repo);
    const r = await manager.mergeGoal(
      { goalId: "c2", goalDescription: "c2", branch: b, verdicts: ["approved"] },
      {
        gate: { command: "true" },
        skipLabels,
        resolveConflict: async () => {
          // The worker committed something the reviewer then rejected.
          writeFileSync(join(repo, "README.md"), "only one side\n");
          git(["add", "README.md"], repo);
          git([...ID, "commit", "-q", "--no-edit"], repo);
          return { resolved: false, reason: "the resolution was not approved (rejected)" };
        },
      },
    );
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("conflict");
    expect(r.reason).toBe("the conflict with main was not resolved: the resolution was not approved (rejected)");
    expect(git(["rev-parse", b], repo)).toBe(before);
  });

  it("leaves the PR open as conflict when the resolver leaves the merge unfinished", async () => {
    const b = await conflicting("c3");
    const r = await manager.mergeGoal(
      { goalId: "c3", goalDescription: "c3", branch: b, verdicts: ["approved"] },
      { gate: { command: "true" }, skipLabels, resolveConflict: async () => ({ resolved: true }) },
    );
    expect(r.kind).toBe("conflict");
    expect(r.reason).toBe("the conflict with main was not resolved: the worker left the merge unfinished");
  });

  it("does not count a resolution that leaves changes uncommitted, and clears what the worker left", async () => {
    const b = await conflicting("c6");
    const before = git(["rev-parse", b], repo);
    const r = await manager.mergeGoal(
      { goalId: "c6", goalDescription: "c6", branch: b, verdicts: ["approved"] },
      {
        gate: { command: "true" },
        skipLabels,
        resolveConflict: async () => {
          writeFileSync(join(repo, "README.md"), "goal c6\nbase for c6\n");
          git(["add", "README.md"], repo);
          git([...ID, "commit", "-q", "--no-edit"], repo);
          // Then a fix and a new file the push would never carry.
          writeFileSync(join(repo, "README.md"), "goal c6\nbase for c6\nfixed later\n");
          writeFileSync(join(repo, "stray.txt"), "new\n");
          return { resolved: true };
        },
      },
    );
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("conflict");
    expect(r.reason).toBe("the conflict with main was not resolved: the worker left changes uncommitted");
    expect(git(["rev-parse", b], repo)).toBe(before);
    expect(git(["status", "--porcelain", "--untracked-files=all"], repo)).toBe("");
    expect(existsSync(join(repo, "stray.txt"))).toBe(false);
  });

  it("puts back a branch the worker moved off, without touching the branch it moved to", async () => {
    const b = await conflicting("c7");
    const before = git(["rev-parse", b], repo);
    const mainBefore = git(["rev-parse", "main"], repo);
    const r = await manager.mergeGoal(
      { goalId: "c7", goalDescription: "c7", branch: b, verdicts: ["approved"] },
      {
        gate: { command: "true" },
        skipLabels,
        resolveConflict: async () => {
          writeFileSync(join(repo, "README.md"), "goal c7\nbase for c7\n");
          git(["add", "README.md"], repo);
          git([...ID, "commit", "-q", "--no-edit"], repo);
          git(["switch", "-q", "main"], repo);
          return { resolved: true };
        },
      },
    );
    expect(r.merged).toBe(false);
    expect(r.reason).toBe("the conflict with main was not resolved: the worker moved off the branch");
    expect(git(["rev-parse", b], repo)).toBe(before);
    // main moved only forward, to the remote's main, never to the goal's commits.
    expect(git(["merge-base", "--is-ancestor", mainBefore, "main"], repo)).toBe("");
    expect(() => git(["merge-base", "--is-ancestor", before, "main"], repo)).toThrow();
  });

  it("leaves the PR open as conflict without a resolver, as before", async () => {
    const b = await conflicting("c4");
    const r = await manager.mergeGoal({ goalId: "c4", goalDescription: "c4", branch: b, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels });
    expect(r.kind).toBe("conflict");
    expect(r.reason).toBe("the branch conflicts with main; a person needs to resolve it");
    // A kind swarm retries says how to stop it.
    expect(prs().find((p) => p.head === b)!.comments).toEqual([
      "Swarm left this pull request open: the branch conflicts with main; a person needs to resolve it. Swarm tries again on a later run; close this pull request to stop it.",
    ]);
  });

  it("stops handing back after max_conflict_rounds", async () => {
    const b = await conflicting("c5");
    let calls = 0;
    const r = await manager.mergeGoal(
      { goalId: "c5", goalDescription: "c5", branch: b, verdicts: ["approved"] },
      { gate: { command: "true" }, skipLabels, maxConflictRounds: 0, resolveConflict: async () => { calls++; return { resolved: true }; } },
    );
    expect(calls).toBe(0);
    expect(r.kind).toBe("conflict");
  });
});

describe("merge_prs: retrying a pull request an earlier attempt left open", () => {
  /** A goal branch pushed, with a PR in `state` as a person left it. */
  async function leftOpen(id: string, state: FakePr["state"]): Promise<{ branch: string; prUrl: string }> {
    const branch = await startGoal(id, { [`${id}.txt`]: `${id}\n` });
    git(["push", "-q", "origin", branch], repo);
    const pr: FakePr = { n: prs().length + 1, base: "main", head: branch, state, comments: [] };
    if (state === "MERGED") pr.mergeCommit = git(["rev-parse", branch], repo);
    prs().push(pr);
    git(["switch", "-q", "main"], repo);
    return { branch, prUrl: `https://github.com/test/repo/pull/${pr.n}` };
  }

  it("leaves a pull request a person closed alone: no new PR, no comment, finished as closed", async () => {
    const { branch, prUrl } = await leftOpen("p1", "CLOSED");
    const creates = fake.creates;
    const r = await manager.mergeGoal(
      { goalId: "p1", goalDescription: "p1", branch, verdicts: ["approved"], prUrl, lastLeftOpenReason: "the branch conflicts with main; a person needs to resolve it" },
      { gate: { command: "true" }, skipLabels },
    );
    expect(r.merged).toBe(false);
    expect(r.kind).toBe("closed");
    expect(r.prUrl).toBe(prUrl);
    expect(fake.creates).toBe(creates);
    expect(prs().filter((p) => p.head === branch).map((p) => p.state)).toEqual(["CLOSED"]);
    expect(prs().find((p) => p.head === branch)!.comments).toEqual([]);
    git(["fetch", "-q", "origin"], repo);
    expect(() => git(["show", `origin/main:p1.txt`], repo)).toThrow();
  });

  it("records a pull request a person merged as merged, without opening another", async () => {
    const { branch, prUrl } = await leftOpen("p2", "MERGED");
    const creates = fake.creates;
    events.length = 0;
    const r = await manager.mergeGoal(
      { goalId: "p2", goalDescription: "p2", branch, verdicts: ["approved"], prUrl },
      { gate: { command: "false" }, skipLabels },
    );
    expect(r.merged).toBe(true);
    expect(r.prUrl).toBe(prUrl);
    expect(r.mergeCommit).toBe(prs().find((p) => p.head === branch)!.mergeCommit);
    expect(fake.creates).toBe(creates);
    expect(events.some((e) => e.name === "source_control:pr_merged" && e.payload.goalId === "p2")).toBe(true);
    expect(events.some((e) => e.name === "source_control:merge_gate_started")).toBe(false);
  });

  it("comments only when the reason it is left open changed", async () => {
    const { branch, prUrl } = await leftOpen("p4", "OPEN");
    const reason = "the merge gate failed (exit 1); its output is in the run log";
    const goal = { goalId: "p4", goalDescription: "p4", branch, verdicts: ["approved"], prUrl };
    await manager.mergeGoal({ ...goal, lastLeftOpenReason: reason }, { gate: { command: "false" }, skipLabels });
    expect(prs().find((p) => p.head === branch)!.comments).toEqual([]);
    await manager.mergeGoal({ ...goal, lastLeftOpenReason: "the branch conflicts with main; a person needs to resolve it" }, { gate: { command: "false" }, skipLabels });
    expect(prs().find((p) => p.head === branch)!.comments).toEqual([`Swarm left this pull request open: ${reason}.`]);
  });

  it("merges the recorded open pull request without trying to open another", async () => {
    const { branch, prUrl } = await leftOpen("p3", "OPEN");
    const creates = fake.creates;
    const r = await manager.mergeGoal(
      { goalId: "p3", goalDescription: "p3", branch, verdicts: ["approved"], prUrl },
      { gate: { command: "test -f p3.txt" }, skipLabels },
    );
    expect(r.merged).toBe(true);
    expect(r.prUrl).toBe(prUrl);
    expect(fake.creates).toBe(creates);
  });
});
