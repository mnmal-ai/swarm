# Metrics Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every phase, session, tool call, store call, shell-out and queue in `swarm run` records a local metric, and the owner reads them at the end of each run, with `swarm metrics`, and on the run dashboard's Performance panel.

**Architecture:** A new zero-dependency package, `packages/metrics` (`@mnmal-ai/swarm-metrics`), holds the registry, the JSON-lines sink, the read and analysis side, the process sampler and the catalogue of every metric swarm records. `swarm run` builds one registry per run with `run_id` as a base label and hands it down through the existing constructors; each choke point (the Substrate client, the git and gh helpers, the task sources, the agent backends, the merge gate, the orchestrator's phases) records the catalogue's rows. The Swarm OS plans (02 to 09) record their own rows on the same library through `BrainContext.metrics`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), node builtins only in `packages/metrics` (`node:fs`, `node:perf_hooks`, `node:os`, `node:crypto`), vitest, the existing run dashboard.

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md`, section **Metrics** (added 2026-10-25 from the owner's plan approval), and `00-overview.md`, **Shared contracts → Metrics**.

**Runs first.** This plan executes before plan 02, so every later plan finds `@mnmal-ai/swarm-metrics` in place.

## Global Constraints

- **Local only.** Metrics are written to files on the machine that records them and read from there. No code in this plan sends a metric over the network; the telemetry upload in `packages/telemetry` never includes them.
- **No currency.** No metric, summary or panel shows money. Model usage is in tokens (the repository's "token budgets, never dollars" rule). The Agent SDK's `total_cost_usd` is never read.
- **Never on the failure path.** A metric call never throws in production (`strict: false`), never awaits I/O on the caller's path, and a sink write error is counted, logged once and dropped.
- **Bounded labels.** Label values come from bounded sets: phase names, roles, tool names, operation names, route patterns, outcome words. Never a path, title, prompt, argument, error message or id, except `run_id` as a base label on a run's registry and ids on span records.
- **Names** follow `swarm_<area>_<thing>_<unit>`: counters end `_total`, duration histograms end `_seconds`, sizes `_bytes`, token histograms and counters `_tokens` / `_tokens_total`.
- **Run-side choke points read `processMetrics()`** at call time (the run's registry, set by `createRunMetrics`), so no constructor in the existing packages has to be threaded; a class that already takes options may also accept `metrics?: Metrics`, which wins.
- **Long-lived callers name their parent.** The span context is inherited by anything started inside a span, so spans recorded by timers, pollers, servers and event handlers pass their parent explicitly: the run's `root` on the run side, `null` in the brain. Only work done inside the call that opened a span inherits it.
- **Every metric is declared** in `packages/metrics/src/catalogue/` before it is recorded; tests run registries with `strict: true`, which throws on an undeclared name or label.
- **`swarm run` behaves as before** apart from the added end-of-run block, the metrics file and the dashboard panel. The CLI suite (`cd packages/cli && npx vitest run`) stays green after every task.
- **Package conventions:** `packages/metrics` is `"type": "module"`, `"version": "1.0.0-alpha.0"`, `"license": "Apache-2.0"`, has no `dependencies`, extends `../../tsconfig.base.json`, tests with `vitest run`, builds with `tsc`.
- **Anonymity:** no personal names, client names, hostnames or home paths in code, tests or docs.

## Review Focus

1. **A run that crashes or is killed mid-way.** Expected: the metrics file holds every span that ended before the crash (flushed at most one second late) and `swarm metrics --run <id>` reads it without error, reporting open spans as `unfinished`. Pinned in Task 2 (truncated last line) and Task 3 (spans with no end).
2. **A very long run (days) or a hot loop.** Expected: memory stays bounded (reservoirs of 1,024 values, at most 2,000 series per metric) and the file stops growing past its daily cap by sampling observations, never by dropping spans or snapshots. Pinned in Task 1 (series cap) and Task 2 (cap and sampling).
3. **Two processes write the same directory** (a `swarm run` and a `swarm metrics` reading it; two runs in one project). Expected: one file per run id, appends are whole lines, a reader skips a partial last line. Pinned in Task 2 and Task 3.
4. **A label value that is unbounded slips in** (a file path as a label). Expected: in tests, strict mode throws on undeclared labels; in production the series cap folds the excess into `overflow: "true"` and counts it. Pinned in Task 1.
5. **Clock skew and sub-millisecond spans.** Expected: durations come from a monotonic source (`performance.now()`), never `Date.now()` differences, and are never negative. Pinned in Task 1.

---

### Task 1: The registry, spans and the Prometheus text

**Files:**
- Create: `packages/metrics/package.json`, `packages/metrics/tsconfig.json`, `packages/metrics/vitest.config.ts`
- Create: `packages/metrics/src/index.ts`, `packages/metrics/src/types.ts`, `packages/metrics/src/clock.ts`, `packages/metrics/src/histogram.ts`, `packages/metrics/src/registry.ts`, `packages/metrics/src/noop.ts`, `packages/metrics/src/prometheus.ts`
- Create: `packages/metrics/src/testing.ts` (`FakeMetricsClock`)
- Test: `packages/metrics/tests/registry.test.ts`, `packages/metrics/tests/prometheus.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exported from `@mnmal-ai/swarm-metrics`):

```ts
export type Labels = Readonly<Record<string, string>>;
export type MetricKind = "counter" | "gauge" | "histogram";
export type MetricUnit = "seconds" | "bytes" | "count" | "tokens" | "ratio";
export interface MetricDef { name: string; kind: MetricKind; unit: MetricUnit; help: string; labels: readonly string[]; buckets?: readonly number[] }
export type SpanOutcome = "ok" | "error" | "cancelled" | "timeout" | (string & {});
export interface Span { readonly id: string; readonly name: string; end(outcome?: SpanOutcome, labels?: Labels): number }
export interface Metrics {
  define(defs: readonly MetricDef[]): void;
  inc(name: string, labels?: Labels, by?: number): void;
  set(name: string, value: number, labels?: Labels): void;
  observe(name: string, value: number, labels?: Labels): void;
  span(name: string, labels?: Labels, parent?: Span | string): Span;
  time<T>(name: string, labels: Labels, fn: (span: Span) => Promise<T> | T, parent?: Span | string): Promise<T>;
  with(labels: Labels): Metrics;
}
export interface MetricsClock { epochMs(): number; monoMs(): number }
export const systemClock: MetricsClock;            // epochMs: Date.now() (wall time, right after a laptop sleeps); monoMs: performance.now() (durations only)
export interface CounterSnapshot { name: string; labels: Labels; value: number }
export interface GaugeSnapshot { name: string; labels: Labels; value: number; at: number }
export interface HistogramSnapshot { name: string; labels: Labels; unit: MetricUnit; count: number; sum: number; min: number; max: number; p50: number; p90: number; p99: number; buckets: Array<[le: number, cumulative: number]> }
export interface MetricsSnapshot { at: number; defs: MetricDef[]; counters: CounterSnapshot[]; gauges: GaugeSnapshot[]; histograms: HistogramSnapshot[] }
export interface SpanRecord { r: "span"; name: string; id: string; parent?: string; start: number; dur: number; outcome: string; labels: Labels }
export interface ObsRecord { r: "obs"; name: string; v: number; t: number; labels: Labels; sampled?: number }
export interface SnapRecord { r: "snap"; t: number; boot: string; counters: CounterSnapshot[]; gauges: GaugeSnapshot[] }
export type MetricRecord = SpanRecord | ObsRecord | SnapRecord;
export interface MetricsSink { write(record: MetricRecord): void; flush(): Promise<void>; close(): Promise<void> }
export class MetricsRegistry implements Metrics {
  constructor(opts?: { clock?: MetricsClock; sink?: MetricsSink; strict?: boolean; maxSeriesPerMetric?: number; reservoirSize?: number; idGen?: () => string; onWarn?: (message: string) => void });
  readonly boot: string;                            // random 12-hex id of this registry's lifetime, stamped on snapshots
  snapshot(): MetricsSnapshot;
  writeSnapshot(): void;                            // writes one SnapRecord to the sink
  startSnapshots(intervalMs?: number): () => void;  // default 60_000; the timer is unref'd; returns stop
  toPrometheus(): string;
}
export const noopMetrics: Metrics;
export class UnknownMetricError extends Error {}
export class MetricLabelError extends Error {}
export const SECONDS_BUCKETS: readonly number[];    // [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200]
export const TOKEN_BUCKETS: readonly number[];      // [1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000, 10000000, 50000000]
export const BYTES_BUCKETS: readonly number[];      // [1024, 16384, 131072, 1048576, 16777216, 134217728, 1073741824]
// packages/metrics/src/testing.ts, exported as "@mnmal-ai/swarm-metrics/testing"
export class FakeMetricsClock implements MetricsClock { constructor(startEpochMs?: number); epochMs(): number; monoMs(): number; advance(ms: number): void }
export function testRegistry(defs: readonly MetricDef[], opts?: { clock?: FakeMetricsClock; sink?: MetricsSink }): { metrics: MetricsRegistry; clock: FakeMetricsClock };   // strict: true, idGen counting "s1", "s2", …
```

- [ ] **Step 1: Scaffold the package**

`package.json`: name `@mnmal-ai/swarm-metrics`, `"version": "1.0.0-alpha.0"`, `"type": "module"`, `"license": "Apache-2.0"`, `main` `dist/src/index.js`, `types` `dist/src/index.d.ts`, `exports` `"."` → `./dist/src/index.js` (types `./dist/src/index.d.ts`) and `"./testing"` → `./dist/src/testing.js` (types `./dist/src/testing.d.ts`), scripts `build: tsc`, `test: vitest run`, `test:ci` as in `packages/types/package.json`, devDependencies `@types/node` and `vitest` at the versions `packages/types` and `packages/substrate-shared` use, and no `dependencies`. `tsconfig.json` and `vitest.config.ts` mirror `packages/types`. Run `pnpm install` at the root so the workspace links it.

- [ ] **Step 2: Write the failing tests**

`packages/metrics/tests/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MetricsRegistry, noopMetrics, UnknownMetricError, MetricLabelError, SECONDS_BUCKETS, type MetricDef } from "../src/index.js";
import { testRegistry } from "../src/testing.js";

const DEFS: MetricDef[] = [
  { name: "swarm_test_calls_total", kind: "counter", unit: "count", help: "calls", labels: ["op"] },
  { name: "swarm_test_depth", kind: "gauge", unit: "count", help: "depth", labels: [] },
  { name: "swarm_test_call_seconds", kind: "histogram", unit: "seconds", help: "call time", labels: ["op", "outcome"] },
  { name: "swarm_test_size_bytes", kind: "histogram", unit: "bytes", help: "size", labels: [] },
];

describe("MetricsRegistry", () => {
  it("counts, sets and observes per label set", () => {
    const { metrics } = testRegistry(DEFS);
    metrics.inc("swarm_test_calls_total", { op: "get" });
    metrics.inc("swarm_test_calls_total", { op: "get" }, 2);
    metrics.inc("swarm_test_calls_total", { op: "put" });
    metrics.set("swarm_test_depth", 4);
    metrics.set("swarm_test_depth", 7);
    const snap = metrics.snapshot();
    expect(snap.counters).toEqual(expect.arrayContaining([
      { name: "swarm_test_calls_total", labels: { op: "get" }, value: 3 },
      { name: "swarm_test_calls_total", labels: { op: "put" }, value: 1 },
    ]));
    expect(snap.gauges.find((g) => g.name === "swarm_test_depth")?.value).toBe(7);
  });

  it("times spans from the monotonic clock and links parents", () => {
    const { metrics, clock } = testRegistry(DEFS);
    const outer = metrics.span("swarm_test_call_seconds", { op: "get" });
    clock.advance(250);
    const inner = metrics.span("swarm_test_call_seconds", { op: "put" }, outer);
    clock.advance(500);
    expect(inner.end()).toBeCloseTo(0.5);
    expect(outer.end("error")).toBeCloseTo(0.75);
    const h = metrics.snapshot().histograms;
    expect(h.find((x) => x.labels.op === "get")).toMatchObject({ count: 1, sum: 0.75, labels: { op: "get", outcome: "error" } });
    expect(h.find((x) => x.labels.op === "put")).toMatchObject({ count: 1, sum: 0.5, labels: { op: "put", outcome: "ok" } });
  });

  it("time() records ok, records error and rethrows", async () => {
    const { metrics, clock } = testRegistry(DEFS);
    await expect(metrics.time("swarm_test_call_seconds", { op: "get" }, async () => { clock.advance(10); return 1; })).resolves.toBe(1);
    await expect(metrics.time("swarm_test_call_seconds", { op: "get" }, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const outcomes = metrics.snapshot().histograms.map((x) => x.labels.outcome).sort();
    expect(outcomes).toEqual(["error", "ok"]);
  });

  it("ending a span twice records it once", () => {
    const { metrics } = testRegistry(DEFS);
    const s = metrics.span("swarm_test_call_seconds", { op: "get" });
    s.end(); s.end();
    expect(metrics.snapshot().histograms[0].count).toBe(1);
  });

  it("computes p50, p90 and p99 over the reservoir and min and max over all values", () => {
    const { metrics } = testRegistry(DEFS);
    for (let i = 1; i <= 100; i++) metrics.observe("swarm_test_size_bytes", i);
    const h = metrics.snapshot().histograms[0];
    expect([h.count, h.sum, h.min, h.max, h.p50, h.p90, h.p99]).toEqual([100, 5050, 1, 100, 50, 90, 99]);
  });

  it("keeps the reservoir bounded", () => {
    const metrics = new MetricsRegistry({ strict: true, reservoirSize: 10 });
    metrics.define(DEFS);
    for (let i = 1; i <= 1000; i++) metrics.observe("swarm_test_size_bytes", i);
    const h = metrics.snapshot().histograms[0];
    expect(h.count).toBe(1000);
    expect(h.p50).toBeGreaterThan(990);   // the reservoir holds the last 10 values
  });

  it("buckets are cumulative and use the unit's default buckets", () => {
    const { metrics } = testRegistry(DEFS);
    metrics.observe("swarm_test_call_seconds", 0.003, { op: "get", outcome: "ok" });
    metrics.observe("swarm_test_call_seconds", 2, { op: "get", outcome: "ok" });
    const b = metrics.snapshot().histograms[0].buckets;
    expect(b.map(([le]) => le)).toEqual([...SECONDS_BUCKETS, Infinity]);
    expect(b.find(([le]) => le === 0.005)?.[1]).toBe(1);
    expect(b.find(([le]) => le === 2.5)?.[1]).toBe(2);
    expect(b.at(-1)?.[1]).toBe(2);
  });

  it("strict mode throws on an undeclared name or label", () => {
    const { metrics } = testRegistry(DEFS);
    expect(() => metrics.inc("swarm_test_nope_total")).toThrow(UnknownMetricError);
    expect(() => metrics.inc("swarm_test_calls_total", { path: "/x" })).toThrow(MetricLabelError);
  });

  it("non-strict mode never throws and warns once per name", () => {
    const warnings: string[] = [];
    const metrics = new MetricsRegistry({ onWarn: (m) => warnings.push(m) });
    expect(() => { metrics.inc("swarm_x_total"); metrics.inc("swarm_x_total"); metrics.observe("swarm_x_total", 1); }).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it("folds series past the cap into overflow and counts the drop", () => {
    const metrics = new MetricsRegistry({ strict: true, maxSeriesPerMetric: 3 });
    metrics.define(DEFS);
    for (const op of ["a", "b", "c", "d", "e"]) metrics.inc("swarm_test_calls_total", { op });
    const series = metrics.snapshot().counters.filter((c) => c.name === "swarm_test_calls_total");
    expect(series).toHaveLength(4);
    expect(series.find((c) => c.labels.overflow === "true")?.value).toBe(2);
    expect(metrics.snapshot().counters.find((c) => c.name === "swarm_metrics_series_dropped_total")?.value).toBe(2);
  });

  it("with() merges base labels into every record", () => {
    const metrics = new MetricsRegistry({ strict: true });
    metrics.define([{ name: "swarm_test_calls_total", kind: "counter", unit: "count", help: "calls", labels: ["op", "run_id"] }]);
    metrics.with({ run_id: "run-1" }).inc("swarm_test_calls_total", { op: "get" });
    expect(metrics.snapshot().counters[0].labels).toEqual({ op: "get", run_id: "run-1" });
  });

  it("a second, different definition for a name throws; the same one is a no-op", () => {
    const { metrics } = testRegistry(DEFS);
    expect(() => metrics.define(DEFS)).not.toThrow();
    expect(() => metrics.define([{ ...DEFS[0], kind: "gauge" }])).toThrow();
  });

  it("noopMetrics does nothing and still runs time()", async () => {
    noopMetrics.inc("anything");
    expect(noopMetrics.span("anything").end()).toBe(0);
    await expect(noopMetrics.time("anything", {}, () => 5)).resolves.toBe(5);
  });
});
```

`packages/metrics/tests/prometheus.test.ts` asserts that a registry holding one counter `{op:"get"}` = 3, one gauge = 7 and one seconds histogram with observations 0.003 and 2 renders exactly these lines (among others): `# HELP swarm_test_calls_total calls`, `# TYPE swarm_test_calls_total counter`, `swarm_test_calls_total{op="get"} 3`, `# TYPE swarm_test_depth gauge`, `swarm_test_depth 7`, `# TYPE swarm_test_call_seconds histogram`, `swarm_test_call_seconds_bucket{op="get",outcome="ok",le="0.005"} 1`, `swarm_test_call_seconds_bucket{op="get",outcome="ok",le="+Inf"} 2`, `swarm_test_call_seconds_sum{op="get",outcome="ok"} 2.003`, `swarm_test_call_seconds_count{op="get",outcome="ok"} 2`; and that a label value containing `"`, `\` and a newline is escaped as `\"`, `\\` and `\n`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd packages/metrics && npx vitest run`
Expected: FAIL, the modules do not exist.

- [ ] **Step 4: Implement**

- `MetricsRegistry` stores series in `Map<name, Map<labelKey, Series>>` where `labelKey` is the labels sorted by key and JSON-encoded. Span and `time()` histograms get the `outcome` label added at `end` (a def used with `span` must declare `outcome`); a span's duration is `(clock.monoMs() at end − at start) / 1000`, clamped at 0. Every ended span writes a `SpanRecord` (`start` is `clock.epochMs()` at start) and every `observe` a `ObsRecord` to the sink when one is set.
- Quantiles use nearest rank over the sorted reservoir: the value at index `ceil(q × n) − 1`. The reservoir is a ring of the last `reservoirSize` values (default 1,024). `min`, `max`, `sum`, `count` and the buckets cover every value.
- `buckets` defaults by unit: `seconds` → `SECONDS_BUCKETS`, `tokens` → `TOKEN_BUCKETS`, `bytes` → `BYTES_BUCKETS`, anything else → `[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]`; a snapshot always ends with `[Infinity, count]`.
- The registry pre-defines `swarm_metrics_series_dropped_total` (counter, labels `metric`), `swarm_metrics_sink_errors_total` (counter, no labels) and `swarm_metrics_unknown_total` (counter, labels `metric`) in its constructor.
- `idGen` defaults to 12 random hex characters from `node:crypto`.
- The labels `run_id`, `process` and `overflow` are accepted on every metric without being declared (they are base labels). Any other label must be in the def's `labels`, or strict mode throws `MetricLabelError`.
- Past `maxSeriesPerMetric` (default 2,000) series for one name, a new label set is recorded into the single series `{ overflow: "true" }` (every other label dropped) and counts `swarm_metrics_series_dropped_total{metric}`.
- `toPrometheus()` renders `HELP`, `TYPE` and samples in definition order, label keys in sorted order with `le` last on bucket lines, `+Inf` for the last bucket, and numbers with `String(n)`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd packages/metrics && npx vitest run && cd ../.. && pnpm -w build`
Expected: all tests pass; the build is green.

- [ ] **Step 6: Commit**

```bash
git add packages/metrics pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "feat(metrics): a zero-dependency metrics registry with spans and Prometheus text"
```

---

### Task 2: The JSON-lines sink

**Files:**
- Create: `packages/metrics/src/sink.ts`
- Modify: `packages/metrics/src/index.ts` (export)
- Test: `packages/metrics/tests/sink.test.ts`

**Interfaces:**
- Consumes: `MetricRecord`, `MetricsSink`, `MetricsRegistry` (Task 1).
- Produces:

```ts
export interface JsonlSinkOptions {
  file: (now: Date) => string;          // file name inside dir, e.g. () => `${runId}.jsonl` or (d) => `${isoDate(d)}.jsonl`
  retainDays?: number;                  // default 14; files in dir ending .jsonl with mtime older than this are deleted at open and once a day
  maxBytesPerDay?: number;              // default 268_435_456 (256 MiB) per file per UTC day
  flushMs?: number;                     // default 1000
  now?: () => Date;
  onError?: (err: Error) => void;       // called once per distinct error message
  onWriteFailed?: (records: number) => void;   // called on every failed append with the number of records lost
}
export class JsonlMetricsSink implements MetricsSink {
  constructor(dir: string, opts: JsonlSinkOptions);
  write(record: MetricRecord): void;    // buffers; never throws
  flush(): Promise<void>;               // appends the buffer as whole lines, in order
  flushSync(): void;                    // for process "exit" handlers
  close(): Promise<void>;               // flush and stop the timer
  readonly bytesWritten: number;
  readonly sampledCount: number;
  readonly failedRecords: number;       // records lost to failed appends
}
export class DeferredMetricsSink implements MetricsSink {   // buffers until a real sink is attached; used by `swarm run` before the run id and swarm directory are known
  constructor(maxBuffered?: number);                      // default 10_000; past it the oldest `obs` records are dropped first, then the oldest of any kind
  attach(sink: MetricsSink): void;                        // replays the buffer in order into `sink`, then forwards every later write
  readonly dropped: number;
}
```

- [ ] **Step 1: Write the failing tests** in `packages/metrics/tests/sink.test.ts`, each on a fresh `fs.mkdtempSync` directory:
  - `writes whole JSON lines in order and flushes on the timer`: write three records, advance a fake timer (`vi.useFakeTimers()`) by `flushMs`, read the file: three lines, each `JSON.parse`s to the record written, in order.
  - `flushSync writes everything still buffered`.
  - `past maxBytesPerDay keeps spans and snapshots and samples observations one in ten`: `maxBytesPerDay: 2000`; write 50 `obs` records, then 5 `span` records and 1 `snap`; after flush: all 5 spans and the snap are present, `obs` lines after the cap carry `"sampled":10`, and the number of `obs` lines after the cap is `ceil(k / 10)` for the `k` written after it; `sampledCount` equals `k`.
  - `the cap resets on a new UTC day` (inject `now`).
  - `deletes .jsonl files older than retainDays at open and leaves others`: create `old.jsonl` with `utimesSync` 15 days back, `new.jsonl` now, and `notes.txt` 30 days back; open a sink with `retainDays: 14`; only `old.jsonl` is gone.
  - `a write error never throws and is reported once`: point `dir` at a path under a regular file; `write` and `flush` do not throw; `onError` called once for two failed flushes with the same message.
  - `creates the directory if missing`.
  - `DeferredMetricsSink buffers, then replays in order on attach`: three writes before `attach`, one after; the attached sink sees all four in order. With `maxBuffered: 3` and writes `obs, span, obs, snap`, attach replays `span, obs, snap` and `dropped === 1`; with `maxBuffered: 2` it replays `span, snap` and `dropped === 2`.
  - `registry and sink together`: a `MetricsRegistry` with this sink, `span(...).end()`, `observe(...)`, `writeSnapshot()`, flush: the file holds one `span`, one `obs` and one `snap` line whose `boot` equals `registry.boot`.

- [ ] **Step 2: Run them to see them fail.** Run: `cd packages/metrics && npx vitest run tests/sink.test.ts`. Expected: FAIL, `JsonlMetricsSink` is not exported.

- [ ] **Step 3: Implement `JsonlMetricsSink`**. Every append is synchronous (`appendFileSync`), both on the timer and in `flushSync`, so nothing is ever in flight when the process exits; `flush()` keeps its `Promise` signature. Bytes already in today's file when the sink opens count toward today's cap. Neither the constructor nor any method throws: a failed `mkdir`, retention sweep or append is reported through `onError` (once per distinct message) and counted on the registry's `swarm_metrics_sink_errors_total` when the registry owns the sink. Use `mkdirSync(dir, { recursive: true })` at construction, a `setInterval(flushMs).unref()` timer, and per-file-per-UTC-day byte accounting. Sampling keeps the first observation of every ten past the cap (a counter per file and day). A failed append adds the number of records it held to `failedRecords` and calls `onWriteFailed(records)` every time (not de-duplicated); `onError` stays once per distinct message, for logging.

- [ ] **Step 4: Run them to see them pass.** Run: `cd packages/metrics && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/metrics
git -c commit.gpgsign=false commit -m "feat(metrics): a JSON-lines sink with a daily cap, sampling, retention and a deferred buffer"
```

---

### Task 3: Reading, aggregating and explaining

**Files:**
- Create: `packages/metrics/src/read.ts`, `packages/metrics/src/analysis.ts`, `packages/metrics/src/format.ts`
- Modify: `packages/metrics/src/index.ts`, `packages/metrics/src/types.ts` (the `InstanceRecord` member of `MetricRecord`)
- Test: `packages/metrics/tests/read.test.ts`, `packages/metrics/tests/analysis.test.ts`, `packages/metrics/tests/format.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:

```ts
export interface InstanceRecord { r: "instance"; instanceId: string; at: number; snapshot: MetricsSnapshot }   // the brain's copy of an instance's forwarded snapshot (plan 04 writes it); MetricRecord becomes SpanRecord | ObsRecord | SnapRecord | InstanceRecord
export function latestInstanceSnapshots(records: Iterable<MetricRecord> | AsyncIterable<MetricRecord>): Promise<Record<string, { at: number; snapshot: MetricsSnapshot }>>;   // the newest per instanceId
export function readMetricsFile(path: string): AsyncIterable<MetricRecord> & { readonly skipped: number };   // skips blank, partial and unparseable lines; `skipped` counts them once iteration ends
export function readMetricsDir(dir: string, opts?: { since?: number; until?: number; files?: (name: string) => boolean }): AsyncIterable<MetricRecord>;   // files in name order; records outside [since, until) by `t` or `start` are skipped
export function aggregate(records: Iterable<MetricRecord> | AsyncIterable<MetricRecord>, opts?: { since?: number; defs?: readonly MetricDef[] }): Promise<MetricsSnapshot>;
export interface SinkRow { name: string; labels: Labels; count: number; totalSeconds: number; meanSeconds: number; p50: number; p99: number; share: number | null }
export const CONTAINER_METRICS: readonly string[];   // ["swarm_run_seconds", "swarm_run_phase_seconds", "swarm_run_goal_seconds", "swarm_run_task_seconds", "swarm_agent_session_seconds"]: spans that contain other measured work
export function topSinks(snapshot: MetricsSnapshot, n: number, opts?: { wallSeconds?: number; names?: (name: string) => boolean }): SinkRow[];   // without `names`, excludes CONTAINER_METRICS so the list shows where time is actually spent
export interface SpanNode { id: string; name: string; labels: Labels; start: number; dur: number | null; outcome: string; children: SpanNode[] }
export function waterfall(records: Iterable<SpanRecord>, rootId?: string): SpanNode[];       // roots: spans with no parent; a parent id that children name but that never ended becomes a synthesized node { name: "unfinished", labels: {}, start: earliest child start, dur: null, outcome: "unfinished" } holding those children; children sorted by start
export function formatSummary(snapshot: MetricsSnapshot, opts: { wallSeconds: number; top?: number }): string;
export function formatTopSinks(rows: SinkRow[]): string;
export function formatWaterfall(nodes: SpanNode[], opts?: { width?: number; maxDepth?: number }): string;
export function formatDuration(seconds: number): string;   // "0.4 ms", "12 ms", "3.2 s", "4m 05s", "1h 12m"
```

- [ ] **Step 1: Write the failing tests.**
  - `read.test.ts`: a file with a valid line, a blank line, `{"r":"span"` (truncated) and another valid line yields two records and `skipped === 2`; `readMetricsDir` with `files: (n) => n.startsWith("run-1")` reads only that run's file; `since`/`until` filter on `start` for spans and `t` for others.
  - `analysis.test.ts`:
    - `aggregate` ignores `instance` records; `latestInstanceSnapshots` keeps the newest `at` per `instanceId`.
    - `aggregate` turns spans and observations into histograms equal to what a live registry would report for the same values (build both from one list of values and compare `count`, `sum`, `p50`, `p99`).
    - Counters from snapshots: for one `boot`, the last snapshot's value; for two boots (a restart), the sum of each boot's last value; with `since`, each boot's last value in the window minus its last value before `since` (0 if none).
    - Gauges: the latest by `t` across boots.
    - Sampled observations count `sampled` times in `count` and `sum`.
    - `topSinks` ranks seconds histograms by `totalSeconds` (ties by name), ignores non-seconds histograms, leaves out `CONTAINER_METRICS` unless `names` is given, and with `wallSeconds: 100` reports `share: 0.4` for a 40-second sink.
    - `waterfall` nests a child under its parent, sorts children by `start`, and, when the `run` span never ended (a crashed run), returns one synthesized `unfinished` root holding `plan` and `task`; a test helper builds spans `run → plan, task(→ worker, review)`.
  - `format.test.ts`: `formatDuration` for `0.0004`, `0.012`, `3.2`, `245`, `4320` gives `"0.4 ms"`, `"12 ms"`, `"3.2 s"`, `"4m 05s"`, `"1h 12m"`; `formatSummary` for a fixture snapshot (phases `setup` 30 s, `agents` 300 s, `merge_gate` 120 s, wall 500 s) contains the lines `Time      8m 20s`, a phase line `agents          5m 00s   60%`, a line `Top time sinks` and no `$`; `formatWaterfall` indents children by two spaces per depth and prints each node's duration, and `unfinished` for `dur: null`.

- [ ] **Step 2: Run them to see them fail.** Run: `cd packages/metrics && npx vitest run tests/read.test.ts tests/analysis.test.ts tests/format.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `readMetricsFile` uses `readline` over `createReadStream`. `aggregate` reuses `histogram.ts` from Task 1 so live and aggregated quantiles agree. `formatSummary` layout:

```
Time      <wall>
Phases    <phase>  <duration>  <share>%          (one line each, from swarm_run_phase_seconds, longest first)
Agents    model <x>  tools <y>  other <z>         (from swarm_agent_api_seconds, swarm_agent_tool_seconds, swarm_agent_session_seconds)
Tokens    <role> <n> in / <m> out                 (one line per role, from swarm_agent_tokens_total)
Top time sinks
  <name>{<labels>}  <count>×  total <t>  p50 <a>  p99 <b>
```

Lines whose source metric is absent are left out. Padding: a phase name `padEnd(16)`, its duration `padStart(6)`, three spaces, then the share as a whole percent.

- [ ] **Step 4: Run them to see them pass.** Run: `cd packages/metrics && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/metrics
git -c commit.gpgsign=false commit -m "feat(metrics): read, aggregate, rank time sinks and draw waterfalls"
```

---

### Task 4: The process sampler

**Files:**
- Create: `packages/metrics/src/process.ts`, `packages/metrics/src/catalogue/process.ts`
- Modify: `packages/metrics/src/index.ts`
- Test: `packages/metrics/tests/process.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
export const PROCESS_METRICS: readonly MetricDef[];
export function startProcessSampler(metrics: Metrics, opts?: { intervalMs?: number; diskPaths?: string[]; probes?: Partial<ProcessProbes> }): () => void;   // samples once immediately, then every intervalMs (default 5000, unref'd); returns stop, which also disables the GC observer and the delay monitor
export interface ProcessProbes { memoryUsage(): NodeJS.MemoryUsage; cpuUsage(): NodeJS.CpuUsage; loadavg(): number[]; freemem(): number; statfs(path: string): { bavail: number; bsize: number } | null; eventLoopDelay(): { p50: number; p99: number; max: number } /* ns */ }
```

`PROCESS_METRICS` (labels in brackets):

| Name | Kind | Unit | Labels |
|---|---|---|---|
| `swarm_process_event_loop_delay_seconds` | gauge | seconds | `stat` (`p50`, `p99`, `max`) |
| `swarm_process_heap_used_bytes` | gauge | bytes | |
| `swarm_process_heap_total_bytes` | gauge | bytes | |
| `swarm_process_rss_bytes` | gauge | bytes | |
| `swarm_process_external_bytes` | gauge | bytes | |
| `swarm_process_cpu_seconds_total` | counter | seconds | `mode` (`user`, `system`) |
| `swarm_process_gc_pause_seconds` | histogram | seconds | `kind` (`minor`, `major`, `incremental`, `weakcb`) |
| `swarm_process_load_average` | gauge | ratio | |
| `swarm_process_system_free_bytes` | gauge | bytes | |
| `swarm_process_disk_free_bytes` | gauge | bytes | `disk` (the index of the path in `diskPaths`, as a string: `"0"`, `"1"`) |
| `swarm_process_probe_errors_total` | counter | count | `probe` (`event_loop`, `memory`, `cpu`, `gc`, `load`, `freemem`, `disk`) |

Every row also accepts the base label `process` (`run`, `brain`, `room-mcp`), which callers set with `metrics.with({ process: "…" })`, and `run_id`.

- [ ] **Step 1: Write the failing test** with scripted `probes`: after `startProcessSampler(metrics, { probes, diskPaths: ["/tmp"] })` the snapshot holds every gauge above with the scripted values (event-loop nanoseconds converted to seconds; disk free = `bavail × bsize`); a second sample after `vi.advanceTimersByTime(5000)` increases `swarm_process_cpu_seconds_total{mode:"user"}` by the scripted delta in seconds (CPU usage is microseconds); `stop()` stops further samples; with real probes (no `probes` option) one sample runs without throwing and records a positive `swarm_process_rss_bytes`.
- [ ] **Step 2: Run it to see it fail.** Run: `cd packages/metrics && npx vitest run tests/process.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` (reset after each sample; under Node the readings include the timer's resolution, so subtract it and floor at 0, while Bun already reports the true delay — detect with `process.versions.bun`, so both runtimes report the same quantity), `PerformanceObserver` on `entryTypes: ["gc"]` mapping `detail.kind` to the four words, `process.memoryUsage()`, `process.cpuUsage()` deltas, `os.loadavg()[0]`, `os.freemem()`, `fs.statfsSync`, each probe call wrapped so one failing probe skips only its rows and counts `swarm_process_probe_errors_total{probe}`.
- [ ] **Step 4: Run it to see it pass.** Run: `cd packages/metrics && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/metrics
git -c commit.gpgsign=false commit -m "feat(metrics): sample event-loop delay, memory, CPU, GC, load and disk"
```

---

### Task 5: The catalogue, span context and the process registry

**Files:**
- Create: `packages/metrics/src/catalogue/index.ts`, `packages/metrics/src/catalogue/run.ts`, `packages/metrics/src/catalogue/self.ts`, `packages/metrics/src/catalogue/os.ts`, `packages/metrics/src/context.ts`
- Modify: `packages/metrics/src/registry.ts` (default parent from context; `time()` runs inside the span; pre-defines come from `SELF_METRICS`), `packages/metrics/src/index.ts`
- Test: `packages/metrics/tests/catalogue.test.ts`, `packages/metrics/tests/context.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4 (`PROCESS_METRICS` from Task 4).
- Produces:

```ts
export const RUN_PHASES: readonly ["preamble", "stack_boot", "seed", "mcp_reconcile", "config", "base_sync", "setup", "github_preflight", "goal_discovery", "goal_labels", "wiring", "backend_resolve", "credential_preflight", "project_claim", "resume", "preflight_screen", "approval", "dashboard_start", "git_ready", "worktree_prune", "pre_loop", "execution", "planning", "task_registration", "goal_dispatch_prep", "remediation", "ship_readiness", "merge", "goal_bookkeeping", "stack_push", "final_checkpoint", "sharing_upload", "stop"];
export type RunPhase = (typeof RUN_PHASES)[number];
export const RUN_METRICS: readonly MetricDef[];     // areas run, agent, substrate, git, gh, tasks, merge (table below)
export const SELF_METRICS: readonly MetricDef[];    // swarm_metrics_*
export const OS_METRICS: MetricDef[];               // empty now; plans 02 to 09 append in their marked slots
export const CATALOGUE: readonly MetricDef[];       // [...PROCESS_METRICS, ...SELF_METRICS, ...RUN_METRICS, ...OS_METRICS]
export function defineAll(metrics: Metrics): void;
export function setProcessMetrics(metrics: Metrics | null): void;
export function processMetrics(): Metrics;          // the registry set for this process, else noopMetrics; read at call time, never cached by callers
export function currentSpan(): Span | undefined;    // AsyncLocalStorage from node:async_hooks
export function withSpan<T>(span: Span, fn: () => T): T;
// registry change: span(name, labels?, parent?: Span | string | null): parent undefined → currentSpan(); null → a root span
```

`os.ts` holds `export const OS_METRICS: MetricDef[] = [` followed by one comment line per plan, `  // plan 01`, `  // plan 02`, … `  // plan 09`, and `];`. Plan 01's rows are recorded by `swarm run --os` and `swarm room-mcp`, the rest by the brain.

`SELF_METRICS`: `swarm_metrics_series_dropped_total` (counter, `metric`), `swarm_metrics_sink_errors_total` (counter), `swarm_metrics_unknown_total` (counter, `metric`), `swarm_metrics_sampled_total` (counter), `swarm_metrics_deferred_dropped_total` (counter).

`RUN_METRICS` (every histogram over `seconds` uses `SECONDS_BUCKETS`; `outcome` is `ok`, `error`, `cancelled` or `timeout` unless stated):

| Name | Kind | Unit | Labels | Recorded in |
|---|---|---|---|---|
| `swarm_run_seconds` | histogram | seconds | `outcome` | the run's root span (Task 6) |
| `swarm_run_phase_seconds` | histogram | seconds | `phase`, `outcome` | each `RUN_PHASES` span (Tasks 6, 10) |
| `swarm_run_goal_seconds` | histogram | seconds | `outcome` (`completed`, `failed`, `blocked`, `cancelled`) | each goal (Task 10) |
| `swarm_run_task_seconds` | histogram | seconds | `outcome` | each task, worker plus oversight (Task 10) |
| `swarm_run_tasks_total` | counter | count | `outcome` | Task 10 |
| `swarm_run_worktree_seconds` | histogram | seconds | `op` (`create`, `commit`, `merge`, `destroy`, `prune`, `poll`), `outcome` | `WorktreeManager` (Task 10) |
| `swarm_run_checkpoint_seconds` | histogram | seconds | `op` (`save`, `load`), `outcome` | `Orchestrator.saveCheckpoint` / `loadCheckpoint` (Task 10) |
| `swarm_run_context_sync_seconds` | histogram | seconds | `outcome` | section sync (Task 10) |
| `swarm_run_command_seconds` | histogram | seconds | `kind` (`setup`, `ship_deploy`, `bash_tool`, `validator`, `discovery`, `mcp`, `fnl`, `dependency_check`, `other`), `outcome` | Task 8 |
| `swarm_run_telemetry_write_seconds` | histogram | seconds | `sink` (`substrate`, `jsonl`), `outcome` | `Telemetry` (Task 10) |
| `swarm_run_events_total` | counter | count | `event` (the bus event name) | `eventBus.onAny` (Task 10) |
| `swarm_run_tokens_used_ratio` | gauge | ratio | `scope` (`session`, `goal`, `task`) | on `tokens:update` (Task 10) |
| `swarm_run_dashboard_clients` | gauge | count | | `DashboardServer` (Task 10) |
| `swarm_run_dashboard_request_seconds` | histogram | seconds | `route`, `status` (`2xx`, `3xx`, `4xx`, `5xx`) | `DashboardServer.handleRequest` (Task 10) |
| `swarm_run_upload_seconds` | histogram | seconds | `outcome` | sharing upload (Task 10) |
| `swarm_run_ship_readiness_seconds` | histogram | seconds | `step` (`deploy`, `smoke`), `outcome` | `runShipReadinessGate` (Task 10) |
| `swarm_agent_session_seconds` | histogram | seconds | `role`, `backend`, `outcome` | Task 9 |
| `swarm_agent_api_seconds` | histogram | seconds | `role`, `backend` | Task 9 (SDK `duration_api_ms`) |
| `swarm_agent_first_message_seconds` | histogram | seconds | `role`, `backend` | Task 9 |
| `swarm_agent_turns` | histogram | count | `role`, `backend` | Task 9 (SDK `num_turns`) |
| `swarm_agent_tool_seconds` | histogram | seconds | `role`, `backend`, `tool`, `outcome` | Task 9 |
| `swarm_agent_tokens_total` | counter | tokens | `role`, `backend`, `kind` (`input`, `output`, `cache_read`, `cache_write`) | Task 9 |
| `swarm_agent_session_tokens` | histogram | tokens | `role`, `backend` | Task 9 |
| `swarm_agent_rate_limits_total` | counter | count | `role`, `backend` | Task 9 |
| `swarm_agent_rate_limit_wait_seconds` | histogram | seconds | `site` (`session`, `oversight`, `decomposition`, `gate`, `api_retry`) | Task 9 (measured, never the planned wait) |
| `swarm_agent_fallbacks_total` | counter | count | `role` | Task 9 |
| `swarm_agent_api_call_seconds` | histogram | seconds | `provider` (`anthropic`, `openai`), `outcome` | `withRetry`, per attempt (Task 9) |
| `swarm_agent_api_retries_total` | counter | count | `provider`, `status` | Task 9 |
| `swarm_agent_small_model_seconds` | histogram | seconds | `purpose` (`label`, `synopsis`, `other`), `outcome` | `smallModel` (Task 9) |
| `swarm_substrate_request_seconds` | histogram | seconds | `op` (`query`, `mutate`, `get`, `health`, `schema`), `target`, `outcome` | Task 7 |
| `swarm_substrate_response_bytes` | histogram | bytes | `op` | Task 7 |
| `swarm_substrate_errors_total` | counter | count | `op`, `code` (`timeout`, `network`, `http_4xx`, `http_5xx`, `frame`) | Task 7 |
| `swarm_substrate_query_pages` | histogram | count | `target` | `SubstrateClient.query` (Task 7) |
| `swarm_substrate_boot_seconds` | histogram | seconds | `step` (`runtime_install`, `postgres`, `sidecar`, `types`, `meta_check`), `outcome` | the lifecycle (Task 7) |
| `swarm_git_command_seconds` | histogram | seconds | `cmd`, `outcome` | Task 8 |
| `swarm_gh_command_seconds` | histogram | seconds | `cmd`, `outcome` | Task 8 |
| `swarm_tasks_cli_seconds` | histogram | seconds | `source` (`github`, `trello`), `op`, `outcome` | `runCli` (Task 8) |
| `swarm_merge_queue_wait_seconds` | histogram | seconds | | `FileMergeQueue.take` (Task 10) |
| `swarm_merge_turn_held_seconds` | histogram | seconds | | the turn's release (Task 10) |
| `swarm_merge_attempt_seconds` | histogram | seconds | `outcome` | `attemptMerge` (Task 10) |
| `swarm_merge_gate_seconds` | histogram | seconds | `outcome` | `runMergeGate` (Task 10) |
| `swarm_merge_push_seconds` | histogram | seconds | `outcome` | `SourceControlManager.push` (Task 10) |
| `swarm_merge_mergeable_wait_seconds` | histogram | seconds | `outcome` | `waitMergeable` (Task 10) |
| `swarm_merge_pr_seconds` | histogram | seconds | `op` (`open`, `merge`), `outcome` | `GitHubHost` (Task 10) |
| `swarm_merge_stack_push_seconds` | histogram | seconds | `outcome` | `pushGoalStack` (Task 10) |

`role` is one of `worker`, `reviewer`, `arbiter`, `planner`, `conflict_resolver`, `labeler`; `backend` is `claude-code`, `codex` or `api`; `tool` is the tool's name as the model called it; `target` is the frame's first `<namespace>/<Type or mutation>` key, or `health` or `schema`; `cmd` is defined in Task 8; `route` is a route pattern, never a raw path.

- [ ] **Step 1: Write the failing tests.**
  - `catalogue.test.ts`: names are unique across `CATALOGUE`; every name matches `/^swarm_[a-z0-9_]+$/`; counters end `_total`; histograms with unit `seconds` end `_seconds`, unit `bytes` end `_bytes`; counters with unit `tokens` end `_tokens_total`; no def declares a label in `["path", "title", "id", "message", "error", "prompt", "card", "card_id", "session_id", "task_id", "body"]`; `RUN_PHASES` has no duplicates; `defineAll` on `new MetricsRegistry({ strict: true })` succeeds, and recording one value on every def with a value for each declared label does not throw; `OS_METRICS` is an array.
  - `context.test.ts`: inside `metrics.time("a", …)`, a `metrics.span("b")` gets the outer span's id as `parent` (read from the sink's records); `withSpan(s, () => metrics.span("c"))` parents `c` to `s`; `metrics.span("d", {}, null)` has no parent even inside `withSpan`; two `time()` calls run under `Promise.all`, each creating an inner span after an `await`, keep their own parents; `processMetrics()` is `noopMetrics` until `setProcessMetrics(r)`, then `r`, and `noopMetrics` again after `setProcessMetrics(null)`.
- [ ] **Step 2: Run them to see them fail.** Run: `cd packages/metrics && npx vitest run tests/catalogue.test.ts tests/context.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Catalogue modules are data only. `context.ts` keeps one module-level `AsyncLocalStorage<Span>` and one module-level `Metrics | null`.
- [ ] **Step 4: Run all metrics tests to see them pass.** Run: `cd packages/metrics && npx vitest run && cd ../.. && pnpm -w build`. Expected: PASS; build green.
- [ ] **Step 5: Commit**

```bash
git add packages/metrics
git -c commit.gpgsign=false commit -m "feat(metrics): the catalogue of every run metric, span context and a per-process registry"
```

---

### Task 6: The run's registry, its file and the start-up phases

**Files:**
- Create: `packages/cli/src/cli/run-metrics.ts`
- Modify: `packages/cli/package.json` (`"@mnmal-ai/swarm-metrics": "workspace:*"`), `packages/cli/src/cli/main.ts` (the `run` command's pre-run steps), `packages/cli/src/cli/run.ts` (`runOrchestrator` gains a fourth parameter; bind after `runId`; phases 3 to 22 and 37 to 39 of the inventory below), `packages/types/src/orchestration.ts` (`ProjectConfig.metrics?: { retain_days?: number }`), `packages/cli/src/scaffold/templates/index.ts` (`.gitignore` template gains `metrics/`)
- Test: `packages/cli/tests/run-metrics.test.ts`

**Interfaces:**
- Consumes: `MetricsRegistry`, `JsonlMetricsSink`, `DeferredMetricsSink`, `startProcessSampler`, `defineAll`, `setProcessMetrics`, `withSpan`, `RUN_PHASES`, `RunPhase` (Tasks 1 to 5).
- Produces:

```ts
// packages/cli/src/cli/run-metrics.ts
export interface RunMetrics {
  readonly metrics: MetricsRegistry;     // strict: false, CATALOGUE defined, used through metrics.with({ process: "run" }) by callers that record directly
  readonly root: Span;                   // "swarm_run_seconds", started at creation, parent null
  readonly dir: string | null;           // <swarmPath>/metrics once bound
  readonly runId: string | null;
  bind(opts: { swarmPath: string; runId: string; retainDays?: number }): void;   // attaches a JsonlMetricsSink(<swarmPath>/metrics, { file: () => `${runId}.jsonl`, retainDays, onWriteFailed: (n) => metrics.inc("swarm_metrics_sink_errors_total", {}, n) }) to the deferred sink; writes <swarmPath>/metrics/.gitignore containing "*\n" when absent; starts snapshots every 60 s and startProcessSampler({ diskPaths: [swarmPath] }); registers process.on("exit") → closeSync("error"); idempotent
  phase<T>(name: RunPhase, fn: () => Promise<T> | T): Promise<T>;                  // metrics.time("swarm_run_phase_seconds", { phase: name }, fn, root) run inside withSpan(root)
  close(outcome: SpanOutcome): Promise<void>;                                       // ends root, writes a final snapshot, stops the sampler and snapshots, flushes; idempotent
  closeSync(outcome: SpanOutcome): void;
}
export function createRunMetrics(opts?: { clock?: MetricsClock; sampler?: boolean /* default true */ }): RunMetrics;   // also setProcessMetrics(metrics)
// packages/cli/src/cli/run.ts
export async function runOrchestrator(args: Record<string, string>, substrateClient?: any, _queryClient?: SwarmQueryClient, runMetrics?: RunMetrics): Promise<void>;   // creates its own when absent
```

The run's file has no `run_id` label on its series (the file is the run, and leaving it off lets `swarm metrics --since` add runs together); span records carry their ids.

- [ ] **Step 1: Write the failing tests** in `packages/cli/tests/run-metrics.test.ts`, on a temporary swarm directory and `sampler: false`:
  - `records before bind land in the run file after bind`: `phase("preamble", …)` before `bind`, `phase("config", …)` after, `close("ok")`; `<swarm>/metrics/<runId>.jsonl` holds two `swarm_run_phase_seconds` span records whose `parent` is `root.id`, then the root `swarm_run_seconds` span with `outcome: "ok"`, then a `snap` record.
  - `bind writes a self-ignoring directory`: `<swarm>/metrics/.gitignore` is `"*\n"`; a second `bind` changes nothing; an existing `.gitignore` is left as is.
  - `phase records error and rethrows`: a throwing phase records `outcome: "error"` and the error propagates.
  - `closeSync flushes without awaiting`, and `close` after `closeSync` writes nothing more.
  - `createRunMetrics sets the process registry`: `processMetrics()` is `metrics`.
  - `the scaffold ignores metrics/`: `TEMPLATES[".gitignore"]` contains a `metrics/` line.
- [ ] **Step 2: Run them to see them fail.** Run: `cd packages/cli && npx vitest run tests/run-metrics.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `run-metrics.ts`**, then wire it:
  - `main.ts`, `run` command only: `createRunMetrics()` before `prepareProjectSubstrate`; `phase("preamble", …)` around `prepareProjectSubstrate`, `phase("stack_boot", …)` around `resolveDbConfig` and `ensureProjectSubstrate`, `phase("seed", …)` around `seedSwarmContent`, `phase("mcp_reconcile", …)` around `reconcileMcpServers`; pass it to `runOrchestrator` as the fourth argument. A `process.exit` before `runOrchestrator` binds nothing and loses nothing that matters (no run id exists yet).
  - `run.ts`: `runMetrics.bind({ swarmPath, runId, retainDays: projectConfig.metrics?.retain_days })` immediately after `runId` is computed (the config is read later, so bind with the default first and pass `retain_days` to the sink when the config is read: `bind` is idempotent, so add `setRetainDays(days)` on `RunMetrics` if the sink is already attached, or move the read; record which in the report). Wrap, as `RUN_PHASES` names them: config read and validation (`config`), `syncBaseBranch` (`base_sync`), `runSetupCommand` (`setup`), `prepareGitHubAccess` (`github_preflight`), goal fetching (`goal_discovery`), `labelGoals` (`goal_labels`), the wiring block from `createTaskBackend` through `createSectionSync` (`wiring`), the three `resolveWorkerBackend` calls (`backend_resolve`), `preflightCredentialCheck` and `preflightCodexRoles` (`credential_preflight`), `claimProject` (`project_claim`), checkpoint load and the resume prompt (`resume`), `printSwarmTree` (`preflight_screen`), the approval prompt (`approval`), `new DashboardServer` and its start (`dashboard_start`), `ensureGitReady` (`git_ready`), `pruneStale` (`worktree_prune`), the pre-loop block from `session_started` through `publishEarlierMerges` (`pre_loop`), the goal loop as a whole (`execution`), `saveRunCheckpoint` (`final_checkpoint`), the sharing upload (`sharing_upload`) and the stop block (`stop`). Line numbers in `.superpowers/sdd/10-metrics/inventory.md` §1 are as of commit `8e65266`. Call `runMetrics.close(outcome)` at the normal end (`ok`), in the SIGINT path (`cancelled`) and before every `process.exit(non-zero)` after `bind` (`error`), relying on the exit handler for anything missed.
- [ ] **Step 4: Run the tests to see them pass.** Run: `cd packages/cli && npx vitest run && cd ../.. && pnpm -w build`. Expected: the new tests pass, the whole CLI suite stays green, build green.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/run-metrics.ts packages/cli/src/cli/main.ts packages/cli/src/cli/run.ts packages/cli/package.json packages/cli/src/scaffold/templates/index.ts packages/types/src/orchestration.ts packages/cli/tests/run-metrics.test.ts pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "feat(run): a metrics file per run with every start-up phase timed"
```

---

### Task 7: Every Substrate request and every step of the stack's bring-up

**Files:**
- Modify: `packages/substrate/package.json` (dependency), `packages/substrate/src/transport/http-transport.ts` (`#request`), `packages/substrate/src/client.ts` (`query` page count, `isHealthy`, `getSchema`), `packages/substrate/src/lifecycle/ready.ts` (`probeNamespaceSchema`, `ensureTypesRegistered`, `checkMeta`, `ensureSharedStores`), `packages/substrate/src/lifecycle/sidecar.ts` (`sidecarHealthy`, `ensureSidecar`), `packages/substrate/src/lifecycle/runtime.ts` (`ensureRuntimeInstalled`), `packages/substrate/src/lifecycle/postgres.ts` (`ensureDedicatedPostgres`)
- Test: the substrate package's existing test location for the transport and lifecycle (beside the files they test), new file `http-transport.metrics.test.ts` and `lifecycle.metrics.test.ts`

**Interfaces:**
- Consumes: `processMetrics`, `testRegistry`, `setProcessMetrics` (Task 5).
- Produces: no new exports. Every call reads `processMetrics()` at call time, so a registry set after a client is constructed still counts.

- [ ] **Step 1: Write the failing tests.** With `setProcessMetrics(testRegistry(CATALOGUE…).metrics)` and a stubbed `fetch`:
  - a `query` for `{"swarm/SessionEvent": …}` that returns 200 records `swarm_substrate_request_seconds{op:"query", target:"swarm/SessionEvent", outcome:"ok"}` once and `swarm_substrate_response_bytes{op:"query"}` with the body length;
  - a paginated `query` that follows two cursors records three requests and one `swarm_substrate_query_pages{target}` observation of `3`;
  - a 503 records `outcome:"error"` and `swarm_substrate_errors_total{op:"query", code:"http_5xx"}`; an `AbortSignal.timeout` abort records `code:"timeout"`; a rejected `fetch` records `code:"network"`; a refused frame (`SubstrateFrameError`) records `code:"frame"`;
  - `isHealthy` records `op:"health", target:"health"`; `getSchema` records `op:"schema", target:"schema"`;
  - each lifecycle step, driven with the package's existing fakes for docker, npm and spawn, records `swarm_substrate_boot_seconds{step}` with the step words above.
- [ ] **Step 2: Run them to see them fail.** Run the substrate package's vitest on the new files. Expected: FAIL.
- [ ] **Step 3: Implement** with `processMetrics().time(…)` or a span around each call; classify errors before rethrowing; never change what a call returns or throws.
- [ ] **Step 4: Run the substrate suite and the build.** Run: `cd packages/substrate && npx vitest run && cd ../.. && pnpm -w build`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/substrate pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "feat(substrate): time every request and every bring-up step"
```

---

### Task 8: Every git, gh, task-source and shell command

**Files:**
- Create: `packages/metrics/src/exec.ts`
- Modify: `packages/metrics/src/index.ts`; the four `execFileAsync` copies (`packages/orchestrator/src/orchestrator/index.ts`, `packages/orchestrator/src/source-control/index.ts`, `packages/orchestrator/src/worktree/index.ts`, `packages/orchestrator/src/source-control/github-host.ts`) replaced by `execFileTimed`; the raw git calls in `packages/orchestrator/src/source-control/stack.ts`, `packages/orchestrator/src/source-control/merge-lock.ts`, `packages/cli/src/cli/goal-stack.ts`, `packages/cli/src/cli/context-sections.ts`, `packages/cli/src/cli/run-prep.ts`, `packages/cli/src/cli/repo-root.ts`, `ensureGitReady` in `packages/cli/src/cli/run.ts`, `packages/core/src/git-head.ts`, `captureGitDiff` in `packages/oversight/src/index.ts`, `packages/worker-backends/src/codex-args.ts`, `packages/cli/src/cli/author-id.ts`; `packages/task-backends/src/run-cli.ts`; `GitHubTaskBackend.ghWithInput`, `GitHubExternalSource.gh`, the `CommandRunner` in `packages/cli/src/cli/github-account.ts`; `runSetupCommand` (`run-prep.ts`), `defaultCommandRunner` (`packages/orchestrator/src/ship-readiness/gate.ts`), `spawnInGroup` (`packages/types/src/process-group.ts`, gaining an optional `metricKind`), the fnl hook (`packages/worker-backends/src/fnl-hook.ts`), `checkDependencyVersion` (`packages/cli/src/external-deps.ts`); each touched package's `package.json` gains the dependency
- Test: `packages/metrics/tests/exec.test.ts`, `packages/task-backends/tests/run-cli.metrics.test.ts`, `packages/orchestrator/tests/exec-timing.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces:

```ts
// packages/metrics/src/exec.ts
export function commandMetric(file: string, args: readonly string[]): { name: "swarm_git_command_seconds" | "swarm_gh_command_seconds" | "swarm_run_command_seconds"; labels: Labels };
export function execFileTimed(file: string, args: readonly string[], opts?: ExecFileOptions & { metrics?: Metrics; kind?: string }): Promise<{ stdout: string; stderr: string }>;   // promisified execFile with the same resolve and reject shape as the copies it replaces
export function execFileSyncTimed(file: string, args: readonly string[], opts?: ExecFileSyncOptions & { metrics?: Metrics; kind?: string }): string | Buffer;
export function timeSync<T>(name: string, labels: Labels, fn: () => T, metrics?: Metrics): T;
```

`commandMetric`: for `git` (basename), skip leading `-c <k=v>`, `-C <dir>` and `--no-pager`, then `cmd` = the first remaining word (`fetch`, `merge`, `worktree`, …); for `gh`, `cmd` = the first word plus the second when the second does not start with `-` (`pr create`, `api`, `auth token`), at most 32 characters; anything else is `swarm_run_command_seconds{kind}` with `kind` from the option, else `other`. `outcome` is `ok`, `error`, or `timeout` when the child was killed by the timeout.

`runCli` records `swarm_tasks_cli_seconds{source, op, outcome}`: `source` is `github` when the command's basename is `gh`, else `trello`; `op` is the first argument word (at most 32 characters). It does not also record `swarm_gh_command_seconds`, so time is never counted twice.

- [ ] **Step 1: Write the failing tests.** `exec.test.ts`: `commandMetric` cases for `git -C /x -c a=b fetch origin` → `fetch`, `git --no-pager log` → `log`, `gh pr create --title t` → `pr create`, `gh api repos/x` → `api`, `sh -c x` with `kind: "setup"` → `swarm_run_command_seconds{kind:"setup"}`; `execFileTimed("node", ["-e", "process.exit(3)"])` rejects as `execFile` would and records `outcome:"error"`; a `timeout: 50` child running `setTimeout(…, 5000)` records `outcome:"timeout"`; `execFileSyncTimed` returns stdout and records once. `run-cli.metrics.test.ts`: a stubbed command records the task-source row and nothing under `swarm_gh_command_seconds`. `exec-timing.test.ts`: a `WorktreeManager` git call on a temporary repository records `swarm_git_command_seconds{cmd:"worktree"}`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** `exec.ts`, then replace the copies and wrap each listed site without changing arguments, options, return values or errors. `spawnInGroup` callers pass `metricKind`: the Bash tool `bash_tool`, the functional validator `validator`, discovery `discovery`, MCP management `mcp`.
- [ ] **Step 4: Run every touched package's suite and the build.** Run: `pnpm turbo test --filter=@mnmal-ai/swarm-metrics --filter=@mnmal-ai/swarm-orchestrator --filter=@mnmal-ai/swarm-task-backends --filter=@mnmal-ai/swarm-core --filter=@mnmal-ai/swarm-oversight --filter=@mnmal-ai/swarm-worker-backends --filter=@mnmal-ai/swarm-types --filter=@mnmal-ai/swarm-cli && pnpm -w build`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/metrics packages/orchestrator packages/task-backends packages/core packages/oversight packages/worker-backends packages/types packages/cli pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "feat(metrics): time every git, gh, task-source and shell command"
```

---

### Task 9: Every agent session, model call, tool call and rate-limit wait

**Files:**
- Modify: `packages/types/src/config.ts` (`WorkerTaskOutput` gains `apiLatencyMs?: number; numTurns?: number; firstMessageMs?: number`; `BackendConfig` gains `metrics?: Metrics`, a type-only import; `packages/types/package.json` gains the dependency on `@mnmal-ai/swarm-metrics`, which has none of its own, so there is no cycle), `packages/worker-backends/src/claude-code.ts` (read `duration_api_ms` and `num_turns`; time the first message; pair `tool_use.id` with `tool_result.tool_use_id`), `packages/worker-backends/src/codex-events.ts` (start time in `open`, record at `toolDone` and `closeOpen`), `packages/worker-backends/src/small-model.ts`, `packages/cli/src/cli/role-models.ts` (`withModelReporting` records the session rows), `packages/cli/src/cli/run.ts` (each role's backend gets `metrics: runMetrics.metrics.with({ role, backend })`), `packages/core/src/swarm.ts` (the api path's session span and its existing tool timing; `pauseForRateLimit` measured wait; fallback counter), `packages/core/src/executor/index.ts` (`withRetry` per-attempt seconds, retries, the retry sleep), `packages/oversight/src/index.ts` (the two 60 s rate-limit sleeps, measured), `packages/orchestrator/src/rate-limit-gate.ts` (`wait()` measured, site `gate`), the decomposition retry sleep in `run.ts` (site `decomposition`)
- Test: `packages/worker-backends/tests/claude-code.metrics.test.ts`, `packages/worker-backends/tests/codex-events.metrics.test.ts`, `packages/cli/tests/role-models.metrics.test.ts`, `packages/core/tests/executor.metrics.test.ts`, `packages/orchestrator/tests/rate-limit-gate.metrics.test.ts`

**Interfaces:**
- Consumes: Task 5; the existing `withModelReporting`, `ClaudeCodeBackend`, `CodexEventCollector`, `withRetry`, `RateLimitGate`.
- Produces: `WorkerTaskOutput.apiLatencyMs`, `numTurns`, `firstMessageMs` (all optional, filled by the claude-code backend; codex fills `firstMessageMs` only).

- [ ] **Step 1: Write the failing tests.**
  - `claude-code.metrics.test.ts`, with the existing fake SDK stream: a session whose stream is `system init`, `assistant` with `tool_use {id: "t1", name: "Read"}`, `user` with `tool_result {tool_use_id: "t1"}` 400 ms later, `assistant` with `tool_use {id: "t2", name: "Bash"}`, `user` with `tool_result {tool_use_id: "t2", is_error: true}` 1 s later, then `result {duration_ms: 5000, duration_api_ms: 3000, num_turns: 4}` records `swarm_agent_tool_seconds{tool:"Read", outcome:"ok"}` = 0.4 and `{tool:"Bash", outcome:"error"}` = 1.0 (labels `role` and `backend` from `config.metrics`), and the output carries `apiLatencyMs: 3000`, `numTurns: 4` and a `firstMessageMs` equal to the fake clock's offset of the first `assistant` message. A `tool_use` with no `tool_result` before `result` records `outcome:"cancelled"` at the end.
  - `codex-events.metrics.test.ts`: `started` then `completed` 250 ms later for item `shell` records `swarm_agent_tool_seconds{tool:"shell"}` = 0.25; an item still open at `closeOpen` records `outcome:"cancelled"`.
  - `role-models.metrics.test.ts`: `withModelReporting` for role `reviewer` over a backend returning `latencyMs: 8000, apiLatencyMs: 6000, numTurns: 3, tokensUsed: {input: 100, output: 50, cacheRead: 1000, cacheWrite: 10}` records `swarm_agent_session_seconds{role:"reviewer", backend, outcome:"ok"}` = 8, `swarm_agent_api_seconds` = 6, `swarm_agent_turns` = 3, the four `swarm_agent_tokens_total{kind}` counters and `swarm_agent_session_tokens` = 1160; a backend that throws `RateLimitError` records `outcome:"error"` and `swarm_agent_rate_limits_total`.
  - `executor.metrics.test.ts`: a provider that answers 429, 429, 200 records three `swarm_agent_api_call_seconds{provider:"anthropic"}` observations (two `error`, one `ok`), `swarm_agent_api_retries_total{status:"429"}` = 2 and two `swarm_agent_rate_limit_wait_seconds{site:"api_retry"}` observations equal to the slept time on the fake timer.
  - `rate-limit-gate.metrics.test.ts`: `wait()` while the gate is closed for 60 s on fake timers records one `site:"gate"` observation of 60.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Measured waits come from the monotonic clock around the actual `sleep`, never from the planned value. No code reads `total_cost_usd` or `costUSD`.
- [ ] **Step 4: Run every touched package's suite and the build.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/types packages/worker-backends packages/cli packages/core packages/oversight packages/orchestrator pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "feat(metrics): time every agent session, model call, tool call and rate-limit wait"
```

---

### Task 10: Goals, tasks, worktrees, merges, pushes and the rest of the run

**Files:**
- Modify: `packages/cli/src/cli/run.ts` (goal spans with `withSpan` so their tasks nest; per-goal `planning`, `task_registration`, `goal_dispatch_prep`, `remediation`, `ship_readiness`, `merge`, `goal_bookkeeping`, `stack_push` phases; the sequential task sites' `swarm_run_task_seconds` and `swarm_run_tasks_total`; `swarm_run_events_total` from `eventBus.onAny`; `swarm_run_tokens_used_ratio` on `tokens:update`), `packages/orchestrator/src/orchestrator/index.ts` (the parallel path's task spans in `_dispatchFlat`; `saveCheckpoint`, `loadCheckpoint`), `packages/orchestrator/src/worktree/index.ts`, `packages/orchestrator/src/source-control/merge-lock.ts`, `packages/orchestrator/src/source-control/index.ts` (`attemptMerge`, `push`, `waitMergeable`, `pushGoalStack`), `packages/orchestrator/src/source-control/merge.ts` (`runMergeGate`), `packages/orchestrator/src/source-control/github-host.ts`, `packages/orchestrator/src/ship-readiness/gate.ts`, `packages/telemetry/src/telemetry/index.ts` and `upload.ts`, `packages/cli/src/server/index.ts` (clients gauge; request seconds by route pattern `/`, `/axon.css`, `/api/substrate`, `/api/transcript/:id`, `/api/tasks`, `/api/tasks/:id`, `/api/metrics`, `ws`, `other`), the context section sync in `packages/core/src/swarm.ts` or `packages/cli/src/cli/context-sections.ts` (wherever `context:sync-done.ms` is computed)
- Test: `packages/orchestrator/tests/merge.metrics.test.ts`, `packages/orchestrator/tests/worktree.metrics.test.ts`, `packages/orchestrator/tests/checkpoint.metrics.test.ts`, `packages/telemetry/tests/telemetry.metrics.test.ts`, `packages/cli/tests/dashboard-server.metrics.test.ts`

**Interfaces:**
- Consumes: Tasks 5 to 9.
- Produces: nothing new; every row of the `run` and `merge` areas in Task 5's table is recorded after this task.

- [ ] **Step 1: Write the failing tests.** Each on `testRegistry` and the package's existing fakes: `FileMergeQueue.take` that waits behind a held turn for 2 s on fake timers records `swarm_merge_queue_wait_seconds` = 2 and, on release, `swarm_merge_turn_held_seconds`; `runMergeGate` with a passing and a failing command records `swarm_merge_gate_seconds{outcome}` both ways; `waitMergeable` that gives up records `outcome:"timeout"`; a `WorktreeManager.create` and `destroy` on a temporary repository record their `op` rows; `saveCheckpoint` records `op:"save"`; `Telemetry` writing to JSONL records `sink:"jsonl"`; the dashboard server answering `GET /api/tasks/abc` records `route:"/api/tasks/:id", status:"2xx"` and a connected WebSocket sets `swarm_run_dashboard_clients` to 1, back to 0 on close.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Use the existing durations where they are already computed (`waitedMs`, `heldMs`, `GateResult.durationMs`) by observing them in seconds rather than timing twice. The parallel path records task spans in the orchestrator and the sequential path in `run.ts`; a task is never counted by both.
- [ ] **Step 4: Run every touched package's suite and the build.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/orchestrator packages/telemetry packages/core pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "feat(metrics): time goals, tasks, worktrees, merges, pushes and the dashboard"
```

---

### Task 11: The end-of-run block and `swarm metrics`

**Files:**
- Create: `packages/cli/src/cli/metrics.ts`
- Modify: `packages/cli/src/cli/main.ts` (`case "metrics"`; `metrics` joins the commands that skip the project Substrate preparation and stack bring-up; help text), `packages/cli/src/cli/run.ts` (print the block in the stop phase)
- Test: `packages/cli/tests/metrics-command.test.ts`

**Interfaces:**
- Consumes: `readMetricsDir`, `aggregate`, `topSinks`, `waterfall`, `formatSummary`, `formatTopSinks`, `formatWaterfall`, `formatDuration`, `CATALOGUE` (Tasks 3, 5); `RunMetrics` (Task 6).
- Produces:

```ts
export async function runMetricsCommand(args: Record<string, string>, out?: (line: string) => void): Promise<number>;   // exit code
```

Flags: `--run <runId>` or `--last` (default: the most recently modified `<runId>.jsonl`), `--since <dur>` (`30m`, `24h`, `7d`; aggregates every run file with records in the window, including `*.room-mcp.*.jsonl` files), `--top <n>` (default 15), `--waterfall` (depth 3 by default, `--depth <n>`), `--json` (prints `{ runId, wallSeconds, snapshot, top, waterfall? }`), `--catalogue` (every `CATALOGUE` row: name, kind, unit, labels, help), `--swarm-path`. A run's files are `<runId>.jsonl` plus `<runId>.*.jsonl`. With no metrics directory it prints `No metrics yet. They appear after the next swarm run.` and exits 0.

The end-of-run block, printed after the existing session summary unless `--quiet`:

```
  Performance
  <formatSummary(runMetrics.metrics.snapshot(), { wallSeconds, top: 5 }), each line indented two spaces>
  Metrics   <dir>/<runId>.jsonl   (swarm metrics --run <runId>)
```

- [ ] **Step 1: Write the failing tests** on fixture files written with `JsonlMetricsSink` into a temporary swarm directory: `--last` picks the newest run; `--run` prints `Run <id>`, a `Time` line, phase lines and `Top time sinks`; `--waterfall` prints the indented tree; `--since 1h` adds two runs' counters; `--json` parses and holds `top`; `--catalogue` lists `swarm_run_phase_seconds`; an absent directory prints the message and returns 0; output never contains `$`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement**, and print the block from `run.ts`. Always call `aggregate(records, { since, defs: CATALOGUE })`: `since` so each boot's counters are differenced at the window's start, and `defs` so observed seconds metrics (such as `swarm_agent_api_seconds`) aggregate as seconds and appear among the time sinks. Read the files with no `since` filter (`readMetricsDir` without `since`) so `aggregate` sees each boot's snapshot from before the window; build `--waterfall` from the run's unfiltered files too.
- [ ] **Step 4: Run the CLI suite and the build.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/metrics.ts packages/cli/src/cli/main.ts packages/cli/src/cli/run.ts packages/cli/tests/metrics-command.test.ts
git -c commit.gpgsign=false commit -m "feat(cli): swarm metrics, and a performance block at the end of every run"
```

---

### Task 12: The run dashboard's Performance panel

**Files:**
- Modify: `packages/cli/src/server/index.ts` (`DashboardServer` options gain `metrics?: MetricsRegistry` and `metricsFile?: string`; `GET /api/metrics`), `packages/cli/src/server/dashboard.html` (a `view-performance` view, a drill button, `"performance"` in `showView`'s list), `packages/cli/src/cli/run.ts` (pass both to `new DashboardServer`)
- Test: `packages/cli/tests/dashboard-performance.test.ts`; extend `packages/cli/tests/dashboard-views.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 10.
- Produces: `GET /api/metrics` → `{ at: number; wallSeconds: number; phases: Array<{ phase: string; seconds: number; share: number }>; agents: Array<{ role: string; sessionSeconds: number; modelSeconds: number; toolSeconds: number; tokensIn: number; tokensOut: number }>; top: SinkRow[] /* 20 */; process: GaugeSnapshot[]; waterfall: SpanNode[] /* depth 3, from metricsFile */ }`, guarded like the other `/api` routes.

- [ ] **Step 1: Write the failing tests.** Server: with a registry holding phase, agent and process rows and a metrics file holding a three-level span tree, `GET /api/metrics` returns the shape above with phases sorted longest first and shares summing to at most 1. Page (jsdom, as the sibling dashboard tests do): `showView("performance")` shows the view; given a stubbed `/api/metrics` response it renders a Phases table (phase, time, share), a Top time sinks table (metric, labels, count, total, p50, p99), an Agents table (role, session, model, tools, tokens in and out), a Process line (event-loop p99, RSS, heap, CPU) and the waterfall as nested rows; it polls every 5 s only while the view is visible; no `$` appears.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** in the page's existing vanilla style with Axon tokens, matching the existing "Execution Timing" panel's look.
- [ ] **Step 4: Run the CLI suite and the build.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/server/index.ts packages/cli/src/server/dashboard.html packages/cli/src/cli/run.ts packages/cli/tests/dashboard-performance.test.ts packages/cli/tests/dashboard-views.test.ts
git -c commit.gpgsign=false commit -m "feat(dashboard): a Performance panel with phases, time sinks, agents and the waterfall"
```

---

### Task 13: Nothing in the catalogue goes unrecorded, and a real run proves it

**Files:**
- Create: `tests/integration/metrics-coverage.test.ts`
- Test: itself; and the controller's acceptance run below.

**Interfaces:**
- Consumes: `CATALOGUE`, `PROCESS_METRICS`, `SELF_METRICS`, `RUN_METRICS`.
- Produces: a test that later plans extend to `OS_METRICS` (plan 09's last task flips its `includeOs` flag to `true`).

- [ ] **Step 1: Write the test.** For every def in `PROCESS_METRICS`, `SELF_METRICS` and `RUN_METRICS`, the name appears as a string literal in at least one `.ts` file under `packages/*/src/`, excluding `packages/metrics/src/catalogue/`. A constant `includeOs = false` gates the same check for `OS_METRICS`. Metric names are always literals at the call site, never built from parts, so this check is exact.
- [ ] **Step 2: Run it.** Run: `cd tests/integration && npx vitest run metrics-coverage.test.ts`. Expected: PASS. A failure names each unrecorded metric; fix by recording it in the task that owns it, or by removing the row with a ruling.
- [ ] **Step 3: Commit**

```bash
git add tests/integration/metrics-coverage.test.ts
git -c commit.gpgsign=false commit -m "test(metrics): every catalogued run metric is recorded somewhere"
```

- [ ] **Step 4 (controller, not a subagent): an acceptance run.** On the throwaway project used to prove the one-command run (its own dedicated stack, never a client project), run `env -u ANTHROPIC_API_KEY swarm run --yes` with a one-task goal, then `swarm metrics --last` and `swarm metrics --last --waterfall`. Expected: the end-of-run block prints; every phase of the run appears; agent model time and tool time are both non-zero; `swarm_substrate_request_seconds`, `swarm_git_command_seconds` and `swarm_merge_gate_seconds` appear in the top sinks or the JSON; the dashboard's Performance view shows the same numbers. Record the output in the ledger.
