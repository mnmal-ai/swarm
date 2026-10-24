import { describe, it, expect } from "vitest";
import { bindingRulePaths, formatBindingRules, resolvePreReadConfig, selectReviewerFiles } from "@mnmal-ai/swarm-core";

describe("resolvePreReadConfig", () => {
  it("orchestration intent with pre-read content caps maxTurns at 10", () => {
    const result = resolvePreReadConfig("orchestration", true);
    expect(result.preReadApplied).toBe(true);
    expect(result.maxTurns).toBe(10);
  });

  it("investigation intent with pre-read content caps maxTurns at 25 (default, no user override)", () => {
    const result = resolvePreReadConfig("investigation", true);
    expect(result.preReadApplied).toBe(true);
    expect(result.maxTurns).toBe(25);
  });

  it("orchestration without pre-read content caps at 20", () => {
    const result = resolvePreReadConfig("orchestration", false);
    expect(result.preReadApplied).toBe(false);
    expect(result.maxTurns).toBe(20);
  });

  it("investigation without pre-read content caps at 20", () => {
    const result = resolvePreReadConfig("investigation", false);
    expect(result.preReadApplied).toBe(false);
    expect(result.maxTurns).toBe(20);
  });

  it("implementation intent does not trigger pre-read", () => {
    const result = resolvePreReadConfig("implementation", true);
    expect(result.preReadApplied).toBe(false);
    expect(result.maxTurns).toBe(50); // unchanged default
  });

  it("user-specified maxTurns is respected when lower than cap", () => {
    const result = resolvePreReadConfig("orchestration", true, 3);
    expect(result.maxTurns).toBe(3); // Math.min(3, 10) = 3
  });
});

describe("selectReviewerFiles", () => {
  it("includes mode, domain, and oversight files", () => {
    const files = [
      { path: "core/values.md", tier: "core", content: "Be excellent" },
      { path: "core/rules.md", tier: "core", content: "No force push" },
      { path: "modes/implementation.md", tier: "mode", content: "Build it right" },
      { path: "domains/alpha-app/constraints.md", tier: "domain", content: "Maintain existing functionality" },
      { path: "domains/alpha-app/conventions.md", tier: "domain", content: "Use Swift concurrency" },
      { path: "oversight/review-policy.json", tier: "oversight", content: '{"always_review": true}' },
      { path: "capabilities/testing.md", tier: "capabilities", content: "Write tests" },
    ];

    const result = selectReviewerFiles(files, ["domains/alpha-app/constraints.md"]);

    // Should include mode, domain, oversight content. The constraints file
    // reaches the reviewer as a binding rule instead (bindingRulePaths).
    expect(result).toContain("--- modes/implementation.md (mode) ---");
    expect(result).not.toContain("domains/alpha-app/constraints.md");
    expect(result).toContain("--- domains/alpha-app/conventions.md (domain) ---");
    expect(result).toContain("--- oversight/review-policy.json (oversight) ---");

    // Should NOT include core or capabilities
    expect(result).not.toContain("core/values.md");
    expect(result).not.toContain("core/rules.md");
    expect(result).not.toContain("capabilities/testing.md");
  });

  it("returns empty string when no matching tiers exist", () => {
    const files = [
      { path: "core/values.md", tier: "core", content: "Be excellent" },
      { path: "capabilities/testing.md", tier: "capabilities", content: "Write tests" },
    ];

    expect(selectReviewerFiles(files)).toBe("");
  });

  it("delivers the domain constraints as binding rules, not as domain context", () => {
    const files = [
      { path: "modes/code-review.md", tier: "mode", content: "Review carefully" },
      { path: "domains/alpha-app/constraints.md", tier: "domain", content: "Maintain all existing functionality of the app" },
    ];

    expect(selectReviewerFiles(files, ["domains/alpha-app/constraints.md"])).not.toContain("Maintain all existing functionality");
    expect(bindingRulePaths("alpha-app")).toContain("domains/alpha-app/constraints.md");
    expect(formatBindingRules([{ path: "domains/alpha-app/constraints.md", content: files[1].content }])).toContain(
      "Maintain all existing functionality of the app",
    );
  });
});
