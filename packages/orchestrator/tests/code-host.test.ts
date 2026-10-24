import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { GitHubCredential } from "@mnmal-ai/swarm-types";
import { SourceControlManager } from "../src/source-control/index.js";
import type { CodeHost, Mergeability, PinnedMergeOutcome } from "../src/source-control/code-host.js";
import { GitHubCodeHost } from "../src/source-control/github-host.js";
import { materializeGoalBranch } from "../src/source-control/stack.js";
import { validateSourceControlConfig } from "../src/source-control/commit-policy.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

/** A code host kept in memory that merges for real into a bare remote. No gh anywhere: what a GitLab implementation must do, in miniature. */
class MemoryHost implements CodeHost {
  readonly name = "memory";
  readonly displayName = "Memory";
  prs: Array<{ url: string; base: string; head: string; state: string; mergeCommit?: string; comments: string[] }> = [];
  constructor(private readonly remote: string, private readonly scratch: string) {}
  async openChangeRequest(o: { title: string; body: string; base: string; head: string }): Promise<string> {
    const url = `memory://pr/${this.prs.length + 1}`;
    this.prs.push({ url, base: o.base, head: o.head, state: "OPEN", comments: [] });
    return url;
  }
  async findChangeRequest(head: string) {
    const pr = this.prs.find((p) => p.head === head);
    return pr ? { url: pr.url, state: pr.state, base: pr.base } : undefined;
  }
  async viewChangeRequest(url: string) {
    const pr = this.prs.find((p) => p.url === url);
    if (!pr) throw new Error(`no change request ${url}`);
    return { url: pr.url, state: pr.state, base: pr.base, ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}) };
  }
  async comment(url: string, body: string): Promise<void> {
    this.prs.find((p) => p.url === url)!.comments.push(body);
  }
  async mergeability(url: string): Promise<{ mergeable: Mergeability; headSha?: string }> {
    const pr = this.prs.find((p) => p.url === url)!;
    return { mergeable: "MERGEABLE", headSha: git(["rev-parse", `refs/heads/${pr.head}`], this.remote) };
  }
  async mergePinned(url: string, headSha: string): Promise<PinnedMergeOutcome> {
    const pr = this.prs.find((p) => p.url === url)!;
    if (git(["rev-parse", `refs/heads/${pr.head}`], this.remote) !== headSha) return { kind: "refused", error: new Error("head moved") };
    rmSync(this.scratch, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", this.remote, this.scratch]);
    git(["checkout", "-q", pr.base], this.scratch);
    git([...ID, "merge", "--no-ff", "-m", `Merge ${url}`, `origin/${pr.head}`], this.scratch);
    git(["push", "-q", "origin", pr.base], this.scratch);
    pr.state = "MERGED";
    pr.mergeCommit = git(["rev-parse", "HEAD"], this.scratch);
    return { kind: "merged", mergeCommit: pr.mergeCommit };
  }
  async gitAuth() {
    return undefined;
  }
  redact(text: string): string {
    return text;
  }
}

let root: string, remote: string, repo: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "swarm-code-host-"));
  remote = join(root, "remote.git");
  repo = join(root, "work");
  git(["init", "-q", "--bare", "-b", "main", remote], root);
  git(["clone", "-q", remote, repo], root);
  git(["switch", "-q", "-c", "main"], repo);
  writeFileSync(join(repo, "README.md"), "one\n");
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", "initial"], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function goal(manager: SourceControlManager, id: string): Promise<string> {
  await manager.syncBaseBranch();
  const branch = `swarm/goal-${id}`;
  await materializeGoalBranch(repo, branch, "main");
  git(["switch", "-q", branch], repo);
  writeFileSync(join(repo, `${id}.txt`), `${id}\n`);
  git(["add", "-A"], repo);
  git([...ID, "commit", "-q", "-m", id], repo);
  return branch;
}

describe("the code host interface", () => {
  const config = { strategy: "remote_pr" as const, base_branch: "main", git_identity: { name: "Swarm", email: "b@e" } };

  it("merges a goal through a host that is not GitHub, without any gh call", async () => {
    const host = new MemoryHost(remote, join(root, "scratch"));
    const manager = new SourceControlManager(repo, config, new SwarmEventBus(), { codeHost: host });
    const branch = await goal(manager, "m1");
    const r = await manager.mergeGoal({ goalId: "m1", goalDescription: "m1", branch, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels: [] });
    expect(r.merged).toBe(true);
    expect(r.prUrl).toBe("memory://pr/1");
    expect(host.prs[0].state).toBe("MERGED");
    expect(git(["show", "origin/main:m1.txt"], repo)).toBe("m1");
  });

  it("posts swarm's reason through the host when it leaves a change request open", async () => {
    const host = new MemoryHost(remote, join(root, "scratch"));
    const manager = new SourceControlManager(repo, config, new SwarmEventBus(), { codeHost: host });
    const branch = await goal(manager, "m2");
    const r = await manager.mergeGoal({ goalId: "m2", goalDescription: "m2", branch, verdicts: ["approved"] }, { gate: { command: "exit 1" }, skipLabels: [] });
    expect(r.merged).toBe(false);
    expect(r.reason).toBe("the merge gate failed (exit 1); its output is in the run log");
    expect(host.prs[0].comments[0]).toBe("Swarm left this pull request open: the merge gate failed (exit 1); its output is in the run log.");
  });

  it("names the host in a refusal", async () => {
    class RefusingHost extends MemoryHost {
      override async mergePinned(): Promise<PinnedMergeOutcome> {
        return { kind: "refused", error: new Error("nope") };
      }
    }
    const host = new RefusingHost(remote, join(root, "scratch"));
    const manager = new SourceControlManager(repo, config, new SwarmEventBus(), { codeHost: host });
    const branch = await goal(manager, "m3");
    const r = await manager.mergeGoal({ goalId: "m3", goalDescription: "m3", branch, verdicts: ["approved"] }, { gate: { command: "true" }, skipLabels: [] });
    expect(r.reason).toBe("Memory refused to merge the pull request");
  });
});

describe("GitHubCodeHost.gitAuth", () => {
  it("authenticates git as the account only for an HTTPS GitHub remote", async () => {
    git(["remote", "add", "gh-https", "https://github.com/o/r.git"], repo);
    git(["remote", "add", "gh-ssh", "git@github.com:o/r.git"], repo);
    const host = new GitHubCodeHost(repo, new GitHubCredential("bot", "tok-123"));
    const https = await host.gitAuth("gh-https");
    expect(https?.env.GH_TOKEN).toBe("tok-123");
    expect(https?.args).toContain("credential.helper=!gh auth git-credential");
    expect(await host.gitAuth("gh-ssh")).toBeUndefined();
    expect(await new GitHubCodeHost(repo).gitAuth("gh-https")).toBeUndefined();
    expect(host.redact("token tok-123 leaked")).toBe("token ●●●● leaked");
  });
});

describe("source_control.code_host", () => {
  it("accepts github, and refuses anything else by naming what is supported", () => {
    expect(validateSourceControlConfig({ strategy: "remote_pr", code_host: "github" })).toEqual([]);
    expect(validateSourceControlConfig({ strategy: "remote_pr", code_host: "gitlab" })).toEqual([
      'source_control.code_host must be "github", the only code host swarm supports so far (got "gitlab"). A new host is one more implementation of CodeHost (packages/orchestrator/src/source-control/code-host.ts).',
    ]);
  });
});
