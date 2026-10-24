/**
 * Tests for the goal-source helpers `swarm run` uses to take goals from a
 * Trello board and to brief the planner on a goal.
 */

import { describe, it, expect } from "vitest";
import type { Goal } from "@mnmal-ai/swarm-types";
import { formatGoalBrief, trelloSourceOptions } from "../src/cli/goal-source.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "trello-aaa111",
    description: "Show saved searches on the dashboard",
    priority: 0,
    status: "pending",
    constraints: ["Keep the public API unchanged"],
    acceptance_criteria: ["A viewer sees every saved search"],
    ...overrides,
  };
}

describe("formatGoalBrief", () => {
  it("states the goal, its acceptance criteria and its constraints", () => {
    const brief = formatGoalBrief(goal()).join("\n");

    expect(brief).toContain("## Goal: Show saved searches on the dashboard");
    expect(brief).toContain("## Acceptance Criteria\n- A viewer sees every saved search");
    expect(brief).toContain("## Constraints\n- Keep the public API unchanged");
  });

  it("includes the source ticket in full when the goal has one", () => {
    const brief = formatGoalBrief(goal({ context: "Card: https://trello.com/c/aaa111\n\n## Details\n\n**Viewers**" })).join("\n");

    expect(brief).toContain("## Ticket\n\nCard: https://trello.com/c/aaa111\n\n## Details\n\n**Viewers**");
  });

  it("omits the ticket section when there is none", () => {
    expect(formatGoalBrief(goal()).join("\n")).not.toContain("## Ticket");
  });

  it("appends design references to the goal line", () => {
    const brief = formatGoalBrief(goal(), "\n\n## Design References\n\nfigma").join("\n");

    expect(brief).toContain("## Goal: Show saved searches on the dashboard\n\n## Design References\n\nfigma");
  });
});

describe("trelloSourceOptions", () => {
  it("maps the project config onto source options, running the CLI from the repo root", () => {
    const options = trelloSourceOptions(
      {
        command: ["./bin/trello-cli"],
        boards: ["board-a", "board-b", "board-c"],
        queue_list: "To Do",
        per_board: 2,
        lists: { completed: "Review" },
      },
      "/work/repo",
    );

    expect(options).toEqual({
      command: ["./bin/trello-cli"],
      cwd: "/work/repo",
      boards: ["board-a", "board-b", "board-c"],
      queueList: "To Do",
      perBoard: 2,
      lists: { completed: "Review" },
    });
  });

  it("explains what is missing when the trello block is absent", () => {
    expect(() => trelloSourceOptions(undefined, "/work/repo")).toThrow(/taskBackendConfig\.trello/);
  });

  it("explains what is missing when there is no command or no board", () => {
    expect(() => trelloSourceOptions({ command: [], boards: ["board-a"] }, "/r")).toThrow(/command/);
    expect(() => trelloSourceOptions({ command: ["t"], boards: [] }, "/r")).toThrow(/boards/);
  });
});
