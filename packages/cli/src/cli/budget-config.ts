/**
 * swarm run's side of the token budgets: refusing, at startup, a project
 * config whose budget settings it cannot honour — above all a dollar limit
 * (`max_cost_per_*`), which is named with the token key that replaced it.
 * The rules live in validateBudgetConfig (@mnmal-ai/swarm-orchestrator).
 */

import { validateBudgetConfig } from "@mnmal-ai/swarm-orchestrator";
import type { ProjectConfig } from "@mnmal-ai/swarm-types";

/** Fail fast, with every problem and the config file named. */
export function assertValidBudgetConfig(projectConfig: ProjectConfig, configPath: string): void {
  const errors = validateBudgetConfig(projectConfig);
  if (errors.length === 0) return;
  throw new Error(`Invalid budget settings in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}
