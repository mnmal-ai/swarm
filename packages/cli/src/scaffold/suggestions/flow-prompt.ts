// Skill-prompt prose for the menu-driven /prepare-for-swarm suggestion flow.
//
// This module owns the *teaching text* the agent reads to run the flow; the
// runtime engine that backs it lives beside this file:
//   - catalog (pure data) ........ src/scaffold/suggestions/catalog.json
//   - flow contract (matcher) .... src/scaffold/suggestions/matcher.ts
//                                  (loadCatalog / detectEnvironment / matchSuggestions)
//   - axes + entry shape ......... src/scaffold/suggestions/types.ts
//   - log artifact shape ......... src/scaffold/templates/suggestions-log-schema.ts
//
// buildSuggestionFlowBody returns the body only — variant-neutral, with no
// frontmatter or editor-specific framing. The editor variants (claude-code,
// cursor, copilot, universal) wrap it; wiring it into them is a separate task.

import { SUGGESTION_AXES } from './types.js';

// Canonical, source-of-truth locations referenced from the prose so the skill
// text and the engine code never drift on where the catalog/contract/schema
// live. Kept as constants (not inlined) so a path move is a one-line change
// that propagates into the generated prompt.
const CATALOG_PATH = 'src/scaffold/suggestions/catalog.json';
const TEMPLATE_DIR = 'src/scaffold/suggestions/templates/<id>/';
const MATCHER_PATH = 'src/scaffold/suggestions/matcher.ts';
const LOG_SCHEMA_PATH = 'src/scaffold/templates/suggestions-log-schema.ts';
const LOG_ARTIFACT_PATH = '.swarm/.suggestions-log.json';

/**
 * Build the editor-neutral skill-prompt body that teaches the menu-driven
 * /prepare-for-swarm suggestion flow.
 *
 * The returned string is the prose only — no YAML frontmatter, no
 * `<!-- swarm:begin -->` markers, no editor-specific notes. Each variant
 * wrapper supplies its own framing around this body.
 *
 * The prose walks the agent through five phases (DETECT → ITERATE → ASK →
 * WRITE-ACCEPTED → ALWAYS-LOG) and names the canonical engine paths so the
 * skill and the suggestion engine agree on the catalog ({@link CATALOG_PATH}),
 * the flow contract ({@link MATCHER_PATH}), and the log schema
 * ({@link LOG_SCHEMA_PATH}).
 *
 * Pure: no fs, no LLM, no arguments. The text is generic across projects —
 * project-specific detail is discovered at runtime by the DETECT phase, not
 * interpolated here.
 *
 * @returns the suggestion-flow skill body as Markdown prose.
 */
export function buildSuggestionFlowBody(): string {
  const [deploymentAxis, skillAxis, mcpAxis] = SUGGESTION_AXES;

  return `You are running swarm's onboarding suggestion flow. After the user has populated their core swarm files, your job is to offer a short, curated menu of additions — deployment scaffolding, skills, and MCP servers — that fit *this specific repo*, one item at a time, and to record exactly what you offered and how the user responded.

This is a **menu-driven flow**, not a questionnaire. You detect what the project already is, propose a handful of relevant additions, and let the user accept, tailor, or decline each one. Nothing is written without consent except the transcript log.

## The Engine Behind This Flow

A pure-data catalog and a matcher back this prompt. They ship inside swarm — reference them by their canonical paths so your behavior and the engine stay in agreement:

- **Catalog (pure JSON, no LLM):** \`${CATALOG_PATH}\` — every suggestion swarm can offer. Each entry has an \`id\`, an \`axis\`, a \`title\`, a \`suggestionText\`, \`detection\` signals, and \`templateFiles\` (paths relative to \`${TEMPLATE_DIR}\`).
- **Flow contract (the matcher):** \`${MATCHER_PATH}\` — exports \`loadCatalog()\`, \`detectEnvironment(projectPath)\`, and \`matchSuggestions(report, catalog)\`. \`matchSuggestions\` is pure and already groups relevant entries by axis and caps each axis. Treat its output as the menu you walk; do not invent suggestions outside the catalog.
- **Log schema (the one mandatory artifact):** \`${LOG_SCHEMA_PATH}\` — the \`SuggestionsLog\` shape you must write to \`${LOG_ARTIFACT_PATH}\`.

The three axes, walked in this order:
1. \`${deploymentAxis}\` — finishing the deploy story (deploy capability, verify-deployment task, ship-readiness checklist).
2. \`${skillAxis}\` — slash-command skills that fit the stack (e.g. a schema doctor, a security review).
3. \`${mcpAxis}\` — MCP servers worth registering (e.g. a GitHub server).

---

## Phase 1 — DETECT

Run the environment scan and report what you found back to the user **as prose**, conversationally, before offering anything.

- Drive detection through the flow contract: \`detectEnvironment(projectPath)\` returns a report whose \`available\` flag is load-bearing. \`matchSuggestions(report, catalog)\` turns that report into the per-axis menu.
- When detection succeeds, summarize it plainly. Lead with the headline stack, then the long tail. For example:

  > "I see this is a Vercel + Hono + Drizzle project. Other things I noticed: TypeScript with strict mode, Vitest for tests, and a pnpm workspace. Based on that, I have a few suggestions across deployment, skills, and MCP servers."

  Name concrete, detected things — do not narrate the absence of things. The point is to show the user you understand their repo so the suggestions land as informed, not generic.

- **Degrade gracefully.** If the backend cannot read files (the detection report comes back with \`available: false\`, or you otherwise have no filesystem access), do **not** stop. Fall back to a short **verbal interview**: ask the user directly what they're building — deployment target, framework, database, package manager — and use their answers in place of the scan. Make the degradation invisible to the user: the menu still happens, you just sourced the signals by asking instead of by reading.

---

## Phase 2 — ITERATE the catalog

Walk the matched menu axis by axis, in the order above (\`${deploymentAxis}\`, then \`${skillAxis}\`, then \`${mcpAxis}\`).

- **One suggestion at a time.** Emit a single suggestion, get a response, then move to the next. Never dump a batch of suggestions or a checklist for the user to triage. Each suggestion is its own turn.
- **Cap each axis at 4-5 suggestions.** This is a fatigue guard — \`matchSuggestions\` already enforces the cap, so offer what it returns and do not pad an axis to reach a number. If an axis matched nothing, say so in one line and move on.
- Use the catalog entry's own \`title\` and \`suggestionText\` as the basis for what you present — they are written to be shown to the user.

---

## Phase 3 — ASK: yes / customize / no

For each suggestion, present it and ask the user to choose **yes**, **customize**, or **no**.

- **yes** — accept the suggestion as-is. Proceed to write its artifacts (Phase 4) using the catalog entry's template files unchanged.
- **customize** — accept with edits. Walk the user through inline editing: show what the default artifact would contain, ask what they want changed, and apply their edits to the copied template before writing. Capture a short note describing the deviation — it goes in the log's \`customizationNote\`.
- **no** — decline. Write nothing for this entry. Ask briefly why (optional, one line) and record it as the log's \`reason\`. A decline is a first-class outcome, not a failure — record it and move on without pushing back.

Record every offer in the running transcript regardless of the answer, so the log is a complete record of the menu and not just the accepts.

---

## Phase 4 — WRITE only what was accepted

Everything except the log is **opt-in**. Write artifacts only for entries the user answered \`yes\` or \`customize\`.

- To fulfill an accepted entry, copy its \`templateFiles\` from \`${TEMPLATE_DIR}\` (the per-entry template directory, keyed by the catalog entry's \`id\`) into the project at their intended destinations.
- For \`yes\`, copy the templates verbatim. For \`customize\`, copy then apply the user's inline edits.
- An entry may legitimately have **no** template files (\`templateFiles: []\`) — e.g. an MCP server that is registered rather than scaffolded. Honor whatever the entry specifies; do not invent files.
- Track the destination path of every file you write — those paths go in the log's \`artifactPaths\` for that entry.
- Declined entries (\`no\`) produce no files. Do not pre-create directories or stubs for them.

---

## Phase 5 — ALWAYS write the transcript log

Regardless of how many suggestions were accepted — even if the user declined every single one — you **must** write \`${LOG_ARTIFACT_PATH}\`. It is the one mandatory output of this flow.

Write a JSON file conforming to the \`SuggestionsLog\` schema (\`${LOG_SCHEMA_PATH}\`):

\`\`\`json
{
  "schemaVersion": "1",
  "generatedAt": "<ISO-8601 timestamp>",
  "detection": {
    "stacks": ["typescript"],
    "frameworks": ["hono", "drizzle"],
    "signals": { "vercel": true }
  },
  "entries": [
    {
      "catalogEntryId": "vercel-deploy",
      "axis": "${deploymentAxis}",
      "offeredAt": "<ISO-8601 timestamp>",
      "response": "yes",
      "artifactPaths": [".swarm/capabilities/deploy-vercel.md"]
    },
    {
      "catalogEntryId": "github-mcp",
      "axis": "${mcpAxis}",
      "offeredAt": "<ISO-8601 timestamp>",
      "response": "customize",
      "artifactPaths": [".mcp.json"],
      "customizationNote": "scoped the token to read-only"
    },
    {
      "catalogEntryId": "security-review",
      "axis": "${skillAxis}",
      "offeredAt": "<ISO-8601 timestamp>",
      "response": "no",
      "reason": "not relevant to this repo"
    }
  ]
}
\`\`\`

Rules for the log:
- **One \`entries\` element per suggestion you offered**, in offer order — yes, customize, and no alike.
- \`detection\` captures what Phase 1 observed (the scan results, or the answers from the verbal-interview fallback). Best-effort: empty arrays mean "not detected", not "absent".
- \`artifactPaths\` is present for \`yes\`/\`customize\` (omit it for register-only accepts that wrote nothing, and for \`no\`).
- \`customizationNote\` is present only for \`customize\`. \`reason\` is present only for \`no\`.
- Use real ISO-8601 timestamps. \`schemaVersion\` is \`"1"\`.

Write the log last, after the menu is complete, so it reflects the full session.

---

## Summary

DETECT (report findings as prose; degrade to a verbal interview when files are unreadable) → ITERATE the catalog across \`${deploymentAxis}\`, \`${skillAxis}\`, \`${mcpAxis}\`, one suggestion at a time, ≤5 per axis → ASK yes/customize/no per item → WRITE only accepted artifacts by copying the entry's template files → ALWAYS write \`${LOG_ARTIFACT_PATH}\`. The log is mandatory; everything else is opt-in.`;
}
