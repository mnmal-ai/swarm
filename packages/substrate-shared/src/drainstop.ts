/**
 * The drainstop's report, as the swarm plugin's `trigger-drainstop` route
 * answers it (`TRIGGER_DRAINSTOP_PATH`). Pure shapes: the plugin produces
 * them, the client and CLI read them.
 */

/** One promotion or expiry that did not happen, and why. */
export interface DrainstopFailure {
  /** `promote_todo`, `promote_decision`, `promote_agent_rule`, `promote_concern_recurrence`, `absorb_concern_recurrence`, `load_open_recurrences`, `delete`, `expire`, `session_count`. */
  phase: string;
  /** The observation the failure kept, or null for a run-level failure. */
  observationId: string | null;
  /** The envelope error code, when the engine gave one. */
  code: string | null;
  /** The thrown error's class name (`PromotionWriteError`, `FrameRefusedError`, `EngineQueryError`, …), when it was an Error. */
  name: string | null;
  message: string;
}

/** What one drainstop pass did. */
export interface DrainstopResult {
  promoted: { todos: number; decisions: number; agentRules: number };
  /** Concerns appended to an already-open recurrence Todo (and deleted). */
  absorbed: number;
  expired: number;
  /** True when this run wrote the calibration anchor. */
  anchorSeeded: boolean;
  /** Promotions and deletes that did not happen; each kept its observation. */
  failures: DrainstopFailure[];
  /** True when the run stopped at the page cap (`maxPages`) with rows left unread. */
  truncated: boolean;
}
