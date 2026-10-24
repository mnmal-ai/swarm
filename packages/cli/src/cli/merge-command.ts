/**
 * `swarm merge`: merge-as-you-go for pull requests earlier runs left open,
 * without running any goals (merge-queue spec, "Left open, and trying
 * again"). Takes the repository's merge turn like a run does. A conflict is
 * left open here — resolving one needs a worker, which `swarm run` provides.
 *
 *   swarm merge                 retry what swarm can fix (conflict, base_kept_moving, refused)
 *   swarm merge --all           also retry gate failures (the gate runs again)
 *   swarm merge --pr <url>      retry one pull request, whatever its kind
 *
 * It refuses to start while `swarm run` runs for the same project (both use
 * the work repo and the checkpoint), and `swarm run` refuses while it runs.
 */

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { GoalPublication, ProjectConfig } from "@mnmal-ai/swarm-types";
import {
  FileMergeQueue,
  MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS,
  MERGE_PRS_DEFAULT_MAX_ROUNDS,
  MERGE_PRS_DEFAULT_SKIP_LABELS,
  RETRYABLE_LEFT_OPEN_KINDS,
  SourceControlManager,
  mergeableFromPublication,
  repoKeyFor,
  trackGoalPublications,
} from "@mnmal-ai/swarm-orchestrator";
import type { MergeGoalResult, PublicationStore } from "@mnmal-ai/swarm-orchestrator";
import { mergeGoalSafely } from "./goal-publications.js";
import { claimProject } from "./project-claim.js";
import { assertGitRepo, resolveRepoRoot } from "./repo-root.js";
import { prepareGitHubAccess } from "./github-account.js";
import { assertValidSourceControlConfig, discoverSwarmPath, formatMergeOutcome, formatMergeSummary } from "./run.js";

/** Which merge-mode records to try again: never merged ones; by default the retryable kinds. */
export function selectMergeRetries(records: readonly GoalPublication[], opts: { pr?: string; all?: boolean }): GoalPublication[] {
  const open = records.filter((r) => r.mode === "merge" && !r.merged && r.pr_url);
  if (opts.pr) return open.filter((r) => r.pr_url === opts.pr);
  return open.filter((r) => {
    if (!r.left_open_kind) return false;
    if (RETRYABLE_LEFT_OPEN_KINDS.has(r.left_open_kind)) return true;
    return opts.all === true && r.left_open_kind === "gate_failed";
  });
}

/** goal_publications in a checkpoint.json, read once and written back whole (atomically). */
export class CheckpointPublicationFile implements PublicationStore {
  private constructor(private readonly path: string, private readonly doc: Record<string, unknown>) {}

  static async open(path: string): Promise<CheckpointPublicationFile> {
    const doc = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return new CheckpointPublicationFile(path, doc);
  }

  getGoalPublications(): GoalPublication[] {
    return [...((this.doc.goal_publications as GoalPublication[] | undefined) ?? [])];
  }

  updateGoalPublication(goalId: string, patch: Partial<Omit<GoalPublication, "goal_id">>): void {
    this.doc.goal_publications = this.getGoalPublications().map((r) => (r.goal_id === goalId ? { ...r, ...patch } : r));
  }

  async save(): Promise<void> {
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.doc, null, 2));
    await rename(tmp, this.path);
  }
}

export async function runMergeCommand(args: Record<string, string>): Promise<void> {
  const swarmPath = args["swarm-path"] ? resolve(args["swarm-path"]) : discoverSwarmPath();
  const { resolveProjectName } = await import("./swarm-meta.js");
  const projectName = resolveProjectName(swarmPath, args["project"]);
  if (!projectName || projectName === "global") {
    console.error("\n  --project is required, and could not be inferred.\n  Usage: swarm merge [--project <name>] [--all | --pr <url>]\n");
    process.exit(1);
  }
  const domainDir = join(swarmPath, "domains", projectName);
  const configPath = join(domainDir, "config.json");
  const projectConfig = JSON.parse(await readFile(configPath, "utf8")) as ProjectConfig;
  assertValidSourceControlConfig(projectConfig, configPath);
  const mp = projectConfig.source_control?.merge_prs;
  if (mp?.enabled !== true || !mp.gate || projectConfig.source_control?.strategy !== "remote_pr") {
    console.error(`\n  source_control.merge_prs is not on for ${projectName}; nothing to merge.\n`);
    process.exit(1);
  }
  const checkpointPath = join(domainDir, ".checkpoints", "checkpoint.json");
  if (!existsSync(checkpointPath)) {
    console.log(`  No checkpoint for ${projectName}: no pull request was left open.`);
    return;
  }
  const store = await CheckpointPublicationFile.open(checkpointPath);
  const selected = selectMergeRetries(store.getGoalPublications(), { ...(args["pr"] ? { pr: args["pr"] } : {}), all: args["all"] === "true" });
  if (selected.length === 0) {
    console.log("  Nothing to retry.");
    return;
  }

  const claim = await claimProject(join(domainDir, ".checkpoints"), "merge");
  if (!claim.ok) {
    console.error(`\n  swarm ${claim.holder.command} (pid ${claim.holder.pid}) has been using ${projectName} since ${claim.holder.since}; run swarm merge after it finishes.\n`);
    process.exit(1);
  }

  const repoRoot = resolveRepoRoot(args, projectConfig, process.cwd());
  assertGitRepo(repoRoot);
  const access = await prepareGitHubAccess(projectConfig, repoRoot);
  if (!access.ok) {
    console.error(`\n  ${access.error}\n`);
    process.exit(1);
  }
  const base = projectConfig.source_control?.base_branch ?? "main";
  const bus = new SwarmEventBus();
  trackGoalPublications(bus, store);
  bus.on("source_control:merge_waiting", (e) => console.log(`    Merge queue: waiting for ${e.holderProject ?? "another run"}, ${e.ahead} ahead`));
  const manager = new SourceControlManager(repoRoot, { ...projectConfig.source_control, base_branch: base }, bus, { github: access.credential });
  let queue: FileMergeQueue | undefined;
  try {
    queue = new FileMergeQueue(await repoKeyFor(repoRoot, projectConfig.source_control?.remote ?? "origin", base));
  } catch {
    console.log("  ⚠ the work repo's remote could not be read; merging without a turn");
  }
  const outcomes: MergeGoalResult[] = [];
  for (const record of selected) {
    console.log(`  ${record.goal_id}: ${record.pr_url} (${record.left_open_kind ?? "no kind"})`);
    const outcome = await mergeGoalSafely(
      manager,
      mergeableFromPublication(record),
      {
        gate: mp.gate,
        skipLabels: mp.skip_labels ?? MERGE_PRS_DEFAULT_SKIP_LABELS,
        ...(queue ? { queue } : {}),
        project: projectConfig.project,
        maxRounds: mp.max_rounds ?? MERGE_PRS_DEFAULT_MAX_ROUNDS,
        maxConflictRounds: mp.max_conflict_rounds ?? MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS,
      },
      base,
    );
    outcomes.push(outcome);
    for (const line of formatMergeOutcome(outcome)) console.log(line);
    if (outcome.kind === "conflict") console.log("      A worker can resolve this conflict: it is retried by the next `swarm run`.");
    await store.save();
  }
  for (const line of formatMergeSummary(outcomes)) console.log(line);
  claim.release();
}
