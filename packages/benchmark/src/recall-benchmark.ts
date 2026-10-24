/**
 * RecallBenchmark — measures the REAL quality of swarm's `classifyIntent` +
 * `loadContext` against a labeled fixture set, driving a REAL recall-wired
 * Substrate sidecar end-to-end.
 *
 * Unlike {@link BenchmarkRunner} (which scores behavioral LLM tests against the
 * Anthropic API), this is a distinct, deterministic metric: it spawns a private
 * `substrate serve` on the memory store with Substrate recall wired to an
 * Ollama embedder, seeds the swarm corpus, then for every fixture classifies
 * the prompt and assembles context, recording the classified intent, the loaded
 * content paths, and the classify latency. Precision/recall/F1 are computed —
 * separately for the train and test splits — by delegating to `recall-metrics.ts`
 * (this file never reimplements the scoring math). The `similarityThreshold`
 * knob is seeded as the `recall_similarity_threshold` SwarmConfig row (category
 * `recall`), the same row the swarm plugin reads on every request in
 * production, so the tuning task can sweep it.
 *
 * E2E-gated by convention: callers run it only under `SWARM_SDK_E2E=1` and skip
 * cleanly when Ollama is unavailable — see {@link RecallBenchmark.isOllamaAvailable}.
 *
 * The sidecar boots through the test setup's `startTestSubstrate()`
 * (`tests/setup/isolated-substrate.ts`, loaded from the repo root at run time):
 * the same spawned sidecar the E2E suites use, on an ephemeral loopback port,
 * stopped in a `finally` so no process is left orphaned (per the cleanup rules
 * in `modes/orchestration.md` / `core/rules.md`). It therefore runs only from a
 * workspace checkout, never from an installed package.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  findRepoRoot,
  RECALL_CONFIG_CATEGORY,
  RECALL_SIMILARITY_THRESHOLD_KEY,
  RECALL_TOP_K,
  resolveEmbedderSettings,
  SubstrateClient,
} from "@mnmal-ai/swarm-substrate";

import {
  type ContentPathMetrics,
  type IntentMetrics,
  type LatencyPercentiles,
  latencyPercentiles,
  type RecallObservation,
  scoreContentPaths,
  scoreIntents,
} from "./recall-metrics.js";

// ---------------------------------------------------------------------------
// Embedder defaults: the same SWARM_EMBEDDER_* resolution production sidecars
// use (resolveEmbedderSettings), so the benchmark embeds with the model and
// dimension production seeds with.
// ---------------------------------------------------------------------------

/** Probe timeout for the liveness check — bounded so a wedged-but-reachable
 *  Ollama can't stall the gate. "Latency is a feature." */
const PROBE_TIMEOUT_MS = 15_000;

const SWARM_NAMESPACE = "swarm";

/** Default fixture set: the artifact harvested by `scripts/harvest-recall-fixtures.ts`. */
const DEFAULT_FIXTURES_RELPATH = "tests/fixtures/recall-fixtures.json";

/** Default holdout fraction used ONLY when a fixture carries no `split` field. */
const DEFAULT_TEST_EVERY_N = 5; // every 5th fixture -> test == 20% holdout floor

// ---------------------------------------------------------------------------
// Corpus seeding (tier mapping mirrors packages/cli/src/cli/seed.ts). A trimmed
// copy lives here ON PURPOSE: @mnmal-ai/swarm-cli depends on @mnmal-ai/swarm-
// benchmark, so importing the CLI seeder would close a package dependency cycle.
// ---------------------------------------------------------------------------

const TIER_MAP: Record<string, string> = {
  core: "core",
  modes: "mode",
  capabilities: "capabilities",
  domains: "domain",
  oversight: "oversight",
  skills: "skills_vetted",
};

const EXCLUDED_FILES = new Set([
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
  "package-lock.json",
  ".swarm-meta.json",
  "config.json",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One labeled fixture, as emitted by the harvest script. */
export interface RecallFixture {
  prompt: string;
  expectedIntent: string;
  expectedContentPaths: string[];
  /** Stable train/test assignment from the harvest; respected when present. */
  split?: "train" | "test";
  provenance?: unknown;
  pathsResolved?: number;
}

/** The on-disk `recall-fixtures.json` shape (a `meta` block + the fixtures). */
export interface RecallFixtureFile {
  meta?: Record<string, unknown>;
  fixtures: RecallFixture[];
}

export interface RecallBenchmarkOptions {
  /** Pre-parsed fixtures (for testability). Takes precedence over `fixturesPath`. */
  fixtures?: RecallFixtureFile | RecallFixture[];
  /** Path to the labeled fixtures JSON. Defaults to repo-root `tests/fixtures/recall-fixtures.json`. */
  fixturesPath?: string;
  /**
   * Path to the swarm content directory (with `swarm.json` + tier dirs) to seed
   * into the sidecar. Defaults to `process.env.SWARM_PATH`. Required for {@link
   * RecallBenchmark.run}; classify/load have nothing to resolve against an empty
   * corpus.
   */
  swarmPath?: string;
  /**
   * Project scope substituted into `{project}` route paths: the name of the
   * corpus's `domains/<project>/` directory. Defaults to "default".
   */
  projectId?: string;
  /** Model id used to resolve the token budget in `loadContext`. */
  modelId?: string;
  /** Ollama base URL. Defaults to `SWARM_EMBEDDER_OLLAMA_URL` then http://127.0.0.1:11434. */
  ollamaBaseUrl?: string;
  /** Ollama model. Defaults to `SWARM_EMBEDDER_MODEL` then nomic-embed-text. */
  ollamaModel?: string;
}

export interface RecallRunOptions {
  /**
   * Cosine-similarity cutoff (0..1), seeded as the `recall_similarity_threshold`
   * SwarmConfig row the swarm plugin reads per request. Undefined -> 0 (no
   * cutoff), byte-identical to the unfiltered path.
   */
  similarityThreshold?: number;
  /**
   * Max nearest-neighbor hits per recall. The swarm plugin recalls a fixed
   * `RECALL_TOP_K` (8); any other value is refused rather than silently ignored.
   */
  topK?: number;
}

/** Per-split scores: per-intent + aggregate, computed by `recall-metrics.ts`. */
export interface RecallSplitMetrics {
  count: number;
  /** Intent scoring: `perIntent` one-vs-rest, `micro` aggregate, `macroF1`. */
  intent: IntentMetrics;
  /** Content-path set-overlap scoring, pooled across the split's fixtures. */
  contentPaths: ContentPathMetrics;
}

/** One fixture's observed behaviour, retained for debugging a run. */
export interface RecallFixtureObservation extends RecallObservation {
  /** Truncated prompt — enough to identify the fixture without bloating output. */
  prompt: string;
  split: "train" | "test";
  /** classifyIntent confidence tier (`exact|keyword|semantic|fallback`). */
  confidence: string;
  /** Wall-clock latency of the classifyIntent round trip, in milliseconds. */
  classifyMs: number;
}

export interface RecallBenchmarkResult {
  /** The cutoff this run used — echoed so a sweep can label its rows. */
  similarityThreshold: number;
  topK: number;
  fixtureCount: number;
  /** Train and test metrics, computed SEPARATELY (no leakage between splits). */
  splits: { train: RecallSplitMetrics; test: RecallSplitMetrics };
  /** Classify-latency percentiles over ALL fixtures (the operational SLO view). */
  latency: LatencyPercentiles;
  /** Convenience alias for `latency.p99` — the latency-budget guardrail number. */
  p99ClassifyMs: number;
  /** Per-fixture observations (both splits) for debugging a regression. */
  observations: RecallFixtureObservation[];
}

// ---------------------------------------------------------------------------
// Internal sidecar handle
// ---------------------------------------------------------------------------

interface RecallSidecar {
  url: string;
  /** Stop the server; idempotent and never rejects. */
  stop: () => Promise<void>;
}

const PROMPT_DEBUG_MAX = 120;

// ---------------------------------------------------------------------------
// RecallBenchmark
// ---------------------------------------------------------------------------

export class RecallBenchmark {
  private readonly fixturesPath: string;
  private readonly preParsed?: RecallFixture[];
  private readonly swarmPath?: string;
  private readonly projectId: string;
  private readonly modelId: string;
  private readonly ollamaBaseUrl: string;
  private readonly ollamaModel: string;
  private readonly embedderDimension: number;
  private cachedFixtures?: RecallFixture[];

  constructor(options: RecallBenchmarkOptions = {}) {
    this.preParsed = options.fixtures
      ? Array.isArray(options.fixtures)
        ? options.fixtures
        : options.fixtures.fixtures
      : undefined;
    this.fixturesPath =
      options.fixturesPath ?? join(findRepoRoot(), DEFAULT_FIXTURES_RELPATH);
    this.swarmPath = options.swarmPath ?? process.env.SWARM_PATH;
    this.projectId = options.projectId ?? "default";
    this.modelId = options.modelId ?? "claude-opus-4-6";
    const embedder = embedderSettings(options);
    this.ollamaBaseUrl = embedder.baseUrl;
    this.ollamaModel = embedder.model;
    this.embedderDimension = embedder.dimension;
  }

  /**
   * One-shot Ollama liveness probe — a tiny embed (`POST /api/embed`) on a
   * short timeout. Callers gate the E2E run on this and skip cleanly when it
   * returns false (Ollama not running, model not pulled, or wedged).
   */
  static async isOllamaAvailable(
    opts: { baseUrl?: string; model?: string } = {},
  ): Promise<boolean> {
    const { baseUrl, model } = embedderSettings({ ollamaBaseUrl: opts.baseUrl, ollamaModel: opts.model });
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "ping" }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { embeddings?: unknown[] };
      return Array.isArray(body.embeddings) && body.embeddings.length > 0;
    } catch {
      return false;
    }
  }

  /** Load (and cache) the labeled fixtures from the injected array or disk. */
  async loadFixtures(): Promise<RecallFixture[]> {
    if (this.cachedFixtures) return this.cachedFixtures;
    if (this.preParsed) {
      this.cachedFixtures = this.preParsed;
      return this.cachedFixtures;
    }
    const raw = await readFile(this.fixturesPath, "utf-8");
    const parsed = JSON.parse(raw) as RecallFixtureFile;
    if (!Array.isArray(parsed.fixtures)) {
      throw new Error(`recall fixtures at ${this.fixturesPath} have no "fixtures" array`);
    }
    this.cachedFixtures = parsed.fixtures;
    return this.cachedFixtures;
  }

  /**
   * Boot a recall-wired sidecar, seed the corpus, run every fixture through
   * classifyIntent + loadContext, and return the per-split metrics. Always tears
   * the sidecar down (no orphaned server/socket) even on failure.
   *
   * @throws if Ollama is unavailable, or if no swarm corpus path is configured —
   *   both are caller-skippable preconditions for a meaningful recall run.
   */
  async run(options: RecallRunOptions = {}): Promise<RecallBenchmarkResult> {
    const similarityThreshold = options.similarityThreshold ?? 0;
    const topK = options.topK ?? RECALL_TOP_K;
    if (topK !== RECALL_TOP_K) {
      throw new Error(
        `RecallBenchmark.run: topK ${topK} is not tunable on a Substrate sidecar; the swarm plugin recalls RECALL_TOP_K (${RECALL_TOP_K}) hits.`,
      );
    }

    if (!this.swarmPath) {
      throw new Error(
        "RecallBenchmark.run requires a swarm corpus path (constructor `swarmPath` or env SWARM_PATH).",
      );
    }
    if (!(await RecallBenchmark.isOllamaAvailable({ baseUrl: this.ollamaBaseUrl, model: this.ollamaModel }))) {
      throw new Error(
        `Ollama unavailable at ${this.ollamaBaseUrl} (model ${this.ollamaModel}); ` +
          "cannot run the recall benchmark. Skip this run.",
      );
    }

    const fixtures = await this.loadFixtures();

    const sidecar = await this.bootSidecar();
    const client = new SubstrateClient(sidecar.url, { namespace: SWARM_NAMESPACE });

    try {
      await this.seedCorpus(client, this.swarmPath, similarityThreshold);

      const observations: RecallFixtureObservation[] = [];
      const latencies: number[] = [];

      for (let i = 0; i < fixtures.length; i++) {
        const fixture = fixtures[i]!;
        const split = fixture.split ?? (i % DEFAULT_TEST_EVERY_N === 0 ? "test" : "train");

        const startedAt = performance.now();
        const classified = await client.classifyIntent({
          prompt: fixture.prompt,
          projectId: this.projectId,
        });
        const classifyMs = performance.now() - startedAt;
        latencies.push(classifyMs);

        // Drive the REAL pipeline: assemble context for the CLASSIFIED intent
        // (not the ground-truth one), so content-path scoring reflects the
        // end-to-end classify -> load quality the goal asks us to measure.
        const loaded = await client.loadContext({
          intent: classified.intent,
          projectId: this.projectId,
          modelId: this.modelId,
          prompt: fixture.prompt,
        });

        observations.push({
          prompt: fixture.prompt.slice(0, PROMPT_DEBUG_MAX),
          split,
          expectedIntent: fixture.expectedIntent,
          classifiedIntent: classified.intent,
          confidence: classified.confidence,
          expectedContentPaths: fixture.expectedContentPaths,
          loadedPaths: loaded.filesIncluded.map((f) => f.path),
          classifyMs,
        });
      }

      return this.computeResult(observations, latencies, similarityThreshold, topK);
    } finally {
      // Cleanup discipline (core/rules.md): never leave the sidecar process
      // running — the client and the spawned sidecar are torn down
      // unconditionally here.
      client.close();
      await sidecar.stop();
    }
  }

  /**
   * Assemble the structured result from raw observations: partition by split,
   * delegate per-split scoring to `recall-metrics.ts`, and derive the classify
   * p99. Pure (no I/O) so it is unit-testable without a sidecar.
   */
  computeResult(
    observations: RecallFixtureObservation[],
    latencies: number[],
    similarityThreshold: number,
    topK: number,
  ): RecallBenchmarkResult {
    const train = observations.filter((o) => o.split === "train");
    const test = observations.filter((o) => o.split === "test");
    const latency = latencyPercentiles(latencies);
    return {
      similarityThreshold,
      topK,
      fixtureCount: observations.length,
      splits: {
        train: this.scoreSplit(train),
        test: this.scoreSplit(test),
      },
      latency,
      p99ClassifyMs: latency.p99,
      observations,
    };
  }

  /** Score one split's observations via the shared metric functions. */
  private scoreSplit(observations: RecallObservation[]): RecallSplitMetrics {
    return {
      count: observations.length,
      intent: scoreIntents(observations),
      contentPaths: scoreContentPaths(observations),
    };
  }

  // -------------------------------------------------------------------------
  // Sidecar boot (the test setup's spawned sidecar, memory store + Ollama recall)
  // -------------------------------------------------------------------------

  private async bootSidecar(): Promise<RecallSidecar> {
    const helper = await loadTestSubstrateHelper();
    const substrate = await helper.startTestSubstrate({
      recall: { baseUrl: this.ollamaBaseUrl, model: this.ollamaModel, dimension: this.embedderDimension },
      meta: false,
      cortext: false,
    });
    return {
      url: substrate.cold.url,
      stop: () => substrate.stop().catch(() => {}),
    };
  }

  // -------------------------------------------------------------------------
  // Corpus seeding (SwarmConfig + SwarmContent + SwarmRoute)
  // -------------------------------------------------------------------------

  /**
   * Seed the swarm corpus into the sidecar so classify/load have routes,
   * budget, recall tuning and content to resolve against. Writing each
   * SwarmContent row fires Substrate recall's embed-on-write hook.
   */
  private async seedCorpus(client: SubstrateClient, swarmDir: string, similarityThreshold: number): Promise<void> {
    const swarmJsonPath = join(swarmDir, "swarm.json");
    if (!existsSync(swarmJsonPath)) {
      throw new Error(`No swarm.json at ${swarmJsonPath} — cannot seed the recall benchmark corpus.`);
    }
    const swarmJson = JSON.parse(await readFile(swarmJsonPath, "utf-8")) as {
      context_budget?: { default_max_tokens?: number; model_overrides?: Record<string, number> };
      routes?: Array<{
        intent: string;
        description?: string;
        keywords?: string[];
        load?: Record<string, string[]>;
      }>;
    };

    await this.seedConfigs(client, swarmJson.context_budget, similarityThreshold);
    await this.seedContent(client, swarmDir);
    await this.seedRoutes(client, swarmJson.routes ?? []);
  }

  private async seedConfigs(
    client: SubstrateClient,
    budget: { default_max_tokens?: number; model_overrides?: Record<string, number> } | undefined,
    similarityThreshold: number,
  ): Promise<void> {
    const configs: Record<string, unknown>[] = [
      // The recall cutoff for this run: the swarm plugin reads this row per request.
      { key: RECALL_SIMILARITY_THRESHOLD_KEY, value: String(similarityThreshold), category: RECALL_CONFIG_CATEGORY },
    ];
    if (budget?.default_max_tokens !== undefined) {
      configs.push({ key: "default_max_tokens", value: String(budget.default_max_tokens), category: "budget" });
    }
    for (const [model, tokens] of Object.entries(budget?.model_overrides ?? {})) {
      configs.push({ key: `model_override:${model}`, value: String(tokens), category: "budget" });
    }
    if (configs.length > 0) await client.ingest("SwarmConfig", configs, "extend");
  }

  private async seedContent(client: SubstrateClient, swarmDir: string): Promise<void> {
    const entities: Record<string, unknown>[] = [];
    const topLevel = await readdir(swarmDir, { withFileTypes: true });
    for (const entry of topLevel) {
      if (!entry.isDirectory() || !(entry.name in TIER_MAP)) continue;
      for (const filePath of await walkDir(join(swarmDir, entry.name))) {
        if (!filePath.endsWith(".md") && !filePath.endsWith(".json")) continue;
        if (EXCLUDED_FILES.has(basename(filePath))) continue;
        const relPath = relative(swarmDir, filePath).replace(/\\/g, "/");
        const tier = TIER_MAP[relPath.split("/")[0]];
        if (!tier) continue;
        const content = await readFile(filePath, "utf-8");
        entities.push({
          path: relPath,
          tier,
          intent: "all",
          content,
          // A number: Substrate's field.number() refuses a string.
          tokenEstimate: Math.ceil(content.length / 4),
          lastReviewed: new Date().toISOString(),
          projectId: relPath.startsWith("domains/") ? this.projectId : "global",
        });
      }
    }
    if (entities.length > 0) await client.ingest("SwarmContent", entities, "extend");
  }

  private async seedRoutes(
    client: SubstrateClient,
    routes: Array<{ intent: string; description?: string; keywords?: string[]; load?: Record<string, string[]> }>,
  ): Promise<void> {
    const entities: Record<string, unknown>[] = [];
    for (const route of routes) {
      const contentPaths: string[] = [];
      for (const paths of Object.values(route.load ?? {})) {
        if (Array.isArray(paths)) contentPaths.push(...paths);
      }
      entities.push({
        intent: route.intent,
        description: route.description ?? "",
        keywords: JSON.stringify(route.keywords ?? []),
        contentPaths: JSON.stringify(contentPaths),
      });
    }
    if (entities.length > 0) await client.ingest("SwarmRoute", entities, "extend");
  }
}

// ---------------------------------------------------------------------------
// File walking (local; mirrors the CLI seeder's recursive walk)
// ---------------------------------------------------------------------------

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      results.push(...(await walkDir(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Embedder settings and the test-sidecar helper
// ---------------------------------------------------------------------------

/** The Ollama embedder this benchmark recalls with: explicit options, else SWARM_EMBEDDER_*. */
function embedderSettings(options: { ollamaBaseUrl?: string; ollamaModel?: string }): {
  baseUrl: string;
  model: string;
  dimension: number;
} {
  const settings = resolveEmbedderSettings({
    ...process.env,
    ...(options.ollamaBaseUrl !== undefined ? { SWARM_EMBEDDER_OLLAMA_URL: options.ollamaBaseUrl } : {}),
    ...(options.ollamaModel !== undefined ? { SWARM_EMBEDDER_MODEL: options.ollamaModel } : {}),
  });
  return { baseUrl: settings.baseUrl, model: settings.model, dimension: settings.dimension };
}

/** The slice of `tests/setup/isolated-substrate.ts` this benchmark drives. */
interface TestSubstrateHelper {
  startTestSubstrate(opts: {
    recall: { baseUrl: string; model: string; dimension: number };
    meta: boolean;
    cortext: boolean;
  }): Promise<{ cold: { url: string }; stop(): Promise<void> }>;
}

/**
 * Load the test setup's sidecar helper from the repo root. It is a test-only
 * module, so it is imported by path at run time rather than packaged.
 */
async function loadTestSubstrateHelper(): Promise<TestSubstrateHelper> {
  const path = join(findRepoRoot(), "tests", "setup", "isolated-substrate.ts");
  if (!existsSync(path)) {
    throw new Error(`RecallBenchmark.run needs the workspace's test sidecar helper at ${path}; run it from a swarm checkout.`);
  }
  return (await import(pathToFileURL(path).href)) as TestSubstrateHelper;
}
