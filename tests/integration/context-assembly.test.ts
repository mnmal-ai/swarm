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

describe("Context Assembly — Full Pipeline", () => {
  let router: Router;
  let loader: Loader;

  beforeAll(() => {
    const pair = createRouterAndLoader();
    router = pair.router;
    loader = pair.loader;
  });

  // -------------------------------------------------------------------------
  // End-to-end: classify → load → assembleContext
  // -------------------------------------------------------------------------

  describe("classify → load → assembleContext pipeline", () => {
    it.each(ALL_INTENTS)(
      "intent %s: produces non-empty assembled context",
      async (intent) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();
        const project = KNOWN_PROJECTS[0];

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project,
        );

        const context = loader.assembleContext(loadResult.files);

        expect(context.length).toBeGreaterThan(0);
        expect(loadResult.files.length).toBeGreaterThan(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Context string contains proper delimiters
  // -------------------------------------------------------------------------

  describe("assembled context uses correct delimiters", () => {
    it("every loaded file has a `--- swarm: <path> (<tier>) ---` delimiter", async () => {
      const classification = await router.classify("test", INTENTS.IMPLEMENTATION);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      const context = loader.assembleContext(loadResult.files);

      for (const file of loadResult.files) {
        const expectedDelimiter = `--- swarm: ${file.path} (${file.tier}) ---`;
        expect(
          context.includes(expectedDelimiter),
          `missing delimiter for ${file.path}: expected "${expectedDelimiter}"`,
        ).toBe(true);
      }
    });

    it("delimiter count matches loaded file count", async () => {
      const classification = await router.classify("test", INTENTS.CODE_REVIEW);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      const context = loader.assembleContext(loadResult.files);
      const delimiterCount = (context.match(/--- swarm: /g) || []).length;

      expect(delimiterCount).toBe(loadResult.files.length);
    });
  });

  // -------------------------------------------------------------------------
  // Core files appear for every route
  // -------------------------------------------------------------------------

  describe("core files always present", () => {
    it.each(ALL_INTENTS)(
      "intent %s: loads core/values.md and core/rules.md",
      async (intent) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          KNOWN_PROJECTS[0],
        );

        const loadedPaths = loadResult.files.map((f) => f.path);
        expect(loadedPaths).toContain("core/values.md");
        expect(loadedPaths).toContain("core/rules.md");
      },
    );
  });

  // -------------------------------------------------------------------------
  // Mode file matches classified intent
  // -------------------------------------------------------------------------

  describe("mode file matches intent", () => {
    const intentToMode: [string, string][] = [
      [INTENTS.CODE_REVIEW, "modes/code-review.md"],
      [INTENTS.IMPLEMENTATION, "modes/implementation.md"],
      [INTENTS.INVESTIGATION, "modes/investigation.md"],
      [INTENTS.ONBOARDING, "modes/onboarding.md"],
      [INTENTS.ORCHESTRATION, "modes/orchestration.md"],
    ];

    it.each(intentToMode)(
      "intent %s loads %s",
      async (intent, expectedMode) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          KNOWN_PROJECTS[0],
        );

        const loadedPaths = loadResult.files.map((f) => f.path);
        expect(loadedPaths).toContain(expectedMode);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Oversight file present for every route
  // -------------------------------------------------------------------------

  describe("oversight always loaded", () => {
    it.each(ALL_INTENTS)(
      "intent %s: loads oversight/review-policy.json",
      async (intent) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          KNOWN_PROJECTS[0],
        );

        const loadedPaths = loadResult.files.map((f) => f.path);
        expect(loadedPaths).toContain("oversight/review-policy.json");
      },
    );
  });

  // -------------------------------------------------------------------------
  // File content is not empty
  // -------------------------------------------------------------------------

  describe("loaded file content is non-empty", () => {
    it.each(ALL_INTENTS)(
      "intent %s: every loaded file has content",
      async (intent) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          KNOWN_PROJECTS[0],
        );

        for (const file of loadResult.files) {
          expect(
            file.content.length,
            `file ${file.path} has empty content`,
          ).toBeGreaterThan(0);
          expect(
            file.estimatedTokens,
            `file ${file.path} has zero estimated tokens`,
          ).toBeGreaterThan(0);
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // Assembled context contains actual file content
  // -------------------------------------------------------------------------

  describe("assembled context contains file content, not just delimiters", () => {
    it("context for code-review contains content from core/values.md", async () => {
      const classification = await router.classify("test", INTENTS.CODE_REVIEW);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );

      const context = loader.assembleContext(loadResult.files);

      // Find the values.md file and verify its content appears in the assembled string
      const valuesFile = loadResult.files.find((f) => f.path === "core/values.md");
      expect(valuesFile).toBeDefined();
      expect(context).toContain(valuesFile!.content.slice(0, 50));
    });
  });
});
