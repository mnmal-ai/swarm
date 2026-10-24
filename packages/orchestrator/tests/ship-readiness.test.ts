/**
 * Ship-readiness gate — acceptance-matrix coverage.
 *
 * The sibling files exercise each piece in isolation (gate runner, follow-up
 * builder, contract loader). This file ties them together over the full
 * acceptance matrix the goal calls out, so the *wiring* the orchestrator relies
 * on is pinned: a failed gate must produce a follow-up task with real DAG edges
 * and must signal "do not close the goal", while a passed gate must produce
 * neither — and a deploy-step failure must never be conflated with a smoke-test
 * failure in the emitted evidence.
 *
 * Side effects are injected (worktree.test.ts vi.fn style): the deploy command
 * runner and the smoke fetch are both `vi.fn()` fakes, so no real child_process
 * spawns and no real network request is ever made. The fetch spy doubles as the
 * proof that a failed deploy short-circuits before any endpoint is polled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runShipReadinessGate,
  loadShipReadinessContract,
  gateAppliesToGoal,
  buildShipReadinessFollowUpTask,
} from "../src/ship-readiness/index.js";
import type { Goal, Task } from "@mnmal-ai/swarm-types";
import type {
  CommandResult,
  CommandRunner,
  Fetch,
  FetchResponse,
  ShipReadinessContract,
  ShipReadinessGateResult,
  SmokeEndpoint,
} from "../src/ship-readiness/types.js";

// ---------------------------------------------------------------------------
// Builders + injected fakes
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<ShipReadinessContract> = {}): ShipReadinessContract {
  return {
    platform: "generic",
    target: "production",
    schemaVersion: "1",
    gates: [],
    promoteCommand: "deploy-it",
    ...overrides,
  };
}

const goal: Goal = {
  id: "goal-6",
  description: "Ship the resolve endpoint",
  priority: 1,
  status: "in_progress",
  constraints: [],
  acceptance_criteria: ["Endpoint returns 200"],
};

const COMPLETED_TASK_IDS = ["goal-6-task-1", "goal-6-task-2", "goal-6-task-3"];

/** A vi.fn command runner that resolves with a canned CommandResult. */
function mockRunner(result: CommandResult): ReturnType<typeof vi.fn> & CommandRunner {
  return vi.fn(async (_command: string, _opts?: { cwd?: string }) => result) as ReturnType<
    typeof vi.fn
  > &
    CommandRunner;
}

/** A vi.fn fetch mapping urls to (partial) responses; throws for unmapped urls. */
function mockFetch(
  routes: Record<string, Partial<FetchResponse>>,
): ReturnType<typeof vi.fn> & Fetch {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected url: ${url}`);
    return {
      status: 200,
      text: async () => "",
      json: async () => ({}),
      ...route,
    } as FetchResponse;
  }) as ReturnType<typeof vi.fn> & Fetch;
}

/**
 * Models the orchestrator's gate decision: a passed gate lets the caller close
 * the goal; any failure forbids closing and yields a remediation follow-up task.
 * This is the seam the matrix asserts on — runShipReadinessGate emits the
 * discriminated outcome, buildShipReadinessFollowUpTask turns a failure into the
 * DAG task. Kept tiny and local so the test pins the contract, not an internal.
 */
function decide(result: ShipReadinessGateResult): {
  mayCloseGoal: boolean;
  followUpTask?: Task;
} {
  if (result.outcome === "passed") return { mayCloseGoal: true };
  return {
    mayCloseGoal: false,
    followUpTask: buildShipReadinessFollowUpTask(goal, COMPLETED_TASK_IDS, result),
  };
}

// ---------------------------------------------------------------------------
// (1) Deploy step broken: runner exits non-zero
// ---------------------------------------------------------------------------

describe("acceptance (1): a broken deploy", () => {
  const smokeEndpoints: SmokeEndpoint[] = [{ url: "https://x/health", expectStatus: 200 }];

  it("returns deploy-failed carrying the exit code + stderr, and never polls endpoints", async () => {
    const runCommand = mockRunner({ exitCode: 17, stdout: "", stderr: "deploy rejected: bad token" });
    const fetch = mockFetch({ "https://x/health": { status: 200 } });

    const result = await runShipReadinessGate({
      contract: makeContract({ promoteCommand: "make ship", smokeEndpoints }),
      goalId: "goal-6",
      runCommand,
      fetch,
    });

    expect(result).toEqual({
      outcome: "deploy-failed",
      deployExitCode: 17,
      deployStderr: "deploy rejected: bad token",
    });
    // A failed deploy leaves the targets on the old release; polling them would
    // mislabel a deploy bug as an env failure. Prove the short-circuit: fetch
    // was injected and wired, yet never called.
    expect(fetch).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("produces a follow-up task with real dependsOn edges and forbids closing the goal", async () => {
    const result = await runShipReadinessGate({
      contract: makeContract({ promoteCommand: "make ship", smokeEndpoints }),
      goalId: "goal-6",
      runCommand: mockRunner({ exitCode: 17, stdout: "", stderr: "deploy rejected: bad token" }),
      fetch: mockFetch({}),
    });

    const decision = decide(result);

    // The result must instruct the caller NOT to close the goal.
    expect(decision.mayCloseGoal).toBe(false);
    expect(decision.followUpTask).toBeDefined();

    const task = decision.followUpTask as Task;
    // Real DAG edges via the EXISTING Task.dependsOn field — not a new field.
    expect(task.dependsOn).toEqual(COMPLETED_TASK_IDS);
    expect("depends_on" in task).toBe(false);
    expect("blockedBy" in task).toBe(false);
    expect("requires" in task).toBe(false);
    expect(task.goal_id).toBe("goal-6");
    expect(task.status).toBe("pending");
    // Evidence frames this as a deploy-step failure with the exit code.
    expect(task.description).toContain("deploy step");
    expect(task.description).toContain("exited 17");
    expect(task.description).toContain("deploy rejected: bad token");
  });
});

// ---------------------------------------------------------------------------
// (2) Deploy OK, a smoke endpoint returns the wrong status/JSON
// ---------------------------------------------------------------------------

describe("acceptance (2): deploy succeeds but smoke fails", () => {
  it("returns smoke-failed with failedEndpoints populated", async () => {
    const endpoints: SmokeEndpoint[] = [
      { url: "https://x/health", expectStatus: 200 },
      { url: "https://x/api", jsonPath: "$.ok", expectEquals: true },
    ];
    const fetch = mockFetch({
      "https://x/health": { status: 503 }, // wrong status
      "https://x/api": { status: 200, json: async () => ({ ok: false }) }, // wrong JSON
    });

    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: endpoints }),
      goalId: "goal-6",
      runCommand: mockRunner({ exitCode: 0, stdout: "deployed", stderr: "" }),
      fetch,
    });

    expect(result.outcome).toBe("smoke-failed");
    if (result.outcome !== "smoke-failed") throw new Error("unreachable");
    expect(result.failedEndpoints).toHaveLength(2);
    expect(result.failedEndpoints.map((e) => e.url)).toEqual([
      "https://x/health",
      "https://x/api",
    ]);
    expect(result.failedEndpoints[0].reason).toBe("expected status 200, got 503");
    expect(result.failedEndpoints[1].reason).toMatch(/JSON assertion failed at \$\.ok/);
    // Deploy succeeded, so the endpoints WERE polled (both of them).
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("emits smoke evidence DISTINCT from deploy-failed evidence (no conflation)", async () => {
    const fetch = mockFetch({ "https://x/health": { status: 500 } });
    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: [{ url: "https://x/health" }] }),
      goalId: "goal-6",
      runCommand: mockRunner({ exitCode: 0, stdout: "", stderr: "" }),
      fetch,
    });

    if (result.outcome !== "smoke-failed") throw new Error("expected smoke-failed");
    // The smoke-failed shape carries endpoint detail and NOTHING from the deploy
    // failure shape: no exit code, no deploy stderr field. This is what keeps a
    // live-but-broken deploy from being dismissed as an env/deploy issue.
    expect(result).not.toHaveProperty("deployExitCode");
    expect(result).not.toHaveProperty("deployStderr");

    const decision = decide(result);
    expect(decision.mayCloseGoal).toBe(false);
    const task = decision.followUpTask as Task;
    expect(task.dependsOn).toEqual(COMPLETED_TASK_IDS);
    // Reviewer-facing framing: a smoke (real-bug) failure, not a deploy failure.
    expect(task.description).toContain("smoke-test step");
    expect(task.description).toContain("real bug");
    expect(task.description).toContain("https://x/health");
    expect(task.description).not.toContain("deploy step");
  });
});

// ---------------------------------------------------------------------------
// (3) Deploy OK + every endpoint passes
// ---------------------------------------------------------------------------

describe("acceptance (3): deploy succeeds and all endpoints pass", () => {
  it("returns passed, allows closing the goal, and produces NO follow-up task", async () => {
    const endpoints: SmokeEndpoint[] = [
      { url: "https://x/health", expectStatus: 200 },
      { url: "https://x/api", jsonPath: "$.status", expectEquals: "up" },
    ];
    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: endpoints }),
      goalId: "goal-6",
      runCommand: mockRunner({ exitCode: 0, stdout: "deployed", stderr: "" }),
      fetch: mockFetch({
        "https://x/health": { status: 200 },
        "https://x/api": { status: 200, json: async () => ({ status: "up" }) },
      }),
    });

    expect(result).toEqual({ outcome: "passed" });

    const decision = decide(result);
    expect(decision.mayCloseGoal).toBe(true);
    expect(decision.followUpTask).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (4) loadShipReadinessContract: absent -> null, present -> parsed
// ---------------------------------------------------------------------------

describe("acceptance (4): loadShipReadinessContract presence", () => {
  let swarmPath: string;

  beforeEach(() => {
    swarmPath = mkdtempSync(join(tmpdir(), "ship-readiness-matrix-"));
    mkdirSync(join(swarmPath, "oversight"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(swarmPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("returns null when the contract file is absent (gate inactive)", () => {
    expect(loadShipReadinessContract(swarmPath)).toBeNull();
  });

  it("parses a fixture contract when the file is present", () => {
    const fixture = {
      platform: "vercel",
      target: "production",
      schemaVersion: "1",
      gates: [],
      promoteCommand: "pnpm deploy",
      goalIds: ["goal-6"],
      smokeEndpoints: [{ url: "https://example.com/health", expectStatus: 200 }],
    };
    writeFileSync(
      join(swarmPath, "oversight", "ship-readiness.json"),
      JSON.stringify(fixture),
      "utf-8",
    );

    const contract = loadShipReadinessContract(swarmPath);
    expect(contract).not.toBeNull();
    expect(contract?.promoteCommand).toBe("pnpm deploy");
    expect(contract?.goalIds).toEqual(["goal-6"]);
    expect(contract?.smokeEndpoints).toEqual([
      { url: "https://example.com/health", expectStatus: 200 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// (5) gateAppliesToGoal: matches only listed goalIds
// ---------------------------------------------------------------------------

describe("acceptance (5): gateAppliesToGoal scoping", () => {
  it("matches only the listed goalIds", () => {
    const contract = makeContract({ goalIds: ["goal-6", "goal-7"] });
    expect(gateAppliesToGoal(contract, "goal-6")).toBe(true);
    expect(gateAppliesToGoal(contract, "goal-7")).toBe(true);
    expect(gateAppliesToGoal(contract, "goal-8")).toBe(false);
    expect(gateAppliesToGoal(contract, "goal-99")).toBe(false);
  });

  it("scopes to no goal when goalIds is an explicit empty array", () => {
    expect(gateAppliesToGoal(makeContract({ goalIds: [] }), "goal-6")).toBe(false);
  });
});
