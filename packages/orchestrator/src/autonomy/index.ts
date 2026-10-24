import type { ProjectConfig, AutonomyConfig, AutonomyExecution } from "@mnmal-ai/swarm-types";
import { AUTONOMY_PRESETS } from "./presets.js";

export { AUTONOMY_PRESETS } from "./presets.js";

/** The token-limit keys, with the dollar key each one replaced. */
const TOKEN_LIMIT_KEYS = [
  { key: "max_tokens_per_session", legacy: "max_cost_per_session" },
  { key: "max_tokens_per_goal", legacy: "max_cost_per_goal" },
  { key: "max_tokens_per_task", legacy: "max_cost_per_task" },
] as const;

/**
 * Derive the full AutonomyConfig for a project.
 *
 * Resolution order:
 * 1. If `config.autonomy` is present, use it (user has explicit control).
 * 2. Otherwise, look up the preset for `config.trust_level` (defaulting to "medium").
 * 3. Apply `config.concurrency` overrides to the execution block.
 *
 * Every token limit the chosen source leaves out takes the trust level's
 * preset value, so a project always has a task, goal and session limit.
 */
export function deriveAutonomy(config: ProjectConfig): AutonomyConfig {
  const preset = AUTONOMY_PRESETS[config.trust_level ?? "medium"];

  // If explicit autonomy block is present, use it — filling any token limit
  // it leaves out from the preset.
  if (config.autonomy) {
    const missing = TOKEN_LIMIT_KEYS.filter(({ key }) => config.autonomy!.execution?.[key] === undefined);
    if (missing.length === 0) return config.autonomy;
    return { ...config.autonomy, execution: withPresetLimits(config.autonomy.execution, preset.execution) };
  }

  // If concurrency overrides are present, apply them to the execution block.
  if (config.concurrency) {
    const c = config.concurrency;
    return {
      ...preset,
      execution: {
        ...preset.execution,
        max_workers: c.max_workers,
        max_tokens_per_session: c.max_tokens_per_session ?? preset.execution.max_tokens_per_session,
        max_tokens_per_goal: c.max_tokens_per_goal ?? preset.execution.max_tokens_per_goal,
        max_tokens_per_task: c.max_tokens_per_task ?? preset.execution.max_tokens_per_task,
      },
    };
  }

  return preset;
}

function withPresetLimits(execution: AutonomyExecution, preset: AutonomyExecution): AutonomyExecution {
  const filled = { ...execution };
  for (const { key } of TOKEN_LIMIT_KEYS) {
    if (filled[key] === undefined) filled[key] = preset[key];
  }
  return filled;
}

/**
 * Problems with a project's budget settings, one message each; empty when
 * there are none. Budgets are in tokens: a dollar key (`max_cost_per_*`) is
 * refused, naming the token key that replaced it, because ignoring it would
 * leave the project without the limit it chose. A token limit must be a
 * positive number.
 */
export function validateBudgetConfig(config: ProjectConfig): string[] {
  const errors: string[] = [];
  const sections: Array<{ path: string; block: unknown }> = [
    { path: "concurrency", block: config.concurrency },
    { path: "autonomy.execution", block: (config.autonomy as { execution?: unknown } | undefined)?.execution },
  ];
  for (const { path, block } of sections) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    for (const { key, legacy } of TOKEN_LIMIT_KEYS) {
      if (legacy in b) {
        errors.push(
          `${path}.${legacy} is no longer supported: budgets are in tokens. ` +
            `Replace it with ${path}.${key} (all input tokens, cache reads and writes included, plus output tokens).`,
        );
      }
      if (key in b && !isPositiveNumber(b[key])) {
        errors.push(`${path}.${key} must be a positive number of tokens (got ${JSON.stringify(b[key])})`);
      }
    }
  }
  return errors;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
