/**
 * Decomposition scenarios built from invented tickets (see
 * __fixtures__/sample-project/tickets.ts).
 *
 * Each ticket goes the way `swarm run` takes it: through the real
 * TrelloExternalSource (running a fake Trello CLI that prints card JSON) or
 * GitHubExternalSource (with a fake `gh` on PATH), then through the goal
 * loop's own seams: effectiveDecomposition → decomposeGoal (the planner
 * answering with a fixed plan) → applyPlannerCap → classifyTaskForDispatch
 * against the thresholds loaded from swarm.json.
 * No LLM, no network, no Trello.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GitHubExternalSource, TrelloExternalSource } from "@mnmal-ai/swarm-task-backends";
import {
  classifyTaskForDispatch,
  deriveAutonomy,
  effectiveDecomposition,
  estimateComplexity,
} from "@mnmal-ai/swarm-orchestrator";
import type { Swarm } from "@mnmal-ai/swarm-core";
import type { DecompositionConfig, Goal, ProjectConfig } from "@mnmal-ai/swarm-types";
import { decomposeGoal } from "../src/cli/run.js";
import { applyPlannerCap, goalDecompositionWarnings } from "../src/cli/decomposition-policy.js";
import { loadComplexityThresholds } from "../src/cli/complexity-thresholds.js";
import {
  S1_ACCEPTANCE,
  S1_BUG_CARD,
  S1_PLAN,
  S1_PROFILE,
  S2_DESIGN_CARD,
  S3_ACCEPTANCE,
  S3_FEATURE_CARD,
  S3_FEATURE_CARD_RELABELLED,
  S4_CONFLICT_CARD,
  asGitHubIssue,
  withLabels,
  type GitHubIssueJson,
  type TrelloCardJson,
} from "./__fixtures__/sample-project/tickets.js";

const FAKE_TRELLO_CLI = fileURLToPath(new URL("./__fixtures__/sample-project/fake-trello-cli.mjs", import.meta.url));

// A medium-trust project: autonomy.escalation.decompose_on_failure is on.
const autonomy = deriveAutonomy({ trust_level: "medium" } as ProjectConfig);

let root: string;
let swarmPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "swarm-decomp-scenarios-"));
  swarmPath = join(root, ".swarm");
  await mkdir(swarmPath);
  // The complexity section `swarm init` scaffolds (today's thresholds).
  await writeFile(
    join(swarmPath, "swarm.json"),
    JSON.stringify({
      version: "0.1.0",
      complexity: { simple_max: 30, complex_min: 61, escalation: { token_fraction: 0.5, turn_fraction: 0.7, timeout_fraction: 0.6 } },
      routes: [],
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Queue `cards` in "To Do" on one board and take them the way swarm run does. */
async function goalsFromTrello(cards: TrelloCardJson[]): Promise<Goal[]> {
  const boards = join(root, "boards.json");
  await writeFile(boards, JSON.stringify({ "board-a": cards }));
  const source = new TrelloExternalSource({
    command: [process.execPath, FAKE_TRELLO_CLI, boards],
    cwd: root,
    boards: ["board-a"],
    perBoard: cards.length,
  });
  return source.fetchGoals();
}

async function goalFromTrello(card: TrelloCardJson): Promise<Goal> {
  const [goal] = await goalsFromTrello([card]);
  return goal;
}

type Plan = { shared_files: string[]; tasks: Array<{ title: string; description: string; intent: string }> };

/** One goal through the goal loop's planning and gating seams, as run.ts drives them. */
async function throughRunPath(goal: Goal, projectPolicy: DecompositionConfig | undefined, plan: Plan = S1_PLAN) {
  const policy = effectiveDecomposition(projectPolicy, goal, autonomy);

  const prompts: string[] = [];
  const swarm = {
    run: async (_task: string, options: { input: string }) => {
      prompts.push(options.input);
      return { output: JSON.stringify(plan) };
    },
  } as unknown as Swarm;
  const planned = await decomposeGoal(swarm, goal, "sample-project", root, undefined, undefined, undefined, undefined, policy.maxTasks);
  const capped = applyPlannerCap(planned.tasks, planned.createsMap, policy.maxTasks);

  const { thresholds } = loadComplexityThresholds(swarmPath);
  const dispatch = capped.tasks.map((task) => ({ task, ...classifyTaskForDispatch(task, thresholds, policy) }));
  return { policy, prompt: prompts[0], planned, capped, dispatch };
}

/** Extra LLM sessions spent splitting tasks before any of them has run. */
function upFrontSplitSessions(dispatch: Array<{ split: { proactive: string } }>): number {
  return dispatch.filter((d) => d.split.proactive !== "none").length;
}

// ---------------------------------------------------------------------------
// S1 — permission bug card
// ---------------------------------------------------------------------------

describe("S1 — permission bug card", () => {
  it("reaches swarm as a goal with the whole card and its 12 acceptance items", async () => {
    const goal = await goalFromTrello(S1_BUG_CARD);

    expect(goal.id).toBe("trello-Mx4qT8vB");
    expect(goal.description).toBe("Members can read other members' records");
    expect(goal.acceptance_criteria).toEqual(S1_ACCEPTANCE);
    expect(goal.acceptance_criteria).toHaveLength(12);
    expect(goal.context).toContain("Card: https://trello.com/c/Mx4qT8vB");
    const sections = [...goal.context!.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(sections).toEqual(["## Summary", "## Details", "## To reproduce", "## Notes", "## References"]);
    expect(S1_BUG_CARD.desc.length).toBeGreaterThan(3300);
    expect(S1_BUG_CARD.desc.length).toBeLessThan(3700);
    // No swarm_split label, so the project's policy applies.
    expect(goal.split).toBeUndefined();
    expect(effectiveDecomposition(undefined, goal, autonomy).source).toBe("project");
  });

  it("its plan scores the profile it was written to, task by task", () => {
    const { thresholds } = loadComplexityThresholds(swarmPath);
    S1_PLAN.tasks.forEach((task, i) => {
      const expected = S1_PROFILE[i];
      const scored = estimateComplexity(task.description, thresholds);
      const signal = (name: string) => scored.signals.find((s) => s.name === name)!.score;

      expect(task.intent).toBe(expected.intent);
      expect(scored.band).toBe(expected.band);
      expect(Math.abs(scored.score - expected.score)).toBeLessThanOrEqual(5);
      expect(signal("conjunctions")).toBe(25);
      expect(signal("description_length")).toBeGreaterThanOrEqual(14);
      expect(task.description.length).toBeGreaterThanOrEqual(600);
      expect(task.description.length).toBeLessThanOrEqual(1224);
    });
  });

  it("default policy (auto, no cap): tasks 4 and 5 are split first, 1-3 get speculative sub-plans", async () => {
    const goal = await goalFromTrello(S1_BUG_CARD);
    const { policy, prompt, capped, dispatch } = await throughRunPath(goal, undefined);

    expect(policy).toMatchObject({ maxTasks: undefined, subDecompose: "auto", source: "project" });
    expect(prompt).not.toMatch(/Plan at most|Plan exactly one/);
    expect(capped.message).toBeNull();
    expect(dispatch.map((d) => d.complexity.band)).toEqual(["moderate", "moderate", "moderate", "complex", "complex"]);
    expect(dispatch.map((d) => d.split.proactive)).toEqual(["speculative", "speculative", "speculative", "pre_split", "pre_split"]);
    expect(dispatch.map((d) => d.split.armEscalationWatcher)).toEqual([true, true, true, false, false]);
    expect(upFrontSplitSessions(dispatch)).toBe(5);
  });

  it("{ max_tasks: 3, sub_decompose: on_failure }: the plan folds to 3 tasks and nothing is split up front", async () => {
    const goal = await goalFromTrello(S1_BUG_CARD);
    const { policy, prompt, planned, capped, dispatch } = await throughRunPath(goal, { max_tasks: 3, sub_decompose: "on_failure" });

    expect(policy).toMatchObject({ maxTasks: 3, subDecompose: "on_failure", proactive: false, reactive: true });
    expect(prompt).toContain("Plan at most 3 tasks.");
    // The planner answered with five anyway; swarm folds the last three into task 3.
    expect(planned.tasks).toHaveLength(5);
    expect(capped.message).toBe("Folded 2 of 5 planned tasks into task 3 (max 3 tasks)");
    expect(capped.tasks.map((t) => t.id)).toEqual(["trello-Mx4qT8vB-task-1", "trello-Mx4qT8vB-task-2", "trello-Mx4qT8vB-task-3"]);

    const merged = capped.tasks[2];
    expect(merged.title).toBe("Check access in the member routes and search");
    expect(merged.intent).toBe("implementation");
    for (const [n, planTask] of [[1, S1_PLAN.tasks[2]], [2, S1_PLAN.tasks[3]], [3, S1_PLAN.tasks[4]]] as const) {
      expect(merged.description).toContain(`Step ${n} of 3: ${planTask.title}\n${planTask.description}`);
    }
    expect(merged.serializedFiles).toEqual([
      "src/members/member-routes.ts",
      "src/search/member-search.ts",
      "src/members/member-routes.test.ts",
      "src/test/demo-library.ts",
    ]);
    expect(capped.createsMap.get("trello-Mx4qT8vB-task-3")).toEqual(["src/search/member-search.test.ts"]);

    expect(dispatch.map((d) => d.split.proactive)).toEqual(["none", "none", "none"]);
    expect(upFrontSplitSessions(dispatch)).toBe(0);
    // A moderate task that escalates can still be split, on failure.
    expect(dispatch[0].split.armEscalationWatcher).toBe(true);
  });

  it("swarm_split: false: one task, never split", async () => {
    const goal = await goalFromTrello(withLabels(S1_BUG_CARD, "swarm_split: false"));
    expect(goal.split).toBe(false);

    const { policy, prompt, capped, dispatch } = await throughRunPath(goal, undefined);

    expect(policy).toMatchObject({ maxTasks: 1, subDecompose: "never", proactive: false, reactive: false, source: "swarm_split: false" });
    expect(prompt).toContain("Plan exactly one task that does the whole goal.");
    expect(capped.message).toBe("Folded 4 of 5 planned tasks into task 1 (max 1 task)");
    expect(capped.tasks).toHaveLength(1);
    expect(capped.tasks[0].intent).toBe("implementation");
    for (const planTask of S1_PLAN.tasks) expect(capped.tasks[0].description).toContain(planTask.description);
    expect(capped.createsMap.get("trello-Mx4qT8vB-task-1")).toEqual(["src/search/member-search.test.ts"]);

    expect(dispatch).toHaveLength(1);
    expect(dispatch[0].split).toEqual({ proactive: "none", armEscalationWatcher: false });
  });

  it("swarm_split: true on a project set to on_failure behaves as auto", async () => {
    const goal = await goalFromTrello(withLabels(S1_BUG_CARD, "Swarm_Split : TRUE"));
    expect(goal.split).toBe(true);

    const project: DecompositionConfig = { max_tasks: 2, sub_decompose: "on_failure" };
    const labelled = await throughRunPath(goal, project);
    const byDefault = await throughRunPath(await goalFromTrello(S1_BUG_CARD), undefined);

    expect(labelled.policy).toMatchObject({ maxTasks: undefined, subDecompose: "auto", proactive: true, speculative: true, reactive: true, source: "swarm_split: true" });
    expect(labelled.prompt).not.toMatch(/Plan at most|Plan exactly one/);
    expect(labelled.capped.tasks).toHaveLength(5);
    expect(labelled.dispatch.map((d) => d.split)).toEqual(byDefault.dispatch.map((d) => d.split));
    expect(labelled.dispatch.map((d) => d.split.proactive)).toEqual(["speculative", "speculative", "speculative", "pre_split", "pre_split"]);

    // The same card without the label, on that project: capped and split only on failure.
    const unlabelled = await throughRunPath(await goalFromTrello(S1_BUG_CARD), project);
    expect(unlabelled.capped.tasks).toHaveLength(2);
    expect(upFrontSplitSessions(unlabelled.dispatch)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S2 — design card
// ---------------------------------------------------------------------------

const S2_PLAN: Plan = {
  shared_files: [],
  tasks: [
    { title: "Read the notes the design builds on", description: "Read the member records design, the overdue letter job and the renewal rules notes.", intent: "investigation" },
    { title: "Write the reminder design", description: "Write docs/design/due-date-reminders.md covering timing, content, channels, grouping, opt-out and quiet hours.", intent: "implementation" },
    { title: "Record the open points and who decides them", description: "Add each open point with the person who must decide it.", intent: "implementation" },
    { title: "Review the design against the card", description: "Check every acceptance item against the design.", intent: "code-review" },
  ],
};

describe("S2 — design card", () => {
  it("reaches the planner whole, and follows the project's policy", async () => {
    const goal = await goalFromTrello(S2_DESIGN_CARD);

    expect(goal.description).toBe("Write the due-date reminder design");
    expect(goal.acceptance_criteria).toHaveLength(12);
    expect(S2_DESIGN_CARD.desc.length).toBeGreaterThan(6000);
    expect(S2_DESIGN_CARD.desc.length).toBeLessThan(6400);
    expect(goal.split).toBeUndefined();

    const { policy, prompt, capped, dispatch } = await throughRunPath(goal, { max_tasks: 2, sub_decompose: "never" }, S2_PLAN);

    expect(policy).toMatchObject({ maxTasks: 2, subDecompose: "never", source: "project" });
    expect(prompt).toContain("Plan at most 2 tasks.");
    for (const heading of ["## Background", "## Approach", "## Open points", "## Notes", "## References"]) expect(prompt).toContain(heading);
    expect(prompt).toContain("- Priya has reviewed the design");
    expect(capped.message).toBe("Folded 2 of 4 planned tasks into task 2 (max 2 tasks)");
    expect(capped.tasks.map((t) => t.intent)).toEqual(["investigation", "implementation"]);
    expect(dispatch.every((d) => d.split.proactive === "none" && !d.split.armEscalationWatcher)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S3 — feature card; S4 — conflicting swarm_split labels
// ---------------------------------------------------------------------------

describe("S3 — feature card", () => {
  it("parses the same way under either label set, neither of which overrides the project", async () => {
    const [first, relabelled] = await goalsFromTrello([S3_FEATURE_CARD, S3_FEATURE_CARD_RELABELLED]);

    for (const goal of [first, relabelled]) {
      expect(goal.description).toBe("Add barcode labels for new copies");
      expect(goal.acceptance_criteria).toEqual(S3_ACCEPTANCE);
      expect(goal.acceptance_criteria).toHaveLength(18);
      const sections = [...goal.context!.matchAll(/^## .+$/gm)].map((m) => m[0]);
      expect(sections).toEqual(["## Summary", "## Approach", "## Users", "## Details", "## Edge cases", "## References"]);
      expect(goal.split).toBeUndefined();
      expect(effectiveDecomposition({ max_tasks: 4, sub_decompose: "on_failure" }, goal, autonomy)).toMatchObject({
        maxTasks: 4, subDecompose: "on_failure", source: "project",
      });
    }
    expect(first.id).toBe("trello-Kq7Lm2Pa");
    expect(relabelled.id).toBe("trello-Yh8sW1qN");
    expect(S3_FEATURE_CARD.desc.length).toBeGreaterThan(6000);
    expect(S3_FEATURE_CARD.desc.length).toBeLessThan(7000);
  });

  it("with swarm_split: false it is one task, never split", async () => {
    const goal = await goalFromTrello(withLabels(S3_FEATURE_CARD_RELABELLED, "swarm_split:false"));
    const { policy, capped, dispatch } = await throughRunPath(goal, { sub_decompose: "auto" });
    expect(policy).toMatchObject({ maxTasks: 1, subDecompose: "never" });
    expect(capped.tasks).toHaveLength(1);
    expect(dispatch[0].split).toEqual({ proactive: "none", armEscalationWatcher: false });
  });
});

describe("S4 — both swarm_split labels on one card", () => {
  it("uses swarm_split: false, and swarm run warns naming the goal", async () => {
    const goal = await goalFromTrello(S4_CONFLICT_CARD);

    expect(goal).toMatchObject({ id: "trello-Kq7Lm2Pa", split: false, splitConflict: true });
    expect(goalDecompositionWarnings([goal], undefined, autonomy)).toEqual([
      `Goal "Add barcode labels for new copies" [trello-Kq7Lm2Pa] has both swarm_split: true and swarm_split: false; using swarm_split: false.`,
    ]);

    const { policy, prompt, capped, dispatch } = await throughRunPath(goal, { sub_decompose: "auto" });
    expect(policy).toMatchObject({ maxTasks: 1, subDecompose: "never", source: "swarm_split: false" });
    expect(prompt).toContain("Plan exactly one task that does the whole goal.");
    expect(capped.tasks).toHaveLength(1);
    expect(upFrontSplitSessions(dispatch)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The same tickets as GitHub issues
// ---------------------------------------------------------------------------

describe("GitHub-issue variants", () => {
  let savedPath: string | undefined;
  let issuesFile: string;

  beforeEach(async () => {
    // Saved first, so afterEach restores the real PATH even if setup throws.
    savedPath = process.env.PATH;
    const bin = join(root, "bin");
    await mkdir(bin);
    issuesFile = join(root, "issues.json");
    // Stub `gh`: answers `gh issue list …` with the fixture issues; anything
    // else fails, so a test fails loudly if swarm tries to write.
    const gh = join(bin, "gh");
    await writeFile(
      gh,
      `#!${process.execPath}\n` +
        `const args = process.argv.slice(2);\n` +
        `if (args[0] === "issue" && args[1] === "list") {\n` +
        `  process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(issuesFile)}, "utf-8"));\n` +
        `} else { process.stderr.write("stub gh: " + args.join(" ") + " is not allowed\\n"); process.exit(2); }\n`,
    );
    await chmod(gh, 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
  });

  async function goalsFromGitHub(issues: GitHubIssueJson[]): Promise<Goal[]> {
    await writeFile(issuesFile, JSON.stringify(issues));
    return new GitHubExternalSource({ repo: "example/sample-project" }).fetchGoals();
  }

  it("S1 with swarm_split: false is one task, never split; without it, the project's policy", async () => {
    const [labelled, plain] = await goalsFromGitHub([
      asGitHubIssue(S1_BUG_CARD, 41, ["swarm_split: false"]),
      asGitHubIssue(S1_BUG_CARD, 42),
    ]);

    expect(labelled).toMatchObject({ id: "gh-41", description: S1_BUG_CARD.name, split: false });
    expect(labelled.acceptance_criteria).toEqual(S1_ACCEPTANCE);
    expect(plain.split).toBeUndefined();

    const one = await throughRunPath(labelled, { max_tasks: 3, sub_decompose: "on_failure" });
    expect(one.capped.tasks).toHaveLength(1);
    expect(one.dispatch[0].split).toEqual({ proactive: "none", armEscalationWatcher: false });

    const three = await throughRunPath(plain, { max_tasks: 3, sub_decompose: "on_failure" });
    expect(three.capped.tasks).toHaveLength(3);
    expect(upFrontSplitSessions(three.dispatch)).toBe(0);
  });

  it("S4 as an issue: split false, and the warning names the goal", async () => {
    const [goal] = await goalsFromGitHub([asGitHubIssue(S3_FEATURE_CARD, 57, ["swarm_split: true", "SWARM_SPLIT: false"])]);

    expect(goal).toMatchObject({ id: "gh-57", split: false, splitConflict: true });
    expect(goal.acceptance_criteria).toEqual(S3_ACCEPTANCE);
    expect(goalDecompositionWarnings([goal], { sub_decompose: "auto" }, autonomy)).toEqual([
      `Goal "Add barcode labels for new copies" [gh-57] has both swarm_split: true and swarm_split: false; using swarm_split: false.`,
    ]);
  });
});
