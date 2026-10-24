# CLAUDE.md

This is the **Swarm SDK**: a TypeScript monorepo that integrates AI agents with the Swarm context system. All storage lives in Substrate, a typed data engine backed by Postgres, reached over HTTP through the `@mnmal-ai/swarm-substrate` client.

## What This Does

The SDK wraps any LLM API call with swarm-powered context loading, typed oversight, and structured telemetry:

```
Task -> classify intent via Substrate query -> load context from the Substrate store -> call LLM API -> typed Substrate oversight chain -> Substrate telemetry entities
```

Swarm content, oversight artifacts, telemetry events, goals, learning entries and observations are all Substrate types in Postgres. The human-facing CLI renders all data back to readable prose.

## Infrastructure

### Substrate sidecars

Two Substrate sidecars serve the swarm: the **cold sidecar** (namespaces `swarm`, `swarm-docs` and the cortext context store) and the **meta sidecar** (namespace `swarm_meta`). Each runs against its own Postgres 17 (pgvector) container. All SDK packages and CLI commands talk to them over HTTP.

| Port | Purpose | Lifetime |
|---|---|---|
| 32337 | Postgres for the cold sidecar | Working store; `swarm db reset` wipes it |
| 32338 | Cold Substrate sidecar | Serves the cold store |
| 32340 | Postgres for the meta sidecar | **Kept**; `swarm db reset` never touches it |
| 32341 | Meta Substrate sidecar | Serves the meta store |
| 42337-42341 | The isolated test stack (42337 Postgres, 42338 cold sidecar, 42340 meta Postgres, 42341 meta sidecar) | Tests and cold tests only |

Postgres binds loopback only. The sidecars need **Node 26.2 or newer** (`SWARM_NODE` names an absolute path to one; Bun is never used for them). A shipped Bun binary still needs a Node 26.2+ on the machine for the sidecars.

You do not start a sidecar by hand. `swarm run` (and every command that needs the store) brings up Postgres and both sidecars and waits for each to be healthy before it dispatches. The single documented entry point is:

```bash
swarm run
```

Escape hatches, for managing or inspecting the stack outside a run:

- `swarm substrate start` brings Postgres and both sidecars up without dispatching a task.
- `swarm substrate stop` stops this project's two sidecars. Postgres keeps running.
- `swarm substrate status` prints one line per sidecar (health and namespace count) and one per Postgres.
- `swarm doctor` prints a status table (Node, Substrate runtime, lsof on macOS, cold Postgres, cold sidecar, meta Postgres, meta sidecar, dashboard, CLI version) with a `fix:` line under every unhealthy row. It is safe to run with nothing up: it diagnoses and never starts anything.
- `swarm db setup|status|start|stop|reset` manages the machine-wide Postgres containers (`reset` wipes the cold store only; the meta volume is kept). It refuses to run for a project with a dedicated stack.
- `swarm drainstop` runs the drainstop pass now (see Key Design Decisions).

**The runtime directory.** The first bring-up installs the Substrate runtime from npmjs, pinned, into `~/.swarm/substrate/runtime`: `@mnmal-ai/substrate`, `@mnmal-ai/cortext` and the `@mnmal-ai/swarm-substrate-plugin` tarball that the CLI carries (`packages/cli/assets/swarm-substrate-plugin.tgz`, packed by `scripts/pack-substrate-plugin.sh`). A marker file keyed on a hash of the Substrate, cortext and plugin versions plus the tarball's sha256 makes later bring-ups a no-op; a changed marker stops every running stack and reinstalls. The plugin tarball is cached under `~/.swarm/substrate/cache`.

**Stack directories.** Each sidecar runs in `~/.swarm/substrate/stacks/<label>/` (`cold`, `meta`; a dedicated project's are `<compose_project>-cold` and `<compose_project>-meta`). A stack directory holds `swarm.config.json` (scope, namespace, context namespace), `substrate-recall.config.json` (the embedder), a `node_modules` symlink to the runtime's, `server.log` and `server.pid`. `swarm substrate stop` signals only a pid whose command line is `substrate.js serve`.

**Compose files.** `docker-compose.yml` (service `swarm-substrate`, database `swarm`, 127.0.0.1:32337) and `docker-compose.meta.yml` (service `swarm-meta`, database `swarm_meta`, 127.0.0.1:32340) are the repo's cold and meta Postgres files, with volumes `swarm_substrate_data` and `swarm_meta_data`. `swarm db setup` writes the same templates under `~/.swarm/infrastructure`. A compose file counts as swarm's only if it declares `swarm-substrate`.

Key environment variables are listed in `environment.md` (`SWARM_SUBSTRATE_ENDPOINT`/`_PORT`/`_POSTGRES_URL`, `SWARM_META_*`, `SWARM_SUBSTRATE_LOCAL_ONLY`, `SWARM_EMBEDDER_*`, `SWARM_NODE`).

### Dedicated per-project stacks and `substrate.local_only`

By default every swarm project on a machine shares one Substrate stack (cold sidecar 32338 on Postgres 32337, meta sidecar 32341 on Postgres 32340), so one project's runs can read another's content. A project gets its own stack (its own cold and meta sidecars and its own Postgres containers and volumes) with a `substrate` block in `.swarm/config.json` (applies to every domain in that `.swarm/`; a domain's `.swarm/domains/<project>/config.json` may also carry one, and wins per key):

```json
{
  "substrate": {
    "local_only": true,
    "port": 45002,
    "postgres_url": "postgresql://swarm:swarm@127.0.0.1:45001/swarm",
    "meta_port": 45005,
    "meta_postgres_url": "postgresql://swarm:swarm@127.0.0.1:45004/swarm_meta",
    "compose_file": "substrate/docker-compose.yml",
    "compose_project": "swarm-project-a"
  }
}
```

- `port` / `postgres_url` / `meta_port` / `meta_postgres_url` are all-or-nothing (a partial set would still share the missing store). swarm turns them into `SWARM_SUBSTRATE_PORT`, `SWARM_SUBSTRATE_ENDPOINT`, `SWARM_SUBSTRATE_POSTGRES_URL`, `SWARM_META_PORT`, `SWARM_META_ENDPOINT` and `SWARM_META_POSTGRES_URL` for itself and the sidecars it spawns, and sets `SWARM_SUBSTRATE_DEDICATED=1` (plus `SWARM_SUBSTRATE_LOCAL_ONLY=1` only when `local_only` is true). An environment variable that disagrees is an error naming the variable and both values, not an override.
- `compose_file` (relative to the config file) requires `compose_project`, and the four stack keys must be present: swarm brings the project's Postgres up with `docker compose -p <compose_project> -f <compose_file> up -d --wait` when it is down. Copy swarm's `docker-compose.dedicated.yml` there (services `swarm-substrate` and `swarm-meta`, published on 127.0.0.1 only, ports from `SWARM_DEDICATED_PG_PORT` and `SWARM_DEDICATED_META_PG_PORT`); the compose project name keeps the volumes separate. `compose_project` may stand without `compose_file`, to name the stack, but never without the four stack keys; without it the stack is `swarm-dedicated-<port>`.
- A dedicated project never adopts another sidecar: no port scan, no `substrate_url` read or written, and `swarm db start|stop|reset|setup` refuse to run.
- `local_only: true` in any top-level object block of the swarm-dir config or of any domain config (whatever the block is called; only the `substrate` block supplies the stack keys) turns the guard on, and no other file can turn it off. It makes swarm refuse to start, with exit 1, unless every endpoint its context engine would use is loopback: the cold endpoint from whichever source `resolveSubstrateEndpoint` picked (explicit, `SWARM_SUBSTRATE_ENDPOINT`, `substrate_url` in `~/.swarm/config.json`, `SWARM_SUBSTRATE_PORT`, default), the meta endpoint, both Postgres URLs, and `SWARM_EMBEDDER_OLLAMA_URL`. `telemetry_sharing.enabled` is refused too. `ensureSidecar` re-checks the spec's Postgres and the stack's recall embedder URL before it spawns anything, and the sidecar's bind address is forced to 127.0.0.1 through `HOST`.

Bring-up for such a project (from its repo root): `swarm substrate start`, then `swarm doctor` should show the project's ports. `swarm substrate status` reports that project's sidecars and Postgres, and `swarm substrate stop` stops its two sidecars only, never the shared ones, leaving its Postgres containers and volumes running. Tear down its data with `docker compose -p <compose_project> -f .swarm/<compose_file> down -v` (with `SWARM_DEDICATED_PG_PORT` / `SWARM_DEDICATED_META_PG_PORT` set).

### Seeding

Reads the swarm content repo and populates the Substrate store with SwarmConfig, SwarmContent, and SwarmRoute entities:

```bash
npx tsx scripts/seed-swarm.ts --swarm-path <path-to-swarm-repo> --project <project-id>
```

Example: `npx tsx scripts/seed-swarm.ts --swarm-path tests/fixtures/content --project todo-test`

The script talks to the cold sidecar (`--endpoint`, default `http://localhost:32338`), so bring the stack up first with `swarm substrate start`. Seeding is idempotent and can be re-run safely. `swarm sync` and the first `swarm run` seed the same way.

## Repo Layout

Package manager: **pnpm**. Monorepo tool: **Turborepo**.

```
packages/
  types/             # @mnmal-ai/swarm-types — Shared TypeScript interfaces
  events/            # @mnmal-ai/swarm-events — Event schemas and domain events
  worker-backends/   # @mnmal-ai/swarm-worker-backends — LLM provider adapters (Anthropic, OpenAI)
  task-backends/     # @mnmal-ai/swarm-task-backends — Task execution backends
  telemetry/         # @mnmal-ai/swarm-telemetry — Telemetry emission via Substrate entities
  core/              # @mnmal-ai/swarm-core — Swarm class, router, loader, executor (DI-based)
  oversight/         # @mnmal-ai/swarm-oversight — Reviewer/Arbiter chain, retry logic, escalation
  benchmark/         # @mnmal-ai/swarm-benchmark — Behavioral test runner, model comparison
  orchestrator/      # @mnmal-ai/swarm-orchestrator — Multi-task DAG workflows, replanning
  cli/               # @mnmal-ai/swarm-cli — CLI entry point ("swarm" command)
  substrate/         # @mnmal-ai/swarm-substrate — HTTP client, document sync, sidecar and Postgres lifecycle
  substrate-plugin/  # @mnmal-ai/swarm-substrate-plugin — The swarm coordinator plugin: types, resolvers, drainstop (packed into the CLI as a tarball)
  substrate-shared/  # @mnmal-ai/swarm-substrate-shared — Constants and resolver types shared by the client and the plugin
  swarm/             # swarm — Backward-compatible re-export package
tests/
  integration/       # Cross-package integration tests
dashboard/           # Post-mortem analytics SPA (npm, separate from the pnpm packages)
```

All packages use the `@mnmal-ai/swarm-<name>` naming convention (except the root `swarm` compat package).

Companion repos:

- `swarm` — The swarm content repo (context files, routing config, tests, schemas). Content is seeded into Substrate from this repo.
- `swarm-dashboard` — React SPA that visualizes telemetry. Currently reads summary JSON; will be bridged via CLI export.

Substrate (`@mnmal-ai/substrate`), the cortext context store (`@mnmal-ai/cortext`) and `@mnmal-ai/context-render` are consumed from npmjs at exact pinned versions; no token and no sibling checkout is needed.

## Build and Test Commands

```bash
pnpm install                              # Install all dependencies (npmjs only)
pnpm turbo build                          # Build all packages (regenerates packages/cli/src/version.ts; never commit it)
pnpm turbo test                           # Run all tests
pnpm turbo lint                           # Lint all packages
pnpm --filter @mnmal-ai/swarm-<name> test      # Test one package
turbo test --filter=@mnmal-ai/swarm-<name>...  # Test package + its deps
turbo test --affected                     # Test only changed packages
```

Tests never touch the real `~/.swarm`, never bind the default ports 32337-32341, and never start Docker unless you opt in. Run them with `ANTHROPIC_API_KEY` unset:

```bash
env -u ANTHROPIC_API_KEY pnpm turbo test                                     # plain: mocked clients, no process, no network
SWARM_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests   # E2E: spawns two real `substrate serve` sidecars (memory store, ephemeral loopback ports, HOME in a temp dir)
SWARM_SDK_E2E=1 SWARM_SDK_CLAUDE=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests   # also the paid suites (the `claude` CLI, the Anthropic API)
SWARM_SDK_E2E=1 SWARM_SDK_PG=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests       # E2E sidecars on the Docker alt-port Postgres (docker-compose.test.yml, 42337 and 42340)
```

`SWARM_SDK_E2E=1` is what makes `tests/setup/isolated-substrate.ts` start anything; the overrides it sets (`SWARM_SUBSTRATE_ENDPOINT`, `SWARM_SUBSTRATE_PORT`, `SWARM_META_ENDPOINT`, `SWARM_META_PORT`) exist in the test process only, never in your shell. Recall suites run when a local Ollama answers and skip otherwise.

### Testing against an isolated Substrate

Swarm's own test runs never touch the default-port stack. Unit and integration tests use a mocked `SubstrateClient`; any test that needs a **real** sidecar runs against a private one. The vitest `globalSetup` at `tests/setup/isolated-substrate.ts` does nothing unless `SWARM_SDK_E2E=1`; then it starts two `substrate serve` processes from the workspace's own install on ephemeral loopback ports and scopes the endpoint variables to the test process only (see Build and Test Commands). With no env set, the defaults (32337-32341) remain intact (the `env ?? default` pattern), so a test run leaves a stack on the default ports alone. Cold tests use `scripts/cold-test-env.sh` (see the Cold-Test Runbook below).

Outside tests, bring the stack up with `swarm run` or `swarm substrate start` (see Infrastructure), then seed with `npx tsx scripts/seed-swarm.ts --swarm-path tests/fixtures/content --project todo-test`.

> **Internal / last resort, not the documented step.** A sidecar is `node ~/.swarm/substrate/stacks/<label>/node_modules/@mnmal-ai/substrate/dist/substrate.js serve` run inside its stack directory with `SUBSTRATE_DATABASE_URL`, `SUBSTRATE_PLUGIN_DIR`, `SUBSTRATE_SYSTEM_ACTOR`, `HOST` and `PORT` set. Invoke it directly only when debugging the lifecycle machinery itself; normal operation goes through `swarm run`.

## Key Design Decisions

These are settled. Do not revisit without explicit instruction.

- **JSON over YAML.** All config and schemas use JSON. See swarm repo ADR-001.
- **Model-agnostic.** Worker backends implement the `Adapter` base class + domain-specific interface from `@mnmal-ai/swarm-types`. Adding a provider means implementing a new adapter.
- **Separate context windows for oversight.** The reviewer and arbiter make their own API calls — they do not share the worker's context.
- **Task dependencies as DAG.** Tasks declare `dependsOn` fields. The orchestrator topologically sorts them into execution tiers.
- **Failure-driven replanning.** After a goal completes, failures are categorized and the system decides to retry, decompose, or escalate.
- **Pre-review validation.** Worker output is validated as non-empty before sending to the Reviewer.
- **Lockstep versioning.** All packages share the same version. Semantic-release bumps all packages together.
- **Swarm content in Postgres, not files.** Markdown files are seeded into Substrate entities. The Substrate store is the runtime truth. Files are the authoring format; entities are the runtime format.
- **Typed oversight.** Worker/Reviewer/Arbiter exchange typed Substrate entities (WorkerResult, ReviewVerdict, ArbiterDecision) with selective field access. The Reviewer can request only the fields it needs — `diff` and `intent` without `tokenUsage`.
- **Telemetry entities, not JSONL.** Events are Substrate entities (SessionEvent, OversightChain, TranscriptEntry), not append-only files. No daily file rotation. No summary aggregation scripts.
- **Sidecar architecture.** The Substrate server runs as a separate process. CLI, agents, and orchestrator all query the same store. Multiple parallel workers share the store concurrently.
- **Token budgets, never dollars.** Every budget is in tokens — all input (fresh, cache reads, cache writes) plus output — at session, goal and task level: `concurrency.max_tokens_per_session`, `max_tokens_per_goal`, `max_tokens_per_task` in the project's `config.json` (or `autonomy.execution`), defaulting per trust level (medium 60M / 20M / 6M). Swarm computes, stores and shows no currency. A config with a dollar key refuses to start and names its replacement: `max_cost_per_session` → `max_tokens_per_session`, `max_cost_per_goal` → `max_tokens_per_goal`, `max_cost_per_task` → `max_tokens_per_task`; in `swarm.json`, `complexity.escalation.cost_fraction` → `token_fraction`. See `docs/project-structure.md`.
- **Swarm picks the GitHub account; workers get none.** `source_control.github_account: "<login>"` (optional, per project, validated with the other `source_control` keys) names the account swarm's own GitHub operations run as. `swarm run` resolves its token once at start (`gh auth token --user <login>`, argv, no shell) into a `GitHubCredential` (`packages/types/src/github.ts`: private field, never serialized, logged or put in `process.env`) and passes it as `GH_TOKEN` in a per-call env to swarm's own gh calls — `SourceControlManager` PR creation, the GitHub task backend and goal source (`runCli`) — and to `git push` to an HTTPS GitHub remote (per-command `-c credential.helper= -c credential.helper=!gh auth git-credential`; SSH remotes untouched). Before any work it checks the account is logged in, the token is the account's (`gh api user`), the account can see the repo `origin` names (`gh api repos/<owner>/<repo>`), and warns if `git_identity.email` is another account's noreply address (`packages/cli/src/cli/github-account.ts`). The preflight banner's Credentials block shows `GitHub  <login> ✓ <owner>/<repo>`, or gh's active account when the setting is absent. Worker, reviewer and arbiter processes (Claude Code backend, and the API loop's `run_command`) get none of `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` and an empty per-run `GH_CONFIG_DIR` (`BackendConfig.ghConfigDir`; a per-process empty default when unset), so gh inside them has no login; denied-command lists stay as a second layer. Workers therefore never open PRs: `stack_prs: true` requires `strategy: "remote_pr"` (swarm pushes and opens the stacked PRs at session end), any other strategy or none is refused at startup by `validateSourceControlConfig`, and workers get no `SWARM_GOAL_BRANCH`/`SWARM_BASE_BRANCH` hints. `swarm logs`, `swarm init`/sharing and `swarm upgrade`'s gh fallback still use gh's active account — they act for the operator, not a project.
- **External dependency manifest.** `packages/cli/src/external-deps.ts` declares tools swarm runs but does not ship — one data object each (command, version args and pattern, tested major, behaviours relied on). It holds gh (tested major 2). When a run will use gh, `swarm run` runs `gh --version` and warns, naming both versions, if the installed major differs. Reporting versions back to a server is not implemented (needs its own design).

- **HTTP-only client with page-cursor following and in-frame idempotency keys.** `SubstrateClient` speaks plain HTTP to `/substrate/v1/query` and `/substrate/v1/mutate`; there is no WebSocket and no push channel (`subscribeOrPoll` polls). A `query()` that is given neither `limit` nor `cursor` follows `_pagination[key].nextCursor` and returns every row. Every mutation frame carries a fresh `idempotencyKey` inside its entry, which is where Substrate de-dupes. A frame the server refuses (an `errors` entry for its key, or a key missing from `data`) throws `SubstrateFrameError` instead of returning an empty result.
- **Recall through the engine.** `classifyIntent`, `loadContext` and `prepareTask` are custom queries of the `swarm` plugin. They recall through Substrate's own recall plugin (embeddings in pgvector, local Ollama by default) and read the `swarm-docs` namespace through the engine handle. With no embedder they degrade to the keyword and path baseline.
- **Observations and drainstop promotion into cortext.** Agents write `Observation` rows with `observe()` (fire-and-forget, never confidence 50). The drainstop seeds the confidence-50 calibration anchor, promotes high-signal observations into the cortext context store (`fold-back-candidate` to Todo, `architectural` above confidence 80 to Decision, `user-framing` at confidence 100 to AgentRule, three or more `concern`s sharing a tag signature to one Todo), and expires the rest by TTL. Promotion runs only when triggered (`swarm drainstop`); the scheduled tick only expires. A refused promotion keeps its observation and is reported.


## Namespaces and Types

### Namespaces

Op-keys are fully qualified: `<namespace>/<TypeName>` for queries, `<namespace>/<mutationName>` for mutations. Swarm owns three namespaces, plus the cortext context store:

- `swarm` — the cold sidecar (port 32338): content, oversight, telemetry, orchestrator data and observations. **15 types:** SwarmConfig, SwarmContent, SwarmRoute, WorkerResult, ReviewVerdict, ArbiterDecision, SessionEvent, OversightChain, TranscriptEntry, Goal, TaskExecution, LearningEntry, McpServer, FailurePostmortem, Observation.
- `swarm_meta` — the persistent meta store (port 32341): institutional memory. **5 types:** SessionLog, Decision, CodeLandmark, ColdTestRun, BugReport.
- `swarm-docs` — the cold sidecar: the project's markdown stored as sections. **2 types:** Document, Section.
- `cortext` — the durable context store the drainstop promotes into (Decision, Todo, AgentRule, Concept, SessionLog).

Callers don't write the namespace by hand: each `SubstrateClient` is constructed with a namespace and prepends it on every call. The namespace defaults to `swarm`; pass `{ namespace: 'swarm_meta' }` for the meta client.

**Four custom operations** are registered by the swarm plugin on the `swarm` namespace: three queries (`loadContext`, `classifyIntent`, `prepareTask`) and one mutation (`persistTaskTelemetry`, which writes a task's SessionEvent, TranscriptEntry, WorkerResult and optional ReviewVerdict in one atomic call).

All types are declared in `packages/substrate-plugin/src/types/` with Substrate's `field` DSL; autoCRUD generates `create<Type>`, `update<Type>`, `delete<Type>`, `get<Type>` and a list query per type. Filter with the `where` clause and its operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `startsWith`, ...); a bare param is not a filter. Number fields (token counts, latencies, `tokenEstimate`, `toolCount`) are sent as numbers. Cross-entity references are scalar id strings.

### Wire protocol

- `GET /substrate/v1/schema/<namespace>` — per-namespace schema, fetched once per namespace by `getSchema()`.
- `GET /substrate/v1/federated-schema` — every namespace the sidecar serves (used by `swarm substrate status`).
- `POST /substrate/v1/query` — selective field access:

```json
{ "swarm/SwarmContent": { "params": { "where": { "tier": { "eq": "always-load" } } }, "fields": { "path": true, "content": true } } }
```

- `POST /substrate/v1/mutate` — auto-CRUD or custom mutations:

```json
{ "swarm/createSwarmContent": { "params": { "path": "values.md", "content": "..." }, "fields": { "id": true }, "idempotencyKey": "..." } }
```

- `POST /substrate/v1/plugins/swarm/trigger-drainstop` — runs the drainstop pass (`swarm drainstop`).
- `GET /health` (top-level). The CLI's `client.isHealthy()` hits this on every command.

### observe()

`SubstrateClient.observe()` writes a single fire-and-forget Observation to `swarm/createObservation`:

```ts
observe(request: {
  kind: string;          // convention-typed, e.g. 'architectural' | 'concern' | 'rationale'
  content: string;       // the observation (-> the Observation `body` field)
  tags?: string[];       // joined to the comma-separated `tags` string
  confidence?: number;   // 0-100; omitted -> written as 0 ("just noting")
}): Promise<ObserveResponse | null>
```

- **Fire-and-forget.** Any failure (including a refused frame) is swallowed, logged (kind and message only; content may carry PII), and `null` returned.
- **Never writes confidence 50.** An unset `confidence` is written as `0`; the `confidence=50` calibration anchor is seeded by the drainstop and must not be overridden by an ordinary write (`isAnchor` stays null).
- The **worker, reviewer, and arbiter** roles emit observations during execution.

### Drainstop

`swarm drainstop` POSTs the plugin's trigger route and prints what was promoted (todos, decisions, agent rules, total), absorbed, expired, whether the anchor was seeded, and each failure as `phase · observationId · code: message`. The plugin's scheduled tick runs the TTL expiry every `drainstopIntervalMs` (plugin config, default 1 hour); promotion happens only on the trigger. Promotions write to cortext, which is pg-backed, so they survive a restart. Decision promotion uses `sessionId: null` (cortext 1.0.0-alpha.7 accepts it), and every promoted row carries a lineage marker so a human rejection can walk the anchor up.

### Batch 1 — Swarm Content (Phase 1)

**SwarmConfig** — Key-value pairs for context budget, recall and isolation config. (Complexity thresholds are not stored here: `swarm run` reads them from `swarm.json`'s `complexity` section at startup.)
- Fields: `key`, `value`, `category`

**SwarmContent** — One entity per swarm file (values.md, modes/code-review.md, etc.).
- Fields: `path`, `tier`, `intent`, `content`, `tokenEstimate`, `lastReviewed`, `projectId`

**SwarmRoute** — One entity per route (maps intents to content paths).
- Fields: `intent`, `description`, `keywords`, `contentPaths`

### Batch 2 — Oversight (Phase 2)

**WorkerResult** — Created after each Worker execution.
- Fields: `sessionId`, `intent`, `output`, `diff`, `filesModified`, `tokenUsage`, `timestamp` (plus a legacy nullable `costUsd` column swarm no longer writes)

**ReviewVerdict** — Created after each Reviewer execution.
- Fields: `sessionId`, `workerResultId`, `verdict`, `reasons`, `suggestions`, `attempt`, `timestamp`

**ArbiterDecision** — Created if the Arbiter is invoked.
- Fields: `sessionId`, `workerResultId`, `reviewVerdictId`, `verdict`, `reasoning`, `timestamp`

### Batch 3 — Telemetry (Phase 3)

**SessionEvent** — One entity per LLM invocation.
- Fields: `eventId`, `sessionId`, `role`, `provider`, `modelId`, `intent`, `swarmFilesLoaded`, `contextTokensUsed`, `inputTokens`, `outputTokens`, `latencyMs`, `timestamp` (plus a legacy nullable `costUsd` column swarm no longer writes)

**OversightChain** — Session-level oversight chain record.
- Fields: `sessionId`, `workerEventId`, `reviewerVerdict`, `rejectionReasons`, `retryCount`, `arbiterInvolved`, `arbiterVerdict`, `humanEscalation`, `totalResolutionTimeMs`, `timestamp`

**TranscriptEntry** — Full prompt/response transcript per invocation.
- Fields: `sessionId`, `role`, `prompt`, `response`, `inputTokens`, `outputTokens`, `backend`, `timestamp` (plus a legacy nullable `costUsd` column swarm no longer writes)

### Batch 4 — Orchestrator (Phase 4)

**Goal** — A goal for multi-task orchestration.
- Fields: `goalId`, `projectId`, `description`, `priority`, `status`, `acceptanceCriteria`, `constraints`, `dependsOn`, `timestamp`

**TaskExecution** — Tracks each dispatched sub-task.
- Fields: `goalId`, `sessionId`, `workerResultId`, `status`, `retries`, `startedAt`, `completedAt`

**LearningEntry** — Captures patterns learned from goal execution.
- Fields: `projectId`, `goalId`, `category`, `content`, `timestamp`

### Batch 5 — Integrations, post-mortems, observations

**McpServer** — One entity per registered MCP server.
- Fields: `name`, `command`, `args`, `type`, `toolCount` (number), `tools`, `projectId`, `lastIntrospected`

**FailurePostmortem** — Written when a task fails.
- Fields: `runId`, `taskId`, `goalId`, `failureCategory`, `schemaVersion`, `writtenAt`, `failureEvent`, `recentToolCalls`, `recentTranscriptTurns`, `taskVerdict`, `activeToolsAtFailure`, `lineage`

**Observation** — A cheap, fire-and-forget working-memory note written by workers, reviewers and arbiters.
- Fields: `ts`, `kind`, `body`, `context`, `confidence`, `tags` (comma-separated), `ttlHours`, `isAnchor`


### Types in the meta store:

| Type | Purpose |
|---|---|
| `SessionLog` | One entry per work session — branch, summary, decision count |
| `Decision` | Architectural choices with rationale. Supersedes field for evolution. |
| `CodeLandmark` | Notable file paths with purpose descriptions |
| `ColdTestRun` | Cold test metrics — goals, cost, first-pass rate, notes |
| `BugReport` | Bugs with symptom, root cause, fix, and the query that found it |

Use of the meta store is described under "Persistent Context Store" below.

## Development Notes

- The SDK expects Postgres running and the Substrate sidecars started before any operation; `swarm run` does both.
- The CLI checks `GET /health` before every command and prints a clear error if the server is not running.
- Token estimation still uses 1 token ~ 4 characters heuristic. Good enough for budgeting.
- Every dependency installs from npmjs. There is no `.npmrc` and no token.
- All public APIs are async. The SDK is designed to be used in Node.js environments.
- Each package has its own `tests/` directory. Cross-package integration tests live in `tests/integration/`.
- The router uses keyword matching for intent classification, plus embedding recall when an embedder is available.
- JSON arrays stored as fields (keywords, contentPaths, reasons, etc.) are serialized as JSON strings. The SDK parses them in application code.

## Conventions

- All config uses JSON, never YAML.
- All public methods are async.
- Errors should be typed and descriptive, not generic throws.
- Token estimation: 1 token ~ 4 characters. This is a heuristic for budget enforcement, not billing.
- Session IDs use the format `sess-{uuid}`.
- Event IDs use the format `evt-{ISO-date}-{sequence}`.
- Pluggable backends implement the `Adapter` base class + domain-specific interface from `@mnmal-ai/swarm-types`.
- Use conventional commit prefixes (see Versioning). Do not commit `packages/cli/src/version.ts`; the build regenerates it.

## Adapter Convention

Pluggable backends (worker-backends, task-backends) implement the `Adapter` base class and a domain-specific interface from `@mnmal-ai/swarm-types`. To add a new LLM provider or task backend, create a new adapter in the appropriate package.

## Routing Change Requirements

When modifying SwarmRoute entities, keywords, tiers, or context budget config:
- Run `pnpm turbo test` — integration tests in `tests/integration/` validate the full router -> loader -> context assembly pipeline
- Add or update integration tests if adding new routes, changing keyword sets, or modifying budget behavior
- Integration tests mock Substrate queries — changes to swarm content or route entities may require test updates

## Do Not

- Do not bypass Substrate to read swarm files directly from disk at runtime. The Substrate store is the runtime truth. Disk files are the authoring/seeding format only.
- Do not hardcode API keys. Always read from environment variables or config (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- Do not give workers GitHub access. Never forward a GitHub token variable or the machine's `GH_CONFIG_DIR` to an agent's processes, and never put the `github_account` token in `process.env`, config, telemetry, the Substrate store or a log line; pass it only through `GitHubCredential.env()` to one of swarm's own gh/git calls.
- Do not share context windows between worker/reviewer/arbiter — each gets a fresh API call with selective field access.
- Do not catch and swallow errors silently. Log them and include them in telemetry.
- Do not declare swarm types outside `packages/substrate-plugin/src/types/`. All 15 swarm types, 5 meta types and 2 docs types are declared there and registered when the sidecar loads the plugin.
- Do not skip the health check. The CLI must verify `GET /health` (top-level, not under `/substrate/v1`) before any operation.
- Do not send a bare param as a filter; use `where` with an operator. Do not send numbers as strings.
- Do not point a test or a cold test at 32337-32341. Tests use ephemeral ports or the 42337-42341 test stack. (Seeding and reading the meta store, below, do use the live stack.)
- Do not run a sidecar on Node older than 26.2, and do not add a registry override or a token requirement back to the install.
- Do not stop a sidecar by killing a port; use `swarm substrate stop`.

## Persistent Context Store (Swarm Meta)

A dedicated Substrate sidecar on port 32341, the meta sidecar, maintains institutional knowledge across all sessions. This is NOT the cold sidecar (32338): this store is never wiped.

### On every session start:

`swarm run` (see Infrastructure) has already brought up both sidecars by the time work begins. `swarm substrate start` does it without dispatching a task, and `swarm doctor` diagnoses the stack; use it in place of a per-port `curl .../health` check.

### Load context before starting work:

```bash
curl -s -X POST http://localhost:32341/substrate/v1/query \
  -H 'Content-Type: application/json' \
  -d '{
    "swarm_meta/Decision":     {"params": {}, "fields": {"topic": true, "choice": true, "rationale": true, "createdAt": true}},
    "swarm_meta/BugReport":    {"params": {}, "fields": {"title": true, "status": true, "rootCause": true, "fix": true}},
    "swarm_meta/ColdTestRun":  {"params": {}, "fields": {"runNumber": true, "goalsCompleted": true, "cost": true, "firstPassRate": true, "notes": true}},
    "swarm_meta/CodeLandmark": {"params": {}, "fields": {"filePath": true, "purpose": true}}
  }'
```

This gives you: every architectural decision, every bug found and how it was fixed, every cold test result, and the important code locations. Read this before modifying anything.

### Write context at session end:

After meaningful work, create entries via the namespaced auto-CRUD mutations:
- `swarm_meta/createSessionLog` — what you did, which branch, how many decisions
- `swarm_meta/createDecision` — for architectural choices (set `supersedes` if replacing a previous decision)
- `swarm_meta/createBugReport` — for bugs found (include the query that diagnosed it)
- `swarm_meta/createCodeLandmark` — for new important code locations
- `swarm_meta/createColdTestRun` — after each cold test with full metrics

---

## Cold-Test Runbook

Cold-test `swarm run` regression gates exercise a real, self-modifying swarm-on-swarm run. They **MUST** run against the isolated alt-port test stack and **MUST NEVER** touch the live default-port Substrate/Postgres that the live orchestrator and normal dev use.

### Always run cold tests through the wrapper

Run every cold-test `swarm run` regression gate through the wrapper; never invoke `swarm run` against the test stack by hand:

```bash
pnpm cold-test:env swarm run --cold-test ...
# or, equivalently:
./scripts/cold-test-env.sh swarm run --cold-test ...
```

The wrapper does two things for you:

1. **Brings up `docker-compose.test.yml` automatically** (project `swarm-substrate-test`) if the isolated stack isn't already running. It's idempotent: already-running containers are left alone.
2. **Scopes the alt-port env vars to the invoked command only.** `SWARM_SUBSTRATE_ENDPOINT`, `SWARM_SUBSTRATE_PORT`, `SWARM_SUBSTRATE_POSTGRES_URL`, `SWARM_META_ENDPOINT`, `SWARM_META_PORT` and `SWARM_META_POSTGRES_URL` are exported in the wrapper's own process, which then `exec`s the command, so they are **never** exported into the orchestrator shell. The live orchestrator's own telemetry/oversight sidecars keep running on the defaults, untouched. (The endpoint variables matter: a saved `substrate_url` in `~/.swarm/config.json` would otherwise outrank the port variable and send the run to the live sidecar.)

### Cold tests MUST target the alt-port test stack, never the live defaults

| Role | Test stack (cold tests USE these) | Live defaults (cold tests must NEVER hit these) |
|---|---|---|
| Cold Postgres | **42337** (`SWARM_SUBSTRATE_POSTGRES_URL`) | 32337 |
| Cold sidecar | **42338** (`SWARM_SUBSTRATE_PORT`) | 32338 |
| Meta Postgres | **42340** (`SWARM_META_POSTGRES_URL`) | 32340 |
| Meta sidecar | **42341** (`SWARM_META_PORT`) | 32341 |

The live default ports **32337/32338** (plus **32340/32341**) belong to the live orchestrator and normal dev. A cold test that hit them would pollute or corrupt the runtime telemetry/oversight/meta store mid-run. There is no exception: cold-test regression gates always go through `pnpm cold-test:env` / `./scripts/cold-test-env.sh`.

### Never set the overrides globally

Do **not** export `SWARM_SUBSTRATE_*` / `SWARM_META_*` in the swarm run shell to "make it easier." Global overrides redirect the orchestrator's own telemetry and oversight Substrate to the test instance. The wrapper exists precisely so the overrides stay scoped to the test subprocess; use it.

---

## Versioning

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning. `.releaserc.json` configures `main` as the `alpha` prerelease branch, so every release is a `1.0.0-alpha.N` prerelease (`v1.0.0-alpha.1`, `v1.0.0-alpha.2`, …) until the maintainer removes the prerelease flag for 1.0.0. A merge to `main` releases or not by its conventional commit prefixes:

- `feat:` or `fix:` -> a release: the next `1.0.0-alpha.N`
- `feat!:` or `BREAKING CHANGE:` in the body -> a release too; the release rules map a breaking change to a minor bump, never a major one, until 1.0
- `chore:`, `docs:`, `test:`, `ci:` -> no release

A release attaches the five platform binaries and their `.sha256` files to a GitHub Release. Nothing is published to npm.

**Rules for agents:**
- Always use conventional commit prefixes. Every commit message must start with a type.
- Use `feat:` for new SDK capabilities (new module, new provider, new API surface).
- Use `fix:` for bug fixes to existing functionality.
- Use `test:` for test-only changes (new tests, test refactors).
- Use `chore:` for config, CI, dependency updates, and non-functional changes.
- Use `docs:` for documentation-only changes.
- Never manually edit the version in package.json — semantic-release manages it.
- Never manually create git tags — semantic-release manages them.
- CHANGELOG.md is generated by semantic-release, which creates it with the first release (it does not exist before then). Do not edit it manually.
