# AGENTS.md

## Project

The **Swarm SDK** is a TypeScript monorepo that integrates AI agents with the Swarm context system. All storage lives in Substrate, a typed data engine backed by Postgres, reached over HTTP through the `@mnmal-ai/swarm-substrate` client.

## What This Does

The SDK wraps any LLM API call with swarm-powered context loading, typed oversight, and structured telemetry:

```
Task -> classify intent via Substrate query -> load context from the Substrate store -> call LLM API -> typed Substrate oversight chain -> Substrate telemetry entities
```

Swarm content, oversight artifacts, telemetry events, goals, learning entries and observations are all Substrate types in Postgres. The human-facing CLI renders all data back to readable prose.

## Tech Stack

- Language: TypeScript (strict mode)
- Runtime: Node.js 26.2+ for development, CI and the sidecars; the shipped CLI binary is Bun-compiled but still needs a Node 26.2+ for the sidecars
- Build: tsc (per-package)
- Test: Vitest
- Lint: ESLint with TypeScript plugin
- Package manager: pnpm (everything installs from npmjs, no token)
- Monorepo tool: Turborepo
- Database: Postgres 17 (pgvector) via Docker Compose
- Data layer: two Substrate sidecars (cold 32338, meta 32341)

## Infrastructure

### Starting the stack

```bash
swarm run                                 # brings up Postgres and both sidecars, then dispatches
swarm substrate start|stop|status         # manage the sidecars without dispatching a task
swarm doctor                              # diagnose the stack (never starts anything)
swarm db setup|status|start|stop|reset    # machine-wide Postgres containers
npx tsx scripts/seed-swarm.ts --swarm-path tests/fixtures/content --project todo-test  # Seed swarm content (needs the stack up)
```

| Port | Purpose |
|---|---|
| 32337 | Postgres, cold sidecar |
| 32338 | Cold Substrate sidecar (`swarm`, `swarm-docs`, cortext) |
| 32340 | Postgres, meta sidecar |
| 32341 | Meta Substrate sidecar (`swarm_meta`) |
| 42337-42341 | Isolated test stack (tests and cold tests only) |

The sidecars run from a runtime installed from npmjs into `~/.swarm/substrate/runtime` (Node 26.2 or newer; `SWARM_NODE` names one). Each sidecar runs in `~/.swarm/substrate/stacks/<label>/`. The CLI checks `GET /health` before every command. The swarm plugin ships inside the CLI as `packages/cli/assets/swarm-substrate-plugin.tgz`.

### Dedicated per-project stacks

A `substrate` block in `.swarm/config.json` (`port`, `postgres_url`, `meta_port`, `meta_postgres_url`, `compose_file`, `compose_project`, `local_only`) gives a project its own sidecars and Postgres. `local_only: true` makes swarm refuse any non-loopback endpoint, Postgres or embedder URL. `local_only: true` in any top-level object block of the swarm-dir or a domain config, whatever the block is called, turns the guard on; only the `substrate` block supplies the stack keys, and `compose_project` never stands without them. Details and the environment variables are in `CLAUDE.md` and `environment.md`.

### Tests

```bash
env -u ANTHROPIC_API_KEY pnpm turbo test                                     # plain: no process, no network
SWARM_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests   # real sidecars, memory store, ephemeral ports
SWARM_SDK_CLAUDE=1 ...                                                       # adds the paid suites
SWARM_SDK_PG=1 ...                                                           # sidecars on the 42337/42340 Docker Postgres
```

Tests never touch the real `~/.swarm` and never bind the default ports 32337-32341.

## Repo Layout

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
  substrate-plugin/  # @mnmal-ai/swarm-substrate-plugin — The swarm coordinator plugin: types, resolvers, drainstop
  substrate-shared/  # @mnmal-ai/swarm-substrate-shared — Constants and resolver types shared by both
  swarm/             # swarm — Backward-compatible re-export package
tests/
  integration/       # Cross-package integration tests
```

## Package Naming

All packages use `@mnmal-ai/swarm-<name>` except the root compat package (`swarm`).

## Build Commands

```bash
pnpm install                              # Install all dependencies
pnpm turbo build                          # Build all packages (regenerates packages/cli/src/version.ts; never commit it)
pnpm turbo test                           # Run all tests
pnpm turbo lint                           # Lint all packages
pnpm --filter @mnmal-ai/swarm-<name> test      # Test one package
```

## Key Design Decisions

- **JSON over YAML.** All config and schemas use JSON.
- **Model-agnostic.** Worker backends implement the `Adapter` base class + domain-specific interface from `@mnmal-ai/swarm-types`.
- **Separate context windows for oversight.** The reviewer and arbiter make their own API calls; they do not share the worker's context.
- **Task dependencies as DAG.** Tasks declare `dependsOn` fields. The orchestrator topologically sorts them into execution tiers.
- **Failure-driven replanning.** After a goal completes, failures are categorized and the system decides to retry, decompose, or escalate.
- **Pre-review validation.** Worker output is validated as non-empty before sending to the Reviewer.
- **Lockstep versioning.** All packages share the same version. Semantic-release bumps all packages together.
- **Swarm content in Postgres, not files.** Markdown files are seeded into Substrate entities. The Substrate store is the runtime truth.
- **Typed oversight.** Worker/Reviewer/Arbiter exchange typed Substrate entities (WorkerResult, ReviewVerdict, ArbiterDecision) with selective field access.
- **Telemetry entities, not JSONL.** Events are Substrate entities, not append-only files.
- **Sidecar architecture.** The Substrate server runs as a separate process. CLI, agents, and orchestrator all query the same store.
- **Token budgets, never dollars.** Every budget is in tokens (`max_tokens_per_session`, `max_tokens_per_goal`, `max_tokens_per_task`); swarm computes, stores and shows no currency.
- **Swarm picks the GitHub account; workers get none.** `source_control.github_account` names the account swarm's own gh/git calls run as; worker, reviewer and arbiter processes get no GitHub token and an empty `GH_CONFIG_DIR`. See `CLAUDE.md`.
- **External dependency manifest.** `packages/cli/src/external-deps.ts` declares tools swarm runs but does not ship (gh, tested major 2).
- **HTTP-only client with page-cursor following and in-frame idempotency keys.** `SubstrateClient` speaks HTTP to `/substrate/v1/query` and `/substrate/v1/mutate`; a `query()` with neither `limit` nor `cursor` follows `nextCursor`; every mutation frame carries its `idempotencyKey`; a refused frame throws `SubstrateFrameError`.
- **Recall through the engine.** `classifyIntent`, `loadContext` and `prepareTask` are custom queries of the `swarm` plugin and recall through Substrate's recall plugin; with no embedder they fall back to keywords and paths.
- **Observations and drainstop promotion into cortext.** Agents write `Observation` rows; `swarm drainstop` promotes high-signal ones into the cortext context store, and the scheduled tick expires the rest by TTL.

## Namespaces and Types

- `swarm` (cold sidecar): 15 types: SwarmConfig, SwarmContent, SwarmRoute, WorkerResult, ReviewVerdict, ArbiterDecision, SessionEvent, OversightChain, TranscriptEntry, Goal, TaskExecution, LearningEntry, McpServer, FailurePostmortem, Observation.
- `swarm_meta` (meta sidecar): 5 types: SessionLog, Decision, CodeLandmark, ColdTestRun, BugReport.
- `swarm-docs` (cold sidecar): 2 types: Document, Section.
- Four custom operations on `swarm`: queries `loadContext`, `classifyIntent`, `prepareTask`; mutation `persistTaskTelemetry`.
- Types live in `packages/substrate-plugin/src/types/`. AutoCRUD gives `create<Type>`, `update<Type>`, `delete<Type>`, `get<Type>` and a list query. Filter with `where` and an operator (`{ "tier": { "eq": "always-load" } }`); a bare param is not a filter. Numbers are sent as numbers.
- Op-keys are `<namespace>/<TypeName>`; each `SubstrateClient` prepends its namespace (default `swarm`).

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


## Conventions

- All config uses JSON, never YAML.
- All public methods are async.
- Errors should be typed and descriptive, not generic throws.
- Token estimation: 1 token ~ 4 characters. This is a heuristic for budget enforcement, not billing.
- Session IDs use the format `sess-{uuid}`.
- Event IDs use the format `evt-{ISO-date}-{sequence}`.
- Pluggable backends implement the `Adapter` base class + domain-specific interface from `@mnmal-ai/swarm-types`.
- JSON arrays stored as fields (keywords, contentPaths, reasons, etc.) are serialized as JSON strings. The SDK parses them in application code.
- Use conventional commit prefixes; do not commit `packages/cli/src/version.ts`.

## Key Interfaces

- `SubstrateClient` — HTTP wrapper for a Substrate sidecar. Methods: `query()`, `mutate()`, `batchMutate()`, `ingest()`, `getSchema()`, `hasType()`, `isHealthy()`, `loadContext()`, `classifyIntent()`, `prepareTask()`, `persistTaskTelemetry()`, `observe()`.
- `Adapter` — Base class for pluggable LLM providers and task backends.
- `SwarmConfig` — Top-level SDK configuration.
- `Route` — A single intent-to-files mapping (backed by SwarmRoute entities).

## Adapter Convention

Pluggable backends (worker-backends, task-backends) implement the `Adapter` base class and a domain-specific interface from `@mnmal-ai/swarm-types`. To add a new LLM provider or task backend, create a new adapter in the appropriate package.

## Routing Change Requirements

When modifying SwarmRoute entities, keywords, tiers, or context budget config:
- Run `pnpm turbo test` — integration tests in `tests/integration/` validate the full router -> loader -> context assembly pipeline
- Add or update integration tests if adding new routes, changing keyword sets, or modifying budget behavior
- Integration tests mock Substrate queries — changes to swarm content or route entities may require test updates

## Do Not

- Do not bypass Substrate to read swarm files directly from disk at runtime. The Substrate store is the runtime truth.
- Do not hardcode API keys. Always read from environment variables or config.
- Do not share context windows between worker/reviewer/arbiter — each gets a fresh API call with selective field access.
- Do not catch and swallow errors silently. Log them and include them in telemetry.
- Do not declare swarm types outside `packages/substrate-plugin/src/types/`.
- Do not skip the health check. Verify `GET /health` before any operation.
- Do not send a bare param as a filter, or numbers as strings.
- Do not point a test or a cold test at 32337-32341; use ephemeral ports or the 42337-42341 test stack.
- Do not stop a sidecar by killing a port; use `swarm substrate stop`.

## Cold-Test Runbook

Run every cold-test `swarm run` regression gate through the wrapper, never by hand against the test stack:

```bash
pnpm cold-test:env swarm run --cold-test ...
# or: ./scripts/cold-test-env.sh swarm run --cold-test ...
```

The wrapper brings up `docker-compose.test.yml` if needed and exports `SWARM_SUBSTRATE_ENDPOINT`, `SWARM_SUBSTRATE_PORT`, `SWARM_SUBSTRATE_POSTGRES_URL`, `SWARM_META_ENDPOINT`, `SWARM_META_PORT` and `SWARM_META_POSTGRES_URL` for the invoked command only. Cold tests use Postgres 42337, cold sidecar 42338, meta Postgres 42340 and meta sidecar 42341, and never the live 32337/32338/32340/32341. Never export those variables in your shell.

## Versioning

Semantic-release versions merges to `main` from conventional commit prefixes. `main` is the `alpha` prerelease branch, so every release is `1.0.0-alpha.N` until the prerelease flag is removed for 1.0.0: `feat:` and `fix:` release the next `1.0.0-alpha.N`, a breaking change (`feat!:` or `BREAKING CHANGE:`) counts as minor, never major, until 1.0, and `chore:`, `docs:`, `test:`, `ci:` do not release. Always use a prefix, never edit the version in package.json, never create tags by hand, and never edit CHANGELOG.md (semantic-release creates it with the first release).
