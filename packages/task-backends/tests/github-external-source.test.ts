import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { execFile } from "node:child_process";
import { GitHubExternalSource } from "../src/github-external-source.js";
import type { ExternalItem, Goal } from "@mnmal-ai/swarm-types";
import { cli, cliFailure, execFileCalls, fakeChild, type ExecFileCallback } from "./helpers/fake-child-process.js";

// ---------------------------------------------------------------------------
// Mock the child_process module so gh never runs; `cli` plays it
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async () => (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());

const mockExecFile = execFile as unknown as Mock;

function resetCli(): void {
  cli.mockReset();
  mockExecFile.mockClear();
}

function ghArgs(): string[][] {
  return execFileCalls(mockExecFile).map((call) => call.args);
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    description: "Implement auth flow",
    priority: 0,
    status: "pending",
    constraints: [],
    acceptance_criteria: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ExternalItem> = {}): ExternalItem {
  return {
    externalId: overrides.externalId ?? "1",
    title: overrides.title ?? "Implement auth flow",
    body: overrides.body ?? "",
    state: overrides.state ?? "open",
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://github.com/mnmal-ai/swarm/issues/1",
  };
}

/**
 * Build a full markdown body with all sections populated.
 */
function fullBody(): string {
  return [
    "## Acceptance Criteria",
    "- [ ] Users can log in with OAuth",
    "- [x] Session persists across refreshes",
    "- [ ] Logout clears tokens",
    "",
    "## Constraints",
    "- Must use TypeScript",
    "- No external auth libraries",
    "",
    "## Designs",
    "- `designs/login-page.png`",
    "- `designs/oauth-flow.svg`",
    "",
    "## Dependencies",
    "Depends on #5",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubExternalSource — parseGoal", () => {
  beforeEach(() => {
    resetCli();
  });

  // -------------------------------------------------------------------------
  // Full markdown body
  // -------------------------------------------------------------------------

  describe("full markdown body", () => {
    it("extracts acceptance criteria from checkboxes", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body: fullBody() }));

      expect(goal.acceptance_criteria).toEqual([
        "Users can log in with OAuth",
        "Session persists across refreshes",
        "Logout clears tokens",
      ]);
    });

    it("extracts constraints from bullet items", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body: fullBody() }));

      expect(goal.constraints).toEqual([
        "Must use TypeScript",
        "No external auth libraries",
      ]);
    });

    it("extracts designs from backtick-wrapped items", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body: fullBody() }));

      expect(goal.designs).toEqual([
        "designs/login-page.png",
        "designs/oauth-flow.svg",
      ]);
    });

    it("extracts dependencies as gh-prefixed IDs", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body: fullBody() }));

      expect(goal.dependsOn).toEqual(["gh-5"]);
    });

    it("sets id as gh-<externalId>", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ externalId: "42" }));

      expect(goal.id).toBe("gh-42");
    });

    it("uses item title as goal description", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(
        makeItem({ title: "Build the feature" }),
      );

      expect(goal.description).toBe("Build the feature");
    });

    it("links the goal to its issue", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });

      expect(source.parseGoal(makeItem({ url: "https://github.com/mnmal-ai/swarm/issues/42" })).url).toBe(
        "https://github.com/mnmal-ai/swarm/issues/42",
      );
      expect(source.parseGoal(makeItem({ url: "" }))).not.toHaveProperty("url");
    });

    it("maps open state to pending status", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ state: "open" }));

      expect(goal.status).toBe("pending");
    });

    it("maps closed state to completed status", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ state: "closed" }));

      expect(goal.status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // Missing sections
  // -------------------------------------------------------------------------

  describe("missing sections", () => {
    it("returns empty arrays when no constraints section exists", () => {
      const body = [
        "## Acceptance Criteria",
        "- [ ] Works correctly",
      ].join("\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.constraints).toEqual([]);
      expect(goal.acceptance_criteria).toEqual(["Works correctly"]);
    });

    it("returns undefined designs when no Designs section exists", () => {
      const body = [
        "## Acceptance Criteria",
        "- [ ] Works correctly",
        "",
        "## Constraints",
        "- Must be fast",
      ].join("\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.designs).toBeUndefined();
    });

    it("returns undefined dependsOn when no Dependencies section exists", () => {
      const body = [
        "## Acceptance Criteria",
        "- [ ] Works correctly",
      ].join("\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.dependsOn).toBeUndefined();
    });

    it("handles completely empty body", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body: "" }));

      expect(goal.acceptance_criteria).toEqual([]);
      expect(goal.constraints).toEqual([]);
      expect(goal.designs).toBeUndefined();
      expect(goal.dependsOn).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // CRLF line endings
  // -------------------------------------------------------------------------

  describe("CRLF line endings", () => {
    it("parses sections correctly with CRLF", () => {
      const body = [
        "## Acceptance Criteria",
        "- [ ] Users can log in",
        "- [ ] Session persists",
        "",
        "## Constraints",
        "- Must use TypeScript",
        "",
        "## Designs",
        "- `designs/mockup.png`",
        "",
        "## Dependencies",
        "Depends on #3",
      ].join("\r\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.acceptance_criteria).toEqual([
        "Users can log in",
        "Session persists",
      ]);
      expect(goal.constraints).toEqual(["Must use TypeScript"]);
      expect(goal.designs).toEqual(["designs/mockup.png"]);
      expect(goal.dependsOn).toEqual(["gh-3"]);
    });
  });

  // -------------------------------------------------------------------------
  // Priority label parsing
  // -------------------------------------------------------------------------

  describe("priority label parsing", () => {
    it("extracts numeric priority from priority:N label", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(
        makeItem({ labels: ["swarm:goal", "priority:2"] }),
      );

      expect(goal.priority).toBe(2);
    });

    it("produces NaN for malformed priority label like priority:high", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(
        makeItem({ labels: ["swarm:goal", "priority:high"] }),
      );

      // Number.isFinite guard ensures malformed labels fall back to 0.
      expect(goal.priority).toBe(0);
    });

    it("defaults priority to 0 when no priority label exists", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(
        makeItem({ labels: ["swarm:goal", "enhancement"] }),
      );

      expect(goal.priority).toBe(0);
    });

    it("defaults priority to 0 when labels array is empty", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ labels: [] }));

      expect(goal.priority).toBe(0);
    });

    it("picks the first priority label if multiple exist", () => {
      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(
        makeItem({ labels: ["priority:3", "priority:1"] }),
      );

      // Array.find returns the first match
      expect(goal.priority).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple dependency references
  // -------------------------------------------------------------------------

  describe("multiple dependencies", () => {
    it("extracts all #N references from Dependencies section", () => {
      const body = [
        "## Dependencies",
        "Depends on #2, #3, #4",
      ].join("\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.dependsOn).toEqual(["gh-2", "gh-3", "gh-4"]);
    });

    it("extracts dependencies on separate lines", () => {
      const body = [
        "## Dependencies",
        "- Depends on #10",
        "- Also depends on #11",
      ].join("\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.dependsOn).toEqual(["gh-10", "gh-11"]);
    });

    it("returns undefined dependsOn when Dependencies section has no #N refs", () => {
      const body = [
        "## Dependencies",
        "No dependencies at this time.",
      ].join("\n");

      const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });
      const goal = source.parseGoal(makeItem({ body }));

      expect(goal.dependsOn).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// gh calls
// ---------------------------------------------------------------------------

describe("GitHubExternalSource — gh calls", () => {
  beforeEach(() => {
    resetCli();
  });

  it("lists open goal issues in the configured repo, with a 30 s timeout", async () => {
    cli.mockReturnValue(JSON.stringify([
      { number: 7, title: "Ship it", body: null, state: "OPEN", labels: [{ name: "swarm:goal" }], url: "" },
    ]));

    const items = await new GitHubExternalSource({ repo: "mnmal-ai/swarm" }).fetchItems();

    expect(items).toEqual([{
      externalId: "7",
      title: "Ship it",
      body: "",
      state: "open",
      labels: ["swarm:goal"],
      url: "https://github.com/mnmal-ai/swarm/issues/7",
    }]);
    const [{ file, args, options }] = execFileCalls(mockExecFile);
    expect(file).toBe("gh");
    expect(args).toEqual([
      "issue", "list", "--repo", "mnmal-ai/swarm",
      "--label", "swarm:goal", "--state", "open",
      "--json", "number,title,body,state,labels,url", "--limit", "100",
    ]);
    expect(options).toMatchObject({ timeout: 30_000 });
  });

  it("runs gh without a shell: argv reaches it verbatim, and stdin is closed", async () => {
    cli.mockReturnValue("https://github.com/mnmal-ai/swarm/issues/12\n");
    const title = `it's "done" $(touch pwned) \`id\`; rm -rf ~ && echo $HOME | cat > out`;

    const id = await new GitHubExternalSource({ repo: "mnmal-ai/swarm" }).pushTask(
      { id: "t", goal_id: "g", title, description: "x", intent: "implement", status: "pending", order: 1 },
      "3",
    );

    expect(id).toBe("12");
    const create = execFileCalls(mockExecFile).find((call) => call.args[1] === "create" && call.args[0] === "issue")!;
    expect(create.file).toBe("gh");
    expect(create.args).toEqual([
      "issue", "create", "--repo", "mnmal-ai/swarm",
      "--title", title, "--body", "Part of #3\n\nx", "--label", "swarm:task",
    ]);
    expect(create.options.shell).toBeFalsy();
    expect(create.stdinClosed).toBe(true);
    expect(create.stdin).toBeUndefined();
  });

  it("does not block the event loop while gh runs", async () => {
    let exit: (() => void) | undefined;
    mockExecFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      exit = () => callback(null, "", "");
      return fakeChild();
    });
    const order: string[] = [];

    const comment = new GitHubExternalSource({ repo: "mnmal-ai/swarm" })
      .postComment("7", "Started.")
      .then(() => order.push("gh finished"));

    // gh has started and the caller has control back: a timer gets to run.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setTimeout(() => (order.push("timer"), resolve()), 0));
    expect(order).toEqual(["timer"]);

    // The call settles only when gh exits.
    exit!();
    await comment;
    expect(order).toEqual(["timer", "gh finished"]);
  });

  it("creates swarm's labels once, before any issue, even when pushes overlap", async () => {
    cli.mockImplementation((_file, args) => (args[0] === "issue" ? "https://github.com/mnmal-ai/swarm/issues/1\n" : ""));
    const source = new GitHubExternalSource({ repo: "mnmal-ai/swarm" });

    await Promise.all([source.pushGoal(makeGoal()), source.pushGoal(makeGoal({ description: "Second" }))]);

    expect(ghArgs().map((args) => `${args[0]} ${args[1]} ${args[2]}`)).toEqual([
      "label create swarm:goal",
      "label create swarm:task",
      "issue create --repo",
      "issue create --repo",
    ]);
  });

  it("surfaces gh's own error when it fails", async () => {
    cli.mockImplementation(() => {
      throw cliFailure("HTTP 401: Bad credentials (https://api.github.com/graphql)", "gh issue comment 7");
    });

    const error = await new GitHubExternalSource({ repo: "mnmal-ai/swarm" })
      .postComment("7", "Started.")
      .catch((err: unknown) => err as Error);

    expect(error.message).toMatch(/^gh CLI failed: Command failed: gh issue comment 7/);
    expect(error.message).toContain("HTTP 401: Bad credentials");
  });

  it("treats a failed reopen as an issue that is already open", async () => {
    cli.mockImplementation(() => {
      throw cliFailure("issue #7 is already open", "gh issue reopen 7");
    });

    await expect(new GitHubExternalSource({ repo: "mnmal-ai/swarm" }).updateStatus("7", "in_progress")).resolves.toBeUndefined();
    expect(ghArgs()).toEqual([["issue", "reopen", "7", "--repo", "mnmal-ai/swarm"]]);
  });
});

describe("GitHubExternalSource — postGoalSummary", () => {
  it("reports the goal's tokens and no dollar amount", async () => {
    const source = new GitHubExternalSource({ repo: "sample-org/sample-repo" });
    const posted: string[] = [];
    (source as unknown as { postComment: (id: string, body: string) => Promise<void> }).postComment = async (_id, body) => {
      posted.push(body);
    };

    await source.postGoalSummary("42", { tasksCompleted: 3, tasksFailed: 0, tokens: 10_550_000, durationMs: 600_000 });

    expect(posted[0]).toContain("10.55M tokens");
    expect(posted[0]).not.toMatch(/\$/);
  });
});
