/**
 * One-shot sweep runner for the recall benchmark (goal-12 task-3 measurement).
 *
 * Uses the REAL RecallBenchmark harness (no reimplementation of scoring or
 * sidecar boot). For each similarityThreshold in the grid it boots a fresh
 * recall-wired sidecar, seeds the content corpus at SWARM_PATH, runs all the fixtures
 * through classifyIntent + loadContext, and records per-split intent + content
 * path precision/recall/F1 plus classify p99. Emits a JSON results file the doc
 * write-up cites. Selection of the F1-peak and the TEST evaluation are done by
 * the human/script after reviewing the TRAIN curve printed below — this script
 * just produces the raw numbers for every grid point on BOTH splits (so the
 * single chosen value's TEST row is already present, no second tuning pass).
 *
 * Run from packages/benchmark with the repo-root tsx, naming the content
 * directory to seed (SWARM_PATH) and the project whose `domains/<project>/`
 * it holds (the first argument):
 *   SWARM_PATH=<content dir> ../../node_modules/.bin/tsx run-recall-sweep.mts <project>
 */

import { writeFileSync } from "node:fs";
import { RecallBenchmark } from "./src/recall-benchmark.js";

const GRID = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
const TOP_K = 8;

interface Row {
  similarityThreshold: number;
  topK: number;
  train: {
    count: number;
    intentMicro: { precision: number; recall: number; f1: number };
    intentMacroF1: number;
    contentPaths: { precision: number; recall: number; f1: number };
  };
  test: {
    count: number;
    intentMicro: { precision: number; recall: number; f1: number };
    intentMacroF1: number;
    contentPaths: { precision: number; recall: number; f1: number };
  };
  p99ClassifyMs: number;
  p50ClassifyMs: number;
  p95ClassifyMs: number;
}

function pick(m: { precision: number; recall: number; f1: number }) {
  return { precision: m.precision, recall: m.recall, f1: m.f1 };
}

const projectId = process.argv[2];
if (!process.env.SWARM_PATH || !projectId) {
  console.error("usage: SWARM_PATH=<content dir> tsx run-recall-sweep.mts <project>");
  process.exit(2);
}

const bench = new RecallBenchmark({
  swarmPath: process.env.SWARM_PATH,
  projectId,
});

const available = await RecallBenchmark.isOllamaAvailable();
if (!available) {
  console.error("Ollama not available — aborting (no fabricated numbers).");
  process.exit(2);
}

const rows: Row[] = [];

const fmt = (n: number) => n.toFixed(4);

console.log(`grid=${JSON.stringify(GRID)} topK=${TOP_K}`);
console.log(
  "thr | train: intP intR intF1 | cpP cpR cpF1 | p99ms || test: intF1 cpF1",
);

for (const threshold of GRID) {
  const t0 = Date.now();
  const res = await bench.run({ similarityThreshold: threshold, topK: TOP_K });
  const row: Row = {
    similarityThreshold: threshold,
    topK: TOP_K,
    train: {
      count: res.splits.train.count,
      intentMicro: pick(res.splits.train.intent.micro),
      intentMacroF1: res.splits.train.intent.macroF1,
      contentPaths: pick(res.splits.train.contentPaths),
    },
    test: {
      count: res.splits.test.count,
      intentMicro: pick(res.splits.test.intent.micro),
      intentMacroF1: res.splits.test.intent.macroF1,
      contentPaths: pick(res.splits.test.contentPaths),
    },
    p99ClassifyMs: res.p99ClassifyMs,
    p50ClassifyMs: res.latency.p50,
    p95ClassifyMs: res.latency.p95,
  };
  rows.push(row);
  console.log(
    `${threshold.toFixed(2)} | ` +
      `${fmt(row.train.intentMicro.precision)} ${fmt(row.train.intentMicro.recall)} ${fmt(row.train.intentMicro.f1)} | ` +
      `${fmt(row.train.contentPaths.precision)} ${fmt(row.train.contentPaths.recall)} ${fmt(row.train.contentPaths.f1)} | ` +
      `${row.p99ClassifyMs.toFixed(1)} || ` +
      `${fmt(row.test.intentMicro.f1)} ${fmt(row.test.contentPaths.f1)}  ` +
      `(${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}

const out = {
  meta: {
    grid: GRID,
    topK: TOP_K,
    swarmPath: process.env.SWARM_PATH,
    projectId,
    embedder: { model: "nomic-embed-text", dimension: 768 },
    generatedBy: "packages/benchmark/run-recall-sweep.mts",
  },
  rows,
};
writeFileSync("recall-sweep-results.json", JSON.stringify(out, null, 2));
console.log("\nWrote recall-sweep-results.json");
