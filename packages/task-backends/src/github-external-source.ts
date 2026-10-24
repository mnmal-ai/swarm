import type {
  ExternalItem,
  ExternalTaskSource,
  GitHubCredential,
  Goal,
  Task,
  ExternalItemStatus,
} from "@mnmal-ai/swarm-types";
import { GOAL_LABEL, TASK_LABEL, splitGoalFields } from "./labels.js";
import { runCli } from "./run-cli.js";
import { formatTokens } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GitHubExternalSourceOptions {
  /**
   * Repository in "owner/repo" format. If omitted, the gh CLI
   * auto-detects from the current git remote.
   */
  repo?: string;
  /** The account every gh call runs as (source_control.github_account).
   *  Absent: gh's active account. */
  credential?: GitHubCredential;
}

// ---------------------------------------------------------------------------
// GitHubExternalSource — sync goals with GitHub Issues
// ---------------------------------------------------------------------------

/**
 * Implements ExternalTaskSource for GitHub Issues. Fetches open issues,
 * parses them into swarm Goals (extracting acceptance criteria, constraints,
 * designs, and dependencies from issue markdown), and pushes goals/tasks
 * back as issues.
 *
 * This is the *sync layer* — it doesn't handle CRUD for swarm-created
 * tasks (that's GitHubTaskBackend). Instead it bridges the gap between
 * human-authored GitHub issues and the swarm goal format.
 */
export class GitHubExternalSource implements ExternalTaskSource {
  readonly name = "github";
  private readonly repo: string | undefined;
  private readonly repoArgs: string[];
  private readonly credential: GitHubCredential | undefined;
  /** Settles once swarm's labels exist; shared, so concurrent pushes wait on
   *  the one creation rather than racing ahead of it. */
  private labelsEnsured: Promise<void> | undefined;

  constructor(options?: GitHubExternalSourceOptions) {
    const repo = options?.repo;
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`Invalid repo format: ${repo}. Expected "owner/repo".`);
    }
    this.repo = repo || undefined;
    this.repoArgs = repo ? ["--repo", repo] : [];
    this.credential = options?.credential;
  }

  // -------------------------------------------------------------------------
  // ExternalTaskSource implementation
  // -------------------------------------------------------------------------

  async fetchItems(): Promise<ExternalItem[]> {
    const raw = await this.gh([
      "issue", "list", ...this.repoArgs,
      "--label", GOAL_LABEL, "--state", "open",
      "--json", "number,title,body,state,labels,url", "--limit", "100",
    ]);

    const issues = JSON.parse(raw) as GitHubIssueJson[];
    return issues.map((issue) => ({
      externalId: String(issue.number),
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state === "CLOSED" ? "closed" as const : "open" as const,
      labels: (issue.labels ?? []).map((l) => l.name),
      url: issue.url || (this.repo ? `https://github.com/${this.repo}/issues/${issue.number}` : ""),
    }));
  }

  parseGoal(item: ExternalItem): Goal {
    const body = item.body;

    // Extract acceptance criteria from checkboxes under ## Acceptance Criteria
    const acceptanceCriteria = this.extractCheckboxItems(body, "Acceptance Criteria");

    // Extract constraints from bullet list under ## Constraints
    const constraints = this.extractBulletItems(body, "Constraints");

    // Extract designs from bullet list under ## Designs
    const designs = this.extractCodeItems(body, "Designs");

    // Extract dependencies from ## Dependencies section
    const dependsOn = this.extractDependencies(body);

    // Extract priority from labels (priority:N)
    const priorityLabel = item.labels.find((l) => l.startsWith("priority:"));
    let priority = 0;
    if (priorityLabel) {
      const parsed = parseInt(priorityLabel.split(":")[1]?.trim() ?? "", 10);
      if (Number.isFinite(parsed)) priority = parsed;
    }

    return {
      id: `gh-${item.externalId}`,
      description: item.title,
      ...(item.url ? { url: item.url } : {}),
      priority,
      status: item.state === "closed" ? "completed" : "pending",
      constraints,
      acceptance_criteria: acceptanceCriteria,
      designs: designs.length > 0 ? designs : undefined,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      // swarm_split: true / false overrides the project's decomposition policy.
      ...splitGoalFields(item.labels),
      // Kept for source_control.merge_prs.skip_labels.
      ...(item.labels.length > 0 ? { labels: [...item.labels] } : {}),
    };
  }

  async pushGoal(goal: Goal): Promise<string> {
    await this.ensureLabelsOnce();
    const body = this.goalToIssueBody(goal);
    const labels = [GOAL_LABEL];
    if (goal.priority > 0) {
      labels.push(`priority:${goal.priority}`);
    }

    const raw = await this.gh([
      "issue", "create", ...this.repoArgs,
      "--title", goal.description, "--body", body, "--label", labels.join(","),
    ]);
    return this.extractIssueNumber(raw.trim());
  }

  async pushTask(task: Task, parentGoalExternalId: string): Promise<string> {
    await this.ensureLabelsOnce();
    const body = `Part of #${parentGoalExternalId}\n\n${task.description}`;
    const raw = await this.gh([
      "issue", "create", ...this.repoArgs,
      "--title", task.title || task.description, "--body", body, "--label", TASK_LABEL,
    ]);
    return this.extractIssueNumber(raw.trim());
  }

  async updateStatus(externalId: string, status: ExternalItemStatus): Promise<void> {
    if (status === "completed" || status === "failed" || status === "merged") {
      await this.gh(["issue", "close", externalId, ...this.repoArgs]);
    } else if (status === "pending" || status === "in_progress") {
      try {
        await this.gh(["issue", "reopen", externalId, ...this.repoArgs]);
      } catch {
        // Issue may already be open
      }
    }
  }

  async postComment(externalId: string, comment: string): Promise<void> {
    await this.gh(["issue", "comment", externalId, ...this.repoArgs, "--body", comment]);
  }

  // -------------------------------------------------------------------------
  // Public helpers for bootstrap sync
  // -------------------------------------------------------------------------

  /**
   * Fetch all open issues with the swarm:goal label and parse them
   * directly into Goal objects. Convenience method for the bootstrap
   * sync flow in run.ts.
   */
  async fetchGoals(): Promise<Goal[]> {
    const items = await this.fetchItems();
    return items.map((item) => this.parseGoal(item));
  }

  /**
   * Post a goal completion summary as a comment on the goal's issue.
   */
  async postGoalSummary(
    externalId: string,
    summary: { tasksCompleted: number; tasksFailed: number; tokens: number; durationMs: number },
  ): Promise<void> {
    const emoji = summary.tasksFailed === 0 ? "\u2705" : "\u26a0\ufe0f";
    const durationMin = Math.round(summary.durationMs / 60_000);
    const comment = [
      `${emoji} Goal completed`,
      `- ${summary.tasksCompleted} tasks completed, ${summary.tasksFailed} failed`,
      `- Tokens: ${formatTokens(summary.tokens)} tokens`,
      `- Duration: ${durationMin} minutes`,
    ].join("\n");
    await this.postComment(externalId, comment);
  }

  // -------------------------------------------------------------------------
  // Private helpers — gh CLI
  // -------------------------------------------------------------------------

  /** Run a gh CLI command: asynchronously, with no shell (see runCli), as
   *  the configured account when there is one. */
  private async gh(args: string[]): Promise<string> {
    try {
      return await runCli("gh", args, { env: this.credential?.env() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`gh CLI failed: ${this.credential ? this.credential.redact(message) : message}`);
    }
  }

  private extractIssueNumber(output: string): string {
    const match = output.match(/\/issues\/(\d+)/);
    if (match) return match[1];
    const numMatch = output.trim().match(/(\d+)/);
    return numMatch ? numMatch[1] : output.trim();
  }

  private ensureLabelsOnce(): Promise<void> {
    this.labelsEnsured ??= this.ensureLabels();
    return this.labelsEnsured;
  }

  private async ensureLabels(): Promise<void> {
    const labels = [
      { name: GOAL_LABEL, color: "0E8A16", description: "Swarm goal" },
      { name: TASK_LABEL, color: "1D76DB", description: "Swarm task" },
    ];
    for (const label of labels) {
      try {
        await this.gh([
          "label", "create", label.name, ...this.repoArgs,
          "--color", label.color, "--description", label.description, "--force",
        ]);
      } catch {
        // Label may already exist — that's fine
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers — markdown parsing
  // -------------------------------------------------------------------------

  /**
   * Extract checkbox items (- [ ] text) from a markdown section.
   */
  private extractCheckboxItems(body: string, sectionTitle: string): string[] {
    const section = this.extractSection(body, sectionTitle);
    if (!section) return [];

    const items: string[] = [];
    const regex = /- \[[ x]\] (.+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(section)) !== null) {
      items.push(match[1].trim());
    }
    return items;
  }

  /**
   * Extract bullet items (- text) from a markdown section.
   */
  private extractBulletItems(body: string, sectionTitle: string): string[] {
    const section = this.extractSection(body, sectionTitle);
    if (!section) return [];

    const items: string[] = [];
    const regex = /^- (.+)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(section)) !== null) {
      // Skip checkbox items
      if (match[1].startsWith("[")) continue;
      items.push(match[1].trim());
    }
    return items;
  }

  /**
   * Extract backtick-wrapped items from a section (used for design file paths).
   */
  private extractCodeItems(body: string, sectionTitle: string): string[] {
    const section = this.extractSection(body, sectionTitle);
    if (!section) return [];

    const items: string[] = [];
    const regex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(section)) !== null) {
      items.push(match[1].trim());
    }
    return items;
  }

  /**
   * Extract dependency references from ## Dependencies section.
   * Looks for patterns like "Depends on #1", "Depends on goal-1",
   * "Depends on #2, #3, #4".
   */
  private extractDependencies(body: string): string[] {
    const section = this.extractSection(body, "Dependencies");
    if (!section) return [];

    const deps: string[] = [];
    // Match "#N" references
    const regex = /#(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(section)) !== null) {
      deps.push(`gh-${match[1]}`);
    }
    return deps;
  }

  /**
   * Extract the content of a markdown section by heading.
   * Returns text between the heading and the next heading (or end of string).
   */
  private extractSection(body: string, title: string): string | null {
    const regex = new RegExp(
      `##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
      "i"
    );
    const match = body.match(regex);
    return match ? match[1].trim() : null;
  }

  // -------------------------------------------------------------------------
  // Private helpers — serialization
  // -------------------------------------------------------------------------

  private goalToIssueBody(goal: Goal): string {
    const sections: string[] = [];

    if (goal.acceptance_criteria.length > 0) {
      sections.push("## Acceptance Criteria");
      for (const ac of goal.acceptance_criteria) {
        sections.push(`- [ ] ${ac}`);
      }
    }

    if (goal.constraints.length > 0) {
      sections.push("\n## Constraints");
      for (const c of goal.constraints) {
        sections.push(`- ${c}`);
      }
    }

    if (goal.designs && goal.designs.length > 0) {
      sections.push("\n## Designs");
      for (const d of goal.designs) {
        sections.push(`- \`${d}\``);
      }
    }

    if (goal.dependsOn && goal.dependsOn.length > 0) {
      sections.push("\n## Dependencies");
      const depRefs = goal.dependsOn.map((d) => {
        // Convert gh-N back to #N
        const num = d.replace("gh-", "");
        return `#${num}`;
      });
      sections.push(`Depends on ${depRefs.join(", ")}`);
    }

    return sections.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GitHubIssueJson {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels?: { name: string }[];
  url?: string;
}
