import { describe, it, expect } from "vitest";
import {
  precisionRecallF1,
  scoreIntents,
  scoreContentPaths,
  latencyPercentiles,
  type RecallObservation,
} from "./recall-metrics.js";

// Helper: build an observation with sensible defaults so each test only states
// the axis it cares about.
function obs(partial: Partial<RecallObservation>): RecallObservation {
  return {
    expectedIntent: "implementation",
    classifiedIntent: "implementation",
    expectedContentPaths: [],
    loadedPaths: [],
    ...partial,
  };
}

describe("precisionRecallF1", () => {
  it("computes P/R/F1 from confusion counts", () => {
    const { precision, recall, f1 } = precisionRecallF1(2, 1, 1);
    expect(precision).toBeCloseTo(2 / 3, 10);
    expect(recall).toBeCloseTo(2 / 3, 10);
    expect(f1).toBeCloseTo(2 / 3, 10);
  });

  it("returns 0 (not NaN) when tp+fp denominator is 0", () => {
    const { precision, recall, f1 } = precisionRecallF1(0, 0, 5);
    expect(precision).toBe(0);
    expect(recall).toBe(0);
    expect(f1).toBe(0);
  });

  it("returns 0 (not NaN) when all counts are 0", () => {
    const { precision, recall, f1 } = precisionRecallF1(0, 0, 0);
    expect(precision).toBe(0);
    expect(recall).toBe(0);
    expect(f1).toBe(0);
  });
});

describe("scoreIntents", () => {
  describe("perfect-match set", () => {
    it("yields P=R=F1=1 on micro, macro, and every intent", () => {
      const observations = [
        obs({ expectedIntent: "implementation", classifiedIntent: "implementation" }),
        obs({ expectedIntent: "code_review", classifiedIntent: "code_review" }),
        obs({ expectedIntent: "onboarding", classifiedIntent: "onboarding" }),
      ];
      const m = scoreIntents(observations);

      expect(m.micro.precision).toBe(1);
      expect(m.micro.recall).toBe(1);
      expect(m.micro.f1).toBe(1);
      expect(m.macroF1).toBe(1);
      for (const label of Object.keys(m.perIntent)) {
        expect(m.perIntent[label].f1).toBe(1);
      }
    });
  });

  describe("all-wrong set", () => {
    it("yields 0 across every aggregate and per-intent score", () => {
      const observations = [
        obs({ expectedIntent: "alpha", classifiedIntent: "beta" }),
        obs({ expectedIntent: "beta", classifiedIntent: "alpha" }),
      ];
      const m = scoreIntents(observations);

      expect(m.micro.precision).toBe(0);
      expect(m.micro.recall).toBe(0);
      expect(m.micro.f1).toBe(0);
      expect(m.macroF1).toBe(0);
      expect(m.perIntent.alpha.f1).toBe(0);
      expect(m.perIntent.beta.f1).toBe(0);
    });
  });

  describe("mixed set with hand-computed expectations", () => {
    // 6 observations across 3 intents:
    //   1. implementation -> implementation  (correct)
    //   2. implementation -> implementation  (correct)
    //   3. implementation -> code_review     (wrong)
    //   4. code_review    -> code_review     (correct)
    //   5. code_review    -> implementation  (wrong)
    //   6. onboarding     -> onboarding      (correct)
    //
    // implementation: TP=2 FP=1 FN=1 -> P=R=F1=2/3 = 0.66667
    // code_review:    TP=1 FP=1 FN=1 -> P=R=F1=1/2 = 0.50000
    // onboarding:     TP=1 FP=0 FN=0 -> P=R=F1=1   = 1.00000
    // micro: pooled TP=4 FP=2 FN=2 -> P=R=F1=4/6 = 0.66667
    // macroF1: (2/3 + 1/2 + 1)/3 = 0.72222
    const observations = [
      obs({ expectedIntent: "implementation", classifiedIntent: "implementation" }),
      obs({ expectedIntent: "implementation", classifiedIntent: "implementation" }),
      obs({ expectedIntent: "implementation", classifiedIntent: "code_review" }),
      obs({ expectedIntent: "code_review", classifiedIntent: "code_review" }),
      obs({ expectedIntent: "code_review", classifiedIntent: "implementation" }),
      obs({ expectedIntent: "onboarding", classifiedIntent: "onboarding" }),
    ];
    const m = scoreIntents(observations);

    it("scores the implementation intent to 5 decimals", () => {
      const s = m.perIntent.implementation;
      expect(s.tp).toBe(2);
      expect(s.fp).toBe(1);
      expect(s.fn).toBe(1);
      expect(s.precision).toBeCloseTo(0.66667, 5);
      expect(s.recall).toBeCloseTo(0.66667, 5);
      expect(s.f1).toBeCloseTo(0.66667, 5);
    });

    it("scores the code_review intent to 5 decimals", () => {
      const s = m.perIntent.code_review;
      expect(s.tp).toBe(1);
      expect(s.fp).toBe(1);
      expect(s.fn).toBe(1);
      expect(s.precision).toBeCloseTo(0.5, 5);
      expect(s.recall).toBeCloseTo(0.5, 5);
      expect(s.f1).toBeCloseTo(0.5, 5);
    });

    it("scores the onboarding intent to a perfect 1", () => {
      const s = m.perIntent.onboarding;
      expect(s.tp).toBe(1);
      expect(s.fp).toBe(0);
      expect(s.fn).toBe(0);
      expect(s.f1).toBeCloseTo(1.0, 5);
    });

    it("computes micro and macro aggregates to 5 decimals", () => {
      expect(m.micro.precision).toBeCloseTo(0.66667, 5);
      expect(m.micro.recall).toBeCloseTo(0.66667, 5);
      expect(m.micro.f1).toBeCloseTo(0.66667, 5);
      expect(m.macroF1).toBeCloseTo(0.72222, 5);
    });
  });

  it("returns empty metrics for an empty observation set", () => {
    const m = scoreIntents([]);
    expect(m.perIntent).toEqual({});
    expect(m.micro).toEqual({ precision: 0, recall: 0, f1: 0 });
    expect(m.macroF1).toBe(0);
  });
});

describe("scoreContentPaths", () => {
  describe("perfect-match set", () => {
    it("yields P=R=F1=1 when loaded exactly equals expected", () => {
      const observations = [
        obs({ expectedContentPaths: ["a.md", "b.md"], loadedPaths: ["a.md", "b.md"] }),
        obs({ expectedContentPaths: ["c.md"], loadedPaths: ["c.md"] }),
      ];
      const m = scoreContentPaths(observations);
      expect(m.tp).toBe(3);
      expect(m.fp).toBe(0);
      expect(m.fn).toBe(0);
      expect(m.precision).toBe(1);
      expect(m.recall).toBe(1);
      expect(m.f1).toBe(1);
    });
  });

  describe("all-wrong set", () => {
    it("yields 0 when loaded is disjoint from expected", () => {
      const observations = [
        obs({ expectedContentPaths: ["a.md"], loadedPaths: ["b.md"] }),
      ];
      const m = scoreContentPaths(observations);
      expect(m.tp).toBe(0);
      expect(m.precision).toBe(0);
      expect(m.recall).toBe(0);
      expect(m.f1).toBe(0);
    });
  });

  describe("asymmetric set with hand-computed expectations", () => {
    // Fixture A: expected {a,b,c}, loaded {a,b}        -> TP=2 FP=0 FN=1 (missing c)
    // Fixture B: expected {x},     loaded {x,y,z}      -> TP=1 FP=2 FN=0 (extra y,z)
    // Fixture C: expected {p,q},   loaded {q,r}        -> TP=1 FP=1 FN=1 (partial overlap)
    // pooled: TP=4 FP=3 FN=2
    //   precision = 4/7 = 0.57143
    //   recall    = 4/6 = 0.66667
    //   f1 = 2*TP/(2*TP+FP+FN) = 8/13 = 0.61538
    const observations = [
      obs({ expectedContentPaths: ["a.md", "b.md", "c.md"], loadedPaths: ["a.md", "b.md"] }),
      obs({ expectedContentPaths: ["x.md"], loadedPaths: ["x.md", "y.md", "z.md"] }),
      obs({ expectedContentPaths: ["p.md", "q.md"], loadedPaths: ["q.md", "r.md"] }),
    ];
    const m = scoreContentPaths(observations);

    it("pools TP/FP/FN across fixtures", () => {
      expect(m.tp).toBe(4);
      expect(m.fp).toBe(3);
      expect(m.fn).toBe(2);
    });

    it("derives precision/recall/f1 to 5 decimals", () => {
      expect(m.precision).toBeCloseTo(0.57143, 5);
      expect(m.recall).toBeCloseTo(0.66667, 5);
      expect(m.f1).toBeCloseTo(0.61538, 5);
    });
  });

  it("returns 0 for an empty observation set (divide-by-zero guard)", () => {
    const m = scoreContentPaths([]);
    expect(m.tp).toBe(0);
    expect(m.precision).toBe(0);
    expect(m.recall).toBe(0);
    expect(m.f1).toBe(0);
  });
});

describe("latencyPercentiles", () => {
  it("returns 0 for empty input", () => {
    expect(latencyPercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it("returns the lone value for every percentile on single-element input", () => {
    expect(latencyPercentiles([42])).toEqual({ p50: 42, p95: 42, p99: 42 });
  });

  it("computes nearest-rank percentiles on a known sorted array (1..100)", () => {
    // N=100. rank = ceil(p/100 * 100):
    //   p50 -> rank 50  -> value 50
    //   p95 -> rank 95  -> value 95
    //   p99 -> rank 99  -> value 99
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(latencyPercentiles(latencies)).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  it("sorts unordered input before ranking and does not mutate the caller's array", () => {
    const latencies = [100, 1, 50, 95, 99];
    const copy = [...latencies];
    const result = latencyPercentiles(latencies);
    // sorted = [1,50,95,99,100], N=5:
    //   p50 rank=ceil(2.5)=3 -> sorted[2]=95
    //   p95 rank=ceil(4.75)=5 -> sorted[4]=100
    //   p99 rank=ceil(4.95)=5 -> sorted[4]=100
    expect(result).toEqual({ p50: 95, p95: 100, p99: 100 });
    expect(latencies).toEqual(copy);
  });
});
