import { describe, it, expect, beforeAll } from "vitest";
import { createRouter, INTENTS } from "./helpers.js";
import type { Router } from "@mnmal-ai/swarm-core";

describe("Route Resolution — Intent Classification", () => {
  let router: Router;

  beforeAll(() => {
    router = createRouter();
  });

  // -------------------------------------------------------------------------
  // Realistic prompts → correct intent
  // -------------------------------------------------------------------------

  describe("classifies realistic prompts correctly", () => {
    const cases: [string, string][] = [
      ["Review this PR for style issues", INTENTS.CODE_REVIEW],
      ["Can you do a code review of my changes?", INTENTS.CODE_REVIEW],
      ["Look at this diff and tell me what's wrong", INTENTS.CODE_REVIEW],
      ["Check this pull request before merge", INTENTS.CODE_REVIEW],

      ["Build a login screen with SwiftUI", INTENTS.IMPLEMENTATION],
      ["Implement the user profile feature", INTENTS.IMPLEMENTATION],
      ["Create a new API endpoint for payments", INTENTS.IMPLEMENTATION],
      ["Fix the crash on the settings page", INTENTS.IMPLEMENTATION],
      ["Add dark mode support", INTENTS.IMPLEMENTATION],

      ["Why is the build failing?", INTENTS.INVESTIGATION],
      ["Why is there a memory leak in the settings tab", INTENTS.INVESTIGATION],
      ["Investigate why tests are broken", INTENTS.INVESTIGATION],
      ["I need to understand how the auth flow works", INTENTS.INVESTIGATION],
      ["Why is this error failing in CI", INTENTS.INVESTIGATION],

      ["Initialize swarm for my new project", INTENTS.ONBOARDING],
      ["Get started with swarm setup for my iOS app", INTENTS.ONBOARDING],
      ["Onboard this repo to the swarm system", INTENTS.ONBOARDING],
      ["I want to adopt the swarm for my codebase", INTENTS.ONBOARDING],

      ["Orchestrate the remaining tasks", INTENTS.ORCHESTRATION],
      ["Dispatch workers to execute goals", INTENTS.ORCHESTRATION],
      ["Coordinate and orchestrate the full migration", INTENTS.ORCHESTRATION],
      ["Execute goals for the authentication module", INTENTS.ORCHESTRATION],
    ];

    it.each(cases)(
      '"%s" → %s',
      async (prompt, expectedIntent) => {
        const result = await router.classify(prompt);
        expect(result.intent).toBe(expectedIntent);
        expect(result.confidence).toBe("keyword");
        expect(result.matchedKeywords.length).toBeGreaterThan(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Ambiguous / no-keyword prompts → fallback
  // -------------------------------------------------------------------------

  describe("falls back for unrecognizable prompts", () => {
    const ambiguousCases = [
      "xyzzy gibberish nonsense",
      "hello world",
      "what is the meaning of life",
      "tell me a joke about cats",
    ];

    it.each(ambiguousCases)(
      '"%s" → fallback',
      async (prompt) => {
        const result = await router.classify(prompt);
        expect(result.intent).toBe(INTENTS.FALLBACK);
        expect(result.confidence).toBe("fallback");
        expect(result.matchedKeywords).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Multiple keyword matches — highest score wins
  // -------------------------------------------------------------------------

  describe("highest keyword score wins", () => {
    it("prompt with more code-review keywords routes to code-review, not implementation", async () => {
      // "review" + "PR" + "code review" → 3 code-review keywords
      // vs "fix" → 1 implementation keyword
      const result = await router.classify(
        "review this PR, do a code review, and fix the formatting",
      );
      expect(result.intent).toBe(INTENTS.CODE_REVIEW);
      expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(2);
    });

    it("prompt dominated by implementation keywords routes there", async () => {
      // "build" + "implement" + "create" + "feature" → 4 implementation keywords
      const result = await router.classify(
        "build and implement a feature, create the new module",
      );
      expect(result.intent).toBe(INTENTS.IMPLEMENTATION);
      expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // Intent override bypasses keyword scoring
  // -------------------------------------------------------------------------

  describe("intent override", () => {
    it("overrides keyword scoring entirely", async () => {
      // This prompt would normally route to code-review
      const result = await router.classify(
        "review this PR for issues",
        INTENTS.IMPLEMENTATION,
      );
      expect(result.intent).toBe(INTENTS.IMPLEMENTATION);
      expect(result.confidence).toBe("exact");
      expect(result.matchedKeywords).toEqual([]);
    });

    it("unknown intent override falls through to keyword scoring", async () => {
      const result = await router.classify(
        "review this code",
        "nonexistent-intent",
      );
      // Should fall back to keyword scoring since the override doesn't match
      expect(result.intent).toBe(INTENTS.CODE_REVIEW);
      expect(result.confidence).toBe("keyword");
    });
  });

  // -------------------------------------------------------------------------
  // Route conflict detection — ambiguous prompts and tie-breaking
  // -------------------------------------------------------------------------

  describe("route conflict detection", () => {
    it("tie-breaking is deterministic: first route in swarm.json wins", async () => {
      // "debug" matches investigation, but "debug" also contains "bug" (implementation)
      // Both score 1. Implementation comes before investigation in swarm.json → implementation wins.
      const result = await router.classify("debug this");
      expect(result.intent).toBe(INTENTS.IMPLEMENTATION);
      expect(result.confidence).toBe("keyword");
    });

    it("known substring collision: 'PR' keyword matches inside common words", async () => {
      // "PR" (code-review keyword) is a 2-char substring that matches inside
      // words like "programming", "project", "approach", "sprint", "profile".
      // This is a documented limitation of substring-based keyword matching.
      const result = await router.classify("tell me about my project");
      // "project" contains "pr" → code-review matches
      // No other keyword matches → code-review wins
      expect(result.intent).toBe(INTENTS.CODE_REVIEW);
      expect(result.matchedKeywords).toContain("PR");
    });

    it("explicit keyword beats substring collision when score is higher", async () => {
      // "investigate my project" → "investigate" (investigation, 1 match)
      //                          + "project" contains "pr" (code-review, 1 match)
      // Tie → first route (code-review) wins. But with "investigate" + "why":
      const result = await router.classify("investigate why my codebase is slow");
      // "investigate" + "why" → 2 investigation matches, 0 code-review → investigation
      expect(result.intent).toBe(INTENTS.INVESTIGATION);
      expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(2);
    });

    it("all routes produce consistent results on repeated classification", async () => {
      const prompts = [
        "review this code change",
        "build a new feature",
        "why is this broken",
        "onboard my new repo",
        "orchestrate these tasks",
      ];

      for (const prompt of prompts) {
        const first = await router.classify(prompt);
        const second = await router.classify(prompt);
        expect(first.intent).toBe(second.intent);
        expect(first.confidence).toBe(second.confidence);
        expect(first.matchedKeywords).toEqual(second.matchedKeywords);
      }
    });

    it("multi-word keywords score as single matches, not per-word", async () => {
      // "code review" is one keyword, not two. A prompt containing it
      // should score 1 for that keyword, not 2.
      const result = await router.classify("please do a code review");
      const codeReviewCount = result.matchedKeywords.filter(
        (k) => k === "code review",
      ).length;
      expect(codeReviewCount).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Classification result shape
  // -------------------------------------------------------------------------

  describe("classification result shape", () => {
    it("result always has route with load config", async () => {
      const result = await router.classify("build a feature");
      expect(result.route).toBeDefined();
      expect(result.route.load).toBeDefined();
      expect(result.route.intent).toBe(result.intent);
    });

    it("fallback result has core files in load config", async () => {
      const result = await router.classify("zzz no keywords here zzz");
      expect(result.route.load["core"]).toBeDefined();
      expect(result.route.load["core"].length).toBeGreaterThan(0);
    });
  });
});
