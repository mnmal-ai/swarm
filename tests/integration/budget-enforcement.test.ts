import { describe, it, expect, beforeAll } from "vitest";
import {
  createRouterAndLoader,
  INTENTS,
  ALL_INTENTS,
  MODELS,
  KNOWN_PROJECTS,
} from "./helpers.js";
import type { Router } from "@mnmal-ai/swarm-core";
import type { Loader } from "@mnmal-ai/swarm-core";

describe("Budget Enforcement", () => {
  let router: Router;
  let loader: Loader;

  beforeAll(() => {
    const pair = createRouterAndLoader();
    router = pair.router;
    loader = pair.loader;
  });

  // Helper: load a route with a specific budget
  async function loadWithBudget(intent: string, budget: number) {
    const classification = await router.classify("test", intent);
    const priority = await router.getLoadingPriority();
    return loader.load(
      classification.route,
      budget,
      priority,
      KNOWN_PROJECTS[0],
    );
  }

  // -------------------------------------------------------------------------
  // Default budget (15000) loads required + optional tiers
  // -------------------------------------------------------------------------

  describe("default budget (15000)", () => {
    it("loads core + mode + oversight plus some optional tiers", async () => {
      const result = await loadWithBudget(INTENTS.IMPLEMENTATION, 15000);

      const tiers = new Set(result.files.map((f) => f.tier));
      expect(tiers.has("core")).toBe(true);
      expect(tiers.has("mode")).toBe(true);
      expect(tiers.has("oversight")).toBe(true);

      // Implementation route has capabilities — should fit in 15k
      expect(result.files.length).toBeGreaterThan(3);
    });
  });

  // -------------------------------------------------------------------------
  // Model-specific budgets
  // -------------------------------------------------------------------------

  describe("model-specific budget from manifest", () => {
    it("opus budget is 20000", async () => {
      const budget = await router.getBudget(MODELS.OPUS);
      expect(budget).toBe(20000);
    });

    it("sonnet budget is 14000", async () => {
      const budget = await router.getBudget(MODELS.SONNET);
      expect(budget).toBe(14000);
    });

    it("unknown model gets default budget of 15000", async () => {
      const budget = await router.getBudget("unknown-model-xyz");
      expect(budget).toBe(15000);
    });
  });

  // -------------------------------------------------------------------------
  // Opus budget loads more optional files than Sonnet
  // -------------------------------------------------------------------------

  describe("opus vs sonnet budget comparison", () => {
    it("opus loads at least as many files as sonnet for implementation route", async () => {
      const opusBudget = await router.getBudget(MODELS.OPUS);
      const sonnetBudget = await router.getBudget(MODELS.SONNET);

      const opusResult = await loadWithBudget(INTENTS.IMPLEMENTATION, opusBudget);
      const sonnetResult = await loadWithBudget(INTENTS.IMPLEMENTATION, sonnetBudget);

      expect(opusResult.files.length).toBeGreaterThanOrEqual(
        sonnetResult.files.length,
      );
    });

    it("sonnet truncates more files than opus for implementation route", async () => {
      const opusBudget = await router.getBudget(MODELS.OPUS);
      const sonnetBudget = await router.getBudget(MODELS.SONNET);

      const opusResult = await loadWithBudget(INTENTS.IMPLEMENTATION, opusBudget);
      const sonnetResult = await loadWithBudget(INTENTS.IMPLEMENTATION, sonnetBudget);

      expect(sonnetResult.truncated.length).toBeGreaterThanOrEqual(
        opusResult.truncated.length,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Tiny budget — required tiers still load
  // -------------------------------------------------------------------------

  describe("tiny budget (100 tokens)", () => {
    it.each(ALL_INTENTS)(
      "intent %s: required tiers load despite tiny budget",
      async (intent) => {
        const result = await loadWithBudget(intent, 100);

        const tiers = new Set(result.files.map((f) => f.tier));
        expect(tiers.has("core")).toBe(true);
        expect(tiers.has("mode")).toBe(true);
        expect(tiers.has("oversight")).toBe(true);
      },
    );

    it("tiny budget exceeds budget max — required tiers ignore budget", async () => {
      const result = await loadWithBudget(INTENTS.IMPLEMENTATION, 100);

      // Required tiers have real content that exceeds 100 tokens
      expect(result.totalTokens).toBeGreaterThan(100);
      expect(result.budgetMax).toBe(100);
      // Budget used should be well over 100%
      expect(result.budgetUsedPercent).toBeGreaterThan(100);
    });

    it("tiny budget truncates all optional files", async () => {
      const result = await loadWithBudget(INTENTS.IMPLEMENTATION, 100);

      // No optional tiers should be loaded
      const optionalTiers = result.files.filter(
        (f) => !["core", "mode", "oversight"].includes(f.tier),
      );
      expect(optionalTiers.length).toBe(0);

      // Implementation route has capabilities and domain tiers that should be
      // truncated at budget=100 — assert they are actually in the truncated list
      expect(result.truncated.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Truncated array contains skipped file paths
  // -------------------------------------------------------------------------

  describe("truncated array", () => {
    it("truncated files are not in the loaded files list", async () => {
      const result = await loadWithBudget(INTENTS.IMPLEMENTATION, 100);

      const loadedPaths = new Set(result.files.map((f) => f.path));
      for (const truncatedPath of result.truncated) {
        expect(
          loadedPaths.has(truncatedPath),
          `truncated file "${truncatedPath}" should not be in loaded files`,
        ).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // budgetUsedPercent calculation
  // -------------------------------------------------------------------------

  describe("budgetUsedPercent", () => {
    it("is calculated as (totalTokens / budget) * 100", async () => {
      const budget = 15000;
      const result = await loadWithBudget(INTENTS.CODE_REVIEW, budget);

      const expected = (result.totalTokens / budget) * 100;
      expect(result.budgetUsedPercent).toBeCloseTo(expected, 5);
    });

    it("is 0 when budget is 0 (loader special-cases division by zero)", async () => {
      // Budget 0 edge case: the naive formula (totalTokens / 0) * 100 = Infinity,
      // but the Loader guards against this — when budget === 0, it returns 0 for
      // budgetUsedPercent. Required tiers still load (totalTokens > 0).
      const classification = await router.classify("test", INTENTS.ONBOARDING);
      const priority = await router.getLoadingPriority();
      const result = await loader.load(
        classification.route,
        0,
        priority,
        KNOWN_PROJECTS[0],
      );
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.budgetUsedPercent).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Token estimation consistency
  // -------------------------------------------------------------------------

  describe("token estimation", () => {
    it("totalTokens equals sum of loaded file estimatedTokens", async () => {
      const result = await loadWithBudget(INTENTS.IMPLEMENTATION, 20000);

      const sumOfFileTokens = result.files.reduce(
        (sum, f) => sum + f.estimatedTokens,
        0,
      );
      expect(result.totalTokens).toBe(sumOfFileTokens);
    });

    it("estimatedTokens matches Math.ceil(content.length / 4)", async () => {
      const result = await loadWithBudget(INTENTS.CODE_REVIEW, 20000);

      for (const file of result.files) {
        const expected = Math.ceil(file.content.length / 4);
        expect(
          file.estimatedTokens,
          `token estimate mismatch for ${file.path}`,
        ).toBe(expected);
      }
    });
  });
});
