import { describe, it, expect } from "vitest";
import { resolvePreReadConfig } from "../src/swarm.js";

describe("resolvePreReadConfig — maxTurns behavior", () => {
  describe("when user sets maxTurns", () => {
    it("respects user maxTurns for investigation with pre-read", () => {
      const result = resolvePreReadConfig("investigation", true, 50);
      expect(result.maxTurns).toBe(50);
    });

    it("respects user maxTurns for orchestration with pre-read", () => {
      const result = resolvePreReadConfig("orchestration", true, 50);
      expect(result.maxTurns).toBe(50);
    });

    it("respects user maxTurns for investigation without pre-read", () => {
      const result = resolvePreReadConfig("investigation", false, 50);
      expect(result.maxTurns).toBe(50);
    });

    it("respects low user maxTurns", () => {
      const result = resolvePreReadConfig("investigation", true, 3);
      expect(result.maxTurns).toBe(3);
    });
  });

  describe("when user does NOT set maxTurns (defaults)", () => {
    it("caps investigation with pre-read at 25", () => {
      const result = resolvePreReadConfig("investigation", true);
      expect(result.maxTurns).toBe(25);
    });

    it("caps orchestration with pre-read at 10", () => {
      const result = resolvePreReadConfig("orchestration", true);
      expect(result.maxTurns).toBe(10);
    });

    it("caps investigation without pre-read at 20", () => {
      const result = resolvePreReadConfig("investigation", false);
      expect(result.maxTurns).toBe(20);
    });

    it("defaults to 50 for non-investigation/orchestration", () => {
      const result = resolvePreReadConfig("implementation", true);
      expect(result.maxTurns).toBe(50);
    });
  });

  describe("preReadApplied flag", () => {
    it("true when investigation has pre-read content", () => {
      expect(resolvePreReadConfig("investigation", true).preReadApplied).toBe(true);
    });

    it("false when investigation has no pre-read content", () => {
      expect(resolvePreReadConfig("investigation", false).preReadApplied).toBe(false);
    });

    it("false for non-investigation intents", () => {
      expect(resolvePreReadConfig("implementation", true).preReadApplied).toBe(false);
    });
  });
});
