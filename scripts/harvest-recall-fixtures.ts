#!/usr/bin/env tsx
/**
 * Harvest a labeled recall-fixture set from REAL swarm runs.
 *
 * goal-12 (the engine-recall quality bar) needs a fixture set of
 * `prompt -> expectedIntent + expectedContentPaths` triples derived from real
 * `classifyIntent` / `loadContext` history so precision/recall/F1 can be measured
 * against ground truth. This script harvests those triples from the three real
 * sources catalogued in docs/plans/2026-06-02-recall-fixtures-sources.md, attaches
 * per-fixture provenance, deduplicates by prompt, and writes a deterministic
 * train/test split. It NEVER fabricates a record — every fixture is traceable to a
 * real sessionId (and, where available, a runId).
 *
 * Sources (per the inventory doc):
 *   1. Live/cold Substrate store (PRIMARY, the superset): join worker `SessionEvent`
 *      (`intent`, `swarmFilesLoaded`) with worker `TranscriptEntry` (`prompt`) on
 *      `sessionId`. `SwarmContent` is read to validate that each
 *      `expectedContentPaths` entry resolves to a real corpus file. Reading these
 *      already-materialized rows over HTTP IS "driving the sidecar to read
 *      historical SessionEvent rows" — no replay/spawn is required (doc §Source 2).
 *   2. Telemetry JSONL (`telemetry/events/*.jsonl`, searched recursively):
 *      EventBus `bus_event`
 *      wrappers whose triple is reconstructed by joining `intent:classified` +
 *      `context:loaded` + worker `transcript` on `payload.sessionId`. Carries the
 *      top-level `runId` that the Substrate rows lack, so it is the provenance path and
 *      the source for cold-test sessions not in the live store.
 *   3. learned/runs/*.md RunObservation files: run-level rollups with NO per-
 *      classification signal (doc §Source 3 -> 0 triples). Read only to decorate
 *      matching JSONL fixtures with run metadata (project/swarmVersion); never a
 *      triple source.
 *
 * The Substrate and JSONL sources are the SAME underlying population (don't sum) —
 * dedup-by-prompt collapses the overlap and merges provenance (a JSONL `runId`
 * enriches the matching Substrate fixture).
 *
 * Endpoint resolution uses the honored config chain (lifecycle
 * `resolveSubstrateEndpoint`): explicit --endpoint > SWARM_SUBSTRATE_ENDPOINT >
 * ~/.swarm/config.json.substrate_url > SWARM_SUBSTRATE_PORT > :32338. The isolated test
 * stack (ports 42337-42341) is REFUSED — harvesting real history must never read a
 * throwaway test DB.
 *
 * Output is byte-deterministic given the same input data (fixtures sorted by
 * sessionId then prompt; no wall-clock fields) so repeated runs are idempotent.
 *
 * Usage:
 *   npx tsx scripts/harvest-recall-fixtures.ts --dry-run
 *   npx tsx scripts/harvest-recall-fixtures.ts --limit 20 --dry-run
 *   npx tsx scripts/harvest-recall-fixtures.ts --out tests/fixtures/recall-fixtures.json
 *   npx tsx scripts/harvest-recall-fixtures.ts \
 *     --telemetry-root ../my-project --learned-root ../my-project
 *
 * Flags:
 *   --out             Output path. Default: tests/fixtures/recall-fixtures.json
 *   --endpoint        Substrate sidecar URL. Default: resolveSubstrateEndpoint() chain.
 *   --telemetry-root  Root dir scanned recursively for telemetry/events/*.jsonl. Repeatable.
 *                     Default: the swarm repo (cwd) and ~/.swarm (doc-documented).
 *   --learned-root    Root dir scanned recursively for learned/runs/*.md. Repeatable.
 *                     Default: same as --telemetry-root defaults.
 *   --sources         Comma list of sources to harvest: substrate,telemetry,learned.
 *                     Default: all three.
 *   --test-percent    Held-out test fraction (integer percent). Default: 20. Min 20.
 *   --limit           Cap the number of emitted fixtures (deterministic prefix).
 *                     Use for a small self-test sample.
 *   --strict-paths    Drop any fixture with a content path absent from SwarmContent.
 *                     Default: off (unresolved paths are counted + reported only).
 *   --dry-run         Harvest + summarize + print a sample; write NOTHING to disk.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

// The Substrate source needs the client package. Import it dynamically inside
// harvestSubstrate() (and resolveSubstrateEndpoint lazily in main) so the
// JSONL/learned paths run with node built-ins alone when --sources excludes
// substrate. Types are erased at compile so the type-only import carries no
// runtime edge.
import type { SubstrateClient as SubstrateClientType } from "../packages/substrate/src/index.js";

// --- Types ---

type SourceName = "substrate" | "telemetry" | "learned";

interface Provenance {
  /** Which real source the triple came from. */
  source: "substrate" | "telemetry-jsonl";
  sessionId: string;
  /** Present only on telemetry-jsonl rows (and Substrate rows enriched by a matching
   *  JSONL/run). Substrate `SessionEvent` carries no runId. */
  runId?: string;
  /** Substrate `SessionEvent.eventId`, when harvested from Substrate. */
  eventId?: string;
  /** ISO timestamp of the originating session event, when available. */
  timestamp?: string;
  /** Source filename for JSONL rows (the daily telemetry file). */
  sourceFile?: string;
  /** Decorated from a matching learned/runs RunObservation, when found. */
  project?: string;
  swarmVersion?: string;
}

interface Fixture {
  prompt: string;
  expectedIntent: string;
  expectedContentPaths: string[];
  /** Stable train/test assignment (hash of sessionId+prompt). */
  split: "train" | "test";
  provenance: Provenance;
  /** How many of expectedContentPaths resolve to a real SwarmContent row. */
  pathsResolved?: number;
}

/** A pre-split, pre-dedup harvested triple. */
interface Candidate {
  prompt: string;
  expectedIntent: string;
  expectedContentPaths: string[];
  provenance: Provenance;
}

// --- CLI args ---

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "tests/fixtures/recall-fixtures.json" },
    endpoint: { type: "string" },
    "telemetry-root": { type: "string", multiple: true },
    "learned-root": { type: "string", multiple: true },
    sources: { type: "string", default: "substrate,telemetry,learned" },
    "test-percent": { type: "string", default: "20" },
    limit: { type: "string" },
    "strict-paths": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const OUT_PATH = resolve(values.out!);
const DRY_RUN = values["dry-run"]!;
const STRICT_PATHS = values["strict-paths"]!;
const LIMIT = values.limit ? Number.parseInt(values.limit, 10) : undefined;

// The held-out test fraction is floored at 20% per the goal constraint
// ("hold out at least 20% as a test set"). A smaller value would violate it.
const TEST_PERCENT = Math.max(20, Number.parseInt(values["test-percent"]!, 10) || 20);

const SOURCES = new Set(
  values
    .sources!.split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SourceName[],
);

// Default scan roots: the swarm repo (cwd) and ~/.swarm, as the inventory doc
// documents. Per-project swarm content (the real bulk) lives elsewhere, so a
// harvest that wants JSONL provenance points --telemetry-root at the adopted
// project dir; the recursive walk finds telemetry/events/*.jsonl beneath it.
const DEFAULT_ROOTS = [process.cwd(), join(homedir(), ".swarm")];
const TELEMETRY_ROOTS = (values["telemetry-root"] ?? DEFAULT_ROOTS).map((r) => resolve(r));
const LEARNED_ROOTS = (values["learned-root"] ?? DEFAULT_ROOTS).map((r) => resolve(r));

// --- Helpers ---

/** Substrate field selection result rows are plain objects; keep the read loose. */
type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Refuse the isolated test stack (42337-42341). Harvesting real history must
 *  never read a throwaway test DB — the inventory doc calls this out explicitly. */
function assertNotTestStack(endpoint: string): void {
  const m = endpoint.match(/:(\d{4,5})(?:\/|$)/);
  const port = m ? Number(m[1]) : null;
  if (port !== null && port >= 42337 && port <= 42341) {
    throw new Error(
      `Refusing to harvest from the isolated test stack at ${endpoint} (port ${port}). ` +
        `Point --endpoint at the live cold sidecar (default :32338).`,
    );
  }
}

/**
 * Recursively collect files whose path ends with the given suffix segments,
 * pruning noisy dirs. Bounded depth keeps a stray large root from melting.
 */
function walkForFiles(
  root: string,
  matchSuffix: (relParts: string[]) => boolean,
  maxDepth = 8,
): string[] {
  const out: string[] = [];
  const prune = new Set([".git", "node_modules", "dist", "build", ".turbo", "coverage"]);
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (prune.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && matchSuffix(full.split(/[/\\]/))) {
        out.push(full);
      }
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out.sort(); // deterministic file order
}

/** A fixture's stable split key: sha256(sessionId + space + prompt) hex. Independent
 *  of harvest order, so the ranking it drives reproduces exactly across runs. */
function splitHash(sessionId: string, prompt: string): string {
  return createHash("sha256").update(`${sessionId} ${prompt}`).digest("hex");
}

/**
 * Deterministic hash-RANK holdout: order fixtures by their stable split hash and
 * assign the smallest-hash `ceil(N * pct/100)` to the test set. Unlike a fixed
 * hash-bucket threshold (which fluctuates around pct and can dip below the floor),
 * this GUARANTEES >= pct% held out while staying fully deterministic and
 * order-independent — the rank is a pure function of the per-fixture hash. The
 * tie-break on (sessionId, prompt) keeps the rare equal-hash case stable too.
 */
function assignSplits(fixtures: Fixture[], pct: number): void {
  const ranked = fixtures
    .map((f) => ({ f, h: splitHash(f.provenance.sessionId, f.prompt) }))
    .sort((a, b) => {
      if (a.h !== b.h) return a.h < b.h ? -1 : 1;
      if (a.f.provenance.sessionId !== b.f.provenance.sessionId)
        return a.f.provenance.sessionId < b.f.provenance.sessionId ? -1 : 1;
      return a.f.prompt < b.f.prompt ? -1 : a.f.prompt > b.f.prompt ? 1 : 0;
    });
  const testCount = Math.ceil((ranked.length * pct) / 100);
  ranked.forEach(({ f }, i) => {
    f.split = i < testCount ? "test" : "train";
  });
}

/** A candidate is only valid if it traces to a real run and carries a full triple. */
function isValid(c: Candidate): boolean {
  return (
    c.prompt.trim().length > 0 &&
    c.expectedIntent.trim().length > 0 &&
    c.expectedContentPaths.length > 0 &&
    (c.provenance.sessionId.length > 0 || (c.provenance.runId?.length ?? 0) > 0)
  );
}

// --- Source 1: Substrate store ---

interface SubstrateHarvest {
  candidates: Candidate[];
  swarmContentPaths: Set<string>;
}

async function harvestSubstrate(endpoint: string): Promise<SubstrateHarvest> {
  const { SubstrateClient } = await import("../packages/substrate/src/index.js");
  const client: SubstrateClientType = new SubstrateClient(endpoint, { namespace: "swarm" });
  if (!(await client.isHealthy())) {
    throw new Error(
      `Substrate sidecar not reachable at ${endpoint}. Start the cold stack ` +
        `(scripts/cold-test-env.sh) or pass --sources telemetry,learned to skip it.`,
    );
  }

  // No limit: Substrate pages a list read (a `limit` over 1000 is refused), and
  // the client follows the cursor to the last page when given no limit or cursor.
  const sessionEvents = await client.query<Row>(
    "SessionEvent",
    {},
    {
      eventId: true,
      sessionId: true,
      role: true,
      intent: true,
      swarmFilesLoaded: true,
      timestamp: true,
    },
  );
  const transcripts = await client.query<Row>(
    "TranscriptEntry",
    {},
    { sessionId: true, role: true, prompt: true, timestamp: true },
  );
  const swarmContent = await client.query<Row>("SwarmContent", {}, { path: true });

  client.close(); // http close() is a safe no-op; keep the contract explicit.

  const swarmContentPaths = new Set(swarmContent.map((r) => str(r, "path")).filter(Boolean));

  // sessionId -> earliest worker prompt (deterministic pick when a session has
  // several worker transcripts).
  const promptBySession = new Map<string, { prompt: string; timestamp: string }>();
  for (const t of transcripts) {
    if (str(t, "role") !== "worker") continue;
    const prompt = str(t, "prompt");
    if (!prompt) continue;
    const sessionId = str(t, "sessionId");
    const ts = str(t, "timestamp");
    const existing = promptBySession.get(sessionId);
    if (!existing || ts < existing.timestamp) promptBySession.set(sessionId, { prompt, timestamp: ts });
  }

  const candidates: Candidate[] = [];
  for (const ev of sessionEvents) {
    if (str(ev, "role") !== "worker") continue;
    const intent = str(ev, "intent");
    const rawFiles = str(ev, "swarmFilesLoaded");
    if (!intent || !rawFiles) continue;
    let paths: string[];
    try {
      const parsed = JSON.parse(rawFiles);
      if (!Array.isArray(parsed)) continue;
      paths = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      continue; // unparseable swarmFilesLoaded -> not traceable, skip
    }
    if (paths.length === 0) continue;
    const sessionId = str(ev, "sessionId");
    const promptRec = promptBySession.get(sessionId);
    if (!promptRec) continue; // no joinable worker prompt -> skip
    candidates.push({
      prompt: promptRec.prompt,
      expectedIntent: intent,
      expectedContentPaths: paths,
      provenance: {
        source: "substrate",
        sessionId,
        eventId: str(ev, "eventId") || undefined,
        timestamp: str(ev, "timestamp") || undefined,
      },
    });
  }
  return { candidates, swarmContentPaths };
}

// --- Source 2: Telemetry JSONL ---

interface SessionAccumulator {
  intent?: string;
  paths?: string[];
  prompt?: string;
  runId?: string;
  timestamp?: string;
  sourceFile?: string;
}

function harvestTelemetry(roots: string[]): Candidate[] {
  const files = new Set<string>();
  for (const root of roots) {
    for (const f of walkForFiles(root, (parts) => {
      const n = parts.length;
      return (
        n >= 3 &&
        parts[n - 1].endsWith(".jsonl") &&
        parts[n - 2] === "events" &&
        parts[n - 3] === "telemetry"
      );
    })) {
      files.add(f);
    }
  }

  // Join three bus-event types per payload.sessionId (doc §Source 1).
  const bySession = new Map<string, SessionAccumulator>();
  const acc = (sessionId: string): SessionAccumulator => {
    let a = bySession.get(sessionId);
    if (!a) {
      a = {};
      bySession.set(sessionId, a);
    }
    return a;
  };

  for (const file of [...files].sort()) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Row;
      try {
        obj = JSON.parse(trimmed) as Row;
      } catch {
        continue;
      }
      if (obj._type !== "bus_event") continue;
      const event = typeof obj.event === "string" ? obj.event : "";
      const payload = (obj.payload ?? {}) as Row;
      const sessionId = str(payload, "sessionId");
      if (!sessionId) continue;
      const runId = typeof obj.runId === "string" ? obj.runId : undefined;

      if (event === "intent:classified") {
        const a = acc(sessionId);
        a.intent = str(payload, "intent");
        a.runId ??= runId;
        a.timestamp ??= typeof obj.timestamp === "string" ? obj.timestamp : undefined;
        a.sourceFile ??= file;
      } else if (event === "context:loaded") {
        const files_ = Array.isArray(payload.files) ? (payload.files as Row[]) : [];
        const a = acc(sessionId);
        a.paths = files_.map((f) => str(f, "path")).filter(Boolean);
        a.runId ??= runId;
        a.sourceFile ??= file;
      } else if (event === "transcript" && str(payload, "role") === "worker") {
        const a = acc(sessionId);
        // first worker transcript wins (files are read in sorted order)
        a.prompt ??= str(payload, "prompt");
        a.runId ??= runId;
        a.sourceFile ??= file;
      }
    }
  }

  const candidates: Candidate[] = [];
  for (const [sessionId, a] of bySession) {
    if (!a.intent || !a.paths || a.paths.length === 0 || !a.prompt) continue;
    candidates.push({
      prompt: a.prompt,
      expectedIntent: a.intent,
      expectedContentPaths: a.paths,
      provenance: {
        source: "telemetry-jsonl",
        sessionId,
        runId: a.runId,
        timestamp: a.timestamp,
        sourceFile: a.sourceFile,
      },
    });
  }
  return candidates;
}

// --- Source 3: learned/runs RunObservation (provenance decoration only) ---

interface RunMeta {
  project?: string;
  swarmVersion?: string;
}

/** Parse run-level metadata keyed by run_id. These files carry NO triple signal
 *  (doc §Source 3) — they only decorate matching JSONL fixtures' provenance. */
function harvestLearnedRuns(roots: string[]): Map<string, RunMeta> {
  const byRunId = new Map<string, RunMeta>();
  const files = new Set<string>();
  for (const root of roots) {
    for (const f of walkForFiles(root, (parts) => {
      const n = parts.length;
      return (
        n >= 3 && parts[n - 1].endsWith(".md") && parts[n - 2] === "runs" && parts[n - 3] === "learned"
      );
    })) {
      files.add(f);
    }
  }
  const field = (block: string, key: string): string | undefined => {
    const m = block.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  for (const file of [...files].sort()) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const block = fm[1];
    const runId = field(block, "run_id");
    if (!runId) continue;
    byRunId.set(runId, {
      project: field(block, "project"),
      swarmVersion: field(block, "swarm_version"),
    });
  }
  return byRunId;
}

// --- Dedup + assemble ---

function dedupeByPrompt(candidates: Candidate[]): Candidate[] {
  // Deterministic order: substrate before telemetry-jsonl, then by sessionId, then by
  // prompt — so the "first wins" dedup result is stable across runs. Substrate wins on
  // a tie because it carries eventId; a colliding JSONL candidate then enriches the
  // surviving record with its runId.
  const sourceRank: Record<Provenance["source"], number> = { substrate: 0, "telemetry-jsonl": 1 };
  const sorted = [...candidates].sort((a, b) => {
    const r = sourceRank[a.provenance.source] - sourceRank[b.provenance.source];
    if (r !== 0) return r;
    if (a.provenance.sessionId !== b.provenance.sessionId)
      return a.provenance.sessionId < b.provenance.sessionId ? -1 : 1;
    return a.prompt < b.prompt ? -1 : a.prompt > b.prompt ? 1 : 0;
  });

  const byPrompt = new Map<string, Candidate>();
  for (const c of sorted) {
    const key = c.prompt.trim();
    const existing = byPrompt.get(key);
    if (!existing) {
      byPrompt.set(key, c);
      continue;
    }
    // Merge provenance: a JSONL duplicate lends its runId/sourceFile to a Substrate
    // record that lacks them (same population, complementary provenance).
    existing.provenance.runId ??= c.provenance.runId;
    existing.provenance.sourceFile ??= c.provenance.sourceFile;
    existing.provenance.timestamp ??= c.provenance.timestamp;
  }
  return [...byPrompt.values()];
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Recall Fixture Harvest ===");
  console.log(`  Sources:        ${[...SOURCES].join(", ")}`);
  console.log(`  Test split:     ${TEST_PERCENT}%`);
  console.log(`  Output:         ${DRY_RUN ? "(dry-run, no write)" : OUT_PATH}`);
  if (LIMIT) console.log(`  Limit:          ${LIMIT}`);
  console.log();

  const candidates: Candidate[] = [];
  let swarmContentPaths = new Set<string>();

  if (SOURCES.has("substrate")) {
    // Resolve the endpoint from the honored config chain (lifecycle.ts), lazily —
    // importing the client package, which JSONL-only runs skip.
    const { resolveSubstrateEndpoint } = await import("../packages/substrate/src/index.js");
    const endpoint = resolveSubstrateEndpoint(values.endpoint);
    console.log(`   Endpoint: ${endpoint}`);
    assertNotTestStack(endpoint);
    console.log("1. Harvesting Substrate store (SessionEvent x TranscriptEntry)...");
    const h = await harvestSubstrate(endpoint);
    candidates.push(...h.candidates);
    swarmContentPaths = h.swarmContentPaths;
    console.log(`   ${h.candidates.length} candidate triples; ${swarmContentPaths.size} SwarmContent paths`);
  }

  if (SOURCES.has("telemetry")) {
    console.log("2. Harvesting telemetry JSONL...");
    const t = harvestTelemetry(TELEMETRY_ROOTS);
    candidates.push(...t);
    console.log(`   ${t.length} candidate triples from ${TELEMETRY_ROOTS.length} root(s)`);
  }

  const runMeta = SOURCES.has("learned") ? harvestLearnedRuns(LEARNED_ROOTS) : new Map<string, RunMeta>();
  if (SOURCES.has("learned")) {
    console.log("3. Reading learned/runs RunObservation provenance...");
    console.log(`   ${runMeta.size} run record(s) (0 triples by design; provenance decoration only)`);
  }

  // Validate (reject untraceable / partial triples) then dedup by prompt.
  const valid = candidates.filter(isValid);
  const rejected = candidates.length - valid.length;
  const deduped = dedupeByPrompt(valid);

  // Decorate provenance from learned runs, validate paths, assign split.
  let fixtures: Fixture[] = deduped.map((c) => {
    const meta = c.provenance.runId ? runMeta.get(c.provenance.runId) : undefined;
    if (meta) {
      c.provenance.project = meta.project;
      c.provenance.swarmVersion = meta.swarmVersion;
    }
    const pathsResolved = swarmContentPaths.size
      ? c.expectedContentPaths.filter((p) => swarmContentPaths.has(p)).length
      : undefined;
    return {
      prompt: c.prompt,
      expectedIntent: c.expectedIntent,
      expectedContentPaths: c.expectedContentPaths,
      split: "train", // reassigned by assignSplits() after limit
      provenance: c.provenance,
      pathsResolved,
    };
  });

  if (STRICT_PATHS && swarmContentPaths.size) {
    const before = fixtures.length;
    fixtures = fixtures.filter((f) => f.pathsResolved === f.expectedContentPaths.length);
    console.log(`   --strict-paths dropped ${before - fixtures.length} fixture(s) with unresolved paths`);
  }

  // Deterministic output order (idempotent across runs).
  fixtures.sort((a, b) => {
    if (a.provenance.sessionId !== b.provenance.sessionId)
      return a.provenance.sessionId < b.provenance.sessionId ? -1 : 1;
    return a.prompt < b.prompt ? -1 : a.prompt > b.prompt ? 1 : 0;
  });

  if (LIMIT && fixtures.length > LIMIT) fixtures = fixtures.slice(0, LIMIT);

  // Assign the deterministic train/test split over the FINAL emitted set so
  // the >= TEST_PERCENT holdout floor holds even when --limit trims the tail.
  assignSplits(fixtures, TEST_PERCENT);

  // Summary stats.
  const byIntent: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let trainCount = 0;
  let testCount = 0;
  for (const f of fixtures) {
    byIntent[f.expectedIntent] = (byIntent[f.expectedIntent] ?? 0) + 1;
    bySource[f.provenance.source] = (bySource[f.provenance.source] ?? 0) + 1;
    if (f.split === "test") testCount++;
    else trainCount++;
  }

  const meta = {
    fixtureCount: fixtures.length,
    trainCount,
    testCount,
    // The split the file holds (assignSplits rounds the test count up, so it
    // can exceed the target), and the floor that was asked for.
    testPercent: fixtures.length > 0 ? Math.round((testCount / fixtures.length) * 100) : 0,
    targetTestPercent: TEST_PERCENT,
    rejected,
    byIntent,
    bySource,
    swarmContentPaths: swarmContentPaths.size,
  };

  console.log();
  console.log("=== Harvest Summary ===");
  console.log(`  Candidates:     ${candidates.length} (rejected ${rejected}, valid ${valid.length})`);
  console.log(`  After dedup:    ${deduped.length}`);
  console.log(`  Fixtures:       ${fixtures.length} (train ${trainCount}, test ${testCount})`);
  console.log(`  By intent:      ${JSON.stringify(byIntent)}`);
  console.log(`  By source:      ${JSON.stringify(bySource)}`);
  if (testCount > 0) {
    console.log(`  Test fraction:  ${meta.testPercent}% (target >= ${TEST_PERCENT}%)`);
  }

  if (DRY_RUN) {
    console.log();
    console.log("=== Dry run — sample (first up to 3 fixtures) ===");
    console.log(JSON.stringify(fixtures.slice(0, 3), null, 2));
    console.log();
    console.log("Dry run: no file written.");
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  await writeOutput(OUT_PATH, meta, fixtures);
  console.log();
  console.log(`Wrote ${fixtures.length} fixtures -> ${OUT_PATH}`);
}

/**
 * Stream the output as pretty-printed JSON, serializing ONE fixture at a time.
 * The full dataset's worker prompts can total well past V8's max string length
 * (~512M chars), so `JSON.stringify(wholeObject)` throws `Invalid string length`.
 * Per-fixture stringify keeps every intermediate string bounded; re-indenting each
 * with a fixed prefix preserves a readable, diff-friendly, byte-deterministic file.
 */
function writeOutput(
  outPath: string,
  meta: Record<string, unknown>,
  fixtures: Fixture[],
): Promise<void> {
  const stream = createWriteStream(outPath, { encoding: "utf-8" });
  const indent = (json: string, pad: string): string => json.replace(/\n/g, `\n${pad}`);
  stream.write("{\n");
  stream.write(`  "meta": ${indent(JSON.stringify(meta, null, 2), "  ")},\n`);
  stream.write(`  "fixtures": [`);
  fixtures.forEach((f, i) => {
    const body = indent(JSON.stringify(f, null, 2), "    ");
    stream.write(`${i === 0 ? "\n" : ",\n"}    ${body}`);
  });
  stream.write(`${fixtures.length ? "\n  " : ""}]\n}\n`);
  return new Promise((resolveWrite, rejectWrite) => {
    stream.on("error", rejectWrite);
    stream.end(resolveWrite);
  });
}

main().catch((err: unknown) => {
  console.error("Harvest failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
