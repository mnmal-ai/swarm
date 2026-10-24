import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { ProjectConfig, SourceControlConfig, TaskBackend } from "@mnmal-ai/swarm-types";

/**
 * A run that finished goals but could not publish them leaves them in its
 * checkpoint, and the next run publishes them: stacked PRs in their original
 * order (joined by the next run's own goals), or merge-as-you-go with the
 * same eligibility, gate and skip rules. Nothing is done twice. Real git
 * against a local bare remote; only `gh` is faked, keeping PR state.
 */

interface FakePr {
  n: number;
  base: string;
  head: string;
  body: string;
  state: "OPEN" | "MERGED";
  mergeCommit?: string;
  comments: string[];
}

const fake = vi.hoisted(() => ({ remote: "", scratch: "", prs: [] as unknown[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = (args: string[], cwd: string) => actual.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const prs = () => fake.prs as FakePr[];
  const findPr = (target: string) => prs().find((p) => target.endsWith(`/pull/${p.n}`) || p.head === target);
  const ghImpl = (args: string[]): string => {
    const [cmd, sub, ...rest] = args;
    if (cmd !== "pr") throw new Error(`fake gh: unsupported ${args.join(" ")}`);
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    if (sub === "create") {
      const base = flag("--base")!;
      const head = flag("--head")!;
      if (prs().some((p) => p.head === head && p.state === "OPEN")) throw new Error("a pull request for branch already exists");
      const pr: FakePr = { n: prs().length + 1, base, head, body: flag("--body") ?? "", state: "OPEN", comments: [] };
      prs().push(pr);
      return `https://github.com/test/repo/pull/${pr.n}\n`;
    }
    if (sub === "view") {
      const pr = findPr(rest[0]);
      if (!pr) throw new Error("no pull requests found");
      return JSON.stringify({
        url: `https://github.com/test/repo/pull/${pr.n}`,
        state: pr.state,
        baseRefName: pr.base,
        mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
        // GitHub always reports mergeability; swarm waits while it is UNKNOWN.
        mergeable: pr.state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
      });
    }
    if (sub === "comment") {
      findPr(rest[0])?.comments.push(flag("--body") ?? "");
      return "";
    }
    if (sub === "merge") {
      const pr = findPr(rest[0]);
      if (!pr || pr.state !== "OPEN") throw new Error("pull request is not open");
      rmSync(fake.scratch, { recursive: true, force: true });
      actual.execFileSync("git", ["clone", "-q", fake.remote, fake.scratch]);
      const as = ["-c", "user.name=GitHub", "-c", "user.email=noreply@example.com"];
      run([...as, "checkout", "-q", pr.base], fake.scratch);
      run([...as, "merge", "--no-ff", "-m", `Merge pull request #${pr.n}`, `origin/${pr.head}`], fake.scratch);
      run(["push", "-q", "origin", pr.base], fake.scratch);
      pr.state = "MERGED";
      pr.mergeCommit = run(["rev-parse", "HEAD"], fake.scratch);
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

import { Orchestrator } from "../src/orchestrator/index.js";
import { SourceControlManager } from "../src/source-control/index.js";
import { materializeGoalBranch } from "../src/source-control/stack.js";
import {
  completedFromPublication,
  mergeableFromPublication,
  pendingPublications,
  resumeStackHead,
  trackGoalPublications,
} from "../src/source-control/publications.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const prs = () => fake.prs as FakePr[];
const ON = { autoPush: true, openPr: true };
const LEFT = [{ task: "Build the settings screen", items: ["Check it on a physical phone"] }];

const projectConfig = { project: "p", swarm_path: "/tmp/swarm", trust_level: "medium", concurrency: { max_workers: 1 }, task_backend: "local", created: "2026-01-01T00:00:00Z" } as unknown as ProjectConfig;
const taskBackend = {} as TaskBackend;
const checkpointFields = (currentGoal: string | null) => ({
  session_id: "s", swarm_version: "HEAD", project: "p", current_goal: currentGoal, current_task: null,
  completed_tasks: [], pending_tasks: [], skipped_tasks: [], blocked: false,
});

/** One `swarm run`: an orchestrator on the shared checkpoint, and its event bus, tracked. */
async function startRun(checkpointDir: string, repo: string, config: SourceControlConfig) {
  const orchestrator = new Orchestrator({ projectConfig, backend: taskBackend, checkpointPath: checkpointDir });
  const checkpoint = await orchestrator.loadCheckpoint();
  const bus = new SwarmEventBus();
  trackGoalPublications(bus, orchestrator);
  return { orchestrator, checkpoint, manager: new SourceControlManager(repo, config, bus) };
}

function setUpRepo(prefix: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fake.remote = join(root, "remote.git");
  fake.scratch = join(root, "scratch");
  fake.prs = [];
  const repo = join(root, "work");
  git(["init", "-q", "--bare", "-b", "main", fake.remote], root);
  git(["clone", "-q", fake.remote, repo], root);
  git(["switch", "-q", "-c", "main"], repo);
  writeFileSync(join(repo, "README.md"), "line one\n");
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", "initial"], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);
  return { root, repo };
}

/** A goal's branch off `base`, with one commit. */
async function finishGoal(repo: string, branch: string, base: string, file: string): Promise<void> {
  await materializeGoalBranch(repo, branch, base);
  git(["switch", "-q", branch], repo);
  writeFileSync(join(repo, file), `${file}\n`);
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", `work: ${file}`], repo);
}

describe("stacked PRs: a resumed run publishes the earlier run's goals first", () => {
  let root: string;
  let repo: string;
  let checkpointDir: string;
  const config: SourceControlConfig = { strategy: "remote_pr", stack_prs: true, base_branch: "main", branch_prefix: "swarm/" };

  beforeAll(() => {
    ({ root, repo } = setUpRepo("swarm-resume-stack-"));
    checkpointDir = join(root, "checkpoints");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("run 1 finishes two goals and stops mid-goal, with nothing published", async () => {
    const run1 = await startRun(checkpointDir, repo, config);
    await finishGoal(repo, "swarm/goal-g1", "main", "one.txt");
    run1.orchestrator.recordGoalPublication({ goal_id: "g1", description: "Goal one", mode: "stack", branch: "swarm/goal-g1", base: "main", pushed: false, merged: false });
    await finishGoal(repo, "swarm/goal-g2", "swarm/goal-g1", "two.txt");
    run1.orchestrator.recordGoalPublication({ goal_id: "g2", description: "Goal two", mode: "stack", branch: "swarm/goal-g2", base: "swarm/goal-g1", left_for_person: LEFT, pushed: false, merged: false });
    // Goal three is in flight on top of goal two, its work half-done and uncommitted.
    await finishGoal(repo, "swarm/goal-g3", "swarm/goal-g2", "three.txt");
    writeFileSync(join(repo, "README.md"), "edited by an unfinished task\n");

    // The remote is unreachable, so the end-of-run push fails.
    git(["remote", "set-url", "origin", join(root, "missing.git")], repo);
    await expect(run1.manager.onGoalComplete(pendingPublications(run1.orchestrator.getGoalPublications(), "stack", ON).map(completedFromPublication)))
      .rejects.toThrow(/failed to push/);
    await run1.orchestrator.saveCheckpoint(checkpointFields("g3"));

    expect(prs()).toHaveLength(0);
    expect(run1.orchestrator.getGoalPublications().every((r) => !r.pushed && !r.pr_url)).toBe(true);
  });

  it("run 2 stacks its goals on them and publishes all of them, in order, from a dirty tree", async () => {
    git(["remote", "set-url", "origin", fake.remote], repo);
    const run2 = await startRun(checkpointDir, repo, config);
    const earlier = pendingPublications(run2.orchestrator.getGoalPublications(), "stack", ON);
    expect(earlier.map((r) => r.goal_id)).toEqual(["g1", "g2"]);
    const head = resumeStackHead(run2.orchestrator.getGoalPublications(), { interrupted: run2.checkpoint?.current_goal != null, settings: ON });
    expect(head).toBe("swarm/goal-g2");

    // The in-flight goal resumes where it was: its branch is kept, not reset.
    await materializeGoalBranch(repo, "swarm/goal-g3", head!);
    expect(git(["show", "swarm/goal-g3:three.txt"], repo)).toBe("three.txt");
    run2.orchestrator.recordGoalPublication({ goal_id: "g3", description: "Goal three", mode: "stack", branch: "swarm/goal-g3", base: head!, pushed: false, merged: false });

    // The tree is still dirty: no session branch, no checkout, nothing refuses.
    const result = await run2.manager.onGoalComplete([
      ...earlier.map(completedFromPublication),
      { goalId: "g3", goalDescription: "Goal three", base: head! },
    ]);
    await run2.orchestrator.saveCheckpoint(checkpointFields(null));

    expect(result.goals.map((g) => [g.goalId, g.base, g.pushed])).toEqual([
      ["g1", "main", true],
      ["g2", "swarm/goal-g1", true],
      ["g3", "swarm/goal-g2", true],
    ]);
    expect(prs().map((p) => [p.head, p.base])).toEqual([
      ["swarm/goal-g1", "main"],
      ["swarm/goal-g2", "swarm/goal-g1"],
      ["swarm/goal-g3", "swarm/goal-g2"],
    ]);
    expect(prs()[1].body).toContain("## Left for a person");
    expect(prs()[1].body).toContain("**Build the settings screen**\n- Check it on a physical phone");
    expect(prs()[0].body).not.toContain("Left for a person");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("edited by an unfinished task\n");
    expect(run2.orchestrator.getGoalPublications().map((r) => [r.goal_id, r.pushed, r.pr_url])).toEqual([
      ["g1", true, "https://github.com/test/repo/pull/1"],
      ["g2", true, "https://github.com/test/repo/pull/2"],
      ["g3", true, "https://github.com/test/repo/pull/3"],
    ]);
  });

  it("run 3 has nothing left to publish, and starts a new stack from the base", async () => {
    const run3 = await startRun(checkpointDir, repo, config);
    expect(pendingPublications(run3.orchestrator.getGoalPublications(), "stack", ON)).toEqual([]);
    expect(resumeStackHead(run3.orchestrator.getGoalPublications(), { interrupted: run3.checkpoint?.current_goal != null, settings: ON })).toBeNull();
    expect(prs()).toHaveLength(3);
  });
});

describe("merge_prs: a resumed run pushes, opens and merges the earlier run's goals", () => {
  let root: string;
  let repo: string;
  let checkpointDir: string;
  const config: SourceControlConfig = { strategy: "remote_pr", base_branch: "main", branch_prefix: "swarm/" };
  const options = { gate: { command: "test -f one.txt || test -f two.txt" }, skipLabels: ["swarm_merge: false"] };

  beforeAll(() => {
    ({ root, repo } = setUpRepo("swarm-resume-merge-"));
    checkpointDir = join(root, "checkpoints");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("run 1 finishes a goal whose push fails: no PR, so it stays to do", async () => {
    const run1 = await startRun(checkpointDir, repo, config);
    await finishGoal(repo, "swarm/goal-m1", "main", "one.txt");
    run1.orchestrator.recordGoalPublication({
      goal_id: "m1", description: "Goal one", mode: "merge", branch: "swarm/goal-m1",
      verdicts: ["approved", "completed_with_deferrals"], left_for_person: LEFT, pushed: false, merged: false,
    });
    git(["remote", "set-url", "origin", join(root, "missing.git")], repo);

    const outcome = await run1.manager.mergeGoal(mergeableFromPublication(run1.orchestrator.getGoalPublications()[0]), options);
    await run1.orchestrator.saveCheckpoint(checkpointFields(null));

    expect(outcome).toMatchObject({ merged: false, reason: "the branch swarm/goal-m1 could not be pushed" });
    expect(prs()).toHaveLength(0);
    expect(pendingPublications(run1.orchestrator.getGoalPublications(), "merge", ON).map((r) => r.goal_id)).toEqual(["m1"]);
  });

  it("run 2 merges it before its own goals, and one left open on purpose stays done", async () => {
    git(["remote", "set-url", "origin", fake.remote], repo);
    git(["switch", "-q", "main"], repo);
    const run2 = await startRun(checkpointDir, repo, config);

    for (const record of pendingPublications(run2.orchestrator.getGoalPublications(), "merge", ON)) {
      const outcome = await run2.manager.mergeGoal(mergeableFromPublication(record), options);
      expect(outcome.merged).toBe(true);
    }
    expect(prs()[0]).toMatchObject({ head: "swarm/goal-m1", base: "main", state: "MERGED" });
    expect(prs()[0].body).toContain("## Left for a person");
    git(["fetch", "-q", "origin"], repo);
    expect(git(["show", "origin/main:one.txt"], repo)).toBe("one.txt");

    // This run's own goal fails its gate: its PR is left open, with a reason.
    await run2.manager.syncBaseBranch();
    await finishGoal(repo, "swarm/goal-m2", "main", "unrelated.txt");
    run2.orchestrator.recordGoalPublication({ goal_id: "m2", description: "Goal two", mode: "merge", branch: "swarm/goal-m2", verdicts: ["approved"], pushed: false, merged: false });
    const left = await run2.manager.mergeGoal(mergeableFromPublication(run2.orchestrator.getGoalPublications()[1]), { ...options, gate: { command: "exit 3" } });
    expect(left.merged).toBe(false);
    await run2.orchestrator.saveCheckpoint(checkpointFields(null));

    expect(run2.orchestrator.getGoalPublications().map((r) => [r.goal_id, r.pushed, r.merged, r.left_open_reason ?? null])).toEqual([
      ["m1", true, true, null],
      ["m2", true, false, "the merge gate failed (exit 3); its output is in the run log"],
    ]);
  });

  it("run 3 does nothing twice", async () => {
    const run3 = await startRun(checkpointDir, repo, config);
    expect(pendingPublications(run3.orchestrator.getGoalPublications(), "merge", ON)).toEqual([]);
    expect(prs().map((p) => [p.head, p.state])).toEqual([
      ["swarm/goal-m1", "MERGED"],
      ["swarm/goal-m2", "OPEN"],
    ]);
  });
});
