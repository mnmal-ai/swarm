import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { SourceControlConfig } from "@mnmal-ai/swarm-types";

/**
 * Two swarm runs on two clones of one repository take merge turns through the
 * file merge queue: their gates never overlap and both land. Same fake `gh` as
 * merge-prs-integration.test.ts (each test file needs its own mock).
 */

interface FakePr {
  n: number;
  base: string;
  head: string;
  state: "OPEN" | "MERGED";
  mergeCommit?: string;
  comments: string[];
}

const fake = vi.hoisted(() => ({ remote: "", scratch: "", prs: [] as unknown[], failViews: 0, mergeThenFail: false, beforeMerge: undefined as undefined | (() => void), unknownPolls: 0, refuseOnce: undefined as undefined | string }));

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
import { FileMergeQueue } from "../src/source-control/merge-lock.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
let root: string, repoA: string, repoB: string, lockDir: string, gateLog: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "swarm-merge-queue-"));
  fake.remote = join(root, "remote.git");
  fake.scratch = join(root, "scratch");
  repoA = join(root, "a");
  repoB = join(root, "b");
  lockDir = join(root, "locks");
  gateLog = join(root, "gates.log");
  git(["init", "-q", "--bare", "-b", "main", fake.remote], root);
  git(["clone", "-q", fake.remote, repoA], root);
  git(["switch", "-q", "-c", "main"], repoA);
  writeFileSync(join(repoA, "README.md"), "one\n");
  git(["add", "-A"], repoA);
  git([...ID, "commit", "-q", "-m", "initial"], repoA);
  git(["push", "-q", "-u", "origin", "main"], repoA);
  git(["clone", "-q", fake.remote, repoB], root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function goalIn(repo: string, manager: SourceControlManager, id: string): Promise<string> {
  await manager.syncBaseBranch();
  const branch = `swarm/goal-${id}`;
  await materializeGoalBranch(repo, branch, "main");
  git(["switch", "-q", branch], repo);
  writeFileSync(join(repo, `${id}.txt`), `${id}\n`);
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", id], repo);
  return branch;
}

it("two runs on two clones merge one after the other, and their gates never overlap", async () => {
  const config = { strategy: "remote_pr" as const, base_branch: "main", git_identity: { name: "Swarm", email: "b@e" } };
  const a = new SourceControlManager(repoA, config, new SwarmEventBus());
  const b = new SourceControlManager(repoB, config, new SwarmEventBus());
  const queueOpts = { dir: lockDir, pollMs: 20 };
  const key = "local/remote#main";
  const ba = await goalIn(repoA, a, "ga");
  const bb = await goalIn(repoB, b, "gb");
  // Each gate logs start and end, sleeping between, so an overlap would interleave.
  const gate = { command: `echo start-$$ >> ${gateLog}; sleep 1; echo end-$$ >> ${gateLog}` };
  const [ra, rb] = await Promise.all([
    a.mergeGoal({ goalId: "ga", goalDescription: "a", branch: ba, verdicts: ["approved"] }, { gate, skipLabels: [], queue: new FileMergeQueue(key, queueOpts), project: "a" }),
    b.mergeGoal({ goalId: "gb", goalDescription: "b", branch: bb, verdicts: ["approved"] }, { gate, skipLabels: [], queue: new FileMergeQueue(key, queueOpts), project: "b" }),
  ]);
  expect(ra.merged && rb.merged).toBe(true);
  // The second merge brought main in only after taking the turn, so neither went round again.
  expect([ra.rounds, rb.rounds]).toEqual([1, 1]);
  const lines = readFileSync(gateLog, "utf8").trim().split("\n");
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i].startsWith("start-")).toBe(true);
    expect(lines[i + 1]).toBe(lines[i].replace("start-", "end-"));
  }
  // Both goals' work is on main.
  git(["fetch", "-q", "origin"], repoA);
  expect(git(["show", "origin/main:ga.txt"], repoA)).toBe("ga");
  expect(git(["show", "origin/main:gb.txt"], repoA)).toBe("gb");
});
