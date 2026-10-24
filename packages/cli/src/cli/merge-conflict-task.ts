/**
 * The task swarm gives a worker when a goal's branch conflicts with the base
 * at merge time (merge-queue spec, "Conflicts"). The description is also what
 * the reviewer judges, so its last paragraph is the reviewer's added rule.
 */

import type { ConflictContext } from "@mnmal-ai/swarm-orchestrator";

export function conflictTaskDescription(ctx: ConflictContext): string {
  const files = ctx.files.map((f) => `- ${f}`).join("\n");
  return [
    `Resolve the conflict between ${ctx.branch} and ${ctx.remote}/${ctx.base} so this goal can merge: "${ctx.goalDescription}".`,
    "",
    `A merge of ${ctx.remote}/${ctx.base} into ${ctx.branch} is in progress in the working tree. Git could not merge these files:`,
    files,
    "",
    "Keep everything both sides added. Where both sides made the same thing differently (a field, a function, a string, a test helper), keep one version that serves both, preferring the base's naming. Delete nothing to make it compile. Keep every test from both sides; if one side's change breaks the other's test, update the test to the combined behaviour without removing assertions.",
    "",
    `Run the project's tests. Then stage every file you changed or added and conclude the merge with \`git commit --no-edit\`. Leave nothing uncommitted: swarm pushes only what is committed, and counts a resolution with uncommitted changes as not done. Stay on ${ctx.branch}: do not switch branches, rebase, reset, push, or start a new merge.`,
    "",
    "Reviewer: name anything either side had that this merge dropped. A dropped behaviour is a rejection.",
  ].join("\n");
}

export function conflictTaskContext(ctx: ConflictContext): string {
  if (ctx.baseCommits.length === 0) return `No commit on ${ctx.base} touching these files was found since the branch was made.`;
  const lines = ctx.baseCommits.map((c) => `${c.sha.slice(0, 12)} ${c.subject}`);
  return [`Commits on ${ctx.base} since this branch was made that touched the conflicted files (newest first):`, ...lines].join("\n");
}
