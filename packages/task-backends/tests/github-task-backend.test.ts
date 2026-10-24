import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { execFile } from "node:child_process";
import { GitHubTaskBackend } from "../src/github.js";
import type { Goal, Task } from "@mnmal-ai/swarm-types";
import { cli, cliFailure, execFileCalls, fakeChild, type ExecFileCallback } from "./helpers/fake-child-process.js";

// ---------------------------------------------------------------------------
// Mock the child_process module so gh never runs; `cli` plays it
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async () => (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());

const mockExecFile = execFile as unknown as Mock;

/** The argv of every gh call made so far. */
function ghArgs(): string[][] {
  return execFileCalls(mockExecFile).map((call) => call.args);
}

/** The value that follows `flag` in one call's argv. */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

// ---------------------------------------------------------------------------
// Mock data matching the real GitHub issue JSON shape from `gh issue list --json`
// ---------------------------------------------------------------------------

function makeGoalIssue(overrides: Partial<{ number: number; title: string; body: string; state: string }> = {}) {
  const metadata = {
    id: "goal-1",
    priority: 1,
    status: "pending",
    constraints: ["Must use TypeScript"],
    acceptance_criteria: ["All tests pass"],
  };
  return {
    number: overrides.number ?? 10,
    title: overrides.title ?? "Implement authentication",
    body: overrides.body ?? [
      "<!-- swarm-metadata-start -->",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```",
      "<!-- swarm-metadata-end -->",
    ].join("\n"),
    state: overrides.state ?? "OPEN",
  };
}

function makeTaskIssue(overrides: Partial<{ number: number; title: string; goalId: string; intent: string; state: string; status: string; order: number }> = {}) {
  const metadata: Record<string, unknown> = {
    id: `task-${overrides.number ?? 20}`,
    goal_id: overrides.goalId ?? "goal-1",
    intent: overrides.intent ?? "implementation",
    status: overrides.status ?? "pending",
    order: overrides.order ?? 1,
  };
  return {
    number: overrides.number ?? 20,
    title: overrides.title ?? "Set up OAuth provider",
    body: [
      "<!-- swarm-metadata-start -->",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```",
      "<!-- swarm-metadata-end -->",
    ].join("\n"),
    state: overrides.state ?? "OPEN",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubTaskBackend", () => {
  beforeEach(() => {
    cli.mockReset();
    mockExecFile.mockClear();
  });

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("accepts a valid owner/repo format", () => {
      expect(() => new GitHubTaskBackend("mnmal-ai/swarm")).not.toThrow();
    });

    it("accepts no repo (auto-detect from git remote)", () => {
      expect(() => new GitHubTaskBackend()).not.toThrow();
    });

    it("rejects an invalid repo format — missing slash", () => {
      expect(() => new GitHubTaskBackend("invalid-repo")).toThrow(
        /Invalid repo format/
      );
    });

    it("rejects an invalid repo format — too many slashes", () => {
      expect(() => new GitHubTaskBackend("a/b/c")).toThrow(
        /Invalid repo format/
      );
    });

    it("rejects an invalid repo format — empty string is treated as no repo", () => {
      // Empty string is falsy, so it bypasses the regex check and uses auto-detect
      expect(() => new GitHubTaskBackend("")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getGoals()
  // -------------------------------------------------------------------------

  describe("getGoals()", () => {
    it("parses GitHub issue JSON into Goal objects", async () => {
      const issues = [makeGoalIssue()];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const goals = await backend.getGoals();

      expect(goals).toHaveLength(1);
      expect(goals[0]).toEqual({
        id: "goal-1",
        description: "Implement authentication",
        priority: 1,
        status: "pending",
        constraints: ["Must use TypeScript"],
        acceptance_criteria: ["All tests pass"],
      });
    });

    it("returns multiple goals", async () => {
      const issues = [
        makeGoalIssue({ number: 10, title: "First goal" }),
        makeGoalIssue({ number: 11, title: "Second goal" }),
      ];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const goals = await backend.getGoals();
      expect(goals).toHaveLength(2);
    });

    it("returns empty array when no goals exist", async () => {
      cli.mockReturnValue("[]");

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const goals = await backend.getGoals();
      expect(goals).toEqual([]);
    });

    it("calls gh with correct arguments including repo flag", async () => {
      cli.mockReturnValue("[]");

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.getGoals();

      const [{ file, args, options }] = execFileCalls(mockExecFile);
      expect(file).toBe("gh");
      expect(args).toEqual([
        "issue", "list", "--repo", "mnmal-ai/swarm",
        "--label", "swarm:goal", "--state", "all", "--json", "number,title,body,state", "--limit", "100",
      ]);
      expect(options).toMatchObject({ encoding: "utf-8", timeout: 30_000 });
    });

    it("leaves out --repo when the repo is auto-detected", async () => {
      cli.mockReturnValue("[]");

      await new GitHubTaskBackend().getGoals();

      expect(ghArgs()[0]).not.toContain("--repo");
      expect(ghArgs()[0].slice(0, 4)).toEqual(["issue", "list", "--label", "swarm:goal"]);
    });

    it("falls back to issue number as id when metadata is missing", async () => {
      const issues = [{ number: 42, title: "No metadata goal", body: "Just a plain body", state: "OPEN" }];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const goals = await backend.getGoals();
      expect(goals[0].id).toBe("42");
      expect(goals[0].description).toBe("No metadata goal");
    });

    it("maps CLOSED state to completed when no metadata status", async () => {
      const issues = [{ number: 42, title: "Closed goal", body: "", state: "CLOSED" }];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const goals = await backend.getGoals();
      expect(goals[0].status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // getTasks(goalId)
  // -------------------------------------------------------------------------

  describe("getTasks(goalId)", () => {
    it("filters tasks by goal_id in metadata", async () => {
      const issues = [
        makeTaskIssue({ number: 20, goalId: "goal-1" }),
        makeTaskIssue({ number: 21, goalId: "goal-2" }),
        makeTaskIssue({ number: 22, goalId: "goal-1" }),
      ];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const tasks = await backend.getTasks("goal-1");

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.goal_id === "goal-1")).toBe(true);
    });

    it("returns empty array when no tasks match the goal_id", async () => {
      const issues = [makeTaskIssue({ goalId: "goal-99" })];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const tasks = await backend.getTasks("goal-1");
      expect(tasks).toEqual([]);
    });

    it("calls gh with swarm:task label", async () => {
      cli.mockReturnValue("[]");

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.getTasks("goal-1");

      expect(ghArgs()).toEqual([[
        "issue", "list", "--repo", "mnmal-ai/swarm",
        "--label", "swarm:task", "--state", "all", "--json", "number,title,body,state", "--limit", "100",
      ]]);
    });
  });

  // -------------------------------------------------------------------------
  // createGoal(goal)
  // -------------------------------------------------------------------------

  describe("createGoal(goal)", () => {
    it("calls gh issue create with correct labels and returns issue number", async () => {
      cli.mockReturnValue("https://github.com/mnmal-ai/swarm/issues/42\n");

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const goal: Goal = {
        id: "goal-new",
        description: "New feature goal",
        priority: 2,
        status: "pending",
        constraints: [],
        acceptance_criteria: ["Tests pass"],
      };

      const id = await backend.createGoal(goal);

      expect(id).toBe("42");
      expect(ghArgs()).toEqual([[
        "issue", "create", "--repo", "mnmal-ai/swarm",
        "--title", "New feature goal", "--body", expect.stringContaining('"acceptance_criteria"'), "--label", "swarm:goal",
      ]]);
    });

    it("includes goal description in the issue title", async () => {
      cli.mockReturnValue("https://github.com/mnmal-ai/swarm/issues/1\n");

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.createGoal({
        id: "g",
        description: "My goal title",
        priority: 1,
        status: "pending",
        constraints: [],
        acceptance_criteria: [],
      });

      expect(flagValue(ghArgs()[0], "--title")).toBe("My goal title");
    });
  });

  // -------------------------------------------------------------------------
  // createTask(task)
  // -------------------------------------------------------------------------

  describe("createTask(task)", () => {
    it("calls gh issue create with swarm:task label and returns issue number", async () => {
      // createTask now calls: label create (for goal label), issue create, api (get ID), api (sub-issue)
      // Only the issue create call returns a URL — others can return empty
      cli.mockImplementation((_file, args) => {
        if (args[0] === "issue" && args[1] === "create") return "https://github.com/mnmal-ai/swarm/issues/55\n";
        if (args[0] === "api" && flagValue(args, "--jq") === ".id") return "12345\n";
        return "";
      });

      const backend = new GitHubTaskBackend("mnmal-ai/swarm", { createTasks: true });
      const task: Task = {
        id: "task-new",
        goal_id: "goal-1",
        description: "Implement login flow",
        intent: "implementation",
        status: "pending",
        order: 1,
      };

      const id = await backend.createTask(task);

      expect(id).toBe("55");
      const create = ghArgs().find((args) => args[0] === "issue" && args[1] === "create")!;
      expect(flagValue(create, "--label")).toBe("swarm:task");
      expect(flagValue(create, "--title")).toBe("Implement login flow");
    });

    it("labels the task with its goal and links it as a sub-issue, sending the ID on stdin", async () => {
      cli.mockImplementation((_file, args) => {
        if (args[0] === "issue" && args[1] === "create") return "https://github.com/mnmal-ai/swarm/issues/55\n";
        if (args[0] === "api" && flagValue(args, "--jq") === ".id") return "12345\n";
        return "";
      });

      const backend = new GitHubTaskBackend("mnmal-ai/swarm", { createTasks: true });
      const id = await backend.createTask({
        id: "task-new",
        goal_id: "gh-7",
        description: "Implement login flow",
        intent: "implementation",
        status: "pending",
        order: 1,
      });

      expect(id).toBe("55");
      const calls = execFileCalls(mockExecFile);
      expect(calls.map((call) => call.args)).toEqual([
        ["label", "create", "goal:7", "--repo", "mnmal-ai/swarm", "--color", "C5DEF5", "--description", "Tasks for goal #7", "--force"],
        ["issue", "create", "--repo", "mnmal-ai/swarm", "--title", "Implement login flow", "--body", expect.stringMatching(/^Part of #7\n/), "--label", "swarm:task,goal:7"],
        ["api", "repos/mnmal-ai/swarm/issues/55", "--jq", ".id"],
        ["api", "repos/mnmal-ai/swarm/issues/7/sub_issues", "--method", "POST", "--input", "-"],
      ]);
      expect(calls[3].stdin).toBe(JSON.stringify({ sub_issue_id: 12345 }));
      expect(calls.every((call) => call.stdinClosed)).toBe(true);
      expect(calls.slice(0, 3).every((call) => call.stdin === undefined)).toBe(true);
    });

    it("does not call gh when createTasks is disabled", async () => {
      const backend = new GitHubTaskBackend("mnmal-ai/swarm", { createTasks: false });
      const task: Task = {
        id: "task-local",
        goal_id: "goal-1",
        description: "Should stay local",
        intent: "implementation",
        status: "pending",
        order: 1,
      };

      const id = await backend.createTask(task);

      // Should return the task's own id (local fallback)
      expect(id).toBe("task-local");
      // No gh CLI calls should have been made
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("calls gh when createTasks is explicitly enabled", async () => {
      cli.mockReturnValue("https://github.com/mnmal-ai/swarm/issues/60\n");

      const backend = new GitHubTaskBackend("mnmal-ai/swarm", { createTasks: true });
      const task: Task = {
        id: "task-remote",
        goal_id: "goal-1",
        description: "Should go to GitHub",
        intent: "implementation",
        status: "pending",
        order: 1,
      };

      const id = await backend.createTask(task);

      expect(id).toBe("60");
      expect(mockExecFile).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // updateTask(taskId, update)
  // -------------------------------------------------------------------------

  describe("updateTask(taskId, update)", () => {
    it("calls gh issue edit with updated body", async () => {
      // First call: issue view (read current body)
      const currentBody = [
        "<!-- swarm-metadata-start -->",
        "```json",
        JSON.stringify({ id: "task-1", goal_id: "goal-1", intent: "impl", status: "pending", order: 1 }, null, 2),
        "```",
        "<!-- swarm-metadata-end -->",
      ].join("\n");
      cli
        .mockReturnValueOnce(JSON.stringify({ body: currentBody, state: "OPEN" }))  // issue view
        .mockReturnValueOnce("")  // issue edit (body)
        .mockReturnValueOnce("");  // issue reopen (status pending → in_progress)

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.updateTask("42", { status: "in_progress" });

      // Should have called issue view, then issue edit
      expect(ghArgs()[0]).toEqual(["issue", "view", "42", "--repo", "mnmal-ai/swarm", "--json", "body,state"]);
      expect(ghArgs()[1]).toEqual([
        "issue", "edit", "42", "--repo", "mnmal-ai/swarm", "--body", expect.stringContaining('"status": "in_progress"'),
      ]);
    });

    it("closes the issue when status is completed", async () => {
      const currentBody = [
        "<!-- swarm-metadata-start -->",
        "```json",
        JSON.stringify({ status: "in_progress" }, null, 2),
        "```",
        "<!-- swarm-metadata-end -->",
      ].join("\n");
      cli
        .mockReturnValueOnce(JSON.stringify({ body: currentBody, state: "OPEN" }))
        .mockReturnValueOnce("")  // issue edit (body)
        .mockReturnValueOnce("");  // issue close

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.updateTask("42", { status: "completed" });

      expect(ghArgs()).toContainEqual(["issue", "close", "42", "--repo", "mnmal-ai/swarm"]);
    });

    it("closes the issue when status is failed", async () => {
      const currentBody = [
        "<!-- swarm-metadata-start -->",
        "```json",
        JSON.stringify({ status: "in_progress" }, null, 2),
        "```",
        "<!-- swarm-metadata-end -->",
      ].join("\n");
      cli
        .mockReturnValueOnce(JSON.stringify({ body: currentBody, state: "OPEN" }))
        .mockReturnValueOnce("")  // issue edit (body)
        .mockReturnValueOnce("");  // issue close

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.updateTask("42", { status: "failed" });

      expect(ghArgs()).toContainEqual(["issue", "close", "42", "--repo", "mnmal-ai/swarm"]);
    });

    it("reopens the issue when status goes back to pending", async () => {
      const currentBody = [
        "<!-- swarm-metadata-start -->",
        "```json",
        JSON.stringify({ status: "completed" }, null, 2),
        "```",
        "<!-- swarm-metadata-end -->",
      ].join("\n");
      cli
        .mockReturnValueOnce(JSON.stringify({ body: currentBody, state: "CLOSED" }))
        .mockReturnValueOnce("")  // issue edit (body)
        .mockReturnValueOnce("");  // issue reopen

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.updateTask("42", { status: "pending" });

      expect(ghArgs()).toContainEqual(["issue", "reopen", "42", "--repo", "mnmal-ai/swarm"]);
    });

    it("updates the issue title when description changes", async () => {
      const currentBody = [
        "<!-- swarm-metadata-start -->",
        "```json",
        JSON.stringify({ status: "pending" }, null, 2),
        "```",
        "<!-- swarm-metadata-end -->",
      ].join("\n");
      cli
        .mockReturnValueOnce(JSON.stringify({ body: currentBody, state: "OPEN" }))
        .mockReturnValueOnce("")  // issue edit (body)
        .mockReturnValueOnce("");  // issue edit (title)

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.updateTask("42", { description: "Updated description" });

      // Should have an edit call that sets --title
      expect(ghArgs()).toContainEqual(["issue", "edit", "42", "--repo", "mnmal-ai/swarm", "--title", "Updated description"]);
    });
  });

  // -------------------------------------------------------------------------
  // escalate(taskId, reason)
  // -------------------------------------------------------------------------

  describe("escalate(taskId, reason)", () => {
    it("adds swarm:escalated label and an ESCALATED comment", async () => {
      // escalate calls: edit (add label), then updateTask (view + edit + reopen), then addComment
      const currentBody = [
        "<!-- swarm-metadata-start -->",
        "```json",
        JSON.stringify({ status: "in_progress" }, null, 2),
        "```",
        "<!-- swarm-metadata-end -->",
      ].join("\n");
      cli
        .mockReturnValueOnce("")  // issue edit (add label)
        .mockReturnValueOnce(JSON.stringify({ body: currentBody, state: "OPEN" }))  // issue view (from updateTask)
        .mockReturnValueOnce("")  // issue edit body (from updateTask)
        .mockReturnValueOnce("")  // issue comment

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await backend.escalate("42", "Needs human review");

      // Should add the escalated label
      expect(ghArgs()).toContainEqual(["issue", "edit", "42", "--repo", "mnmal-ai/swarm", "--add-label", "swarm:escalated"]);

      // Should add a comment with ESCALATED reason
      expect(ghArgs()).toContainEqual(["issue", "comment", "42", "--repo", "mnmal-ai/swarm", "--body", "ESCALATED: Needs human review"]);
    });
  });

  // -------------------------------------------------------------------------
  // getTaskById(taskId)
  // -------------------------------------------------------------------------

  describe("getTaskById(taskId)", () => {
    it("retrieves a single task by issue number", async () => {
      const issue = makeTaskIssue({ number: 30, goalId: "goal-1" });
      cli.mockReturnValue(JSON.stringify(issue));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const task = await backend.getTaskById("30");

      expect(task).not.toBeNull();
      expect(task!.id).toBe("task-30");
      expect(task!.goal_id).toBe("goal-1");
    });

    it("returns null when the issue does not exist", async () => {
      cli.mockImplementation(() => {
        throw cliFailure("GraphQL: Could not resolve to an issue or pull request with the number of 999.", "gh issue view 999");
      });

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const task = await backend.getTaskById("999");
      expect(task).toBeNull();
    });

    it("populates source field with GitHub issue URL", async () => {
      const issue = makeTaskIssue({ number: 30, goalId: "goal-1" });
      cli.mockReturnValue(JSON.stringify(issue));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const task = await backend.getTaskById("30");

      expect(task).not.toBeNull();
      expect(task!.source).toEqual({
        type: "github",
        url: "https://github.com/mnmal-ai/swarm/issues/30",
        externalId: "30",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("surfaces gh CLI errors with descriptive message", async () => {
      cli.mockImplementation(() => {
        throw cliFailure("To get started with GitHub CLI, please run:  gh auth login", "gh issue list");
      });

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const error = await backend.getGoals().catch((err: unknown) => err as Error);
      expect(error.message).toMatch(/^gh CLI failed: Command failed: gh issue list/);
      expect(error.message).toContain("gh auth login");
    });

    it("surfaces non-Error throwables", async () => {
      cli.mockImplementation(() => {
        throw "some string error"; // eslint-disable-line no-throw-literal
      });

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      await expect(backend.getGoals()).rejects.toThrow("gh CLI failed: some string error");
    });
  });

  // -------------------------------------------------------------------------
  // getAllTasks()
  // -------------------------------------------------------------------------

  describe("getAllTasks()", () => {
    it("returns all tasks without filtering by goal_id", async () => {
      const issues = [
        makeTaskIssue({ number: 20, goalId: "goal-1" }),
        makeTaskIssue({ number: 21, goalId: "goal-2" }),
      ];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const tasks = await backend.getAllTasks();
      expect(tasks).toHaveLength(2);
    });

    it("populates source field on all returned tasks", async () => {
      const issues = [
        makeTaskIssue({ number: 20, goalId: "goal-1" }),
        makeTaskIssue({ number: 21, goalId: "goal-2" }),
      ];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const tasks = await backend.getAllTasks();
      expect(tasks.every((t) => t.source?.type === "github")).toBe(true);
      expect(tasks[0].source?.url).toBe("https://github.com/mnmal-ai/swarm/issues/20");
      expect(tasks[0].source?.externalId).toBe("20");
    });
  });

  // -------------------------------------------------------------------------
  // Source tracking on getTasks
  // -------------------------------------------------------------------------

  describe("source tracking", () => {
    it("populates source on tasks returned by getTasks()", async () => {
      const issues = [makeTaskIssue({ number: 25, goalId: "goal-1" })];
      cli.mockReturnValue(JSON.stringify(issues));

      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      const tasks = await backend.getTasks("goal-1");

      expect(tasks).toHaveLength(1);
      expect(tasks[0].source).toEqual({
        type: "github",
        url: "https://github.com/mnmal-ai/swarm/issues/25",
        externalId: "25",
      });
    });
  });

  // -------------------------------------------------------------------------
  // How gh is run
  // -------------------------------------------------------------------------

  describe("running gh", () => {
    it("runs it without a shell: every value is its own argv entry, verbatim", async () => {
      const comment = `it's "done" $(touch pwned) \`id\`; rm -rf ~ && echo $HOME | cat > out`;
      const taskId = "42; touch pwned";

      await new GitHubTaskBackend("mnmal-ai/swarm").addComment(taskId, comment);

      const [call] = execFileCalls(mockExecFile);
      expect(call.file).toBe("gh");
      expect(call.args).toEqual(["issue", "comment", taskId, "--repo", "mnmal-ai/swarm", "--body", comment]);
      expect(call.options.shell).toBeFalsy();
      expect(call.options).toMatchObject({ timeout: 30_000 });
      expect(call.stdinClosed).toBe(true);
      expect(call.stdin).toBeUndefined();
    });

    it("does not block the event loop while gh runs", async () => {
      let exit: (() => void) | undefined;
      mockExecFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        exit = () => callback(null, JSON.stringify([makeGoalIssue()]), "");
        return fakeChild();
      });
      const order: string[] = [];

      const goals = new GitHubTaskBackend("mnmal-ai/swarm").getGoals().then((result) => {
        order.push("gh finished");
        return result;
      });

      // gh has started and the caller has control back: a timer gets to run.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setTimeout(() => (order.push("timer"), resolve()), 0));
      expect(order).toEqual(["timer"]);

      // The call settles only when gh exits, with what gh printed.
      exit!();
      expect(await goals).toHaveLength(1);
      expect(order).toEqual(["timer", "gh finished"]);
    });
  });

  // -------------------------------------------------------------------------
  // createTasksEnabled property
  // -------------------------------------------------------------------------

  describe("createTasksEnabled", () => {
    it("defaults to false when no options provided", () => {
      const backend = new GitHubTaskBackend("mnmal-ai/swarm");
      expect(backend.createTasksEnabled).toBe(false);
    });

    it("defaults to false when options are provided but createTasks is undefined", () => {
      const backend = new GitHubTaskBackend("mnmal-ai/swarm", {});
      expect(backend.createTasksEnabled).toBe(false);
    });

    it("is false when explicitly set to false", () => {
      const backend = new GitHubTaskBackend("mnmal-ai/swarm", { createTasks: false });
      expect(backend.createTasksEnabled).toBe(false);
    });

    it("is true when explicitly set to true", () => {
      const backend = new GitHubTaskBackend("mnmal-ai/swarm", { createTasks: true });
      expect(backend.createTasksEnabled).toBe(true);
    });
  });
});
