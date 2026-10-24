/**
 * Tests for the AutonomyConfig type system and deriveAutonomy logic.
 *
 * Verifies that:
 * - deriveAutonomy returns autonomy block directly when present
 * - deriveAutonomy derives from trust_level when autonomy is absent
 * - deriveAutonomy honors concurrency overrides from legacy config
 * - deriveAutonomy defaults to medium when trust_level is missing
 * - AUTONOMY_PRESETS has correct entries for all trust levels
 */

import { describe, it, expect } from "vitest";
import { AUTONOMY_PRESETS, deriveAutonomy } from "../src/autonomy/index.js";
import type { ProjectConfig, AutonomyConfig } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectConfig(
  overrides?: Partial<ProjectConfig>,
): ProjectConfig {
  return {
    project: "test-project",
    swarm_path: "/tmp/swarm",
    trust_level: "medium",
    concurrency: {
      max_workers: 3,
      max_tokens_per_session: 20_000_000,
      max_tokens_per_task: 2_000_000,
      max_tokens_per_goal: 10_000_000,
    },
    task_backend: "local",
    created: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: deriveAutonomy
// ---------------------------------------------------------------------------

describe("deriveAutonomy", () => {
  it("returns autonomy block directly if present", () => {
    const customAutonomy: AutonomyConfig = {
      execution: {
        parallel_workers: false,
        max_workers: 2,
        allow_shell_commands: true,
        allow_dependency_install: false,
        max_tokens_per_task: 3_000_000,
        max_tokens_per_goal: 15_000_000,
        max_tokens_per_session: 30_000_000,
        task_timeout_seconds: 600,
      },
      review: {
        require_review: true,
        separate_reviewer_context: true,
        auto_retry_on_rejection: true,
        max_retries: 3,
        arbiter_can_resolve: true,
      },
      merge: {
        auto_merge_worktrees: false,
        auto_resolve_conflicts: false,
        push_to_remote: false,
        open_pull_requests: false,
        conflict_anticipation: "static",
      },
      escalation: {
        decompose_on_failure: true,
        max_remediation_iterations: 2,
        escalate_after_retries: 3,
      },
      context: {
        skill_tiers: ["core", "vetted"],
        allow_runtime_skill_fetch: false,
      },
    };

    const config = makeProjectConfig({ autonomy: customAutonomy });
    const result = deriveAutonomy(config);
    expect(result).toBe(customAutonomy);
  });

  it("derives from trust_level when autonomy absent", () => {
    const config = makeProjectConfig({
      trust_level: "low",
      concurrency: { max_workers: 1 },
    });
    const result = deriveAutonomy(config);
    expect(result).toEqual(AUTONOMY_PRESETS.low);
  });

  it("honors concurrency overrides from legacy config", () => {
    const config = makeProjectConfig({
      trust_level: "medium",
      concurrency: {
        max_workers: 7,
        max_tokens_per_session: 100_000_000,
        max_tokens_per_task: 10_000_000,
        max_tokens_per_goal: 50_000_000,
      },
    });
    const result = deriveAutonomy(config);

    // Should use the concurrency overrides, not the preset defaults
    expect(result.execution.max_workers).toBe(7);
    expect(result.execution.max_tokens_per_session).toBe(100_000_000);
    expect(result.execution.max_tokens_per_task).toBe(10_000_000);
    expect(result.execution.max_tokens_per_goal).toBe(50_000_000);

    // Non-concurrency fields should still match the medium preset
    expect(result.review.require_review).toBe(
      AUTONOMY_PRESETS.medium.review.require_review,
    );
    expect(result.merge.auto_merge_worktrees).toBe(
      AUTONOMY_PRESETS.medium.merge.auto_merge_worktrees,
    );
  });

  it("defaults to medium when trust_level missing", () => {
    // Create config with concurrency matching the medium preset,
    // then delete trust_level to simulate legacy/incomplete config.
    const config = makeProjectConfig({
      concurrency: { max_workers: 3 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (config as any).trust_level;

    const result = deriveAutonomy(config);
    expect(result).toEqual(AUTONOMY_PRESETS.medium);
  });
});

// ---------------------------------------------------------------------------
// Tests: AUTONOMY_PRESETS
// ---------------------------------------------------------------------------

describe("AUTONOMY_PRESETS", () => {
  it("has entries for all trust levels", () => {
    expect(AUTONOMY_PRESETS).toHaveProperty("low");
    expect(AUTONOMY_PRESETS).toHaveProperty("medium");
    expect(AUTONOMY_PRESETS).toHaveProperty("high");
  });

  it("low preset requires review", () => {
    expect(AUTONOMY_PRESETS.low.review.require_review).toBe(true);
  });

  it("medium preset requires review", () => {
    expect(AUTONOMY_PRESETS.medium.review.require_review).toBe(true);
  });

  it("high preset does not require review", () => {
    expect(AUTONOMY_PRESETS.high.review.require_review).toBe(false);
  });

  it("all presets default to learned conflict anticipation", () => {
    expect(AUTONOMY_PRESETS.low.merge.conflict_anticipation).toBe("learned");
    expect(AUTONOMY_PRESETS.medium.merge.conflict_anticipation).toBe("learned");
    expect(AUTONOMY_PRESETS.high.merge.conflict_anticipation).toBe("learned");
  });
});
