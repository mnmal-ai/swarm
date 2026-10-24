export { LocalTaskBackend } from "./local.js";
export { GitHubTaskBackend } from "./github.js";
export { GitHubExternalSource } from "./github-external-source.js";
export type { GitHubExternalSourceOptions } from "./github-external-source.js";
export { TrelloExternalSource } from "./trello-external-source.js";
export type { TrelloExternalSourceOptions } from "./trello-external-source.js";
export { syncGoalLifecycle, formatLeftForPersonComment } from "./external-source-sync.js";
export { splitFromLabels } from "./labels.js";
export type { GoalLifecycleSyncOptions } from "./external-source-sync.js";

import type { TaskBackend, GitHubCredential } from "@mnmal-ai/swarm-types";
import { LocalTaskBackend } from "./local.js";
import { GitHubTaskBackend } from "./github.js";

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface LocalTaskBackendOptions {
  storageDir: string;
}

export interface GitHubTaskBackendOptions {
  repo?: string;
  /** When true, swarm creates new tasks as GitHub issues. Default: false. */
  createTasks?: boolean;
  /** The account every gh call runs as (source_control.github_account). */
  credential?: GitHubCredential;
}

export type TaskBackendOptions =
  | ({ type: "local" } & LocalTaskBackendOptions)
  | ({ type: "github" } & GitHubTaskBackendOptions);

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a TaskBackend instance based on the specified type.
 *
 * @example
 * ```ts
 * const local = createTaskBackend({ type: "local", storageDir: "/tmp/swarm-tasks" });
 * const github = createTaskBackend({ type: "github", repo: "mnmal-ai/swarm" });
 * const githubReadOnly = createTaskBackend({ type: "github", repo: "mnmal-ai/swarm", createTasks: false });
 * ```
 */
export function createTaskBackend(options: TaskBackendOptions): TaskBackend {
  switch (options.type) {
    case "local":
      return new LocalTaskBackend(options.storageDir);
    case "github":
      return new GitHubTaskBackend(options.repo, {
        createTasks: options.createTasks,
        credential: options.credential,
      });
    default: {
      const exhaustive: never = options;
      throw new Error(`Unknown task backend type: ${(exhaustive as TaskBackendOptions).type}`);
    }
  }
}
