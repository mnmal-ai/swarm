// Schema for the single mandatory artifact `.swarm/.suggestions-log.json`.
//
// The /prepare-for-swarm suggestion flow ALWAYS writes this transcript, recording
// every offer it made across the three axes and how the user responded — even when
// every suggestion is declined. It is the one non-optional output of the flow; every
// other suggested artifact is opt-in (yes/customize/no).
//
// Downstream tools consume this file as a structured record of what was offered and
// chosen — e.g. Phase 6.4 learn-from-pr reads it to correlate accepted/declined
// suggestions against later PR activity. Keep this module independent of catalog
// content: it shares only the {@link SuggestionAxis} type with the catalog.

import type { SuggestionAxis } from '../suggestions/types.js';

/**
 * The full offer/response transcript for one catalog item.
 *
 * One entry is appended per suggestion presented to the user, regardless of the
 * response, so the log is a complete record of the flow — not just the accepts.
 */
export interface SuggestionLogEntry {
  /**
   * The {@link CatalogEntry.id} of the item that was offered. Stable kebab-case
   * key linking this transcript line back to the catalog entry.
   */
  catalogEntryId: string;

  /** Which of the three suggestion axes the offered item belongs to. */
  axis: SuggestionAxis;

  /** ISO-8601 timestamp of when the suggestion was presented to the user. */
  offeredAt: string;

  /**
   * How the user responded. Literal union (not an enum) to match the codebase
   * style. `customize` means accepted-with-edits; `no` is a decline.
   */
  response: 'yes' | 'customize' | 'no';

  /** Why the user declined. Populated for `no` responses; omitted otherwise. */
  reason?: string;

  /**
   * Paths of files written into the project as a result of accepting this item.
   * Populated for `yes`/`customize`; omitted for `no` (and for register-only
   * accepts that scaffold nothing).
   */
  artifactPaths?: string[];

  /**
   * What the user edited when accepting with `customize`. Free-form note
   * describing the deviation from the default template; omitted otherwise.
   */
  customizationNote?: string;
}

/**
 * The environment-detection report the suggestion flow produced before offering
 * any items. Captured in the log so downstream tools can see what the detector
 * observed without re-running detection.
 *
 * Detection degrades to a verbal interview when the backend can't read files, so
 * every field is best-effort: absent or empty means "not detected", not "absent
 * from the repo".
 */
export interface SuggestionsLogDetection {
  /** Languages/runtimes detected (e.g. 'typescript', 'swift', 'node'). */
  stacks: string[];

  /** Frameworks/libraries detected (e.g. 'express', 'drizzle', 'swiftui'). */
  frameworks: string[];

  /**
   * Free-form signal record: maps a signal name to whatever the detector found
   * for it (matched dependency names, glob hits, env-var presence, etc.).
   * Backend-neutral and intentionally loose so new signal kinds need no schema
   * change.
   */
  signals: Record<string, unknown>;
}

/**
 * Root shape of `.swarm/.suggestions-log.json` — the single mandatory artifact of
 * the /prepare-for-swarm suggestion flow.
 */
export interface SuggestionsLog {
  /**
   * Schema version of this log file. Typed as a string literal so
   * downstream consumers can narrow on it (e.g. `if (log.schemaVersion ===
   * "1") { … }`); widen to a union (`"1" | "2"`) when a v2 schema ships.
   */
  schemaVersion: "1";

  /** ISO-8601 timestamp of when the log was generated. */
  generatedAt: string;

  /** The env-detection report that gated which entries were offered. */
  detection: SuggestionsLogDetection;

  /** One transcript entry per suggestion presented, in offer order. */
  entries: SuggestionLogEntry[];
}
