import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  estimateComplexity,
  createEscalationWatcher,
  configToThresholds,
  getTimeoutForComplexity,
  DEFAULT_COMPLEXITY_THRESHOLDS,
} from "../src/complexity/index.js";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { ComplexityThresholds } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// estimateComplexity
// ---------------------------------------------------------------------------

describe("estimateComplexity", () => {
  it("should classify a simple task as 'simple'", () => {
    const result = estimateComplexity("Add copyright header");
    expect(result.band).toBe("simple");
    expect(result.score).toBeLessThanOrEqual(30);
  });

  it("should classify a simple single-verb task as 'simple'", () => {
    const result = estimateComplexity("Fix typo in README");
    expect(result.band).toBe("simple");
    expect(result.score).toBeLessThanOrEqual(30);
  });

  it("should classify a moderate multi-operation task", () => {
    // The DataModel.swift example from the plan — scores 39 (moderate)
    const result = estimateComplexity(
      "Convert all model types to use Swift actor isolation, add Sendable conformance, migrate from completion handlers to async/await"
    );
    expect(result.band).toBe("moderate");
    expect(result.score).toBeGreaterThan(30);
    expect(result.score).toBeLessThan(61);
  });

  it("should classify a complex task with many operations as 'complex'", () => {
    const result = estimateComplexity(
      "Refactor all view controllers to use async/await, convert every model to use actors, migrate from UIKit to SwiftUI across the entire project, and replace all completion handlers with structured concurrency"
    );
    expect(result.band).toBe("complex");
    expect(result.score).toBeGreaterThanOrEqual(61);
  });

  it("should detect conjunction-heavy descriptions", () => {
    const result = estimateComplexity(
      "Update the auth flow and fix the login screen and refactor the user model and add tests"
    );
    const conjSignal = result.signals.find(s => s.name === "conjunctions");
    expect(conjSignal).toBeDefined();
    expect(conjSignal!.score).toBeGreaterThan(0);
  });

  it("should detect multiple action verbs", () => {
    const result = estimateComplexity(
      "Convert models, add validation, migrate database schema"
    );
    const verbSignal = result.signals.find(s => s.name === "verb_count");
    expect(verbSignal).toBeDefined();
    expect(verbSignal!.score).toBeGreaterThan(0);
    expect(verbSignal!.detail).toContain("convert");
    expect(verbSignal!.detail).toContain("add");
    expect(verbSignal!.detail).toContain("migrate");
  });

  it("should detect scope markers", () => {
    const result = estimateComplexity("Update all models across the entire project");
    const scopeSignal = result.signals.find(s => s.name === "scope_markers");
    expect(scopeSignal).toBeDefined();
    expect(scopeSignal!.score).toBeGreaterThan(0);
  });

  it("should detect migration language", () => {
    const result = estimateComplexity("Migrate from UIKit to SwiftUI");
    const migSignal = result.signals.find(s => s.name === "migration_language");
    expect(migSignal).toBeDefined();
    expect(migSignal!.score).toBeGreaterThan(0);
  });

  it("should detect file breadth references", () => {
    const result = estimateComplexity("Update DataModel.swift, ViewModel.ts, and AuthService.py");
    const fileSignal = result.signals.find(s => s.name === "file_breadth");
    expect(fileSignal).toBeDefined();
    expect(fileSignal!.score).toBeGreaterThan(0);
  });

  it("should score long descriptions higher", () => {
    const short = estimateComplexity("Fix bug");
    const long = estimateComplexity(
      "This task requires a comprehensive refactoring of the authentication module. " +
      "We need to update the OAuth flow to support multiple providers, add proper error " +
      "handling for network failures, implement token refresh logic, add unit tests for " +
      "each component, and update the documentation to reflect the changes."
    );

    const shortLen = short.signals.find(s => s.name === "description_length")!;
    const longLen = long.signals.find(s => s.name === "description_length")!;
    expect(longLen.score).toBeGreaterThan(shortLen.score);
  });

  it("should return exactly 6 signals", () => {
    const result = estimateComplexity("Any task description");
    expect(result.signals).toHaveLength(6);
  });

  it("should cap total score at 100", () => {
    // Intentionally over-the-top description
    const result = estimateComplexity(
      "Convert all models and refactor every service and migrate from completion handlers to async/await " +
      "and replace all UIKit views with SwiftUI and update each controller across the entire project " +
      "and restructure the whole module hierarchy and transform every test file to use the new framework " +
      "and reorganize all configurations and optimize every database query"
    );
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("should include reasoning string", () => {
    const result = estimateComplexity("Add Sendable conformance to all models");
    expect(result.reasoning).toContain("Score");
  });

  it("should respect custom thresholds", () => {
    const tight: ComplexityThresholds = {
      simpleMax: 5,
      complexMin: 12,
      tokenEscalationFraction: 0.5,
      turnEscalationFraction: 0.7,
      timeoutEscalationFraction: 0.6,
    };

    // "Add two features and migrate the database" scores 13 with default thresholds (simple).
    // With tight thresholds (complexMin=12), the same score becomes "complex".
    const description = "Add two features and migrate the database";
    const defaultResult = estimateComplexity(description);
    const tightResult = estimateComplexity(description, tight);

    // Same score, different band classification
    expect(defaultResult.score).toBe(tightResult.score);
    expect(defaultResult.band).toBe("simple");
    expect(tightResult.band).toBe("complex");
  });
});

// ---------------------------------------------------------------------------
// configToThresholds
// ---------------------------------------------------------------------------

describe("configToThresholds", () => {
  it("should return defaults when config is undefined", () => {
    const result = configToThresholds(undefined);
    expect(result).toEqual(DEFAULT_COMPLEXITY_THRESHOLDS);
  });

  it("should throw when simple_max >= complex_min", () => {
    expect(() => configToThresholds({
      simple_max: 61,
      complex_min: 30,
      escalation: { token_fraction: 0.5, turn_fraction: 0.7, timeout_fraction: 0.6 },
    })).toThrow("simple_max (61) must be less than complex_min (30)");
  });

  it("should throw when simple_max equals complex_min", () => {
    expect(() => configToThresholds({
      simple_max: 50,
      complex_min: 50,
      escalation: { token_fraction: 0.5, turn_fraction: 0.7, timeout_fraction: 0.6 },
    })).toThrow("simple_max (50) must be less than complex_min (50)");
  });

  it("should map config fields to threshold fields", () => {
    const result = configToThresholds({
      simple_max: 25,
      complex_min: 70,
      escalation: {
        token_fraction: 0.4,
        turn_fraction: 0.6,
        timeout_fraction: 0.5,
      },
    });
    expect(result.simpleMax).toBe(25);
    expect(result.complexMin).toBe(70);
    expect(result.tokenEscalationFraction).toBe(0.4);
    expect(result.turnEscalationFraction).toBe(0.6);
    expect(result.timeoutEscalationFraction).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// getTimeoutForComplexity
// ---------------------------------------------------------------------------

describe("getTimeoutForComplexity", () => {
  it("should return 300_000ms for simple band", () => {
    expect(getTimeoutForComplexity("simple")).toBe(300_000);
  });

  it("should return 600_000ms for moderate band", () => {
    expect(getTimeoutForComplexity("moderate")).toBe(600_000);
  });

  it("should return 900_000ms for complex band", () => {
    expect(getTimeoutForComplexity("complex")).toBe(900_000);
  });

  it("should use overrides when provided", () => {
    expect(getTimeoutForComplexity("simple", { simple: 60_000 })).toBe(60_000);
  });

  it("should fall back to default for bands not in overrides", () => {
    expect(getTimeoutForComplexity("complex", { simple: 60_000 })).toBe(900_000);
  });

  it("should allow overriding all bands", () => {
    const overrides = { simple: 10_000, moderate: 20_000, complex: 30_000 };
    expect(getTimeoutForComplexity("simple", overrides)).toBe(10_000);
    expect(getTimeoutForComplexity("moderate", overrides)).toBe(20_000);
    expect(getTimeoutForComplexity("complex", overrides)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// createEscalationWatcher
// ---------------------------------------------------------------------------

describe("createEscalationWatcher", () => {
  let eventBus: SwarmEventBus;

  beforeEach(() => {
    eventBus = new SwarmEventBus();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  it("should not be triggered initially", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    expect(watcher.isTriggered()).toBe(false);
    expect(watcher.getReason()).toBeNull();

    watcher.dispose();
  });

  it("should trigger on token threshold, counting the task's turns since it started", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    // Token threshold is 50% of 1,000 = 500, over input + output across turns
    eventBus.emit("turn:end", {
      turn: 0,
      inputTokens: 200,
      outputTokens: 100,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(false);

    eventBus.emit("turn:end", {
      turn: 1,
      inputTokens: 150,
      outputTokens: 60,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(true);
    expect(watcher.getReason()).toBe("token_threshold");

    watcher.dispose();
  });

  it("should trigger on turn threshold", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    // Turn threshold is 70% of 50 = 35
    eventBus.emit("turn:end", {
      turn: 10,
      inputTokens: 100,
      outputTokens: 50,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(false);

    eventBus.emit("turn:end", {
      turn: 35,
      inputTokens: 100,
      outputTokens: 50,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(true);
    expect(watcher.getReason()).toBe("turn_threshold");

    watcher.dispose();
  });

  it("should trigger on reviewer rejection", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    // Rejection of a different task should NOT trigger
    eventBus.emit("task:verdict", {
      taskId: "task-other",
      verdict: "rejected",
      tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      latencyMs: 1000,
      retryCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(false);

    // Rejection of THIS task should trigger
    eventBus.emit("task:verdict", {
      taskId: "task-1",
      verdict: "rejected",
      tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      latencyMs: 1000,
      retryCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(true);
    expect(watcher.getReason()).toBe("reviewer_rejection");

    watcher.dispose();
  });

  it("should not trigger on task approval", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    eventBus.emit("task:verdict", {
      taskId: "task-1",
      verdict: "approved",
      tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      latencyMs: 1000,
      retryCount: 0,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(false);

    watcher.dispose();
  });

  it("should only trigger once (first reason wins)", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    // Trigger via tokens
    eventBus.emit("turn:end", {
      turn: 0,
      inputTokens: 500,
      outputTokens: 100,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.getReason()).toBe("token_threshold");

    // Try to trigger via rejection — reason should not change
    eventBus.emit("task:verdict", {
      taskId: "task-1",
      verdict: "rejected",
      tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      latencyMs: 1000,
      retryCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.getReason()).toBe("token_threshold"); // Still tokens, not rejection

    watcher.dispose();
  });

  it("should clean up listeners on dispose", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 1_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

    watcher.dispose();

    // After dispose, events should not trigger
    eventBus.emit("turn:end", {
      turn: 0,
      inputTokens: 500,
      outputTokens: 100,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(false);
  });

  it("should not trigger when token limit is 0", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 0,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

eventBus.emit("turn:end", {
      turn: 0,
      inputTokens: 100000,
      outputTokens: 5000,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(false);

    watcher.dispose();
  });

  it("should provide detail message when triggered", () => {
    const watcher = createEscalationWatcher(eventBus, "task-1", DEFAULT_COMPLEXITY_THRESHOLDS, {
      tokenLimit: 2_000,
      maxTurns: 50,
      timeoutMs: 300_000,
    });

eventBus.emit("turn:end", {
      turn: 0,
      inputTokens: 1000,
      outputTokens: 100,
      toolCallCount: 1,
      timestamp: Date.now(),
    });
    expect(watcher.isTriggered()).toBe(true);
    expect(watcher.getDetail()).toContain("50%");
    expect(watcher.getDetail()).toContain("limit");

    watcher.dispose();
  });
});
