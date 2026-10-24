/**
 * Guardrail measurement runner for the goal-12 similarityThreshold default
 * (the "capture the two guardrail measurements" sub-task).
 *
 * The set-default sub-task selected similarityThreshold = 0.0, which EQUALS the
 * pre-existing RECALL_SIMILARITY_THRESHOLD_DEFAULT — so "before tuning" and
 * "after tuning" are the SAME numeric configuration. This driver makes that
 * explicit by running the REAL RecallBenchmark harness (same in-process,
 * port-less, Ollama-gated sidecar the recall E2E suites use) twice:
 *
 *   BEFORE = pre-change default (0.0)   AFTER = new/selected default (0.0)
 *
 * For each run it records, from the curl-timed classifyIntent round trips the
 * harness already measures:
 *   1. Latency guardrail   -> classify p99 (ms). After must stay within +10 ms
 *      of the Before baseline (the constraint's fixed latency budget).
 *   2. Cold-test parity    -> the "arbiter intervention rate" proxy. The
 *      oversight arbiter triggers on `confidence_below_threshold`
 *      (oversight/review-policy.json), so the faithful cold-path signal this
 *      sidecar exposes is the share of classifyIntent results returning the
 *      `fallback` confidence tier (no exact/keyword/semantic match -> the
 *      low-confidence case that drives arbiter involvement downstream). After
 *      must NOT increase over Before (ideally decreases).
 *
 * Emits run-recall-guardrails-results.json the doc cites. Changes no production
 * defaults; read-only against a seeded in-memory sidecar.
 *
 * Run from packages/benchmark with the repo-root tsx, naming the content
 * directory to seed (SWARM_PATH) and the project whose `domains/<project>/`
 * it holds (the first argument):
 *   SWARM_PATH=<content dir> \
 *   SWARM_EMBEDDER_OLLAMA_URL=http://127.0.0.1:11434 \
 *     ../../node_modules/.bin/tsx run-recall-guardrails.mts <project>
 */

import { writeFileSync } from "node:fs";
import { RecallBenchmark } from "./src/recall-benchmark.js";

const TOP_K = 8;
// Both legs run at 0.0: the pre-change default and the selected new default are
// the same value (see the set-default sub-task). Running both proves the
// before/after delta on real, independently-timed curl round trips.
const PRE_CHANGE_DEFAULT = 0.0;
const NEW_DEFAULT = 0.0;

interface GuardrailLeg {
  label: string;
  similarityThreshold: number;
  fixtureCount: number;
  p50ClassifyMs: number;
  p95ClassifyMs: number;
  p99ClassifyMs: number;
  /** confidence-tier counts across all fixtures (exact|keyword|semantic|fallback). */
  confidenceTiers: Record<string, number>;
  /** fallback count / fixtureCount — the arbiter-intervention proxy. */
  interventionRate: number;
}

const projectId = process.argv[2];
if (!process.env.SWARM_PATH || !projectId) {
  console.error("usage: SWARM_PATH=<content dir> tsx run-recall-guardrails.mts <project>");
  process.exit(2);
}

const bench = new RecallBenchmark({
  swarmPath: process.env.SWARM_PATH,
  projectId,
});

if (!(await RecallBenchmark.isOllamaAvailable())) {
  console.error("Ollama not available — aborting (no fabricated numbers).");
  process.exit(2);
}

async function measure(label: string, similarityThreshold: number): Promise<GuardrailLeg> {
  const res = await bench.run({ similarityThreshold, topK: TOP_K });
  const tiers: Record<string, number> = {};
  for (const o of res.observations) {
    tiers[o.confidence] = (tiers[o.confidence] ?? 0) + 1;
  }
  const fallback = tiers.fallback ?? 0;
  return {
    label,
    similarityThreshold,
    fixtureCount: res.fixtureCount,
    p50ClassifyMs: res.latency.p50,
    p95ClassifyMs: res.latency.p95,
    p99ClassifyMs: res.p99ClassifyMs,
    confidenceTiers: tiers,
    interventionRate: res.fixtureCount === 0 ? 0 : fallback / res.fixtureCount,
  };
}

console.log("Measuring BEFORE (pre-change default)…");
const before = await measure("before (pre-change default)", PRE_CHANGE_DEFAULT);
console.log("Measuring AFTER (new default)…");
const after = await measure("after (new default)", NEW_DEFAULT);

const latencyDeltaMs = after.p99ClassifyMs - before.p99ClassifyMs;
const interventionDelta = after.interventionRate - before.interventionRate;

const verdict = {
  latencyWithinBudget: latencyDeltaMs <= 10,
  interventionDidNotIncrease: interventionDelta <= 0,
};

const out = {
  meta: {
    purpose: "goal-12 similarityThreshold default — latency + cold-test-parity guardrails",
    topK: TOP_K,
    preChangeDefault: PRE_CHANGE_DEFAULT,
    newDefault: NEW_DEFAULT,
    note:
      "new default == pre-change default (0.0): no numeric config delta. " +
      "Both legs measured independently so the before/after p99 + intervention pairs are real curl-timed numbers.",
    swarmPath: process.env.SWARM_PATH,
    projectId,
    embedder: { model: "nomic-embed-text", dimension: 768 },
    generatedBy: "packages/benchmark/run-recall-guardrails.mts",
  },
  before,
  after,
  deltas: { p99ClassifyMs: latencyDeltaMs, interventionRate: interventionDelta },
  verdict,
};

writeFileSync("run-recall-guardrails-results.json", JSON.stringify(out, null, 2));

const f = (n: number) => n.toFixed(3);
console.log("\n=== Guardrail results ===");
console.log(`BEFORE  p99=${f(before.p99ClassifyMs)}ms  intervention=${f(before.interventionRate)}  tiers=${JSON.stringify(before.confidenceTiers)}`);
console.log(`AFTER   p99=${f(after.p99ClassifyMs)}ms  intervention=${f(after.interventionRate)}  tiers=${JSON.stringify(after.confidenceTiers)}`);
console.log(`DELTA   p99=${f(latencyDeltaMs)}ms (budget +10ms -> ${verdict.latencyWithinBudget ? "PASS" : "FAIL"})  intervention=${f(interventionDelta)} (no-increase -> ${verdict.interventionDidNotIncrease ? "PASS" : "FAIL"})`);
console.log("\nWrote run-recall-guardrails-results.json");
