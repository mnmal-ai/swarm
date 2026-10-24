/**
 * recall-quality — proves the `SwarmConfig.recall.similarityThreshold` knob has
 * an END-TO-END effect on semantic recall: raising the knob drops low-score
 * hits that a lower knob admits, changing the set of files `loadContext`
 * surfaces and the intent `classifyIntent` recovers.
 *
 * This is the acceptance test for goal-12 task 2 (the threshold knob). The
 * swarm Substrate plugin reads the knob row on every request
 * (`readSimilarityThreshold`); this suite proves the stored value changes
 * recall RESULTS through a live sidecar — the part a unit test over the
 * resolver in isolation cannot show.
 *
 * E2E-gated: runs only under `SWARM_SDK_E2E=1`. It spawns its OWN sidecar
 * through the test setup's `startTestSubstrate()` (memory store, Substrate
 * recall wired to local Ollama `nomic-embed-text`), so its corpus is the only
 * one in the store. Without Ollama it skips: recall suites need Ollama.
 *
 * ----------------------------------------------------------------------------
 *   1. Each SwarmContent row is embedded as it is written (Substrate recall's
 *      write hook, awaited inside the create), so a vector exists once
 *      `createSwarmContent` resolves — no polling.
 *
 *   2. The KNOB → behaviour chain:
 *        SwarmConfig{category:'recall', key:'recall_similarity_threshold'}.value
 *          → read per request by the plugin (`coerceSimilarityThreshold`)
 *          → `threshold` on its `recall/Hit` search
 *          → hits scoring below the cutoff are dropped before they can augment
 *            loadContext's file set or vote in classifyIntent.
 *      The corpus is written once; between the three phases ONLY the stored
 *      knob row changes (updateSwarmConfig).
 *
 *   3. Thresholds are derived from the REAL observed cosine scores (a direct
 *      `recall/Hit` probe at threshold 0), not guessed: LOW=0 admits
 *      everything, MID sits between the weak and strong hit (drops the weak
 *      one), HIGH sits above every hit (drops all semantic augmentation).
 * ----------------------------------------------------------------------------
 */

import {
  coerceSimilarityThreshold,
  RECALL_CONFIG_CATEGORY,
  RECALL_SIMILARITY_THRESHOLD_KEY,
  SubstrateClient,
} from "@mnmal-ai/swarm-substrate";
import { afterAll, describe, expect, it } from "vitest";
import { probeOllama, RECALL_SKIP_REASON, startTestSubstrate, stopTestSubstrate } from "../setup/isolated-substrate.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";
const HAVE_OLLAMA = RUN_E2E && process.env.SWARM_TEST_RECALL !== "none" && (await probeOllama());

const SWARM_NAMESPACE = "swarm";
const PROJECT_ID = "recall-quality-test";
const MODEL_ID = "claude-sonnet-4-6";
const TARGET_INTENT = "deployment";

// A keyword guaranteed NOT to appear in the prompt, so classifyIntent's keyword
// leg always misses and falls through to the semantic-recall leg (the leg the
// knob gates). If the keyword matched, classification would short-circuit before
// recall ever ran.
const UNMATCHABLE_KEYWORD = "xyzzy-deploy-token";

// The task prompt. Contains none of the route's keyword, so classify is forced
// onto semantic recall; it is a near-paraphrase of STRONG and only loosely
// related to WEAK.
const PROMPT =
  "How do I ship and release my backend server application to the production cloud so users can reach it live?";

// Path-selected baseline file (named in the route's contentPaths): always loaded
// via the path leg regardless of the knob, so HIGH still returns a valid,
// non-empty context rather than nothing.
const BASE_PATH = "capabilities/deploy-base.md";
// Strongly similar to PROMPT, NOT in contentPaths — only semantic recall can
// surface it. Survives MID, dropped by HIGH.
const STRONG_PATH = "capabilities/deploy-release-runbook.md";
// Loosely related to PROMPT, NOT in contentPaths. Admitted by LOW, dropped by
// both MID and HIGH (it is the lowest-scoring hit).
const WEAK_PATH = "capabilities/deploy-monitoring-notes.md";

interface SeedContentRow {
  path: string;
  content: string;
}

// Non-skill tier ("capabilities") so the loader's intent filter passes them
// through unconditionally; all carry TARGET_INTENT so they also vote for it in
// classifyIntent's semantic leg.
const CONTENT_ROWS: SeedContentRow[] = [
  { path: BASE_PATH, content: "Baseline deployment runbook for the backend service." },
  {
    path: STRONG_PATH,
    content:
      "Releasing the backend server to production: how to publish and roll out the application to the cloud so end users can reach it live.",
  },
  {
    path: WEAK_PATH,
    content:
      "Notes on watching server CPU and memory usage dashboards and alert thresholds after a release has settled.",
  },
];

afterAll(async () => {
  // Every pair this file started, including one still booting after a timeout.
  await stopTestSubstrate();
});

/**
 * Seed the route + the three content rows through the client, so Substrate
 * recall embeds each SwarmContent as it is written.
 */
async function seedCorpus(client: SubstrateClient): Promise<void> {
  await client.mutate(
    "createSwarmRoute",
    {
      intent: TARGET_INTENT,
      description: "Deploying and releasing the backend service",
      keywords: JSON.stringify([UNMATCHABLE_KEYWORD]),
      contentPaths: JSON.stringify([BASE_PATH]),
    },
    { id: true },
  );

  for (const row of CONTENT_ROWS) {
    await client.mutate(
      "createSwarmContent",
      {
        path: row.path,
        tier: "capabilities",
        intent: TARGET_INTENT,
        content: row.content,
        tokenEstimate: 12,
        lastReviewed: "2026-06-02",
        projectId: PROJECT_ID,
      },
      { id: true },
    );
  }
}

/** Store `value` as the recall threshold knob (creating the row the first time). */
async function setKnob(client: SubstrateClient, value: number, id?: string): Promise<string> {
  if (id === undefined) {
    const row = await client.mutate<{ id: string }>(
      "createSwarmConfig",
      { key: RECALL_SIMILARITY_THRESHOLD_KEY, value: String(value), category: RECALL_CONFIG_CATEGORY },
      { id: true },
    );
    return row.id;
  }
  await client.mutate("updateSwarmConfig", { id, value: String(value) }, { id: true });
  return id;
}

/** The knob as the plugin reads it back from storage. */
async function readKnob(client: SubstrateClient): Promise<number | undefined> {
  const rows = await client.query<{ key: string; value: string }>(
    "SwarmConfig",
    { where: { category: { eq: RECALL_CONFIG_CATEGORY } } },
    { key: true, value: true },
  );
  const row = rows.find((r) => r.key === RECALL_SIMILARITY_THRESHOLD_KEY);
  return row === undefined ? undefined : coerceSimilarityThreshold(row.value);
}

/** The set of file paths loadContext surfaced for PROMPT. */
async function loadedPaths(client: SubstrateClient): Promise<Set<string>> {
  const res = await client.loadContext({
    intent: TARGET_INTENT,
    projectId: PROJECT_ID,
    modelId: MODEL_ID,
    prompt: PROMPT,
  });
  return new Set(res.filesIncluded.map((f) => f.path));
}

describe.skipIf(!HAVE_OLLAMA)(`recall-quality: similarityThreshold knob (real Substrate sidecar + embedder; ${RECALL_SKIP_REASON})`, () => {
  it(
    "raising the SwarmConfig knob drops low-score hits the lower knob admits (loadContext + classifyIntent)",
    async () => {
      const substrate = await startTestSubstrate({ meta: false, cortext: false, recall: "auto" });
      expect(substrate.recall).toBe("ollama");
      const client = new SubstrateClient(substrate.cold.url);
      const recall = new SubstrateClient(substrate.cold.url, { namespace: "recall" });

      // --- LOW knob (threshold 0). Seed once and observe REAL scores ----------
      const knobId = await setKnob(client, 0);
      expect(await readKnob(client)).toBe(0); // knob round-tripped through storage
      await seedCorpus(client);

      // Direct recall probe (bypasses the swarm resolvers) for the raw cosine
      // scores the thresholds derive from: the same `recall/Hit` frame the
      // plugin searches with.
      const hits = await recall.query<{ score: number; row: { path?: string } }>(
        "Hit",
        { to: PROMPT, namespace: SWARM_NAMESPACE, type: "SwarmContent", k: 20, boost: false, lexical: false, threshold: 0 },
        { id: true, score: true, row: { path: true } },
      );
      const scoreOf = (path: string): number => {
        const hit = hits.find((h) => h.row?.path === path);
        if (hit === undefined) {
          throw new Error(`probe: no recall hit for ${path} — embed-on-write did not fire`);
        }
        return hit.score;
      };
      const strongScore = scoreOf(STRONG_PATH);
      const weakScore = scoreOf(WEAK_PATH);
      const maxScore = Math.max(...hits.map((h) => h.score));

      // Content-design invariants the threshold derivation depends on.
      expect(weakScore).toBeGreaterThan(0);
      expect(strongScore).toBeGreaterThan(weakScore);

      // MID strictly between the two hits → admits STRONG, drops WEAK.
      // HIGH strictly above every hit (clamped to the cosine cap of 1).
      const MID = (weakScore + strongScore) / 2;
      const HIGH = Math.min((maxScore + 1.0001) / 2, 1);

      // LOW behaviour: both semantic files augment the path-selected base, and
      // semantic classification recovers the intent the keyword leg missed.
      const lowPaths = await loadedPaths(client);
      expect(lowPaths).toEqual(new Set([BASE_PATH, STRONG_PATH, WEAK_PATH]));

      const lowClassify = await client.classifyIntent({ prompt: PROMPT, projectId: PROJECT_ID });
      expect(lowClassify.confidence).toBe("semantic");
      expect(lowClassify.intent).toBe(TARGET_INTENT);

      // --- MID knob: drops the weak hit, keeps the strong one -----------------
      await setKnob(client, MID, knobId);
      expect(await readKnob(client)).toBeCloseTo(MID, 10);
      const midPaths = await loadedPaths(client);
      expect(midPaths).toEqual(new Set([BASE_PATH, STRONG_PATH]));
      expect(midPaths.has(WEAK_PATH)).toBe(false);

      // --- HIGH knob: drops ALL semantic hits → path-selected base only -------
      await setKnob(client, HIGH, knobId);
      expect(await readKnob(client)).toBeCloseTo(HIGH, 10);
      const highPaths = await loadedPaths(client);
      expect(highPaths).toEqual(new Set([BASE_PATH]));

      // With every SwarmContent vector below the cutoff, the semantic leg has no
      // vote left and classification falls back to the static fallback intent.
      const highClassify = await client.classifyIntent({ prompt: PROMPT, projectId: PROJECT_ID });
      expect(highClassify.confidence).toBe("fallback");
      expect(highClassify.intent).toBe("fallback");

      // --- The acceptance assertion: the recalled set strictly SHRINKS as the
      //     knob rises. Same corpus, same prompt — only the stored knob differs.
      expect(lowPaths.size).toBeGreaterThan(midPaths.size);
      expect(midPaths.size).toBeGreaterThan(highPaths.size);
      expect([...midPaths].every((p) => lowPaths.has(p))).toBe(true);
      expect([...highPaths].every((p) => midPaths.has(p))).toBe(true);
    },
    120_000,
  );
});
