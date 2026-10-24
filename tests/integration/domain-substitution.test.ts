import { describe, it, expect, beforeAll } from "vitest";
import {
  createRouterAndLoader,
  INTENTS,
  MODELS,
  KNOWN_PROJECTS,
} from "./helpers.js";
import type { Router } from "@mnmal-ai/swarm-core";
import type { Loader } from "@mnmal-ai/swarm-core";

describe("Domain Substitution — {project} Placeholder", () => {
  let router: Router;
  let loader: Loader;

  beforeAll(() => {
    const pair = createRouterAndLoader();
    router = pair.router;
    loader = pair.loader;
  });

  // Routes that have {project} in domain paths
  const routesWithDomain: string[] = [
    INTENTS.CODE_REVIEW,
    INTENTS.IMPLEMENTATION,
    INTENTS.INVESTIGATION,
    INTENTS.ORCHESTRATION,
  ];

  // -------------------------------------------------------------------------
  // With projectId — {project} is substituted
  // -------------------------------------------------------------------------

  describe("with projectId provided", () => {
    it.each(routesWithDomain)(
      "intent %s: domain file paths contain the project name",
      async (intent) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();
        const project = KNOWN_PROJECTS[0]; // "alpha-app"

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project,
        );

        const domainFiles = loadResult.files.filter(
          (f) => f.tier === "domain",
        );

        // If domain files are loaded, they should have the project name substituted
        for (const file of domainFiles) {
          expect(file.path).toContain(`domains/${project}/`);
          expect(file.path).not.toContain("{project}");
        }
      },
    );

    it("conventions.md resolves to domains/alpha-app/conventions.md for code-review", async () => {
      const classification = await router.classify("test", INTENTS.CODE_REVIEW);
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        "alpha-app",
      );

      const loadedPaths = loadResult.files.map((f) => f.path);
      expect(loadedPaths).toContain("domains/alpha-app/conventions.md");
    });
  });

  // -------------------------------------------------------------------------
  // Without projectId — {project} stays literal, files don't exist
  // -------------------------------------------------------------------------

  describe("without projectId", () => {
    it.each(routesWithDomain)(
      "intent %s: no domain files loaded when projectId is undefined",
      async (intent) => {
        const classification = await router.classify("test", intent);
        const budget = await router.getBudget(MODELS.OPUS);
        const priority = await router.getLoadingPriority();

        // Load without projectId
        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          undefined,
        );

        const domainFiles = loadResult.files.filter(
          (f) => f.tier === "domain",
        );

        // Domain files with {project} placeholder won't exist on disk,
        // so the loader silently skips them — the list should be empty
        expect(domainFiles.length).toBe(0);
      },
    );

    it("loader does not error when domain files don't exist", async () => {
      const classification = await router.classify(
        "test",
        INTENTS.IMPLEMENTATION,
      );
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      // Should not throw
      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        undefined,
      );

      expect(loadResult.files.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Domain files are optional tier — missing files don't cause errors
  // -------------------------------------------------------------------------

  describe("missing domain files are skipped silently", () => {
    it("loading with a nonexistent project produces no domain files", async () => {
      const classification = await router.classify(
        "test",
        INTENTS.IMPLEMENTATION,
      );
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const loadResult = await loader.load(
        classification.route,
        budget,
        priority,
        "nonexistent-project-xyz",
      );

      const domainFiles = loadResult.files.filter(
        (f) => f.tier === "domain",
      );
      expect(domainFiles.length).toBe(0);

      // Required tiers should still be present
      const tiers = new Set(loadResult.files.map((f) => f.tier));
      expect(tiers.has("core")).toBe(true);
      expect(tiers.has("mode")).toBe(true);
      expect(tiers.has("oversight")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Routes without domain paths (onboarding) are unaffected by projectId
  // -------------------------------------------------------------------------

  describe("routes without domain paths", () => {
    it("onboarding loads the same files with or without projectId", async () => {
      const classification = await router.classify(
        "test",
        INTENTS.ONBOARDING,
      );
      const budget = await router.getBudget(MODELS.OPUS);
      const priority = await router.getLoadingPriority();

      const withProject = await loader.load(
        classification.route,
        budget,
        priority,
        KNOWN_PROJECTS[0],
      );
      const withoutProject = await loader.load(
        classification.route,
        budget,
        priority,
        undefined,
      );

      const withPaths = withProject.files.map((f) => f.path).sort();
      const withoutPaths = withoutProject.files.map((f) => f.path).sort();

      expect(withPaths).toEqual(withoutPaths);
    });
  });
});
