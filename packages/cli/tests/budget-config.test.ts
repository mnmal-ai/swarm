/**
 * `swarm run` refuses to start on a project config that still sets a dollar
 * limit, naming the file, the key and its token replacement. Ignoring the key
 * would leave the project running without the limit it chose.
 */

import { describe, it, expect } from "vitest";
import type { ProjectConfig } from "@mnmal-ai/swarm-types";
import { assertValidBudgetConfig } from "../src/cli/budget-config.js";

const CONFIG_PATH = "/tmp/swarm/domains/sample-project/config.json";

function project(concurrency: Record<string, unknown>): ProjectConfig {
  return {
    project: "sample-project",
    swarm_path: "/tmp/swarm",
    trust_level: "medium",
    concurrency,
    task_backend: "local",
    created: "2026-01-01T00:00:00Z",
  } as unknown as ProjectConfig;
}

describe("assertValidBudgetConfig", () => {
  for (const [oldKey, newKey] of [
    ["max_cost_per_session", "max_tokens_per_session"],
    ["max_cost_per_goal", "max_tokens_per_goal"],
    ["max_cost_per_task", "max_tokens_per_task"],
  ]) {
    it(`stops on concurrency.${oldKey}, naming the file and concurrency.${newKey}`, () => {
      const run = () => assertValidBudgetConfig(project({ max_workers: 1, [oldKey]: 5 }), CONFIG_PATH);

      expect(run).toThrow(CONFIG_PATH);
      expect(run).toThrow(`concurrency.${oldKey}`);
      expect(run).toThrow(`concurrency.${newKey}`);
    });
  }

  it("lets a token-only config through", () => {
    expect(() => assertValidBudgetConfig(project({ max_workers: 1, max_tokens_per_session: 60_000_000 }), CONFIG_PATH)).not.toThrow();
  });
});
