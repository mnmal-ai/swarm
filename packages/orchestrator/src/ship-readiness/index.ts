/**
 * Ship-readiness gate — public barrel.
 *
 * The presence-triggered gate (active iff `.swarm/oversight/ship-readiness.json`
 * exists) is split across sibling modules: contract loading + goal scoping
 * (contract.ts), the deploy + smoke runner (gate.ts), and the failure follow-up
 * task builder (follow-up.ts), over a shared type surface (types.ts). This file
 * re-exports the public API so the orchestrator package has a single
 * ship-readiness import surface, matching how acceptance-verifier and
 * rate-limit-gate are surfaced from the package root.
 */

// Contract loading + goal scoping
export { loadShipReadinessContract, gateAppliesToGoal } from "./contract.js";

// Deploy + smoke gate runner (defaults exported so callers can inject or reuse them)
export {
  runShipReadinessGate,
  defaultCommandRunner,
  defaultFetch,
} from "./gate.js";

// Failure remediation task builder
export { buildShipReadinessFollowUpTask } from "./follow-up.js";

// Shared types: the reused contract schema, the operational gate result, and the
// injectable command/fetch types the gate runner depends on.
export type {
  ShipReadinessContract,
  ShipReadinessGate,
  ShipReadinessGateOutcome,
  ShipReadinessGateResult,
  SmokeEndpoint,
  FailedEndpoint,
  CommandRunner,
  CommandResult,
  Fetch,
  FetchResponse,
  RunShipReadinessGateOpts,
} from "./types.js";
