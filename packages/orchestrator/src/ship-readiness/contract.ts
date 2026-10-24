/**
 * Ship-readiness contract — pure load + validation.
 *
 * The presence of `<swarmPath>/oversight/ship-readiness.json` is itself the gate
 * trigger (plan Decision P): no top-level config flag. This module is the pure
 * foundation the gate runner imports — no process spawning, no network. It only
 * reads and validates the contract file, and answers whether the gate applies to
 * a given goal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ShipReadinessContract } from "./types.js";

/** Location of the contract, relative to the swarm root. */
const CONTRACT_RELATIVE_PATH = ["oversight", "ship-readiness.json"] as const;

/**
 * Load and validate the ship-readiness contract from `<swarmPath>/oversight/`.
 *
 * Returns `null` when the file is absent — the gate is inactive (Decision P
 * presence-trigger). Throws with a clear, path-qualified message when the file
 * exists but is unreadable, is malformed JSON, or fails shape validation. The
 * absent/malformed split matters: an absent file is a normal "gate off" state,
 * while a malformed file is a misconfiguration the operator must see, not a
 * silent skip.
 */
export function loadShipReadinessContract(
  swarmPath: string,
): ShipReadinessContract | null {
  const contractPath = join(swarmPath, ...CONTRACT_RELATIVE_PATH);

  let raw: string;
  try {
    raw = readFileSync(contractPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Failed to read ship-readiness contract at ${contractPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed ship-readiness contract at ${contractPath}: ${(err as Error).message}`,
    );
  }

  return validateContract(parsed, contractPath);
}

/**
 * Whether the gate applies to a specific goal.
 *
 * Decision P: the contract's mere presence activates the gate. `goalIds`, when
 * present, narrows it to the listed goals; when absent the gate applies to every
 * goal. An explicit empty array therefore scopes the gate to no goals.
 */
export function gateAppliesToGoal(
  contract: ShipReadinessContract,
  goalId: string,
): boolean {
  if (contract.goalIds === undefined) return true;
  return contract.goalIds.includes(goalId);
}

// ---------------------------------------------------------------------------
// Validation — defensive, shape-only. Validates the orchestrator-relevant
// fields; tolerates the extra catalog-template fields (platform, gates, ...).
// ---------------------------------------------------------------------------

function validateContract(
  value: unknown,
  contractPath: string,
): ShipReadinessContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid ship-readiness contract at ${contractPath}: expected a JSON object`,
    );
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.promoteCommand !== "string" || obj.promoteCommand.trim() === "") {
    throw new Error(
      `Invalid ship-readiness contract at ${contractPath}: "promoteCommand" must be a non-empty string`,
    );
  }

  if (obj.smokeEndpoints !== undefined) {
    if (!Array.isArray(obj.smokeEndpoints)) {
      throw new Error(
        `Invalid ship-readiness contract at ${contractPath}: "smokeEndpoints" must be an array`,
      );
    }
    obj.smokeEndpoints.forEach((ep, index) =>
      validateEndpoint(ep, index, contractPath),
    );
  }

  if (obj.goalIds !== undefined) {
    if (
      !Array.isArray(obj.goalIds) ||
      !obj.goalIds.every((g) => typeof g === "string")
    ) {
      throw new Error(
        `Invalid ship-readiness contract at ${contractPath}: "goalIds" must be an array of strings`,
      );
    }
  }

  return value as ShipReadinessContract;
}

function validateEndpoint(
  ep: unknown,
  index: number,
  contractPath: string,
): void {
  if (typeof ep !== "object" || ep === null || Array.isArray(ep)) {
    throw new Error(
      `Invalid ship-readiness contract at ${contractPath}: smokeEndpoints[${index}] must be an object`,
    );
  }
  const e = ep as Record<string, unknown>;

  if (typeof e.url !== "string" || e.url.trim() === "") {
    throw new Error(
      `Invalid ship-readiness contract at ${contractPath}: smokeEndpoints[${index}].url must be a non-empty string`,
    );
  }

  if (e.expectStatus !== undefined && typeof e.expectStatus !== "number") {
    throw new Error(
      `Invalid ship-readiness contract at ${contractPath}: smokeEndpoints[${index}].expectStatus must be a number`,
    );
  }

  if (e.jsonPath !== undefined && typeof e.jsonPath !== "string") {
    throw new Error(
      `Invalid ship-readiness contract at ${contractPath}: smokeEndpoints[${index}].jsonPath must be a string`,
    );
  }
}
