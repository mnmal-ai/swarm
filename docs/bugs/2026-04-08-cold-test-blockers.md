# Cold Test Blockers — 2026-04-08

Every bug found during the clean-room end-to-end test, written against the engine that preceded Substrate. None of these were fixed there; the store layer has since been replaced, so read them as history. "The store" below means that earlier engine.

## Critical

### 1. Seed creates duplicates — no upsert by path
**What:** Every call to `ingest("SwarmContent", data, "extend")` appends without checking if entities with the same `path` already exist. Running seed twice doubles all content.
**Impact:** Swarm loads duplicate context, wastes tokens, confuses agents.
**Root cause:** the store auto-CRUD has no upsert. The `replace` mode we built fails because the store doesn't generate delete mutations (returns 500).
**Fix options:** (a) the engine maintainer adds upsert or bulk-delete to the store. (b) Seed queries existing paths, diffs, only inserts new/changed. (c) the engine maintainer adds a working delete mutation.
**Workaround:** Wipe DB before every seed. Not viable for production.
**Filed:** No

### 2. `swarm init` fails to start sidecar after DB setup
**What:** Init writes `~/.swarm/config.json` with postgres_url, then calls `ensureSubstrateReady` which fails because `findRepoRoot()` can't find `docker-compose.yml` in the project dir (binary install). Logs "No database configuration found" even though config was just written.
**Impact:** First `swarm init` with Docker doesn't seed content. User must manually start sidecar and seed.
**Root cause:** `ensureSubstrateReady` in init.ts resolves `dockerComposeDir` from `resolveDbConfig`, but this may run before the config is fully written, or the sidecar probe fails before Docker bootstrapping is attempted.
**Fix:** Ensure init passes `~/.swarm/infrastructure/` directly to `ensureSubstrateReady` after Docker setup, without going through `resolveDbConfig`.
**Filed:** No

### 3. `swarm add skill` doesn't fetch reference material
**What:** Adding a skill from a GitHub repo only downloads the SKILL.md file. Reference files listed in the skill (e.g., `references/migration-from-xctest.md`) are not fetched.
**Impact:** Agent is told to consult reference material that doesn't exist.
**Fix:** Parse SKILL.md for `references/` paths, fetch from the same repo.
**Filed:** Yes

### 4. `swarm add skill` doesn't ingest into the store
**What:** Skills are written to `.swarm/skills/vetted/` on disk but not ingested as SwarmContent entities in the store.
**Impact:** Skills aren't available to the Router/Loader until a manual seed.
**Fix:** After writing skill file to disk, ingest it as a SwarmContent entity.
**Filed:** No

## Major

### 5. The old client's `ingest("replace")` did not work
**What:** Replace mode tries to delete existing entities before ingesting. The store's auto-CRUD returns 500 on delete mutations for SwarmConfig, SwarmContent, SwarmRoute.
**Impact:** The "replace" mode we built and shipped is non-functional.
**Fix:** Either the engine maintainer adds working delete mutations, or we remove replace mode and implement dedup differently.
**Filed:** No

### 6. Orchestrator reads config.json from disk, not the store
**What:** `run.ts` line 1183 reads `config.json` via `readFile`, bypassing the store entirely. The store copy (seeded as SwarmContent) is never consulted and can go stale.
**Impact:** Editing config in the store has no effect. The store is not the source of truth for config despite the design intent.
**Fix:** Either read config from the store, or stop seeding config.json into the store (treat it as a disk-only file).
**Filed:** No

### 7. Seed script `accepted` count shows `undefined`
**What:** The seed script prints `undefined config entities ingested` instead of an actual count.
**Impact:** Cosmetic — user can't verify how many entities were ingested.
**Root cause:** `ingest` response may not have the `accepted` field, or the field name differs.
**Filed:** No

### 8. `swarm db status` partially broken without `pg_isready`
**What:** The v0.23.2 binary has the three-method fallback (pg_isready → docker exec → TCP probe), but during testing the Docker exec fallback didn't trigger correctly when Docker was running but the compose project name didn't match.
**Impact:** Status shows "not reachable" when Postgres is actually running.
**Fix:** Verify the Docker exec path uses the correct compose file and service name.
**Filed:** No

## Minor

### 9. Duplicate logic: `seed.ts` vs `scripts/seed-swarm.ts`
**What:** Two independent implementations of the same seeding logic with the same constants (TIER_MAP, EXCLUDED_FILES, directory walk). They will drift.
**Fix:** Have `scripts/seed-swarm.ts` import from `packages/cli/src/cli/seed.ts`, or extract shared module.
**Filed:** No

### 10. `swarm init` sharing options missing Transcripts
**What:** Fixed in v0.23.2 but needs verification in next clean-room test.
**Filed:** Fixed

### 12. `swarm init` doesn't set reviewer/arbiter backends to Claude Code
**What:** When user selects "Claude Code" as runtime backend during init, only `backends.worker` is generated with `type: "claude-code"`. Reviewer and arbiter have no backend config, so they fall back to `models.provider` (direct API) which requires `ANTHROPIC_API_KEY`. Every review fails with "No API key — oversight will reject/escalate for safety", causing infinite retry loops.
**Impact:** Swarm run is completely non-functional out of the box when using Claude Code without an API key set.
**Fix:** When init scaffolds `backends.worker` with `type: "claude-code"`, also scaffold `backends.reviewer` and `backends.arbiter` with the same type and MCP servers.
**Filed:** No

### 13. Concurrency limiter exceeded — 4 workers active with max_workers=3
**What:** Dashboard shows "4/3 active" workers. When a task times out and decomposes into sub-tasks, the sub-tasks are dispatched before the parent's worker slot is released, exceeding the configured `max_workers` limit.
**Impact:** Resource contention, higher costs than budgeted, potential merge conflicts between worktrees.
**Fix:** Orchestrator must await parent worker slot release before dispatching decomposed sub-tasks.
**Filed:** No

### 14. swarm sync --force doesn't restart sidecar after DB reset
**What:** `--force` calls `swarm db reset` which wipes the Postgres volume. The running sidecar loses its DB connection. The subsequent `ensureSubstrateReady` reconnect either fails (sidecar is stale) or can't find docker-compose.yml (binary install). User must manually kill sidecar and restart.
**Impact:** `swarm sync --force` fails with "Ingest failed: 500 Internal Server Error" or "No database configuration found."
**Fix:** After DB reset, kill the sidecar process, wait for Postgres readiness, then restart the sidecar before re-seeding.
**Filed:** No

### 15. swarm init auto-seed + swarm sync creates duplicates
**What:** `swarm init` auto-seeds content after DB setup. Then `swarm sync` runs and the dedup should prevent duplicates — but it doesn't. Every path is duplicated exactly 2x.
**Root cause:** Unclear — `getExistingKeys` queries existing paths and the dedup check should skip them. Possibly a timing issue where the init seed and sync seed overlap, or the path format differs between the two seed invocations.
**Impact:** Double content in the store, wasted tokens.
**Workaround:** After init, run `swarm sync --force` (which requires a manual sidecar restart).
**Filed:** No

### 16. swarm init scaffold doesn't copy worker MCP servers to reviewer/arbiter backends
**What:** The scaffold template generates `backends.reviewer` and `backends.arbiter` with `type: "claude-code"` but no `mcpServers`. The worker's MCP config is not copied to reviewer/arbiter. User must manually add MCP to each backend.
**Impact:** Reviewer and arbiter can't use MCP tools (e.g., xcodebuild) unless manually configured.
**Fix:** Scaffold should copy `backends.worker.mcpServers` to reviewer and arbiter.
**Filed:** No

### 17. --dashboard-lan doesn't show LAN URL in output
**What:** `swarm run --dashboard-lan` correctly binds to `0.0.0.0:3141` but the output only prints `http://localhost:3141`. It should also print the LAN address (e.g., `http://192.168.x.x:3141`).
**Impact:** User doesn't know the LAN URL without manually looking up their IP.
**Fix:** Resolve local network IP and print both URLs.
**Filed:** No

### 18. Task timeouts not configurable in config.json
**What:** Task timeouts are hardcoded in `orchestrator/src/complexity/index.ts`. The `getTimeoutForComplexity` function accepts overrides but `run.ts` never passes them from config. Users can't adjust timeouts without editing source.
**Impact:** Iterative tasks (build → fix → rebuild) timeout at 5 minutes for moderate complexity, which is too short for xcodebuild cycles.
**Fix:** Add `timeouts: { simple: 300000, moderate: 600000, complex: 900000 }` to config.json schema and wire it through run.ts to `getTimeoutForComplexity`.
**Filed:** No

### 19. Single-task timeout escalates as "systemic failure"
**What:** When 1 of 1 tasks fails with the same category, the orchestrator logs "all 1 failure(s) share the same category — systemic issue" and escalates to human. This is a single task failure, not systemic.
**Impact:** Orchestrator gives up on the entire goal instead of retrying or continuing.
**Fix:** Only trigger systemic escalation when N > 2 tasks share the same failure category.
**Filed:** No

### 11. Auto-sync only triggers when the store is completely empty
**What:** `swarm run` auto-sync checks `if (!hasContent)`. If the store has any SwarmContent (even stale), sync is skipped. Editing .swarm/ files after initial seed has no effect until manual `swarm sync`.
**Impact:** Users expect file edits to be picked up. They aren't.
**Fix:** Compare file mtimes against last-seed timestamp, or always sync before run.
**Filed:** No
