/**
 * source_control.github_account on the GitHub task backend and goal source:
 * given a GitHubCredential, every gh call they make runs as that account — its
 * token in that call's env, and nowhere else (never process.env). Without one,
 * gh inherits the environment as before.
 *
 * gh never runs: the fake child process records each call's options.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { execFile } from "node:child_process";
import { GitHubCredential, type Goal, type Task } from "@mnmal-ai/swarm-types";
import { GitHubTaskBackend } from "../src/github.js";
import { GitHubExternalSource } from "../src/github-external-source.js";
import { createTaskBackend } from "../src/index.js";
import { runCli } from "../src/run-cli.js";
import { cli, cliFailure, execFileCalls } from "./helpers/fake-child-process.js";

vi.mock("node:child_process", async () => (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());

const mockExecFile = execFile as unknown as Mock;
const FAKE_TOKEN = "gho_FAKE0000000000000000000000000000test";
const credential = () => new GitHubCredential("example-bot", FAKE_TOKEN);

const GOAL: Goal = {
  id: "goal-1", description: "Add login", priority: 1, status: "pending",
  constraints: [], acceptance_criteria: [],
};
const TASK = {
  id: "task-1", goal_id: "gh-7", description: "Write the form", title: "feat: form",
  intent: "implementation", status: "pending", order: 1,
} as Task;

/** gh's stdout for any call: enough for every method below to parse. */
function fakeGh(_file: string, args: string[]): string {
  if (args[0] === "issue" && args[1] === "list") return "[]";
  if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ number: 3, title: "t", body: "", state: "OPEN" });
  if (args[0] === "issue" && args[1] === "create") return "https://github.com/example-org/sample-app/issues/9\n";
  if (args[0] === "api") return "123\n";
  return "";
}

/** Every recorded call ran gh with the account's token in its own env. */
function expectEveryCallAsAccount(): void {
  const calls = execFileCalls(mockExecFile);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.file).toBe("gh");
    expect((call.options.env as NodeJS.ProcessEnv | undefined)?.GH_TOKEN, call.args.join(" ")).toBe(FAKE_TOKEN);
  }
  expect(process.env.GH_TOKEN).not.toBe(FAKE_TOKEN);
}

beforeEach(() => {
  cli.mockReset();
  cli.mockImplementation(fakeGh);
  mockExecFile.mockClear();
});

describe("runCli", () => {
  it("passes an env to the process when given one, and none otherwise", async () => {
    await runCli("gh", ["api", "user"], { env: { PATH: "/usr/bin", GH_TOKEN: FAKE_TOKEN } });
    await runCli("gh", ["api", "user"]);
    const [withEnv, without] = execFileCalls(mockExecFile);
    expect(withEnv.options.env).toEqual({ PATH: "/usr/bin", GH_TOKEN: FAKE_TOKEN });
    expect(without.options.env).toBeUndefined();
  });
});

describe("GitHubTaskBackend with a GitHub account", () => {
  it("runs every gh call as the account", async () => {
    const backend = new GitHubTaskBackend("example-org/sample-app", { createTasks: true, credential: credential() });
    await backend.getGoals();
    await backend.getAllTasks();
    await backend.createGoal(GOAL);
    await backend.createTask(TASK);
    await backend.updateTask("3", { status: "completed" });
    await backend.addComment("3", "done");
    expectEveryCallAsAccount();
  });

  it("without an account, gh inherits the environment (unchanged)", async () => {
    await new GitHubTaskBackend("example-org/sample-app").getGoals();
    for (const call of execFileCalls(mockExecFile)) expect(call.options.env).toBeUndefined();
  });

  it("createTaskBackend hands the account to the GitHub backend", async () => {
    const backend = createTaskBackend({ type: "github", repo: "example-org/sample-app", credential: credential() });
    await backend.getGoals();
    expectEveryCallAsAccount();
  });
});

describe("GitHubExternalSource with a GitHub account", () => {
  it("runs every gh call as the account", async () => {
    const source = new GitHubExternalSource({ repo: "example-org/sample-app", credential: credential() });
    await source.fetchGoals();
    await source.pushGoal(GOAL);
    await source.pushTask(TASK, "7");
    await source.updateStatus("7", "completed");
    await source.postComment("7", "done");
    expectEveryCallAsAccount();
  });

  it("without an account, gh inherits the environment (unchanged)", async () => {
    await new GitHubExternalSource({ repo: "example-org/sample-app" }).fetchGoals();
    for (const call of execFileCalls(mockExecFile)) expect(call.options.env).toBeUndefined();
  });

  it("masks the token in a failed call's error", async () => {
    cli.mockImplementation(() => { throw cliFailure(`HTTP 401 for token ${FAKE_TOKEN}`, `gh issue list ${FAKE_TOKEN}`); });
    const source = new GitHubExternalSource({ repo: "example-org/sample-app", credential: credential() });
    const backend = new GitHubTaskBackend("example-org/sample-app", { credential: credential() });

    for (const attempt of [source.fetchGoals(), backend.getGoals()]) {
      const failure = await attempt.catch((e: Error) => e);
      expect((failure as Error).message).toMatch(/gh CLI failed/);
      expect((failure as Error).message).not.toContain(FAKE_TOKEN);
    }
  });

  it("keeps the token out of anything it serializes", () => {
    const source = new GitHubExternalSource({ repo: "example-org/sample-app", credential: credential() });
    expect(JSON.stringify(source)).not.toContain(FAKE_TOKEN);
  });
});
