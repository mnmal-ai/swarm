import type { Goal, Task, TaskUpdate, TaskBackend, TaskResult, TaskSource, GitHubCredential } from "@mnmal-ai/swarm-types";
import { SUCCESS_TASK_STATUSES, currentTaskStatus } from "@mnmal-ai/swarm-types";
import {
  GOAL_LABEL, TASK_LABEL, ESCALATED_LABEL,
  STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED, STATUS_COLORS,
} from "./labels.js";
import { runCli } from "./run-cli.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GitHubTaskBackendConstructorOptions {
  /** When true, swarm creates new tasks as GitHub issues. Default: false. */
  createTasks?: boolean;
  /** The account every gh call runs as (source_control.github_account).
   *  Absent: gh's active account. */
  credential?: GitHubCredential;
}

// ---------------------------------------------------------------------------
// GitHubTaskBackend — gh CLI-based implementation of TaskBackend
// ---------------------------------------------------------------------------

/**
 * A task backend that uses GitHub Issues via the `gh` CLI as the persistence
 * layer. Designed for team workflows where visibility and collaboration
 * matter more than raw speed.
 *
 * Mapping:
 *   Goal  -> GitHub Issue with `swarm:goal` label
 *   Task  -> GitHub Issue with `swarm:task` label
 *   Comment -> GitHub Issue comment
 *   Escalation -> `swarm:escalated` label + comment
 *
 * The `gh` CLI must be installed and authenticated. If no `repo` is provided,
 * it auto-detects from the current git remote.
 */
export class GitHubTaskBackend implements TaskBackend {
  private readonly repoArgs: string[];
  private readonly repo: string | undefined;
  private readonly credential: GitHubCredential | undefined;

  /** Whether createTask() creates GitHub issues. When false, returns the
   *  task's own ID without calling the gh CLI (local-only fallback). */
  readonly createTasksEnabled: boolean;

  constructor(repo?: string, options?: GitHubTaskBackendConstructorOptions) {
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`Invalid repo format: ${repo}. Expected "owner/repo".`);
    }
    this.repo = repo || undefined;
    this.repoArgs = repo ? ["--repo", repo] : [];
    this.createTasksEnabled = options?.createTasks === true;
    this.credential = options?.credential;
  }

  /** Returns the configured repo string (e.g. "owner/repo"), or undefined
   *  if the backend relies on auto-detection from the git remote. */
  getRepo(): string | undefined {
    return this.repo;
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  async getGoals(): Promise<Goal[]> {
    const raw = await this.gh([
      "issue", "list", ...this.repoArgs,
      "--label", GOAL_LABEL, "--state", "all", "--json", "number,title,body,state", "--limit", "100",
    ]);

    const issues = JSON.parse(raw) as GitHubIssue[];
    return issues.map((issue) => this.issueToGoal(issue));
  }

  async createGoal(goal: Goal): Promise<string> {
    const body = this.goalToBody(goal);
    const raw = await this.gh([
      "issue", "create", ...this.repoArgs,
      "--title", goal.description, "--body", body, "--label", GOAL_LABEL,
    ]);

    // gh issue create outputs the URL of the created issue
    const issueUrl = raw.trim();
    const issueNumber = this.extractIssueNumber(issueUrl);
    return issueNumber;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  async getTasks(goalId: string): Promise<Task[]> {
    const raw = await this.gh([
      "issue", "list", ...this.repoArgs,
      "--label", TASK_LABEL, "--state", "all", "--json", "number,title,body,state", "--limit", "100",
    ]);

    const issues = JSON.parse(raw) as GitHubIssue[];
    return issues
      .map((issue) => this.issueToTask(issue))
      .filter((task) => task.goal_id === goalId);
  }

  async getAllTasks(): Promise<Task[]> {
    const raw = await this.gh([
      "issue", "list", ...this.repoArgs,
      "--label", TASK_LABEL, "--state", "all", "--json", "number,title,body,state", "--limit", "100",
    ]);

    const issues = JSON.parse(raw) as GitHubIssue[];
    return issues.map((issue) => this.issueToTask(issue));
  }

  async getTaskById(taskId: string): Promise<Task | null> {
    try {
      const raw = await this.gh([
        "issue", "view", taskId, ...this.repoArgs, "--json", "number,title,body,state",
      ]);
      const issue = JSON.parse(raw) as GitHubIssue;
      return this.issueToTask(issue);
    } catch {
      return null;
    }
  }

  async createTask(task: Task): Promise<string> {
    // When createTasks is disabled, return the task's own ID without
    // calling the gh CLI — the caller should fall back to local storage.
    if (!this.createTasksEnabled) {
      return task.id;
    }

    // Use the short title for the issue title, falling back to a
    // truncated description if no title is set.
    const title = task.title || task.description.slice(0, 120);

    // Add a goal label so tasks can be filtered by parent goal.
    const goalNum = task.goal_id.replace(/^gh-/, "");
    const labels = [TASK_LABEL];
    if (/^\d+$/.test(goalNum)) {
      const goalLabel = `goal:${goalNum}`;
      // Ensure the label exists (gh issue create doesn't auto-create labels)
      try {
        await this.gh([
          "label", "create", goalLabel, ...this.repoArgs,
          "--color", "C5DEF5", "--description", `Tasks for goal #${goalNum}`, "--force",
        ]);
      } catch { /* label may already exist */ }
      labels.push(goalLabel);
    }

    const body = this.taskToBody(task);
    const raw = await this.gh([
      "issue", "create", ...this.repoArgs,
      "--title", title, "--body", body, "--label", labels.join(","),
    ]);

    const issueUrl = raw.trim();
    const issueNumber = this.extractIssueNumber(issueUrl);

    // Link as a real sub-issue of the parent goal via the GitHub API.
    if (/^\d+$/.test(goalNum) && this.repo) {
      try {
        // Get the task issue's database ID (required by the sub-issues API).
        const issueJson = await this.gh([
          "api", `repos/${this.repo}/issues/${issueNumber}`, "--jq", ".id",
        ]);
        const issueId = parseInt(issueJson.trim(), 10);
        if (!isNaN(issueId)) {
          await this.ghWithInput(
            ["api", `repos/${this.repo}/issues/${goalNum}/sub_issues`, "--method", "POST", "--input", "-"],
            JSON.stringify({ sub_issue_id: issueId }),
          );
        }
      } catch {
        // Sub-issues API may not be available — silently fall back to
        // the "Part of #N" text reference in the body.
      }
    }

    return issueNumber;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<void> {
    // Read the current issue to get the existing body
    const raw = await this.gh([
      "issue", "view", taskId, ...this.repoArgs, "--json", "body,state",
    ]);
    const issue = JSON.parse(raw) as { body: string; state: string };
    const metadata = this.parseMetadata(issue.body);

    // Apply updates to the metadata
    if (update.status !== undefined) {
      metadata.status = update.status;
    }
    if (update.result !== undefined) {
      metadata.result = update.result;
    }
    if (update.description !== undefined) {
      metadata.description = update.description;
    }

    // Replace only the metadata section in the existing body, preserving
    // all human-readable content (description, "Part of #N", files, etc.).
    const newBody = this.replaceMetadata(issue.body, metadata);
    await this.gh(["issue", "edit", taskId, ...this.repoArgs, "--body", newBody]);

    // Update issue title if description changed
    if (update.description !== undefined) {
      await this.gh(["issue", "edit", taskId, ...this.repoArgs, "--title", update.description]);
    }

    // Update status label and close/reopen the issue
    if (update.status !== undefined) {
      // Remove any existing status labels, then add the new one
      const statusLabels = [STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED];
      for (const label of statusLabels) {
        try {
          await this.gh(["issue", "edit", taskId, ...this.repoArgs, "--remove-label", label]);
        } catch { /* label may not be present */ }
      }

      const labelMap: Record<string, string | undefined> = {
        in_progress: STATUS_IN_PROGRESS,
        completed: STATUS_COMPLETED,
        completed_with_notes: STATUS_COMPLETED,
        completed_with_deferrals: STATUS_COMPLETED,
        failed: STATUS_FAILED,
      };
      const newLabel = labelMap[update.status];
      if (newLabel) {
        try {
          await this.gh([
            "label", "create", newLabel, ...this.repoArgs,
            "--color", STATUS_COLORS[newLabel] || "EDEDED", "--force",
          ]);
          await this.gh(["issue", "edit", taskId, ...this.repoArgs, "--add-label", newLabel]);
        } catch { /* best-effort */ }
      }

      if (SUCCESS_TASK_STATUSES.has(update.status) || update.status === "failed") {
        await this.gh(["issue", "close", taskId, ...this.repoArgs]);
      } else if (update.status === "pending" || update.status === "in_progress") {
        try { await this.gh(["issue", "reopen", taskId, ...this.repoArgs]); } catch { /* may already be open */ }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  async addComment(taskId: string, comment: string): Promise<void> {
    await this.gh(["issue", "comment", taskId, ...this.repoArgs, "--body", comment]);
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  async escalate(taskId: string, reason: string): Promise<void> {
    // Add the escalated label
    await this.gh(["issue", "edit", taskId, ...this.repoArgs, "--add-label", ESCALATED_LABEL]);

    // Update the task status to blocked
    await this.updateTask(taskId, { status: "blocked" });

    // Add an escalation comment
    await this.addComment(taskId, `ESCALATED: ${reason}`);
  }

  // -------------------------------------------------------------------------
  // Private helpers — gh CLI wrapper
  // -------------------------------------------------------------------------

  /**
   * Run a gh command: asynchronously, with no shell (see runCli). Every value
   * — titles, bodies, labels, IDs — is its own argv entry and reaches gh
   * verbatim, so none of it needs quoting or can be read as shell syntax.
   */
  private async gh(args: string[]): Promise<string> {
    return this.ghWithInput(args, undefined);
  }

  /** Run a gh command with `input` on its stdin (for `--input -`), as the
   *  configured account when there is one. */
  private async ghWithInput(args: string[], input: string | undefined): Promise<string> {
    try {
      return await runCli("gh", args, { input, env: this.credential?.env() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`gh CLI failed: ${this.credential ? this.credential.redact(message) : message}`);
    }
  }

  private extractIssueNumber(output: string): string {
    // gh issue create outputs a URL like https://github.com/owner/repo/issues/42
    const match = output.match(/\/issues\/(\d+)/);
    if (match) {
      return match[1];
    }
    // Fallback: the output itself might just be a number
    const numMatch = output.trim().match(/(\d+)/);
    return numMatch ? numMatch[1] : output.trim();
  }

  // -------------------------------------------------------------------------
  // Private helpers — source tracking
  // -------------------------------------------------------------------------

  private makeSource(issueNumber: number): TaskSource {
    return {
      type: "github",
      url: this.repo ? `https://github.com/${this.repo}/issues/${issueNumber}` : undefined,
      externalId: String(issueNumber),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers — serialization
  // -------------------------------------------------------------------------

  /**
   * Encode structured data into the issue body as a JSON block within
   * a markdown code fence so it survives round-trips through GitHub.
   */
  private goalToBody(goal: Goal): string {
    const metadata = {
      id: goal.id,
      priority: goal.priority,
      status: goal.status,
      constraints: goal.constraints,
      acceptance_criteria: goal.acceptance_criteria,
    };
    return this.buildBody(metadata);
  }

  private taskToBody(task: Task): string {
    const sections: string[] = [];

    // Link to parent goal issue. Extract the numeric ID from goal_id
    // formats like "gh-1" or plain "1".
    const goalNum = task.goal_id.replace(/^gh-/, "");
    if (/^\d+$/.test(goalNum)) {
      sections.push(`Part of #${goalNum}`);
      sections.push("");
    }

    // Human-readable description
    sections.push(task.description);
    sections.push("");

    // Files this task creates or modifies
    if (task.createsFiles && task.createsFiles.length > 0) {
      sections.push("### Files");
      for (const f of task.createsFiles) {
        sections.push(`- Creates: \`${f}\``);
      }
      if (task.serializedFiles && task.serializedFiles.length > 0) {
        for (const f of task.serializedFiles) {
          sections.push(`- Modifies: \`${f}\``);
        }
      }
      sections.push("");
    }

    // Metadata block (collapsible). Include the full description so
    // round-tripping via issueToTask recovers it (the issue title is truncated).
    const metadata: Record<string, unknown> = {
      id: task.id,
      goal_id: task.goal_id,
      intent: task.intent,
      status: task.status,
      order: task.order,
      description: task.description,
    };
    if (task.result) {
      metadata.result = task.result;
    }

    sections.push("<details>");
    sections.push("<summary>Swarm metadata</summary>");
    sections.push("");
    sections.push("<!-- swarm-metadata-start -->");
    sections.push("```json");
    sections.push(JSON.stringify(metadata, null, 2));
    sections.push("```");
    sections.push("<!-- swarm-metadata-end -->");
    sections.push("");
    sections.push("</details>");

    return sections.join("\n");
  }

  private buildBody(metadata: Record<string, unknown>): string {
    return [
      "<!-- swarm-metadata-start -->",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```",
      "<!-- swarm-metadata-end -->",
    ].join("\n");
  }

  private parseMetadata(body: string): Record<string, unknown> {
    const match = body.match(
      /<!-- swarm-metadata-start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- swarm-metadata-end -->/
    );
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[1]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Replace only the metadata JSON block inside an existing issue body,
   * preserving all surrounding human-readable content.
   */
  private replaceMetadata(existingBody: string, metadata: Record<string, unknown>): string {
    const metadataBlock = [
      "<!-- swarm-metadata-start -->",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```",
      "<!-- swarm-metadata-end -->",
    ].join("\n");

    // Try to replace the existing metadata block in-place
    const pattern = /<!-- swarm-metadata-start -->[\s\S]*?<!-- swarm-metadata-end -->/;
    if (pattern.test(existingBody)) {
      return existingBody.replace(pattern, metadataBlock);
    }

    // No existing metadata block — append it
    return existingBody + "\n\n" + metadataBlock;
  }

  // -------------------------------------------------------------------------
  // Private helpers — deserialization
  // -------------------------------------------------------------------------

  private issueToGoal(issue: GitHubIssue): Goal {
    const metadata = this.parseMetadata(issue.body ?? "");
    return {
      id: (metadata.id as string) ?? String(issue.number),
      description: issue.title,
      priority: (metadata.priority as number) ?? 0,
      status: (metadata.status as Goal["status"]) ?? this.ghStateToGoalStatus(issue.state),
      constraints: (metadata.constraints as string[]) ?? [],
      acceptance_criteria: (metadata.acceptance_criteria as string[]) ?? [],
    };
  }

  private issueToTask(issue: GitHubIssue): Task {
    const metadata = this.parseMetadata(issue.body ?? "");
    const task: Task = {
      id: (metadata.id as string) ?? String(issue.number),
      goal_id: (metadata.goal_id as string) ?? "",
      description: (metadata.description as string) ?? issue.title,
      intent: (metadata.intent as string) ?? "unknown",
      status: typeof metadata.status === "string" ? currentTaskStatus(metadata.status) : this.ghStateToTaskStatus(issue.state),
      order: (metadata.order as number) ?? 0,
      source: this.makeSource(issue.number),
    };
    if (metadata.result) {
      task.result = metadata.result as TaskResult;
    }
    return task;
  }

  private ghStateToGoalStatus(state: string): Goal["status"] {
    return state === "CLOSED" ? "completed" : "pending";
  }

  private ghStateToTaskStatus(state: string): Task["status"] {
    return state === "CLOSED" ? "completed" : "pending";
  }
}

// ---------------------------------------------------------------------------
// Internal types for gh CLI JSON output
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
}
