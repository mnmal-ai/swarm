/**
 * Deterministic, sidecar-free scoring functions for the RecallBenchmark.
 *
 * These measure the quality of swarm's `classifyIntent` (multi-class intent
 * classification) and `loadContext` (which content paths get loaded) against a
 * labeled fixture set derived from real swarm runs. No I/O, no class, no
 * imports from sidecar/Substrate packages — pure functions over plain data so the
 * tuning task can call them in a tight loop.
 *
 * Divide-by-zero convention matches the Loader's `budgetUsedPercent`
 * (`denominator > 0 ? n / denominator : 0`): a zero denominator yields 0, never
 * NaN/Infinity. See packages/core/src/loader/index.ts.
 */

// ---------------------------------------------------------------------------
// Labeled-pair types
// ---------------------------------------------------------------------------

/**
 * One labeled observation from a real swarm run: the expected vs. actual intent
 * classification, and the expected vs. actually-loaded content paths.
 *
 * Intents are kept as plain strings (not a coupled enum) so a fixture can carry
 * any intent label the router emits without this module depending on the
 * router's type surface.
 */
export interface RecallObservation {
  /** Ground-truth intent label for this fixture. */
  expectedIntent: string;
  /** Intent label produced by `classifyIntent`. */
  classifiedIntent: string;
  /** Ground-truth content paths that should have been loaded. */
  expectedContentPaths: string[];
  /** Content paths actually loaded by `loadContext`. */
  loadedPaths: string[];
}

/** Precision / recall / F1 triple. */
export interface PrecisionRecallF1 {
  precision: number;
  recall: number;
  f1: number;
}

/** Per-class confusion counts plus its derived precision/recall/F1. */
export interface IntentClassScore extends PrecisionRecallF1 {
  tp: number;
  fp: number;
  fn: number;
}

/** Aggregate intent scoring across all observations. */
export interface IntentMetrics {
  /** One-vs-rest score for each intent label seen (expected or classified). */
  perIntent: Record<string, IntentClassScore>;
  /** Micro-averaged P/R/F1 from pooled TP/FP/FN across all classes. */
  micro: PrecisionRecallF1;
  /** Macro-averaged F1: unweighted mean of every per-intent F1. */
  macroF1: number;
}

/** Set-overlap scoring for content paths, pooled across fixtures. */
export interface ContentPathMetrics extends PrecisionRecallF1 {
  tp: number;
  fp: number;
  fn: number;
}

/** Latency percentiles (milliseconds). */
export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

// ---------------------------------------------------------------------------
// Precision / recall / F1 primitive
// ---------------------------------------------------------------------------

/**
 * Compute precision/recall/F1 from raw confusion counts.
 *
 * Divide-by-zero guard: a zero denominator returns 0 (matching the Loader
 * `budgetUsedPercent` convention) rather than producing NaN. F1 is the harmonic
 * mean of precision and recall, and is 0 whenever precision + recall is 0.
 */
export function precisionRecallF1(tp: number, fp: number, fn: number): PrecisionRecallF1 {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

// ---------------------------------------------------------------------------
// Intent scoring (multi-class, one-vs-rest)
// ---------------------------------------------------------------------------

/**
 * Score intent classification as a multi-class problem. Each distinct intent
 * label (drawn from the union of expected and classified labels) is treated as
 * a one-vs-rest binary class:
 *   - TP: expected == L and classified == L
 *   - FP: expected != L and classified == L
 *   - FN: expected == L and classified != L
 *
 * Aggregates are reported two ways so the tuning task can pick:
 *   - micro: pool TP/FP/FN across all classes, then derive P/R/F1. For
 *     single-label classification this equals overall accuracy.
 *   - macroF1: the unweighted mean of every per-intent F1, which weights rare
 *     intents equally with common ones.
 */
export function scoreIntents(observations: RecallObservation[]): IntentMetrics {
  const labels = new Set<string>();
  for (const obs of observations) {
    labels.add(obs.expectedIntent);
    labels.add(obs.classifiedIntent);
  }

  const perIntent: Record<string, IntentClassScore> = {};
  let pooledTp = 0;
  let pooledFp = 0;
  let pooledFn = 0;
  let f1Sum = 0;

  // Sort labels for deterministic perIntent key ordering.
  for (const label of [...labels].sort()) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const obs of observations) {
      const expectedIsL = obs.expectedIntent === label;
      const classifiedIsL = obs.classifiedIntent === label;
      if (expectedIsL && classifiedIsL) tp++;
      else if (!expectedIsL && classifiedIsL) fp++;
      else if (expectedIsL && !classifiedIsL) fn++;
    }

    const prf = precisionRecallF1(tp, fp, fn);
    perIntent[label] = { tp, fp, fn, ...prf };

    pooledTp += tp;
    pooledFp += fp;
    pooledFn += fn;
    f1Sum += prf.f1;
  }

  const micro = precisionRecallF1(pooledTp, pooledFp, pooledFn);
  const macroF1 = labels.size > 0 ? f1Sum / labels.size : 0;

  return { perIntent, micro, macroF1 };
}

// ---------------------------------------------------------------------------
// Content-path scoring (set overlap, pooled across fixtures)
// ---------------------------------------------------------------------------

/**
 * Score loaded content paths against expected paths as a per-fixture set-overlap
 * problem, then pool the counts across fixtures:
 *   - TP: path in both expected and loaded (intersection)
 *   - FP: loaded but not expected
 *   - FN: expected but not loaded
 *
 * Duplicate paths within a single fixture's array are collapsed (set semantics).
 */
export function scoreContentPaths(observations: RecallObservation[]): ContentPathMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const obs of observations) {
    const expected = new Set(obs.expectedContentPaths);
    const loaded = new Set(obs.loadedPaths);

    for (const p of loaded) {
      if (expected.has(p)) tp++;
      else fp++;
    }
    for (const p of expected) {
      if (!loaded.has(p)) fn++;
    }
  }

  const prf = precisionRecallF1(tp, fp, fn);
  return { tp, fp, fn, ...prf };
}

// ---------------------------------------------------------------------------
// Latency percentiles (nearest-rank)
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile of a sorted-ascending array. For percentile `p` in
 * (0,100], rank = ceil(p/100 * N) clamped to [1, N], and the value is the
 * element at that 1-based rank. Returns 0 for an empty array.
 */
function nearestRank(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const clamped = Math.min(Math.max(rank, 1), n);
  return sortedAsc[clamped - 1];
}

/**
 * Compute p50/p95/p99 of classify latencies (ms) via the nearest-rank method.
 *
 * Edge cases:
 *   - empty input → all percentiles 0 (matching the divide-by-zero convention
 *     of returning 0 rather than null/NaN for a degenerate input).
 *   - single element → every percentile equals that element.
 */
export function latencyPercentiles(latencies: number[]): LatencyPercentiles {
  // Copy before sorting so the caller's array is not mutated.
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
  };
}
