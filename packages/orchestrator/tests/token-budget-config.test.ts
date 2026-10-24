/**
 * Budgets are in tokens only. A project config that still carries a dollar
 * key must be refused at startup, naming the token key that replaces it —
 * ignoring it would leave the project running with no limit it chose.
 *
 * Every trust level has token limits for a task, a goal and a session, so a
 * project that sets none still has all three.
 */

import { describe, it, expect } from "vitest";
import { AUTONOMY_PRESETS, deriveAutonomy, validateBudgetConfig } from "../src/autonomy/index.js";
import type { AutonomyConfig, ProjectConfig } from "@mnmal-ai/swarm-types";

function project(overrides: Record<string, unknown> = {}): ProjectConfig {
  return {
    project: "sample-project",
    swarm_path: "/tmp/swarm",
    trust_level: "medium",
    concurrency: { max_workers: 3 },
    task_backend: "local",
    created: "2026-01-01T00:00:00Z",
    ...overrides,
  } as ProjectConfig;
}

describe("validateBudgetConfig refuses dollar limits", () => {
  const renamed: Array<[string, string]> = [
    ["max_cost_per_session", "max_tokens_per_session"],
    ["max_cost_per_goal", "max_tokens_per_goal"],
    ["max_cost_per_task", "max_tokens_per_task"],
  ];

  for (const [oldKey, newKey] of renamed) {
    it(`names concurrency.${newKey} for concurrency.${oldKey}`, () => {
      const errors = validateBudgetConfig(project({ concurrency: { max_workers: 3, [oldKey]: 5 } }));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`concurrency.${oldKey}`);
      expect(errors[0]).toContain(`concurrency.${newKey}`);
    });

    it(`names autonomy.execution.${newKey} for autonomy.execution.${oldKey}`, () => {
      const autonomy = { ...AUTONOMY_PRESETS.medium, execution: { ...AUTONOMY_PRESETS.medium.execution, [oldKey]: 5 } };

      const errors = validateBudgetConfig(project({ autonomy }));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`autonomy.execution.${oldKey}`);
      expect(errors[0]).toContain(`autonomy.execution.${newKey}`);
    });
  }

  it("reports every dollar key, not just the first", () => {
    const errors = validateBudgetConfig(project({
      concurrency: { max_workers: 3, max_cost_per_session: 50, max_cost_per_goal: 25, max_cost_per_task: 5 },
    }));

    expect(errors).toHaveLength(3);
  });

  it("accepts token limits", () => {
    expect(validateBudgetConfig(project({
      concurrency: { max_workers: 3, max_tokens_per_session: 60_000_000, max_tokens_per_goal: 20_000_000, max_tokens_per_task: 6_000_000 },
    }))).toEqual([]);
  });

  it("accepts a config with no limits at all (the trust level's defaults apply)", () => {
    expect(validateBudgetConfig(project())).toEqual([]);
  });

  it("refuses a token limit that is not a positive number", () => {
    const errors = validateBudgetConfig(project({ concurrency: { max_workers: 3, max_tokens_per_goal: 0, max_tokens_per_task: "6M" } }));

    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("concurrency.max_tokens_per_goal");
    expect(errors.join("\n")).toContain("concurrency.max_tokens_per_task");
  });
});

describe("AUTONOMY_PRESETS token limits", () => {
  const levels = ["low", "medium", "high"] as const;

  it("sets medium to 6M per task, 20M per goal, 60M per session", () => {
    const e = AUTONOMY_PRESETS.medium.execution;
    expect([e.max_tokens_per_task, e.max_tokens_per_goal, e.max_tokens_per_session]).toEqual([6_000_000, 20_000_000, 60_000_000]);
  });

  it("orders task < goal < session within every trust level", () => {
    for (const level of levels) {
      const e = AUTONOMY_PRESETS[level].execution;
      expect(e.max_tokens_per_task).toBeLessThan(e.max_tokens_per_goal);
      expect(e.max_tokens_per_goal).toBeLessThan(e.max_tokens_per_session);
    }
  });

  it("orders low < medium < high for every limit", () => {
    for (const key of ["max_tokens_per_task", "max_tokens_per_goal", "max_tokens_per_session"] as const) {
      expect(AUTONOMY_PRESETS.low.execution[key]).toBeLessThan(AUTONOMY_PRESETS.medium.execution[key]);
      expect(AUTONOMY_PRESETS.medium.execution[key]).toBeLessThan(AUTONOMY_PRESETS.high.execution[key]);
    }
  });

  it("carries no dollar limit", () => {
    for (const level of levels) {
      expect(Object.keys(AUTONOMY_PRESETS[level].execution).filter((k) => k.includes("cost"))).toEqual([]);
    }
  });
});

describe("deriveAutonomy token limits", () => {
  it("takes each limit from concurrency when set", () => {
    const e = deriveAutonomy(project({
      concurrency: { max_workers: 2, max_tokens_per_session: 9_000_000, max_tokens_per_goal: 4_000_000, max_tokens_per_task: 1_000_000 },
    })).execution;

    expect([e.max_tokens_per_task, e.max_tokens_per_goal, e.max_tokens_per_session]).toEqual([1_000_000, 4_000_000, 9_000_000]);
  });

  it("fills the limits concurrency leaves out from the trust level", () => {
    const e = deriveAutonomy(project({ trust_level: "high", concurrency: { max_workers: 2, max_tokens_per_goal: 4_000_000 } })).execution;

    expect(e.max_tokens_per_goal).toBe(4_000_000);
    expect(e.max_tokens_per_task).toBe(AUTONOMY_PRESETS.high.execution.max_tokens_per_task);
    expect(e.max_tokens_per_session).toBe(AUTONOMY_PRESETS.high.execution.max_tokens_per_session);
  });

  it("fills limits an explicit autonomy block leaves out from the trust level", () => {
    const execution = { ...AUTONOMY_PRESETS.low.execution } as Partial<AutonomyConfig["execution"]>;
    delete execution.max_tokens_per_task;
    const autonomy = { ...AUTONOMY_PRESETS.low, execution } as AutonomyConfig;

    const e = deriveAutonomy(project({ trust_level: "low", autonomy })).execution;

    expect(e.max_tokens_per_task).toBe(AUTONOMY_PRESETS.low.execution.max_tokens_per_task);
    expect(e.max_tokens_per_goal).toBe(AUTONOMY_PRESETS.low.execution.max_tokens_per_goal);
  });
});
