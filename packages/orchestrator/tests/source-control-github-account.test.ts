import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubCredential, GH_GIT_CREDENTIAL_ARGS, type SourceControlConfig } from "@mnmal-ai/swarm-types";

/**
 * source_control.github_account: the SourceControlManager's own GitHub calls
 * — `gh pr create`, and `git push` to an HTTPS GitHub remote — run as the
 * configured account, with its token in THAT call's env only. SSH remotes are
 * pushed as before; nothing else gets the token; process.env never holds it.
 *
 * A stub child_process records every call; neither git nor gh runs.
 */

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, "", "")),
}));

import { execFile } from "node:child_process";
import { SourceControlManager } from "../src/source-control/index.js";

const mockExecFile = vi.mocked(execFile);
const FAKE_TOKEN = "gho_FAKE0000000000000000000000000000test";
const HTTPS_REMOTE = "https://github.com/example-org/sample-app.git";
const SSH_REMOTE = "git@work-alias:example-org/sample-app.git";

interface Call {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  /** process.env.GH_TOKEN at the moment of the call. */
  processToken: string | undefined;
}

let calls: Call[];

function install(remoteUrl: string): void {
  let pr = 0;
  mockExecFile.mockImplementation(((cmd: string, rawArgs: unknown, opts: unknown, cb: Function) => {
    const args = (rawArgs as string[]) ?? [];
    calls.push({
      cmd,
      args,
      env: (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env,
      processToken: process.env.GH_TOKEN,
    });
    if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") return cb(null, `${remoteUrl}\n`, "");
    if (cmd === "gh" && args[0] === "pr") return cb(null, `https://github.com/example-org/sample-app/pull/${++pr}\n`, "");
    return cb(null, "", "");
  }) as never);
}

const pushes = () => calls.filter((c) => c.cmd === "git" && c.args.includes("push"));
const prCreates = () => calls.filter((c) => c.cmd === "gh" && c.args[0] === "pr");
const otherCalls = () => calls.filter((c) => !c.args.includes("push") && c.cmd !== "gh");

function config(overrides?: Partial<SourceControlConfig>): SourceControlConfig {
  return { strategy: "remote_pr", stack_prs: true, ...overrides };
}

const credential = () => new GitHubCredential("example-bot", FAKE_TOKEN);

beforeEach(() => {
  vi.resetAllMocks();
  calls = [];
});

describe("SourceControlManager with a GitHub account", () => {
  it("stacked PRs: pushes to an HTTPS remote through gh's credential helper, and opens PRs, as the account", async () => {
    install(HTTPS_REMOTE);
    const mgr = new SourceControlManager("/repo", config(), undefined, { github: credential() });
    await mgr.createSessionBranch("sess-1");

    const result = await mgr.onGoalComplete([
      { goalId: "goal-1", goalDescription: "First" },
      { goalId: "goal-2", goalDescription: "Second" },
    ]);

    expect(result.goals.map((g) => g.prUrl)).toHaveLength(2);
    expect(pushes()).toHaveLength(2);
    for (const push of pushes()) {
      expect(push.args).toEqual([...GH_GIT_CREDENTIAL_ARGS, "push", "-u", "origin", expect.stringMatching(/^swarm\/goal-/)]);
      expect(push.env?.GH_TOKEN).toBe(FAKE_TOKEN);
    }
    expect(prCreates()).toHaveLength(2);
    for (const pr of prCreates()) expect(pr.env?.GH_TOKEN).toBe(FAKE_TOKEN);
  });

  it("gives the token to no other git call, and never to process.env", async () => {
    install(HTTPS_REMOTE);
    const mgr = new SourceControlManager("/repo", config(), undefined, { github: credential() });
    await mgr.createSessionBranch("sess-1");
    await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First" }]);

    expect(otherCalls().length).toBeGreaterThan(0);
    for (const call of otherCalls()) expect(call.env?.GH_TOKEN, call.args.join(" ")).toBeUndefined();
    for (const call of calls) expect(call.processToken).not.toBe(FAKE_TOKEN);
    expect(process.env.GH_TOKEN).not.toBe(FAKE_TOKEN);
  });

  it("leaves a push to an SSH remote as it was, but still opens the PR as the account", async () => {
    install(SSH_REMOTE);
    const mgr = new SourceControlManager("/repo", config(), undefined, { github: credential() });
    await mgr.createSessionBranch("sess-1");
    await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First" }]);

    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].args).toEqual(["push", "-u", "origin", "swarm/goal-1"]);
    expect(pushes()[0].env?.GH_TOKEN).toBeUndefined();
    expect(prCreates()[0].env?.GH_TOKEN).toBe(FAKE_TOKEN);
  });

  it("looks up the configured remote, not always origin", async () => {
    install(HTTPS_REMOTE);
    const mgr = new SourceControlManager("/repo", config({ remote: "upstream" }), undefined, { github: credential() });
    await mgr.createSessionBranch("sess-1");
    await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First" }]);

    expect(calls.find((c) => c.args[0] === "remote")?.args).toEqual(["remote", "get-url", "upstream"]);
    expect(pushes()[0].args.slice(-3)).toEqual(["-u", "upstream", "swarm/goal-1"]);
  });

  it("session-branch mode (no stack_prs) and onSessionEnd push and open the PR as the account", async () => {
    install(HTTPS_REMOTE);
    const mgr = new SourceControlManager("/repo", config({ stack_prs: false }), undefined, { github: credential() });
    await mgr.createSessionBranch("sess-1");
    const result = await mgr.onGoalComplete("goal-1", "First");

    expect(result.pushed).toBe(true);
    expect(pushes()[0].args.slice(0, GH_GIT_CREDENTIAL_ARGS.length)).toEqual([...GH_GIT_CREDENTIAL_ARGS]);
    expect(pushes()[0].env?.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(prCreates()[0].env?.GH_TOKEN).toBe(FAKE_TOKEN);

    calls = [];
    const again = new SourceControlManager("/repo", config({ stack_prs: false, pr_on_goal_complete: false, auto_push: true }), undefined, { github: credential() });
    await again.createSessionBranch("sess-2");
    await again.onSessionEnd();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].env?.GH_TOKEN).toBe(FAKE_TOKEN);
  });

  it("masks the token in a failed call's error", async () => {
    mockExecFile.mockImplementation(((cmd: string, rawArgs: unknown, _opts: unknown, cb: Function) => {
      const args = (rawArgs as string[]) ?? [];
      if (cmd === "git" && args[0] === "remote") return cb(null, `${HTTPS_REMOTE}\n`, "");
      if (cmd === "gh") return cb(new Error(`gh: HTTP 401 for token ${FAKE_TOKEN}`), "", "");
      return cb(null, "", "");
    }) as never);
    const mgr = new SourceControlManager("/repo", config(), undefined, { github: credential() });
    await mgr.createSessionBranch("sess-1");

    const failure = await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First" }]).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/PR creation failed/);
    expect((failure as Error).message).not.toContain(FAKE_TOKEN);
  });
});

describe("SourceControlManager without a GitHub account (unchanged)", () => {
  it("pushes plainly and runs gh with the inherited environment", async () => {
    install(HTTPS_REMOTE);
    const mgr = new SourceControlManager("/repo", config());
    await mgr.createSessionBranch("sess-1");
    await mgr.onGoalComplete([{ goalId: "goal-1", goalDescription: "First" }]);

    expect(pushes()[0].args).toEqual(["push", "-u", "origin", "swarm/goal-1"]);
    expect(pushes()[0].env).toBeUndefined();
    expect(prCreates()[0].env).toBeUndefined();
    // No remote lookup is needed when there is no account to route.
    expect(calls.some((c) => c.args[0] === "remote")).toBe(false);
  });
});
