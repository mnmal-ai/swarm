/**
 * Ship-readiness gate — shared types.
 *
 * The contract *schema* (ShipReadinessContract, SmokeEndpoint, ShipReadinessGate)
 * is REUSED from @mnmal-ai/swarm-types, the canonical home for the goal-6a
 * suggestion-flow `ship-readiness.json` shape. This module re-exports those so
 * orchestrator-internal code has a single ship-readiness import surface, and adds
 * the *operational* types the presence-triggered gate needs: injectable command
 * and fetch functions (so the gate runner is unit-testable without spawning
 * processes or hitting the network), the gate input, and a structured result
 * whose evidence differs by failure mode.
 */

import type { ShipReadinessContract } from "@mnmal-ai/swarm-types";

export type {
  ShipReadinessContract,
  ShipReadinessGate,
  ShipReadinessGateOutcome,
  ShipReadinessGateResult,
  SmokeEndpoint,
  FailedEndpoint,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Injectable side-effect functions
//
// These are deliberately narrow structural subsets of `child_process` exec and
// the WHATWG `fetch` so the real implementations satisfy them, while tests can
// pass in trivial fakes. No sub-task that depends on these may reach for the
// concrete process/network APIs directly — they receive these instead.
// ---------------------------------------------------------------------------

/** Captured output of a single deploy-command invocation. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the user-specified deploy command (provider-agnostic — we shell out to
 * whatever string the contract carries). Resolves with the captured result even
 * on a non-zero exit; it rejects only when the command cannot be launched at all.
 */
export type CommandRunner = (
  command: string,
  opts?: { cwd?: string },
) => Promise<CommandResult>;

/** Minimal response shape the smoke poller needs. Satisfied by `fetch`'s Response. */
export interface FetchResponse {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Fetches a single smoke endpoint. A structural subset of `globalThis.fetch`,
 * so the global can be passed as the default while tests inject a fake.
 */
export type Fetch = (url: string) => Promise<FetchResponse>;

// ---------------------------------------------------------------------------
// Gate input
// ---------------------------------------------------------------------------

/** Input for a single run of the presence-triggered ship-readiness gate. */
export interface RunShipReadinessGateOpts {
  /** The loaded, validated contract (presence already confirmed by the caller). */
  contract: ShipReadinessContract;
  /** The goal whose completion is being gated. */
  goalId: string;
  /** Working directory for the deploy command. Defaults to the process cwd. */
  cwd?: string;
  /** Injected deploy-command runner. */
  runCommand: CommandRunner;
  /** Injected fetch used to poll smoke endpoints. */
  fetch: Fetch;
}

// Gate-result types (FailedEndpoint, ShipReadinessGateResult) live in
// @mnmal-ai/swarm-types as the canonical public shape and are re-exported
// from the `export type { ... }` block above for orchestrator-internal use.
