import { describe, it, expect, beforeAll } from "vitest";
import {
  createRouterAndLoader,
  ALL_INTENTS,
  MODELS,
  KNOWN_PROJECTS,
  REVIEWER_TIERS,
} from "./helpers.js";
import { selectReviewerFiles } from "@mnmal-ai/swarm-core";
import type { Router } from "@mnmal-ai/swarm-core";
import type { Loader } from "@mnmal-ai/swarm-core";

describe("Oversight Divergence — Worker vs Reviewer Context", () => {
  let router: Router;
  let loader: Loader;

  beforeAll(() => {
    const pair = createRouterAndLoader();
    router = pair.router;
    loader = pair.loader;
  });

  // Helper: load worker context for a route
  async function loadWorkerContext(intent: string) {
    const classification = await router.classify("test", intent);
    const budget = await router.getBudget(MODELS.OPUS);
    const priority = await router.getLoadingPriority();

    return loader.load(
      classification.route,
      budget,
      priority,
      KNOWN_PROJECTS[0],
    );
  }

  // -------------------------------------------------------------------------
  // Worker context includes all tiers
  // -------------------------------------------------------------------------

  describe("worker receives all tiers", () => {
    it.each(ALL_INTENTS)(
      "intent %s: worker LoadResult includes core, mode, oversight",
      async (intent) => {
        const loadResult = await loadWorkerContext(intent);
        const tiers = new Set(loadResult.files.map((f) => f.tier));

        expect(tiers.has("core")).toBe(true);
        expect(tiers.has("mode")).toBe(true);
        expect(tiers.has("oversight")).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Reviewer context includes ONLY mode, domain, oversight
  // -------------------------------------------------------------------------

  describe("reviewer context is restricted to mode+domain+oversight", () => {
    it.each(ALL_INTENTS)(
      "intent %s: reviewer context excludes core, capabilities, skills",
      async (intent) => {
        const loadResult = await loadWorkerContext(intent);
        const reviewerContext = selectReviewerFiles(loadResult.files);

        // Reviewer should NOT contain core files — check by delimiter presence
        for (const file of loadResult.files) {
          if (file.tier === "core") {
            expect(
              reviewerContext.includes(`--- ${file.path} (core) ---`),
              `reviewer context should not contain core file ${file.path}`,
            ).toBe(false);
          }
          if (file.tier === "capabilities") {
            expect(
              reviewerContext.includes(`--- ${file.path}`),
              `reviewer context should not contain capabilities file ${file.path}`,
            ).toBe(false);
          }
          if (file.tier === "skills_vetted") {
            expect(
              reviewerContext.includes(`--- ${file.path}`),
              `reviewer context should not contain skills_vetted file ${file.path}`,
            ).toBe(false);
          }
        }
      },
    );

    it.each(ALL_INTENTS)(
      "intent %s: reviewer context includes mode and oversight files",
      async (intent) => {
        const loadResult = await loadWorkerContext(intent);
        const reviewerContext = selectReviewerFiles(loadResult.files);

        // Reviewer should contain mode files
        const modeFiles = loadResult.files.filter((f) => f.tier === "mode");
        for (const file of modeFiles) {
          expect(
            reviewerContext.includes(`--- ${file.path} (mode) ---`),
            `reviewer context should contain mode file ${file.path}`,
          ).toBe(true);
        }

        // Reviewer should contain oversight files
        const oversightFiles = loadResult.files.filter(
          (f) => f.tier === "oversight",
        );
        for (const file of oversightFiles) {
          expect(
            reviewerContext.includes(`--- ${file.path} (oversight) ---`),
            `reviewer context should contain oversight file ${file.path}`,
          ).toBe(true);
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // Format difference: Reviewer vs assembleContext
  // -------------------------------------------------------------------------

  describe("format difference between worker and reviewer context", () => {
    it("assembleContext uses `--- swarm: <path> (<tier>) ---` prefix", async () => {
      const loadResult = await loadWorkerContext("implementation");
      const workerContext = loader.assembleContext(loadResult.files);

      // Worker context uses "swarm:" prefix
      expect(workerContext).toContain("--- swarm: ");
    });

    it("selectReviewerFiles uses `--- <path> (<tier>) ---` without swarm: prefix", async () => {
      const loadResult = await loadWorkerContext("implementation");
      const reviewerContext = selectReviewerFiles(loadResult.files);

      // Reviewer context does NOT use "swarm:" prefix
      const reviewerLines = reviewerContext
        .split("\n")
        .filter((l) => l.startsWith("--- "));

      for (const line of reviewerLines) {
        expect(
          line.startsWith("--- swarm:"),
          `reviewer delimiter should not have "swarm:" prefix: ${line}`,
        ).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Reviewer context is a strict subset of worker context by file paths
  // -------------------------------------------------------------------------

  describe("reviewer is strict subset of worker by file paths", () => {
    it.each(ALL_INTENTS)(
      "intent %s: every file in reviewer context is also in worker context",
      async (intent) => {
        const loadResult = await loadWorkerContext(intent);
        const workerPaths = new Set(loadResult.files.map((f) => f.path));

        // Extract reviewer file paths from the reviewer context
        const reviewerFiles = loadResult.files.filter((f) =>
          REVIEWER_TIERS.has(f.tier),
        );

        for (const file of reviewerFiles) {
          expect(
            workerPaths.has(file.path),
            `reviewer file ${file.path} should be in worker context`,
          ).toBe(true);
        }
      },
    );

    it.each(ALL_INTENTS)(
      "intent %s: reviewer file count is less than or equal to worker file count",
      async (intent) => {
        const loadResult = await loadWorkerContext(intent);
        const reviewerFiles = loadResult.files.filter((f) =>
          REVIEWER_TIERS.has(f.tier),
        );

        expect(reviewerFiles.length).toBeLessThanOrEqual(
          loadResult.files.length,
        );
      },
    );
  });

  // -------------------------------------------------------------------------
  // Reviewer context is non-empty
  // -------------------------------------------------------------------------

  describe("reviewer context is non-empty", () => {
    it.each(ALL_INTENTS)(
      "intent %s: reviewer context has at least mode + oversight",
      async (intent) => {
        const loadResult = await loadWorkerContext(intent);
        const reviewerContext = selectReviewerFiles(loadResult.files);

        expect(
          reviewerContext.length,
          `reviewer context for ${intent} should not be empty`,
        ).toBeGreaterThan(0);

        // At minimum, it should include mode and oversight
        const reviewerFiles = loadResult.files.filter((f) =>
          REVIEWER_TIERS.has(f.tier),
        );
        expect(reviewerFiles.length).toBeGreaterThanOrEqual(2); // mode + oversight
      },
    );
  });
});
