import type { TrustLevel, AutonomyConfig } from "@mnmal-ai/swarm-types";

/**
 * Default autonomy configurations for each trust level.
 *
 * These presets define the full set of autonomy decisions for low, medium,
 * and high trust. When a ProjectConfig has no explicit `autonomy` block,
 * `deriveAutonomy()` uses these presets (optionally overridden by legacy
 * concurrency fields).
 *
 * Key design choice: medium trust REQUIRES review. The oversight chain is
 * valuable enough that only high trust (explicit opt-in) disables it.
 *
 * Token limits count all input (fresh input, cache reads, cache writes) plus
 * output. They are sized from a real single-worker bug-fix run: one goal used
 * 10.55M tokens in total (10.44M input, nearly all cached; 0.11M output)
 * across 41 sessions, and its largest session used 1.14M. Medium allows about
 * two such goals per goal limit and three goal limits per session; low still
 * fits one such goal; high doubles medium.
 */
export const AUTONOMY_PRESETS: Record<TrustLevel, AutonomyConfig> = {
  low: {
    execution: {
      parallel_workers: false,
      max_workers: 1,
      allow_shell_commands: false,
      allow_dependency_install: false,
      max_tokens_per_task: 3_000_000,
      max_tokens_per_goal: 12_000_000,
      max_tokens_per_session: 20_000_000,
      task_timeout_seconds: 300,
    },
    review: {
      require_review: true,
      separate_reviewer_context: true,
      auto_retry_on_rejection: true,
      max_retries: 3,
      arbiter_can_resolve: false,
    },
    merge: {
      auto_merge_worktrees: false,
      auto_resolve_conflicts: false,
      push_to_remote: false,
      open_pull_requests: false,
      conflict_anticipation: "learned",
    },
    escalation: {
      decompose_on_failure: false,
      max_remediation_iterations: 1,
      escalate_after_retries: 3,
    },
    context: {
      skill_tiers: ["core"],
      allow_runtime_skill_fetch: false,
    },
  },

  medium: {
    execution: {
      parallel_workers: true,
      max_workers: 3,
      allow_shell_commands: true,
      allow_dependency_install: true,
      max_tokens_per_task: 6_000_000,
      max_tokens_per_goal: 20_000_000,
      max_tokens_per_session: 60_000_000,
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
      auto_merge_worktrees: true,
      auto_resolve_conflicts: false,
      push_to_remote: false,
      open_pull_requests: false,
      conflict_anticipation: "learned",
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
  },

  high: {
    execution: {
      parallel_workers: true,
      max_workers: 5,
      allow_shell_commands: true,
      allow_dependency_install: true,
      max_tokens_per_task: 12_000_000,
      max_tokens_per_goal: 40_000_000,
      max_tokens_per_session: 120_000_000,
      task_timeout_seconds: 900,
    },
    review: {
      require_review: false,
      separate_reviewer_context: true,
      auto_retry_on_rejection: true,
      max_retries: 3,
      arbiter_can_resolve: true,
    },
    merge: {
      auto_merge_worktrees: true,
      auto_resolve_conflicts: true,
      push_to_remote: true,
      open_pull_requests: true,
      conflict_anticipation: "learned",
    },
    escalation: {
      decompose_on_failure: true,
      max_remediation_iterations: 3,
      escalate_after_retries: 3,
    },
    context: {
      skill_tiers: ["core", "vetted", "community"],
      allow_runtime_skill_fetch: true,
    },
  },
};
