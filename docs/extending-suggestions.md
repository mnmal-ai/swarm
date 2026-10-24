# Extending the Suggestion Catalog

The suggestion catalog powers `/prepare-for-swarm`. It replaces the old static
onboarding template with a menu-driven flow: detect the environment, then offer
per-item yes/customize/no choices across three axes. The catalog ships as pure
data — no runtime logic, no LLM calls, backend-neutral. This doc explains the
data model so you can add entries.

Source of truth for every shape below:
[`packages/cli/src/scaffold/suggestions/types.ts`](../packages/cli/src/scaffold/suggestions/types.ts).
The catalog data lives in
[`packages/cli/src/scaffold/suggestions/catalog.json`](../packages/cli/src/scaffold/suggestions/catalog.json),
an object with an `entries` array of `CatalogEntry` objects. When the code and
this doc disagree, the code wins — update the doc.

## The `CatalogEntry` schema

One entry is one suggestion. Field names below match `types.ts` exactly.

| Field | Type | Required | Purpose |
|---|---|---|---|
| `id` | `string` | yes | Stable kebab-case id, unique across the catalog. Keys the suggestions-log transcript and names the template directory (`templates/<id>/`). |
| `axis` | `SuggestionAxis` | yes | Which of the three axes this entry belongs to. See below. |
| `title` | `string` | yes | Short human-facing label shown in the menu. |
| `suggestionText` | `string` | yes | Full text presented to the user for the yes/customize/no choice. |
| `detection` | `DetectionSignal[]` | yes | Signals that decide whether the entry is offered. ANY match (OR) offers it; an empty array means "always offer". |
| `templateFiles` | `string[]` | yes | Files copied into the project on accept, each relative to `templates/<id>/`. MAY be empty for register-only entries (e.g. an MCP server that is registered, not scaffolded). |
| `rationale` | `string` | no | Human-readable reason the entry is suggested. Reserved for future ranking/explanation; currently unused. |
| `impact` | `'low' \| 'medium' \| 'high'` | no | Coarse impact estimate. Reserved for future ranking; currently unused. |

## The three axes

`SuggestionAxis` is derived from the `SUGGESTION_AXES` const array — a closed set
of exactly three string identifiers:

- **`deployment-completion`** — artifacts that let the swarm drive and gate a
  deploy: a deploy capability, a verify-deployment task, a ship-readiness
  checklist. These fill the gap between "code works locally" and "code is
  deployed."
- **`skill`** — reusable agent skills tailored to the repo's stack and tooling
  (schema doctors, route reviewers, coverage enforcers).
- **`mcp`** — MCP server registrations the repo would benefit from, so the agent
  can reach the right external tools.

Cap each axis at 4–5 offered entries to avoid choice fatigue.

## Detection signals

A `DetectionSignal` decides whether an entry is relevant to the current repo.
Signals are pure: file-system- or env-readable checks, never LLM calls or repo
code execution. When the backend can't read files, detection degrades to a
verbal interview and signals are skipped.

`DetectionSignal` is a discriminated union on `kind`. The three kinds and their
exact payload fields:

| `kind` | Payload field | Relevant when |
|---|---|---|
| `dependency` | `pattern: string` | A `package.json` dependency name matches the regex `pattern`. |
| `file` | `glob: string` | A file matching `glob` (relative to repo root) exists. |
| `env` | `name: string` | The environment variable `name` is set. |

> Note: these code identifiers (`dependency`, `file`, `env`) are the
> dependency-regex, file-presence, and env-var signal kinds respectively. Use
> the code identifiers in catalog entries.

An entry declares its signals inline in the `detection` array. Mixed kinds are
fine; matches are OR-ed. Example (from `vercel-deploy`):

```json
"detection": [
  { "kind": "file", "glob": "vercel.json" },
  { "kind": "file", "glob": "vercel.ts" },
  { "kind": "dependency", "pattern": "^vercel$" },
  { "kind": "file", "glob": ".vercel/**" }
]
```

This entry is offered if either Vercel config file exists, the `.vercel`
directory exists, or a dependency named exactly `vercel` is present.

## Template files

Each entry's template files live in `suggestions/templates/<entry-id>/`. The
directory name is exactly the entry's `id`. The `templateFiles` array lists bare
filenames relative to that directory.

**Rule: every template referenced by an entry MUST exist on disk.** This is
enforced by
[`tests/integration/suggestion-catalog.test.ts`](../tests/integration/suggestion-catalog.test.ts),
which, per entry, asserts each `templateFiles` path (a) resolves inside the
entry's own `<id>` directory — no `..` traversal or absolute path — and (b)
exists. The same test also checks unique ids, that `axis` is one of
`SUGGESTION_AXES`, and that every `detection` signal has a known `kind` with a
non-empty payload field. A missing template file fails the suite, so add the
template in the same change as the entry that references it.

File-count conventions by axis:

- **`deployment-completion`** entries carry three files: `deploy-<target>.md`, a
  `verify-deployment-task.json`, and a `ship-readiness.json`.
- **`skill`** entries carry one Markdown file, typically `<id>.md`.
- **`mcp`** entries carry one JSON file, typically `<id>.json`.

<!-- ANCHOR: worked-example -->
## Worked example: adding a `biome-lint-enforcer` skill

This walks through one real entry end to end. The repo uses Biome, so a skill
that keeps Biome runs clean is a natural fit on the `skill` axis.

### 1. Choose the axis and id

It's a reusable agent skill, so the axis is `skill`. The id is the stable,
kebab-case handle that names both the suggestions-log key and the template
directory: `biome-lint-enforcer`.

### 2. Write the detection signals

Offer the entry only when the repo actually uses Biome. Biome shows up two ways —
a dependency and a config file — so use a mixed-kind `detection` array; matches
are OR-ed, so any one is enough to offer the entry:

```json
"detection": [
  { "kind": "dependency", "pattern": "@biomejs/biome" },
  { "kind": "file", "glob": "biome.json" },
  { "kind": "file", "glob": "biome.jsonc" }
]
```

`pattern` is a regex against `package.json` dependency names; `glob` is a
file-presence check relative to the repo root. (See [Detection
signals](#detection-signals) for the full kind/payload table.)

### 3. Author the template file

`skill` entries carry one Markdown file named `<id>.md` (see [Template
files](#template-files)). It lives at exactly:

```
packages/cli/src/scaffold/suggestions/templates/biome-lint-enforcer/biome-lint-enforcer.md
```

The directory name is the entry's `id`; the file is referenced by its bare name
in `templateFiles`. This file already exists in the repo — open it as a model for
the scaffolded-skill format (frontmatter `name`/`description`, a `DRAFT
scaffolded by /prepare-for-swarm` banner, then When/What/Workflow/Red-flags
sections).

### 4. Write the full catalog entry

Add this object to the `entries` array in
[`catalog.json`](../packages/cli/src/scaffold/suggestions/catalog.json). Every
field matches [the `CatalogEntry` schema](#the-catalogentry-schema): `id`,
`axis`, `title`, `suggestionText`, and `detection` and `templateFiles` are
required; `rationale` and `impact` are optional.

```json
{
  "id": "biome-lint-enforcer",
  "axis": "skill",
  "title": "Biome lint enforcer",
  "suggestionText": "This repo uses Biome for linting and formatting. Add a skill that enforces a clean Biome run on changed files: zero warnings, organized imports, and consistent formatting, treating a remaining warning as a blocker unless explicitly justified.",
  "detection": [
    { "kind": "dependency", "pattern": "@biomejs/biome" },
    { "kind": "file", "glob": "biome.json" },
    { "kind": "file", "glob": "biome.jsonc" }
  ],
  "templateFiles": ["biome-lint-enforcer.md"],
  "rationale": "Biome dependency or config detected.",
  "impact": "medium"
}
```

Note how the pieces stay in lockstep: the entry `id`, the template directory
name (`templates/biome-lint-enforcer/`), and the single `templateFiles` entry
(`biome-lint-enforcer.md`, resolved relative to that directory) all agree. That
internal consistency is exactly what the test in the next step gates.

### 5. Validate the entry

Run the catalog-shape test. The fastest loop runs just that file:

```sh
pnpm --filter @mnmal-ai/swarm-integration-tests test suggestion-catalog
```

The full suite — what CI runs, and the command to use before opening the PR —
covers it too:

```sh
pnpm turbo test
```

The shape gate is
[`tests/integration/suggestion-catalog.test.ts`](../tests/integration/suggestion-catalog.test.ts).
It loads the catalog through the public `loadCatalog` export (the same path the
runtime uses) and, for every entry, asserts the structural invariants the
matcher, prompt loop, and transcript depend on:

- **id** is present and kebab-case, and **unique across the whole catalog**.
- **axis** is one of `SUGGESTION_AXES` (`deployment-completion`, `skill`,
  `mcp`), and every axis has at least one entry.
- **title** and **suggestionText** are non-empty.
- **detection** is a non-empty array, and every signal has a known `kind`
  (`dependency`/`file`/`env`) carrying its non-empty payload field.
- **templateFiles** is an array, and — the must-exist rule — every listed file
  resolves *inside* the entry's own `templates/<id>/` directory (no `..`
  traversal, no absolute path) **and exists on disk**.

For `biome-lint-enforcer`, that last check is why step 3 is not optional: the
test stats `templates/biome-lint-enforcer/biome-lint-enforcer.md`, and a missing
file fails the suite. Add the template in the same change as the entry that
references it.
<!-- /ANCHOR: worked-example -->

<!-- ANCHOR: rationale -->
## Rationale and design decisions

### Why each axis is capped at 4–5 entries

The matcher can offer at most 4–5 entries per axis (see [The three
axes](#the-three-axes), where the cap is stated alongside the axis definitions).
This is a deliberate ceiling on *offered* suggestions, not on how many entries
the catalog may hold.

The reason is suggestion fatigue. `/prepare-for-swarm` is a menu-driven
onboarding flow: the user walks each offered entry and answers yes/customize/no.
That interaction only works while the menu stays short enough to read and decide
on in one pass. Across three axes, a 4–5 cap keeps the whole onboarding session
to roughly a dozen decisions — enough to meaningfully tailor the swarm, few
enough that the user engages with each choice instead of rubber-stamping or
abandoning the flow. Past that point the menu degrades: each additional prompt
lowers the attention paid to every other prompt, and a long list of low-signal
suggestions trains the user to mash "no" — which defeats the purpose of
detecting and offering tailored artifacts at all.

The cap is therefore a quality lever, not a storage limit. The catalog can carry
more than 4–5 entries per axis; [detection signals](#detection-signals) are what
keep the *offered* set small and relevant to the repo in front of the user. When
two entries on the same axis would both fire for a typical repo, prefer
sharpening their detection (so only the relevant one offers) over shipping both
and blowing past the cap.

### Why the catalog ships in-SDK for v0.x (Decision Q)

For the v0.x line the suggestion catalog — `catalog.json`, its `types.ts`
schema, and the `templates/<id>/` trees — ships **inside the SDK**, under
`packages/cli/src/scaffold/suggestions/`. It is not yet a standalone package.

This is a recorded decision (plan Decision Q), not a deferred TODO. Keeping the
catalog in-SDK while it is small avoids a premature package boundary: a separate
package would add its own versioning, release cadence, and a published interface
between the matcher and its data — overhead that buys nothing while the catalog
and the code that consumes it move together in lockstep (the same lockstep the
[worked example](#worked-example-adding-a-biome-lint-enforcer-skill) relies on,
where an entry and its template land in one change and are gated by one test).

The migration trigger is concrete: once the catalog grows past **~20 entries**,
it extracts into a dedicated `@mnmal-ai/swarm-suggestions` package. At that scale
the catalog has its own contributors and review cadence, the in-SDK coupling
starts to cost more than it saves, and an independent release line becomes worth
its overhead. Until that threshold is crossed, in-SDK is the intended home, and
new entries should be added here per [the `CatalogEntry`
schema](#the-catalogentry-schema) without reaching for a new package.

_Two further rationale topics — why suggestions are pure JSON with no LLM calls,
and why `.swarm/.suggestions-log.json` is the single mandatory artifact while
every other suggestion is opt-in — are documented separately._
<!-- /ANCHOR: rationale -->
