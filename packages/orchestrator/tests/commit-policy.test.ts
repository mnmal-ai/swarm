/**
 * Per-project commit identity and format (source_control.git_identity,
 * source_control.commit_style).
 *
 * A project can require every commit swarm makes in its work repo to be
 * authored AND committed as one account, and to use Conventional Commits.
 * The identity must win over the repo's git config and any inherited GIT_*
 * environment, on every commit path: the live-repo commit, the worktree task
 * commit, and the worktree merge commit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator } from "../src/orchestrator/index.js";
import { WorktreeManager } from "../src/worktree/index.js";
import {
  taskCommitSubject,
  validateSourceControlConfig,
} from "../src/source-control/commit-policy.js";
import type { SwarmOversightRunResult, Goal, ProjectConfig, SourceControlConfig, Task } from "@mnmal-ai/swarm-types";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

const IDENTITY = { name: "Example Bot", email: "bot@example.com" };

/** author name|author email|committer name|committer email of `rev`. */
async function who(cwd: string, rev = "HEAD"): Promise<string> {
  return git(cwd, ["log", "-1", "--format=%an|%ae|%cn|%ce", rev]);
}

function makeTask(id: string, title?: string): Task {
  return {
    id,
    goal_id: "goal-1",
    title,
    description: `do ${id}`,
    status: "pending",
    priority: 1,
    intent: "implementation",
  } as unknown as Task;
}

function makeOrchestrator(repoRoot: string, sourceControl?: Partial<SourceControlConfig>, maxWorkers = 1): Orchestrator {
  return new Orchestrator({
    projectConfig: {
      project: "test",
      swarm_path: ".swarm",
      trust_level: maxWorkers > 1 ? "medium" : "low", // "low" disables parallel workers
      task_backend: "local",
      models: { worker: "test", reviewer: "test", arbiter: "test", provider: "anthropic" },
      backends: {},
      base_branch: "main",
      isolation: null,
      concurrency: { max_workers: maxWorkers, max_tokens_per_session: 100_000_000, max_tokens_per_task: 10_000_000, max_tokens_per_goal: 50_000_000 },
      ...(sourceControl ? { source_control: { strategy: "remote_pr", ...sourceControl } } : {}),
    } as unknown as ProjectConfig,
    backend: { run: async () => ({ output: "", tokenUsage: {} }) } as never,
    repoRoot,
  });
}

// ---------------------------------------------------------------------------
// Subject format
// ---------------------------------------------------------------------------

describe("taskCommitSubject", () => {
  it("swarm style (the default) is unchanged: swarm(<task-id>): <title>", () => {
    expect(taskCommitSubject(makeTask("goal-1-t2", "Add export button"))).toBe("swarm(goal-1-t2): Add export button");
    expect(taskCommitSubject(makeTask("goal-1-t2", "Add export button"), "swarm")).toBe("swarm(goal-1-t2): Add export button");
    expect(taskCommitSubject(makeTask("goal-1-t2"))).toBe("swarm(goal-1-t2): task completed");
  });

  it("conventional style keeps a title that is already a Conventional Commit subject", () => {
    for (const title of [
      "feat(api): add the export query",
      "fix: handle an empty search result",
      "refactor(ui)!: rename DashboardView",
      "docs(readme): describe the new flags",
    ]) {
      expect(taskCommitSubject(makeTask("t1", title), "conventional")).toBe(title);
    }
  });

  it("conventional style falls back to chore(swarm): <title> otherwise", () => {
    expect(taskCommitSubject(makeTask("t1", "Add the export query"), "conventional")).toBe("chore(swarm): Add the export query");
    expect(taskCommitSubject(makeTask("t1", "Feat: add it"), "conventional")).toBe("chore(swarm): Feat: add it");
    expect(taskCommitSubject(makeTask("t1", "feat:no space"), "conventional")).toBe("chore(swarm): feat:no space");
    expect(taskCommitSubject(makeTask("t1", "feat(): empty scope"), "conventional")).toBe("chore(swarm): feat(): empty scope");
    expect(taskCommitSubject(makeTask("t1"), "conventional")).toBe("chore(swarm): task completed");
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("validateSourceControlConfig", () => {
  it("accepts a config without the new keys, and a well-formed one", () => {
    expect(validateSourceControlConfig(undefined)).toEqual([]);
    expect(validateSourceControlConfig({ strategy: "remote_pr" })).toEqual([]);
    expect(
      validateSourceControlConfig({
        strategy: "remote_pr",
        git_identity: { name: "example-user", email: "example-user@example.invalid" },
        commit_style: "conventional",
      }),
    ).toEqual([]);
  });

  it("rejects a malformed git_identity with a message naming the key", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["example-user", /source_control\.git_identity must be an object/],
      [{ name: "example-user" }, /source_control\.git_identity\.email/],
      [{ email: "d@example.com" }, /source_control\.git_identity\.name/],
      [{ name: "  ", email: "d@example.com" }, /source_control\.git_identity\.name/],
      [{ name: "example-user <d@x>", email: "d@example.com" }, /source_control\.git_identity\.name/],
      [{ name: "example-user", email: "not-an-email" }, /source_control\.git_identity\.email/],
      [{ name: "example-user", email: "d @example.com" }, /source_control\.git_identity\.email/],
      [{ name: "example-user", email: 42 }, /source_control\.git_identity\.email/],
    ];
    for (const [identity, message] of cases) {
      const errors = validateSourceControlConfig({ strategy: "remote_pr", git_identity: identity });
      expect(errors.join("\n"), JSON.stringify(identity)).toMatch(message);
    }
  });

  it("rejects an unknown commit_style", () => {
    expect(validateSourceControlConfig({ strategy: "remote_pr", commit_style: "angular" }).join("\n")).toMatch(
      /source_control\.commit_style must be "swarm" or "conventional"/,
    );
  });

  it("accepts a GitHub login as github_account", () => {
    for (const login of ["example-bot", "ExampleBot", "a", "example-bot-2", "x".repeat(39)]) {
      expect(validateSourceControlConfig({ strategy: "remote_pr", github_account: login }), login).toEqual([]);
    }
  });

  it("rejects a github_account that is not a GitHub login, naming the key", () => {
    // A leading "-" would reach gh as a flag; the rest are not logins.
    for (const bad of ["", "  ", "-example-bot", "example bot", "example-org/sample-app", "x".repeat(40), 42, null, ["example-bot"]]) {
      expect(
        validateSourceControlConfig({ strategy: "remote_pr", github_account: bad }).join("\n"),
        JSON.stringify(bad),
      ).toMatch(/source_control\.github_account must be a GitHub login like "example-bot"/);
    }
  });

  // Workers have no GitHub access, so a config that expects them to open the
  // stacked PRs (stack_prs without remote_pr) would finish with no PR.
  it.each([
    ["ephemeral", "'ephemeral'"],
    ["local_branch", "'local_branch'"],
    [undefined, "unset"],
  ])("refuses stack_prs with strategy %s, naming the fix", (strategy, shown) => {
    const errors = validateSourceControlConfig({ ...(strategy ? { strategy } : {}), stack_prs: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      `source_control.stack_prs is on but strategy is ${shown}: workers no longer have GitHub access, so they cannot open pull requests. ` +
        `Set source_control.strategy to "remote_pr" so swarm opens them (or turn stack_prs off).`,
    );
  });

  it("accepts stack_prs with remote_pr, stack_prs off with any strategy, and no block", () => {
    expect(validateSourceControlConfig({ strategy: "remote_pr", stack_prs: true })).toEqual([]);
    for (const strategy of ["ephemeral", "local_branch", "remote_pr", undefined]) {
      for (const stack_prs of [false, undefined]) {
        const sc = { ...(strategy ? { strategy } : {}), ...(stack_prs === undefined ? {} : { stack_prs }) };
        expect(validateSourceControlConfig(sc), JSON.stringify(sc)).toEqual([]);
      }
    }
    expect(validateSourceControlConfig(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Identity and style on real commits
// ---------------------------------------------------------------------------

describe("commits swarm makes use the configured identity and style", () => {
  let repo: string;
  const savedEnv: Record<string, string | undefined> = {};
  const GIT_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "swarm-commit-policy-"));
    await git(repo, ["init", "-b", "main"]);
    // The repo's own identity, which a configured identity must override.
    await git(repo, ["config", "user.email", "repo@example.com"]);
    await git(repo, ["config", "user.name", "Repo User"]);
    await git(repo, ["config", "author.name", "Repo Author"]);
    await git(repo, ["config", "committer.name", "Repo Committer"]);
    await writeFile(join(repo, "README.md"), "# initial\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    // …and an identity inherited from the environment swarm runs in.
    for (const k of GIT_ENV) savedEnv[k] = process.env[k];
    process.env.GIT_AUTHOR_NAME = "Env Author";
    process.env.GIT_COMMITTER_NAME = "Env Committer";
  });

  afterEach(async () => {
    for (const k of GIT_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(repo, { recursive: true, force: true });
  });

  it("live-repo commit: author and committer are the configured identity", async () => {
    const orch = makeOrchestrator(repo, { git_identity: IDENTITY });
    await writeFile(join(repo, "a.txt"), "a\n");
    await orch.commitLiveRepo(makeTask("goal-1-t1", "Add a"));

    expect(await who(repo)).toBe(`${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`);
    expect(await git(repo, ["log", "-1", "--format=%s"])).toBe("swarm(goal-1-t1): Add a");
  });

  it("live-repo commit without an identity still uses the environment/repo config", async () => {
    const orch = makeOrchestrator(repo);
    await writeFile(join(repo, "a.txt"), "a\n");
    await orch.commitLiveRepo(makeTask("goal-1-t1", "Add a"));

    expect(await who(repo)).toBe("Env Author|repo@example.com|Env Committer|repo@example.com");
  });

  it("live-repo commit in conventional style keeps the Goal/Task/Session body", async () => {
    const orch = makeOrchestrator(repo, { git_identity: IDENTITY, commit_style: "conventional" });
    await writeFile(join(repo, "a.txt"), "a\n");
    await orch.commitLiveRepo(makeTask("goal-1-t1", "feat(api): add a"));
    await writeFile(join(repo, "b.txt"), "b\n");
    await orch.commitLiveRepo(makeTask("goal-1-t2", "Add b"));

    expect(await git(repo, ["log", "-2", "--format=%s"])).toBe("chore(swarm): Add b\nfeat(api): add a");
    const body = await git(repo, ["log", "-1", "--format=%b"]);
    expect(body).toMatch(/^Goal: goal-1\nTask: goal-1-t2\nSession: \S+/);
  });

  it("worktree task commit and merge commit: identity on both, conventional merge message", async () => {
    const manager = new WorktreeManager(repo, {
      baseDir: join(repo, ".swarm", "worktrees"),
      gitIdentity: IDENTITY,
      commitStyle: "conventional",
    });
    const wt = await manager.create("task-1");
    await writeFile(join(wt.path, "c.txt"), "c\n");
    expect(await manager.commitChanges("task-1", "feat(api): add c")).toBe(true);
    expect(await who(wt.path)).toBe(`${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`);

    const result = await manager.merge("task-1");
    expect(result.success).toBe(true);
    // The merge commit on main.
    expect(await git(repo, ["rev-list", "--count", "--merges", "main"])).toBe("1");
    expect(await who(repo, "main")).toBe(`${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`);
    expect(await git(repo, ["log", "-1", "--format=%s", "main"])).toMatch(/^chore\(swarm\): merge /);
  });

  it("worktree dispatch: the orchestrator's task commits follow the configured style", async () => {
    // Two workers: worktrees are only used when max_workers > 1.
    const orch = makeOrchestrator(repo, { git_identity: IDENTITY, commit_style: "conventional" }, 2);
    const worktreeManager = new WorktreeManager(repo, {
      baseDir: join(repo, ".swarm", "worktrees"),
      gitIdentity: IDENTITY,
      commitStyle: "conventional",
    });
    const approved = {
      output: "ok",
      tokensUsed: { input: 0, output: 0 },
      latencyMs: 0,
      tokenLimitExceeded: false,
      oversight: { verdict: "approved", rejectionReasons: [], retryCount: 0, arbiterInvolved: false, humanEscalation: false },
    } as unknown as SwarmOversightRunResult;

    await orch.dispatchParallel({
      tasks: [makeTask("t1", "feat(api): add one"), makeTask("t2", "Add two")],
      goal: { id: "goal-1", description: "goal", priority: 1, status: "pending" } as unknown as Goal,
      project: "test",
      workingDirectory: repo,
      worktreeManager,
      executeTask: async (task: Task, workingDir: string) => {
        await writeFile(join(workingDir, `${task.id}.txt`), `${task.id}\n`);
        return approved;
      },
    });

    const subjects = (await git(repo, ["log", "--no-merges", "--format=%s", "main"])).split("\n");
    expect(subjects).toContain("feat(api): add one");
    expect(subjects).toContain("chore(swarm): Add two");
    // Two task commits and two merge commits since "initial", all as IDENTITY.
    const root = await git(repo, ["rev-list", "--max-parents=0", "main"]);
    const people = (await git(repo, ["log", "--format=%an|%ae|%cn|%ce", "main", "--not", root])).split("\n");
    expect(people).toEqual(Array(4).fill(`${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`));
  });

  it("worktree merge in swarm style keeps git's default merge message", async () => {
    const manager = new WorktreeManager(repo, { baseDir: join(repo, ".swarm", "worktrees") });
    const wt = await manager.create("task-1");
    await writeFile(join(wt.path, "c.txt"), "c\n");
    await manager.commitChanges("task-1", "swarm(task-1): add c");
    await manager.merge("task-1");
    expect(await git(repo, ["log", "-1", "--format=%s", "main"])).toMatch(/^Merge branch /);
  });
});
