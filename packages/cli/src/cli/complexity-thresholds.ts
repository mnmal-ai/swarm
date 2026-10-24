/**
 * Complexity thresholds for `swarm run`, from the swarm's swarm.json.
 *
 * Every task's description is scored 0-100 (estimateComplexity) and banded
 * simple / moderate / complex against these thresholds; the band decides the
 * task's timeout, whether its escalation watcher runs, and (as the project's
 * decomposition policy allows) whether it is split into sub-tasks.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configToThresholds, DEFAULT_COMPLEXITY_THRESHOLDS } from "@mnmal-ai/swarm-orchestrator";
import type { ComplexityConfig, ComplexityThresholds } from "@mnmal-ai/swarm-types";

export interface LoadedComplexityThresholds {
  thresholds: ComplexityThresholds;
  /** The swarm.json the thresholds came from; null when they are the defaults. */
  source: string | null;
}

/**
 * Read `complexity` from `<swarmPath>/swarm.json`. Without the file or the
 * section, today's defaults (simple ≤30, complex ≥61). Escalation fractions
 * the section leaves out keep their defaults. Throws, naming the file and the
 * key, on a section swarm run cannot use — including simple_max ≥ complex_min.
 */
export function loadComplexityThresholds(swarmPath: string): LoadedComplexityThresholds {
  const file = join(swarmPath, "swarm.json");
  if (!existsSync(file)) return { thresholds: { ...DEFAULT_COMPLEXITY_THRESHOLDS }, source: null };

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`Invalid complexity in ${file}: swarm.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  const section = (manifest as { complexity?: unknown } | null)?.complexity;
  if (section === undefined) return { thresholds: { ...DEFAULT_COMPLEXITY_THRESHOLDS }, source: null };

  try {
    return { thresholds: configToThresholds(toComplexityConfig(section)), source: file };
  } catch (err) {
    throw new Error(`Invalid complexity in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The banner's Complexity row, e.g. `simple ≤30 · complex ≥61 (defaults)`. */
export function describeComplexityThresholds(loaded: LoadedComplexityThresholds): string {
  const { simpleMax, complexMin } = loaded.thresholds;
  return `simple ≤${simpleMax} · complex ≥${complexMin} (${loaded.source ? "swarm.json" : "defaults"})`;
}

function toComplexityConfig(section: unknown): ComplexityConfig {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`complexity must be an object like { "simple_max": 30, "complex_min": 61 } (got ${JSON.stringify(section)})`);
  }
  const c = section as Record<string, unknown>;
  // `description` is prose the scaffold writes into the section; anything else
  // unknown is a typo or a stale key, and ignoring it would hide the mistake.
  rejectUnknownKeys(c, ["description", "simple_max", "complex_min", "escalation"], "complexity");
  const escalation = c.escalation ?? {};
  if (escalation === null || typeof escalation !== "object" || Array.isArray(escalation)) {
    throw new Error(`complexity.escalation must be an object (got ${JSON.stringify(escalation)})`);
  }
  const e = escalation as Record<string, unknown>;
  // Budgets are in tokens, so the escalation fraction is a share of the task
  // token limit; the old dollar-era key is refused with its replacement named.
  if ("cost_fraction" in e) {
    throw new Error(
      "complexity.escalation.cost_fraction is no longer supported: budgets are in tokens. " +
        "Replace it with complexity.escalation.token_fraction (the share of the task token limit at which a running task escalates).",
    );
  }
  rejectUnknownKeys(e, ["token_fraction", "turn_fraction", "timeout_fraction"], "complexity.escalation");
  const d = DEFAULT_COMPLEXITY_THRESHOLDS;
  return {
    simple_max: requireNumber(c.simple_max, "complexity.simple_max"),
    complex_min: requireNumber(c.complex_min, "complexity.complex_min"),
    escalation: {
      token_fraction: optionalFraction(e.token_fraction, "complexity.escalation.token_fraction", d.tokenEscalationFraction),
      turn_fraction: optionalFraction(e.turn_fraction, "complexity.escalation.turn_fraction", d.turnEscalationFraction),
      timeout_fraction: optionalFraction(e.timeout_fraction, "complexity.escalation.timeout_fraction", d.timeoutEscalationFraction),
    },
  };
}

function rejectUnknownKeys(obj: Record<string, unknown>, known: readonly string[], prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      throw new Error(`unknown key ${prefix}.${key} (known: ${known.join(", ")})`);
    }
  }
}

function requireNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * An escalation fraction: the share of a task's budget at which the watcher
 * fires. Above 1 it would never fire; at or below 0 it would fire at once.
 */
function optionalFraction(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = requireNumber(value, key);
  if (n <= 0 || n > 1) throw new Error(`${key} must be greater than 0 and at most 1 (got ${n})`);
  return n;
}
