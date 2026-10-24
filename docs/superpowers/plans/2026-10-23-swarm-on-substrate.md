# Swarm on Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `mnmal-ai/swarm` from the source repo as one fresh, anonymous commit, with Hydra replaced by a Substrate sidecar and every feature intact.

**Architecture:** The source tree is imported into the swarm clone and ported in place while it still builds against Hydra: a Substrate coordinator plugin (`packages/substrate-plugin`) takes the server-side resolvers, a client package (`packages/substrate`) takes the HTTP client and sidecar lifecycle, consumers switch over, Hydra is deleted, then the mechanical `brain` to `swarm` rename, telemetry, release and workflow changes land. The final task squashes the local history into a single verified commit.

**Tech Stack:** TypeScript (strict), pnpm 10 + Turborepo, Vitest, Bun 1.3.11 for binaries, `@mnmal-ai/substrate` 1.0.0-alpha.6 (exact), `@mnmal-ai/cortext` and `@mnmal-ai/context-render` at npmjs `next`, Postgres 17 + pgvector in Docker, Node ≥ 26.2 for the sidecar runtime.

**Spec:** `docs/superpowers/specs/2026-10-23-swarm-on-substrate-design.md`

## Global Constraints

- Work in the swarm clone (`$SWARM` below). Read the source repo only from the scratch clone at `$SCRATCH/brain` (`SCRATCH` is the session scratchpad directory) or `git show origin/main:<path>`; never from the predecessor installation's own checkouts.
- Git identity in the clone: `mnmal-ai-two <273891930+mnmal-ai-two@users.noreply.github.com>`, `commit.gpgsign=false` (already set). Every `gh` call runs as the organisation's bot account, never by switching gh's active account.
- Local commits are allowed and expected per task; **nothing is pushed** before Task 17, and Task 17 pushes exactly one fresh commit after the maintainer's yes.
- Commit messages: conventional prefix, `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer, no session links.
- Until Task 11 removes Hydra, `pnpm install` needs the GitHub Packages token in `GH_PACKAGES_TOKEN`, supplied from the maintainer's secret store to that one command. Never write the token into a file; `.npmrc` references `${GH_PACKAGES_TOKEN}` only.
- `@mnmal-ai/substrate` is pinned `1.0.0-alpha.6` everywhere (no `^`); `@mnmal-ai/cortext` and `@mnmal-ai/context-render` pinned to the exact `next` version at install time.
- No new GitHub Actions trigger beyond the four workflows in the spec. No `gh workflow run`.
- Every `claude` or `swarm` run is started with `env -u ANTHROPIC_API_KEY`.
- Never touch the predecessor installation (its binary, sidecars, Postgres containers and dashboards), the ports other services on the maintainer's machine already use, or any agent process already running. Swarm defaults are 32337/32338 (cold), 32340/32341 (meta); the test stack is 42337/42338/42340/42341.
- Node version floor for the sidecar runtime: `>=26.2.0`. Plugin `contractVersion`: `>=1.0.0-alpha.0 <2.0.0`.
- Copyright line in `LICENSE`: `Copyright 2026 mnmal-ai`.

## Review Focus

1. **Node absent or older than 26.2 on the user's machine.** `swarm doctor` and `swarm substrate start` name the floor and a fix; they never try to install Node. Pinned in Task 8 (`resolveNode` tests).
2. **`npm install` of the runtime directory fails or is interrupted.** No half-installed runtime is treated as ready; the next start retries from a clean state and the error names the directory. Pinned in Task 8 (`ensureRuntimeInstalled` marker-file test).
3. **A stray `SWARM_SUBSTRATE_ENDPOINT` pointing at another stack while a project declares a dedicated one.** Refused with an error naming both, never silently followed. Pinned in Task 10 (`project-substrate` env-mismatch test).
4. **`swarm upgrade` when the repo has only prereleases, or none.** Picks the newest prerelease; with no releases at all it says so and exits non-zero without touching the installed binary. Pinned in Task 14.
5. **`local_only` with an Ollama or Postgres URL that is not loopback.** The run refuses to start and names the offending target. Pinned in Task 8 (`collectLocalOnlyViolations` tests keep the Ollama case).

---

### Task 0: Baseline the source repo's test suite

**Files:**
- Create: `$SCRATCH/baseline.md` (outside the repo)

**Interfaces:**
- Produces: a green/red baseline the later `pnpm turbo test` runs are compared to.

- [ ] **Step 1: Confirm the token is available**

Check that `GH_PACKAGES_TOKEN` can be supplied from the maintainer's secret store.
Expected: it can. If not, stop and ask the maintainer to add it.

- [ ] **Step 2: Point the scratch clone's `.npmrc` at the token variable**

Append to `$SCRATCH/brain/.npmrc`: `//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}`

- [ ] **Step 3: Install, build, test**

Run (from `$SCRATCH/brain`, with `GH_PACKAGES_TOKEN` supplied): `pnpm install --frozen-lockfile && pnpm turbo build && pnpm turbo test 2>&1 | tee $SCRATCH/baseline.log`
Expected: build succeeds; record the per-package pass/fail summary in `$SCRATCH/baseline.md`. Known: `packages/events` has no test script.

- [ ] **Step 4: Keep the Axon CSS for Task 13**

Run: `cp $SCRATCH/brain/node_modules/@mnmal-ai/axon-tokens/tokens.css $SCRATCH/brain/node_modules/@mnmal-ai/axon-tokens/theme-light.css $SCRATCH/`
Expected: both files present in `$SCRATCH`.

---

### Task 1: Import the source tree as the working base

**Files:**
- Create: everything under `$SWARM/` from `git archive`
- Create: `LICENSE`
- Delete: `tests/fixtures/recall-fixtures.json`, `packages/cli/2026-04-03-001831-local-command-caveatcaveat-the-messages-below.txt`, `docs/plans/`, `docs/superpowers/plans/*` and `docs/superpowers/specs/*` from the source (keep this repo's two files), `docs/whitepapers/`, `.xcodebuildmcp/`, `dashboard/.releaserc.json`

- [ ] **Step 1: Archive and extract**

Run (from `$SCRATCH/brain`): `git archive --format=tar origin/main | tar -x -C $SWARM`
Expected: `ls $SWARM/packages` lists the 12 source packages.

- [ ] **Step 2: Delete the dropped files and directories**

Run: `cd $SWARM && rm -rf tests/fixtures/recall-fixtures.json packages/cli/2026-04-03-*.txt docs/plans docs/whitepapers .xcodebuildmcp dashboard/.releaserc.json && find docs/superpowers -type f ! -name '2026-10-23-*' -delete`
Expected: `ls docs/superpowers/specs docs/superpowers/plans` shows only this spec and this plan.

- [ ] **Step 3: Write `LICENSE`**

Apache-2.0 text with the appendix notice `Copyright 2026 mnmal-ai`. Add `"license": "Apache-2.0"` to the root `package.json`.

- [ ] **Step 4: Keep installs working for the port**

Append to `.npmrc`: `//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}` (this file is deleted in Task 11).

- [ ] **Step 5: Verify the imported tree matches the baseline**

Run (with `GH_PACKAGES_TOKEN` supplied): `pnpm install --frozen-lockfile && pnpm turbo build && pnpm turbo test`
Expected: same per-package results as `$SCRATCH/baseline.md`, with the recall benchmark test skipping because its fixture is gone.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: import source tree under Apache-2.0"
```

---

### Task 2: Scrub personal identity and add the anonymity verifier

**Files:**
- Create: `scripts/verify-anonymous.sh`
- Modify: `packages/cli/src/cli/author-id.test.ts`, `packages/cli/tests/commit-style.test.ts`, `packages/orchestrator/tests/commit-policy.test.ts`, `packages/oversight/tests/hydra-entities.test.ts`, `packages/telemetry/tests/hydra-telemetry.test.ts`, `packages/telemetry/tests/telemetry.test.ts`, `packages/telemetry/tests/fixtures/scrub-test-payload/has-paths.txt`, `packages/core/tests/fixtures/document-index-golden.json`, `packages/cli/tests/project-hydra.test.ts`, `packages/hydra/src/local-only.test.ts`, `README.md`

**Interfaces:**
- Produces: `scripts/verify-anonymous.sh [--only <group>]` with groups `identity`, `nda`, `infra`, `hydra`, `history`; exit 0 when the selected groups have zero hits, exit 1 and print `file:line` otherwise.

- [ ] **Step 1: Write the verifier**

Generic groups live in the script (matched over `git ls-files`, `pnpm-lock.yaml` excluded for `hydra` only):
- `paths`: the macOS home-directory prefix (case-sensitive) and MacBook hostnames.
- `hydra`: `hydra`.
- `history`: a session-link URL and a session trailer.
The private pattern groups (identity, nda, infra, people) are loaded from the file outside the repo (`${SWARM_ANONYMITY_PATTERNS:-$HOME/.config/swarm/anonymity-patterns}`, one `group<TAB>regex` per line, case-insensitive); they are never written into the repository. `--generic-only` skips them.

- [ ] **Step 2: Run it to see the starting count**

Run: `scripts/verify-anonymous.sh --only identity`
Expected: exit 1 listing the files in the Modify list above (and nothing in `docs/`).

- [ ] **Step 3: Replace identities in the listed tests and fixtures**

Fixture author becomes `example-user <example-user@example.invalid>`; home paths become `/home/user/...`; the private shared-store host and address in `project-hydra.test.ts` and `local-only.test.ts` become `substrate.example.invalid:3100` and `203.0.113.7`. Keep every assertion's meaning (the scrub tests must still see a path-shaped string to scrub). Remove the Wiki and Discussions line from `README.md`.

- [ ] **Step 4: Verify**

Run: `scripts/verify-anonymous.sh --only identity && scripts/verify-anonymous.sh --only nda && scripts/verify-anonymous.sh --only history && pnpm turbo test --filter=@mnmal-ai/brain-cli --filter=@mnmal-ai/brain-telemetry --filter=@mnmal-ai/brain-orchestrator --filter=@mnmal-ai/brain-oversight --filter=@mnmal-ai/brain-core --filter=@mnmal-ai/brain-hydra`
Expected: three exit 0s; tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scrub personal identity from tests and fixtures; add verify-anonymous"
```

---

### Task 3: Shared types package and the Substrate plugin skeleton

**Files:**
- Create: `packages/substrate-shared/{package.json,tsconfig.json,src/index.ts,src/resolver-types.ts,src/split.ts,src/project-scope.ts,src/constants.ts}`
- Create: `packages/substrate-plugin/{package.json,tsconfig.json,vitest.config.ts,default-config.json,config.schema.json}`
- Create: `packages/substrate-plugin/src/{types/brain-types.ts,types/meta-types.ts,types/docs-types.ts,types/observation.ts,namespaces.ts,plugin.ts,bootstrap.ts,index.ts}`
- Create: `packages/substrate-plugin/test/{harness.ts,schema.test.ts}`
- Modify: `pnpm-workspace.yaml` (no change if it globs `packages/*`), root `package.json` devDependencies (`@mnmal-ai/substrate`)

**Interfaces:**
- Produces (`@mnmal-ai/brain-substrate-shared`): every request/response interface and constant now in `packages/hydra/src/resolvers/types.ts` (`LoadContextRequest`, `LoadContextResponse`, `ClassifyIntentRequest`, `ClassifyIntentResponse`, `PrepareTaskRequest`, `PrepareTaskResponse`, `PersistTaskTelemetryRequest`, `PersistTaskTelemetryResponse`, `ObserveRequest`, `ObserveResponse`, `SessionEventInput`, `TranscriptEntryInput`, `WorkerResultInput`, `ReviewVerdictInput`, `RouteMatched`, `IndexedDocument`, `IndexedSection`, `SectionRanking`, `LoadContextFile`, `ClassifyConfidence`, `RECALL_TOP_K`, `RECALL_CONFIG_CATEGORY`, `RECALL_SIMILARITY_THRESHOLD_KEY`, `RECALL_SIMILARITY_THRESHOLD_DEFAULT`, `DEFAULT_RANK_LIMIT`, `coerceSimilarityThreshold`, `BRAIN_CONTENT_TYPE`), plus `splitSections`, `estimateTokens`, `fallbackSynopsis`, `synopsisOverride` from `sections/split.ts` and `selectProjectContent`, `selectProjectRoutes`, `isLegacyScoped`, `LEGACY_GLOBAL_PROJECT_ID` from `resolvers/project-scope.ts`. Namespace constants: `BRAIN_NAMESPACE = "brain"`, `BRAIN_META_NAMESPACE = "brain_meta"`, `docsNamespaceFor(ns) => \`${ns}-docs\``, `BRAIN_DOCS_NAMESPACE`, `BRAIN_TYPE_NAMES` (15 names: the 14 plus `Observation`), `BRAIN_META_TYPE_NAMES` (5).
- Produces (`@mnmal-ai/brain-substrate-plugin`): `createBrainSubstratePlugin(config: BrainPluginConfig): CoordinatorPlugin` with `BrainPluginConfig = { scope: "cold" | "meta" | "combined"; namespace?: string; contextNamespace?: string; drainstopIntervalMs?: number }` (defaults `"brain"`, `"cortext"`, `3_600_000`); `bootstrap` default export built with `defineBootstrap.coordinator`; plugin `name: "brain"`, `contractVersion: ">=1.0.0-alpha.0 <2.0.0"`.
- Produces (test harness): `bootTestServer(opts: { scope: BrainPluginConfig["scope"]; coordinators?: CoordinatorPlugin[]; embedderDimension?: number }): Promise<TestServer>` where `TestServer = { inject(req: { method: "GET" | "POST"; url: string; body?: unknown }): Promise<{ status: number; json(): unknown }>; engine: EngineHandle; stop(): Promise<void> }`, composed from `@mnmal-ai/substrate/testing` (`compose`, `MemorySubstrateServer`, `MemoryDataset`, `MemoryEdgesStore`, `FakeEmbedder`) with the recall kernel plugin and `systemActor: "brain-test"`.

- [ ] **Step 1: Create `packages/substrate-shared` by moving the listed files out of `packages/hydra`**

Move with `git mv`; leave re-exports in `packages/hydra/src/resolvers/types.ts`, `sections/split.ts` and `resolvers/project-scope.ts` so the Hydra package still builds. Add the workspace dependency to `packages/hydra/package.json`.

- [ ] **Step 2: Verify Hydra still builds and tests**

Run: `pnpm turbo build --filter=@mnmal-ai/brain-hydra && pnpm turbo test --filter=@mnmal-ai/brain-hydra`
Expected: PASS, same counts as before.

- [ ] **Step 3: Write the failing schema test**

```ts
// packages/substrate-plugin/test/schema.test.ts
it("cold scope publishes brain and brain-docs with every type", async () => {
  const s = await bootTestServer({ scope: "cold" });
  const brain = (await s.inject({ method: "GET", url: "/substrate/v1/schema/brain" })).json() as { types: Record<string, unknown> };
  expect(Object.keys(brain.types).sort()).toEqual([...BRAIN_TYPE_NAMES].sort());
  const docs = (await s.inject({ method: "GET", url: "/substrate/v1/schema/brain-docs" })).json() as { types: Record<string, unknown> };
  expect(Object.keys(docs.types).sort()).toEqual(["Document", "Section"]);
  await s.stop();
});
it("meta scope publishes only brain_meta", …)  // 5 types, /schema/brain → 404
it("createBrainConfig round-trips through autoCRUD", …) // mutate brain/createBrainConfig then query brain/BrainConfig where key eq
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test`
Expected: FAIL, modules not found.

- [ ] **Step 5: Add `@mnmal-ai/substrate@1.0.0-alpha.6` to the root devDependencies and the plugin's devDependencies, with `peerDependencies: { "@mnmal-ai/substrate": ">=1.0.0-alpha.0 <2.0.0" }`; write the plugin `package.json` manifest**

```json
"substrate": { "tier": "coordinator", "entry": "./dist/bootstrap.js", "defaultConfig": "./default-config.json", "configSchema": "./config.schema.json", "configBasename": "brain" }
```
Build with `tsdown` (or `esbuild`) so `@mnmal-ai/brain-substrate-shared` and `@mnmal-ai/brain-types` are inlined and only `@mnmal-ai/substrate` and `zod` stay external; `files: ["dist", "default-config.json", "config.schema.json"]`.

- [ ] **Step 6: Port the type definitions**

`types/brain-types.ts`: the 14 types from `packages/hydra/src/brain-types.ts` with `field.*` from `@mnmal-ai/substrate/sdk` (same names, nullability and `indexed: false` flags; `BrainContent.embed.source` unchanged; no `lexical.source`). `types/observation.ts`: `Observation` with `ts: field.date()`, `kind: field.string()`, `body: field.string({ indexed: false })`, `context: field.string({ indexed: false, nullable: true })`, `confidence: field.number({ nullable: true })`, `tags: field.string()`, `ttlHours: field.number({ nullable: true })`, `isAnchor: field.boolean({ nullable: true })`. `types/meta-types.ts`: the 5 from `plugin.ts:43-101`. `types/docs-types.ts`: `brainDocsTypes(namespace)` with `Section.document: field.crossRef(ns, "Document", { onDelete: "cascade" })` and `embed.source: sectionEmbedText`.

- [ ] **Step 7: Implement `namespaces.ts` and `plugin.ts`**

`buildNamespaces(config): NamespaceDefinition[]`: cold → `[defineNamespace(ns, {...brainTypes, Observation}), defineNamespace(docsNamespaceFor(ns), brainDocsTypes(docsNs))]`; meta → `[defineNamespace(ns + "_meta", metaTypes)]`; combined → all three. `createBrainSubstratePlugin` returns `{ name: "brain", contractVersion, namespaces, onStart(ctx) { holder.engine = ctx.engine } }`. `bootstrap.ts` parses `{ scope, namespace, contextNamespace, drainstopIntervalMs }` with zod and defaults.

- [ ] **Step 8: Implement the harness and run the tests**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test`
Expected: PASS (3 tests). If `@mnmal-ai/substrate/recall` exports no plugin factory, build the kernel plugin through `loadPlugins` from `/testing` against a temp dir whose `node_modules/@mnmal-ai/substrate` symlinks the workspace copy; record which path worked in `test/harness.ts`'s header comment.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(substrate): shared types package and coordinator plugin skeleton"
```

---

### Task 4: Port the query resolvers into the plugin

**Files:**
- Move (`git mv` from `packages/hydra/src/resolvers/`): `assemble.ts`, `classify-intent.ts`, `load-context.ts`, `prepare-task.ts`, `recall.ts` and their `*.test.ts` into `packages/substrate-plugin/src/resolvers/`
- Create: `packages/substrate-plugin/src/resolvers/engine-recall.ts`, `packages/substrate-plugin/src/resolvers/register.ts`, `packages/substrate-plugin/test/prepare-task.e2e.test.ts`
- Modify: `packages/substrate-plugin/src/plugin.ts`, `packages/hydra/src/plugin.ts` (import the moved resolvers from the plugin package so Hydra keeps building until Task 11)

**Interfaces:**
- Consumes: `holder.engine` from Task 3.
- Produces: `interface SemanticRecall { search(args: { namespace: string; type: string; query: string; k: number; threshold: number; where?: Record<string, unknown>; rowFields: Record<string, true> | true }): Promise<SemanticHit[]> }` and `makeEngineRecall(getEngine: () => EngineHandle | undefined): SemanticRecall` issuing `recall/Hit` frames with `boost: false`; `registerBrainResolvers(ctx: NamespaceInstallContext, deps: { recall: SemanticRecall; docs: () => Promise<DocsReader> })` registering `loadContext` and `classifyIntent` and `prepareTask` as `kind: "type"` and (Task 5) `persistTaskTelemetry` as `kind: "mutation"`, with `policy: ctx.pluginPolicy ?? allowAll()`. `DocsReader = { read(type: "Document" | "Section", params: { where?: …; limit?: number }): Promise<Row[]> }` implemented over `engine.query` against the docs namespace.

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// test/prepare-task.e2e.test.ts
it("prepareTask classifies by keyword and loads routed content within budget", async () => {
  const s = await bootTestServer({ scope: "cold" });
  await seed(s, { routes: [{ intent: "testing", keywords: '["vitest","test"]', contentPaths: '["docs/testing.md"]' }],
                  content: [{ path: "docs/testing.md", tier: "core", intent: "testing", content: "# Testing\nRun vitest.", tokenEstimate: 8, projectId: "p1" }] });
  const res = (await s.inject({ method: "POST", url: "/substrate/v1/query",
    body: { "brain/prepareTask": { params: { prompt: "add a vitest test", projectId: "p1", budgetTokens: 4000 }, fields: { intent: true, confidence: true, files: true } } } })).json() as Envelope;
  expect(res.errors ?? []).toEqual([]);
  const row = res.data["brain/prepareTask"];
  expect(row.intent).toBe("testing");
  expect(row.confidence).toBe("keyword");
  expect(row.files.map((f) => f.path)).toEqual(["docs/testing.md"]);
  await s.stop();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test -- prepare-task.e2e`
Expected: FAIL with the frame key missing from `data`.

- [ ] **Step 3: Move the resolver files and replace their recall dependency**

In `classify-intent.ts`, `load-context.ts`, `prepare-task.ts`, `recall.ts`: replace `BrainRecallDeps` (embedder + store + `knnSearch`) with `SemanticRecall.search`; `recallBrainContent` and `rankSections` call it with `rowFields` naming the fields they read (`path`, `tier`, `intent`, `tokenEstimate`, `projectId` for content; `documentId`, `headingPath`, `tokenEstimate` for sections). Replace `HydraDataset`/`ResolverArgs` types with the `@mnmal-ai/substrate/sdk` equivalents; replace the `DocsDataset` closure with `deps.docs`.

- [ ] **Step 4: Implement `engine-recall.ts` and `register.ts`; wire `registerBrainResolvers` into the cold namespace's `install`**

`makeEngineRecall` builds the frame `{ "recall/Hit": { params: { query, namespace, type, k, threshold, where, boost: false }, fields: { id: true, score: true, row: rowFields } } }`, checks `errors` first, maps hits to `SemanticHit { id, score, row }`.

- [ ] **Step 5: Run the moved unit tests and the e2e test**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test && pnpm turbo build --filter=@mnmal-ai/brain-hydra && pnpm turbo test --filter=@mnmal-ai/brain-hydra`
Expected: PASS. The moved unit tests keep their assertions; only the dataset/recall stubs change shape.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(substrate): port classifyIntent, loadContext and prepareTask resolvers"
```

---

### Task 5: Port `persistTaskTelemetry`

**Files:**
- Move: `packages/hydra/src/resolvers/persist-task-telemetry.ts` and its test into the plugin
- Create: `packages/substrate-plugin/test/persist-task-telemetry.e2e.test.ts`

**Interfaces:**
- Consumes: `registerBrainResolvers` from Task 4.
- Produces: the `brain/persistTaskTelemetry` mutation (`PersistTaskTelemetryRequest` → `PersistTaskTelemetryResponse`, unchanged shapes).

- [ ] **Step 1: Write the failing tests**

```ts
it("writes the worker result, review verdicts and session events atomically", …) // one mutate; then query each type by sessionId and count rows
it("a failing verdict write leaves no rows behind", …) // pass one verdict with an undeclared field; expect errors non-empty and zero WorkerResult rows for that sessionId
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test -- persist-task-telemetry.e2e`
Expected: FAIL.

- [ ] **Step 3: Port the resolver**

Replace `args.dataset.withTransaction(...)` with direct `args.dataset.write` calls on the transaction-scoped dataset a mutation resolver receives; keep `RESERVED_AUTOCRUD_FIELDS` stripping; register as `kind: "mutation"`; return `{ id: "ack", ... }` with the existing response fields.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(substrate): port persistTaskTelemetry as a transactional mutation"
```

---

### Task 6: Observations, drainstop promotion and the plugin routes

**Files:**
- Create: `packages/substrate-plugin/src/drainstop/{drainstop.ts,promotion.ts,expiry.ts,reject-promotion.ts}`, `packages/substrate-plugin/src/routes.ts`, `packages/substrate-plugin/src/onboard.ts`
- Create: `packages/substrate-plugin/test/{drainstop.test.ts,routes.test.ts,cortext-fixture.ts}`
- Source to port (read-only, via `gh api repos/mnmal-ai/hydra/contents/plugins/hydra-plane/src/<file> --jq .content | base64 -d`): `drainstop.ts`, `reject-promotion.ts`, `namespace.ts`; and `packages/hydra/src/promotion-engine.ts`

**Interfaces:**
- Consumes: `Observation` type and `holder.engine` (Task 3).
- Produces: `runDrainstopOnce(engine: EngineHandle, cfg: DrainstopConfig): Promise<DrainstopResult>` with `DrainstopConfig = { planeNamespace: string; contextNamespace: string; now?: Date }` and `DrainstopResult = { promoted: { todos: number; decisions: number; agentRules: number }; expired: number; anchorSeeded: boolean }`; constants `DRAINSTOP_KIND_DEFAULTS`, `DEFAULT_TTL_UNKNOWN_KIND_HOURS = 168`, `CONCERN_RECURRENCE_MIN_GROUP_SIZE = 3`; `withStrictPromotions(engine): EngineHandle` and `PromotionWriteError`; routes `GET /substrate/v1/plugins/brain/onboard` and `POST /substrate/v1/plugins/brain/trigger-drainstop` (returns `DrainstopResult` as JSON, 200); `TRIGGER_DRAINSTOP_PATH = "/substrate/v1/plugins/brain/trigger-drainstop"` exported from the shared package; a `schedule` entry running `expireObservations` every `drainstopIntervalMs`.

- [ ] **Step 1: Write the cortext fixture and the failing drainstop tests**

`cortext-fixture.ts`: a coordinator `name: "cortext-fixture"` owning namespace `cortext` with `Todo { title, body }`, `Decision { topic, choice, rationale }`, `AgentRule { category, rule }` (the fields drainstop writes). Tests:
```ts
it("seeds the calibration anchor once", …)        // two runs → exactly one isAnchor row
it("promotes fold-back-candidate to a Todo and deletes the observation", …)
it("promotes architectural with confidence > 80 to a Decision", …)
it("promotes user-framing with confidence 100 to an AgentRule", …)
it("expires observations past their kind TTL and keeps the anchor", …) // now = +200h
it("wraps a refused cortext write in PromotionWriteError", …)      // fixture rejects a title → error, observation kept
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test -- drainstop`
Expected: FAIL.

- [ ] **Step 3: Port the promotion rules and expiry from hydra-plane, writing through `engine.mutate`**

Same kind mappings, thresholds, anchor seed body and tags, TTL table and unknown-kind default as the source; reads via `engine.query` on `<planeNamespace>/Observation`; promotion writes as `<contextNamespace>/createTodo|createDecision|createAgentRule` frames with the caller's `ctx` forwarded; deletes via `<planeNamespace>/deleteObservation`.

- [ ] **Step 4: Implement `routes.ts`, `onboard.ts` and the schedule; attach to the plugin**

`onboardInstructions`: `summary`, `types` (one line per type), `workflows.prepareTask` and `workflows.persistTaskTelemetry` with their frame keys. Route test: `POST …/trigger-drainstop` returns 200 with a `DrainstopResult`; `GET …/onboard` returns the same object as `onboardInstructions`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @mnmal-ai/brain-substrate-plugin test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(substrate): Observation type, drainstop promotion into cortext, plugin routes"
```

---

### Task 7: Package the plugin as an embeddable tarball

**Files:**
- Create: `scripts/pack-substrate-plugin.sh`, `packages/cli/assets/.gitkeep`
- Modify: `packages/cli/package.json` (`prebuild` runs the pack script; `files` includes `assets`), `.gitignore` (`packages/cli/assets/*.tgz`), `turbo.json` (cli `build` depends on `@mnmal-ai/brain-substrate-plugin#build`)
- Create: `packages/cli/src/substrate/plugin-asset.ts`, `packages/cli/tests/plugin-asset.test.ts`

**Interfaces:**
- Produces: `resolvePluginTarball(): Promise<{ path: string; version: string }>` — in a Bun binary returns the embedded file (imported with `with { type: "file" }`) written to `~/.brain/substrate/cache/brain-substrate-plugin-<version>.tgz`; in dev returns `packages/cli/assets/brain-substrate-plugin.tgz`.

- [ ] **Step 1: Write the failing test**

```ts
it("the packed tarball carries a substrate manifest and the pinned version", async () => {
  const { path, version } = await resolvePluginTarball();
  const manifest = JSON.parse(await tarEntry(path, "package/package.json"));
  expect(manifest.substrate.tier).toBe("coordinator");
  expect(manifest.version).toBe(version);
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `pnpm --filter @mnmal-ai/brain-cli test -- plugin-asset`. Expected: FAIL.

- [ ] **Step 3: Write `pack-substrate-plugin.sh`** — `pnpm --filter @mnmal-ai/brain-substrate-plugin build && pnpm --filter @mnmal-ai/brain-substrate-plugin pack --pack-destination packages/cli/assets` then rename the output to `brain-substrate-plugin.tgz`.

- [ ] **Step 4: Implement `plugin-asset.ts`** and wire `prebuild`.

- [ ] **Step 5: Run** — `pnpm turbo build --filter=@mnmal-ai/brain-cli && pnpm --filter @mnmal-ai/brain-cli test -- plugin-asset`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(substrate): pack the plugin into the CLI as an embedded tarball"`

---

### Task 8: The client package: `@mnmal-ai/brain-substrate`

**Files:**
- Create: `packages/substrate/{package.json,tsconfig.json,vitest.config.ts}`
- Move from `packages/hydra/src/` (`git mv`, then edit): `client.ts` + `client.test.ts`, `transport/http-transport.ts` + test, `transport/types.ts`, `task-telemetry-buffer.ts` + test, `subscribe-or-poll.ts` + test, `local-only.ts` + test, `sections/sync.ts` + test, `sections/embeddings.ts` (only `resolveEmbedderSettings`, `KNOWN_EMBEDDING_DIMENSIONS`, `DEFAULT_EMBED_TIMEOUT_MS` survive, in `embedder-settings.ts`)
- Create: `packages/substrate/src/{index.ts,lifecycle/runtime.ts,lifecycle/stacks.ts,lifecycle/sidecar.ts,lifecycle/postgres.ts,lifecycle/endpoint.ts,lifecycle/ready.ts,lifecycle/specs.ts}` and tests `lifecycle/{runtime,stacks,endpoint,ready}.test.ts`
- Leave in `packages/hydra` for Task 11 to delete: `server.ts`, `meta-server.ts`, `manifest-*.ts`, `observation-plane.ts`, `promotion-engine.ts`, `relabel-context.ts`, `context-namespace.ts`, `decode-subscription.ts`, `transport/{codec,correlation,ws-transport}.ts`, `plugin.ts`, `bootstrap.ts`, `brain-types.ts`, `docs-types.ts`, `lifecycle.ts`

**Interfaces:**
- Produces, re-exported from `packages/substrate/src/index.ts` under the same names the consumers import today, with `Hydra` → `Substrate` in identifiers: `SubstrateClient` (constructor `(endpoint: string, options?: SubstrateClientOptions)`, methods `query`, `mutate`, `batchMutate`, `ingest`, `getSchema(): Promise<SubstrateSchema>`, `hasType`, `invalidateSchema`, `isHealthy`, `close`, `loadContext`, `classifyIntent`, `prepareTask`, `persistTaskTelemetry`, `observe`; `subscribe` removed), `BrainQueryClient`, `FieldSelection`, `BatchMutateOperation`, `SubstrateSchema = { namespaces: Record<string, { types: Record<string, unknown>; queries: Record<string, unknown>; mutations: Record<string, unknown> }> }`, `TaskTelemetryBuffer`, `subscribeOrPoll` (polling only; `SubscribeOrPollOptions.transport` removed), `syncDocuments`, `substrateDocsStore(client)`, `DocsStore`, `documentTitle`, sync constants; local-only: `LOCAL_ONLY_ENV = "BRAIN_SUBSTRATE_LOCAL_ONLY"`, `LocalOnlyViolation`, `isLocalOnlyEnv`, `isLoopbackHost`, `loopbackViolation`, `collectLocalOnlyViolations`, `LocalOnlyTargets = { endpoint: string; metaEndpoint: string; postgresUrl: string; metaPostgresUrl: string; ollamaUrl: string }`, `resolveLocalOnlyTargets`, `assertLocalOnly`; lifecycle: `SIDECAR_SPECS: readonly SidecarSpec[]` (`{ label: "cold" | "meta"; port: number; namespace: string; scope: "cold" | "meta"; postgresUrl: string; postgresComposeFile?: string }`, ports 32338/32341, Postgres `postgresql://brain:brain@localhost:32337/brain` and `…:32340/brain_meta`), `resolveSubstrateEndpoint`, `resolveSubstrateEndpointWithSource` (chain: explicit, `BRAIN_SUBSTRATE_ENDPOINT`, `substrate_url` in `~/.brain/config.json`, `BRAIN_SUBSTRATE_PORT`, default), `resolveNode(): Promise<{ path: string; version: string }>` (throws `NodeVersionError` naming the floor `26.2.0`), `ensureRuntimeInstalled(opts: { runtimeDir: string; pluginTarball: string; substrateVersion: string; cortextVersion: string; quiet: boolean }): Promise<RuntimeInfo>` (`RuntimeInfo = { runtimeDir: string; substrateBin: string; installedMarker: string }`; writes `package.json`, runs `npm install --no-audit --no-fund --loglevel=error`, writes `.installed-<hash>` only on success), `ensureStackDir(spec: SidecarSpec, opts: { runtimeDir: string; embedder: EmbedderSettings; contextNamespace: string }): string` (writes `package.json` listing `@mnmal-ai/substrate`, `@mnmal-ai/brain-substrate-plugin` and, for cold, `@mnmal-ai/cortext`; `brain.config.json` `{ scope, namespace, contextNamespace }`; `substrate-recall.config.json` `{ embedder: { kind: "ollama", baseUrl, model, dimension }, writeEmbedTimeoutMs: 120000 }`; `node_modules` symlink), `ensureSidecar(spec, opts)`, `ensureAllSidecars(quiet)`, `stopSidecar(spec)`, `ensurePostgres`, `probePostgresReachable`, `ensureTypesRegistered(client, specs)` (per-namespace `/substrate/v1/schema/<ns>` checks plus the four custom ops on `brain`), `ensureSubstrateReady(opts: EnsureSubstrateReadyOptions)` with the same option names as `EnsureHydraReadyOptions`, `findRepoRoot`.
- Stack directories live at `~/.brain/substrate/stacks/<label>/` for the shared stack and `~/.brain/substrate/stacks/<compose_project>-<label>/` for dedicated ones; the runtime at `~/.brain/substrate/runtime/`.

- [ ] **Step 1: Write the failing lifecycle unit tests** (`HOME` pointed at a temp dir in each)

```ts
// endpoint.test.ts
it("resolves in order: explicit, env endpoint, saved substrate_url, env port, default 32338", …)
// runtime.test.ts
it("resolveNode rejects node older than 26.2.0 with the floor in the message", …) // stub execFile → "v24.0.0"
it("ensureRuntimeInstalled is a no-op when the marker for this hash exists", …)   // npm not invoked
it("a failed npm install leaves no marker and the next call retries", …)
// stacks.test.ts
it("ensureStackDir writes package.json, brain.config.json, recall config and the node_modules symlink", …)
it("cold stacks list cortext; meta stacks do not", …)
// ready.test.ts
it("ensureTypesRegistered fails naming the missing namespace or op", …) // stub client.getSchema
// local-only.test.ts keeps every existing case, with the Ollama non-loopback case asserting the message names "ollama"
```

- [ ] **Step 2: Run to verify they fail** — Run: `pnpm --filter @mnmal-ai/brain-substrate test`. Expected: FAIL.

- [ ] **Step 3: Move the client files and retarget routes**

`http-transport.ts`: `/substrate/v1/query`, `/substrate/v1/mutate` (keep the `Idempotency-Key` header). `client.ts`: `getSchema` fetches `/substrate/v1/schema/<ns>` for the client's namespace and its docs namespace; every response checks `errors` before `data` and throws `SubstrateFrameError { key, code, message }` for a missing key; `observe` posts `brain/createObservation`; remove `subscribe`, `#initTransport`, the WS path and `transport` option.

- [ ] **Step 4: Implement the lifecycle modules**

`sidecar.ts` spawns `<node> <runtime>/node_modules/@mnmal-ai/substrate/dist/substrate.js serve` detached with `SUBSTRATE_DATABASE_URL`, `SUBSTRATE_PLUGIN_DIR=<stack dir>`, `SUBSTRATE_SYSTEM_ACTOR` (`brain` / `brain-meta`), `HOST=127.0.0.1`, `PORT`, stdout/stderr to `<stack dir>/server.log`, pid to `<stack dir>/server.pid`; polls `/health` at 500 ms up to 15 s; `stopSidecar` reads the pid file, SIGTERMs, waits 5 s, SIGKILLs. `postgres.ts` is the moved `ensurePostgres`/`probePostgresReachable` with the new defaults and `~/.brain/infrastructure/docker-compose.yml` detection by the string `brain-substrate`.

- [ ] **Step 5: Run the package tests** — Run: `pnpm --filter @mnmal-ai/brain-substrate test`. Expected: PASS.

- [ ] **Step 6: Write and run the gated real-sidecar test** (`test/sidecar.e2e.test.ts`, runs only with `BRAIN_SDK_E2E=1` and network): `ensureRuntimeInstalled` into a temp `HOME`, `ensureStackDir`, `ensureSidecar` with `SUBSTRATE_DATABASE_URL=memory`, then `ensureTypesRegistered` passes and `stopSidecar` leaves no process (`kill -0` fails).

Run: `BRAIN_SDK_E2E=1 pnpm --filter @mnmal-ai/brain-substrate test -- sidecar.e2e`
Expected: PASS (first run installs the runtime; note the time).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(substrate): client package with HTTP transport and sidecar lifecycle"`

---

### Task 9: Switch the library consumers and the test setup

**Files:**
- Modify: `packages/core/src/{brain.ts,loader/index.ts,router/index.ts,agent-rules.ts,document-index.ts,file-query-adapter.ts}`, `packages/orchestrator/src/{orchestrator/index.ts,learning/capture.ts,learning/task-execution-mirror.ts}`, `packages/oversight/src/index.ts`, `packages/telemetry/src/telemetry/index.ts`, `packages/benchmark/src/recall-benchmark.ts`, each package's `package.json` and tests that import `@mnmal-ai/brain-hydra`
- Replace: `tests/setup/isolated-hydra.ts` → `tests/setup/isolated-substrate.ts`; `tests/integration/fixtures/memory-sidecar.mjs` → removed
- Modify: `tests/integration/*.test.ts` that compose Hydra in-process (`manifest-host*`, `observe-plane-drainstop`, `recall-quality`, `relabel-context`, `ws-transport-parity`, `hydra-namespace-scan`, `isolated-hydra-env`, `seed-routes`, `context-*`, `binding-rules`, `goal-taskexecution-durability`): keep the behaviour tests against the spawned sidecar; delete `relabel-context`, `ws-transport-parity`, `manifest-host*`, `hydra-namespace-scan`
- Modify: `vitest.workspace.ts`, `docker-compose.test.yml` (ports 42337/42338/42340/42341, services `brain-substrate-test`, `brain-meta-test`), `scripts/cold-test-env.sh`

**Interfaces:**
- Consumes: everything in Task 8's export list; `TRIGGER_DRAINSTOP_PATH` from the shared package.
- Produces: `tests/setup/isolated-substrate.ts` default export `setup(): Promise<() => Promise<void>>` that, when `BRAIN_SDK_E2E=1`, spawns `substrate serve` from `node_modules/@mnmal-ai/substrate/dist/substrate.js` with `SUBSTRATE_DATABASE_URL=memory`, a temp `SUBSTRATE_PLUGIN_DIR` whose `package.json` lists `@mnmal-ai/substrate` and `@mnmal-ai/brain-substrate-plugin` and whose `node_modules` symlinks the workspace's (`packages/substrate-plugin` built), on an ephemeral port, exporting `BRAIN_SUBSTRATE_ENDPOINT`, `BRAIN_SUBSTRATE_PORT`, `BRAIN_META_ENDPOINT`, `BRAIN_META_PORT` (second process, meta scope) for the test process only; falls back to the docker test stack when `BRAIN_SDK_PG=1`. The temp plugin dir's `substrate-recall.config.json` uses `kind: "ollama"`, model `nomic-embed-text`, dimension 768 when `http://127.0.0.1:11434/api/tags` answers, else `kind: "none"`, in which case `recall-quality` and the section-ranking suites skip with the message `recall suites need Ollama`.

- [ ] **Step 1: Switch imports package by package** (`@mnmal-ai/brain-hydra` → `@mnmal-ai/brain-substrate`, `HydraClient` → `SubstrateClient`, `ensureHydraReady` → `ensureSubstrateReady`), running each package's tests after its switch:

Run: `pnpm turbo test --filter=@mnmal-ai/brain-core --filter=@mnmal-ai/brain-orchestrator --filter=@mnmal-ai/brain-oversight --filter=@mnmal-ai/brain-telemetry --filter=@mnmal-ai/brain-benchmark`
Expected: PASS with the same counts as baseline. `packages/benchmark/src/recall-benchmark.ts` boots the sidecar through the Task 9 setup helper instead of composing in-process.

- [ ] **Step 2: Write `isolated-substrate.ts`** and point `tests/integration/vitest.config.ts` and `packages/*/vitest.config.ts` `globalSetup` at it.

- [ ] **Step 3: Run the E2E suites** — Run: `BRAIN_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/brain-integration-tests`. Expected: PASS for the retained suites; the deleted ones are gone from the run.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "refactor: library packages and integration tests use the Substrate client and a spawned sidecar"`

---

### Task 10: Switch the CLI

**Files:**
- Rename: `packages/cli/src/cli/hydra.ts` → `substrate.ts`, `packages/cli/src/project-hydra.ts` → `project-substrate.ts`, tests `hydra-cli.test.ts` → `substrate-cli.test.ts`, `project-hydra.test.ts` → `project-substrate.test.ts`, `dashboard-hydra-proxy.test.ts` → `dashboard-substrate-proxy.test.ts`
- Modify: `packages/cli/src/cli/{main.ts,doctor.ts,doctor-probes.ts,db.ts,drainstop.ts,run.ts,init.ts,dashboard.ts,context-sections.ts,relabel-context.ts (delete),uninstall.ts,seed.ts,sync…}`, `packages/cli/src/server/{index.ts,dashboard.html}`, `packages/cli/src/config.ts`, `packages/cli/package.json`

**Interfaces:**
- Consumes: Task 8 exports; `resolvePluginTarball` (Task 7).
- Produces: `brain substrate start|stop|status` (the `hydra` command, minus `dashboard`/`explore`); `readProjectSubstrateConfig(brainDir, project): ProjectSubstrateConfig` reading the `substrate` block with keys `local_only`, `port`, `postgres_url`, `meta_port`, `meta_postgres_url`, `compose_file`, `compose_project`, applied as `BRAIN_SUBSTRATE_PORT`, `BRAIN_SUBSTRATE_POSTGRES_URL`, `BRAIN_META_PORT`, `BRAIN_META_POSTGRES_URL`, `BRAIN_SUBSTRATE_DEDICATED=1`, `BRAIN_SUBSTRATE_LOCAL_ONLY=1`; embedder env `BRAIN_EMBEDDER_OLLAMA_URL|MODEL|DIMENSION|TIMEOUT_MS` (replacing `HYDRA_EMBEDDER_*`) flowing into `ensureStackDir`'s recall config; dashboard proxy prefix `/api/substrate/*` → sidecar; `db` compose templates on 32337/32340 with services `brain-substrate`/`brain-meta` and no `relabel-context` subcommand; `main.ts` without the `--start-hydra-server`/`--start-meta-server` re-entry flags; `doctor` probes: node version, runtime installed, cold pg, cold sidecar, meta pg, meta sidecar, dashboard, CLI version, each with a fix line (`brain substrate start`, or the Node floor).

- [ ] **Step 1: Update the renamed tests first** — `project-substrate.test.ts` keeps every case including the env-mismatch one (`BRAIN_SUBSTRATE_ENDPOINT` disagreeing with a dedicated stack → `ProjectSubstrateConfigError` naming both). Add to `doctor` tests: `it("reports Node below 26.2.0 with the floor and a fix line", …)`.

- [ ] **Step 2: Run to verify they fail** — Run: `pnpm --filter @mnmal-ai/brain-cli test`. Expected: FAIL on the renamed modules.

- [ ] **Step 3: Port the command modules** — mechanical, following the Interfaces block; `substrate status` prints one line per sidecar (health, namespace count) and per Postgres; `drainstop.ts` posts to `TRIGGER_DRAINSTOP_PATH` on the cold endpoint.

- [ ] **Step 4: Run the CLI tests** — Run: `pnpm --filter @mnmal-ai/brain-cli test`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor(cli): substrate command, project config and doctor on the Substrate sidecar"`

---

### Task 11: Remove Hydra

**Files:**
- Delete: `packages/hydra/`, `.npmrc`, `docker-compose.dedicated.yml`'s `hydra` naming (rename services/volumes to `brain-substrate*`), `scripts/{smoke-hydra-binary.sh,spike-manifest-*.mts,record-manifest-migration-decision.ts,record-topology-decision.ts}`, `environment.md` Hydra sections
- Modify: every remaining `package.json` with an `@mnmal-ai/hydra-*`, `@mnmal-ai/cortext`, `@mnmal-ai/cortext-substrate` dependency; `pnpm-lock.yaml` regenerated; `docker-compose*.yml`; `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/*.md` (Hydra paragraphs rewritten for Substrate; `CLAUDE.md`'s seven duplicated "Cold-Test Runbook" sections collapsed to one)

- [ ] **Step 1: Delete and reinstall without the token**

Run: `git rm -r packages/hydra .npmrc && pnpm install && pnpm turbo build`
Expected: install succeeds with no GitHub Packages access; `pnpm why @mnmal-ai/hydra-core` reports nothing.

- [ ] **Step 2: Rewrite the docs** — `CLAUDE.md` sections: What this does, Infrastructure (Substrate sidecars, runtime directory, ports table), Repo layout (with `substrate`, `substrate-plugin`, `substrate-shared`), Build commands, Key design decisions, Namespaces and types, Conventions, Do-not list, Cold-test runbook (once), Versioning. Same for `AGENTS.md` at its shorter length.

- [ ] **Step 3: Verify** — Run: `pnpm turbo test && BRAIN_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/brain-integration-tests && scripts/verify-anonymous.sh --only hydra`
Expected: PASS; verifier exit 0 (zero `hydra` hits, `pnpm-lock.yaml` excluded by the script).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "chore: remove Hydra and the GitHub Packages registry"`

---

### Task 12: Rename brain to swarm

**Files:**
- Create: `scripts/rename-brain-to-swarm.sh` (one-off; deleted at the end of the task), `tests/fixtures/content/{swarm.json,core/*.md}` (a minimal content fixture: two routes, three files)
- Modify: every tracked text file; every path containing `brain` (`git mv`)

- [ ] **Step 1: Rename paths**

Run: `git ls-files | grep -i brain | while read f; do git mv "$f" "$(echo "$f" | sed 's/brain/swarm/g; s/Brain/Swarm/g; s/BRAIN/SWARM/g')"; done` (create parent dirs first; `packages/brain` → `packages/swarm`, `tools/brain-admin` → `tools/swarm-admin`, `scripts/seed-brain.ts` → `scripts/seed-swarm.ts`, `packages/core/src/brain.ts` → `swarm.ts`, `dashboard/src/components/BrainDashboard.jsx` → `SwarmDashboard.jsx`).

- [ ] **Step 2: Rewrite contents, case-aware, with word guards**

`perl -pi -e 's/\bbrainstorm/\x00BS\x00/g; s/brain/swarm/g; s/Brain/Swarm/g; s/BRAIN/SWARM/g; s/\x00BS\x00/brainstorm/g'` over `git ls-files` text files, excluding `pnpm-lock.yaml` (regenerate it) and this spec and plan. Then `pnpm install` to regenerate the lockfile.

- [ ] **Step 3: Fix the fallbacks that assumed a sibling directory named `brain`**

`tests/integration/helpers.ts`, `backend-retry.test.ts`, `e2e-*.test.ts`, `packages/core/tests/route-coverage.test.ts`: content path is `SWARM_PATH` if set, else `tests/fixtures/content`; `discoverSwarmPath` in `run.ts` keeps `.swarm/` and the `--swarm-path` flag and drops the `../swarm` sibling fallback. Tests throw if the directory is missing (no silent skip).

- [ ] **Step 4: Verify**

Run: `git grep -in 'swarmstorm\|hydra' -- . ':!pnpm-lock.yaml' | wc -l` → `0`; `git grep -c -i brain | wc -l` → `0` outside `docs/superpowers/`; `pnpm turbo build && pnpm turbo test && SWARM_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests`
Expected: PASS. CLI help (`node packages/cli/dist/src/cli/main.js --help`) shows `swarm substrate …` and no `brain`.

- [ ] **Step 5: Delete the rename script and commit** — `git rm scripts/rename-brain-to-swarm.sh && git add -A && git commit -m "refactor: rename brain to swarm across the tree"`

---

### Task 13: Telemetry endpoint, infra rename, vendored Axon tokens

**Files:**
- Create: `packages/telemetry/src/telemetry/endpoint.ts`, `packages/cli/src/server/axon/{tokens.css,theme-light.css}`, `dashboard/src/axon/{tokens.css,theme-light.css}` (copied from `$SCRATCH/*.css` with a header comment `Generated from the Axon design tokens; vendored.`)
- Modify: `packages/telemetry/src/telemetry/upload.ts`, `packages/cli/src/cli/logs.ts`, `dashboard/src/App.jsx`, `dashboard/src/components/RunListPage.jsx`, `dashboard/vite.config.js` (base `/swarm/`), `dashboard/package.json` (name `@mnmal-ai/swarm-dashboard`, drop `@mnmal-ai/axon-tokens`), `dashboard/src/axon.css`, `packages/cli/src/server/index.ts` (read the vendored files), `packages/cli/src/server/dashboard.html`, `packages/cli/package.json` (drop `@mnmal-ai/axon-tokens`), `infra/lib/infra-stack.ts`, `infra/lambda/index.mjs`, `tools/swarm-admin/index.mjs`

**Interfaces:**
- Produces: `DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.example.invalid"` exported from `packages/telemetry/src/telemetry/endpoint.ts` and consumed by upload, logs and the dashboard (`import.meta.env.VITE_TELEMETRY_ENDPOINT ?? DEFAULT`); `infra` resources `swarm-telemetry-${account}`, `swarm-run-index`, `swarm-user-access`, `swarm-telemetry-handler`, `swarm-telemetry-api`; Lambda collaborator check against `mnmal-ai/swarm`.

- [ ] **Step 1: Tests** — `upload.test.ts`: `it("uploads to DEFAULT_TELEMETRY_ENDPOINT when no override is configured", …)`; `infra/test`: existing Jest suite updated for the new names; cli server test: `it("serves the vendored Axon CSS inline", …)` (response contains `--axon-` custom properties).

- [ ] **Step 2: Implement** the constant, the four call sites, the vendored CSS, the infra renames.

- [ ] **Step 3: Verify** — Run: `pnpm turbo test --filter=@mnmal-ai/swarm-telemetry --filter=@mnmal-ai/swarm-cli && (cd infra && npm ci && npm test) && (cd dashboard && npm ci && npm run build) && scripts/verify-anonymous.sh --only infra`
Expected: PASS; dashboard builds without a GitHub Packages token; verifier exit 0.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: single telemetry endpoint constant, renamed infra, vendored Axon tokens"`

---

### Task 14: Release, install, upgrade and workflows

**Files:**
- Modify: `.releaserc.json`, `scripts/compile-release-binaries.sh`, `scripts/compile.sh`, `scripts/generate-version.mjs`, `scripts/install.sh`, `packages/cli/src/cli/upgrade.ts` + `tests/upgrade.test.ts`, `.github/workflows/{ci.yml,release.yml,dashboard-deploy.yml,ai-actions.yml}`, `.github/ai-review.yml`, `.gitignore`, root `package.json` (`version: "1.0.0-alpha.0"`)

**Interfaces:**
- Produces: `.releaserc.json` `branches: [{ "name": "main", "prerelease": "alpha" }]`, assets `swarm-{darwin-arm64,darwin-x64,linux-x64,linux-x64-baseline,linux-arm64}` + `.sha256`; `upgrade.ts` `REPO = "mnmal-ai/swarm"`, `latestReleaseTag(): Promise<string | null>` using `gh release list --repo mnmal-ai/swarm --limit 1 --json tagName --jq '.[0].tagName'` (null when empty), no npm fallback; `install.sh` default URL `https://mnmal-ai.github.io/swarm/install.sh`, same release-list lookup, install name `swarm`, env `SWARM_INSTALL_DIR`.

- [ ] **Step 1: Tests** — `upgrade.test.ts`: `it("picks the newest prerelease tag", …)` (stub gh output `v1.0.0-alpha.3`), `it("exits 1 and leaves the binary alone when there are no releases", …)`. `bash -n scripts/install.sh` and `scripts/install.sh --help` exit 0.

- [ ] **Step 2: Implement** the file changes. `ci.yml`: delete the three `.npmrc`/`GH_PACKAGES_TOKEN` steps; `test:ci` filter includes `@mnmal-ai/swarm-substrate-plugin`, `@mnmal-ai/swarm-substrate`, `@mnmal-ai/swarm-substrate-shared`; no Postgres service. `release.yml`: assets only; Bun `1.3.11`. `dashboard-deploy.yml`: unchanged paths, no token step. `ai-actions.yml`: unchanged apart from removing the comment that cites another repository's PR. `ai-review.yml`: `Swarm class`, `swarm content repo`.

- [ ] **Step 3: Verify** — Run: `pnpm --filter @mnmal-ai/swarm-cli test -- upgrade && bash -n scripts/install.sh && git grep -n 'releases/latest' -- . | wc -l` → `0`; `git grep -n GH_PACKAGES_TOKEN .github | wc -l` → `0`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "ci: prerelease line, swarm assets, no GitHub Packages; release-list lookup in upgrade and install"`

---

### Task 15: Compile the binary and smoke the sidecar from it

**Files:**
- Create: `scripts/smoke-substrate-sidecar.sh` (from the deleted `smoke-hydra-binary.sh`'s intent)

- [ ] **Step 1: Build** — Run: `bash scripts/compile.sh` → `./swarm`; `./swarm --version` prints `1.0.0-alpha.0` (from `generate-version.mjs`).

- [ ] **Step 2: Smoke** — from a scratch CWD with no `node_modules`, with `HOME` set to a temp dir and the test-stack env (`SWARM_SUBSTRATE_PORT=42338 SWARM_SUBSTRATE_POSTGRES_URL=postgresql://swarm:swarm@localhost:42337/swarm SWARM_META_PORT=42341 SWARM_META_POSTGRES_URL=…42340/swarm_meta`) and `docker-compose.test.yml` up: `./swarm substrate start` then `curl -sf localhost:42338/substrate/v1/schema/swarm | jq '.queries | keys'` contains `classifyIntent`, `loadContext`, `prepareTask`; `./swarm substrate stop` then `pgrep -f 'substrate.js serve'` finds nothing for those ports. The script asserts all three and tears down with `docker compose -f docker-compose.test.yml down`.

- [ ] **Step 3: Record** the runtime-install time and binary size in the task's commit message body.

- [ ] **Step 4: Commit** — `git add scripts/smoke-substrate-sidecar.sh && git commit -m "test: smoke the Substrate sidecar from the compiled binary"`

---

### Task 16: Real run on a throwaway project, then regenerate the recall fixtures

**Files:**
- Create (outside the repo): `$SCRATCH/throwaway/` with `git init`, a tiny TypeScript project and `.swarm/` from `swarm init`
- Create: `tests/fixtures/recall-fixtures.json` (small, regenerated)

- [ ] **Step 1: Init** — `cd $SCRATCH/throwaway && git init && $SWARM/swarm init` answering: dedicated stack on 47337/47338/47340/47341 with `local_only: true`, telemetry sharing **no**. Confirm `.swarm/config.json` holds the `substrate` block and `swarm doctor` is all green.

- [ ] **Step 2: Seed** — `$SWARM/swarm seed --swarm-path $SWARM/tests/fixtures/content` then `swarm sync`; `swarm substrate status` shows row counts for `SwarmContent` and `Document`.

- [ ] **Step 3: Run** — `env -u ANTHROPIC_API_KEY $SWARM/swarm run --goal "add a README section describing the project"` and check: the log shows one `prepareTask` call; `swarm/SessionEvent` has rows for `worker` and `reviewer`; a `swarm/Observation` row exists; `swarm drainstop` reports `promoted` ≥ 1 or `expired` ≥ 0 with no error; `swarm dashboard` serves on 3141 and renders the run; `swarm substrate stop` leaves no process; nothing was written outside `$SCRATCH/throwaway` and the temp `HOME`.

- [ ] **Step 4: Regenerate fixtures** — `node scripts/harvest-recall-fixtures.ts` against the throwaway stack (see the script's usage header) limited to the fixture content; commit the result if under 200 KB. `SWARM_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/swarm-benchmark` passes.

- [ ] **Step 5: Commit** — `git add tests/fixtures/recall-fixtures.json && git commit -m "test: regenerate recall fixtures from the fixture content"`

---

### Task 17: Final verification, single fresh commit, push on approval

- [ ] **Step 1: Full verification**

Run: `scripts/verify-anonymous.sh && pnpm turbo build && pnpm turbo test && SWARM_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests && git ls-files | xargs file | grep -v text | tee $SCRATCH/binaries.txt`
Expected: verifier exit 0 for every group; tests pass; `binaries.txt` empty (no binary files are committed; if any appear, `strings <f> | scripts/verify-anonymous.sh --stdin`).

- [ ] **Step 2: Squash into one fresh commit**

```bash
git checkout --orphan fresh && git add -A && git commit -m "feat: swarm 1.0.0-alpha, an agent orchestrator on Substrate" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git branch -D main && git branch -m main
git log --format='%an <%ae>%n%cn <%ce>%n%B' | sort -u
```
Expected: exactly the `mnmal-ai-two` identity and the two message lines; no session trailer, no session URL.

- [ ] **Step 3: Show the maintainer** the verifier output, the `git log` lines, and the test summary. **Stop until they say push.**

- [ ] **Step 4: Push** — `git push -u origin main`. Note for the maintainer: this push triggers `ci.yml`, `release.yml` (cutting `v1.0.0-alpha.1` with binaries) and `dashboard-deploy.yml`, all approved. Before pushing they set the repo secrets `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, Pages (source: Actions), the `github-pages` environment, immutable releases and the `preview-no-build` label.

---

### Task 18: After the push (with the maintainer)

- [ ] **Telemetry collector:** `cd infra && npm ci && npx cdk deploy` with credentials for the organisation's AWS account and a `GITHUB_SERVICE_TOKEN` for the collaborator check; put the resulting API URL into `DEFAULT_TELEMETRY_ENDPOINT` and `VITE_TELEMETRY_ENDPOINT`; PR, merge, release.
- [ ] **Migrate existing projects** with the spec's section 12 checklist, one project at a time, never stopping a running predecessor stack.
- [ ] **Archive the source repo** once swarm has replaced it in daily use.
