// Foundational schema for the /prepare-for-swarm suggestion engine.
// Pure types + const arrays — no runtime logic, no imports, no LLM calls.
// The catalog, matcher, suggestions-log schema, and both tests all build on
// the primitives defined here; keep this module dependency-free so it stays
// the stable leaf the rest of the suggestion subsystem imports from.

/**
 * Canonical set of suggestion axes. The suggestion flow walks these three axes
 * in order, presenting per-item yes/customize/no choices for each.
 *
 * Declared `as const` so it is the single source of truth: {@link SuggestionAxis}
 * is derived from it, which means the union type and the iterable array can
 * never drift apart. The catalog-shape test iterates this to validate that
 * every axis has catalog entries.
 */
export const SUGGESTION_AXES = ['deployment-completion', 'skill', 'mcp'] as const;

/**
 * A single suggestion axis. Derived from {@link SUGGESTION_AXES} so adding or
 * removing an axis is a one-line change that propagates to the type.
 */
export type SuggestionAxis = (typeof SUGGESTION_AXES)[number];

/**
 * A detection signal the matcher evaluates against the target repo to decide
 * whether a catalog entry is relevant. Discriminated on `kind`:
 *
 * - `dependency`: `pattern` is a regex matched against package.json dependency names.
 * - `file`: `glob` is a file-presence glob (entry is relevant if any file matches).
 * - `env`: `name` is an environment variable whose presence signals relevance.
 *
 * Detection degrades to a verbal interview when the backend can't read files,
 * so every signal must be expressible without executing repo code.
 */
export type DetectionSignal =
  | { kind: 'dependency'; pattern: string }
  | { kind: 'file'; glob: string }
  | { kind: 'env'; name: string };

/**
 * A single entry in the suggestion catalog — the composite shape everything
 * downstream consumes (detection/matcher, the yes/customize/no prompt loop,
 * template copying on accept, and the .swarm/.suggestions-log.json transcript).
 *
 * The catalog ships as pure data: no runtime logic and no LLM calls. Each entry
 * describes one thing the /prepare-for-swarm flow can suggest along a single axis.
 */
export interface CatalogEntry {
  /**
   * Stable kebab-case identifier (e.g. 'vercel-deploy', 'github-mcp').
   * MUST be unique across the entire catalog: it keys the suggestions-log
   * transcript and names the per-entry template directory
   * (suggestions/templates/<id>/).
   */
  id: string;

  /** Which of the three suggestion axes this entry belongs to. */
  axis: SuggestionAxis;

  /** Short human-facing label shown in the menu. */
  title: string;

  /** Full suggestion text presented to the user for the yes/customize/no choice. */
  suggestionText: string;

  /**
   * One or more detection signals that decide whether this entry is offered.
   * Always represented as an array, even for a single signal, so consumers
   * never branch on shape. An empty array means "always offer" (no gating).
   */
  detection: DetectionSignal[];

  /**
   * Template files copied into the project on accept, expressed as paths
   * relative to suggestions/templates/<id>/. MAY be empty: register-only
   * entries (e.g. an MCP server that is registered rather than scaffolded)
   * legitimately carry `templateFiles: []`.
   */
  templateFiles: string[];

  /**
   * Optional human-readable reason this entry is being suggested.
   * Reserved for future ranking/explanation; currently unused.
   */
  rationale?: string;

  /**
   * Optional coarse impact estimate. Reserved for future ranking; currently
   * unused. A small fixed union keeps entries sortable without freeform text.
   */
  impact?: 'low' | 'medium' | 'high';
}
