import { describe, expect, it } from "vitest";
import {
  RecallBenchmark,
  type RecallFixture,
  type RecallFixtureObservation,
} from "./recall-benchmark.js";
import {
  latencyPercentiles,
  scoreContentPaths,
  scoreIntents,
} from "./recall-metrics.js";

// E2E gate — the full sidecar run is exercised only under SWARM_SDK_E2E=1 with a
// reachable Ollama and a SWARM_PATH corpus, mirroring the integration suites.
const RUN_E2E = process.env.SWARM_SDK_E2E === "1";

// A benchmark instance that never touches disk (pre-parsed empty fixtures) — used
// to drive the pure `computeResult` seam without booting a sidecar.
function pureBench(): RecallBenchmark {
  return new RecallBenchmark({ fixtures: [] });
}

function obs(partial: Partial<RecallFixtureObservation>): RecallFixtureObservation {
  return {
    prompt: "p",
    split: "train",
    expectedIntent: "implementation",
    classifiedIntent: "implementation",
    confidence: "keyword",
    expectedContentPaths: ["core/rules.md"],
    loadedPaths: ["core/rules.md"],
    classifyMs: 1,
    ...partial,
  };
}

describe("RecallBenchmark.loadFixtures", () => {
  it("returns a pre-parsed fixture array verbatim", async () => {
    const fixtures: RecallFixture[] = [
      { prompt: "build a thing", expectedIntent: "implementation", expectedContentPaths: ["core/rules.md"] },
    ];
    const bench = new RecallBenchmark({ fixtures });
    expect(await bench.loadFixtures()).toEqual(fixtures);
  });

  it("unwraps the { meta, fixtures } file shape", async () => {
    const fixtures: RecallFixture[] = [
      { prompt: "why broken", expectedIntent: "investigation", expectedContentPaths: ["modes/investigation.md"] },
    ];
    const bench = new RecallBenchmark({ fixtures: { meta: { fixtureCount: 1 }, fixtures } });
    expect(await bench.loadFixtures()).toEqual(fixtures);
  });
});

describe("RecallBenchmark.computeResult", () => {
  it("partitions train/test and scores each split separately via recall-metrics", () => {
    const observations = [
      obs({ split: "train", expectedIntent: "implementation", classifiedIntent: "implementation" }),
      obs({ split: "train", expectedIntent: "investigation", classifiedIntent: "implementation" }),
      obs({ split: "test", expectedIntent: "orchestration", classifiedIntent: "orchestration" }),
    ];
    const latencies = observations.map((o) => o.classifyMs);

    const result = pureBench().computeResult(observations, latencies, 0.42, 8);

    expect(result.similarityThreshold).toBe(0.42);
    expect(result.topK).toBe(8);
    expect(result.fixtureCount).toBe(3);
    expect(result.splits.train.count).toBe(2);
    expect(result.splits.test.count).toBe(1);

    // Delegation, not reimplementation: each split's scores equal the metric
    // functions called directly on that split's observations.
    const train = observations.filter((o) => o.split === "train");
    const test = observations.filter((o) => o.split === "test");
    expect(result.splits.train.intent).toEqual(scoreIntents(train));
    expect(result.splits.train.contentPaths).toEqual(scoreContentPaths(train));
    expect(result.splits.test.intent).toEqual(scoreIntents(test));
    expect(result.splits.test.contentPaths).toEqual(scoreContentPaths(test));
  });

  it("reports the classify p99 via the recall-metrics percentile helper", () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100ms
    const observations = latencies.map((ms) => obs({ classifyMs: ms }));

    const result = pureBench().computeResult(observations, latencies, 0, 8);

    expect(result.latency).toEqual(latencyPercentiles(latencies));
    expect(result.p99ClassifyMs).toBe(result.latency.p99);
    expect(result.p99ClassifyMs).toBe(99); // nearest-rank p99 of 1..100
  });

  it("yields zeroed metrics (never NaN) for an empty split", () => {
    const result = pureBench().computeResult([], [], 0, 8);
    expect(result.fixtureCount).toBe(0);
    expect(result.splits.train.count).toBe(0);
    expect(result.splits.test.count).toBe(0);
    expect(result.splits.train.contentPaths.f1).toBe(0);
    expect(result.p99ClassifyMs).toBe(0);
  });
});

// --- E2E: full recall-wired sidecar run (gated) ----------------------------
describe.skipIf(!RUN_E2E)("RecallBenchmark.run (real recall sidecar)", () => {
  it(
    "boots, seeds, scores both splits, and reports classify p99",
    async (ctx) => {
      if (!process.env.SWARM_PATH) ctx.skip();
      if (!(await RecallBenchmark.isOllamaAvailable())) ctx.skip();

      const bench = new RecallBenchmark({ swarmPath: process.env.SWARM_PATH });
      const result = await bench.run({ similarityThreshold: 0 });

      expect(result.fixtureCount).toBeGreaterThan(0);
      expect(result.splits.train.count + result.splits.test.count).toBe(result.fixtureCount);
      expect(result.splits.test.count).toBeGreaterThan(0); // >= 20% held out
      expect(result.p99ClassifyMs).toBeGreaterThanOrEqual(0);
      expect(result.observations).toHaveLength(result.fixtureCount);
    },
    600_000,
  );
});
