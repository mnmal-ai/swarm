/**
 * swarm drainstop — Force a one-shot drainstop pass on the cold Substrate sidecar.
 *
 * The swarm plugin's drainstop normally fires on a scheduled interval (default
 * 1h), too coarse for a short-lived cold-test run that wants to see promotion
 * happen now. This command POSTs the trigger the plugin mounts
 * (`TRIGGER_DRAINSTOP_PATH`) on the cold sidecar and prints what the pass
 * promoted into the context store, expired, and failed to do.
 *
 * Thin by design: all promotion logic lives in the plugin's
 * `runDrainstopOnce` (one implementation, reached by both the interval tick and
 * this trigger). This module only fires the trigger and reports the result.
 */

import { type DrainstopResult, SubstrateClient, TRIGGER_DRAINSTOP_PATH } from "@mnmal-ai/swarm-substrate";
import type { ProjectSubstrateConfig } from "../project-substrate.js";
import { resolveSubstrateStack } from "./substrate.js";

// --- ANSI helpers ---

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// --- Public entry point ---

export async function runDrainstop(
  _positional: string[],
  _flags: Record<string, string>,
  /** The project's Substrate config, as the CLI preamble read and applied it. */
  project?: ProjectSubstrateConfig,
): Promise<void> {
  // The cold sidecar of the stack this project resolves to, exactly as
  // `swarm substrate` resolves it — including the local_only check, which
  // throws before any request is made.
  const endpoint = resolveSubstrateStack(project).cold.endpoint.replace(/\/+$/, "");

  // Gate on liveness first so an unreachable sidecar yields an actionable
  // message rather than an opaque fetch failure on the trigger POST below.
  if (!(await new SubstrateClient(endpoint).isHealthy())) {
    console.error(
      `${RED}The Substrate sidecar is not reachable at ${endpoint}.${RESET}\n` +
        `Start it with ${BOLD}swarm substrate start${RESET} and try again.`,
    );
    process.exit(1);
  }

  // The trigger is a plugin route, not a query or mutate frame, so the client
  // has no method for it — POST it directly. The route answers 200 with a
  // DrainstopResult, or 500 with { code, message } on failure.
  let result: DrainstopResult;
  try {
    const response = await fetch(`${endpoint}${TRIGGER_DRAINSTOP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Valid JSON, so a server that refuses an empty JSON body still runs it.
      body: "{}",
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
      console.error(`${RED}Drainstop failed:${RESET} ${message}`);
      process.exit(1);
    }
    result = body as unknown as DrainstopResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${RED}Drainstop request failed:${RESET} ${message}`);
    process.exit(1);
  }

  const { todos, decisions, agentRules } = result.promoted;
  const promoted = todos + decisions + agentRules;
  const failures = result.failures ?? [];

  console.log("");
  console.log(`${BOLD}Drainstop complete${RESET}`);
  console.log("");
  console.log(`  ${GREEN}${promoted}${RESET} observation${promoted === 1 ? "" : "s"} promoted to the context store`);
  console.log(`    ${DIM}todos:${RESET}       ${todos}`);
  console.log(`    ${DIM}decisions:${RESET}   ${decisions}`);
  console.log(`    ${DIM}agent rules:${RESET} ${agentRules}`);
  console.log("");
  console.log(`  ${DIM}absorbed:${RESET} ${result.absorbed}   ${DIM}expired:${RESET} ${result.expired}`);
  if (result.anchorSeeded) {
    console.log(`  ${DIM}seeded the confidence=50 calibration anchor (first pass)${RESET}`);
  }
  if (result.truncated) {
    console.log(`  ${YELLOW}stopped at the page cap with observations left unread; run it again to continue${RESET}`);
  }
  if (failures.length > 0) {
    console.log("");
    console.log(`  ${YELLOW}${failures.length} failure${failures.length === 1 ? "" : "s"}${RESET} ${DIM}(each kept its observation)${RESET}`);
    for (const f of failures) {
      const what = [f.phase, f.observationId ?? "run", f.code ?? f.name].filter((x) => x !== null && x !== "").join(" · ");
      console.log(`    ${what}: ${f.message}`);
    }
  } else {
    console.log(`  ${DIM}failures: 0${RESET}`);
  }
  console.log("");
}
