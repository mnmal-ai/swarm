# Project Structure

`swarm init` creates a `.swarm/` directory in your project with structured context files. These files are the **seed source** — on first run, their content is seeded into the Substrate store (Postgres) as typed entities. At runtime, agents load context from Substrate, not from disk.

## The `.swarm/` Directory

```
.swarm/
├── swarm.json               # Router manifest — maps intents to swarm files
├── .swarm-meta.json          # Install metadata (used by swarm uninstall)
│
├── core/                    # Layer 1: Always loaded
│   ├── values.md            # Engineering principles, quality bar
│   ├── rules.md             # Hard constraints (never force push, etc.)
│   └── voice.md             # Communication standards
│
├── modes/                   # Layer 2: Loaded by classified intent
│   ├── code-review.md       # How to review a PR
│   ├── implementation.md    # How to build a feature
│   ├── investigation.md     # How to debug/research
│   └── orchestration.md     # How to plan multi-task work
│
├── capabilities/            # Layer 3: How-to docs
│   ├── git-workflow.md      # Branching, commits, PRs
│   └── testing.md           # What/how to test
│
├── domains/{project}/       # Layer 4: Project-specific context
│   ├── overview.md          # Tech stack, structure, key files
│   ├── conventions.md       # Naming patterns, code templates
│   ├── architecture.md      # Data flow, layer boundaries
│   ├── constraints.md       # Protected files, runtime limits
│   ├── definition-of-done.md # Build/test commands that must pass
│   ├── environment.md       # Environment variables (names, not values)
│   ├── secrets.md           # Secret locations, setup instructions
│   ├── goals.json           # Current work items with acceptance criteria
│   └── config.json          # Model, backend, trust level settings
│
├── designs/                 # Mockups, screenshots, Figma URLs
│   └── README.md
│
├── skills/                  # Third-party knowledge
│   ├── core/                # Team-authored, authoritative
│   ├── vetted/              # Reviewed and adopted
│   └── community/           # Reference only
│
├── oversight/               # Review policy definitions
│   └── review-policy.json
│
└── telemetry/               # Legacy directory (no longer used at runtime)
```

> **Telemetry storage:** Telemetry is no longer written as JSONL files to `telemetry/events/`. All telemetry is written as Substrate entities (`SessionEvent`, `OversightChain`, `TranscriptEntry`) to Postgres via the Substrate sidecar. The `telemetry/` directory may still exist in older projects but is not used at runtime.

## Substrate Seeding

The `.swarm/` directory is the authoring format. On first run (or via `swarm init`), the SDK seeds swarm content into Substrate:

- `swarm.json` routes become `SwarmRoute` entities
- Markdown files (`core/`, `modes/`, `capabilities/`, `domains/`, `skills/`) become `SwarmContent` entities
- Context budget config becomes `SwarmConfig` entities
- `goals.json` entries become `Goal` entities

Seeding is idempotent — it can be re-run safely. After seeding, the Substrate store is the runtime truth. Editing a `.swarm/` file requires re-seeding to take effect.

The `packages/substrate/` package holds the client and the sidecar lifecycle, `packages/substrate-plugin/` the `swarm` coordinator plugin (types and resolvers), and `packages/substrate-shared/` the types both use.

## Key Files

### `swarm.json`

The router manifest. Agents read this first. Maps intents to file paths with keyword hints and context budgets.

`swarm run` also reads its `complexity` section at startup. Every task's description is scored 0-100 on its wording (conjunctions, action verbs, scope words like "every", file references, migration phrasing, length) and banded:

```json
"complexity": {
  "simple_max": 30,
  "complex_min": 61,
  "escalation": { "token_fraction": 0.5, "turn_fraction": 0.7, "timeout_fraction": 0.6 }
}
```

- `simple_max` / `complex_min` — a score at or below `simple_max` is simple, at or above `complex_min` is complex, anything between is moderate. The band sets the task's timeout in parallel runs (5 / 10 / 15 minutes) and, as the project's `decomposition` policy allows, whether the task is split into sub-tasks (see `config.json` below).
- `escalation` — fractions of a moderate task's token, turn and time limits at which its escalation watcher stops it so it can be split. Any fraction left out keeps the default shown. The old `cost_fraction` key stops the run at startup; rename it to `token_fraction`.

Without the section, `swarm run` uses the values above. A section it cannot use — `simple_max` at or above `complex_min`, a value that is not a number — stops the run before any work, naming the file and the key. The banner's `Complexity` row shows the thresholds in force and whether they came from `swarm.json`.

### `config.json`

Per-project configuration in `domains/{project}/config.json`:

```json
{
  "project": "my-app",
  "trust_level": "medium",
  "maxTurns": 10,
  "isolation": "session",
  "models": {
    "worker": "claude-sonnet-4-6",
    "reviewer": "claude-sonnet-4-6",
    "arbiter": "claude-opus-4-6"
  },
  "backends": {
    "worker": {
      "type": "claude-code",
      "fallback": "api"
    }
  }
}
```

- `backends.<role>.type` — `claude-code`, `codex` or `api`, chosen per role (`worker`, `reviewer`, `arbiter`). A `codex` role runs the OpenAI Codex CLI (`codex exec`) with the operator's own install and sign-in. Swarm keeps the operator's Codex config, skills, plugins and memories out of the session, enforces the role's `permissions.deniedTools` through a hook it tests before every session, and routes build and test commands through fnl. `models.<role>` names the Codex model; left out, Codex uses its default. Document reads are not limited in codex sessions. What a codex session cannot do: write outside its working directory (and the few `.git` folders a commit needs), push (git there has no credentials, no SSH and no credential helper), or edit with Codex's edit tool in a role without `Edit`/`Write`. What it can do, as an unsandboxed Claude worker can: read any file on the machine, including sign-ins such as `~/.codex/auth.json` and `~/.ssh`, reach the network (tests need local servers), and change files through shell commands in any role. Run codex roles only on machines and repositories you would trust a Claude worker with.
- `maxTurns` — Maximum number of agent turns per task before forced completion.
- `isolation` — Session isolation level (`"session"` or `"task"`). Controls whether parallel workers share Substrate state.

#### `concurrency` — workers and token budgets

```json
"concurrency": {
  "max_workers": 3,
  "max_tokens_per_session": 60000000,
  "max_tokens_per_goal": 20000000,
  "max_tokens_per_task": 6000000
}
```

Budgets are in tokens only. A token count is all input tokens (fresh input, cache reads and cache writes) plus output tokens. At each task boundary `swarm run` warns at 80% of `max_tokens_per_session` and pauses once it is exceeded; a goal over `max_tokens_per_goal` skips its remaining tasks; a task over `max_tokens_per_task` stops at the limit (API backend) or is flagged when it ends (Claude Code), and the run asks whether to raise the limit to 1.5× what the task used, skip the task, or stop. Any limit left out takes the trust level's default:

| Trust | Per task | Per goal | Per session |
|---|---|---|---|
| `low` | 3M | 12M | 20M |
| `medium` | 6M | 20M | 60M |
| `high` | 12M | 40M | 120M |

The same keys can be set in an explicit `autonomy.execution` block.

Dollar limits are gone. A config that still has one stops `swarm run` at startup, naming the key to use instead:

| Old key | New key |
|---|---|
| `max_cost_per_session` | `max_tokens_per_session` |
| `max_cost_per_goal` | `max_tokens_per_goal` |
| `max_cost_per_task` | `max_tokens_per_task` |
| `complexity.escalation.cost_fraction` (swarm.json) | `complexity.escalation.token_fraction` |

#### `decomposition` — how much swarm splits work

Swarm splits work at two levels: the planner turns a goal into tasks, and a task may be split into sub-tasks (one level deep; sub-tasks are never split again). `decomposition` controls both:

```json
"decomposition": {
  "max_tasks": 3,
  "sub_decompose": "on_failure"
}
```

- `max_tasks` — the most tasks the planner may make of one goal (a whole number, at least 1). The planner is asked for at most that many ("exactly one task that does the whole goal" for 1). If it returns more anyway, every task after the (N-1)th is folded into task N: its description lists each merged task's title and description as numbered steps, their file claims are combined, dependencies between them are dropped, and the merged task is `implementation` if any of them was. `swarm run` prints how many were folded; no work is dropped. Unset: no cap.
- `sub_decompose` — when a task may be split into sub-tasks:
  - `"auto"` (default) — in a single-worker run, a complex task is split before it runs and a moderate one starts a standby sub-plan alongside it, used if it escalates (parallel runs never split up front). A failing task is split: one that escalates in a single-worker run, one that times out in a parallel run.
  - `"on_failure"` — nothing is split before it runs. A failing task is split, as under `"auto"`.
  - `"never"` — nothing is split. A task that fails fails, or escalates, as usual.

Splitting on failure also needs `autonomy.escalation.decompose_on_failure` to be true (the trust presets set it false for `low`, true for `medium` and `high`). With it false, `"on_failure"` behaves as `"never"`, and `"auto"` splits complex tasks up front but nothing else. The escalation watcher and the standby sub-plan exist only to split a failing task, so they run only when splitting on failure is allowed.

Without the block: no cap, `"auto"` — swarm's behaviour before this setting existed, except that splitting on failure now honours `decompose_on_failure`. A malformed block (a `max_tasks` that is not a whole number of at least 1, an unknown mode, an unknown key) stops `swarm run` at startup, naming the file and the key. The banner's `Decompose` row shows the policy in force, e.g. `on failure · max 3 tasks` or `auto · no cap`.

A single goal can override the policy — see `split` under `goals.json`.

### `goals.json`

Current work items with acceptance criteria, constraints, and dependencies:

```json
{
  "goals": [
    {
      "id": "goal-1",
      "description": "Implement user authentication",
      "priority": 1,
      "status": "pending",
      "acceptance_criteria": [
        "Login endpoint returns JWT",
        "All auth endpoints have tests"
      ],
      "constraints": ["JWT RS256 only"],
      "dependsOn": []
    }
  ]
}
```

- `split` (optional) — overrides the project's `decomposition` for this goal. `false`: the planner makes one task and nothing is split. `true`: no task cap and `sub_decompose: "auto"`. Unset: the project's policy.

Goals taken from a Trello card or a GitHub issue get `split` from the ticket's labels: `swarm_split: false` or `swarm_split: true` (any case, with or without spaces around the colon). A ticket carrying both runs as `swarm_split: false`, and `swarm run` warns, naming the goal, before it starts.

## Generated Skill Files

`swarm init` also creates a skill file for your AI tool (outside `.swarm/`):

| Tool | File |
|---|---|
| Claude Code | `.claude/commands/prepare-for-swarm.md` |
| Cursor | `.cursor/rules/prepare-for-swarm.mdc` |
| Copilot | `.github/copilot-instructions.md` (appended) |
| Universal | `SWARM-PROMPT.md` |

These prompt your AI assistant to scan the codebase and populate the swarm files with production-quality content.
