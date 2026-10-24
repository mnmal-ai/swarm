import { describe, it, expect } from "vitest";
import {
  buildVerificationPrompt,
  createVerificationTask,
  createIntegrationTask,
  parseVerificationOutput,
} from "../src/orchestrator/acceptance-verifier.js";
import type { Goal } from "@mnmal-ai/swarm-types";

describe("buildVerificationPrompt", () => {
  it("includes all acceptance criteria as numbered list", () => {
    const criteria = [
      "All routes render without errors",
      "OAuth login flow works",
      "Dark mode toggle persists",
    ];
    const prompt = buildVerificationPrompt("Build React app", criteria);
    expect(prompt).toContain("1. All routes render without errors");
    expect(prompt).toContain("2. OAuth login flow works");
    expect(prompt).toContain("3. Dark mode toggle persists");
    expect(prompt).toContain("PASS or FAIL");
    expect(prompt).toContain("Do not modify any files");
  });

  it("returns empty string when no criteria", () => {
    expect(buildVerificationPrompt("Test", [])).toBe("");
  });
});

describe("createVerificationTask", () => {
  const goal: Goal = {
    id: "g1",
    description: "Build React components",
    priority: 1,
    status: "in_progress",
    constraints: [],
    acceptance_criteria: ["All components render"],
  };

  it("creates a task depending on integration task", () => {
    const task = createVerificationTask(goal, "g1-integration");
    expect(task).not.toBeNull();
    expect(task!.dependsOn).toEqual(["g1-integration"]);
    expect(task!.isolated).toBe(false);
    expect(task!.intent).toBe("investigation");
  });

  it("returns null when goal has no acceptance criteria", () => {
    const emptyGoal: Goal = { ...goal, acceptance_criteria: [] };
    expect(createVerificationTask(emptyGoal, "g1-integration")).toBeNull();
  });
});

describe("createIntegrationTask", () => {
  const goal: Goal = {
    id: "g1",
    description: "Build React components",
    priority: 1,
    status: "in_progress",
    constraints: [],
    acceptance_criteria: ["All components render"],
  };

  it("creates a task that depends on all completed tasks", () => {
    const task = createIntegrationTask(goal, ["t1", "t2", "t3"]);
    expect(task.dependsOn).toEqual(["t1", "t2", "t3"]);
    expect(task.isolated).toBe(false);
    expect(task.intent).toBe("implementation");
    expect(task.description).toContain("work together");
  });
});

describe("parseVerificationOutput", () => {
  it("detects failed criteria", () => {
    const output = `
[PASS]: All routes render without errors
[FAIL]: OAuth login flow works - no login page component found
[PASS]: Dark mode toggle persists
    `;
    const { passed, failedCriteria } = parseVerificationOutput(output, 3);
    expect(passed).toBe(false);
    expect(failedCriteria).toHaveLength(1);
    expect(failedCriteria[0]).toContain("OAuth login flow");
  });

  it("reports all passed when no failures", () => {
    const output = "[PASS]: criterion 1\n[PASS]: criterion 2";
    const { passed, failedCriteria } = parseVerificationOutput(output, 2);
    expect(passed).toBe(true);
    expect(failedCriteria).toHaveLength(0);
  });

  it("flags missing verdicts as failures", () => {
    const output = "[PASS]: criterion 1";
    const { passed, failedCriteria } = parseVerificationOutput(output, 3);
    expect(passed).toBe(false);
    expect(failedCriteria.some((c) => c.includes("no verdict"))).toBe(true);
  });
});
