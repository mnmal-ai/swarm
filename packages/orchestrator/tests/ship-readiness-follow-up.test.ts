import { describe, it, expect } from "vitest";
import { buildShipReadinessFollowUpTask } from "../src/ship-readiness/follow-up.js";
import type { Goal } from "@mnmal-ai/swarm-types";
import type { ShipReadinessGateResult } from "../src/ship-readiness/types.js";

const goal: Goal = {
  id: "g1",
  description: "Ship the resolve endpoint",
  priority: 1,
  status: "in_progress",
  constraints: [],
  acceptance_criteria: ["Endpoint returns 200"],
};

describe("buildShipReadinessFollowUpTask", () => {
  it("uses the deterministic id and pending status", () => {
    const result: ShipReadinessGateResult = {
      outcome: "deploy-failed",
      deployExitCode: 1,
      deployStderr: "boom",
    };
    const task = buildShipReadinessFollowUpTask(goal, ["t1"], result);
    expect(task.id).toBe("g1-ship-readiness-followup");
    expect(task.goal_id).toBe("g1");
    expect(task.status).toBe("pending");
    expect(task.intent).toBe("implementation");
    expect(task.isolated).toBe(false);
  });

  it("depends on all completed tasks so re-verification runs after the fix", () => {
    const result: ShipReadinessGateResult = {
      outcome: "deploy-failed",
      deployExitCode: 2,
      deployStderr: "auth error",
    };
    const task = buildShipReadinessFollowUpTask(goal, ["t1", "t2", "t3"], result);
    expect(task.dependsOn).toEqual(["t1", "t2", "t3"]);
  });

  it("distinguishes a deploy-step failure with its exit code and stderr", () => {
    const result: ShipReadinessGateResult = {
      outcome: "deploy-failed",
      deployExitCode: 127,
      deployStderr: "vercel: command not found",
    };
    const task = buildShipReadinessFollowUpTask(goal, ["t1"], result);
    expect(task.description).toContain("deploy step");
    expect(task.description).toContain("exited 127");
    expect(task.description).toContain("vercel: command not found");
    // Must not mask the deploy failure as a smoke/endpoint issue.
    expect(task.description).not.toContain("smoke endpoint(s) did not pass");
  });

  it("distinguishes a smoke-test failure and enumerates each failing endpoint", () => {
    const result: ShipReadinessGateResult = {
      outcome: "smoke-failed",
      failedEndpoints: [
        {
          url: "https://x.test/health",
          expectedStatus: 200,
          actualStatus: 503,
          reason: "status mismatch",
        },
        {
          url: "https://x.test/ready",
          expectedStatus: 200,
          actualStatus: null,
          reason: "network error",
        },
      ],
    };
    const task = buildShipReadinessFollowUpTask(goal, ["t1"], result);
    expect(task.description).toContain("smoke-test step");
    expect(task.description).toContain("https://x.test/health");
    expect(task.description).toContain("expected 200, got 503");
    expect(task.description).toContain("https://x.test/ready");
    expect(task.description).toContain("got no response");
    // A live-but-broken deploy is a real bug, not an env failure.
    expect(task.description).toContain("real bug");
  });

  it("emits a feat: commit instruction for the remediation", () => {
    const result: ShipReadinessGateResult = {
      outcome: "smoke-failed",
      failedEndpoints: [
        {
          url: "https://x.test/health",
          expectedStatus: 200,
          actualStatus: 500,
          reason: "status mismatch",
        },
      ],
    };
    const task = buildShipReadinessFollowUpTask(goal, ["t1"], result);
    expect(task.description).toContain("feat:");
  });
});
