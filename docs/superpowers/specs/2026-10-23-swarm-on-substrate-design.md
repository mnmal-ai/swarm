# Swarm on Substrate: design

Date: 2026-10-23. Status: approved by the maintainer on 2026-10-23.

Swarm is the open-source successor to an internal agent-orchestration
monorepo. This document is the design a builder works from to create the
`mnmal-ai/swarm` repository: the same product under a new name, with its
memory layer ported from the retired Hydra framework to Substrate, and with
nothing in the tree, the history or the metadata that identifies a person.

It names the predecessor as "the source repo" throughout. It lives in the
tree deliberately: a reader of swarm should be able to see why things are
shaped the way they are.

## 1. Intent

The maintainer wants swarm and Substrate to be the organisation's open-source
offerings. Swarm must work exactly as the source repo works today for its
existing operators, under new names, with Substrate underneath instead of
Hydra, and must be publishable without anyone being able to tie it to a
person.

Three things are true at once, and the design serves all three:

1. **It is a rename.** Every feature carries over. An operator who knows the
   source repo should find every command, config key and behaviour where they
   expect it, spelled `swarm` instead of `brain`.
2. **The memory layer is a port, not a rename.** Hydra was an in-process
   framework; Substrate is a sidecar you run. The first attempt at porting a
   sibling project kept Hydra underneath and only renamed what users saw, and
   was rejected for exactly that. Nothing named Hydra survives in swarm's code,
   docs, config keys, commands, tests or package names.
3. **It is anonymous.** The first commit is fresh, and the tree it carries has
   been scrubbed and verified before it is pushed. GitHub keeps force-pushed
   commits reachable, so there is no second chance at the first push.

## 2. Goals, non-goals, anti-goals

**Goals**

- A `swarm` CLI with the full feature set of the source repo: worker, reviewer
  and arbiter roles including the codex backend; the merge queue; the Trello
  and GitHub task sources; the fnl output reducer; the local Axon dashboard
  including `--dashboard-lan`; token budgets; `source_control.github_account`;
  `init`, `run`, `doctor`, `db`, `seed`, `sync`, `drainstop`, `sharing`,
  `logs`, `upgrade`, `uninstall`, `skill`, `add`, `mcp`, `dashboard`, `merge`,
  `list`.
- Substrate 1.0.0-alpha.6 (or the current `next`) as the only data layer,
  reached over HTTP from a `substrate serve` sidecar that swarm manages.
- Same release shape: semantic-release on merge to `main`, five Bun-compiled
  binaries attached to a GitHub Release, `swarm upgrade` and a curl installer.
- Opt-in telemetry, off by default, pointing at new collector infrastructure
  that does not yet exist.
- Apache-2.0, copyright `mnmal-ai`.
- Tests pass locally, and a real `swarm run` completes against a throwaway
  project with its own Substrate.

**Non-goals**

- Reading `.brain/`, `~/.brain/` or `BRAIN_*` during a transition. There are
  no public projects with a brain config. The maintainer's own projects are
  migrated by hand from a checklist (section 12).
- Publishing `@mnmal-ai/swarm-*` to any registry. Packages are workspace-only,
  as the source repo's are.
- Keeping telemetry history from existing Hydra stores. Substrate's schema is
  different; stores start empty.
- Preserving the source repo's design history (`docs/plans/`,
  `docs/superpowers/`, `docs/whitepapers/`). It stays in the archived source
  repo.

**Anti-goals**

- A Hydra reference anywhere in the tree, including test names and comments.
- A personal name, email, home-directory path, hostname or client reference
  anywhere in the tree.
- A GitHub Packages dependency. Open-source users cannot authenticate to the
  organisation's private registry.
- A GitHub Actions run that nobody asked for. The four workflows below are
  the approved set; anything else needs a fresh yes.

## 3. Constraints

- **Account.** All GitHub work runs as the organisation's bot account, never
  a personal one, and never by switching gh's active account.
- **Commit identity.** Author and committer
  `mnmal-ai-two <273891930+mnmal-ai-two@users.noreply.github.com>`, set in the
  clone's local config, with `commit.gpgsign=false`. A `Co-Authored-By:
  Claude …` trailer is fine. No session links, in commits or PR bodies.
- **One fresh commit.** The source repo's 441 commits are never pushed. Code
  arrives via `git archive` of the source `main` (`54b9c8e`, v0.73.1).
- **Repo stays private** until the maintainer says otherwise.
- **No API key** on any `claude` or `swarm` run during verification:
  `env -u ANTHROPIC_API_KEY`.
- **Leave the predecessor installation alone.** Its binary, sidecars,
  Postgres containers and dashboards, and any agent process already running,
  are off limits during the build. Swarm's default ports therefore differ
  from the source repo's (section 6.5).
- **Isolation.** Swarm carries a fail-closed `local_only` guard equivalent to
  the source repo's, and verification only ever targets throwaway projects.

## 4. Naming

| Surface | Source repo | Swarm |
|---|---|---|
| Repo | `mnmal-ai/brain` | `mnmal-ai/swarm` |
| Root package | `@mnmal-ai/brain-monorepo` | `@mnmal-ai/swarm-monorepo` |
| Packages | `@mnmal-ai/brain-<name>` | `@mnmal-ai/swarm-<name>` |
| Umbrella | `@mnmal-ai/brain` (`packages/brain`) | `@mnmal-ai/swarm` (`packages/swarm`) |
| CLI binary | `brain` | `swarm` |
| Release assets | `brain-<os>-<arch>` | `swarm-<os>-<arch>` |
| Global config | `~/.brain/` | `~/.swarm/` |
| Project config | `.brain/`, `.brain/brain.json`, `.brain/domains/<p>/config.json` | `.swarm/`, `.swarm/swarm.json`, `.swarm/domains/<p>/config.json` |
| Env vars | `BRAIN_*` | `SWARM_*` |
| Agent files written into user projects | `prepare-for-brain.md`, `BRAIN-PROMPT.md`, `<!-- brain:begin/end -->` | `prepare-for-swarm.md`, `SWARM-PROMPT.md`, `<!-- swarm:begin/end -->` |
| Task labels | `brain:goal`, `brain:task`, `brain:escalated`, `brain_split`, `brain_merge` | `swarm:goal`, `swarm:task`, `swarm:escalated`, `swarm_split`, `swarm_merge` |
| Worktree branches | `brain-worker/*`, `.brain/worktrees/` | `swarm-worker/*`, `.swarm/worktrees/` |
| Telemetry wire fields | `brain_sdk_version`, `brain_version`, `brain_files_loaded` | `swarm_sdk_version`, `swarm_version`, `swarm_files_loaded` |
| LLM prompt headers | `## Brain Context`, `## Brain Expectations` | `## Swarm Context`, `## Swarm Expectations` |
| Dashboard package | `@yourorg/brain-dashboard` | `@mnmal-ai/swarm-dashboard` |
| Pages URL | the source repo's Pages URL | `mnmal-ai.github.io/swarm` |
| Infra | the `brain-` prefixed telemetry, run-index, user-access and admin resources | `swarm-telemetry-*`, `swarm-run-index`, `swarm-user-access`, `swarm-admin` |

The word "brain" appears in 639 of 788 files. The rename is mechanical and
case-aware (`brain`, `Brain`, `BRAIN`), applied after the Hydra port so the
two changes are reviewable separately in the working tree, even though they
land in one commit.

Three names do **not** change, because they are upstream or third-party:
Substrate's own `SUBSTRATE_*` environment, Ollama's defaults, and the
`mnmal-ai/fnl` reference (see section 13, open question 4).

## 5. What the source repo does with Hydra today

One workspace package, `packages/hydra` (`@mnmal-ai/brain-hydra`), holds all
the coupling. Every other package reaches Hydra only through that package's
HTTP client. Inside the package there are three distinct things:

1. **A client**: `HydraClient` over `POST /hydra/query`, `POST /hydra/mutate`
   (with an idempotency key), `GET /hydra/federated-schema`, `GET /health`.
   An unused WebSocket/msgpack transport sits beside it; production forces
   `transport: "http"`.
2. **A Hydra coordinator plugin**: 14 types in namespace `brain`, 5 in
   `brain_meta`, 2 in `brain-docs`, declared with Hydra's `defineNamespace`
   and `field` DSL, plus four custom resolvers registered on the namespace:
   `classifyIntent`, `loadContext`, `prepareTask` (queries) and
   `persistTaskTelemetry` (a transactional mutation). The resolvers do recall
   by holding an embedder and an embeddings store directly and calling
   kNN search, bypassing the engine.
3. **A sidecar host**: composes Hydra core, a Fastify server, a Postgres
   dataset, the recall plugin, the `hydra-plane` observation plugin and two
   cortext plugins in-process, runs migrations and raw pgvector DDL, mounts
   a `trigger-drainstop` route, and runs an embedding backfill loop. The Bun
   binary re-enters itself with `--start-hydra-server` and loads these from a
   static in-code registry. Two sidecars run: cold (`brain`, port 31338 on
   Postgres 31337) and meta (`brain_meta`, 31341 on 31340).

Lifecycle (`lifecycle.ts`, 1,200 lines) brings up Postgres via docker compose,
spawns the sidecars detached, polls `/health`, and verifies the schema. A
project can declare a dedicated stack and `local_only` in its config; both
are applied as `BRAIN_HYDRA_*` / `BRAIN_META_*` environment variables.

## 6. How swarm uses Substrate

### 6.1 Topology: one sidecar per stack, started from a Node runtime directory

Substrate ships as one npm package, `@mnmal-ai/substrate`, with a `substrate`
binary and library subpaths (`/sdk`, `/client`, `/testing`, …). It has no
public programmatic "serve" entry: the binary loads plugins by scanning
`<SUBSTRATE_PLUGIN_DIR>/node_modules` for packages listed in that directory's
`package.json`. The maintainer's choice (section 13, question 1) is between:

- **A. A Node runtime directory.** Swarm scaffolds
  `~/.swarm/substrate/runtime/` once: a `package.json` pinning
  `@mnmal-ai/substrate@<exact version>` and `@mnmal-ai/swarm-substrate-plugin`
  (installed from a tarball the swarm binary carries), runs `npm install`,
  and spawns `node_modules/.bin/substrate serve` per stack. **Prerequisite
  added for users: Node ≥ 26.2** (which bundles npm). This is the pattern the
  ported memory demo proved. Recommended.
- **B. A Docker image.** Swarm writes a small Dockerfile (`FROM node:26-slim`,
  `npm install` the same two packages, copy the plugin tarball) and runs
  Substrate as a container next to the Postgres container it already manages.
  No Node prerequisite, since Docker is already required. More moving parts:
  an image build on first start and on every upgrade, and host-reachable
  Ollama (`host.docker.internal`) differs by platform.
- **C. In-process.** Would need Substrate to export its compose-from-manifests
  path and Fastify server for hosts. That is a Substrate change, not a swarm
  one, and is not available today.

The rest of this design assumes **A**. Switching to B changes only the
lifecycle module.

Swarm keeps the source repo's **two-sidecar topology**: a cold sidecar
serving `swarm` and `swarm-docs` on its own Postgres container, and a meta
sidecar serving `swarm_meta` on a second one. A single sidecar was
considered and rejected: "the meta store is never wiped" is free when it is
a separate database (`swarm db reset` drops the cold volume), and would
otherwise need every cold type declared `purgeable` plus admin-capability
purges through the engine. Both sidecars load the same plugin tarball; the
plugin's bootstrap config selects which namespaces to install
(`scope: "cold" | "meta"`), as the source repo's combined/meta factories do.

### 6.2 The plugin: `@mnmal-ai/swarm-substrate-plugin`

A new workspace package, `packages/substrate-plugin`, is a Substrate
**coordinator plugin** built with `@mnmal-ai/substrate/sdk`:

- `package.json` has a top-level `"substrate"` manifest
  (`tier: "coordinator"`, `entry: "./dist/bootstrap.js"`, a `defaultConfig`
  and `configSchema`), `@mnmal-ai/substrate` as a peer dependency with range
  `>=1.0.0-alpha.0 <2.0.0`, and the plugin declares the same
  `contractVersion`.
- Three namespaces, from the source repo's type definitions ported from
  Hydra's field DSL to Substrate's (`field.string`, `field.number`,
  `field.boolean`, `field.enum`, `field.crossRef`, `field.list`; `embed.source`
  on `SwarmContent` and `Section`):
  - `swarm`: SwarmConfig, SwarmContent, SwarmRoute, WorkerResult,
    ReviewVerdict, ArbiterDecision, SessionEvent, OversightChain,
    TranscriptEntry, Goal, TaskExecution, LearningEntry, McpServer,
    FailurePostmortem, plus **Observation** (replaces `plane/Observation`,
    section 6.4).
  - `swarm_meta`: SessionLog, Decision, CodeLandmark, ColdTestRun, BugReport.
  - `swarm-docs`: Document, Section (crossRef cascade).
- The four custom resolvers, registered on the `swarm` registry after
  `defineNamespace`'s install, exactly as Substrate's plugin author guide
  shows. Differences from the Hydra versions:
  - **Recall goes through the engine.** The plugin captures the engine handle
    in `onStart` and issues `recall/Hit` frames (with a `row` selection for
    the fields it needs) instead of holding an embedder. The similarity
    threshold stays a `SwarmConfig` row read at call time. **Ranking stays
    at parity with today:** dense-only, no lexical arm (the embedded types
    declare `embed.source` but no `lexical.source`), `boost: false` so a
    context read does not bump salience, and the threshold keeps its cosine
    meaning. Adopting Substrate's fused ranking is a later, separate change
    with its own test update.
  - **`persistTaskTelemetry` uses the transaction-scoped `args.dataset`** that
    Substrate hands a mutation resolver, replacing Hydra's explicit
    `withTransaction`.
  - **Cross-namespace reads** (`swarm-docs` from a `swarm` resolver) go
    through the engine handle rather than a dataset captured at install time.
- A `routes` block mounting `/substrate/v1/plugins/swarm/onboard` and
  `/substrate/v1/plugins/swarm/trigger-drainstop`, the latter running the
  promotion engine (section 6.4) over the engine handle.
- `onboardInstructions` with a short overview of the types, for any agent
  that gets Substrate tools.

The plugin is built in the monorepo and packed (`npm pack`) into a tarball
that the swarm binary embeds and writes into the runtime directory on
`swarm substrate start` and on `swarm upgrade`. No registry is involved.

### 6.3 The client: `@mnmal-ai/swarm-substrate`

`packages/substrate` replaces `packages/hydra` on the swarm side of the HTTP
boundary. It keeps the same exported surface the CLI, core, orchestrator,
oversight and telemetry packages use today (`SubstrateClient` with `query`,
`mutate`, `batchMutate`, `ingest`, `getSchema`, `isHealthy`, the typed
`prepareTask` / `loadContext` / `classifyIntent` / `persistTaskTelemetry`
wrappers, `observe`, `TaskTelemetryBuffer`, `subscribeOrPoll`, the docs
store, `ensureSubstrateReady`, `ensurePostgres`, `ensureAllSidecars`, the
local-only guard, and the lifecycle), retargeted:

| Hydra | Substrate |
|---|---|
| `POST /hydra/query` | `POST /substrate/v1/query` |
| `POST /hydra/mutate` | `POST /substrate/v1/mutate` |
| `GET /hydra/federated-schema` | `GET /substrate/v1/schema/<namespace>` once per namespace (the bare `/schema` route returns only the `default` namespace) |
| `GET /health` | `GET /health` |
| `POST /plugins/hydra-plane/trigger-drainstop` | `POST /substrate/v1/plugins/swarm/trigger-drainstop` |
| frame key `brain/<Type>` | `swarm/<Type>` |
| mutation `brain/createX` | `swarm/createX` |

Frame grammar (`{"ns/op": {params, fields}}`, `where: {field: {eq|in}}`,
`limit`, autoCRUD names) is the same in Substrate, so consumer code changes
are the namespace and the route. Error handling changes: a refused frame
comes back with its key absent from `data` and the reason in `errors`
under HTTP 200. The client checks `errors` before `data` on every call.

**Dropped from the client**, with reasons:

- The WebSocket/msgpack transport and positional decoding. Production never
  used it; `subscribeOrPoll` already falls back to polling. Substrate's
  JSON WebSocket subscriptions can be added later.
- Raw pgvector DDL, dimension re-typing, the salience migration and the
  backfill loop. Substrate's built-in recall plugin owns the embeddings
  table, the embedder config (`substrate-recall.config.json`) and reindexing
  (`POST /substrate/v1/embed/reindex`).
- The `relabel-context` tool and `swarm db relabel-context`. It renamed a
  legacy Hydra namespace with raw SQL; swarm has no legacy data.
- The raw-SQL `hydra_rows` probe for the context namespace.
- `hydra explore` / `hydra dashboard`. Substrate has no equivalent HTML
  explorer; `swarm substrate status` and the optional `@mnmal-ai/substrate-tui`
  cover inspection. This is the one operator-visible feature that does not
  carry over one-to-one.

### 6.4 Observations, promotion and cortext

The source repo writes observations to `hydra-plane`'s `plane/Observation`
(memory-backed, with per-kind TTLs) and promotes them only when an operator
runs `brain drainstop`; the scheduler is never started. Promotion is
`hydra-plane`'s `runDrainstopOnce`: it maps observation kinds to
`cortext/create…` writes in the cortext context store and seeds a
confidence anchor. Nothing in the source repo reads cortext back, but the
promoted rows are the institutional memory the feature exists to build, so
cortext is a real dependency, not a passenger.

Swarm keeps the whole behaviour:

- **Cortext stays**, as `@mnmal-ai/cortext` from npmjs (`next`,
  `1.0.0-alpha.5` at the time of writing), installed in the runtime
  directory and loaded by the cold sidecar like any other plugin. Its
  Substrate version is maintained in the public `mnmal-ai/synoptic` repo.
  Its types may have moved since the 1.26.0 the source repo used; the
  promotion mapping is written against the current ones.
- **`Observation` becomes a type in the `swarm` namespace**, with
  `hydra-plane`'s field set (kind, context, tags, `ttlHours`, `isAnchor`,
  timestamp). It is durable in Postgres now; a scheduled task on the plugin
  (`schedule`) expires rows past their TTL, replacing the memory store's
  own expiry.
- **Promotion is ported into the swarm plugin** from
  `plugins/hydra-plane/src/drainstop.ts` and `reject-promotion.ts` in the
  archived `mnmal-ai/hydra` repo, writing `cortext/create…` frames through the engine handle with the same
  strict-error wrapper the source repo's `promotion-engine.ts` applies.
  `swarm drainstop` calls the plugin route. Promotion is copy-then-delete,
  as today.
- `@mnmal-ai/cortext-substrate` (the Hydra-era kernel half) is replaced by
  what cortext's npm package now ships itself: it carries a kernel plugin
  and a coordinator in one package.

`@mnmal-ai/context-render` stays, pinned to its npmjs `next` version; its
two functions (`splitByTokens`, `renderIndexLine`) are vendored if the reset
version line changed their API.

### 6.5 Lifecycle, ports, config

`swarm substrate start|stop|status` replaces `brain hydra …`. `swarm run`,
`swarm doctor`, `swarm db` and the startup preamble use the same lifecycle:

1. Postgres via docker compose (`pgvector/pgvector:pg17`), from
   `~/.swarm/infrastructure/docker-compose.yml` for the shared stack or the
   project's `compose_file` for a dedicated one.
2. Runtime directory present and installed (section 6.1), plugin tarball
   current for this swarm version. The install is shared; **each stack gets
   its own plugin directory** at `~/.swarm/substrate/stacks/<stack>/` holding
   a `package.json` listing the plugins that sidecar loads, that stack's
   `substrate-recall.config.json` and `cortext.config.json`, and a
   `node_modules` symlink to the shared runtime's. Projects choose their own
   embedder, so the recall config cannot be shared. If Substrate's loader
   turns out not to follow a symlinked `node_modules` directory, the fallback
   is one `npm install` per stack; only the lifecycle module changes.
3. `substrate serve` spawned detached per sidecar with
   `SUBSTRATE_DATABASE_URL`, `SUBSTRATE_PLUGIN_DIR=<stack dir>`,
   `SUBSTRATE_SYSTEM_ACTOR=swarm` (`swarm-meta` for the meta sidecar),
   `HOST=127.0.0.1`, `PORT`; log to `~/.swarm/substrate/stacks/<stack>/
   server.log`; pid file beside it. `substrate-recall.config.json` written
   from swarm's embedder settings (Ollama `nomic-embed-text`, 768 dimensions,
   by default, matching today; `writeEmbedTimeoutMs` raised to 120000).
4. Poll `/health`, then verify `GET /substrate/v1/schema/<ns>` for each of
   the three namespaces, and that `swarm`'s schema lists the four custom ops.
5. `stop` sends SIGTERM to the pid file's process, loopback only.

Defaults differ from brain's so both can run on one machine:

| Role | Brain | Swarm shared default | Swarm test stack |
|---|---|---|---|
| Cold Postgres | 31337 | 32337 | 42337 |
| Cold sidecar | 31338 | 32338 | 42338 |
| Meta Postgres | 31340 | 32340 | 42340 |
| Meta sidecar | 31341 | 32341 | 42341 |

Endpoint resolution order is unchanged: explicit, `SWARM_SUBSTRATE_ENDPOINT`,
`substrate_url` in `~/.swarm/config.json`, `SWARM_SUBSTRATE_PORT`, default.

Project config block, in `.swarm/config.json` or
`.swarm/domains/<p>/config.json`:

```json
"substrate": {
  "local_only": true,
  "port": 47338,
  "postgres_url": "postgresql://swarm:swarm@127.0.0.1:47337/swarm",
  "meta_port": 47341,
  "meta_postgres_url": "postgresql://swarm:swarm@127.0.0.1:47340/swarm_meta",
  "compose_file": "substrate/docker-compose.dedicated.yml",
  "compose_project": "swarm-project-a"
}
```

The four stack keys stay all-or-nothing, as today. `local_only` keeps its
fail-closed, additive semantics: it requires loopback
for the Substrate endpoint, the Postgres URL and the Ollama URL, refuses to
start otherwise, and warns when telemetry sharing is on.

Environment variables, with the same semantics as their `BRAIN_HYDRA_*`
ancestors: `SWARM_SUBSTRATE_ENDPOINT`, `SWARM_SUBSTRATE_PORT`,
`SWARM_SUBSTRATE_POSTGRES_URL`, `SWARM_META_PORT`, `SWARM_META_POSTGRES_URL`,
`SWARM_SUBSTRATE_DEDICATED`,
`SWARM_SUBSTRATE_LOCAL_ONLY`, `SWARM_EMBEDDER_OLLAMA_URL`,
`SWARM_EMBEDDER_MODEL`, `SWARM_EMBEDDER_DIMENSION`,
`SWARM_EMBEDDER_TIMEOUT_MS`, `SWARM_EMBED_ON_WRITE`,
`SWARM_DRAINSTOP_INTERVAL_MS`, `SWARM_DISABLE_SUBSCRIBE`, `SWARM_POLL_FALLBACK`,
`SWARM_TRACE`, `SWARM_DEBUG`, `SWARM_CODEX_SESSIONS_DIR`, `SWARM_PATH`,
`SWARM_SDK_E2E`, `SWARM_VERSION_OVERRIDE`, `SWARM_INSTALL_DIR`.

### 6.6 Dashboard proxy

The local dashboard server proxies `/api/substrate/*` to the sidecar
(replacing `/api/hydra/*`), and its HTML issues `swarm/<Type>` frames.

## 7. Telemetry and the hosted dashboard

Opt-in stays as it is: `swarm init` asks "Share anonymous run data to help
improve swarm?" with the default **no**, writes `telemetry_sharing` into the
domain config, and `swarm sharing` changes it. Nothing uploads unless
`enabled` is true.

The collector endpoint is currently hard-coded in four places. Swarm
centralises it in one constant, `DEFAULT_TELEMETRY_ENDPOINT` in
`packages/telemetry`, with the dashboard reading it at build time. The value
is a **placeholder** (`https://telemetry.example.invalid`) until the
maintainer stands up new infrastructure; the old API Gateway URL and anything
naming the old bucket, tables or Lambda are scrubbed. The CDK project in
`infra/` carries over renamed, so the new stack can be deployed from it, with
its collaborator check pointed at `mnmal-ai/swarm`. Deploying it is manual
and the maintainer's.

The hosted dashboard deploys to `mnmal-ai.github.io/swarm` via Pages, as
today, and is where `install.sh` is served from.

## 8. Workflows, release, install

All four workflows carry over with their automatic triggers. The maintainer
approved this explicitly on 2026-10-23, knowing `ai-actions.yml` runs the
organisation's Claude credentials on PRs and issues and will be reachable
from fork PRs once the repo is public.

| Workflow | Trigger | Change |
|---|---|---|
| `ci.yml` | PR and push to `main` | Remove the GitHub Packages `.npmrc` step. `pnpm turbo test:ci` runs every package with a `test:ci` script, `packages/substrate` and `packages/substrate-plugin` included. The integration suites in `tests/integration` have no `test:ci` script and their sidecar suites need `SWARM_SDK_E2E=1`, so they run locally only. No Postgres service container: the pg-backed suites stay local-only, so CI stays as cheap as it is today (question 6). |
| `release.yml` | push to `main` | Assets renamed `swarm-*`; Bun stays pinned to 1.3.11. No npm publish. |
| `dashboard-deploy.yml` | push to `main` touching `dashboard/**` or `scripts/install.sh`, plus dispatch | Vite base `/swarm/`. |
| `ai-actions.yml` | PR opened/sync, issue opened | Unchanged; reusable workflows come from the public `mnmal-ai/.github`. |

Repository settings the maintainer sets by hand: the `GH_PACKAGES_TOKEN`
secret is **not** needed; `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` for
`ai-actions.yml`; Pages with source "Actions" and the `github-pages`
environment; immutable releases; the `preview-no-build` label.

`.releaserc.json` keeps its plugins and renames the assets, and `main` is
configured as a **prerelease branch** (`{ "name": "main", "prerelease":
"alpha" }`), so releases are `v1.0.0-alpha.1`, `v1.0.0-alpha.2`, … until the
maintainer removes the prerelease flag for 1.0.0. The root `package.json`
version is set to `1.0.0-alpha.0`. The version baked into local builds comes
from `scripts/generate-version.mjs` as today.

Prereleases change how the latest version is found: GitHub's
`releases/latest` endpoint ignores prereleases, so `swarm upgrade` and
`scripts/install.sh` pick the newest published release from the release list
instead of `releases/latest`: the first entry of `repos/<repo>/releases` that
is not a draft (`gh release list --json tagName,isDraft` filtered the same way
on the gh fallback).

`swarm upgrade` and `scripts/install.sh` point at `mnmal-ai/swarm` and
`mnmal-ai.github.io/swarm/install.sh`. Both download anonymously from
github.com (the releases API for the newest tag, `releases/download/<tag>/<asset>`
for the binary and its `.sha256`) and fall back to an authenticated `gh` only
when github.com answers 404 or 403. The `npm install -g` fallback in
`upgrade` is removed, since no package is ever published and it could never
succeed.

## 9. Dependencies and registries

- `.npmrc` is deleted. No `@mnmal-ai` package resolves from GitHub Packages.
- `@mnmal-ai/hydra-*` (13 packages) and `@mnmal-ai/cortext-substrate` are
  removed. `@mnmal-ai/cortext` moves from 1.26.0 on GitHub Packages to its
  npmjs `next` and is installed in the sidecar runtime, not the monorepo.
- `@mnmal-ai/substrate` is pinned to an exact version (`1.0.0-alpha.6` at
  the time of writing) from npmjs. `latest` on npmjs is a `0.0.0`
  placeholder, so neither `^` ranges nor bare installs are safe. Its one
  scoped dependency, `@mnmal-ai/holomap-clusterer`, is public on npmjs.
- `@mnmal-ai/context-render` pinned to its npmjs `next` (`1.0.0-alpha.5`).
- `@mnmal-ai/axon-tokens` exists only on GitHub Packages and the Axon repo is
  private. The CLI's dashboard server and the hosted dashboard both import
  its two CSS files. Open question 2 (section 13) decides between vendoring
  the two files and publishing the package.

## 10. Anonymity: what gets scrubbed, and how it is verified

The scrub runs on the archived tree before anything else, and the verification
runs again on the final tree immediately before the first push.

**Dropped outright** (not scrubbed):

- `tests/fixtures/recall-fixtures.json` (29.6 MB of harvested real prompts
  with home-directory paths from another private project). Regenerated from
  the throwaway project with the existing harvest script, after the port.
- The stray session transcript in `packages/cli/`
  (`2026-04-03-001831-local-command-caveat…txt`).
- `docs/plans/`, `docs/superpowers/` (the source repo's), `docs/whitepapers/`.
  They are design history with personal paths and names throughout. This
  design document is the first entry in swarm's own `docs/superpowers/`.
- `.xcodebuildmcp/`.
- `dashboard/.releaserc.json` (orphaned; no workflow runs it).

**Scrubbed in place** (the remaining hits live in tests and fixtures):

| Pattern | Where it is on source `main` | Replacement |
|---|---|---|
| the previous maintainer's names and handles (private group `identity`) | author-id, commit-style, commit-policy, telemetry and oversight tests; a document-index golden fixture; a scrub-test fixture | neutral fixture identities (`example-user`, `user@example.invalid`) |
| home-directory paths (generic group `paths`) | the same tests and fixtures | `/home/user/…` or a tmp path the test creates |
| private infrastructure hosts and addresses (private group `infra`) | `project-hydra` and `local-only` tests | `substrate.example.invalid`, a documentation-range IP |
| the old Pages URL and the API Gateway URL (private group `infra`) | README, installer, upgrade, telemetry, dashboard | the swarm Pages URL; the placeholder constant |
| `mnmal-ai/brain` slug | upgrade, installer, Lambda, task-backend test fixtures | `mnmal-ai/swarm` |
| Wiki and Discussions links | README | removed until swarm has them |

Nothing on `main` matches the private `nda` group; the re-scan is kept in
the verification script anyway.

**Verification**, scripted at `scripts/verify-anonymous.sh` and run before
the first push and in every later release:

1. `git grep -iE` over the working tree for every pattern above, expecting
   zero hits, printing any that remain.
2. `git ls-files | xargs file` to list non-text files; `strings` on each,
   grepped for the same patterns. (There are none on `main` today.)
3. `git log --format='%an <%ae>%n%cn <%ce>'` on the new repo, expecting only
   the `mnmal-ai-two` identity.
4. A check that no session trailer or session-link URL (generic group `history`)
   appears in any commit message.

The maintainer sees the verification output before the push.

## 11. Testing and verification

- **Baseline.** The source repo's suite is run once in a clean clone
  (`pnpm install && pnpm turbo build && pnpm turbo test`) so swarm's results
  can be compared to a known-green baseline. It needs a GitHub Packages read
  token for the Hydra packages; the maintainer runs it or supplies an
  environment where it already passes.
- **Unit suites** use a mocked client, as today, and need no Postgres.
- **Plugin unit suites** compose the swarm plugin in-process with
  `compose`, `MemorySubstrateServer`, `MemoryDataset` and `FakeEmbedder`
  from `@mnmal-ai/substrate/testing` and drive it with `server.inject`.
- **Integration suites** (gated by `SWARM_SDK_E2E=1`) need a dialable URL,
  and the in-process memory server has no socket, so the vitest global
  setup spawns `substrate serve` from the workspace's own
  `@mnmal-ai/substrate` install on an ephemeral port with
  `SUBSTRATE_DATABASE_URL=memory` and a temporary plugin directory
  symlinked to the workspace's `node_modules`. No Postgres, no Docker. The
  pg-backed suites use the test stack on 42337 to 42341 via
  `docker-compose.test.yml`.
- **Rename hazard** fixed as part of the port: four tests and the CLI's
  `discoverSwarmPath` fall back to a sibling directory literally named
  `brain`; they now use `SWARM_PATH` or a fixture directory inside the repo
  and fail loudly instead of skipping.
- **Real run.** `swarm init` in a throwaway directory with a dedicated
  Substrate stack on non-default ports and `local_only: true`, seeded with the
  repo's own docs, then `env -u ANTHROPIC_API_KEY swarm run` on a small goal,
  checked for: a `prepareTask` round trip, worker and reviewer telemetry rows
  in `swarm/SessionEvent`, an `Observation` written, `swarm drainstop`
  promoting it into a cortext row, the local dashboard rendering, and
  `swarm substrate stop` leaving no process behind.
- **Binary.** `scripts/compile.sh` builds a native binary; the Substrate
  sidecar smoke test (the renamed `smoke-hydra-binary.sh`) boots the sidecar
  from the compiled binary's embedded plugin tarball.

## 12. Migrating the maintainer's own projects (manual checklist)

Not automated, by decision. For each project:

1. Install `swarm` beside `brain`; do not uninstall brain.
2. Copy `.brain/` to `.swarm/`; rename `brain.json` to `swarm.json`.
3. In `.swarm/config.json` and each `domains/<p>/config.json`, rename the
   `hydra` block to `substrate`, choose ports that do not collide with the
   project's running brain stack, and keep `local_only: true` where it was
   set.
4. Copy `~/.brain/config.json` to `~/.swarm/config.json`; rename `hydra_url`
   to `substrate_url` or delete it, and drop `postgres_url` and `db_mode` (or
   re-run `swarm db setup`).
5. Re-seed content with `swarm seed`; Hydra stores are not reusable.
6. Rename task labels on the project's board (`brain:*` to `swarm:*`), or
   keep both while brain still runs.
7. Replace the agent files swarm writes (`prepare-for-swarm.md`,
   `SWARM-PROMPT.md`, copilot instructions, the marker comments) with
   `swarm init`'s output.
8. Any wrapper scripts of the maintainer's own are theirs to update.

## 13. Maintainer decisions (resolved 2026-10-23)

1. **Runtime: A, a Node runtime directory.** Node ≥ 26.2 becomes a user
   prerequisite, reported by `swarm doctor` with a fix line.
2. **Axon tokens: vendored.** The two CSS files from `@mnmal-ai/axon-tokens`
   are copied into the repo with a note that they are generated from the
   Axon design tokens.
3. **This document stays in the public tree.**
4. **fnl links stay** pointing at `mnmal-ai/fnl`; the feature works for org
   members until fnl is public.
5. **Versioning: the 1.0.0-alpha line.** Releases are `v1.0.0-alpha.N` from
   a prerelease-configured `main` until the maintainer is confident in a
   1.0.0 (section 8).
6. **CI without Postgres.** The pg-backed integration suites run locally
   only; no service container is added.

## 14. Builder's calls (made here, listed so they can be checked)

- Swarm's default ports are 32337/32338 and the test stack is 42337/42338.
- The sidecars' system actors are `swarm` and `swarm-meta`; the namespaces
  are `swarm`, `swarm-docs` (cold) and `swarm_meta` (meta). Two sidecars
  and two Postgres containers, as today.
- Cortext stays, from npmjs, as the promotion target; `Observation` and the
  drainstop promotion move from `hydra-plane` into the swarm plugin.
- Recall from the resolvers is dense-only with `boost: false`, for parity.
- One shared runtime install, one plugin directory per stack.
- The WebSocket transport is dropped rather than ported.
- Raw pgvector DDL, backfill and relabel tooling are dropped in favour of
  Substrate recall's own.
- `hydra explore` has no replacement beyond `substrate status` and the TUI.
- The plugin reaches recall through the engine handle, not a held embedder.
- Rename happens after the port, so each is reviewable in the working tree.
- The telemetry endpoint is a single constant with a placeholder value.
- The `npm install -g` fallback in `upgrade` is removed.
- The recall fixtures file is regenerated rather than scrubbed.
- Source design history is not carried over.
- Custom resolvers are registered as Substrate registry entries of the kinds
  the plugin author guide documents; the exact `kind` for query ops is
  confirmed against `@mnmal-ai/substrate/sdk` types at build time.
