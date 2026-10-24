/**
 * Helpers for where `swarm run` gets its goals and how it briefs the planner
 * on one. Kept out of run.ts so they can be tested without a run.
 */

import type { Goal, TrelloSourceConfig } from "@mnmal-ai/swarm-types";
import type { TrelloExternalSourceOptions } from "@mnmal-ai/swarm-task-backends";

/**
 * The goal as the planner reads it: the goal line (with any design
 * references), the source ticket in full when there is one, then the
 * acceptance criteria and constraints.
 */
export function formatGoalBrief(goal: Goal, designContext = ""): string[] {
  return [
    `## Goal: ${goal.description}${designContext}`,
    "",
    ...(goal.context ? [`## Ticket`, "", goal.context, ""] : []),
    `## Acceptance Criteria`,
    ...goal.acceptance_criteria.map((c) => `- ${c}`),
    "",
    `## Constraints`,
    ...goal.constraints.map((c) => `- ${c}`),
  ];
}

/** Map the project's `taskBackendConfig.trello` block onto source options. */
export function trelloSourceOptions(
  config: TrelloSourceConfig | undefined,
  repoRoot: string,
): TrelloExternalSourceOptions {
  if (!config) {
    throw new Error(
      'task backend "trello" needs taskBackendConfig.trello in config.json: { "command": [...], "boards": [...] }',
    );
  }
  if (!config.command || config.command.length === 0) {
    throw new Error("taskBackendConfig.trello.command must name the Trello CLI to run, e.g. [\"./bin/trello-cli\"]");
  }
  if (!config.boards || config.boards.length === 0) {
    throw new Error("taskBackendConfig.trello.boards must list at least one board to take work from");
  }
  return {
    command: config.command,
    cwd: repoRoot,
    boards: config.boards,
    queueList: config.queue_list,
    perBoard: config.per_board,
    lists: config.lists,
  };
}
