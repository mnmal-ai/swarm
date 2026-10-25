# Swarm OS 04: Ingress and Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards on registered Trello and GitHub boards reach the brain by poll and by verified webhook, pass a recorded six-check policy chain, and become `swarm run --card` instances that the brain starts, watches, pauses, resumes, retries and stops within the limits on disk.

**Architecture:** `packages/os/src/ingress` holds thin REST clients that read boards with the brain's own credentials, a `Poller` and the webhook routes; both turn board state into `CardEvent`s. `packages/os/src/dispatch` holds the `Dispatcher`: a policy chain serialised per board whose every outcome is one `DispatchDecision` row per card version, the instance lifecycle (attach, heartbeat, exit, sweep), run control and the dispatch-backed operating commands. `packages/os/src/launcher` starts each run as a detached local process, and `packages/os/src/resources` samples the machine every 15 s. One `mountDispatch(host)` call puts all of it into plan 03's brain: routes on its server, events through its SSE `EventHub`, bodies for its periodic slots.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest, zod 4, global `fetch` with `AbortSignal.timeout`, `node:crypto` (HMAC-SHA1, HMAC-SHA256, `timingSafeEqual`, `createHash`), `node:child_process` (`spawn`, `execFile`), `node:fs`, `node:os`; plan 01's wire types from `@mnmal-ai/swarm-types`; plan 03's `EventHub`, `Tokens`, `reconcile` and `BrainModule`.

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md` ("Ingress", "Registry and the dispatch policy", "Dispatching an instance", "Resources", "Security"), with the shared contracts in `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md` ("Transport", "Brain API", "Launcher", "Dispatcher"). Where this plan and the spec disagree, the spec wins.

## Global Constraints

- The brain starts one kind of process: `swarm run --card <id> --yes --no-tree --swarm-path <path> --os <url> --os-token <token>` (plus `--fresh` for `/retry run <instance> --fresh`), with `cwd = dirname(swarmPath)` and `SWARM_OS_INSTANCE_ID=<instanceId>` in its environment (plan 01's attach client reads it). The brain never runs a worker itself, never moves a card, and never starts, stops, signals or reads a project's Substrate stack.
- Transport is SSE down, HTTP up; the brain has no WebSocket. Plan 04 tells clients things only through `EventHub.publish(visibleTo, { type, payload })`: `instance`, `decision`, `resources`, and `command` events on an instance's own stream (`GET /api/instances/:id/stream`, served by plan 03). A run's upstream calls are the POST routes.
- Instances heartbeat every 15 s (`OS_HEARTBEAT_INTERVAL_MS`). 90 s without one, counted from the later of the last heartbeat and the moment this `Dispatcher` was built, marks an instance `unresponsive`; only the launcher's `status` decides it is gone.
- Polling is always on: every registration every `poll_interval_seconds` (default 120). Webhooks only make the brain react sooner.
- `min_cards` (default 3) is a threshold to start draining; cards in flight count toward depth; draining goes on card by card until no queued card is waiting. `maxInstances` (default 1) caps live instances per registration. `register` (plan 08) writes both defaults; the dispatcher reads the row.
- Limits come from `os.json` `limits` (`max_instances`, `dispatches_per_hour`, `tokens_per_hour`, `tokens_per_day`, `registrable_roots`) and the registration's `tokensPerHour`, read at use time (SIGHUP updates the config object in place). Plan 04 writes nothing to `os.json`. Every dispatch path, including commands and the chief of staff, re-checks the limits inside `dispatch()`, and nothing is dispatched while lockdown is on or the OS stack is unreachable.
- Nothing only in memory: decisions, overrides, draining, instances, phases and pending pause or stop requests are store rows before the brain acts on them. Memory holds only caches the next listing, heartbeat or verdict rebuilds: the queue view, readiness verdicts, poll failure streaks.
- One `DispatchDecision` row per `(boardId, cardId, cardVersion)`, whose `checksJson` is a JSON array of `CheckResult` (what plan 02's `decisionChecks` reads). Arrivals create the row; re-evaluations, exits and commands on that version patch it. Card versions are the board's ISO-8601 timestamps and sort as strings within one board.
- Narration belongs to the chief of staff: plan 04 posts no dispatch or hold lines (plan 06 narrates them from `Dispatcher.onDecision`). Plan 04 posts only the `system` and `question` messages in **Room notices** (asks, unknown boards, refusals, failing polls, and everything about a run's life and death), plus each run's forwarded events as `event` messages from its instance participant.
- Instance tokens come from plan 03's `Tokens`: the raw token goes only to the launcher; rows keep the hash; no message, event, log line or decision holds a token; the token is revoked when the instance ends; published instance rows carry `tokenHash: ""`.
- HTTP errors follow the overview: `{ error: { code, message } }` with `400 bad_request`, `401 unauthenticated`, `403 forbidden`, `404 not_found`, `409 conflict`, `503 store_unavailable`. No plan 04 route takes a cookie-authenticated write, so `X-Swarm-Os: 1` never applies: the instance POST routes are bearer-only (`inst_`, exempt by the overview), the webhook routes are outside `/api` and authenticated by signature, the rest are `GET`s.
- Webhooks are verified against the raw request body; an unverified call gets `401 unauthenticated` and increments a counter; Trello's `HEAD` check gets 200 for a known Trello board.
- Board API calls use global `fetch` with a 10 s timeout; credentials travel only in request headers, never in URLs, errors or logs.
- No new dependencies, and no edit to `packages/os/package.json`, `tsconfig.json` or `vitest.config.ts` (plan 02's; they already carry `@mnmal-ai/swarm-types` and `zod`). The one edit to plan 02's files is Task 9's append of `phase` and `currentTask` to `Instance`.
- Anonymity: fixtures use `board-a`, `board-b`, `project-a`, `owner`, `/path/to/project-a`, `owner-a/repo-a`, `https://os.example`, host `local`. No personal or client names, hostnames or home paths.
- Logging only through plan 02's `createLogger(name)`; no `console.log` in `packages/os/src`.
- Tests are vitest files under `packages/os/tests/`, on `MemoryOsStore`, `FakeClock`, `FakeEventHub`, `FakeLauncher`, `FakeBoardClient`, `FetchStub`, `FakeRoomOpener` and in-test fakes: no network, no real `~/.swarm`, temp dirs only from `mkdtemp`, `ANTHROPIC_API_KEY` unset. A test about an event asserts what was published and who may see it.
- No new GitHub workflows and no trigger changes.
- Every class this plan adds that crosses a process, network, disk, database or model boundary, waits in a queue, or runs on a timer takes `metrics?: Metrics` (default `noopMetrics`) or reads `BrainContext.metrics`; Task 15 records the rows.
- **Package gate**, the last check of every task: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run` passes every file, and `pnpm --filter @mnmal-ai/swarm-os build` exits 0.

## Review Focus

1. **The brain dies between spawning an instance and recording its handle** (a `dispatching` row with no `launcherHandle`, and a live process). Expected: plan 03's `reconcile` keeps the row, a later poll of the same card is held by `not_in_flight`, and the run's `attach` fills the handle from its pid. The card is never started twice. Pinned in Task 9 (`REVIEW FOCUS 1`, plan 03's `reconcile` over this dispatcher); the row-before-start order is pinned in Task 6.
2. **A webhook and a poll report the same new card within a second.** Expected: one `DispatchDecision` and one instance, also when the webhook carries a newer version. Pinned in Task 7 (`REVIEW FOCUS 2`) and end to end in Task 13.
3. **The brain restarts after minutes down while its instances keep running.** Expected: no instance is called unresponsive, and no owner is messaged, until 90 s pass after the restart with no heartbeat. Pinned in Task 9 (`REVIEW FOCUS 3`).
4. **A board's API fails during polls** (rate limit, expired token, timeout, renamed queue column). Expected: that board's poll fails alone, the other registrations still poll, `lastPolledAt` stays at the last good poll, the board's room gets one message per failure streak and one when it recovers, and no credential appears anywhere. Pinned in Task 13 (`REVIEW FOCUS 4`); credentials in errors are pinned in Tasks 1 to 3.
5. **A held card is edited, commented on, or re-polled many times.** Expected: the readiness check (the chief of staff's model once plan 06 fills the slot) is consulted once per card content, never once per version or per poll. Pinned in Task 5 (`REVIEW FOCUS 5`).

## Contracts consumed

Plans 02 and 03 are merged before this plan runs; plans 01 and 05 run alongside it, and plan 06 after it. When a merged plan spells one of these differently, change only the import or call site, in the file this table names, and say so in that task's commit message.

| Plan | Name | Shape this plan relies on | Where |
|---|---|---|---|
| 01 | wire types | from `@mnmal-ai/swarm-types` (`packages/types/src/os-protocol.ts`): `AttachBody`, `AttachResponse { roomId, participantId, roomToken }`, `HeartbeatBody { tokens, phase: InstancePhase, currentTask, dashboardUrl? }`, `ForwardedEvent`, `EventsBody`, `ExitBody { reason: RunExitReason, code, message? }`, `RunExitReason` (`completed`, `nothing_to_do`, `paused`, `stopped`, `login_expired`, `card_not_found`, `failed`), `InstancePhase`, `SessionRole`, `SessionRequest`, `SessionResponse`, `InstanceCommandArgv`, `OS_EVENT_BATCH_MAX` (50), `OS_HEARTBEAT_INTERVAL_MS`. Imported, never redeclared | 4, 9, 14 |
| 02 | store | `OsStore`, `Repo<T>` (`store/store.ts`; `find(where)` filters on equality); row types from `store/rows.ts` with ISO-string dates; `decisionChecks(row)`, `registrationSkipLabels(row)`, `registrationOwners(row)`, `roomMembers(row)`, `readJson`, `toJson` (`store/rows.ts`); `newId(kind)`, `CardRef`, `cardKey` (`store/ids.ts`) | every task |
| 02 | doubles | `MemoryOsStore`, `FakeClock` (`new FakeClock(start?: Date \| string)`, `now()`, `advance(ms)`), `makeConfig(overrides?: DeepPartial<…>)` from `src/testing/index.ts`; `Clock` (`src/clock.ts`); `Logger`, `createLogger` (`src/log.ts`) | every task |
| 03 | config, actor | `OsConfig` (`config/schema.ts`); `Actor` (humans carry `confirmer`) | every task |
| 03 | `EventHub` | `EventPublisher = Pick<EventHub, "publish">`, `publish(visibleTo, { type, payload }): HubEvent` (`sse/hub.ts`); a command waits in the hub's ring buffer and is replayed when the run reconnects with `Last-Event-ID`. `FakeEventHub` (`src/testing/index.ts`) records each `HubEvent` `{ id, type, payload, visibleTo }` in `published` | 4, 10, 12, 14 |
| 03 | `Tokens` | `mintInstanceToken(instanceId): Promise<string>` (the row must exist; it writes `tokenHash`), `revokeInstanceToken(instanceId)`, `mintRoomToken(instanceId, participantId, roomId): string` (`auth/tokens.ts`) | 6, 9, 14 |
| 03 | `reconcile` | `reconcile({ store, launcher, dispatcher, clock, log, hub? })` (`brain/reconcile.ts`): keeps live rows whose process runs, marks gone ones `exited` with `exitReason: BRAIN_RESTART_FOUND_GONE`, then calls `dispatcher.reevaluateHolds(boardId)`; `BrainDispatcher { reevaluateHolds; sweep }` and `BrainLauncher { status; resources }` are slices of this plan's classes | 8, 9 |
| 03 | obligations on plan 04 | `Launcher.status` resolves `handle: ""` by instance id; `reevaluateHolds` holds a card whose last run ended `brain_restart_found_gone` and says so in the board room; nothing dispatches while `lockdown.active()` | 8, 11, 14 |
| 03 | composition | `BrainModule` and `registerBrainModule`, `BrainServices`, the periodic slots `sweep` (30 s) and `resources` (15 s), `server.route` with `requireAuth`, `Lockdown.active()`: reached only through Task 14's `BrainHost` adapter | 14 |
| 05 | `Messaging` | satisfies this plan's `RoomOpener` structurally (`openRoom`, and `post` with `from: { id, kind }` and a `Provenance`); its `post` redacts, stores and publishes the `message` event | 4 to 14 |
| 05 | commands | `registerCommand(spec, into?)` takes a `CommandSpec<A>` whose `args` is a `z.object` keyed by the positional words in order, booleans as `--key` flags; the executor turns argv into that object with `argvToArgs(spec, rest)` and enforces authority, limits, step-up, tripwires and the audit message around `run(ctx, args)`. `Participants.ensureParticipant(role, sessionId, instanceId)` names session participants by session id | 10, 14 |
| 06 | chief of staff | fills the readiness slot (it applies `askFirst` in its `assess`), narrates decisions from `Dispatcher.onDecision`, and answers asks with `/dispatch` or `/hold` | 4, 7 |

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/os/src/ingress/board-client.ts` | `BoardCard`, `BoardClient`, webhook request types, `fetchJson` with the 10 s timeout and error codes | 1 |
| `packages/os/src/ingress/trello-api.ts` | `TrelloApiClient`, callback URL, Trello signature | 2 |
| `packages/os/src/ingress/github-api.ts` | `GitHubApiClient`, GitHub signature | 3 |
| `packages/os/src/launcher/launcher.ts`, `packages/os/src/launcher/fake.ts` | the Launcher contract, `FakeLauncher` | 4 |
| `packages/os/src/dispatch/dispatcher.ts` | contract types (Task 4), then the `Dispatcher` class (Tasks 6 to 9) | 4, 6 to 9 |
| `packages/os/src/dispatch/host.ts` | `RouteSpec`, `ApiCall`, `ApiReply`, `PeriodicTask`, `apiError`, event visibility, `publishInstanceCommand` | 4 |
| `packages/os/src/dispatch/queue.ts` | `KeyedQueue` (in-process serialisation), `QueueView` (queue cache) | 4 |
| `packages/os/src/dispatch/readiness.ts` | `StaticReadiness`, `ReadinessSlot` | 4 |
| `packages/os/src/dispatch/room-opener.ts` | `RoomOpener`, `DispatchRooms` (find-or-open, notices) | 4 |
| `packages/os/src/dispatch/decisions.ts` | decision upsert, sticky holds and asks, `min_cards` overrides | 5 |
| `packages/os/src/dispatch/checks.ts` | the six checks, `runChain`, `ReadinessMemo` | 5 |
| `packages/os/src/resources/usage.ts` | `computeUsage` over instance rows | 5 |
| `packages/os/src/dispatch/holds.ts` | ended-run settlement and re-evaluation over the queue view | 8 |
| `packages/os/src/dispatch/instances.ts` | lifecycle helpers and `exitState` (Task 9), `RunControl` (Task 10) | 9, 10 |
| `packages/substrate-plugin/src/types/os-types.ts`, `packages/os/src/store/rows.ts` | append `phase` and `currentTask` to `Instance` (plan 02's files; append only, skipped where plan 02 already has them) | 9 |
| `packages/os/src/dispatch/commands.ts` | `dispatchCommands` | 10 |
| `packages/os/src/launcher/local.ts` | `LocalLauncher` | 11 |
| `packages/os/src/resources/resources.ts` | `ResourceMonitor`, `storeUsage`, `GET /api/resources` | 12 |
| `packages/os/src/ingress/poller.ts`, `packages/os/src/ingress/webhooks.ts` | `Poller`; webhook routes, `ingestRefs`, `WebhookCounters` | 13 |
| `packages/os/src/dispatch/instance-routes.ts`, `packages/os/src/dispatch/mount.ts`, `packages/os/src/dispatch/brain-module.ts` | the instance HTTP routes; `BrainHost`, `createBoardClients`, `mountDispatch`; the `BrainModule` that puts it in plan 03's brain | 14 |
| `packages/os/src/testing/fetch-stub.ts`, `fake-board-client.ts`, `fake-room-opener.ts` | shared doubles, exported from `src/testing/index.ts` (append-only `// plan 04` block) | 1, 4 |
| `packages/os/src/index.ts` | append-only `// plan 04` export block | 14 |
| `packages/os/tests/dispatch/fixtures.ts`, `packages/os/tests/dispatch/harness.ts` | row builders, `FakeTokens` and the dispatcher harness the later tests use | 1, 6 |

`packages/os/src/launcher/remote.ts` (the remote launcher) is a later plan, not this one. Only `LocalLauncher` assumes the brain shares a filesystem with an instance.

## Room notices

Every notice is `DispatchRooms.say(room, body, { notice, kind?, cardRef?, instanceId?, data? })`: a message from `{ id: "system", kind: "system" }`, kind `system` unless given, with `provenance { source: "system", cardRef? }` and `data { notice, instanceId?, ...data }`, so plan 05's push can tell dead runs and unknown boards from chatter. `<k>` is `<board name>:<cardId>`; `<instance>` is the instance id.

| notice | room | body |
|---|---|---|
| `ask` | board, message kind `question` | the readiness question |
| `unknown_board` | system | `<board name> has no registration: "<title>" (<url>) arrived on it. An owner's /register creates one; nothing is created silently.` |
| `refused` | system | `Not dispatching "<title>" (<k>): <reason>.` |
| `spawn_failed` | board | `Could not start <instance> for <k>: spawn failed: <message>. The card is held: /retry run <instance> to try again.` |
| `attached` | instance | `Attached as <runId>.` |
| `unresponsive` | instance, and board | `No heartbeat for 90 s; asking the launcher whether the process is alive.`, and `<instance> on <k> is unresponsive: no heartbeat for 90 s.` |
| `detached` | board | `<instance> on <k> is running but never attached to the brain; /stop run <instance> stops it through the launcher.` |
| `recovered` | instance | `Heartbeats resumed.` |
| `gone` | board | `<instance> on <k> is gone (no heartbeat, no process). The card is held: /retry run <instance> to try again.` |
| `restart_gone` | board | `<instance> on <k> was gone when the brain restarted. The card is held: /retry run <instance> to try again.` |
| `exited` | board | `<instance> finished <k> (<exitReason>).` |
| `paused` | board | `<instance> paused <k>: /resume run <instance> continues it.` |
| `stopped` | board | `<instance> stopped <k>.` |
| `failed` | board | `<instance> failed on <k>: <exitReason>. The card is held: /retry run <instance> to try again.` |
| `login_expired` | system | `Login expired on <project> (<instance>). Held boards: <board>, <board>. Log in on the host, then /resume board <name>.` |
| `pause_requested`, `stop_requested` | instance | `Pause requested by <by>: the run finishes its task, checkpoints and exits.`, `Stop requested by <by> (<graceful or immediate>).` |
| `poll_failed`, `poll_recovered` | board | `Polling <board> failed (<code>): <message>. Retrying every <poll_interval_seconds> s.`, `Polling <board> recovered after <n> failed polls.` |

`unknown_board` is said at most once per board per 24 h, with the spec's drafted registration in its data: `draft { boardId, boardName, kind, externalId, queueColumn }`, for an owner's `/register`. Inferring the project, repo and stack from the swarm directories on the machine is `register`'s work (plan 08); nothing is created here. `refused` is said only when the card's previous decision had another outcome or reason.

## Events published

| type | payload | `visibleTo` (from `dispatch/host.ts`) | published by |
|---|---|---|---|
| `instance` | `{ instance: InstanceView }`: the row with `tokenHash: ""` plus its registration's `projectName` | `staffOnly`: actor kind `human`, `host` or `cos` | `mountDispatch`, on every instance change |
| `decision` | `{ decision: DispatchDecisionRow }` | `staffOnly` | `mountDispatch`, on every decision change |
| `resources` | `{ snapshot: ResourceSnapshot }` | `staffOnly` | `ResourceMonitor.sample()` |
| `command` | `{ argv: InstanceCommandArgv }`: `["pause"]` or `["stop", "graceful" \| "immediate"]` | `instanceOnly(id)`: `actor.kind === "instance" && actor.instanceId === id` | `RunControl`, through `publishInstanceCommand` (plan 05 publishes `["answer", questionId, body]` with the same helper) |

A `command` published while its run is not attached to its stream waits in the hub's ring buffer and is replayed when the run reconnects with `Last-Event-ID`, so the dispatcher keeps no retry of its own. The ring buffer does not survive a brain restart; the pending request persisted on the instance row does, and `DispatchModule.start()` publishes it once more (Tasks 10 and 14).

---

### Task 1: Board client contract, fetch helper and ingress doubles

**Files:**
- Create: `packages/os/src/ingress/board-client.ts`
- Create: `packages/os/src/testing/fetch-stub.ts`, `packages/os/src/testing/fake-board-client.ts`
- Modify: `packages/os/src/testing/index.ts` (append a `// plan 04` export block)
- Create: `packages/os/tests/dispatch/fixtures.ts`
- Test: `packages/os/tests/ingress/board-client.test.ts`

**Interfaces:**
- Consumes: `CardRef`, `cardKey` (plan 02, `store/ids.ts`); `BoardRow`, `RegistrationRow`, `InstanceRow`; `makeRow`, `makeConfig` (plan 02, `src/testing/index.ts`); `OsConfig`, `Actor`, `Logger`.
- Produces:

```ts
// packages/os/src/ingress/board-client.ts
export interface BoardCard { ref: CardRef; version: string; title: string; body: string; labels: string[]; column: string; url: string }   // ref.boardId is the store's Board.id
export interface WebhookRequest { board: BoardRow; headers: Record<string, string | undefined>; rawBody: string; callbackUrl: string }   // header names lower-case
export interface WebhookBody { board: BoardRow; payload: unknown }
export interface BoardClient {
  kind: "trello" | "github";
  listQueue(board: BoardRow): Promise<BoardCard[]>;
  getCard(ref: CardRef): Promise<BoardCard | null>;
  verifyWebhook(req: WebhookRequest): boolean;
  parseWebhook(body: WebhookBody): CardRef[];
}
export type BoardClients = Partial<Record<BoardClient["kind"], BoardClient>>;
export function clientFor(clients: BoardClients, board: BoardRow): BoardClient | null;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type BoardApiErrorCode = "auth" | "not_found" | "rate_limited" | "http" | "timeout" | "network" | "bad_response" | "queue_column_missing" | "no_credentials";
export class BoardApiError extends Error { readonly code: BoardApiErrorCode; readonly status: number | null; constructor(code: BoardApiErrorCode, message: string, status?: number) }
export const BOARD_API_TIMEOUT_MS = 10_000;
export function fetchJson<T>(fetch: FetchLike, url: string, init: RequestInit, timeoutMs?: number): Promise<T>;
export function timingSafeEqualString(a: string, b: string): boolean;

// packages/os/src/testing/fetch-stub.ts
export interface StubReply { status?: number; json?: unknown; text?: string; hang?: boolean; error?: Error }
export interface StubCall { method: string; url: string; headers: Record<string, string>; body: string | null }
export class FetchStub { readonly calls: StubCall[]; on(method: string, url: string | RegExp, reply: StubReply | ((call: StubCall) => StubReply)): this; readonly fetch: FetchLike }   // first match wins

// packages/os/src/testing/fake-board-client.ts
export class FakeBoardClient implements BoardClient {
  constructor(kind?: "trello" | "github");                // default "trello"
  readonly calls: string[];                               // "listQueue:<boardId>", "getCard:<cardKey>"
  setQueue(boardId: string, cards: BoardCard[]): void;    // the queue in order; every card also becomes gettable
  setCard(card: BoardCard): void;
  deleteCard(ref: CardRef): void;                         // getCard → null, and gone from its queue
  failNext(error: Error, boardId?: string): void;         // the next listQueue/getCard (for that board, when given) rejects with it
  onEmit(handler: (ref: CardRef) => Promise<void>): void;
  emit(ref: CardRef): Promise<void>;                      // one webhook delivery: awaits the handler
}   // verifyWebhook: headers["x-fake-signature"] === "valid"; parseWebhook: (payload as { refs?: CardRef[] }).refs ?? []

// packages/os/tests/dispatch/fixtures.ts
export const T0: Date;                                    // 2026-10-25T09:00:00.000Z
export const OWNER: Actor;                                // { kind: "human", humanId: "owner", sessionId: "sess-1", deviceId: "dev-1", address: "127.0.0.1", confirmer: true }
export function boardRow(over?: Partial<BoardRow>): BoardRow;
export function registrationRow(over?: Partial<RegistrationRow>): RegistrationRow;
export function instanceRow(over?: Partial<InstanceRow>): InstanceRow;
export function boardCard(n: number, over?: Partial<BoardCard>): BoardCard;
export function testConfig(limits?: Partial<OsConfig["limits"]>): OsConfig;
export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void };
export const silentLog: Logger;
```

- [ ] **Step 1: Write the fixtures and the failing test**

`fixtures.ts` builds each row with plan 02's `makeRow(repo, { ...defaults, ...over })`, so every field the merged schema has is present (including `Instance.phase` and `currentTask` once they exist), with these defaults:

```ts
boardRow():        { id: "board-a", kind: "trello", externalId: "5f00000000000000000000aa", name: "board-a", queueColumn: "To Do", webhookSecret: "app-secret-a", lastPolledAt: null }
registrationRow(): { id: "reg-a", boardId: "board-a", projectName: "project-a", swarmPath: "/path/to/project-a/.swarm", repoRoot: "/path/to/project-a", host: "local", description: "Project A's backend", minCards: 3, maxInstances: 1, tokensPerHour: null, askFirst: false, privacy: "normal", askJson: null, skipLabelsJson: '["design"]', ownersJson: '["owner"]', paused: false, draining: false }
instanceRow():     { id: "inst-a", registrationId: "reg-a", boardId: "board-a", cardId: "card-9", runId: null, state: "running", host: "local", launcherHandle: "4242", tokenHash: "hash-a", roomId: "room-a", startedAt: T0.toISOString(), lastHeartbeatAt: T0.toISOString(), endedAt: null, exitReason: null, dashboardUrl: null, tokens: 0 }
boardCard(n):      { ref: { boardId: "board-a", cardId: `card-${n}` }, version: new Date(Date.UTC(2026, 9, 25, 8, 0, n)).toISOString(), title: `Card ${n}`, body: `Do thing ${n}`, labels: [], column: "To Do", url: `https://trello.com/c/card-${n}` }
testConfig(limits): makeConfig({ public_url: "https://os.example", bind: { host: "127.0.0.1", port: 3200 }, owners: [{ id: "owner", name: "Owner" }], poll_interval_seconds: 120,
                      limits: { max_instances: 2, tokens_per_hour: 1_000_000, tokens_per_day: 10_000_000, dispatches_per_hour: 10, registrable_roots: ["/path/to"], launcher_hosts: ["local"], ...limits } })
```

```ts
// packages/os/tests/ingress/board-client.test.ts
import { describe, it, expect } from "vitest";
import { cardKey } from "../../src/store/ids.js";
import { clientFor, fetchJson, BoardApiError, timingSafeEqualString } from "../../src/ingress/board-client.js";
import { FetchStub, FakeBoardClient } from "../../src/testing/index.js";
import { boardRow, boardCard } from "../dispatch/fixtures.js";

describe("board client contract", () => {
  it("maps HTTP outcomes to BoardApiError codes and keeps the query string out of the message", async () => {
    const stub = new FetchStub()
      .on("GET", /\/ok\?/, { json: { a: 1 } })
      .on("GET", /\/401\?/, { status: 401, text: "no" })
      .on("GET", /\/404\?/, { status: 404 })
      .on("GET", /\/429\?/, { status: 429 })
      .on("GET", /\/500\?/, { status: 500 })
      .on("GET", /\/html\?/, { text: "<html>" })
      .on("GET", /\/hang\?/, { hang: true })
      .on("GET", /\/down\?/, { error: new Error("ECONNREFUSED") });
    const get = (path: string) => fetchJson(stub.fetch, `https://api.example/${path}?secret=s1`, { method: "GET" }, 20);
    await expect(get("ok")).resolves.toEqual({ a: 1 });
    const codes: Array<[string, string]> = [["401", "auth"], ["404", "not_found"], ["429", "rate_limited"], ["500", "http"], ["html", "bad_response"], ["hang", "timeout"], ["down", "network"]];
    for (const [path, code] of codes) {
      const err = await get(path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoardApiError);
      expect(err).toMatchObject({ code });
      expect((err as Error).message).not.toContain("secret=s1");
    }
  });

  it("records each stubbed call with lower-cased headers and rejects unrouted calls", async () => {
    const stub = new FetchStub().on("POST", "https://api.example/x", { json: {} });
    await stub.fetch("https://api.example/x", { method: "POST", headers: { Authorization: "Bearer t" }, body: "{}" });
    expect(stub.calls).toEqual([{ method: "POST", url: "https://api.example/x", headers: { authorization: "Bearer t" }, body: "{}" }]);
    await expect(stub.fetch("https://api.example/none", { method: "GET" })).rejects.toThrow("FetchStub: no route for GET https://api.example/none");
  });

  it("compares secrets in constant time and by length", () => {
    expect([timingSafeEqualString("abc", "abc"), timingSafeEqualString("abc", "abd"), timingSafeEqualString("abc", "abcd")]).toEqual([true, false, false]);
  });

  it("serves the fake board's queue and cards, fails on demand, and delivers emitted webhooks", async () => {
    const fake = new FakeBoardClient("trello");
    const card = boardCard(1);
    fake.setQueue("board-a", [card]);
    expect(await fake.listQueue(boardRow())).toEqual([card]);
    expect(await fake.getCard(card.ref)).toEqual(card);
    fake.failNext(new BoardApiError("rate_limited", "slow down"), "board-a");
    await expect(fake.listQueue(boardRow())).rejects.toMatchObject({ code: "rate_limited" });
    expect(await fake.listQueue(boardRow())).toEqual([card]);
    fake.deleteCard(card.ref);
    expect(await fake.getCard(card.ref)).toBeNull();
    const seen: string[] = [];
    fake.onEmit(async (ref) => { seen.push(cardKey(ref)); });
    await fake.emit(card.ref);
    expect(seen).toEqual(["board-a:card-1"]);
    expect([clientFor({ trello: fake }, boardRow()), clientFor({ trello: fake }, boardRow({ kind: "github" }))]).toEqual([fake, null]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/ingress/board-client.test.ts`
Expected: FAIL — the suite cannot load `../../src/ingress/board-client.js` (`Failed to load url … Does the file exist?`).

- [ ] **Step 3: Implement the contract and the doubles**

- `fetchJson` calls `fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs ?? BOARD_API_TIMEOUT_MS) })`. Status 401 or 403 → `auth`; 404 → `not_found`; 429 → `rate_limited`; any other non-2xx → `http` (with `status`); a rejection named `TimeoutError` or `AbortError` → `timeout`; any other rejection → `network`; a 2xx body that is not JSON → `bad_response`. The message is `<METHOD> <origin><pathname>: <status or cause>`, never the query string or a header.
- `timingSafeEqualString` is `false` when the UTF-8 byte lengths differ, else `crypto.timingSafeEqual`.
- `FetchStub` matches the method and either the exact URL string or the RegExp. `hang` waits for `init.signal` to abort and rejects with `signal.reason`; `error` rejects with it; otherwise it resolves `new Response(json !== undefined ? JSON.stringify(json) : (text ?? ""), { status: status ?? 200 })`. Headers are recorded through `new Headers(init.headers)`.
- Append `FetchStub`, `StubReply`, `StubCall` and `FakeBoardClient` to `src/testing/index.ts` under `// plan 04`.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/ingress/board-client.test.ts`
Expected: PASS (4 tests). Then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/ingress/board-client.ts packages/os/src/testing/fetch-stub.ts packages/os/src/testing/fake-board-client.ts packages/os/src/testing/index.ts packages/os/tests/dispatch/fixtures.ts packages/os/tests/ingress/board-client.test.ts
git commit -m "feat(os): board client contract, fetch helper and ingress test doubles"
```

---

### Task 2: Trello API client

**Files:**
- Create: `packages/os/src/ingress/trello-api.ts`
- Test: `packages/os/tests/ingress/trello-api.test.ts`

**Interfaces:**
- Consumes: Task 1's contract, `fetchJson`, `BoardApiError`, `timingSafeEqualString`; `Repo<BoardRow>`.
- Produces:

```ts
export interface TrelloApiOptions { key: string; token: string; boards: Pick<Repo<BoardRow>, "get">; fetch?: FetchLike; timeoutMs?: number; baseUrl?: string }   // baseUrl default "https://api.trello.com"
export class TrelloApiClient implements BoardClient { readonly kind: "trello"; constructor(opts: TrelloApiOptions) }
export const TRELLO_CARD_FIELDS = "id,shortLink,name,desc,idBoard,idList,labels,closed,dateLastActivity,url";
export function trelloCallbackUrl(publicUrl: string, boardId: string): string;   // `${publicUrl without trailing "/"}/hooks/trello/${boardId}`
export function trelloSignature(secret: string, rawBody: string, callbackUrl: string): string;   // base64 HMAC-SHA1 of rawBody + callbackUrl
```

Rules, with the brain's own key and token from `config.boards.trello`:
- Every request carries `Authorization: OAuth oauth_consumer_key="<key>", oauth_token="<token>"`; neither appears in a URL.
- `Board.externalId` for Trello is the board's 24-character id (what `idBoard` and webhooks carry); `register` (plan 08) resolves a short link to it. `Board.webhookSecret` holds the Trello app secret that Trello signs webhooks with, since `os.json` `boards.trello` has only `key` and `token`.
- `listQueue(board)`: `GET /1/boards/{externalId}/lists?fields=id,name&filter=open`, the list whose name equals `board.queueColumn` after trimming, ignoring case (none → `BoardApiError("queue_column_missing", "<board name> has no list named \"<queueColumn>\"")`), then `GET /1/lists/{listId}/cards?fields=<TRELLO_CARD_FIELDS>&checklists=all`, in the list's order.
- `getCard(ref)`: the board row from `boards.get(ref.boardId)` (missing → `null`), then `GET /1/cards/{cardId}?fields=<TRELLO_CARD_FIELDS>&list=true&checklists=all`; 404 → `null`; a card whose `idBoard` is not the board's `externalId` → `null`. Label objects come back in the card's `labels` field, so no `labels=all` parameter is sent.
- Mapping: `ref.cardId` is the card's `shortLink` (the id `TrelloExternalSource` uses, so `swarm run --card <id>` and the goal id `trello-<shortLink>` agree); `version` = `dateLastActivity`; `title` = `name`; `body` = `desc` plus, when a checklist is named `Acceptance`, `\n\n## Acceptance\n` and one `- [ ] item` or `- [x] item` line per check item (the format `TrelloExternalSource.cardToItem` writes); `labels` = label names with empty names dropped; `column` = the list's name, or `"(archived)"` when `closed`; `url` = `url`.
- `verifyWebhook(req)`: `false` when `board.webhookSecret` is null or `x-trello-webhook` is missing; else `timingSafeEqualString(header, trelloSignature(secret, req.rawBody, req.callbackUrl))`.
- `parseWebhook({ board, payload })`: `payload.action.data.card` with a `shortLink` or `id` → `[{ boardId: board.id, cardId: shortLink ?? id }]`; anything else, including a non-object payload → `[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/ingress/trello-api.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { TrelloApiClient, TRELLO_CARD_FIELDS, trelloCallbackUrl, trelloSignature } from "../../src/ingress/trello-api.js";
import { FetchStub } from "../../src/testing/index.js";
import { boardRow } from "../dispatch/fixtures.js";

const BOARD = boardRow();
const boards = { get: async (id: string) => (id === "board-a" ? BOARD : null) };
const API = "https://api.trello.com/1";
const trelloCard = (over: Record<string, unknown> = {}) => ({
  id: "5f00000000000000000000c1", shortLink: "abc123", name: "Add search", desc: "Find things", idBoard: BOARD.externalId, idList: "list-2",
  labels: [{ name: "backend" }, { name: "" }], closed: false, dateLastActivity: "2026-10-25T08:00:00.000Z", url: "https://trello.com/c/abc123/1-add-search",
  checklists: [{ name: "Acceptance", checkItems: [{ name: "Results show", state: "incomplete" }, { name: "Empty state", state: "complete" }] }], ...over,
});
const client = (stub: FetchStub) => new TrelloApiClient({ key: "key-a", token: "token-a", boards, fetch: stub.fetch, timeoutMs: 50 });

describe("TrelloApiClient", () => {
  it("lists the queue column as BoardCards, with the credentials only in the header", async () => {
    const stub = new FetchStub()
      .on("GET", `${API}/boards/${BOARD.externalId}/lists?fields=id,name&filter=open`, { json: [{ id: "list-1", name: "Doing" }, { id: "list-2", name: "To Do" }] })
      .on("GET", `${API}/lists/list-2/cards?fields=${TRELLO_CARD_FIELDS}&checklists=all`, { json: [trelloCard()] });
    expect(await client(stub).listQueue(BOARD)).toEqual([{
      ref: { boardId: "board-a", cardId: "abc123" }, version: "2026-10-25T08:00:00.000Z", title: "Add search",
      body: "Find things\n\n## Acceptance\n- [ ] Results show\n- [x] Empty state", labels: ["backend"], column: "To Do", url: "https://trello.com/c/abc123/1-add-search",
    }]);
    for (const call of stub.calls) {
      expect(call.url).not.toMatch(/key-a|token-a/);
      expect(call.headers.authorization).toBe('OAuth oauth_consumer_key="key-a", oauth_token="token-a"');
    }
  });

  it("refuses a board that lacks the queue column", async () => {
    const stub = new FetchStub().on("GET", /\/lists\?fields=id,name/, { json: [{ id: "list-1", name: "Doing" }] });
    await expect(client(stub).listQueue(BOARD)).rejects.toMatchObject({ code: "queue_column_missing", message: 'board-a has no list named "To Do"' });
  });

  it("fetches one card with its list, and returns null when it is gone, elsewhere, or the board is unknown", async () => {
    const stub = new FetchStub()
      .on("GET", `${API}/cards/abc123?fields=${TRELLO_CARD_FIELDS}&list=true&checklists=all`, { json: { ...trelloCard(), list: { id: "list-1", name: "Doing" } } })
      .on("GET", /\/cards\/gone1\?/, { status: 404 })
      .on("GET", /\/cards\/moved1\?/, { json: { ...trelloCard({ shortLink: "moved1", idBoard: "5f00000000000000000000ff" }), list: { id: "l9", name: "To Do" } } })
      .on("GET", /\/cards\/arch1\?/, { json: { ...trelloCard({ shortLink: "arch1", closed: true }), list: { id: "list-2", name: "To Do" } } });
    const c = client(stub);
    expect(await c.getCard({ boardId: "board-a", cardId: "abc123" })).toMatchObject({ ref: { boardId: "board-a", cardId: "abc123" }, column: "Doing" });
    expect(await c.getCard({ boardId: "board-a", cardId: "gone1" })).toBeNull();
    expect(await c.getCard({ boardId: "board-a", cardId: "moved1" })).toBeNull();
    expect((await c.getCard({ boardId: "board-a", cardId: "arch1" }))?.column).toBe("(archived)");
    expect(await c.getCard({ boardId: "board-x", cardId: "abc123" })).toBeNull();
  });

  it("keeps the key and token out of error text", async () => {
    const stub = new FetchStub().on("GET", /\/lists\?/, { status: 401, text: "invalid token" });
    const err = await client(stub).listQueue(BOARD).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "auth" });
    expect((err as Error).message).not.toMatch(/key-a|token-a/);
  });

  it("verifies Trello's signature over the raw body and the callback URL", () => {
    const callbackUrl = trelloCallbackUrl("https://os.example/", "board-a");
    expect(callbackUrl).toBe("https://os.example/hooks/trello/board-a");
    const rawBody = '{"action": {"type": "updateCard"}}';
    const sig = createHmac("sha1", "app-secret-a").update(rawBody + callbackUrl).digest("base64");
    expect(trelloSignature("app-secret-a", rawBody, callbackUrl)).toBe(sig);
    const c = client(new FetchStub());
    const req = (headers: Record<string, string>, body = rawBody, board = BOARD) => ({ board, headers, rawBody: body, callbackUrl });
    expect(c.verifyWebhook(req({ "x-trello-webhook": sig }))).toBe(true);
    expect(c.verifyWebhook(req({ "x-trello-webhook": sig }, rawBody.replace("updateCard", "updateCarD")))).toBe(false);
    expect(c.verifyWebhook(req({}))).toBe(false);
    expect(c.verifyWebhook(req({ "x-trello-webhook": sig }, rawBody, boardRow({ webhookSecret: null })))).toBe(false);
  });

  it("turns card actions into refs and ignores everything else", () => {
    const c = client(new FetchStub());
    expect(c.parseWebhook({ board: BOARD, payload: { action: { type: "updateCard", data: { card: { id: "5f00000000000000000000c1", shortLink: "abc123" } } } } })).toEqual([{ boardId: "board-a", cardId: "abc123" }]);
    expect(c.parseWebhook({ board: BOARD, payload: { action: { type: "createCard", data: { card: { id: "5f00000000000000000000c2" } } } } })).toEqual([{ boardId: "board-a", cardId: "5f00000000000000000000c2" }]);
    expect(c.parseWebhook({ board: BOARD, payload: { action: { type: "updateList", data: { list: { id: "l1" } } } } })).toEqual([]);
    expect(c.parseWebhook({ board: BOARD, payload: "garbage" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/ingress/trello-api.test.ts`
Expected: FAIL — cannot load `../../src/ingress/trello-api.js`.

- [ ] **Step 3: Implement `TrelloApiClient`** in `packages/os/src/ingress/trello-api.ts` to the rules above, with `fetchJson` for every request. The REST checklist shape is `checklists[].checkItems[] { name, state: "complete" | "incomplete" }`.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/ingress/trello-api.test.ts`
Expected: PASS (6 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/ingress/trello-api.ts packages/os/tests/ingress/trello-api.test.ts
git commit -m "feat(os): Trello REST board client with webhook verification"
```

---

### Task 3: GitHub API client

**Files:**
- Create: `packages/os/src/ingress/github-api.ts`
- Test: `packages/os/tests/ingress/github-api.test.ts`

**Interfaces:**
- Consumes: Task 1's contract and helpers.
- Produces:

```ts
export const GITHUB_QUEUE_LABEL = "swarm:goal";   // GOAL_LABEL in packages/task-backends/src/labels.ts, the label GitHubExternalSource reads
export interface GitHubApiOptions { token: string; boards: Pick<Repo<BoardRow>, "get">; fetch?: FetchLike; timeoutMs?: number; baseUrl?: string }   // baseUrl default "https://api.github.com"
export class GitHubApiClient implements BoardClient { readonly kind: "github"; constructor(opts: GitHubApiOptions) }
export function githubSignature(secret: string, rawBody: string): string;   // "sha256=" + hex HMAC-SHA256
```

Rules, mirroring `packages/task-backends/src/github-external-source.ts` (open issues carrying `swarm:goal` are the queue; the issue number is the id):
- Every request carries `Authorization: Bearer <config.boards.github.token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: swarm-os`.
- `Board.externalId` is `owner/repo`; `Board.queueColumn` is the queue label, `swarm:goal` for every GitHub board; `Board.webhookSecret` is the hook's shared secret.
- `listQueue(board)`: `GET /repos/{owner}/{repo}/issues?labels=<encodeURIComponent(queueColumn)>&state=open&per_page=100&sort=created&direction=asc` (oldest first, the first 100), dropping every item with a `pull_request` key.
- `getCard(ref)`: `GET /repos/{owner}/{repo}/issues/{number}`; 404, an unknown board row, or a pull request → `null`.
- Mapping: `cardId` = `String(number)`; `version` = `updated_at`; `title`; `body` = `body ?? ""`; `labels` = label names; `url` = `html_url`; `column` = `board.queueColumn` when the issue is open and carries that label, `"open"` when open without it, `"closed"` when closed.
- `verifyWebhook(req)`: `false` when `board.webhookSecret` is null or `x-hub-signature-256` is missing; else a timing-safe compare with `githubSignature(secret, req.rawBody)`.
- `parseWebhook({ board, payload })`: `payload.issue.number` on an issue without `pull_request` → `[{ boardId: board.id, cardId: String(number) }]`; everything else (pull-request comments, `ping`, `push`) → `[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/ingress/github-api.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { GitHubApiClient, GITHUB_QUEUE_LABEL, githubSignature } from "../../src/ingress/github-api.js";
import { FetchStub } from "../../src/testing/index.js";
import { boardRow } from "../dispatch/fixtures.js";

const BOARD = boardRow({ id: "board-g", kind: "github", externalId: "owner-a/repo-a", name: "repo-a", queueColumn: GITHUB_QUEUE_LABEL, webhookSecret: "hook-secret-a" });
const boards = { get: async (id: string) => (id === "board-g" ? BOARD : null) };
const issue = (n: number, over: Record<string, unknown> = {}) => ({ number: n, title: `Issue ${n}`, body: null, state: "open", labels: [{ name: "swarm:goal" }, { name: "priority:2" }], updated_at: `2026-10-25T08:00:0${n}Z`, html_url: `https://github.com/owner-a/repo-a/issues/${n}`, ...over });
const client = (stub: FetchStub) => new GitHubApiClient({ token: "ghp_test_a", boards, fetch: stub.fetch, timeoutMs: 50 });
const ISSUES = "https://api.github.com/repos/owner-a/repo-a/issues";

describe("GitHubApiClient", () => {
  it("lists open swarm:goal issues oldest first and drops pull requests", async () => {
    const stub = new FetchStub().on("GET", `${ISSUES}?labels=swarm%3Agoal&state=open&per_page=100&sort=created&direction=asc`, { json: [issue(7), issue(8, { pull_request: { url: "x" } })] });
    expect(await client(stub).listQueue(BOARD)).toEqual([{ ref: { boardId: "board-g", cardId: "7" }, version: "2026-10-25T08:00:07Z", title: "Issue 7", body: "", labels: ["swarm:goal", "priority:2"], column: "swarm:goal", url: "https://github.com/owner-a/repo-a/issues/7" }]);
    expect(stub.calls[0].headers).toMatchObject({ authorization: "Bearer ghp_test_a", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "swarm-os" });
  });

  it("maps one issue to a column and returns null for pull requests, 404s and unknown boards", async () => {
    const stub = new FetchStub()
      .on("GET", `${ISSUES}/1`, { json: issue(1) })
      .on("GET", `${ISSUES}/2`, { json: issue(2, { labels: [] }) })
      .on("GET", `${ISSUES}/3`, { json: issue(3, { state: "closed" }) })
      .on("GET", `${ISSUES}/4`, { json: issue(4, { pull_request: { url: "x" } }) })
      .on("GET", `${ISSUES}/5`, { status: 404 });
    const c = client(stub);
    const col = async (n: number) => (await c.getCard({ boardId: "board-g", cardId: String(n) }))?.column ?? null;
    expect([await col(1), await col(2), await col(3), await col(4), await col(5)]).toEqual(["swarm:goal", "open", "closed", null, null]);
    expect(await c.getCard({ boardId: "board-x", cardId: "1" })).toBeNull();
  });

  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const raw = '{"action": "opened", "issue": {"number": 7}}';
    const sig = "sha256=" + createHmac("sha256", "hook-secret-a").update(raw).digest("hex");
    expect(githubSignature("hook-secret-a", raw)).toBe(sig);
    const c = client(new FetchStub());
    const req = (headers: Record<string, string>, body = raw, board = BOARD) => ({ board, headers, rawBody: body, callbackUrl: "" });
    expect(c.verifyWebhook(req({ "x-hub-signature-256": sig }))).toBe(true);
    expect(c.verifyWebhook(req({ "x-hub-signature-256": sig }, raw + " "))).toBe(false);
    expect(c.verifyWebhook(req({}))).toBe(false);
    expect(c.verifyWebhook(req({ "x-hub-signature-256": sig }, raw, { ...BOARD, webhookSecret: null }))).toBe(false);
  });

  it("parses issue events into refs and ignores pull requests and other events", () => {
    const c = client(new FetchStub());
    expect(c.parseWebhook({ board: BOARD, payload: { action: "labeled", issue: { number: 7 } } })).toEqual([{ boardId: "board-g", cardId: "7" }]);
    expect(c.parseWebhook({ board: BOARD, payload: { action: "created", issue: { number: 8, pull_request: {} } } })).toEqual([]);
    expect(c.parseWebhook({ board: BOARD, payload: { zen: "Keep it simple.", hook_id: 1 } })).toEqual([]);
  });

  it("keeps the token out of error text", async () => {
    const stub = new FetchStub().on("GET", /\/issues\?/, { status: 403, text: "Bad credentials" });
    const err = await client(stub).listQueue(BOARD).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "auth" });
    expect((err as Error).message).not.toContain("ghp_test_a");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/ingress/github-api.test.ts`
Expected: FAIL — cannot load `../../src/ingress/github-api.js`.

- [ ] **Step 3: Implement `GitHubApiClient`** in `packages/os/src/ingress/github-api.ts` to the rules above, with `fetchJson` for every request.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/ingress/github-api.test.ts`
Expected: PASS (5 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/ingress/github-api.ts packages/os/tests/ingress/github-api.test.ts
git commit -m "feat(os): GitHub REST board client with webhook verification"
```

---

### Task 4: Launcher contract, dispatch ports and their doubles

**Files:**
- Create: `packages/os/src/launcher/launcher.ts`, `packages/os/src/launcher/fake.ts`
- Create: `packages/os/src/dispatch/dispatcher.ts` (contract types only; the class arrives in Task 6)
- Create: `packages/os/src/dispatch/host.ts`, `packages/os/src/dispatch/queue.ts`, `packages/os/src/dispatch/readiness.ts`, `packages/os/src/dispatch/room-opener.ts`
- Create: `packages/os/src/testing/fake-room-opener.ts`
- Modify: `packages/os/src/testing/index.ts` (add `FakeLauncher` and `FakeRoomOpener` to the `// plan 04` block)
- Test: `packages/os/tests/dispatch/ports.test.ts`

**Interfaces:**
- Consumes: Task 1's `BoardCard`; `CardRef`, `newId`, rows, `OsStore`, `Clock`, `roomMembers`, `registrationOwners` (plan 02); `ExitBody`, `InstanceCommandArgv` (plan 01); `EventPublisher`, `HubEvent`, `FakeEventHub`, `Actor`, `OsConfig` (plan 03).
- Produces:

```ts
// packages/os/src/launcher/launcher.ts: the overview's contract; `fresh` and UsageSource are plan 04 additions
export interface InstanceSpec { instanceId: string; registration: RegistrationRow; cardId: string; token: string; brainUrl: string; env?: Record<string, string>; fresh?: boolean }   // every launcher puts SWARM_OS_INSTANCE_ID=<instanceId> in the run's environment
export interface LauncherHandle { instanceId: string; host: string; handle: string }
export interface Launcher { kind: "local" | "remote" | "fake"; start(spec: InstanceSpec): Promise<LauncherHandle>; status(handle: LauncherHandle): Promise<"running" | "gone">; stop(handle: LauncherHandle, mode: "graceful" | "immediate"): Promise<void>; resources(): Promise<ResourceSnapshot> }
export interface ResourceSnapshot { host: string; at: string; cpuLoad1: number; cpus: number; memFreeMb: number; memTotalMb: number; instancesRunning: number; claudeSessions: number; portsInUse: number[]; tokensThisHour: Record<string, number> }
export interface UsageSource { usage(): Promise<Pick<ResourceSnapshot, "instancesRunning" | "portsInUse" | "tokensThisHour">> }
export class LaunchError extends Error {}
export function handleOf(row: InstanceRow): LauncherHandle;             // { instanceId: row.id, host: row.host, handle: row.launcherHandle ?? "" }

// packages/os/src/launcher/fake.ts
export class FakeLauncher implements Launcher {
  readonly kind: "fake";
  readonly started: InstanceSpec[];
  readonly stopped: Array<{ handle: LauncherHandle; mode: "graceful" | "immediate" }>;
  beforeStart: ((spec: InstanceSpec) => void | Promise<void>) | null;   // runs first; a throw rejects start() and records nothing
  snapshot: ResourceSnapshot;                                           // what resources() returns
  setStatus(instanceId: string, status: "running" | "gone"): void;     // default: "running" for a started id, "gone" for any other
}   // start() returns { instanceId, host: spec.registration.host, handle: `fake-${started.length}` }

// packages/os/src/dispatch/dispatcher.ts (types)
export type CheckName = "known_board" | "column_and_labels" | "not_in_flight" | "queue_depth" | "resources" | "ready";
export interface CheckResult { name: CheckName; passed: boolean; detail: string }   // assignable to plan 02's DecisionCheck
export interface CardEvent { ref: CardRef; version: string; card: BoardCard; source: "webhook" | "poll" | "human" }
export interface Readiness { assess(card: BoardCard, registration: RegistrationRow): Promise<{ outcome: "dispatch" | "hold" | "ask"; reason: string; question?: string }> }
export type ExitReport = ExitBody | { reason: "process_exit"; code: number; message?: string };   // plan 01's ExitBody, or the launcher's own report of a child's exit
export type DispatchGate = () => Promise<string | null>;                // a refusal reason, or null to allow
export interface InstanceTokens {                                        // the slice of plan 03's Tokens this plan uses
  mintInstanceToken(instanceId: string): Promise<string>;
  revokeInstanceToken(instanceId: string): Promise<void>;
  mintRoomToken(instanceId: string, participantId: string, roomId: string): string;
}
export interface DecisionInfo { quiet: boolean; repeat: boolean }        // quiet: a transient wait no one needs to hear about; repeat: same outcome and reason as the card's previous decision

// packages/os/src/dispatch/host.ts
export interface ApiCall { params: Record<string, string>; query: Record<string, string>; headers: Record<string, string | undefined>; body: unknown; rawBody: string; actor: Actor | null }   // header names lower-case
export interface ApiReply { status: number; body?: unknown; work?: Promise<void> }   // work: processing that continues after the reply (webhooks); never rejects
export interface RouteSpec { method: "GET" | "POST" | "HEAD"; path: string; auth: Array<Actor["kind"]> | "none"; rawBody?: boolean; handler(call: ApiCall): Promise<ApiReply> }
export interface PeriodicTask { name: string; everyMs: number; run(): Promise<void> }
export type ErrorCode = "bad_request" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "store_unavailable";
export function apiError(status: 400 | 401 | 403 | 404 | 409 | 503, code: ErrorCode, message: string): ApiReply;   // body { error: { code, message } }
export function staffOnly(actor: Actor): boolean;                        // human, host or cos
export function instanceOnly(instanceId: string): (actor: Actor) => boolean;
export function publishInstanceCommand(hub: EventPublisher, instanceId: string, argv: InstanceCommandArgv): HubEvent;   // type "command", payload { argv }, visibleTo instanceOnly(instanceId)

// packages/os/src/dispatch/queue.ts
export class KeyedQueue { run<T>(key: string, task: () => Promise<T>): Promise<T> }   // per key one task at a time, in call order; other keys alongside; a rejection reaches only its caller
export class QueueView {
  replace(boardId: string, cards: BoardCard[], at: Date): void;          // a full listing, in queue order
  upsert(card: BoardCard, inQueue: boolean): void;                        // one card's latest state; removed when not in the queue; a new card goes last
  cards(boardId: string): BoardCard[];
  syncedAt(boardId: string): Date | null;                                 // time of the last replace
}

// packages/os/src/dispatch/readiness.ts
export class StaticReadiness implements Readiness { assess(card: BoardCard, registration: RegistrationRow): ReturnType<Readiness["assess"]> }
export class ReadinessSlot implements Readiness { constructor(initial?: Readiness); fill(readiness: Readiness): void; assess(card: BoardCard, registration: RegistrationRow): ReturnType<Readiness["assess"]> }   // plan 06 fills it with the chief of staff

// packages/os/src/dispatch/room-opener.ts
export type ProvenanceLike = { source: "owner" | "human" | "cos" | "worker" | "reviewer" | "arbiter" | "instance" | "card" | "webhook" | "memory" | "tool" | "system"; sessionId?: string; deviceId?: string; address?: string; instanceId?: string; cardRef?: CardRef };   // = plan 05's Provenance
export interface PostInput { roomId: string; from: { id: string; kind: MessageRow["fromKind"] }; kind: MessageRow["kind"]; body: string; data?: unknown; replyTo?: string; provenance: ProvenanceLike }
export interface RoomOpener {   // the part of plan 05's Messaging plan 04 uses
  openRoom(kind: RoomRow["kind"], subjectId: string | null, name: string, members: string[], privacy: RoomRow["privacy"]): Promise<RoomRow>;
  post(input: PostInput): Promise<MessageRow>;
}
export const SYSTEM_SENDER: { id: "system"; kind: "system" };
export type Notice = "ask" | "unknown_board" | "refused" | "spawn_failed" | "attached" | "unresponsive" | "detached" | "recovered" | "gone" | "restart_gone" | "exited" | "paused" | "stopped" | "failed" | "login_expired" | "pause_requested" | "stop_requested" | "poll_failed" | "poll_recovered";
export class DispatchRooms {
  constructor(deps: { store: OsStore; opener: RoomOpener; config: OsConfig });
  board(board: BoardRow, registration: RegistrationRow | null): Promise<RoomRow>;   // kind "board", subjectId board.id, name board.name, members registrationOwners (config owners without one), privacy the registration's ("normal" without one)
  system(): Promise<RoomRow>;                                                        // kind "system", subjectId null, name "system", members the config owners
  say(room: RoomRow, body: string, opts: { notice: Notice; kind?: MessageRow["kind"]; cardRef?: CardRef; instanceId?: string; data?: Record<string, unknown> }): Promise<MessageRow>;
}

// packages/os/src/testing/fake-room-opener.ts
export class FakeRoomOpener implements RoomOpener { constructor(store: OsStore, clock: Clock); readonly opened: RoomRow[]; readonly posts: MessageRow[] }   // writes Room rows (newId("room"), createdAt now, closedAt null) and Message rows (seq from store.nextSeq) as plan 05's Messaging does, without redaction or events
```

`StaticReadiness` answers `{ outcome: "dispatch", reason: "static readiness" }`, or, for a registration with `askFirst`, `{ outcome: "ask", reason: "ask_first", question: 'Take "<title>" (<boardId>:<cardId>)? ask_first is on for <projectName>.' }`: until plan 06 fills the slot (and applies `askFirst` in its own `assess`), `ask_first` still turns a would-be dispatch into an ask, as the spec says. `DispatchRooms.board` and `system` find the room in the store first, open it only when absent, and memoise the promise per key so concurrent callers share one room; a rejected promise is dropped so the next call retries. (Plan 05 has its own `Rooms` class; this one stays private to `dispatch/` and is not exported from the package index.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/dispatch/ports.test.ts
import { describe, it, expect } from "vitest";
import { KeyedQueue, QueueView } from "../../src/dispatch/queue.js";
import { ReadinessSlot } from "../../src/dispatch/readiness.js";
import { DispatchRooms } from "../../src/dispatch/room-opener.js";
import { apiError, publishInstanceCommand, staffOnly } from "../../src/dispatch/host.js";
import { LaunchError, handleOf } from "../../src/launcher/launcher.js";
import { FakeLauncher, FakeRoomOpener, FakeEventHub, MemoryOsStore, FakeClock } from "../../src/testing/index.js";
import { T0, OWNER, boardCard, boardRow, registrationRow, instanceRow, testConfig, deferred } from "./fixtures.js";

describe("KeyedQueue", () => {
  it("runs one key's tasks in call order without overlap, and other keys alongside", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    const gate = deferred();
    const a1 = q.run("a", async () => { log.push("a1 start"); await gate.promise; log.push("a1 end"); });
    const a2 = q.run("a", async () => { log.push("a2"); });
    await q.run("b", async () => { log.push("b1"); });
    expect(log).toEqual(["a1 start", "b1"]);
    gate.resolve();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["a1 start", "b1", "a1 end", "a2"]);
  });

  it("keeps a key usable after a task rejects", async () => {
    const q = new KeyedQueue();
    await expect(q.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(q.run("a", async () => 2)).resolves.toBe(2);
  });
});

it("QueueView keeps each board's latest listing, card updates and sync time", () => {
  const view = new QueueView();
  view.replace("board-a", [boardCard(1), boardCard(2)], T0);
  view.upsert(boardCard(3), true);
  view.upsert(boardCard(1, { column: "Doing" }), false);
  expect(view.cards("board-a").map((c) => c.ref.cardId)).toEqual(["card-2", "card-3"]);
  expect([view.syncedAt("board-a"), view.cards("board-b"), view.syncedAt("board-b")]).toEqual([T0, [], null]);
});

it("ReadinessSlot answers dispatch, or an ask under askFirst, until plan 06 fills it", async () => {
  const slot = new ReadinessSlot();
  expect(await slot.assess(boardCard(1), registrationRow())).toEqual({ outcome: "dispatch", reason: "static readiness" });
  expect(await slot.assess(boardCard(1), registrationRow({ askFirst: true }))).toEqual({ outcome: "ask", reason: "ask_first", question: 'Take "Card 1" (board-a:card-1)? ask_first is on for project-a.' });
  slot.fill({ assess: async () => ({ outcome: "hold", reason: "needs design" }) });
  expect(await slot.assess(boardCard(1), registrationRow())).toEqual({ outcome: "hold", reason: "needs design" });
});

it("FakeLauncher records starts and stops and scripts status", async () => {
  const launcher = new FakeLauncher();
  const spec = { instanceId: "inst-1", registration: registrationRow(), cardId: "card-1", token: "inst_x", brainUrl: "http://127.0.0.1:3200" };
  const h = await launcher.start(spec);
  expect(h).toEqual({ instanceId: "inst-1", host: "local", handle: "fake-1" });
  expect(launcher.started).toEqual([spec]);
  expect(await launcher.status(h)).toBe("running");
  launcher.setStatus("inst-1", "gone");
  expect(await launcher.status(h)).toBe("gone");
  expect(await launcher.status({ instanceId: "inst-9", host: "local", handle: "" })).toBe("gone");
  launcher.beforeStart = () => { throw new LaunchError("spawn failed"); };
  await expect(launcher.start({ ...spec, instanceId: "inst-2" })).rejects.toThrow("spawn failed");
  expect(launcher.started).toHaveLength(1);
  await launcher.stop(h, "graceful");
  expect(launcher.stopped).toEqual([{ handle: h, mode: "graceful" }]);
  expect(handleOf(instanceRow({ launcherHandle: null }))).toEqual({ instanceId: "inst-a", host: "local", handle: "" });
});

it("DispatchRooms opens one board room per board and one system room, and says notices as the system", async () => {
  const store = new MemoryOsStore();
  const rooms = new DispatchRooms({ store, opener: new FakeRoomOpener(store, new FakeClock(T0)), config: testConfig() });
  const [r1, r2] = await Promise.all([rooms.board(boardRow(), registrationRow({ privacy: "local_only" })), rooms.board(boardRow(), registrationRow())]);
  expect(r1.id).toBe(r2.id);
  expect(await store.rooms.find({ kind: "board" })).toHaveLength(1);
  expect(r1).toMatchObject({ kind: "board", subjectId: "board-a", name: "board-a", privacy: "local_only", membersJson: '["owner"]' });
  expect(await rooms.system()).toMatchObject({ kind: "system", subjectId: null, membersJson: '["owner"]' });
  const msg = await rooms.say(r1, "hello", { notice: "gone", cardRef: { boardId: "board-a", cardId: "card-1" } });
  expect(msg).toMatchObject({ roomId: r1.id, fromId: "system", fromKind: "system", kind: "system", body: "hello" });
  expect(JSON.parse(msg.provenanceJson)).toEqual({ source: "system", cardRef: { boardId: "board-a", cardId: "card-1" } });
  expect(JSON.parse(msg.dataJson ?? "null")).toEqual({ notice: "gone" });
});

it("publishes instance commands to that instance only, and errors in the overview's shape", () => {
  const hub = new FakeEventHub();
  publishInstanceCommand(hub, "inst-1", ["stop", "graceful"]);
  const [event] = hub.published;
  expect(event).toMatchObject({ type: "command", payload: { argv: ["stop", "graceful"] } });
  expect([event.visibleTo({ kind: "instance", instanceId: "inst-1" }), event.visibleTo({ kind: "instance", instanceId: "inst-2" }), event.visibleTo(OWNER)]).toEqual([true, false, false]);
  expect([staffOnly(OWNER), staffOnly({ kind: "host" }), staffOnly({ kind: "cos" }), staffOnly({ kind: "instance", instanceId: "inst-1" })]).toEqual([true, true, true, false]);
  expect(apiError(409, "conflict", "inst-1 has ended")).toEqual({ status: 409, body: { error: { code: "conflict", message: "inst-1 has ended" } } });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/dispatch/ports.test.ts`
Expected: FAIL — cannot load `../../src/dispatch/queue.js`.

- [ ] **Step 3: Implement the files** to the signatures and comments above. `KeyedQueue` chains each key's tasks on the previous task's settled promise and drops the key when its chain empties. `dispatcher.ts` holds only the exported types in this task.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/ports.test.ts`
Expected: PASS (8 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/launcher/launcher.ts packages/os/src/launcher/fake.ts packages/os/src/dispatch/dispatcher.ts packages/os/src/dispatch/host.ts packages/os/src/dispatch/queue.ts packages/os/src/dispatch/readiness.ts packages/os/src/dispatch/room-opener.ts packages/os/src/testing/fake-room-opener.ts packages/os/src/testing/index.ts packages/os/tests/dispatch/ports.test.ts
git commit -m "feat(os): launcher contract, dispatch ports and their test doubles"
```

---

### Task 5: The six checks, sticky holds, `min_cards` overrides and usage accounting

**Files:**
- Create: `packages/os/src/dispatch/decisions.ts`, `packages/os/src/dispatch/checks.ts`, `packages/os/src/resources/usage.ts`
- Test: `packages/os/tests/dispatch/checks.test.ts`

**Interfaces:**
- Consumes: Task 4's `CheckResult`, `CardEvent`, `Readiness`, `DispatchGate`, `QueueView`; Task 1's `BoardCard`; `CardRef`, `cardKey`, `newId`, `toJson`, `decisionChecks`, `registrationSkipLabels` (plan 02); `BRAIN_RESTART_FOUND_GONE` (plan 03, `brain/reconcile.ts`).
- Produces:

```ts
// packages/os/src/dispatch/decisions.ts
export const OVERRIDE_CARD_ID = "override:min_cards";
export const OVERRIDE_ACTIVE = "override min_cards";                      // the reason of an active override
export interface Sticky { kind: "hold" | "ask"; by: string; reason: string; questionMessageId: string | null }
export function findDecision(store: OsStore, ref: CardRef, version: string): Promise<DispatchDecisionRow | null>;
export function latestDecision(store: OsStore, ref: CardRef): Promise<DispatchDecisionRow | null>;   // greatest cardVersion
export function upsertDecision(store: OsStore, fields: Omit<DispatchDecisionRow, "id">): Promise<DispatchDecisionRow>;   // patches the (boardId, cardId, cardVersion) row, or puts one with newId("dec")
export function openSticky(store: OsStore, ref: CardRef): Promise<Sticky | null>;
export function activeOverride(store: OsStore, boardId: string): Promise<DispatchDecisionRow | null>;
export function recordOverride(store: OsStore, clock: Clock, registration: RegistrationRow, by: string): Promise<DispatchDecisionRow>;
export function endOverride(store: OsStore, boardId: string, ending: string): Promise<DispatchDecisionRow | null>;   // ending: "queue_empty" or "revoked by <by>"

// packages/os/src/resources/usage.ts
export const ACTIVE_STATES: ReadonlyArray<InstanceRow["state"]>;          // ["dispatching", "running", "unresponsive"]
export interface Usage { live: InstanceRow[]; dispatchesLastHour: number; tokensLastHour: Record<string, number>; tokensLastHourTotal: number; tokensLastDay: number; portsInUse: number[] }
export function computeUsage(store: OsStore, now: Date): Promise<Usage>;

// packages/os/src/dispatch/checks.ts
export type Verdict = Awaited<ReturnType<Readiness["assess"]>>;
export class ReadinessMemo { get(card: BoardCard): Verdict | null; set(card: BoardCard, verdict: Verdict): void }   // in memory, keyed by cardKey and contentHash
export interface ChainContext { store: OsStore; config: OsConfig; clock: Clock; view: QueueView; readiness: Readiness; gates: DispatchGate[]; memo: ReadinessMemo }
export interface ChainResult { checks: CheckResult[]; outcome: DispatchDecisionRow["outcome"]; reason: string | null; quiet: boolean; board: BoardRow | null; registration: RegistrationRow | null; question: string | null; sticky: Sticky | null }
export function runChain(ctx: ChainContext, event: CardEvent): Promise<ChainResult>;
export function checkNotInFlight(ctx: Pick<ChainContext, "store">, board: BoardRow, registration: RegistrationRow, ref: CardRef, opts: { humanAsked: boolean }): Promise<CheckResult & { quiet: boolean }>;
export function checkResources(ctx: Pick<ChainContext, "store" | "config" | "clock" | "gates">, registration: RegistrationRow): Promise<CheckResult>;
export function contentHash(card: BoardCard): string;                     // sha256 hex of JSON.stringify([title, body, labels sorted])
export function isBlockingEnd(row: InstanceRow): boolean;                 // failed; paused; exited with exitReason "stopped", "nothing_to_do" or BRAIN_RESTART_FOUND_GONE
export function blockingDetail(row: InstanceRow, board: BoardRow): string;   // `last run <id> ended <state> (<exitReason>); /retry run <id> or /dispatch <board name> <cardId>`
```

`checksJson` is always `toJson(CheckResult[])`, the array plan 02's `decisionChecks` reads; nothing else goes in it.

**An override is a decision.** `recordOverride` puts `{ boardId, cardId: OVERRIDE_CARD_ID, cardVersion: <now ISO>, outcome: "dispatch", checksJson: toJson([{ name: "queue_depth", passed: true, detail: "min_cards override by <by>" }]), reason: OVERRIDE_ACTIVE, instanceId: null, questionMessageId: null, decidedAt: <now>, decidedBy: "override:<by>" }`. `queue_depth` finds the active one with `activeOverride`: `decisions.find({ boardId, cardId: OVERRIDE_CARD_ID })`, newest `decidedAt` first, the first whose `reason` is exactly `override min_cards`. `endOverride` rewrites that reason to `override min_cards; ended: <ending>`.

**A sticky hold or ask is read from the card's decisions.** `openSticky` sorts the card's decisions by `decidedAt`, then `cardVersion`, newest first, and skips every decision by `"policy"` whose outcome is not `ask`. The first one left decides: a `hold` (by a human id, `cos` or `host`) is a sticky hold; an `ask` is a sticky ask carrying its `questionMessageId`; anything else, such as a person's or the chief of staff's dispatch, means nothing is sticky. A hold by hand therefore survives new versions and column moves until a person dispatches the card, and a question is asked once until it is answered with `/dispatch` or `/hold`.

**The chain** runs in order and stops at the first failing check; `checks` holds every check that ran. A quiet hold is recorded and handed to `onDecision` with `quiet: true`, so plan 06 can leave it unnarrated.

| first failing check | detail (the decision's `reason`) | outcome | quiet |
|---|---|---|---|
| `known_board`: no Board row | `board <id> is not known` | `unknown_board` | n/a |
| `known_board`: no registration | `<board name> has no registration` | `unknown_board` | n/a |
| `known_board`: registration paused | `<board name> is paused` | `hold` | yes |
| `column_and_labels`: the column (trimmed, case-insensitive) is not `queueColumn` | `in "<column>", not "<queueColumn>"` | `hold` | yes |
| `column_and_labels`: a label in `registrationSkipLabels` (case-insensitive) | `label "<label>" is not for swarm` | `hold` | no |
| `not_in_flight`: a live instance on this card | `<instance> is already on this card` | `hold` | yes |
| `not_in_flight`: the card's newest instance `isBlockingEnd` (skipped when `event.source === "human"`) | `blockingDetail(row, board)` | `hold` | no |
| `not_in_flight`: live instances of the registration ≥ `maxInstances` | `<project> has <n> of <max> instances running` | `hold` | yes |
| `queue_depth` | `depth <n> < min_cards <m>; /override min_cards <board> starts now` | `hold` | no |
| `resources` | see below | `refused` | no |
| `ready`: `openSticky` returns a sticky | the sticky's `reason` | the sticky's `kind` | yes (it was announced when it was made) |
| `ready`: verdict `hold` | the verdict's reason | `hold` | no |
| `ready`: verdict `ask` | `asked: <question>`, where the question is `verdict.question ?? verdict.reason` | `ask` | no |
| none | (`reason: null`) | `dispatch` | n/a |

Passing details: `known_board` `<board> → <project>`; `column_and_labels` `in "<queueColumn>", no skip label`; `not_in_flight` `no instance on this card; <n> of <max> running`; `queue_depth` `draining`, `override by <decidedBy>` or `depth <n> >= min_cards <m>`; `resources` `<live> of <max_instances> instances, <n> of <dispatches_per_hour> dispatches this hour`; `ready` `ready: <verdict reason>`.

`queue_depth` passes when `registration.draining`, when `activeOverride` is non-null, or when depth ≥ `minCards`. Depth is the number of distinct card ids among `view.cards(boardId)` and the event's card, plus the registration's live instances whose card is not among them, because cards in flight count.

`resources` refuses, in this order, when: a gate returns a reason (that reason, so lockdown reads `lockdown is on`); `store.ping()` is false (`the OS stack is unreachable; dispatching resumes when it returns`); `path.resolve(swarmPath)` is neither equal to nor inside a `path.resolve`d entry of `limits.registrable_roots` (`swarm path <path> is outside limits.registrable_roots`; an empty list admits nothing); live instances ≥ `max_instances` (`machine at <n> of <max> instances (limits.max_instances)`); `dispatchesLastHour` ≥ `dispatches_per_hour` (`<n> dispatches in the last hour (limits.dispatches_per_hour <max>)`); `tokensLastHourTotal` ≥ `tokens_per_hour` (`<n> tokens in the last hour (limits.tokens_per_hour <max>)`); the project's `tokensLastHour` ≥ the registration's `tokensPerHour` when it is set (`<project> used <n> tokens in the last hour (registration tokensPerHour <max>)`); `tokensLastDay` ≥ `tokens_per_day` (`<n> tokens in the last day (limits.tokens_per_day <max>)`). The registration's `maxInstances` belongs to `not_in_flight`, where the spec's step 3 puts it; the machine's `max_instances` is checked here.

`ready` consults `readiness.assess` at most once per card content: `ReadinessMemo` keeps the verdict per `cardKey` and `contentHash`, so a new version that changed nothing a reader sees (a comment, a move back to the queue) and every re-evaluation reuse it. The memo is a cache, so after a brain restart a held card's readiness may be consulted once more.

`computeUsage` reads the newest 1000 instances by `startedAt`, plus every live one. An instance counts toward a window (the last hour or the last 24 h) when it is live, started inside it, or ended inside it, and it then counts with all its tokens. This is conservative: a long run's earlier tokens push the brain toward refusing rather than overspending. `tokensLastHour` is keyed by the registration's `projectName` (by `registrationId` when the registration is gone). `dispatchesLastHour` counts instances started in the last hour. `portsInUse` are the numeric ports of live instances' `dashboardUrl`, sorted, without duplicates.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/dispatch/checks.test.ts
import { describe, it, expect, vi } from "vitest";
import { runChain, ReadinessMemo, type ChainContext } from "../../src/dispatch/checks.js";
import { upsertDecision, openSticky, recordOverride, endOverride, activeOverride, OVERRIDE_CARD_ID } from "../../src/dispatch/decisions.js";
import { computeUsage } from "../../src/resources/usage.js";
import { QueueView } from "../../src/dispatch/queue.js";
import { StaticReadiness } from "../../src/dispatch/readiness.js";
import { decisionChecks, type DispatchDecisionRow, type InstanceRow, type RegistrationRow } from "../../src/store/rows.js";
import type { CardEvent, Readiness } from "../../src/dispatch/dispatcher.js";
import type { OsConfig } from "../../src/config/schema.js";
import { MemoryOsStore, FakeClock } from "../../src/testing/index.js";
import { T0, boardRow, registrationRow, instanceRow, boardCard, testConfig } from "./fixtures.js";

async function setup(o: { registration?: Partial<RegistrationRow>; limits?: Partial<OsConfig["limits"]>; queue?: number[]; readiness?: Readiness } = {}) {
  const store = new MemoryOsStore();
  const clock = new FakeClock(T0);
  await store.boards.put(boardRow());
  await store.registrations.put(registrationRow(o.registration));
  const view = new QueueView();
  view.replace("board-a", (o.queue ?? []).map((n) => boardCard(n)), clock.now());
  const ctx: ChainContext = { store, config: testConfig(o.limits), clock, view, readiness: o.readiness ?? new StaticReadiness(), gates: [], memo: new ReadinessMemo() };
  return { store, clock, ctx };
}
const ev = (card = boardCard(1), source: CardEvent["source"] = "poll"): CardEvent => ({ ref: card.ref, version: card.version, card, source });
const ago = (minutes: number) => new Date(T0.getTime() - minutes * 60_000).toISOString();
const detailOf = (r: { checks: Array<{ name: string; detail: string }> }, name: string) => r.checks.find((c) => c.name === name)?.detail;
const decision = (over: Partial<DispatchDecisionRow>): Omit<DispatchDecisionRow, "id"> => ({ boardId: "board-a", cardId: "card-1", cardVersion: boardCard(1).version, outcome: "hold", checksJson: "[]", reason: null, instanceId: null, questionMessageId: null, decidedAt: T0.toISOString(), decidedBy: "policy", ...over });

describe("known_board and column_and_labels", () => {
  it("calls cards from unknown or unregistered boards unknown_board, and a paused board a quiet hold", async () => {
    const { ctx, store } = await setup({ queue: [1, 2, 3] });
    expect(await runChain(ctx, ev(boardCard(1, { ref: { boardId: "board-z", cardId: "card-1" } })))).toMatchObject({ outcome: "unknown_board", checks: [{ name: "known_board", passed: false, detail: "board board-z is not known" }] });
    await store.boards.put(boardRow({ id: "board-b", name: "board-b" }));
    expect((await runChain(ctx, ev(boardCard(1, { ref: { boardId: "board-b", cardId: "card-1" } })))).reason).toBe("board-b has no registration");
    await store.registrations.patch("reg-a", { paused: true });
    expect(await runChain(ctx, ev())).toMatchObject({ outcome: "hold", quiet: true, reason: "board-a is paused" });
  });

  it("takes only queue-column cards without a skip label", async () => {
    const { ctx } = await setup({ queue: [1, 2, 3] });
    expect(await runChain(ctx, ev(boardCard(1, { column: "Doing" })))).toMatchObject({ outcome: "hold", quiet: true, reason: 'in "Doing", not "To Do"' });
    expect(await runChain(ctx, ev(boardCard(1, { labels: ["Design"] })))).toMatchObject({ outcome: "hold", quiet: false, reason: 'label "Design" is not for swarm' });
    expect((await runChain(ctx, ev(boardCard(1, { column: " to do " })))).outcome).toBe("dispatch");
  });
});

it("not_in_flight holds a card in flight, a full project, and a card whose last run crashed unless a human asks", async () => {
  const { ctx, store } = await setup({ queue: [1, 2, 3] });
  await store.instances.put(instanceRow({ id: "inst-1", cardId: "card-1", state: "running" }));
  expect(await runChain(ctx, ev(boardCard(1)))).toMatchObject({ outcome: "hold", quiet: true, reason: "inst-1 is already on this card" });
  expect(await runChain(ctx, ev(boardCard(2)))).toMatchObject({ outcome: "hold", quiet: true, reason: "project-a has 1 of 1 instances running" });
  await store.instances.patch("inst-1", { state: "failed", exitReason: "gone", endedAt: T0.toISOString() });
  expect(await runChain(ctx, ev(boardCard(1)))).toMatchObject({ outcome: "hold", quiet: false, reason: "last run inst-1 ended failed (gone); /retry run inst-1 or /dispatch board-a card-1" });
  expect((await runChain(ctx, ev(boardCard(1), "human"))).outcome).toBe("dispatch");
  await store.instances.patch("inst-1", { state: "exited", exitReason: "brain_restart_found_gone" });
  expect((await runChain(ctx, ev(boardCard(1)))).reason).toBe("last run inst-1 ended exited (brain_restart_found_gone); /retry run inst-1 or /dispatch board-a card-1");
});

describe("queue_depth: min_cards starts draining, it does not gate every card", () => {
  it("holds below min_cards and counts cards in flight and the arriving card", async () => {
    const below = await setup({ queue: [1, 2] });
    expect(await runChain(below.ctx, ev(boardCard(2)))).toMatchObject({ outcome: "hold", quiet: false, reason: "depth 2 < min_cards 3; /override min_cards board-a starts now" });
    expect(detailOf(await runChain(below.ctx, ev(boardCard(3))), "queue_depth")).toBe("depth 3 >= min_cards 3");
    const inFlight = await setup({ queue: [1, 2], registration: { maxInstances: 2 } });
    await inFlight.store.instances.put(instanceRow({ cardId: "card-9", state: "running" }));
    expect(detailOf(await runChain(inFlight.ctx, ev(boardCard(2))), "queue_depth")).toBe("depth 3 >= min_cards 3");
  });

  it("passes while draining and while an override is active", async () => {
    const { ctx, store, clock } = await setup({ queue: [1], registration: { draining: true } });
    expect(detailOf(await runChain(ctx, ev()), "queue_depth")).toBe("draining");
    await store.registrations.patch("reg-a", { draining: false });
    await recordOverride(store, clock, registrationRow(), "owner");
    expect(detailOf(await runChain(ctx, ev()), "queue_depth")).toBe("override by override:owner");
    await endOverride(store, "board-a", "revoked by owner");
    expect((await runChain(ctx, ev())).outcome).toBe("hold");
  });

  it("stores the override as a dispatch decision with a queue_depth entry, and ends it", async () => {
    const { store, clock } = await setup();
    const o = await recordOverride(store, clock, registrationRow(), "owner");
    expect(o).toMatchObject({ boardId: "board-a", cardId: OVERRIDE_CARD_ID, cardVersion: T0.toISOString(), outcome: "dispatch", decidedBy: "override:owner", reason: "override min_cards" });
    expect(decisionChecks(o)).toEqual([{ name: "queue_depth", passed: true, detail: "min_cards override by owner" }]);
    expect((await activeOverride(store, "board-a"))?.id).toBe(o.id);
    expect((await endOverride(store, "board-a", "queue_empty"))?.reason).toBe("override min_cards; ended: queue_empty");
    expect(await activeOverride(store, "board-a")).toBeNull();
  });
});

describe("resources: the limits on disk", () => {
  it("refuses on a closed gate, an unreachable store and a path outside registrable_roots", async () => {
    const { ctx, store } = await setup({ queue: [1, 2, 3] });
    vi.spyOn(store, "ping").mockResolvedValueOnce(false);
    expect(await runChain(ctx, ev())).toMatchObject({ outcome: "refused", reason: "the OS stack is unreachable; dispatching resumes when it returns" });
    ctx.gates.push(async () => "lockdown is on");
    expect((await runChain(ctx, ev())).reason).toBe("lockdown is on");
    for (const swarmPath of ["/elsewhere/project-a/.swarm", "/path/tooling/.swarm"]) {
      const outside = await setup({ queue: [1, 2, 3], registration: { swarmPath } });
      expect((await runChain(outside.ctx, ev())).reason).toBe(`swarm path ${swarmPath} is outside limits.registrable_roots`);
    }
  });

  it("refuses at each machine and spend limit, and forgets dispatches older than an hour", async () => {
    const cases: Array<[Partial<OsConfig["limits"]>, Partial<RegistrationRow>, Partial<InstanceRow>, string]> = [
      [{ max_instances: 1 }, { maxInstances: 2 }, { registrationId: "reg-b", boardId: "board-b", state: "running" }, "machine at 1 of 1 instances (limits.max_instances)"],
      [{ dispatches_per_hour: 1 }, {}, { state: "exited", startedAt: ago(59), endedAt: ago(50) }, "1 dispatches in the last hour (limits.dispatches_per_hour 1)"],
      [{ tokens_per_hour: 1000 }, {}, { state: "exited", startedAt: ago(120), endedAt: ago(30), tokens: 1000 }, "1000 tokens in the last hour (limits.tokens_per_hour 1000)"],
      [{}, { tokensPerHour: 500 }, { state: "exited", startedAt: ago(20), endedAt: ago(10), tokens: 600 }, "project-a used 600 tokens in the last hour (registration tokensPerHour 500)"],
      [{ tokens_per_day: 5000 }, {}, { state: "exited", startedAt: ago(600), endedAt: ago(300), tokens: 5000 }, "5000 tokens in the last day (limits.tokens_per_day 5000)"],
    ];
    for (const [limits, registration, instance, reason] of cases) {
      const { ctx, store } = await setup({ queue: [1, 2, 3], limits, registration });
      await store.instances.put(instanceRow({ cardId: "card-7", ...instance }));
      expect(await runChain(ctx, ev())).toMatchObject({ outcome: "refused", reason });
    }
    const old = await setup({ queue: [1, 2, 3], limits: { dispatches_per_hour: 1 } });
    await old.store.instances.put(instanceRow({ state: "exited", startedAt: ago(61), endedAt: ago(55) }));
    expect((await runChain(old.ctx, ev())).outcome).toBe("dispatch");
  });
});

describe("ready", () => {
  it("dispatches with all six checks passed, asks under askFirst, and holds on a hold verdict", async () => {
    const ok = await runChain((await setup({ queue: [1, 2, 3] })).ctx, ev());
    expect(ok.checks.map((c) => [c.name, c.passed])).toEqual([["known_board", true], ["column_and_labels", true], ["not_in_flight", true], ["queue_depth", true], ["resources", true], ["ready", true]]);
    const question = 'Take "Card 1" (board-a:card-1)? ask_first is on for project-a.';
    expect(await runChain((await setup({ queue: [1, 2, 3], registration: { askFirst: true } })).ctx, ev())).toMatchObject({ outcome: "ask", reason: `asked: ${question}`, question });
    const holding = await setup({ queue: [1, 2, 3], readiness: { assess: async () => ({ outcome: "hold", reason: "too vague" }) } });
    expect(await runChain(holding.ctx, ev())).toMatchObject({ outcome: "hold", quiet: false, reason: "too vague" });
  });

  it("REVIEW FOCUS 5: consults readiness once per card content, not per version or per re-evaluation", async () => {
    const assess = vi.fn(async () => ({ outcome: "hold" as const, reason: "too vague" }));
    const { ctx } = await setup({ queue: [1, 2, 3], readiness: { assess } });
    expect((await runChain(ctx, ev(boardCard(1)))).reason).toBe("too vague");
    expect((await runChain(ctx, ev(boardCard(1, { version: "2026-10-25T08:30:00.000Z" })))).reason).toBe("too vague");   // a comment moved the version, not the content
    expect((await runChain(ctx, ev(boardCard(1)))).reason).toBe("too vague");                                            // a re-evaluation
    expect(assess).toHaveBeenCalledTimes(1);
    await runChain(ctx, ev(boardCard(1, { body: "Now with acceptance criteria" })));
    expect(assess).toHaveBeenCalledTimes(2);
  });

  it("applies an open sticky hold quietly, without consulting readiness", async () => {
    const assess = vi.fn(async () => ({ outcome: "dispatch" as const, reason: "fine" }));
    const { ctx, store } = await setup({ queue: [1, 2, 3], readiness: { assess } });
    await upsertDecision(store, decision({ decidedBy: "owner", reason: "held by owner: waiting on design" }));
    expect(await runChain(ctx, ev(boardCard(1, { version: "2026-10-25T08:40:00.000Z" })))).toMatchObject({ outcome: "hold", quiet: true, reason: "held by owner: waiting on design", sticky: { kind: "hold", by: "owner" } });
    expect(assess).not.toHaveBeenCalled();
  });

  it("reads a sticky from the card's decisions, released by a later dispatch from a person", async () => {
    const { store, clock } = await setup();
    await upsertDecision(store, decision({ decidedBy: "owner", reason: "held by owner: waiting on design" }));
    await upsertDecision(store, decision({ cardVersion: "2026-10-25T08:10:00.000Z", reason: 'in "Doing", not "To Do"' }));   // a policy hold in between
    expect(await openSticky(store, boardCard(1).ref)).toEqual({ kind: "hold", by: "owner", reason: "held by owner: waiting on design", questionMessageId: null });
    clock.advance(1000);
    await upsertDecision(store, decision({ cardVersion: "2026-10-25T08:20:00.000Z", outcome: "dispatch", decidedBy: "owner", decidedAt: clock.now().toISOString() }));
    expect(await openSticky(store, boardCard(1).ref)).toBeNull();
    await upsertDecision(store, decision({ cardId: "card-2", outcome: "ask", reason: "asked: which API?", questionMessageId: "msg-q1" }));
    expect(await openSticky(store, boardCard(2).ref)).toEqual({ kind: "ask", by: "policy", reason: "asked: which API?", questionMessageId: "msg-q1" });
  });
});

it("computeUsage counts usage conservatively from instance rows", async () => {
  const { store } = await setup();
  await store.registrations.put(registrationRow({ id: "reg-b", boardId: "board-b", projectName: "project-b" }));
  await store.instances.put(instanceRow({ id: "a", state: "running", startedAt: ago(180), tokens: 700, dashboardUrl: "http://127.0.0.1:3141" }));
  await store.instances.put(instanceRow({ id: "b", registrationId: "reg-b", state: "exited", startedAt: ago(90), endedAt: ago(30), tokens: 300 }));
  await store.instances.put(instanceRow({ id: "c", state: "exited", startedAt: ago(300), endedAt: ago(120), tokens: 999 }));
  const u = await computeUsage(store, T0);
  expect(u.live.map((i) => i.id)).toEqual(["a"]);
  expect([u.tokensLastHour, u.tokensLastHourTotal, u.tokensLastDay, u.dispatchesLastHour, u.portsInUse]).toEqual([{ "project-a": 700, "project-b": 300 }, 1000, 1999, 0, [3141]]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/dispatch/checks.test.ts`
Expected: FAIL — cannot load `../../src/dispatch/checks.js`.

- [ ] **Step 3: Implement `decisions.ts`, `usage.ts` and `checks.ts`** to the signatures, definitions, chain table and rules above.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/checks.test.ts`
Expected: PASS (13 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/dispatch/decisions.ts packages/os/src/dispatch/checks.ts packages/os/src/resources/usage.ts packages/os/tests/dispatch/checks.test.ts
git commit -m "feat(os): dispatch policy checks, sticky holds, min_cards overrides and usage accounting"
```

---

### Task 6: `Dispatcher.dispatch`: the instance row before the process

**Files:**
- Modify: `packages/os/src/dispatch/dispatcher.ts` (add the class)
- Create: `packages/os/tests/dispatch/harness.ts`
- Test: `packages/os/tests/dispatch/dispatch.test.ts`

**Interfaces:**
- Consumes: Task 5's `checkNotInFlight`, `checkResources`, `upsertDecision`, `ReadinessMemo`; Task 4's `KeyedQueue`, `QueueView`, `DispatchRooms`, `RoomOpener`, `Launcher`, `LaunchError`, `DispatchGate`, `InstanceTokens`, `DecisionInfo`; `newId`, `toJson`.
- Produces:

```ts
export interface DispatchOptions { fresh?: boolean; context?: string; resumeOf?: string }
export class DispatchRefusedError extends Error { readonly check: CheckResult; readonly outcome: "hold" | "refused"; constructor(check: CheckResult, outcome: "hold" | "refused") }
export type DispatcherChange = { type: "instance"; instance: InstanceRow } | { type: "decision"; decision: DispatchDecisionRow };
export class Dispatcher {
  constructor(deps: { store: OsStore; launcher: Launcher; config: OsConfig; messaging: RoomOpener; readiness: Readiness; clock: Clock; log: Logger; tokens: InstanceTokens });
  dispatch(registration: RegistrationRow, card: BoardCard, decidedBy: string, opts?: DispatchOptions): Promise<InstanceRow>;
  addGate(gate: DispatchGate): void;
  onChange(listener: (change: DispatcherChange) => void): () => void;     // every instance and decision write; mountDispatch publishes them
  onDecision(listener: (decision: DispatchDecisionRow, event: CardEvent, info: DecisionInfo) => void): () => void;   // after each stored outcome with a card in hand; plan 06 narrates from it
}
export function localBrainUrl(config: OsConfig): string;   // http://<bind.host>:<bind.port>; 0.0.0.0 → 127.0.0.1, :: → [::1], other IPv6 literals bracketed

// packages/os/tests/dispatch/harness.ts
export class FakeTokens implements InstanceTokens {
  constructor(store: OsStore);
  readonly minted: string[];                                              // instance tokens handed out, in order
}   // mintInstanceToken: `inst_test_<n>`, writing tokenHash = sha256 hex of it; revokeInstanceToken: tokenHash "revoked"; mintRoomToken: `room_<participantId>`
export interface Harness {
  store: MemoryOsStore; clock: FakeClock; launcher: FakeLauncher; opener: FakeRoomOpener; tokens: FakeTokens; config: OsConfig; readiness: ReadinessSlot; dispatcher: Dispatcher;
  changes: DispatcherChange[]; decisions: Array<{ decision: DispatchDecisionRow; event: CardEvent; info: DecisionInfo }>;
  restart(): Dispatcher;                                                  // a second Dispatcher on the same store, launcher, opener, tokens, readiness and clock
  posts(kind: RoomRow["kind"], subjectId?: string | null): Promise<MessageRow[]>;   // messages of the rooms of that kind (and subject), in seq order
}
export function harness(opts?: { registration?: Partial<RegistrationRow>; limits?: Partial<OsConfig["limits"]> }): Promise<Harness>;   // board-a and reg-a stored
export function addBoardB(h: Harness, over?: Partial<RegistrationRow>): Promise<RegistrationRow>;   // board-b (externalId "5f00000000000000000000bb") and reg-b (project-b, /path/to/project-b/.swarm)
export function ev(card: BoardCard, source?: CardEvent["source"]): CardEvent;   // source defaults to "webhook"
export function notices(messages: MessageRow[]): string[];                     // each message's data.notice
```

The constructor is the overview's plus `tokens`, plan 03's `Tokens` (Task 14 passes it), because an instance token can only be minted by the class that verifies it. `messaging` is typed as the `RoomOpener` slice, which plan 05's `Messaging` satisfies. `decidedBy` vocabulary, used by every later task: `"policy"` for the chain, a human's `humanId` (for example `"owner"`), `"cos"`, `"host"`, and `"override:<humanId or cos>"` for overrides.

`DecisionInfo` is `{ quiet, repeat }`: `quiet` from the chain, and `repeat` true when the outcome and reason equal the card's previous decision's, so a narrator can skip what it already said.

`dispatch()` runs under the board's key (`registration.boardId`) and calls a private `dispatchLocked(registration, card, decidedBy, opts, chain?)`, which `decideCard` (Task 7) calls while it already holds that key; `chain` carries the chain's checks and its `CardEvent`. Its order is what Review Focus 1 rests on:

1. Under the global key `"limits"`, so two boards cannot both take the last slot: re-read the registration by id (missing → `DispatchRefusedError` with a failed `known_board` check, outcome `hold`); run `checkNotInFlight(…, { humanAsked: true })` and `checkResources(…)`, throwing `DispatchRefusedError` at the first failure (`hold` for `not_in_flight`, `refused` for `resources`); put the instance `Participant` (`kind: "instance"`, `name: "<projectName>/<cardId>"`, `instanceId`, `permissionsJson: "[]"`, `createdAt: now`); `openRoom("instance", instanceId, "<projectName>: <title>"` cut to 80 characters, `[participantId]`, `registration.privacy)`; put the `Instance` row with `state: "dispatching"`, `launcherHandle: null`, `tokenHash: ""`, the `roomId`, `host: registration.host`, `startedAt: now`, `tokens: 0` and every other nullable field null; then `token = await tokens.mintInstanceToken(instanceId)`, which writes the real hash onto the row.
2. Store the `dispatch` decision for `(boardId, cardId, card.version)`: the `instanceId`, `decidedBy`, `reason` `resumes <resumeOf>` or null, `checksJson` the chain's checks or the two re-checks. Emit the change, then `onDecision(decision, event, { quiet: false, repeat: false })`, where `event` is the chain's event or `{ ref: card.ref, version: card.version, card, source: "human" }`.
3. Set `draining: true` on the registration when it was false: draining turns on at the first dispatch.
4. `launcher.start({ instanceId, registration, cardId, token, brainUrl, env, fresh })`, with `brainUrl` = `localBrainUrl(config)` for the `local` and `fake` launchers and `config.public_url` for `remote`, and `env` = `{ SWARM_OS_CONTEXT: opts.context }` when a context is given (an answered ask's added context; plan 01 reads it), else nothing. If `start` throws: patch the instance `failed` with `exitReason: "spawn_failed: <message>"` and `endedAt`; `tokens.revokeInstanceToken(instanceId)`; set the room's `closedAt`; patch the decision to `hold`, `decidedBy: "policy"`, reason `spawn failed: <message>; /retry run <instance>` and one failed `not_in_flight` check of that detail; post `spawn_failed`; emit both changes; return the failed row. A spawn failure is a run's death, so it is a notice, not an `onDecision`.
5. Patch `launcherHandle: handle.handle`, emit the instance change, and return the row, still `dispatching` until the run attaches.

- [ ] **Step 1: Write the harness and the failing test**

```ts
// packages/os/tests/dispatch/dispatch.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DispatchRefusedError } from "../../src/dispatch/dispatcher.js";
import { LaunchError } from "../../src/launcher/launcher.js";
import type { InstanceRow } from "../../src/store/rows.js";
import { harness, addBoardB, notices } from "./harness.js";
import { T0, boardCard, registrationRow } from "./fixtures.js";

describe("Dispatcher.dispatch", () => {
  it("writes the instance row in dispatching, with its token hash, before launcher.start", async () => {
    const h = await harness();
    const seen: { row: InstanceRow | null } = { row: null };
    h.launcher.beforeStart = async (spec) => { seen.row = await h.store.instances.get(spec.instanceId); };
    const row = await h.dispatcher.dispatch(registrationRow(), boardCard(1), "owner");
    expect(seen.row).toMatchObject({ id: row.id, state: "dispatching", launcherHandle: null, cardId: "card-1", boardId: "board-a", registrationId: "reg-a" });
    expect(seen.row?.tokenHash).toBe(createHash("sha256").update(h.tokens.minted[0]).digest("hex"));
    expect(row).toMatchObject({ state: "dispatching", launcherHandle: "fake-1" });
  });

  it("hands the run its token, context and --fresh, and keeps the token out of every row and change", async () => {
    const h = await harness();
    const row = await h.dispatcher.dispatch(registrationRow(), boardCard(1), "owner", { fresh: true, context: "Use the staging API" });
    const spec = h.launcher.started[0];
    expect(spec).toMatchObject({ instanceId: row.id, cardId: "card-1", token: h.tokens.minted[0], brainUrl: "http://127.0.0.1:3200", fresh: true, env: { SWARM_OS_CONTEXT: "Use the staging API" } });
    const stored = JSON.stringify([await h.store.messages.find({}), await h.store.decisions.find({}), await h.store.instances.find({}), h.changes]);
    expect(stored).not.toContain(spec.token);
  });

  it("opens the instance room, records the decision, starts draining, and leaves the narration to plan 06", async () => {
    const h = await harness({ registration: { privacy: "local_only" } });
    const row = await h.dispatcher.dispatch(registrationRow(), boardCard(1), "owner");
    const [participant] = await h.store.participants.find({ instanceId: row.id });
    expect(participant).toMatchObject({ kind: "instance", name: "project-a/card-1", permissionsJson: "[]" });
    expect(await h.store.rooms.get(row.roomId)).toMatchObject({ kind: "instance", subjectId: row.id, name: "project-a: Card 1", privacy: "local_only", membersJson: JSON.stringify([participant.id]) });
    expect(await h.store.decisions.find({ cardId: "card-1" })).toMatchObject([{ outcome: "dispatch", instanceId: row.id, decidedBy: "owner", cardVersion: boardCard(1).version }]);
    expect((await h.store.registrations.get("reg-a"))?.draining).toBe(true);
    expect(h.decisions.map((d) => [d.decision.outcome, d.event.source, d.info])).toEqual([["dispatch", "human", { quiet: false, repeat: false }]]);
    expect(h.changes.map((c) => c.type)).toEqual(expect.arrayContaining(["instance", "decision"]));
    expect(await h.posts("board", "board-a")).toEqual([]);
  });

  it("marks a spawn failure failed, revokes its token, closes its room, holds the card and says so", async () => {
    const h = await harness();
    h.launcher.beforeStart = () => { throw new LaunchError("ENOENT swarm"); };
    const row = await h.dispatcher.dispatch(registrationRow(), boardCard(1), "policy");
    expect(row).toMatchObject({ state: "failed", exitReason: "spawn_failed: ENOENT swarm", tokenHash: "revoked" });
    expect((await h.store.rooms.get(row.roomId))?.closedAt).toBe(T0.toISOString());
    expect(await h.store.decisions.find({ cardId: "card-1" })).toMatchObject([{ outcome: "hold", instanceId: row.id, decidedBy: "policy", reason: `spawn failed: ENOENT swarm; /retry run ${row.id}` }]);
    const board = await h.posts("board", "board-a");
    expect(board.map((m) => m.body)).toEqual([`Could not start ${row.id} for board-a:card-1: spawn failed: ENOENT swarm. The card is held: /retry run ${row.id} to try again.`]);
    expect(notices(board)).toEqual(["spawn_failed"]);
  });

  it("re-checks the limits inside dispatch, so only one of two boards takes the last slot", async () => {
    const h = await harness({ limits: { max_instances: 1 } });
    const regB = await addBoardB(h);
    const results = await Promise.allSettled([
      h.dispatcher.dispatch(registrationRow(), boardCard(1), "owner"),
      h.dispatcher.dispatch(regB, boardCard(3, { ref: { boardId: "board-b", cardId: "card-3" } }), "owner"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!.reason;
    expect(refused).toBeInstanceOf(DispatchRefusedError);
    expect(refused).toMatchObject({ outcome: "refused", check: { name: "resources", passed: false, detail: "machine at 1 of 1 instances (limits.max_instances)" } });
    expect(h.launcher.started).toHaveLength(1);
    expect(await h.store.instances.find({})).toHaveLength(1);
  });

  it("refuses a second instance on a card already in flight", async () => {
    const h = await harness();
    const row = await h.dispatcher.dispatch(registrationRow(), boardCard(1), "owner");
    const again = await h.dispatcher.dispatch(registrationRow(), boardCard(1), "owner").catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DispatchRefusedError);
    expect(again).toMatchObject({ outcome: "hold", check: { name: "not_in_flight", passed: false, detail: `${row.id} is already on this card` } });
    expect([h.launcher.started.length, (await h.store.instances.find({})).length]).toEqual([1, 1]);
  });
});
```

`harness.ts` builds `MemoryOsStore`, `FakeClock(T0)`, `FakeLauncher`, `FakeRoomOpener`, `FakeTokens`, `testConfig(opts.limits)`, a `ReadinessSlot` and the `Dispatcher` with `silentLog`; stores `boardRow()` and `registrationRow(opts.registration)`; and collects every `onChange` into `changes` and every `onDecision` into `decisions`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/dispatch/dispatch.test.ts`
Expected: FAIL — `Dispatcher` is not exported from `../../src/dispatch/dispatcher.js` (`Dispatcher is not a constructor`).

- [ ] **Step 3: Implement the class's constructor, `dispatch`, `addGate`, `onChange`, `onDecision` and `localBrainUrl`** in `packages/os/src/dispatch/dispatcher.ts`, in the order above. The class owns one `KeyedQueue`, one `QueueView`, one `ReadinessMemo`, one `DispatchRooms` built from `deps.messaging`, the gates and the listeners; a throwing listener is logged with `warn` and ignored.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/dispatch.test.ts`
Expected: PASS (6 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/dispatch/dispatcher.ts packages/os/tests/dispatch/harness.ts packages/os/tests/dispatch/dispatch.test.ts
git commit -m "feat(os): Dispatcher.dispatch writes the instance row before starting the run"
```

---

### Task 7: `Dispatcher.decideCard`: one decision per card version

**Files:**
- Modify: `packages/os/src/dispatch/dispatcher.ts`
- Test: `packages/os/tests/dispatch/decide-card.test.ts`

**Interfaces:**
- Consumes: Task 5's `runChain`, `findDecision`, `latestDecision`, `upsertDecision`; Task 6's `dispatchLocked`, `DispatchRooms`, the listeners.
- Produces: `Dispatcher.decideCard(event: CardEvent): Promise<DispatchDecisionRow>`, idempotent per `(boardId, cardId, version)` and serialised per board. A `source: "human"` event skips the last-run-crashed rule; a person who wants a card taken now uses `dispatch()` (the `/dispatch` command), not `decideCard`. An `ask` decision's question is a `question` message in the board room with no `Question` row (those belong to instance sessions); plan 06 answers it with `/dispatch` or `/hold`.

`decideCard(event)` runs under the board's key:

1. `findDecision(event.ref, event.version)`: when present, return it unchanged, with no listener called. This is what makes a webhook, a poll and a restart mid-poll converge.
2. When the board is known, `view.upsert(event.card, <column matches queueColumn>)`.
3. `previous = latestDecision(event.ref)`; `chain = runChain(ctx, event)`.
4. `dispatch` → `dispatchLocked(registration, card, "policy", {}, { checks: chain.checks, event })`. A `DispatchRefusedError` (the last slot went to another board between the check and the lock) is recorded as that outcome and check instead.
5. `ask` → reuse `chain.sticky.questionMessageId` when the ask is carried; otherwise post the question in the board room as notice `ask` with message kind `question`, and use its id.
6. Every outcome but `dispatch` → `upsertDecision` with `decidedBy: "policy"`, the chain's reason and checks, and the `questionMessageId` for an ask; emit the change; `onDecision(decision, event, { quiet: chain.quiet, repeat })`.
7. Notices: `unknown_board` in the system room, with its `draft`, unless another `unknown_board` decision on that board was made in the last 24 h; `refused` in the system room unless `repeat`. Return the row.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/dispatch/decide-card.test.ts
import { describe, it, expect } from "vitest";
import { decisionChecks } from "../../src/store/rows.js";
import { harness, addBoardB, ev } from "./harness.js";
import { boardCard, boardRow, deferred } from "./fixtures.js";

describe("Dispatcher.decideCard", () => {
  it("REVIEW FOCUS 2: a webhook and a poll for the same new card make one decision and one instance", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    const card = boardCard(1);
    const [a, b] = await Promise.all([h.dispatcher.decideCard(ev(card, "webhook")), h.dispatcher.decideCard(ev(card, "poll"))]);
    expect([a.id, a.outcome]).toEqual([b.id, "dispatch"]);
    expect(await h.store.decisions.find({ boardId: "board-a", cardId: "card-1" })).toHaveLength(1);
    expect([h.launcher.started.length, h.decisions.length]).toEqual([1, 1]);
  });

  it("REVIEW FOCUS 2: a newer version arriving alongside still makes one instance", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    const v2 = boardCard(1, { version: "2026-10-25T08:01:00.000Z", body: "edited" });
    const [d1, d2] = await Promise.all([h.dispatcher.decideCard(ev(boardCard(1), "poll")), h.dispatcher.decideCard(ev(v2, "webhook"))]);
    expect([d1.outcome, d2.outcome]).toEqual(["dispatch", "hold"]);
    expect(decisionChecks(d2).at(-1)).toMatchObject({ name: "not_in_flight", passed: false });
    expect(h.launcher.started).toHaveLength(1);
  });

  it("holds below min_cards, records the checks that ran, and tells plan 06 instead of the room", async () => {
    const h = await harness();
    const d = await h.dispatcher.decideCard(ev(boardCard(1)));
    expect(d).toMatchObject({ outcome: "hold", decidedBy: "policy", reason: "depth 1 < min_cards 3; /override min_cards board-a starts now" });
    expect(decisionChecks(d).map((c) => c.name)).toEqual(["known_board", "column_and_labels", "not_in_flight", "queue_depth"]);
    await h.dispatcher.decideCard(ev(boardCard(1, { version: "2026-10-25T08:02:00.000Z" })));
    expect(h.decisions.map((x) => [x.event.source, x.info])).toEqual([["webhook", { quiet: false, repeat: false }], ["webhook", { quiet: false, repeat: true }]]);
    expect(await h.posts("board", "board-a")).toEqual([]);
  });

  it("records a card outside the queue column as a quiet hold", async () => {
    const h = await harness();
    expect(await h.dispatcher.decideCard(ev(boardCard(1, { column: "Doing" })))).toMatchObject({ outcome: "hold", reason: 'in "Doing", not "To Do"' });
    expect(h.decisions[0].info.quiet).toBe(true);
  });

  it("tells the OS owners about an unregistered board at most once a day", async () => {
    const h = await harness();
    await h.store.boards.put(boardRow({ id: "board-u", name: "board-u", externalId: "5f00000000000000000000cc" }));
    const onU = (n: number) => boardCard(n, { ref: { boardId: "board-u", cardId: `card-${n}` } });
    expect((await h.dispatcher.decideCard(ev(onU(1)))).outcome).toBe("unknown_board");
    await h.dispatcher.decideCard(ev(onU(2)));
    expect(await h.posts("system")).toHaveLength(1);
    h.clock.advance(25 * 3_600_000);
    await h.dispatcher.decideCard(ev(onU(3)));
    const sys = await h.posts("system");
    expect(sys).toHaveLength(2);
    expect(sys[0].body).toBe('board-u has no registration: "Card 1" (https://trello.com/c/card-1) arrived on it. An owner\'s /register creates one; nothing is created silently.');
    expect(JSON.parse(sys[0].dataJson!)).toEqual({ notice: "unknown_board", draft: { boardId: "board-u", boardName: "board-u", kind: "trello", externalId: "5f00000000000000000000cc", queueColumn: "To Do" } });
    expect(await h.store.registrations.find({ boardId: "board-u" })).toEqual([]);
  });

  it("refuses at a limit on disk and tells the system room once", async () => {
    const h = await harness({ registration: { minCards: 1 }, limits: { dispatches_per_hour: 0 } });
    expect(await h.dispatcher.decideCard(ev(boardCard(1)))).toMatchObject({ outcome: "refused", reason: "0 dispatches in the last hour (limits.dispatches_per_hour 0)" });
    await h.dispatcher.decideCard(ev(boardCard(1, { version: "2026-10-25T08:04:00.000Z" })));
    expect((await h.posts("system")).map((m) => m.body)).toEqual(['Not dispatching "Card 1" (board-a:card-1): 0 dispatches in the last hour (limits.dispatches_per_hour 0).']);
  });

  it("posts an ask once and carries it to later versions", async () => {
    const h = await harness({ registration: { minCards: 1, askFirst: true } });
    const d1 = await h.dispatcher.decideCard(ev(boardCard(1)));
    const questions = (await h.posts("board", "board-a")).filter((m) => m.kind === "question");
    expect(questions.map((m) => m.body)).toEqual(['Take "Card 1" (board-a:card-1)? ask_first is on for project-a.']);
    expect(d1).toMatchObject({ outcome: "ask", questionMessageId: questions[0].id });
    const d2 = await h.dispatcher.decideCard(ev(boardCard(1, { version: "2026-10-25T08:03:00.000Z" })));
    expect(d2).toMatchObject({ outcome: "ask", questionMessageId: questions[0].id });
    expect((await h.posts("board", "board-a")).filter((m) => m.kind === "question")).toHaveLength(1);
    expect(h.launcher.started).toHaveLength(0);
  });

  it("serialises decisions per board but not across boards", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    await addBoardB(h, { minCards: 1 });
    const gate = deferred();
    const calls: string[] = [];
    h.readiness.fill({ assess: async (card) => { calls.push(card.ref.cardId); if (card.ref.cardId === "card-1") await gate.promise; return { outcome: "hold", reason: "wait" }; } });
    const p1 = h.dispatcher.decideCard(ev(boardCard(1)));
    const p2 = h.dispatcher.decideCard(ev(boardCard(2)));
    await h.dispatcher.decideCard(ev(boardCard(3, { ref: { boardId: "board-b", cardId: "card-3" } })));
    expect(calls).toEqual(["card-1", "card-3"]);
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(calls).toEqual(["card-1", "card-3", "card-2"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/dispatch/decide-card.test.ts`
Expected: FAIL — `h.dispatcher.decideCard is not a function`.

- [ ] **Step 3: Implement `decideCard`** in `packages/os/src/dispatch/dispatcher.ts` in the order above.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/decide-card.test.ts`
Expected: PASS (8 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/dispatch/dispatcher.ts packages/os/tests/dispatch/decide-card.test.ts
git commit -m "feat(os): decideCard runs the policy chain once per card version"
```

---

### Task 8: Holds, draining, the queue view and runs that ended unseen

**Files:**
- Create: `packages/os/src/dispatch/holds.ts`
- Modify: `packages/os/src/dispatch/dispatcher.ts`
- Test: `packages/os/tests/dispatch/holds.test.ts`

**Interfaces:**
- Consumes: Task 7's chain plumbing and listeners; Task 5's `activeOverride`, `recordOverride`, `endOverride`, `findDecision`, `openSticky`, `isBlockingEnd`, `blockingDetail`, `ACTIVE_STATES`; Task 4's `QueueView`, `DispatchRooms`; `BRAIN_RESTART_FOUND_GONE` (plan 03).
- Produces:

```ts
export const REEVALUATE_FRESH_MS = 30_000;
// Dispatcher
noteQueue(boardId: string, cards: BoardCard[]): Promise<void>;             // a full listing, from the poller
reevaluateHolds(boardId: string): Promise<void>;                            // also plan 03's BrainDispatcher.reevaluateHolds, called by its reconcile
holdCard(registration: RegistrationRow, card: BoardCard, by: string, reason: string): Promise<DispatchDecisionRow>;
overrideMinCards(registration: RegistrationRow, by: string, revoke?: boolean): Promise<DispatchDecisionRow | null>;   // null: a revoke with nothing active
// packages/os/src/dispatch/holds.ts
export function heldInView(store: OsStore, view: QueueView, boardId: string): Promise<Array<{ card: BoardCard; decision: DispatchDecisionRow }>>;   // queued cards whose current version's decision is a policy hold or refusal and that have no open sticky, in queue order
export function settleEndedRuns(deps: { store: OsStore; rooms: DispatchRooms; clock: Clock }, board: BoardRow): Promise<DispatchDecisionRow[]>;   // holds the cards of runs that ended without finishing; returns the decisions it patched
```

All four methods run under the board's key.
- `noteQueue`: `view.replace(boardId, cards, now)`. When no listed card lacks a live instance (the queue is empty, or everything in it is in flight), set `draining: false` if it was true and `endOverride(boardId, "queue_empty")`.
- `reevaluateHolds`:
  1. Whatever the view, `settleEndedRuns`: every ended instance on the board (`isEnded`, except `exited` with `exitReason: "completed"`) whose decision (`decisions.find({ instanceId })`) still says `dispatch` has that decision patched to `hold`, `decidedBy: "policy"`, one failed `not_in_flight` check, and the reason `blockingDetail(row, board)` for a blocking end or `<instance> ended login_expired; the card waits for /resume board <board>` for an expired login. A blocking end stays held until a person retries or dispatches the card; an expired login's hold is a plain policy hold, so once the board resumes, the next re-evaluation dispatches the card again, even when its version never changed. The change is emitted, and a run plan 03's reconcile marked `exited` with `BRAIN_RESTART_FOUND_GONE` also gets the `restart_gone` notice in the board room. That is plan 03's obligation: after a restart, a card whose run vanished is held and the board hears why.
  2. Return without acting (one `info` line) when `view.syncedAt(boardId)` is null or older than `REEVALUATE_FRESH_MS`, so nothing is dispatched from a stale picture of the board. The poller calls this right after a listing, and everything else asks for a fresh listing through `Poller.pollNow` (Task 13).
  3. For each `heldInView` entry, in queue order, re-run the chain: `dispatch` goes through `dispatchLocked(…, "policy", {}, { checks, event: { ref, version, card, source: "poll" } })`; a different outcome is stored and passed to `onDecision` (`repeat: false`); the same outcome is patched silently (the reason and checks, emitting only the change). Holds by hand, asks, and decisions by anyone but `"policy"` are never re-run.
- `holdCard`: upsert the card version's decision as `hold`, `decidedBy: by`, reason `held by <by>: <reason>`, one failed `ready` check of that detail; emit; `onDecision(decision, { ref, version, card, source: "human" }, { quiet: false, repeat: false })`. `openSticky` then keeps it held until a person dispatches the card.
- `overrideMinCards`: with `revoke`, `endOverride(boardId, "revoked by <by>")`, or null when nothing was active; otherwise the active override, or a new one from `recordOverride(store, clock, registration, by)`. Emit the change.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/dispatch/holds.test.ts
import { describe, it, expect, vi } from "vitest";
import { activeOverride, openSticky, OVERRIDE_CARD_ID } from "../../src/dispatch/decisions.js";
import type { BoardCard } from "../../src/ingress/board-client.js";
import { harness, ev, type Harness } from "./harness.js";
import { boardCard, registrationRow } from "./fixtures.js";

const finish = async (h: Harness, cardId: string) => {
  const [row] = await h.store.instances.find({ cardId });
  await h.store.instances.patch(row.id, { state: "exited", exitReason: "completed", endedAt: h.clock.now().toISOString() });
};

describe("holds and draining", () => {
  it("drains card by card below min_cards once started, and stops when nothing waits", async () => {
    const h = await harness();
    const [c1, c2, c3] = [boardCard(1), boardCard(2), boardCard(3)];
    const started = () => h.launcher.started.map((s) => s.cardId);
    await h.dispatcher.noteQueue("board-a", [c1, c2, c3]);
    const outcomes: string[] = [];
    for (const c of [c1, c2, c3]) outcomes.push((await h.dispatcher.decideCard(ev(c, "poll"))).outcome);
    expect(outcomes).toEqual(["dispatch", "hold", "hold"]);
    expect((await h.store.registrations.get("reg-a"))?.draining).toBe(true);
    await finish(h, "card-1");
    await h.dispatcher.noteQueue("board-a", [c2, c3]);
    await h.dispatcher.reevaluateHolds("board-a");
    expect(started()).toEqual(["card-1", "card-2"]);              // depth 2 < 3, but the board is draining
    await finish(h, "card-2");
    await h.dispatcher.noteQueue("board-a", [c3]);
    await h.dispatcher.reevaluateHolds("board-a");
    expect(started()).toEqual(["card-1", "card-2", "card-3"]);
    await h.dispatcher.noteQueue("board-a", [c3]);                 // card-3 is in flight, so nothing waits
    expect((await h.store.registrations.get("reg-a"))?.draining).toBe(false);
    await finish(h, "card-3");
    await h.dispatcher.noteQueue("board-a", [boardCard(4)]);
    expect((await h.dispatcher.decideCard(ev(boardCard(4), "poll"))).reason).toBe("depth 1 < min_cards 3; /override min_cards board-a starts now");
  });

  it("never dispatches from a queue view older than 30 s, nor a card the next listing lacks", async () => {
    const h = await harness();
    await h.dispatcher.noteQueue("board-a", [boardCard(1), boardCard(2)]);
    await h.dispatcher.decideCard(ev(boardCard(1), "poll"));
    await h.dispatcher.decideCard(ev(boardCard(2), "poll"));       // both held: depth 2 < 3
    h.clock.advance(60_000);
    await h.dispatcher.overrideMinCards(registrationRow(), "owner");
    await h.dispatcher.reevaluateHolds("board-a");                  // the view is 60 s old
    expect(h.launcher.started).toHaveLength(0);
    await h.dispatcher.noteQueue("board-a", [boardCard(2)]);        // card-1 left the queue unseen
    await h.dispatcher.reevaluateHolds("board-a");
    expect(h.launcher.started.map((s) => s.cardId)).toEqual(["card-2"]);
  });

  it("records a min_cards override that starts draining and ends when the queue empties or is revoked", async () => {
    const h = await harness();
    await h.dispatcher.noteQueue("board-a", [boardCard(1)]);
    await h.dispatcher.decideCard(ev(boardCard(1), "poll"));
    const o = await h.dispatcher.overrideMinCards(registrationRow(), "owner");
    expect(o).toMatchObject({ cardId: OVERRIDE_CARD_ID, outcome: "dispatch", decidedBy: "override:owner" });
    await h.dispatcher.reevaluateHolds("board-a");
    expect(h.launcher.started.map((s) => s.cardId)).toEqual(["card-1"]);
    await h.dispatcher.noteQueue("board-a", []);
    expect(await activeOverride(h.store, "board-a")).toBeNull();
    expect((await h.store.decisions.get(o!.id))?.reason).toBe("override min_cards; ended: queue_empty");
    const o2 = await h.dispatcher.overrideMinCards(registrationRow(), "owner");
    expect(await h.dispatcher.overrideMinCards(registrationRow(), "owner", true)).toMatchObject({ id: o2!.id, reason: "override min_cards; ended: revoked by owner" });
    expect(await h.dispatcher.overrideMinCards(registrationRow(), "owner", true)).toBeNull();
  });

  it("keeps a hold by hand through new versions and column moves until a person dispatches", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    const v = (n: number, over: Partial<BoardCard> = {}) => boardCard(1, { version: `2026-10-25T08:1${n}:00.000Z`, ...over });
    await h.dispatcher.holdCard(registrationRow(), v(1), "owner", "waiting on design");
    expect((await h.dispatcher.decideCard(ev(v(2)))).reason).toBe("held by owner: waiting on design");
    expect((await h.dispatcher.decideCard(ev(v(3, { column: "Doing" })))).reason).toBe('in "Doing", not "To Do"');
    expect((await h.dispatcher.decideCard(ev(v(4)))).reason).toBe("held by owner: waiting on design");
    expect(h.launcher.started).toHaveLength(0);
    h.clock.advance(1_000);
    await h.dispatcher.dispatch(registrationRow(), v(4), "owner");
    expect(await openSticky(h.store, v(4).ref)).toBeNull();
    expect(h.decisions[0]).toMatchObject({ decision: { outcome: "hold", decidedBy: "owner" }, event: { source: "human" } });
  });

  it("re-evaluation leaves holds by hand and readiness verdicts alone, and says nothing unless it dispatches", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    const assess = vi.fn(async () => ({ outcome: "hold" as const, reason: "too vague" }));
    h.readiness.fill({ assess });
    await h.dispatcher.noteQueue("board-a", [boardCard(1), boardCard(2)]);
    await h.dispatcher.decideCard(ev(boardCard(1), "poll"));
    await h.dispatcher.holdCard(registrationRow(), boardCard(2), "owner", "not yet");
    const heard = h.decisions.length;
    await h.dispatcher.reevaluateHolds("board-a");
    await h.dispatcher.reevaluateHolds("board-a");
    expect([assess.mock.calls.length, h.launcher.started.length, h.decisions.length]).toEqual([1, 0, heard]);
    expect(await h.posts("board", "board-a")).toEqual([]);
  });

  it("holds a card whose run plan 03's reconcile found gone, and says so in the board room once", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    await h.dispatcher.decideCard(ev(boardCard(1)));
    const [row] = await h.store.instances.find({ cardId: "card-1" });
    await h.store.instances.patch(row.id, { state: "exited", exitReason: "brain_restart_found_gone", endedAt: h.clock.now().toISOString() });   // as plan 03's reconcile writes it
    await h.dispatcher.reevaluateHolds("board-a");
    await h.dispatcher.reevaluateHolds("board-a");
    expect(await h.store.decisions.find({ cardId: "card-1" })).toMatchObject([{ outcome: "hold", decidedBy: "policy", reason: `last run ${row.id} ended exited (brain_restart_found_gone); /retry run ${row.id} or /dispatch board-a card-1` }]);
    expect((await h.posts("board", "board-a")).map((m) => m.body)).toEqual([`${row.id} on board-a:card-1 was gone when the brain restarted. The card is held: /retry run ${row.id} to try again.`]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/dispatch/holds.test.ts`
Expected: FAIL — `h.dispatcher.noteQueue is not a function`.

- [ ] **Step 3: Implement `holds.ts` and the four methods** to the rules above.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/holds.test.ts`
Expected: PASS (6 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/dispatch/holds.ts packages/os/src/dispatch/dispatcher.ts packages/os/tests/dispatch/holds.test.ts
git commit -m "feat(os): re-evaluate holds, drain to empty, record min_cards overrides and settle runs that vanished"
```

---

### Task 9: Instance lifecycle: attach, heartbeat, exit, sweep

**Files:**
- Create: `packages/os/src/dispatch/instances.ts`
- Modify: `packages/os/src/dispatch/dispatcher.ts`
- Modify (append only, skipped where plan 02 already added them): `packages/substrate-plugin/src/types/os-types.ts` (the `Instance` fields), `packages/os/src/store/rows.ts` (`InstanceRowSchema`)
- Test: `packages/os/tests/dispatch/instances.test.ts`

**Interfaces:**
- Consumes: plan 01's `AttachBody`, `HeartbeatBody`, `ExitBody`; Task 4's `ExitReport`, `InstanceTokens`, `handleOf`, `DispatchRooms`; Task 8's `settleEndedRuns`; plan 03's `reconcile` and `FakeEventHub` (test only).
- Produces:

```ts
// packages/os/src/dispatch/instances.ts
export const UNRESPONSIVE_AFTER_MS = 90_000;
export const STOP_ESCALATE_AFTER_MS = 30_000;
export const SWEEP_EVERY_MS = 30_000;                                     // plan 03's `sweep` slot
export class InstanceNotFoundError extends Error {}
export class InstanceEndedError extends Error {}
export function isEnded(state: InstanceRow["state"]): boolean;           // exited, failed, paused, login_expired
export function exitState(row: InstanceRow, report: ExitReport): { state: "exited" | "paused" | "failed" | "login_expired"; exitReason: string };
// Dispatcher
onAttach(instanceId: string, body: AttachBody): Promise<InstanceRow>;
onHeartbeat(instanceId: string, body: HeartbeatBody): Promise<void>;
onExit(instanceId: string, report: ExitReport): Promise<void>;
sweep(): Promise<void>;                                                   // also plan 03's BrainDispatcher.sweep
// plan 02's files, appended
Instance.fields:   phase: field.string({ nullable: true }), currentTask: field.string({ nullable: true })
InstanceRowSchema: phase: z.string().nullable(), currentTask: z.string().nullable()
```

`phase` and `currentTask` live on the row so the dashboard's instance line (plan 07) and `/top` survive a restart. While an instance is live, `exitReason` carries a pending request that `RunControl` (Task 10) persists: `pause_requested`, `stop_requested:graceful`, `stop_requested:immediate:<requested ISO>`, and `stop_requested:immediate:escalated` once the sweep has signalled it. At exit:

| reported `reason` (plan 01's `RunExitReason`, or the launcher's `process_exit`) | pending request | state | `exitReason` |
|---|---|---|---|
| `login_expired` | any | `login_expired` | `login_expired` |
| `completed` | any | `exited` | `completed` |
| `nothing_to_do` | any | `exited` | `nothing_to_do` |
| `paused`, `stopped` or `process_exit` | `pause_requested` | `paused` | `paused` |
| `paused`, `stopped` or `process_exit` | `stop_requested…` | `exited` | `stopped` |
| `paused` | none | `paused` | `paused` |
| `stopped` | none | `exited` | `stopped` |
| `card_not_found`, `failed`, or `process_exit` with nothing pending | none | `failed` | `<reason>`, then `: <message>` when given, then ` (code <code>)` |

Every lifecycle mutation of one instance runs under the key `instance:<id>`, so a run's own exit report and the launcher's child-exit report never interleave. A card settlement inside it then takes the board's key; the order is always instance, then board, then limits.
- `onAttach`: missing → `InstanceNotFoundError`; ended → `InstanceEndedError`; patch `runId`, `dashboardUrl`, `launcherHandle: row.launcherHandle ?? String(pid)` (recovering a handle the brain died before recording), `state: "running"`, `lastHeartbeatAt: now`; post `attached`; emit.
- `onHeartbeat`: missing → `InstanceNotFoundError`; ended → return without writing (a late heartbeat never resurrects a run); patch `lastHeartbeatAt: now`, `tokens: max(row.tokens, body.tokens)`, `phase`, `currentTask`, `dashboardUrl` when given, `state: "running"` (posting `recovered` when it was `unresponsive`); emit.
- `onExit`: missing → `InstanceNotFoundError`; ended → return (a second report changes nothing); apply `exitState`; patch `state`, `exitReason`, `endedAt: now`; `tokens.revokeInstanceToken(id)`; set the room's `closedAt`; post the state's notice in the board room (`exited`, `paused`, `stopped`, `failed`); `login_expired` → `paused: true` on every registration with the same `projectName`, and `login_expired` in the system room naming those boards in name order; then `settleEndedRuns` for the board, which holds the card of every end but a completed one. The brain moves no card: with `--os`, plan 01's run leaves an expired login's card where it is. Emit.
- `sweep()`: (1) each `dispatching` or `running` row whose `max(lastHeartbeatAt ?? startedAt, watchFrom)` is at least `UNRESPONSIVE_AFTER_MS` old becomes `unresponsive`, with `unresponsive` posted in its room and in its board's room; `watchFrom` is the time this `Dispatcher` was built, so a restarted brain gives every instance 90 s to heartbeat again. (2) Each `unresponsive` row asks `launcher.status(handleOf(row))`. `gone` ends it as `exitState` would with `process_exit` (a pending pause or stop is honoured), else `failed` with `exitReason: "gone"` and the `gone` notice, then settles its card. `running` for a row with `runId: null` that became unresponsive in this sweep posts `detached` once: plan 01's run keeps working when its attach is refused, and the launcher can still stop it. (3) Each live row whose request is `stop_requested:immediate:<t>`, with `t` at least `STOP_ESCALATE_AFTER_MS` old, gets `launcher.stop(handleOf(row), "immediate")` once and the request `stop_requested:immediate:escalated`.

Start-up reconcile is plan 03's: it asks the launcher about every live row, keeps the running ones, marks the gone ones `exited` with `BRAIN_RESTART_FOUND_GONE`, and calls `reevaluateHolds` (Task 8 settles their cards). This plan adds no reconcile of its own.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/dispatch/instances.test.ts
import { describe, it, expect } from "vitest";
import { exitState, InstanceEndedError } from "../../src/dispatch/instances.js";
import { latestDecision } from "../../src/dispatch/decisions.js";
import type { ExitReport } from "../../src/dispatch/dispatcher.js";
import { reconcile } from "../../src/brain/reconcile.js";
import { decisionChecks } from "../../src/store/rows.js";
import { FakeEventHub } from "../../src/testing/index.js";
import { harness, addBoardB, ev, notices } from "./harness.js";
import { T0, boardCard, boardRow, registrationRow, instanceRow, silentLog } from "./fixtures.js";

async function dispatched(opts: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ ...opts, registration: { minCards: 1, ...opts.registration } });
  await h.dispatcher.decideCard(ev(boardCard(1)));
  const [row] = await h.store.instances.find({ cardId: "card-1" });
  return { h, row };
}
const noticeBodies = async (h: Awaited<ReturnType<typeof harness>>, notice: string) => (await h.posts("board", "board-a")).filter((m) => JSON.parse(m.dataJson ?? "{}").notice === notice).map((m) => m.body);

describe("instance lifecycle", () => {
  it("REVIEW FOCUS 1: plan 03's reconcile keeps a dispatching row whose process lives, and the card is never started twice", async () => {
    const { h, row } = await dispatched();
    await h.store.instances.patch(row.id, { launcherHandle: null });   // the brain died after spawning, before recording the handle
    h.launcher.setStatus(row.id, "running");
    const brain = h.restart();
    const report = await reconcile({ store: h.store, launcher: h.launcher, dispatcher: brain, clock: h.clock, log: silentLog, hub: new FakeEventHub() });
    expect(report.kept).toEqual([row.id]);
    expect((await h.store.instances.get(row.id))?.state).toBe("dispatching");
    const again = await brain.decideCard(ev(boardCard(1, { version: "2026-10-25T08:05:00.000Z" }), "poll"));
    expect(again.outcome).toBe("hold");
    expect(decisionChecks(again).at(-1)).toMatchObject({ name: "not_in_flight", passed: false });
    expect(h.launcher.started).toHaveLength(1);
    expect(await brain.onAttach(row.id, { runId: "run-1", dashboardUrl: "http://127.0.0.1:3141", pid: 4242 })).toMatchObject({ state: "running", runId: "run-1", launcherHandle: "4242" });
  });

  it("REVIEW FOCUS 3: a restarted brain gives live instances 90 s before calling them unresponsive", async () => {
    const { h, row } = await dispatched();
    await h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 4242 });
    h.clock.advance(10 * 60_000);                                       // the brain was down for ten minutes
    const brain = h.restart();
    await brain.sweep();
    h.clock.advance(89_000);
    await brain.sweep();
    expect((await h.store.instances.get(row.id))?.state).toBe("running");
    expect(await noticeBodies(h, "unresponsive")).toEqual([]);
    h.clock.advance(2_000);
    await brain.sweep();
    expect((await h.store.instances.get(row.id))?.state).toBe("unresponsive");
    expect(await noticeBodies(h, "unresponsive")).toHaveLength(1);
  });

  it("persists heartbeats, never lowers tokens, recovers an unresponsive run and ignores an ended one", async () => {
    const { h, row } = await dispatched();
    await h.dispatcher.onHeartbeat(row.id, { tokens: 500, phase: "working", currentTask: "Add index", dashboardUrl: "http://127.0.0.1:3141" });
    await h.dispatcher.onHeartbeat(row.id, { tokens: 400, phase: "working", currentTask: "Add index" });
    expect(await h.store.instances.get(row.id)).toMatchObject({ state: "running", tokens: 500, phase: "working", currentTask: "Add index", dashboardUrl: "http://127.0.0.1:3141", lastHeartbeatAt: T0.toISOString() });
    await h.store.instances.patch(row.id, { state: "unresponsive" });
    await h.dispatcher.onHeartbeat(row.id, { tokens: 600, phase: "publishing", currentTask: null });
    expect(notices(await h.store.messages.find({ roomId: row.roomId }))).toContain("recovered");
    await h.dispatcher.onExit(row.id, { reason: "completed", code: 0 });
    await h.dispatcher.onHeartbeat(row.id, { tokens: 900, phase: "working", currentTask: null });
    expect(await h.store.instances.get(row.id)).toMatchObject({ state: "exited", tokens: 600, phase: "publishing", tokenHash: "revoked" });
  });

  it("calls a silent instance unresponsive at 90 s, gone when the launcher says so, and holds its card", async () => {
    const { h, row } = await dispatched();
    await h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 4242 });
    h.clock.advance(90_000);
    await h.dispatcher.sweep();
    expect((await h.store.instances.get(row.id))?.state).toBe("unresponsive");
    expect(notices(await h.store.messages.find({ roomId: row.roomId }))).toContain("unresponsive");
    h.launcher.setStatus(row.id, "gone");
    await h.dispatcher.sweep();
    expect(await h.store.instances.get(row.id)).toMatchObject({ state: "failed", exitReason: "gone", tokenHash: "revoked" });
    expect((await h.store.rooms.get(row.roomId))?.closedAt).not.toBeNull();
    expect((await latestDecision(h.store, boardCard(1).ref))?.reason).toBe(`last run ${row.id} ended failed (gone); /retry run ${row.id} or /dispatch board-a card-1`);
    expect(notices(await h.posts("board", "board-a"))).toEqual(["unresponsive", "gone"]);
    await h.dispatcher.decideCard(ev(boardCard(1, { version: "2026-10-25T08:06:00.000Z" })));
    expect(h.launcher.started).toHaveLength(1);
  });

  it("says once that a run which never attached is detached, and leaves it running", async () => {
    const { h, row } = await dispatched();                             // its attach was refused, so it never attached
    h.clock.advance(91_000);
    await h.dispatcher.sweep();
    await h.dispatcher.sweep();
    expect((await h.store.instances.get(row.id))?.state).toBe("unresponsive");
    expect(await noticeBodies(h, "detached")).toEqual([`${row.id} on board-a:card-1 is running but never attached to the brain; /stop run ${row.id} stops it through the launcher.`]);
    expect(h.launcher.stopped).toEqual([]);
  });

  it("escalates an immediate stop to the launcher once, 30 s after it was asked", async () => {
    const { h, row } = await dispatched();
    await h.store.instances.patch(row.id, { exitReason: `stop_requested:immediate:${T0.toISOString()}` });
    h.clock.advance(29_000);
    await h.dispatcher.sweep();
    expect(h.launcher.stopped).toHaveLength(0);
    h.clock.advance(2_000);
    await h.dispatcher.sweep();
    await h.dispatcher.sweep();
    expect(h.launcher.stopped).toEqual([{ handle: { instanceId: row.id, host: "local", handle: "fake-1" }, mode: "immediate" }]);
    expect((await h.store.instances.get(row.id))?.exitReason).toBe("stop_requested:immediate:escalated");
  });

  it("maps exit reports to states", () => {
    const at = (exitReason: string | null, report: ExitReport) => exitState(instanceRow({ exitReason }), report);
    expect(at(null, { reason: "completed", code: 0 })).toEqual({ state: "exited", exitReason: "completed" });
    expect(at(null, { reason: "nothing_to_do", code: 0 })).toEqual({ state: "exited", exitReason: "nothing_to_do" });
    expect(at(null, { reason: "paused", code: 0 })).toEqual({ state: "paused", exitReason: "paused" });
    expect(at(null, { reason: "stopped", code: 130 })).toEqual({ state: "exited", exitReason: "stopped" });
    expect(at(null, { reason: "login_expired", code: 1 })).toEqual({ state: "login_expired", exitReason: "login_expired" });
    expect(at(null, { reason: "failed", code: 1, message: "merge conflict" })).toEqual({ state: "failed", exitReason: "failed: merge conflict (code 1)" });
    expect(at(null, { reason: "card_not_found", code: 2 })).toEqual({ state: "failed", exitReason: "card_not_found (code 2)" });
    expect(at(null, { reason: "process_exit", code: 137 })).toEqual({ state: "failed", exitReason: "process_exit (code 137)" });
    expect(at("pause_requested", { reason: "stopped", code: 130 })).toEqual({ state: "paused", exitReason: "paused" });
    expect(at("pause_requested", { reason: "process_exit", code: 130 })).toEqual({ state: "paused", exitReason: "paused" });
    expect(at("stop_requested:graceful", { reason: "paused", code: 0 })).toEqual({ state: "exited", exitReason: "stopped" });
    expect(at("pause_requested", { reason: "completed", code: 0 })).toEqual({ state: "exited", exitReason: "completed" });
  });

  it("handles an exit once: token revoked, room closed, one notice", async () => {
    const { h, row } = await dispatched();
    await h.dispatcher.onExit(row.id, { reason: "completed", code: 0 });
    await h.dispatcher.onExit(row.id, { reason: "process_exit", code: 0 });
    expect(await h.store.instances.get(row.id)).toMatchObject({ state: "exited", exitReason: "completed", tokenHash: "revoked", endedAt: T0.toISOString() });
    expect((await h.posts("board", "board-a")).map((m) => m.body)).toEqual([`${row.id} finished board-a:card-1 (completed).`]);
    await expect(h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 1 })).rejects.toBeInstanceOf(InstanceEndedError);
  });

  it("holds every board of a project whose login expired and tells the OS owners", async () => {
    const { h, row } = await dispatched();
    await addBoardB(h, { projectName: "project-a" });
    await h.store.boards.put(boardRow({ id: "board-c", name: "board-c", externalId: "5f00000000000000000000dd" }));
    await h.store.registrations.put(registrationRow({ id: "reg-c", boardId: "board-c", projectName: "project-c", swarmPath: "/path/to/project-c/.swarm" }));
    await h.dispatcher.onExit(row.id, { reason: "login_expired", code: 1 });
    const paused = async (id: string) => (await h.store.registrations.get(id))?.paused;
    expect([await paused("reg-a"), await paused("reg-b"), await paused("reg-c")]).toEqual([true, true, false]);
    expect((await h.posts("system")).map((m) => m.body)).toEqual([`Login expired on project-a (${row.id}). Held boards: board-a, board-b. Log in on the host, then /resume board <name>.`]);
    expect(await latestDecision(h.store, boardCard(1).ref)).toMatchObject({ outcome: "hold", decidedBy: "policy", reason: `${row.id} ended login_expired; the card waits for /resume board board-a` });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/dispatch/instances.test.ts`
Expected: FAIL — cannot load `../../src/dispatch/instances.js`.

- [ ] **Step 3: Append the two `Instance` fields, then implement `instances.ts` and the four methods**

Add `phase` and `currentTask` to `Instance.fields` in `packages/substrate-plugin/src/types/os-types.ts` and to `InstanceRowSchema` in `packages/os/src/store/rows.ts`, in both files or neither, so plan 02's parity test still matches the schemas field for field; skip this when plan 02 already has them. When they are new, `tsc` then points at the one place this plan builds an `Instance` row (Task 6's `dispatchLocked`): set both to `null` there. Then implement `instances.ts` and `onAttach`, `onHeartbeat`, `onExit`, `sweep` to the table and rules above.

- [ ] **Step 4: Run the tests and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/instances.test.ts`
Expected: PASS (9 tests). Then the package gate (which includes plan 02's store and parity tests), and `cd packages/substrate-plugin && npx vitest run` (the plugin suite stays green).

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/dispatch/instances.ts packages/os/src/dispatch/dispatcher.ts packages/substrate-plugin/src/types/os-types.ts packages/os/src/store/rows.ts packages/os/tests/dispatch/instances.test.ts
git commit -m "feat(os): instance lifecycle with heartbeats, exits and sweeps; Instance gains phase and currentTask"
```

---

### Task 10: Run control and the dispatch-backed operating commands

**Files:**
- Modify: `packages/os/src/dispatch/instances.ts` (add `RunControl`)
- Create: `packages/os/src/dispatch/commands.ts`
- Test: `packages/os/tests/dispatch/run-control.test.ts`, `packages/os/tests/dispatch/commands.test.ts`

**Interfaces:**
- Consumes: Tasks 6 to 9's `Dispatcher` methods and `DispatchRefusedError`; Task 4's `publishInstanceCommand`, `DispatchRooms`, `handleOf`; Task 1's `BoardClients`, `clientFor`, `BoardApiError`; `EventPublisher`, `Actor` (plan 03); zod.
- Produces:

```ts
// packages/os/src/dispatch/instances.ts
export interface CommandOutcome { ok: boolean; text: string; instance?: InstanceRow; data?: { code: "limit" | "conflict" | "not_found"; check?: CheckName } }   // data.code lets plan 05 answer 429 limit, 409 conflict or 404 not_found
export class RunControl {
  constructor(deps: { store: OsStore; dispatcher: Dispatcher; launcher: Launcher; hub: EventPublisher; boards: BoardClients; rooms: DispatchRooms; clock: Clock; log: Logger });
  resolve(ref: string): Promise<InstanceRow | null>;          // an Instance id, or an Instance.runId
  pause(ref: string, by: string): Promise<CommandOutcome>;
  stop(ref: string, by: string, mode: "graceful" | "immediate"): Promise<CommandOutcome>;
  resume(ref: string, by: string): Promise<CommandOutcome>;
  retry(ref: string, by: string, fresh: boolean): Promise<CommandOutcome>;
  republishPending(): Promise<number>;                         // after a restart, publish again the command of each live attached row with a pending request
}

// packages/os/src/dispatch/commands.ts
export interface DispatchCommandContext { actor: Actor; roomId: string; store: OsStore; dispatcher: Dispatcher; clock: Clock }   // a subset of plan 05's CommandContext
export interface DispatchCommandSpec<A> { name: string; summary: string; kind: "operating"; args: z.ZodType<A>; run(ctx: DispatchCommandContext, args: A): Promise<{ ok: boolean; text: string; data?: unknown }> }   // structurally plan 05's CommandSpec<A>
export interface DispatchCommandDeps { boards: BoardClients; runs: RunControl; refresh: (boardId: string) => Promise<unknown> }   // refresh is Poller.pollNow (Task 13)
export const DISPATCH_COMMAND_NAMES: readonly ["dispatch", "hold", "override min_cards", "pause board", "resume board", "pause run", "resume run", "retry run", "stop run"];
export function dispatchCommands(deps: DispatchCommandDeps): DispatchCommandSpec<any>[];
export function actorRef(actor: Actor): string;               // human → humanId, cos → "cos", host → "host"
export function resolveBoard(store: OsStore, arg: string): Promise<BoardRow | null>;   // drops a "board:" prefix, then matches Board.id, then Board.name
```

`commands.ts` is how plan 04 provides the overview's dispatch-backed operating commands, and it imports nothing from plan 05. While plan 05 is not merged, the specs are only the exported list `dispatchCommands(...)`; `mountDispatch` hands each one to plan 05's `registerCommand` once `BrainHost.registerCommand` exists (Task 14). Plan 05's executor checks authority, limits, step-up and tripwires, and writes the audit message and the reply, before and after `run`; these commands therefore post no room notices of their own.

`RunControl` rules (a live row is `dispatching`, `running` or `unresponsive`; an attached row has a `runId`):
- `pause`: not live → `{ ok: false, text: "<id> is <state>, not running", data: { code: "conflict" } }`. Else persist `exitReason: "pause_requested"`, post `pause_requested` in the instance room, and deliver: an attached run gets `publishInstanceCommand(hub, id, ["pause"])` (the hub holds it while the run reconnects, so there is no retry here); a run that never attached cannot read its stream and gets `launcher.stop(handleOf(row), "graceful")`, one SIGINT, which is `swarm run`'s own graceful pause. Answer `Pausing <id>: it finishes its task, checkpoints and exits.`
- `stop`: graceful persists `stop_requested:graceful` and publishes `["stop", "graceful"]` (`launcher.stop(…, "graceful")` for a run that never attached), answering `Stopping <id> after its current task.`; immediate persists `stop_requested:immediate:<now ISO>` and publishes `["stop", "immediate"]` (`launcher.stop(…, "immediate")` straight away for a run that never attached), answering `Stopping <id> now.`; the sweep signals an attached run through the launcher if it is still live 30 s later (Task 9). Both post `stop_requested`.
- `resume` takes only a `paused` row (else `only a paused run resumes; <id> is <state>`, `conflict`); `retry` takes only an ended row (else `<id> is still live; /stop run <id> first`, `conflict`). A new instance is therefore made only when the card's last one has ended, so no card has two live rows (plan 09 counts dispatches from `Instance` rows). Both fetch the card fresh with the board's client (`null` → `<cardId> is no longer on <board>`, `not_found`; a `BoardApiError` → `<board> could not be read (<code>)`) and call `dispatcher.dispatch(registration, card, by, { resumeOf: id, fresh })`, with `fresh` only for `retry … --fresh`. A returned `failed` row answers `{ ok: false, text: "spawn failed: …" }`; a `DispatchRefusedError` answers its check's detail with `data.code` `limit` for `refused` and `conflict` for `hold`. Success answers `Resumed <cardId> as <newId>.` or `Retrying <cardId> as <newId>.`, with `instance`.
- `republishPending`: `pause_requested` → `["pause"]`, `stop_requested:graceful` → `["stop", "graceful"]`, `stop_requested:immediate:*` → `["stop", "immediate"]`, for live rows with a `runId`.

The commands. Each `args` is a strict `z.object` keyed by the positional words in order, with booleans as `--key` flags; plan 05's executor builds it from the argv with `argvToArgs(spec, rest)`, so `run` always receives the parsed object, never the raw argv. `board` goes through `resolveBoard`, `card` drops a `card:` prefix, and `instance` goes through `runs.resolve`. A missing board, registration, card or instance answers `ok: false` with `data.code: "not_found"`, and missing board credentials answer `no <kind> credentials in os.json`.

| name | `args` | does | answers |
|---|---|---|---|
| `dispatch` | `{ board, card }` | `getCard`, then `dispatcher.dispatch(registration, card, actorRef(actor))`; bypasses `min_cards` and the chain, never the limits | `Dispatched "<title>" as <id>.` |
| `hold` | `{ board, card, reason?: string[] }` | `dispatcher.holdCard(registration, card, actorRef(actor), reason?.join(" ") \|\| "held by hand")` | `Holding "<title>": <reason>.` |
| `override min_cards` | `{ board, revoke?: boolean }` (`revoke` is this plan's addition: the spec says an override lasts until the queue empties "or it is revoked") | `dispatcher.overrideMinCards(registration, actorRef(actor), revoke)`, then `refresh(boardId)` on success | `min_cards override on <board> until the queue is empty.`, `min_cards override on <board> revoked.`, or `no active min_cards override on <board>` (`not_found`) |
| `pause board` | `{ board }` | `paused: true` | `<board> paused.` |
| `resume board` | `{ board }` | `paused: false`, then `refresh(boardId)` | `<board> resumed.` |
| `pause run` | `{ instance }` | `runs.pause` | its outcome |
| `resume run` | `{ instance }` | `runs.resume` | its outcome |
| `retry run` | `{ instance, fresh?: boolean }` | `runs.retry`, fresh with `fresh` | its outcome |
| `stop run` | `{ instance, now?: boolean }` | `runs.stop`, immediate with `now` | its outcome |

- [ ] **Step 1: Write the failing tests**

```ts
// packages/os/tests/dispatch/run-control.test.ts
import { describe, it, expect } from "vitest";
import { RunControl } from "../../src/dispatch/instances.js";
import { DispatchRooms } from "../../src/dispatch/room-opener.js";
import { FakeBoardClient, FakeEventHub } from "../../src/testing/index.js";
import { harness, ev } from "./harness.js";
import { boardCard, silentLog } from "./fixtures.js";

async function setup(attach = true) {
  const h = await harness({ registration: { minCards: 1 } });
  const hub = new FakeEventHub();
  const fake = new FakeBoardClient("trello");
  fake.setQueue("board-a", [boardCard(1)]);
  const runs = new RunControl({ store: h.store, dispatcher: h.dispatcher, launcher: h.launcher, hub, boards: { trello: fake }, rooms: new DispatchRooms({ store: h.store, opener: h.opener, config: h.config }), clock: h.clock, log: silentLog });
  await h.dispatcher.decideCard(ev(boardCard(1)));
  const [row] = await h.store.instances.find({ cardId: "card-1" });
  if (attach) await h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 4242 });
  return { h, hub, fake, runs, row };
}
const commandsFor = (hub: FakeEventHub, instanceId: string) =>
  hub.published.filter((e) => e.type === "command" && e.visibleTo({ kind: "instance", instanceId })).map((e) => (e.payload as { argv: string[] }).argv);

describe("RunControl", () => {
  it("pauses an attached run through its own stream, and marks it paused when it exits", async () => {
    const { h, hub, runs, row } = await setup();
    expect(await runs.pause("run-1", "owner")).toMatchObject({ ok: true, text: `Pausing ${row.id}: it finishes its task, checkpoints and exits.` });
    expect([commandsFor(hub, row.id), commandsFor(hub, "inst-other"), h.launcher.stopped]).toEqual([[["pause"]], [], []]);
    expect(hub.published.every((e) => !e.visibleTo({ kind: "host" }))).toBe(true);
    expect((await h.store.instances.get(row.id))?.exitReason).toBe("pause_requested");
    await h.dispatcher.onExit(row.id, { reason: "stopped", code: 130 });
    expect((await h.store.instances.get(row.id))?.state).toBe("paused");
    expect(await runs.pause(row.id, "owner")).toMatchObject({ ok: false, data: { code: "conflict" } });
  });

  it("stops a run that never attached through the launcher, since it cannot read its stream", async () => {
    const { h, hub, runs, row } = await setup(false);
    await runs.pause(row.id, "owner");
    await runs.stop(row.id, "owner", "immediate");
    expect(h.launcher.stopped.map((s) => s.mode)).toEqual(["graceful", "immediate"]);
    expect(commandsFor(hub, row.id)).toEqual([]);
  });

  it("stops an attached run immediately through its stream and records the request", async () => {
    const { h, hub, runs, row } = await setup();
    await runs.stop(row.id, "owner", "immediate");
    expect(commandsFor(hub, row.id)).toEqual([["stop", "immediate"]]);
    expect((await h.store.instances.get(row.id))?.exitReason).toBe(`stop_requested:immediate:${h.clock.now().toISOString()}`);
    await h.dispatcher.onExit(row.id, { reason: "paused", code: 0 });
    expect(await h.store.instances.get(row.id)).toMatchObject({ state: "exited", exitReason: "stopped" });
  });

  it("resumes a paused run as a new instance on the same card, and retries an ended one fresh only when asked", async () => {
    const { h, runs, row } = await setup();
    await runs.pause(row.id, "owner");
    await h.dispatcher.onExit(row.id, { reason: "paused", code: 0 });
    const resumed = await runs.resume(row.id, "owner");
    const id = resumed.instance!.id;
    expect(resumed).toMatchObject({ ok: true, text: `Resumed card-1 as ${id}.`, instance: { cardId: "card-1", state: "dispatching" } });
    expect(await runs.resume(id, "owner")).toMatchObject({ ok: false, text: `only a paused run resumes; ${id} is dispatching` });
    expect(await runs.retry(id, "owner", true)).toMatchObject({ ok: false, text: `${id} is still live; /stop run ${id} first` });
    await h.dispatcher.onExit(id, { reason: "failed", code: 1 });
    expect(await runs.retry(id, "owner", true)).toMatchObject({ ok: true });
    expect(h.launcher.started.map((s) => [s.cardId, s.fresh ?? false])).toEqual([["card-1", false], ["card-1", false], ["card-1", true]]);
    const live = (await h.store.instances.find({ cardId: "card-1" })).filter((r) => ["dispatching", "running", "unresponsive"].includes(r.state));
    expect(live).toHaveLength(1);
  });

  it("refuses to resume a card that left the board", async () => {
    const { h, fake, runs, row } = await setup();
    await runs.pause(row.id, "owner");
    await h.dispatcher.onExit(row.id, { reason: "paused", code: 0 });
    fake.deleteCard(boardCard(1).ref);
    expect(await runs.resume(row.id, "owner")).toEqual({ ok: false, text: "card-1 is no longer on board-a", data: { code: "not_found" } });
  });

  it("publishes pending requests again after a restart", async () => {
    const { hub, runs, row } = await setup();
    await runs.pause(row.id, "owner");
    expect(await runs.republishPending()).toBe(1);
    expect(commandsFor(hub, row.id)).toEqual([["pause"], ["pause"]]);
  });
});
```

```ts
// packages/os/tests/dispatch/commands.test.ts
import { describe, it, expect } from "vitest";
import { dispatchCommands, DISPATCH_COMMAND_NAMES } from "../../src/dispatch/commands.js";
import { RunControl } from "../../src/dispatch/instances.js";
import { DispatchRooms } from "../../src/dispatch/room-opener.js";
import { openSticky } from "../../src/dispatch/decisions.js";
import { FakeBoardClient, FakeEventHub } from "../../src/testing/index.js";
import { harness, ev } from "./harness.js";
import { OWNER, boardCard, silentLog } from "./fixtures.js";

async function setup() {
  const h = await harness();
  const fake = new FakeBoardClient("trello");
  fake.setQueue("board-a", [boardCard(1), boardCard(2)]);
  const rooms = new DispatchRooms({ store: h.store, opener: h.opener, config: h.config });
  const runs = new RunControl({ store: h.store, dispatcher: h.dispatcher, launcher: h.launcher, hub: new FakeEventHub(), boards: { trello: fake }, rooms, clock: h.clock, log: silentLog });
  const refreshed: string[] = [];
  const specs = dispatchCommands({ boards: { trello: fake }, runs, refresh: async (id) => { refreshed.push(id); } });
  const run = (name: string, args: Record<string, unknown>) => {
    const spec = specs.find((s) => s.name === name)!;
    return spec.run({ actor: OWNER, roomId: "room-cos", store: h.store, dispatcher: h.dispatcher, clock: h.clock }, spec.args.parse(args));
  };
  return { h, specs, run, refreshed };
}

describe("dispatch-backed commands", () => {
  it("are the overview's nine operating commands", async () => {
    const { specs } = await setup();
    expect(specs.map((s) => [s.name, s.kind])).toEqual(DISPATCH_COMMAND_NAMES.map((n) => [n, "operating"]));
  });

  it("dispatch takes a card below min_cards, and refuses a second instance on it", async () => {
    const { h, run } = await setup();
    expect(await run("dispatch", { board: "board:board-a", card: "card:card-1" })).toMatchObject({ ok: true });
    expect((await h.store.decisions.find({ cardId: "card-1" }))[0].decidedBy).toBe("owner");
    expect(await run("dispatch", { board: "board-a", card: "card-1" })).toMatchObject({ ok: false, text: expect.stringContaining("is already on this card"), data: { code: "conflict", check: "not_in_flight" } });
    expect(await run("dispatch", { board: "board-z", card: "card-1" })).toMatchObject({ ok: false, data: { code: "not_found" } });
  });

  it("hold records a sticky hold by the person who asked", async () => {
    const { h, run } = await setup();
    expect(await run("hold", { board: "board-a", card: "card-2", reason: ["needs", "a", "design"] })).toEqual({ ok: true, text: 'Holding "Card 2": needs a design.' });
    expect(await openSticky(h.store, boardCard(2).ref)).toMatchObject({ kind: "hold", by: "owner", reason: "held by owner: needs a design" });
  });

  it("override min_cards records an override, refreshes the board, and --revoke ends it", async () => {
    const { h, run, refreshed } = await setup();
    expect(await run("override min_cards", { board: "board-a" })).toEqual({ ok: true, text: "min_cards override on board-a until the queue is empty." });
    expect(await h.store.decisions.find({ decidedBy: "override:owner" })).toHaveLength(1);
    expect(await run("override min_cards", { board: "board-a", revoke: true })).toEqual({ ok: true, text: "min_cards override on board-a revoked." });
    expect(await run("override min_cards", { board: "board-a", revoke: true })).toMatchObject({ ok: false, text: "no active min_cards override on board-a" });
    expect(refreshed).toEqual(["board-a", "board-a"]);
  });

  it("pause board holds new cards quietly, and resume board refreshes", async () => {
    const { h, run, refreshed } = await setup();
    expect(await run("pause board", { board: "board-a" })).toEqual({ ok: true, text: "board-a paused." });
    expect((await h.dispatcher.decideCard(ev(boardCard(1)))).reason).toBe("board-a is paused");
    expect(await run("resume board", { board: "board-a" })).toEqual({ ok: true, text: "board-a resumed." });
    expect([(await h.store.registrations.get("reg-a"))?.paused, refreshed]).toEqual([false, ["board-a"]]);
  });

  it("rejects malformed arguments", async () => {
    const { specs } = await setup();
    expect(() => specs.find((s) => s.name === "dispatch")!.args.parse({ board: "board-a" })).toThrow();
    expect(() => specs.find((s) => s.name === "stop run")!.args.parse({ instance: "inst-1", later: true })).toThrow();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/os && npx vitest run tests/dispatch/run-control.test.ts tests/dispatch/commands.test.ts`
Expected: FAIL — `RunControl` is not exported from `instances.js`, and `../../src/dispatch/commands.js` cannot be loaded.

- [ ] **Step 3: Implement `RunControl` and `commands.ts`** to the rules and the table above.

- [ ] **Step 4: Run the tests and the package gate**

Run: `cd packages/os && npx vitest run tests/dispatch/run-control.test.ts tests/dispatch/commands.test.ts`
Expected: PASS (12 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/dispatch/instances.ts packages/os/src/dispatch/commands.ts packages/os/tests/dispatch/run-control.test.ts packages/os/tests/dispatch/commands.test.ts
git commit -m "feat(os): run control and the dispatch-backed operating commands"
```

---

### Task 11: `LocalLauncher`

**Files:**
- Create: `packages/os/src/launcher/local.ts`
- Create: `packages/os/tests/launcher/__fixtures__/fake-run.mjs`
- Test: `packages/os/tests/launcher/local.test.ts`

**Interfaces:**
- Consumes: Task 4's `Launcher`, `InstanceSpec`, `LauncherHandle`, `ResourceSnapshot`, `UsageSource`, `LaunchError`.
- Produces:

```ts
export interface LocalLauncherOptions {
  command: string[];                 // how to run swarm itself; the CLI passes swarmSelfCommand() from packages/cli/src/cli/codex-hook.ts ([execPath] for the binary, [execPath, entry] under node)
  osHome: string;                    // logs and pid files live in <osHome>/instances/
  host?: string;                     // default "local"
  usage?: UsageSource;               // default: no instances, no ports, no tokens
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;   // default process.kill
  ps?: () => Promise<string>;        // default execFile("ps", ["-A", "-o", "args="]) on darwin and linux, "" elsewhere
}
export class LocalLauncher implements Launcher {
  readonly kind: "local";
  constructor(opts: LocalLauncherOptions);
  onChildExit(listener: (handle: LauncherHandle, code: number | null, signal: NodeJS.Signals | null) => void): void;
}
export const INHERITED_ENV: readonly ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "SWARM_NODE"];
export const SECOND_SIGINT_AFTER_MS = 500;
export const SIGKILL_AFTER_MS = 30_000;
export function runArgv(spec: InstanceSpec): string[];   // ["run", "--card", cardId, "--yes", "--no-tree", "--swarm-path", swarmPath, "--os", brainUrl, "--os-token", token] + ["--fresh"] when fresh
export function instanceEnv(spec: InstanceSpec, parent: NodeJS.ProcessEnv): Record<string, string>;
export function countClaudeProcesses(psArgs: string): number;
```

Rules:
- `start`: create `<osHome>/instances` (mode `0700`); open `<instanceId>.log` for append (mode `0600`); `spawn(command[0], [...command.slice(1), ...runArgv(spec)], { cwd: dirname(registration.swarmPath), env: instanceEnv(spec, process.env), detached: true, stdio: ["ignore", fd, fd] })`, so the run has its own process group and its output goes to the log. When `child.pid` is undefined, wait for the child's `error` and reject with `LaunchError(<its message>)`. Write `<instanceId>.pid` (mode `0600`) before resolving, then `child.unref()` and close the fd. On the child's `exit`, delete the pid file and call every `onChildExit` listener. Resolve `{ instanceId, host, handle: String(pid) }`.
- `instanceEnv`: the `INHERITED_ENV` keys the brain's environment has (PATH and HOME, plus what a run needs to push over SSH and to find Node for its sidecars), then `spec.env`, then `SWARM_OS_INSTANCE_ID: spec.instanceId`, set last so nothing overrides it. Nothing else from the brain's environment reaches a run, so `ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN` and the like never pass through the brain.
- `status`: the pid is `Number(handle.handle)`, or the pid file's content when the handle is empty (the brain died before recording it, plan 03's obligation); no pid → `gone`; `kill(pid, 0)` succeeding or failing with `EPERM` → `running`; `ESRCH` → `gone`.
- `stop`: `graceful` sends `SIGINT` once, which `swarm run` treats as a graceful pause (finish the task, checkpoint, exit). `immediate` sends `SIGINT`, a second `SIGINT` after `SECOND_SIGINT_AFTER_MS` (inside the run's 2 s double-press window), and after `SIGKILL_AFTER_MS`, if `kill(pid, 0)` still succeeds, `SIGKILL` to the process group `-pid`. It resolves after the first signal; its timers are `unref`'d; `ESRCH` is ignored. The group is the run's own: the project's Substrate sidecars are spawned detached into their own groups (`packages/substrate/src/lifecycle/sidecar.ts`), so no signal from the brain reaches them.
- `resources`: `{ host, at: <now ISO>, cpuLoad1: os.loadavg()[0], cpus: os.cpus().length, memFreeMb, memTotalMb (rounded MiB), claudeSessions: countClaudeProcesses(await ps()), ...await usage.usage() }`.
- `countClaudeProcesses`: a line of `ps -o args=` counts when argv[0]'s basename is `claude`, or argv[0]'s basename is `node` or `bun` and argv[1] contains `/claude-code/` or `/claude-agent-sdk/` or has the basename `claude`.

- [ ] **Step 1: Write the fixture and the failing test**

```js
// packages/os/tests/launcher/__fixtures__/fake-run.mjs: stands in for `swarm run`
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort() }));
let presses = 0;
process.on("SIGINT", () => { presses += 1; console.log(`SIGINT ${presses}`); if (presses >= 2) process.exit(130); });
setInterval(() => {}, 1_000);
```

```ts
// packages/os/tests/launcher/local.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalLauncher, runArgv, instanceEnv, countClaudeProcesses } from "../../src/launcher/local.js";
import { LaunchError } from "../../src/launcher/launcher.js";
import { registrationRow } from "../dispatch/fixtures.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/fake-run.mjs", import.meta.url));
const spec = (swarmPath = "/path/to/project-a/.swarm", over: Record<string, unknown> = {}) => ({ instanceId: "inst-t1", registration: registrationRow({ swarmPath }), cardId: "card-1", token: "inst_secret", brainUrl: "http://127.0.0.1:3200", ...over });
async function lineIn(file: string, re: RegExp): Promise<string> {
  for (let i = 0; i < 250; i++) {
    const hit = (existsSync(file) ? await readFile(file, "utf8") : "").split("\n").find((l) => re.test(l));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no line matching ${re} in ${file}`);
}
afterEach(() => { vi.useRealTimers(); delete process.env.LEAK_CHECK; });

describe("LocalLauncher", () => {
  it("builds swarm run's argv and a minimal environment that always names the instance", () => {
    expect(runArgv(spec())).toEqual(["run", "--card", "card-1", "--yes", "--no-tree", "--swarm-path", "/path/to/project-a/.swarm", "--os", "http://127.0.0.1:3200", "--os-token", "inst_secret"]);
    expect(runArgv(spec(undefined, { fresh: true })).at(-1)).toBe("--fresh");
    const parent = { PATH: "/usr/bin", HOME: "/path/to/home", SSH_AUTH_SOCK: "/path/to/agent.sock", ANTHROPIC_API_KEY: "sk-ant-x", GH_TOKEN: "ghp_x", LEAK: "1" };
    expect(instanceEnv(spec(), parent)).toEqual({ PATH: "/usr/bin", HOME: "/path/to/home", SSH_AUTH_SOCK: "/path/to/agent.sock", SWARM_OS_INSTANCE_ID: "inst-t1" });
    expect(instanceEnv(spec(undefined, { env: { SWARM_OS_CONTEXT: "Use staging", SWARM_OS_INSTANCE_ID: "spoofed" } }), parent)).toMatchObject({ SWARM_OS_CONTEXT: "Use staging", SWARM_OS_INSTANCE_ID: "inst-t1" });
  });

  it("spawns the run detached in the project directory, logs it, and stops it the way swarm run expects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-os-launcher-"));
    const project = join(dir, "project-a");
    await mkdir(join(project, ".swarm"), { recursive: true });
    const osHome = join(dir, "os");
    process.env.LEAK_CHECK = "1";
    const launcher = new LocalLauncher({ command: [process.execPath, FIXTURE], osHome });
    const exits: Array<number | null> = [];
    launcher.onChildExit((_h, code) => exits.push(code));
    const s = spec(join(project, ".swarm"));
    const h = await launcher.start(s);
    const log = join(osHome, "instances", "inst-t1.log");
    const first = JSON.parse(await lineIn(log, /^\{/)) as { argv: string[]; cwd: string; env: string[] };
    expect(first.argv).toEqual(runArgv(s));
    expect(realpathSync(first.cwd)).toBe(realpathSync(project));
    expect(first.env).toContain("SWARM_OS_INSTANCE_ID");
    expect(first.env).not.toContain("LEAK_CHECK");
    expect(await launcher.status(h)).toBe("running");
    expect(await launcher.status({ ...h, handle: "" })).toBe("running");      // found through the pid file
    await launcher.stop(h, "graceful");
    await lineIn(log, /^SIGINT 1$/);
    expect(await launcher.status(h)).toBe("running");
    await launcher.stop(h, "immediate");
    await vi.waitFor(() => expect(exits).toEqual([130]), { timeout: 5_000 });
    expect(await launcher.status(h)).toBe("gone");
    expect(existsSync(join(osHome, "instances", "inst-t1.pid"))).toBe(false);
  });

  it("rejects a command that cannot be spawned", async () => {
    const osHome = join(await mkdtemp(join(tmpdir(), "swarm-os-launcher-")), "os");
    await expect(new LocalLauncher({ command: ["/path/to/missing-swarm"], osHome }).start(spec())).rejects.toBeInstanceOf(LaunchError);
  });

  it("sends two SIGINTs inside the 2 s window for an immediate stop, then SIGKILLs the group after 30 s", async () => {
    vi.useFakeTimers();
    const sent: Array<[number, NodeJS.Signals]> = [];
    let alive = true;
    const kill = (pid: number, sig: NodeJS.Signals | 0) => {
      if (sig === 0) { if (!alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); return; }
      sent.push([pid, sig]);
    };
    const launcher = new LocalLauncher({ command: ["swarm"], osHome: "/path/to/os-home", kill });
    const h = { instanceId: "inst-1", host: "local", handle: "4242" };
    await launcher.stop(h, "immediate");
    expect(sent).toEqual([[4242, "SIGINT"]]);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([[4242, "SIGINT"], [4242, "SIGINT"]]);
    vi.advanceTimersByTime(30_000);
    expect(sent.at(-1)).toEqual([-4242, "SIGKILL"]);
    sent.length = 0;
    alive = false;
    await launcher.stop(h, "immediate");
    vi.advanceTimersByTime(31_000);
    expect(sent.some(([, sig]) => sig === "SIGKILL")).toBe(false);
    sent.length = 0;
    await launcher.stop(h, "graceful");
    vi.advanceTimersByTime(31_000);
    expect(sent).toEqual([[4242, "SIGINT"]]);
  });

  it("reports the machine, its Claude Code sessions and the usage source", async () => {
    const ps = async () => "/usr/local/bin/claude --resume\nnode /path/to/lib/node_modules/@anthropic-ai/claude-code/cli.js\nnode /path/to/server.js\n/bin/zsh\n";
    expect(countClaudeProcesses(await ps())).toBe(2);
    const usage = { usage: async () => ({ instancesRunning: 1, portsInUse: [3141], tokensThisHour: { "project-a": 700 } }) };
    const r = await new LocalLauncher({ command: ["swarm"], osHome: "/path/to/os-home", ps, usage }).resources();
    expect(r).toMatchObject({ host: "local", claudeSessions: 2, instancesRunning: 1, portsInUse: [3141], tokensThisHour: { "project-a": 700 } });
    expect(r.cpus).toBeGreaterThan(0);
    expect(r.memTotalMb).toBeGreaterThanOrEqual(r.memFreeMb);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/launcher/local.test.ts`
Expected: FAIL — cannot load `../../src/launcher/local.js`.

- [ ] **Step 3: Implement `LocalLauncher`** in `packages/os/src/launcher/local.ts` to the rules above.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/launcher/local.test.ts`
Expected: PASS (5 tests; the spawn test takes about a second); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/launcher/local.ts packages/os/tests/launcher/__fixtures__/fake-run.mjs packages/os/tests/launcher/local.test.ts
git commit -m "feat(os): local launcher that spawns swarm run per card"
```

---

### Task 12: Resource snapshots and `GET /api/resources`

**Files:**
- Create: `packages/os/src/resources/resources.ts`
- Test: `packages/os/tests/resources/resources.test.ts`

**Interfaces:**
- Consumes: Task 4's `Launcher`, `ResourceSnapshot`, `UsageSource`, `RouteSpec`, `PeriodicTask`, `staffOnly`; Task 5's `computeUsage`; `EventPublisher` (plan 03); `readJson` (plan 02).
- Produces:

```ts
export const RESOURCES_EVERY_MS = 15_000;                                 // plan 03's `resources` slot
export const RESOURCE_HISTORY_MS = 3_600_000;
export function storeUsage(store: OsStore, clock: Clock): UsageSource;   // computeUsage → { instancesRunning: live.length, portsInUse, tokensThisHour: tokensLastHour }
export class ResourceMonitor {
  constructor(deps: { store: OsStore; launcher: Launcher; hub: EventPublisher; clock: Clock; log: Logger });
  sample(): Promise<ResourceSnapshot>;      // launcher.resources(); put a ResourceSnapshot row (newId("res"), host, at, snapshotJson); publish "resources" { snapshot } to staffOnly; delete that host's rows older than RESOURCE_HISTORY_MS
  latest(): Promise<ResourceSnapshot | null>;
  history(): Promise<ResourceSnapshot[]>;   // the last hour, oldest first; snapshotJson read with readJson
  periodic(): PeriodicTask;                 // { name: "resources", everyMs: RESOURCES_EVERY_MS }; a failed sample is logged with warn and never thrown
  route(): RouteSpec;                       // GET /api/resources, auth ["human", "cos", "host"] → 200 { latest, history }
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/resources/resources.test.ts
import { describe, it, expect } from "vitest";
import { ResourceMonitor, storeUsage } from "../../src/resources/resources.js";
import { FakeLauncher, FakeEventHub, MemoryOsStore, FakeClock } from "../../src/testing/index.js";
import { T0, OWNER, instanceRow, registrationRow, silentLog } from "../dispatch/fixtures.js";

const at = (minutesAgo: number) => new Date(T0.getTime() - minutesAgo * 60_000).toISOString();
const snap = (when: string) => ({ host: "local", at: when, cpuLoad1: 0.5, cpus: 8, memFreeMb: 4096, memTotalMb: 16384, instancesRunning: 1, claudeSessions: 2, portsInUse: [3141], tokensThisHour: { "project-a": 700 } });

describe("ResourceMonitor", () => {
  it("samples into a row and a staff-only event, keeps an hour of history, and serves GET /api/resources", async () => {
    const store = new MemoryOsStore();
    const launcher = new FakeLauncher();
    launcher.snapshot = snap(T0.toISOString());
    const hub = new FakeEventHub();
    await store.resources.put({ id: "res-old", host: "local", at: at(61), snapshotJson: JSON.stringify(snap(at(61))) });
    await store.resources.put({ id: "res-recent", host: "local", at: at(59), snapshotJson: JSON.stringify(snap(at(59))) });
    const monitor = new ResourceMonitor({ store, launcher, hub, clock: new FakeClock(T0), log: silentLog });
    expect(monitor.periodic()).toMatchObject({ name: "resources", everyMs: 15_000 });
    await monitor.sample();
    expect(hub.published.map((e) => [e.type, e.payload])).toEqual([["resources", { snapshot: snap(T0.toISOString()) }]]);
    expect([hub.published[0].visibleTo(OWNER), hub.published[0].visibleTo({ kind: "instance", instanceId: "inst-1" })]).toEqual([true, false]);
    expect(await store.resources.get("res-old")).toBeNull();
    expect(await monitor.latest()).toEqual(snap(T0.toISOString()));
    expect((await monitor.history()).map((s) => s.at)).toEqual([at(59), T0.toISOString()]);
    const route = monitor.route();
    expect(route).toMatchObject({ method: "GET", path: "/api/resources", auth: ["human", "cos", "host"] });
    expect(await route.handler({ params: {}, query: {}, headers: {}, body: undefined, rawBody: "", actor: OWNER })).toEqual({ status: 200, body: { latest: snap(T0.toISOString()), history: await monitor.history() } });
  });

  it("keeps the periodic alive when the launcher fails", async () => {
    const launcher = new FakeLauncher();
    launcher.resources = async () => { throw new Error("ps failed"); };
    const warned: string[] = [];
    const monitor = new ResourceMonitor({ store: new MemoryOsStore(), launcher, hub: new FakeEventHub(), clock: new FakeClock(T0), log: { ...silentLog, warn: (m: string) => { warned.push(m); } } });
    await expect(monitor.periodic().run()).resolves.toBeUndefined();
    expect(warned).toHaveLength(1);
  });

  it("storeUsage reports live instances, their dashboard ports and tokens per project", async () => {
    const store = new MemoryOsStore();
    await store.registrations.put(registrationRow());
    await store.instances.put(instanceRow({ state: "running", tokens: 700, dashboardUrl: "http://127.0.0.1:3141" }));
    expect(await storeUsage(store, new FakeClock(T0)).usage()).toEqual({ instancesRunning: 1, portsInUse: [3141], tokensThisHour: { "project-a": 700 } });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/os && npx vitest run tests/resources/resources.test.ts`
Expected: FAIL — cannot load `../../src/resources/resources.js`.

- [ ] **Step 3: Implement `ResourceMonitor` and `storeUsage`** to the signatures above.

- [ ] **Step 4: Run the test and the package gate**

Run: `cd packages/os && npx vitest run tests/resources/resources.test.ts`
Expected: PASS (3 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/resources/resources.ts packages/os/tests/resources/resources.test.ts
git commit -m "feat(os): resource snapshots every 15 s and GET /api/resources"
```

---

### Task 13: The poller and the webhook routes

**Files:**
- Create: `packages/os/src/ingress/poller.ts`, `packages/os/src/ingress/webhooks.ts`
- Test: `packages/os/tests/ingress/poller.test.ts`, `packages/os/tests/ingress/webhooks.test.ts`

**Interfaces:**
- Consumes: Task 1's contract; Task 2's `trelloCallbackUrl`; Task 5's `findDecision`; Tasks 7 and 8's `decideCard`, `noteQueue`, `reevaluateHolds`; Task 4's `DispatchRooms`, `KeyedQueue`, `RouteSpec`, `PeriodicTask`, `apiError`.
- Produces:

```ts
// packages/os/src/ingress/poller.ts
export interface PollReport { boardId: string; ok: boolean; listed: number; emitted: number; error: string | null }   // error: the failure's code
export class Poller {
  constructor(deps: { store: OsStore; boards: BoardClients; dispatcher: Pick<Dispatcher, "decideCard" | "noteQueue" | "reevaluateHolds">; rooms: DispatchRooms; config: OsConfig; clock: Clock; log: Logger });
  periodic(): PeriodicTask;                         // { name: "poller", everyMs: config.poll_interval_seconds * 1000, run: () => pollAll(), dropping the reports }
  pollAll(): Promise<PollReport[]>;                 // every registration in id order; one board's failure never stops the rest
  pollNow(boardId: string): Promise<PollReport>;   // one board; polls of the same board never overlap
}

// packages/os/src/ingress/webhooks.ts
export interface IngressCounters { webhooksAccepted: number; webhooksRejected: number; webhooksUnknownBoard: number }   // rejected: unverified or malformed
export class WebhookCounters { accepted: number; rejected: number; unknownBoard: number; counters(): IngressCounters }
export interface WebhookDeps { store: OsStore; boards: BoardClients; config: OsConfig; decide: (event: CardEvent) => Promise<unknown>; counters: WebhookCounters; log: Logger }
export function ingestRefs(deps: WebhookDeps, client: BoardClient, refs: CardRef[]): Promise<void>;   // getCard each; decide({ ref: card.ref, version: card.version, card, source: "webhook" }) with the canonical ref getCard returns; errors are logged, never thrown
export function webhookRoutes(deps: WebhookDeps): RouteSpec[];   // POST and HEAD /hooks/trello/:boardId, POST /hooks/github/:owner/:repo; auth "none", rawBody true
```

**One poll of a board**, under a per-board `KeyedQueue` key:
1. Find the board and its registration (none → report `no registration`); `clientFor(boards, board)` (none → a failure with code `no_credentials` and message `no <kind> credentials in os.json boards`).
2. `startedAt = clock.now()`; `cards = await client.listQueue(board)`.
3. `await dispatcher.noteQueue(board.id, cards)`.
4. For each card in queue order without a decision for its exact `(board, card, version)` (`findDecision`), `await dispatcher.decideCard({ ref: card.ref, version: card.version, card, source: "poll" })`, counting it as emitted.
5. Patch `lastPolledAt: startedAt`, then `await dispatcher.reevaluateHolds(board.id)`.
6. After a failure streak, post `poll_recovered` and reset the streak.

Any throw in steps 2 to 5 is a failure: `lastPolledAt` is not advanced, the error is logged with `warn` every time, and only the first failure of a streak posts `poll_failed` (the code of a `BoardApiError`, else `error`). Decisions already made stay, and the next poll converges on them. `lastPolledAt` records the last good listing and is never a filter: board clocks and the brain's differ, so a card is skipped only when its exact version already has a decision.

**Webhook routes.** They take no `X-Swarm-Os`: they are outside `/api` and authenticated by signature.
- `POST /hooks/trello/:boardId`: the Board row by id; missing or not a Trello board → `unknownBoard += 1`, `404 not_found` (`no Trello board <id>`); no Trello client → `404 not_found` (`this brain has no Trello credentials`); `verifyWebhook({ board, headers, rawBody, callbackUrl: trelloCallbackUrl(config.public_url, board.id) })` false → `rejected += 1`, one `warn` line naming the board (never the body), `401 unauthenticated` (`webhook signature did not verify`); a signed body that is not JSON → `rejected += 1`, `400 bad_request`; else `accepted += 1`, and the reply `200 { ok: true, cards: <refs> }` goes out with `work: ingestRefs(...)`, so the board gets its answer before any card is decided.
- `HEAD /hooks/trello/:boardId`: `200` for a known Trello board (Trello's check when a webhook is created), else `404`.
- `POST /hooks/github/:owner/:repo`: the Board row `{ kind: "github", externalId: "<owner>/<repo>" }`, then the same flow with `callbackUrl: ""`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/os/tests/ingress/poller.test.ts
import { describe, it, expect } from "vitest";
import { Poller } from "../../src/ingress/poller.js";
import { ingestRefs, WebhookCounters } from "../../src/ingress/webhooks.js";
import { BoardApiError, type BoardClients } from "../../src/ingress/board-client.js";
import { DispatchRooms } from "../../src/dispatch/room-opener.js";
import { FakeBoardClient } from "../../src/testing/index.js";
import { harness, addBoardB, notices, type Harness } from "../dispatch/harness.js";
import { boardCard, silentLog, deferred } from "../dispatch/fixtures.js";

const makePoller = (h: Harness, boards: BoardClients) =>
  new Poller({ store: h.store, boards, dispatcher: h.dispatcher, rooms: new DispatchRooms({ store: h.store, opener: h.opener, config: h.config }), config: h.config, clock: h.clock, log: silentLog });

describe("Poller", () => {
  it("emits only undecided card versions and records the listing's start", async () => {
    const h = await harness();
    const fake = new FakeBoardClient("trello");
    fake.setQueue("board-a", [boardCard(1), boardCard(2)]);
    const poller = makePoller(h, { trello: fake });
    expect(poller.periodic()).toMatchObject({ name: "poller", everyMs: 120_000 });
    expect(await poller.pollNow("board-a")).toEqual({ boardId: "board-a", ok: true, listed: 2, emitted: 2, error: null });
    expect((await h.store.boards.get("board-a"))?.lastPolledAt).toBe(h.clock.now().toISOString());
    h.clock.advance(120_000);
    expect((await poller.pollNow("board-a")).emitted).toBe(0);
    fake.setQueue("board-a", [boardCard(1), boardCard(2, { version: "2026-10-25T08:30:00.000Z" })]);
    expect((await poller.pollNow("board-a")).emitted).toBe(1);
  });

  it("REVIEW FOCUS 4: a failing board stops only its own poll, keeps lastPolledAt, and reports once per streak", async () => {
    const h = await harness();
    await addBoardB(h);
    const fake = new FakeBoardClient("trello");
    fake.setQueue("board-a", [boardCard(1)]);
    fake.setQueue("board-b", [boardCard(3, { ref: { boardId: "board-b", cardId: "card-3" } })]);
    const poller = makePoller(h, { trello: fake });
    for (let i = 0; i < 3; i++) {
      fake.failNext(new BoardApiError("rate_limited", "board API returned 429"), "board-a");
      expect((await poller.pollAll()).map((r) => [r.boardId, r.ok])).toEqual([["board-a", false], ["board-b", true]]);
      h.clock.advance(120_000);
    }
    expect((await h.store.boards.get("board-a"))?.lastPolledAt).toBeNull();
    expect((await h.store.boards.get("board-b"))?.lastPolledAt).not.toBeNull();
    await poller.pollAll();
    const board = await h.posts("board", "board-a");
    expect(notices(board).filter((n) => n.startsWith("poll_"))).toEqual(["poll_failed", "poll_recovered"]);
    expect(board.map((m) => m.body)).toEqual(expect.arrayContaining(["Polling board-a failed (rate_limited): board API returned 429. Retrying every 120 s.", "Polling board-a recovered after 3 failed polls."]));
  });

  it("says once that a board's kind has no credentials", async () => {
    const h = await harness();
    const poller = makePoller(h, {});
    expect(await poller.pollNow("board-a")).toMatchObject({ ok: false, error: "no_credentials" });
    await poller.pollNow("board-a");
    expect(notices(await h.posts("board", "board-a"))).toEqual(["poll_failed"]);
  });

  it("never overlaps two polls of one board", async () => {
    const h = await harness();
    const fake = new FakeBoardClient("trello");
    const gate = deferred();
    let inFlight = 0, most = 0;
    fake.listQueue = async () => { inFlight++; most = Math.max(most, inFlight); await gate.promise; inFlight--; return []; };
    const poller = makePoller(h, { trello: fake });
    const both = Promise.all([poller.pollNow("board-a"), poller.pollNow("board-a")]);
    gate.resolve();
    await both;
    expect(most).toBe(1);
  });

  it("REVIEW FOCUS 2 end to end: a webhook delivery and a poll of one new card make one decision and one instance", async () => {
    const h = await harness({ registration: { minCards: 1 } });
    const fake = new FakeBoardClient("trello");
    fake.setQueue("board-a", [boardCard(1)]);
    const deps = { store: h.store, boards: { trello: fake }, config: h.config, decide: (e: Parameters<typeof h.dispatcher.decideCard>[0]) => h.dispatcher.decideCard(e), counters: new WebhookCounters(), log: silentLog };
    fake.onEmit((ref) => ingestRefs(deps, fake, [ref]));
    await Promise.all([fake.emit(boardCard(1).ref), makePoller(h, { trello: fake }).pollNow("board-a")]);
    expect(await h.store.decisions.find({ cardId: "card-1" })).toHaveLength(1);
    expect(h.launcher.started).toHaveLength(1);
  });
});
```

```ts
// packages/os/tests/ingress/webhooks.test.ts
import { describe, it, expect } from "vitest";
import { webhookRoutes, WebhookCounters, type WebhookDeps } from "../../src/ingress/webhooks.js";
import { TrelloApiClient, TRELLO_CARD_FIELDS, trelloCallbackUrl, trelloSignature } from "../../src/ingress/trello-api.js";
import { GitHubApiClient, githubSignature } from "../../src/ingress/github-api.js";
import type { CardEvent } from "../../src/dispatch/dispatcher.js";
import type { ApiCall } from "../../src/dispatch/host.js";
import { FetchStub, MemoryOsStore } from "../../src/testing/index.js";
import { boardRow, testConfig, silentLog } from "../dispatch/fixtures.js";

const GH_BOARD = boardRow({ id: "board-g", kind: "github", externalId: "owner-a/repo-a", name: "repo-a", queueColumn: "swarm:goal", webhookSecret: "hook-secret-a" });
const trelloJson = { id: "5f00000000000000000000c1", shortLink: "abc123", name: "Add search", desc: "", idBoard: "5f00000000000000000000aa", idList: "list-2", labels: [], closed: false, dateLastActivity: "2026-10-25T08:00:00.000Z", url: "https://trello.com/c/abc123", checklists: [], list: { id: "list-2", name: "To Do" } };
const RAW = '{\n  "action": { "type": "updateCard", "data": { "card": { "id": "5f00000000000000000000c1" } } }\n}';
const SIG = trelloSignature("app-secret-a", RAW, trelloCallbackUrl("https://os.example", "board-a"));

async function setup(stub = new FetchStub()) {
  const store = new MemoryOsStore();
  await store.boards.put(boardRow());
  await store.boards.put(GH_BOARD);
  const decided: CardEvent[] = [];
  const warned: string[] = [];
  const deps: WebhookDeps = {
    store, config: testConfig(), counters: new WebhookCounters(), decide: async (e) => { decided.push(e); },
    boards: { trello: new TrelloApiClient({ key: "key-a", token: "token-a", boards: store.boards, fetch: stub.fetch }), github: new GitHubApiClient({ token: "ghp_test_a", boards: store.boards, fetch: stub.fetch }) },
    log: { ...silentLog, warn: (m: string) => { warned.push(m); } },
  };
  const route = (method: string, path: string) => webhookRoutes(deps).find((r) => r.method === method && r.path === path)!;
  const call = (over: Partial<ApiCall>): ApiCall => ({ params: {}, query: {}, headers: {}, body: undefined, rawBody: "", actor: null, ...over });
  return { deps, decided, warned, route, call };
}

describe("webhook routes", () => {
  it("accept a Trello delivery signed over the raw body and decide the card under its canonical id", async () => {
    const stub = new FetchStub().on("GET", `https://api.trello.com/1/cards/5f00000000000000000000c1?fields=${TRELLO_CARD_FIELDS}&list=true&checklists=all`, { json: trelloJson });
    const { deps, decided, route, call } = await setup(stub);
    const reply = await route("POST", "/hooks/trello/:boardId").handler(call({ params: { boardId: "board-a" }, headers: { "x-trello-webhook": SIG }, rawBody: RAW }));
    expect(reply).toMatchObject({ status: 200, body: { ok: true, cards: 1 } });
    await reply.work;
    expect(decided.map((e) => [e.source, e.ref.cardId, e.version])).toEqual([["webhook", "abc123", "2026-10-25T08:00:00.000Z"]]);
    const flat = JSON.stringify(JSON.parse(RAW));                     // the same JSON re-serialised no longer matches the signature
    expect((await route("POST", "/hooks/trello/:boardId").handler(call({ params: { boardId: "board-a" }, headers: { "x-trello-webhook": SIG }, rawBody: flat }))).status).toBe(401);
    expect(deps.counters.counters()).toEqual({ webhooksAccepted: 1, webhooksRejected: 1, webhooksUnknownBoard: 0 });
  });

  it("refuse unsigned and malformed calls, count them and never log their bodies; 404 unknown boards; answer Trello's HEAD", async () => {
    const { deps, decided, warned, route, call } = await setup();
    const post = route("POST", "/hooks/trello/:boardId");
    expect(await post.handler(call({ params: { boardId: "board-a" }, rawBody: RAW }))).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    expect(warned.join(" ")).not.toContain("updateCard");
    const junk = "not json";
    const junkSig = trelloSignature("app-secret-a", junk, trelloCallbackUrl("https://os.example", "board-a"));
    expect((await post.handler(call({ params: { boardId: "board-a" }, headers: { "x-trello-webhook": junkSig }, rawBody: junk }))).status).toBe(400);
    expect((await post.handler(call({ params: { boardId: "board-z" }, rawBody: RAW }))).status).toBe(404);
    expect(deps.counters.counters()).toEqual({ webhooksAccepted: 0, webhooksRejected: 2, webhooksUnknownBoard: 1 });
    expect((await route("HEAD", "/hooks/trello/:boardId").handler(call({ params: { boardId: "board-a" } }))).status).toBe(200);
    expect((await route("HEAD", "/hooks/trello/:boardId").handler(call({ params: { boardId: "board-g" } }))).status).toBe(404);
    expect(decided).toEqual([]);
    expect(webhookRoutes(deps).every((r) => r.auth === "none" && r.rawBody === true)).toBe(true);
  });

  it("decide GitHub issue events and ignore pings and pull-request comments", async () => {
    const issue = { number: 7, title: "Issue 7", body: "", state: "open", labels: [{ name: "swarm:goal" }], updated_at: "2026-10-25T08:00:07Z", html_url: "https://github.com/owner-a/repo-a/issues/7" };
    const stub = new FetchStub().on("GET", "https://api.github.com/repos/owner-a/repo-a/issues/7", { json: issue });
    const { decided, route, call } = await setup(stub);
    const post = async (payload: unknown) => {
      const raw = JSON.stringify(payload);
      const reply = await route("POST", "/hooks/github/:owner/:repo").handler(call({ params: { owner: "owner-a", repo: "repo-a" }, headers: { "x-hub-signature-256": githubSignature("hook-secret-a", raw) }, rawBody: raw }));
      await reply.work;
      return reply.status;
    };
    expect([await post({ action: "labeled", issue: { number: 7 } }), await post({ zen: "Keep it simple.", hook_id: 1 }), await post({ action: "created", issue: { number: 8, pull_request: {} } })]).toEqual([200, 200, 200]);
    expect(decided.map((e) => e.ref)).toEqual([{ boardId: "board-g", cardId: "7" }]);
  });

  it("finish quietly when the board API fails after the reply", async () => {
    const stub = new FetchStub().on("GET", /\/cards\/5f00000000000000000000c1\?/, { status: 500 });
    const { decided, warned, route, call } = await setup(stub);
    const reply = await route("POST", "/hooks/trello/:boardId").handler(call({ params: { boardId: "board-a" }, headers: { "x-trello-webhook": SIG }, rawBody: RAW }));
    await expect(reply.work).resolves.toBeUndefined();
    expect([decided, warned.length]).toEqual([[], 1]);
  });
});
```

`Harness` is exported as a type from `harness.ts` (Task 6).

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/os && npx vitest run tests/ingress/poller.test.ts tests/ingress/webhooks.test.ts`
Expected: FAIL — cannot load `../../src/ingress/poller.js` and `../../src/ingress/webhooks.js`.

- [ ] **Step 3: Implement `Poller` and the webhook routes** to the steps and rules above.

- [ ] **Step 4: Run the tests and the package gate**

Run: `cd packages/os && npx vitest run tests/ingress/poller.test.ts tests/ingress/webhooks.test.ts`
Expected: PASS (9 tests); then the package gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/ingress/poller.ts packages/os/src/ingress/webhooks.ts packages/os/tests/ingress/poller.test.ts packages/os/tests/ingress/webhooks.test.ts
git commit -m "feat(os): board poller and verified Trello and GitHub webhooks"
```

---

### Task 14: Instance routes, the module, and its place in the brain

**Files:**
- Create: `packages/os/src/dispatch/instance-routes.ts`, `packages/os/src/dispatch/mount.ts`, `packages/os/src/dispatch/brain-module.ts`
- Modify: `packages/os/src/index.ts` (append a `// plan 04` export block)
- Test: `packages/os/tests/dispatch/instance-routes.test.ts`, `packages/os/tests/dispatch/mount.test.ts`

**Interfaces:**
- Consumes: everything above; plan 01's wire types; `EventPublisher`, `Actor`, and plan 03's `registerBrainModule`, `BrainServices`, periodic slots, `server.route`, `requireAuth`, `Tokens` and `Lockdown`; plan 05's `registerCommand` and `Participants.ensureParticipant` when merged.
- Produces:

```ts
// packages/os/src/dispatch/instance-routes.ts
export type InstanceView = InstanceRow & { projectName: string | null };
export function toInstanceView(row: InstanceRow, projectName: string | null): InstanceView;   // tokenHash ""
export interface InstanceRouteDeps {
  store: OsStore; dispatcher: Dispatcher; opener: RoomOpener; tokens: Pick<InstanceTokens, "mintRoomToken">; clock: Clock; log: Logger;
  ensureParticipant?: (role: SessionRole, sessionId: string, instanceId: string) => Promise<ParticipantRow>;   // plan 05's Participants.ensureParticipant once merged
}
export const EVENT_BATCH_LIMIT: number;                                   // 2 × OS_EVENT_BATCH_MAX: headroom for the run's synthetic os:events_dropped event
export function ensureSessionParticipant(store: OsStore, clock: Clock, role: SessionRole, sessionId: string, instanceId: string): Promise<ParticipantRow>;   // { kind: role, name: sessionId, instanceId, permissionsJson: "[]" }, reused per (instanceId, name)
export function postInstanceEvents(deps: Pick<InstanceRouteDeps, "store" | "opener">, instanceId: string, events: ForwardedEvent[]): Promise<number>;
export function instanceRoutes(deps: InstanceRouteDeps): RouteSpec[];

// packages/os/src/dispatch/mount.ts
export interface BrainHost {
  hub: EventPublisher;                                                    // plan 03's EventHub
  tokens: InstanceTokens;                                                 // plan 03's Tokens
  route(spec: RouteSpec): void;                                           // plan 03's server.route with requireAuth(...spec.auth) unless "none", handing over the raw body when spec.rawBody
  addPeriodic(task: PeriodicTask): void;                                  // plan 03's periodic registration
  dispatchGates?: DispatchGate[];                                         // [async () => (lockdown.active() ? "lockdown is on" : null)]
  registerCommand?: (spec: DispatchCommandSpec<any>) => void;             // plan 05's registerCommand, once merged
  ensureParticipant?: InstanceRouteDeps["ensureParticipant"];             // plan 05's, once merged
}
export interface MountDeps { store: OsStore; config: OsConfig; rooms: RoomOpener; clock: Clock; log: Logger; launcher?: Launcher; swarmCommand?: string[]; osHome?: string; boards?: BoardClients; fetch?: FetchLike }
export interface DispatchModule {
  dispatcher: Dispatcher; readiness: ReadinessSlot; launcher: Launcher; boards: BoardClients; poller: Poller; runs: RunControl; resources: ResourceMonitor;
  commands: DispatchCommandSpec<any>[]; ingress: { counters(): IngressCounters };   // ingress.counters() feeds plan 09's GET /health
  start(): Promise<void>;                                                 // after plan 03's reconcile: runs.republishPending()
}
export function createBoardClients(config: OsConfig, store: OsStore, fetch?: FetchLike): BoardClients;   // a TrelloApiClient when boards.trello is set, a GitHubApiClient when boards.github is
export function mountDispatch(host: BrainHost, deps: MountDeps): DispatchModule;

// packages/os/src/dispatch/brain-module.ts
export const dispatchBrainModule: BrainModule;                            // plan 03's BrainModule; registered with registerBrainModule on import
```

The instance routes are bearer-only (`inst_` tokens, which the overview exempts from `X-Swarm-Os`): `403 forbidden` whenever `actor.instanceId !== params.id`; `404 not_found` for an unknown instance; `409 conflict` for an ended one, except `exit`; `400 bad_request` with the zod issues joined; a store error is `503 store_unavailable`. Their zod schemas are declared with `satisfies z.ZodType<…>` against plan 01's types, so a change on either side breaks the build. Plan 01's synthetic `os:events_dropped` is posted like any other event.

| route | auth | body | 200 reply |
|---|---|---|---|
| `GET /api/instances` | human, cos, host | query `live=1` keeps only live rows | `{ instances: InstanceView[] }`, newest `startedAt` first, at most 100, with each registration's `projectName` read at request time |
| `GET /api/instances/:id` | human, cos, host | | `{ instance: InstanceView, decision }` (the decision whose `instanceId` is this one, or null) |
| `POST /api/instances/:id/attach` | instance | `AttachBody` | `AttachResponse { roomId, participantId, roomToken }`: the instance's own participant and `tokens.mintRoomToken(id, participantId, roomId)`, so the run can post as itself |
| `POST /api/instances/:id/heartbeat` | instance | `HeartbeatBody` (`phase` one of `InstancePhase`) | `{ ok: true }` |
| `POST /api/instances/:id/events` | instance | `EventsBody`, at most `EVENT_BATCH_LIMIT` events | `{ ok: true, accepted }`; each event is posted to the instance room as a `kind: "event"` message from the instance participant, with `body` the event name, `data { event, payload, at }` and `provenance { source: "instance", instanceId }`; plan 05's `post` publishes it as a `message` event |
| `POST /api/instances/:id/exit` | instance | `ExitBody` (`reason` one of `RunExitReason`) | `{ ok: true, state }`, the state after the exit, also for a repeated report |
| `POST /api/instances/:id/sessions` | instance | `SessionRequest` | `SessionResponse { participantId, roomToken }`: `(deps.ensureParticipant ?? ensureSessionParticipant)(role, sessionId, id)`, added to the instance room's members when absent, and `tokens.mintRoomToken(id, participantId, roomId)` |

`mountDispatch(host, deps)`, in order:
1. `boards = deps.boards ?? createBoardClients(config, store, deps.fetch)`; `launcher = deps.launcher ?? new LocalLauncher({ command: deps.swarmCommand, osHome: deps.osHome, usage: storeUsage(store, clock) })`, throwing when neither a launcher nor both `swarmCommand` and `osHome` are given.
2. `readiness = new ReadinessSlot()`; `dispatcher = new Dispatcher({ store, launcher, config, messaging: deps.rooms, readiness, clock, log, tokens: host.tokens })`; add each of `host.dispatchGates`.
3. Build `DispatchRooms`, `Poller`, `RunControl` and `ResourceMonitor` (both with `host.hub`), and `WebhookCounters`.
4. `dispatcher.onChange`: publish `instance { instance: toInstanceView(row, <its registration's projectName>) }` or `decision { decision }` to `staffOnly`; when an instance change carries an ended state, `poller.pollNow(boardId)` (errors logged), so the freed slot is re-evaluated against a fresh listing.
5. For a `LocalLauncher`, `launcher.onChildExit((h, code) => dispatcher.onExit(h.instanceId, { reason: "process_exit", code: code ?? -1 }))`, logging errors; when the run reported its own exit first, this is a no-op.
6. `host.route` each of `instanceRoutes(...)`, `webhookRoutes(...)` (with `decide: (e) => dispatcher.decideCard(e)`) and `resources.route()`.
7. `host.addPeriodic` for `poller.periodic()`, `resources.periodic()` and `{ name: "sweep", everyMs: SWEEP_EVERY_MS, run: () => dispatcher.sweep() }`.
8. `commands = dispatchCommands({ boards, runs, refresh: (id) => poller.pollNow(id) })`, and `host.registerCommand?.(spec)` for each.
9. Return the module. Its `start()` runs `runs.republishPending()`. Plan 06 calls `module.readiness.fill(chiefOfStaff)` and narrates from `module.dispatcher.onDecision`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/os/tests/dispatch/instance-routes.test.ts
import { describe, it, expect } from "vitest";
import { instanceRoutes, EVENT_BATCH_LIMIT, type InstanceRouteDeps } from "../../src/dispatch/instance-routes.js";
import type { ApiCall } from "../../src/dispatch/host.js";
import { harness, ev } from "./harness.js";
import { OWNER, boardCard, silentLog } from "./fixtures.js";

async function setup() {
  const h = await harness({ registration: { minCards: 1 } });
  await h.dispatcher.decideCard(ev(boardCard(1)));
  const [row] = await h.store.instances.find({ cardId: "card-1" });
  const deps: InstanceRouteDeps = { store: h.store, dispatcher: h.dispatcher, opener: h.opener, tokens: h.tokens, clock: h.clock, log: silentLog };
  const routes = instanceRoutes(deps);
  const send = (method: string, path: string, over: Partial<ApiCall>) => routes.find((r) => r.method === method && r.path === path)!.handler({ params: { id: row.id }, query: {}, headers: {}, body: undefined, rawBody: "", actor: { kind: "instance", instanceId: row.id }, ...over });
  return { h, row, routes, send };
}

describe("instance routes", () => {
  it("are bearer routes for the instance itself, or reads for staff", async () => {
    const { routes } = await setup();
    expect(routes.map((r) => `${r.method} ${r.path} ${r.auth === "none" ? "none" : r.auth.join("|")}`)).toEqual([
      "GET /api/instances human|cos|host", "GET /api/instances/:id human|cos|host", "POST /api/instances/:id/attach instance", "POST /api/instances/:id/heartbeat instance",
      "POST /api/instances/:id/events instance", "POST /api/instances/:id/exit instance", "POST /api/instances/:id/sessions instance"]);
  });

  it("attach only for the instance the token belongs to, answering with its room and its own room token", async () => {
    const { h, send, row } = await setup();
    const [self] = await h.store.participants.find({ instanceId: row.id });
    const body = { runId: "run-1", dashboardUrl: "http://127.0.0.1:3141", pid: 4242 };
    expect(await send("POST", "/api/instances/:id/attach", { actor: { kind: "instance", instanceId: "inst-other" }, body })).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(await send("POST", "/api/instances/:id/attach", { body })).toEqual({ status: 200, body: { roomId: row.roomId, participantId: self.id, roomToken: `room_${self.id}` } });
    expect(await send("POST", "/api/instances/:id/heartbeat", { body: { tokens: -1, phase: "working", currentTask: null } })).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    expect(await send("POST", "/api/instances/:id/exit", { body: { reason: "completed", code: 0 } })).toEqual({ status: 200, body: { ok: true, state: "exited" } });
    expect(await send("POST", "/api/instances/:id/heartbeat", { body: { tokens: 1, phase: "working", currentTask: null } })).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    expect(await send("POST", "/api/instances/:id/exit", { body: { reason: "failed", code: 1 } })).toEqual({ status: 200, body: { ok: true, state: "exited" } });
  });

  it("post forwarded events into the instance room as event messages from the instance", async () => {
    const { h, send, row } = await setup();
    const events = [{ event: "task:started", payload: { taskId: "t1", title: "Add index" }, at: "2026-10-25T09:00:01.000Z" }, { event: "os:events_dropped", payload: { count: 12 }, at: "2026-10-25T09:00:02.000Z" }];
    expect(await send("POST", "/api/instances/:id/events", { body: { events } })).toEqual({ status: 200, body: { ok: true, accepted: 2 } });
    const posted = (await h.store.messages.find({ roomId: row.roomId })).filter((m) => m.kind === "event");
    expect(posted.map((m) => [m.fromKind, m.body])).toEqual([["instance", "task:started"], ["instance", "os:events_dropped"]]);
    expect(JSON.parse(posted[0].provenanceJson)).toEqual({ source: "instance", instanceId: row.id });
    expect(JSON.parse(posted[0].dataJson!)).toEqual(events[0]);
    const many = Array.from({ length: EVENT_BATCH_LIMIT + 1 }, (_, i) => ({ event: "tick", payload: i, at: events[0].at }));
    expect((await send("POST", "/api/instances/:id/events", { body: { events: many } })).status).toBe(400);
  });

  it("make one participant per session, named by its session id, and add it to the instance room", async () => {
    const { h, send, row } = await setup();
    const a = await send("POST", "/api/instances/:id/sessions", { body: { role: "worker", sessionId: "sess-w1" } });
    const { participantId, roomToken } = a.body as { participantId: string; roomToken: string };
    expect(roomToken).toBe(`room_${participantId}`);
    expect(await h.store.participants.get(participantId)).toMatchObject({ kind: "worker", name: "sess-w1", instanceId: row.id, permissionsJson: "[]" });
    expect(JSON.parse((await h.store.rooms.get(row.roomId))!.membersJson)).toContain(participantId);
    const b = await send("POST", "/api/instances/:id/sessions", { body: { role: "worker", sessionId: "sess-w1" } });
    expect((b.body as { participantId: string }).participantId).toBe(participantId);
  });

  it("list instances for staff with their project and without their token hashes", async () => {
    const { send, row } = await setup();
    const list = await send("GET", "/api/instances", { actor: OWNER, params: {}, query: { live: "1" } });
    expect((list.body as { instances: unknown[] }).instances).toEqual([expect.objectContaining({ id: row.id, tokenHash: "", projectName: "project-a" })]);
    expect(await send("GET", "/api/instances/:id", { actor: OWNER })).toMatchObject({ status: 200, body: { instance: { id: row.id, tokenHash: "", projectName: "project-a" }, decision: { instanceId: row.id } } });
    expect((await send("GET", "/api/instances/:id", { actor: OWNER, params: { id: "inst-none" } })).status).toBe(404);
  });
});
```

```ts
// packages/os/tests/dispatch/mount.test.ts
import { describe, it, expect } from "vitest";
import { mountDispatch, type BrainHost } from "../../src/dispatch/mount.js";
import type { PeriodicTask, RouteSpec } from "../../src/dispatch/host.js";
import { FakeBoardClient, FakeEventHub, FakeLauncher, FakeRoomOpener, MemoryOsStore, FakeClock } from "../../src/testing/index.js";
import { FakeTokens } from "./harness.js";
import { T0, OWNER, boardCard, boardRow, instanceRow, registrationRow, testConfig, silentLog } from "./fixtures.js";

async function mount(seed: (store: MemoryOsStore) => Promise<void> = async () => {}) {
  const store = new MemoryOsStore();
  const clock = new FakeClock(T0);
  await store.boards.put(boardRow());
  await store.registrations.put(registrationRow({ minCards: 1 }));
  await seed(store);
  const fake = new FakeBoardClient("trello");
  fake.setQueue("board-a", [boardCard(1)]);
  const hub = new FakeEventHub();
  const routes: RouteSpec[] = [], periodics: PeriodicTask[] = [], commands: unknown[] = [];
  const host: BrainHost = { hub, tokens: new FakeTokens(store), route: (r) => routes.push(r), addPeriodic: (p) => periodics.push(p), registerCommand: (c) => commands.push(c), dispatchGates: [] };
  const mod = mountDispatch(host, { store, config: testConfig(), rooms: new FakeRoomOpener(store, clock), clock, log: silentLog, launcher: new FakeLauncher(), boards: { trello: fake } });
  return { store, hub, routes, periodics, commands, mod, fake };
}

describe("mountDispatch", () => {
  it("registers every route, periodic and command", async () => {
    const { routes, periodics, commands, mod } = await mount();
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/instances", "GET /api/instances/:id", "POST /api/instances/:id/attach", "POST /api/instances/:id/heartbeat", "POST /api/instances/:id/events",
      "POST /api/instances/:id/exit", "POST /api/instances/:id/sessions", "POST /hooks/trello/:boardId", "HEAD /hooks/trello/:boardId", "POST /hooks/github/:owner/:repo", "GET /api/resources"]);
    expect(periodics.map((p) => [p.name, p.everyMs])).toEqual([["poller", 120_000], ["resources", 15_000], ["sweep", 30_000]]);
    expect([commands.length, mod.commands.length]).toEqual([9, 9]);
    expect(mod.ingress.counters()).toEqual({ webhooksAccepted: 0, webhooksRejected: 0, webhooksUnknownBoard: 0 });
  });

  it("publishes instance and decision events to staff without token hashes, and re-polls a board when its run ends", async () => {
    const { hub, mod, fake, store } = await mount();
    await mod.poller.pollNow("board-a");
    expect(hub.published.map((e) => e.type)).toEqual(expect.arrayContaining(["instance", "decision"]));
    for (const e of hub.published) expect([e.visibleTo(OWNER), e.visibleTo({ kind: "instance", instanceId: "inst-x" })]).toEqual([true, false]);
    const views = hub.published.filter((e) => e.type === "instance").map((e) => (e.payload as { instance: { tokenHash: string; projectName: string | null } }).instance);
    expect(views.every((v) => v.tokenHash === "" && v.projectName === "project-a")).toBe(true);
    const [row] = await store.instances.find({ cardId: "card-1" });
    const listings = () => fake.calls.filter((c) => c === "listQueue:board-a").length;
    expect(listings()).toBe(1);
    await mod.dispatcher.onExit(row.id, { reason: "completed", code: 0 });
    await new Promise((r) => setImmediate(r));
    expect(listings()).toBe(2);
  });

  it("publishes pending requests again when started", async () => {
    const { hub, mod } = await mount(async (s) => {
      await s.instances.put(instanceRow({ id: "inst-paused", cardId: "card-9", state: "running", runId: "run-9", exitReason: "pause_requested" }));
    });
    await mod.start();
    expect(hub.published.filter((e) => e.type === "command" && e.visibleTo({ kind: "instance", instanceId: "inst-paused" })).map((e) => (e.payload as { argv: string[] }).argv)).toEqual([["pause"]]);
  });

  it("exports the plan 04 surface from the package index", async () => {
    const os = await import("../../src/index.js");
    for (const name of ["Dispatcher", "DispatchRefusedError", "StaticReadiness", "ReadinessSlot", "LocalLauncher", "TrelloApiClient", "GitHubApiClient", "Poller", "WebhookCounters", "ResourceMonitor", "RunControl", "mountDispatch", "createBoardClients", "dispatchCommands", "publishInstanceCommand", "toInstanceView"]) {
      expect(os).toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/os && npx vitest run tests/dispatch/instance-routes.test.ts tests/dispatch/mount.test.ts`
Expected: FAIL — cannot load `../../src/dispatch/instance-routes.js` and `../../src/dispatch/mount.js`.

- [ ] **Step 3: Implement `instance-routes.ts` and `mount.ts`, and append the exports**

Implement both files to the table and the order above. Append to `packages/os/src/index.ts`, under `// plan 04`: `BoardApiError`, `TrelloApiClient`, `trelloCallbackUrl`, `GitHubApiClient`, `Poller`, `WebhookCounters`, `Dispatcher`, `DispatchRefusedError`, `StaticReadiness`, `ReadinessSlot`, `RunControl`, `dispatchCommands`, `publishInstanceCommand`, `staffOnly`, `instanceOnly`, `LocalLauncher`, `ResourceMonitor`, `storeUsage`, `mountDispatch`, `createBoardClients`, `toInstanceView`, and the types `BoardCard`, `BoardClient`, `BoardClients`, `CardEvent`, `CheckName`, `CheckResult`, `Readiness`, `DecisionInfo`, `InstanceTokens`, `Launcher`, `LauncherHandle`, `InstanceSpec`, `ResourceSnapshot`, `InstanceView`, `BrainHost`, `DispatchModule`, `IngressCounters`, `DispatchCommandSpec`. Leave out the names plans 02, 03 and 05 export (`CardRef`, `cardKey`, `LIVE_STATES`, `Rooms`) and the private helpers (`DispatchRooms`, `RouteSpec`, `ACTIVE_STATES`).

- [ ] **Step 4: Put the module into plan 03's brain**

Write `packages/os/src/dispatch/brain-module.ts` against plan 03's merged `brain/context.ts` and `brain/modules.ts`: `dispatchBrainModule` is a `BrainModule` registered with `registerBrainModule` on import. When the brain builds its context, the module calls `mountDispatch(host, deps)` with a `BrainHost` that maps `hub` to the brain's `EventHub`; `tokens` to its `Tokens`; `route` to `server.route` plus `requireAuth(...spec.auth)` (raw body when `spec.rawBody`); `addPeriodic` to the `sweep` and `resources` slots of those names, with `poller` registered as a further periodic (if plan 03's periodics are fixed slots only, the module runs the poller on its own unref'd interval); `dispatchGates` to `[async () => (lockdown.active() ? "lockdown is on" : null)]`; and `registerCommand` and `ensureParticipant` to plan 05's once merged. `swarmCommand` is the CLI's `swarmSelfCommand()` and `osHome` the brain's `os_home`. Put `module.dispatcher` and `module.launcher` into `BrainServices` before plan 03's reconcile runs, since its reconcile and `/health` read them; call `module.start()` after reconcile; hand `module.ingress.counters()` to `/health` (plan 09). Add `tests/dispatch/brain-module.test.ts`: importing the file makes `brainModules()` include `dispatchBrainModule`, and building plan 03's test context with it registers the eleven routes and the three periodics. This step edits no file plan 03 owns; if plan 03's module API differs from this description, adapt `brain-module.ts` only and name the difference in the commit message.

- [ ] **Step 5: Run the tests, the package gate and the workspace build**

Run: `cd packages/os && npx vitest run tests/dispatch/instance-routes.test.ts tests/dispatch/mount.test.ts tests/dispatch/brain-module.test.ts`
Expected: PASS (11 tests, plus `brain-module.test.ts`'s). Then the package gate, `pnpm -w build` (exit 0), and `cd packages/cli && npx vitest run` (the CLI suite stays green).

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/dispatch/instance-routes.ts packages/os/src/dispatch/mount.ts packages/os/src/dispatch/brain-module.ts packages/os/src/index.ts packages/os/tests/dispatch/instance-routes.test.ts packages/os/tests/dispatch/mount.test.ts packages/os/tests/dispatch/brain-module.test.ts
git commit -m "feat(os): instance routes and the dispatch module in the brain"
```

---

### Task 15: Metrics

Ingress and dispatch's share of the owner's metrics requirement: every board API call and rate-limit hit, every poll and webhook, the three latencies the first proof is about (card seen to decision, to dispatch, and to its instance attaching; seen is the first poll or webhook that reported that card version), every decision and policy check, the serialisation queues, the launcher, the instance lifecycle, the resource snapshot as gauges, and `POST /api/instances/:id/metrics`, which keeps each instance's latest forwarded snapshot for plan 03's `GET /api/metrics`.

**Files:**
- Create: `packages/os/src/dispatch/card-seen.ts`, `packages/os/src/dispatch/instance-metrics.ts`
- Modify: `packages/metrics/src/catalogue/os.ts` (this plan's block, in the `// plan 04` slot of `OS_METRICS`)
- Modify: `packages/os/src/ingress/board-client.ts`, `packages/os/src/ingress/trello-api.ts`, `packages/os/src/ingress/github-api.ts`, `packages/os/src/ingress/poller.ts`, `packages/os/src/ingress/webhooks.ts`
- Modify: `packages/os/src/dispatch/queue.ts`, `packages/os/src/dispatch/checks.ts`, `packages/os/src/dispatch/dispatcher.ts`, `packages/os/src/dispatch/instances.ts`, `packages/os/src/dispatch/instance-routes.ts`, `packages/os/src/dispatch/mount.ts`, `packages/os/src/dispatch/brain-module.ts`
- Modify: `packages/os/src/launcher/launcher.ts`, `packages/os/src/launcher/local.ts`, `packages/os/src/resources/resources.ts`
- Modify: `packages/os/src/testing/fetch-stub.ts` (`StubReply.headers`), `packages/os/src/index.ts` (the `// plan 04` block)
- Modify: `packages/os/tests/dispatch/harness.ts` (a `metrics` option), `packages/os/tests/dispatch/instance-routes.test.ts`, `packages/os/tests/dispatch/mount.test.ts`, `packages/os/tests/dispatch/brain-module.test.ts` (each route list gains `POST /api/instances/:id/metrics`, after `sessions`; eleven routes become twelve)
- Test: `packages/os/tests/metrics/ingress-metrics.test.ts`, `packages/os/tests/metrics/dispatch-metrics.test.ts`, `packages/os/tests/metrics/instance-metrics.test.ts`

**Interfaces:**
- Consumes: `Metrics`, `noopMetrics`, `MetricsSnapshot`, `OS_METRICS` from `@mnmal-ai/swarm-metrics`, `testRegistry` from `@mnmal-ai/swarm-metrics/testing` (plan 10; `packages/os` depends on it since plan 02's Task 11); `hist`, `counter`, `gauge` from `packages/os/tests/metrics/helpers.ts` (plan 02); `MetricsForwardBody` (plan 01, `os-protocol.ts`); from plan 03's `BrainContext`: `metrics` (the brain's registry) and `metricsSink` (its `JsonlMetricsSink`), and `BrainServices.instanceMetrics`, the port plan 03's `GET /api/metrics` reads, which `InstanceMetricsStore` satisfies; Tasks 1 to 14.
- Produces:

```ts
// packages/os/src/ingress/board-client.ts
export type BoardApiOp = "lists" | "list_cards" | "card" | "issues" | "issue";
export interface BoardApiMeter { metrics: Metrics; source: BoardClient["kind"]; op: BoardApiOp }
export function fetchJson<T>(fetch: FetchLike, url: string, init: RequestInit, timeoutMs?: number, meter?: BoardApiMeter): Promise<T>;
export function statusClass(status: number): string;                     // "2xx", "3xx", "4xx", "5xx"
// trello-api.ts, github-api.ts
export interface TrelloApiOptions { /* Task 2's */ metrics?: Metrics }
export interface GitHubApiOptions { /* Task 3's */ metrics?: Metrics }
// poller.ts: deps gain `metrics?: Metrics`; `dispatcher` becomes Pick<Dispatcher, "decideCard" | "noteQueue" | "reevaluateHolds" | "seen">
// webhooks.ts
export interface WebhookDeps { /* Task 13's */ metrics?: Metrics; clock?: Clock; see?: (ref: CardRef, version: string, source: "webhook", at: Date) => void }
export function ingestRefs(deps: WebhookDeps, client: BoardClient, refs: CardRef[], arrived?: Date): Promise<void>;

// packages/os/src/dispatch/queue.ts
export class KeyedQueue { constructor(opts?: { metrics?: Metrics; queue?: "dispatch" | "poller" }); run<T>(key: string, task: () => Promise<T>): Promise<T> }
export function lockKind(key: string): "board" | "limits" | "instance";   // "limits"; "instance:<id>"; anything else is a board id

// packages/os/src/dispatch/card-seen.ts
export type SeenSource = "poll" | "webhook";
export interface Sighting { at: Date; source: SeenSource; decided: boolean }
export class CardSeen {
  constructor(opts: { clock: Clock; maxEntries?: number });              // default 10_000; past it the oldest sighting is forgotten
  see(ref: CardRef, version: string, source: SeenSource, at?: Date): void;   // keeps the first sighting of each (card, version); at defaults to clock.now()
  sighting(ref: CardRef, version: string): Sighting | null;
  firstDecision(ref: CardRef, version: string): Sighting | null;          // the sighting the first time it is asked for that version, then null
  bindInstance(instanceId: string, ref: CardRef, version: string): void;
  takeInstance(instanceId: string): Sighting | null;                      // once per instance
}

// packages/os/src/dispatch/checks.ts
export interface ChainContext { /* Task 5's */ metrics?: Metrics }
export function timedCheck<T extends CheckResult>(metrics: Metrics, name: CheckName, run: () => Promise<T>): Promise<T>;

// packages/os/src/dispatch/dispatcher.ts
// Dispatcher deps gain `metrics?: Metrics`; the class gains `readonly seen: CardSeen`

// packages/os/src/dispatch/instances.ts
export type LifetimeOutcome = "completed" | "nothing_to_do" | "paused" | "stopped" | "login_expired" | "failed" | "gone" | "spawn_failed";
export function lifetimeOutcome(state: InstanceRow["state"], exitReason: string | null): LifetimeOutcome;
// RunControl deps gain `metrics?: Metrics`

// packages/os/src/dispatch/instance-metrics.ts
export const INSTANCE_RECORD_EVERY_MS = 300_000;
export const INSTANCE_ENDED_KEEP_MS = 3_600_000;
export interface InstanceMetricsRecord { r: "instance"; instanceId: string; at: number; snapshot: MetricsSnapshot }
export const MetricsForwardSchema: z.ZodType<MetricsForwardBody<MetricsSnapshot>>;   // at a number; defs, counters, gauges, histograms arrays of the shapes MetricsSnapshot names
export class InstanceMetricsStore {
  constructor(opts: { clock: Clock; write?: (record: InstanceMetricsRecord) => void; metrics?: Metrics; maxEntries?: number });   // maxEntries default 200
  put(instanceId: string, snapshot: MetricsSnapshot): void;              // keeps it as the instance's latest; appends a record when none was appended for it in the last INSTANCE_RECORD_EVERY_MS
  settle(instanceId: string): void;                                       // the instance ended: append its latest unless already appended; forget it INSTANCE_ENDED_KEEP_MS later
  latest(): Record<string, { at: number; snapshot: MetricsSnapshot }>;    // at: epoch ms the brain received it
}

// packages/os/src/dispatch/instance-routes.ts
export interface InstanceRouteDeps { /* Task 14's */ metrics?: Metrics; instanceMetrics?: InstanceMetricsStore }   // a private store when absent
// adds POST /api/instances/:id/metrics, auth ["instance"], body MetricsForwardBody → 200 { ok: true }
export function postInstanceEvents(deps: Pick<InstanceRouteDeps, "store" | "opener" | "metrics">, instanceId: string, events: ForwardedEvent[]): Promise<number>;

// packages/os/src/launcher/launcher.ts
export function meteredLauncher(launcher: Launcher, metrics: Metrics): Launcher;   // same kind, every call timed
// local.ts: LocalLauncherOptions gains `metrics?: Metrics`; resources.ts: ResourceMonitor deps gain `metrics?: Metrics`

// packages/os/src/dispatch/mount.ts
export interface MountDeps { /* Task 14's */ metrics?: Metrics; writeMetricsRecord?: (record: InstanceMetricsRecord) => void }
export interface DispatchModule { /* Task 14's */ instanceMetrics: InstanceMetricsStore }
export function createBoardClients(config: OsConfig, store: OsStore, fetch?: FetchLike, metrics?: Metrics): BoardClients;

// packages/os/tests/dispatch/harness.ts
export function harness(opts?: { registration?: Partial<RegistrationRow>; limits?: Partial<OsConfig["limits"]>; metrics?: Metrics }): Promise<Harness>;   // the Dispatcher (and restart()'s) get the metrics
```

Catalogue rows. Durations taken across the brain's restarts, or measured against card sightings, use the brain's `Clock` (`FakeClock` in tests); every other duration is a span on the registry's monotonic clock. `board` is the registered board's id.

| Name | Kind | Unit | Labels (values) | Recorded in |
|---|---|---|---|---|
| `swarm_os_ingress_board_api_seconds` | histogram | seconds | `source` (`trello`, `github`), `op` (`BoardApiOp`), `outcome` (status class `2xx` to `5xx`, `timeout`, `network`) | `fetchJson`, given the meter `TrelloApiClient` and `GitHubApiClient` pass for each request |
| `swarm_os_ingress_board_rate_limited_total` | counter | count | `source`, `op` | `fetchJson`: a 429, or a 403 whose `x-ratelimit-remaining` is `0` |
| `swarm_os_ingress_poll_seconds` | histogram | seconds | `source` (`trello`, `github`, `unknown`), `outcome` (`ok`, `no_registration`, a `BoardApiErrorCode`, `error`) | `Poller`'s one-board poll, inside its key |
| `swarm_os_ingress_poll_listed_cards` | histogram | count | `source` | the same, cards listed per good poll |
| `swarm_os_ingress_poll_new_cards` | histogram | count | `source` | the same, card versions it handed to `decideCard` |
| `swarm_os_ingress_webhooks_total` | counter | count | `source`, `outcome` (`accepted`, `rejected`, `malformed`, `unknown_board`, `no_credentials`) | the two `POST /hooks/…` handlers, beside `WebhookCounters` |
| `swarm_os_ingress_ingest_seconds` | histogram | seconds | `source`, `outcome` (`ok`, `error`) | `ingestRefs`, the work after the reply |
| `swarm_os_dispatch_card_seen_to_decision_seconds` | histogram | seconds | `source` (`SeenSource`), `outcome` (a decision outcome) | `Dispatcher`, where a version's first decision row is stored (`dispatchLocked` step 2, `decideCard` step 6) |
| `swarm_os_dispatch_card_seen_to_dispatch_seconds` | histogram | seconds | `source`, `by` (`policy`, `command`) | `dispatchLocked`, after `launcher.start` resolves |
| `swarm_os_dispatch_card_seen_to_attach_seconds` | histogram | seconds | `source` | `Dispatcher.onAttach` |
| `swarm_os_dispatch_decisions_total` | counter | count | `outcome`, `check` (the first failing `CheckName`, or `none`), `via` (`card`, `reevaluation`, `command`) | `Dispatcher`'s one private helper that calls the `onDecision` listeners |
| `swarm_os_dispatch_check_seconds` | histogram | seconds | `check` (`CheckName`), `outcome` (`passed`, `failed`, `error`) | `timedCheck`, around each check in `runChain` and the two re-checks in `dispatchLocked` |
| `swarm_os_dispatch_decision_to_start_seconds` | histogram | seconds | `outcome` (`started`, `spawn_failed`) | `dispatchLocked`: from the stored decision to `launcher.start` settling |
| `swarm_os_dispatch_lock_wait_seconds` | histogram | seconds | `queue` (`dispatch`, `poller`), `key` (`board`, `limits`, `instance`), `outcome` (`ok`) | `KeyedQueue.run`: from the call to the task starting |
| `swarm_os_dispatch_lock_tasks` | gauge | count | `queue`, `key` | `KeyedQueue.run`: tasks waiting or running |
| `swarm_os_dispatch_queue_cards` | gauge | count | `board` | `Dispatcher.noteQueue` |
| `swarm_os_dispatch_held_cards` | gauge | count | `board` | `Dispatcher.reevaluateHolds`: held entries left after its re-run |
| `swarm_os_launcher_op_seconds` | histogram | seconds | `launcher` (`local`, `remote`, `fake`), `op` (`start`, `status`, `stop`, `resources`), `outcome` (`ok`, `error`, and `running` or `gone` for `status`) | `meteredLauncher` |
| `swarm_os_launcher_child_exits_total` | counter | count | `outcome` (`ok`, `error`, `signal`) | `LocalLauncher`, on each child's `exit` |
| `swarm_os_launcher_cpu_load`, `swarm_os_launcher_cpus`, `swarm_os_launcher_mem_free_bytes`, `swarm_os_launcher_mem_total_bytes`, `swarm_os_launcher_instances_running`, `swarm_os_launcher_claude_sessions`, `swarm_os_launcher_ports_in_use`, `swarm_os_launcher_last_hour_tokens` | gauge | ratio, count, bytes, bytes, count, count, count, tokens | none | `ResourceMonitor.sample()`: `cpuLoad1`, `cpus`, `memFreeMb` and `memTotalMb` × 1,048,576, `instancesRunning`, `claudeSessions`, `portsInUse.length`, and the sum of `tokensThisHour` |
| `swarm_os_instance_launch_to_attach_seconds` | histogram | seconds | `launcher` | `Dispatcher.onAttach`: now minus the row's `startedAt` |
| `swarm_os_instance_live` | gauge | count | `state` (`dispatching`, `running`, `unresponsive`) | the end of `Dispatcher.sweep()` |
| `swarm_os_instance_lifetime_seconds` | histogram | seconds | `outcome` (`LifetimeOutcome`) | `Dispatcher.onExit`, the sweep's `gone` path, and `dispatchLocked`'s spawn failure: `endedAt` minus `startedAt` |
| `swarm_os_instance_heartbeat_interval_seconds` | histogram | seconds | none | `Dispatcher.onHeartbeat`: now minus the previous `lastHeartbeatAt` |
| `swarm_os_instance_dead_total` | counter | count | `reason` (`unresponsive`, `gone`, `detached`) | `Dispatcher.sweep()`, beside each of those notices |
| `swarm_os_instance_recovered_total` | counter | count | none | `Dispatcher.onHeartbeat`, beside `recovered` |
| `swarm_os_instance_stop_escalations_total` | counter | count | none | `Dispatcher.sweep()` step 3 |
| `swarm_os_instance_control_total` | counter | count | `action` (`pause`, `stop_graceful`, `stop_immediate`, `resume`, `retry`, `republish`), `outcome` (`stream`, `launcher`, `dispatched`, `refused`, `failed`) | `RunControl` |
| `swarm_os_instance_event_batch_seconds` | histogram | seconds | `outcome` (`ok`, `error`) | `postInstanceEvents` |
| `swarm_os_instance_event_batch_events` | histogram | count | none | `postInstanceEvents` |
| `swarm_os_instance_events_dropped_total` | counter | count | none | `postInstanceEvents`: the `count` of each `os:events_dropped` event (plan 01's payload) |
| `swarm_os_instance_sessions_total` | counter | count | `role` (`SessionRole`) | `POST /api/instances/:id/sessions` |
| `swarm_os_instance_metrics_entries` | gauge | count | none | `InstanceMetricsStore`, on every put, settle and prune |

The `MetricDef` entries, appended in the `// plan 04` slot:

```ts
  // plan 04
  { name: "swarm_os_ingress_board_api_seconds", kind: "histogram", unit: "seconds", help: "Board API calls, by source, operation and status class", labels: ["source", "op", "outcome"] },
  { name: "swarm_os_ingress_board_rate_limited_total", kind: "counter", unit: "count", help: "Board API calls refused for rate, by source and operation", labels: ["source", "op"] },
  { name: "swarm_os_ingress_poll_seconds", kind: "histogram", unit: "seconds", help: "One board poll, by source and outcome", labels: ["source", "outcome"] },
  { name: "swarm_os_ingress_poll_listed_cards", kind: "histogram", unit: "count", help: "Cards each good poll listed", labels: ["source"] },
  { name: "swarm_os_ingress_poll_new_cards", kind: "histogram", unit: "count", help: "Card versions each good poll found undecided", labels: ["source"] },
  { name: "swarm_os_ingress_webhooks_total", kind: "counter", unit: "count", help: "Webhook deliveries, by source and outcome", labels: ["source", "outcome"] },
  { name: "swarm_os_ingress_ingest_seconds", kind: "histogram", unit: "seconds", help: "The work after a webhook's reply, by source and outcome", labels: ["source", "outcome"] },
  { name: "swarm_os_dispatch_card_seen_to_decision_seconds", kind: "histogram", unit: "seconds", help: "From a card version's first sighting to its first decision", labels: ["source", "outcome"] },
  { name: "swarm_os_dispatch_card_seen_to_dispatch_seconds", kind: "histogram", unit: "seconds", help: "From a card version's first sighting to launcher.start returning", labels: ["source", "by"] },
  { name: "swarm_os_dispatch_card_seen_to_attach_seconds", kind: "histogram", unit: "seconds", help: "From a card version's first sighting to its instance attaching", labels: ["source"] },
  { name: "swarm_os_dispatch_decisions_total", kind: "counter", unit: "count", help: "Dispatch decisions, by outcome, deciding check and path", labels: ["outcome", "check", "via"] },
  { name: "swarm_os_dispatch_check_seconds", kind: "histogram", unit: "seconds", help: "Each policy check, by check and outcome", labels: ["check", "outcome"] },
  { name: "swarm_os_dispatch_decision_to_start_seconds", kind: "histogram", unit: "seconds", help: "From a dispatch decision to launcher.start settling", labels: ["outcome"] },
  { name: "swarm_os_dispatch_lock_wait_seconds", kind: "histogram", unit: "seconds", help: "Time work waited for its key, by queue and key kind", labels: ["queue", "key", "outcome"] },
  { name: "swarm_os_dispatch_lock_tasks", kind: "gauge", unit: "count", help: "Work waiting for or holding a key, by queue and key kind", labels: ["queue", "key"] },
  { name: "swarm_os_dispatch_queue_cards", kind: "gauge", unit: "count", help: "Cards in a board's queue column at its last listing", labels: ["board"] },
  { name: "swarm_os_dispatch_held_cards", kind: "gauge", unit: "count", help: "Queued cards held by policy at the last re-evaluation", labels: ["board"] },
  { name: "swarm_os_launcher_op_seconds", kind: "histogram", unit: "seconds", help: "Launcher calls, by launcher kind, op and outcome", labels: ["launcher", "op", "outcome"] },
  { name: "swarm_os_launcher_child_exits_total", kind: "counter", unit: "count", help: "Runs the local launcher saw exit, by how", labels: ["outcome"] },
  { name: "swarm_os_launcher_cpu_load", kind: "gauge", unit: "ratio", help: "One-minute load average at the last resource sample", labels: [] },
  { name: "swarm_os_launcher_cpus", kind: "gauge", unit: "count", help: "CPUs at the last resource sample", labels: [] },
  { name: "swarm_os_launcher_mem_free_bytes", kind: "gauge", unit: "bytes", help: "Free memory at the last resource sample", labels: [] },
  { name: "swarm_os_launcher_mem_total_bytes", kind: "gauge", unit: "bytes", help: "Total memory at the last resource sample", labels: [] },
  { name: "swarm_os_launcher_instances_running", kind: "gauge", unit: "count", help: "Live instances at the last resource sample", labels: [] },
  { name: "swarm_os_launcher_claude_sessions", kind: "gauge", unit: "count", help: "Claude Code processes at the last resource sample", labels: [] },
  { name: "swarm_os_launcher_ports_in_use", kind: "gauge", unit: "count", help: "Dashboard ports held by live instances", labels: [] },
  { name: "swarm_os_launcher_last_hour_tokens", kind: "gauge", unit: "tokens", help: "Tokens used by instances in the last hour", labels: [] },
  { name: "swarm_os_instance_launch_to_attach_seconds", kind: "histogram", unit: "seconds", help: "From an instance's start to its run attaching, by launcher kind", labels: ["launcher"] },
  { name: "swarm_os_instance_live", kind: "gauge", unit: "count", help: "Live instances, by state", labels: ["state"] },
  { name: "swarm_os_instance_lifetime_seconds", kind: "histogram", unit: "seconds", help: "From an instance's start to its end, by outcome", labels: ["outcome"] },
  { name: "swarm_os_instance_heartbeat_interval_seconds", kind: "histogram", unit: "seconds", help: "Time between an instance's heartbeats, as received", labels: [] },
  { name: "swarm_os_instance_dead_total", kind: "counter", unit: "count", help: "Instances declared unresponsive, gone or detached", labels: ["reason"] },
  { name: "swarm_os_instance_recovered_total", kind: "counter", unit: "count", help: "Unresponsive instances whose heartbeats resumed", labels: [] },
  { name: "swarm_os_instance_stop_escalations_total", kind: "counter", unit: "count", help: "Immediate stops the sweep signalled through the launcher", labels: [] },
  { name: "swarm_os_instance_control_total", kind: "counter", unit: "count", help: "Run control requests, by action and how they were delivered", labels: ["action", "outcome"] },
  { name: "swarm_os_instance_event_batch_seconds", kind: "histogram", unit: "seconds", help: "Posting one forwarded event batch into its room", labels: ["outcome"] },
  { name: "swarm_os_instance_event_batch_events", kind: "histogram", unit: "count", help: "Events in each forwarded batch", labels: [] },
  { name: "swarm_os_instance_events_dropped_total", kind: "counter", unit: "count", help: "Events runs reported dropping before they reached the brain", labels: [] },
  { name: "swarm_os_instance_sessions_total", kind: "counter", unit: "count", help: "Room sessions minted for instances, by role", labels: ["role"] },
  { name: "swarm_os_instance_metrics_entries", kind: "gauge", unit: "count", help: "Instances whose forwarded snapshot the brain holds", labels: [] },
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/os/tests/metrics/ingress-metrics.test.ts
import { describe, it, expect } from "vitest";
import { OS_METRICS } from "@mnmal-ai/swarm-metrics";
import { testRegistry } from "@mnmal-ai/swarm-metrics/testing";
import { BoardApiError } from "../../src/ingress/board-client.js";
import { TrelloApiClient, TRELLO_CARD_FIELDS, trelloCallbackUrl, trelloSignature } from "../../src/ingress/trello-api.js";
import { GitHubApiClient } from "../../src/ingress/github-api.js";
import { Poller } from "../../src/ingress/poller.js";
import { webhookRoutes, WebhookCounters, type WebhookDeps } from "../../src/ingress/webhooks.js";
import { DispatchRooms } from "../../src/dispatch/room-opener.js";
import type { ApiCall } from "../../src/dispatch/host.js";
import { FakeBoardClient, FakeClock, FetchStub, MemoryOsStore } from "../../src/testing/index.js";
import { harness } from "../dispatch/harness.js";
import { T0, boardCard, boardRow, testConfig, silentLog } from "../dispatch/fixtures.js";
import { counter, gauge, hist } from "./helpers.js";

const API = "https://api.trello.com/1";
const BOARD = boardRow();
const GH_BOARD = boardRow({ id: "board-g", kind: "github", externalId: "owner-a/repo-a", name: "repo-a", queueColumn: "swarm:goal", webhookSecret: "hook-secret-a" });
const boards = { get: async (id: string) => (id === "board-a" ? BOARD : id === "board-g" ? GH_BOARD : null) };

describe("board API metrics", () => {
  it("times every call by source, operation and status class, and counts rate limits", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const stub = new FetchStub()
      .on("GET", `${API}/boards/${BOARD.externalId}/lists?fields=id,name&filter=open`, { json: [{ id: "list-2", name: "To Do" }] })
      .on("GET", `${API}/lists/list-2/cards?fields=${TRELLO_CARD_FIELDS}&checklists=all`, { json: [] })
      .on("GET", /\/cards\/gone1\?/, { status: 404 })
      .on("GET", /\/cards\/slow1\?/, { status: 429 })
      .on("GET", /\/cards\/hang1\?/, { hang: true })
      .on("GET", /\/repos\/owner-a\/repo-a\/issues\?/, { status: 403, headers: { "x-ratelimit-remaining": "0" }, text: "API rate limit exceeded" });
    const trello = new TrelloApiClient({ key: "key-a", token: "token-a", boards, fetch: stub.fetch, timeoutMs: 20, metrics });
    const github = new GitHubApiClient({ token: "ghp_test_a", boards, fetch: stub.fetch, timeoutMs: 20, metrics });
    await trello.listQueue(BOARD);
    await trello.getCard({ boardId: "board-a", cardId: "gone1" });
    for (const cardId of ["slow1", "hang1"]) await trello.getCard({ boardId: "board-a", cardId }).catch(() => {});
    await github.listQueue(GH_BOARD).catch(() => {});
    const s = metrics.snapshot();
    expect(hist(s, "swarm_os_ingress_board_api_seconds", { source: "trello", op: "lists", outcome: "2xx" })?.count).toBe(1);
    expect(hist(s, "swarm_os_ingress_board_api_seconds", { source: "trello", op: "list_cards", outcome: "2xx" })?.count).toBe(1);
    expect(hist(s, "swarm_os_ingress_board_api_seconds", { source: "trello", op: "card", outcome: "4xx" })?.count).toBe(2);
    expect(hist(s, "swarm_os_ingress_board_api_seconds", { source: "trello", op: "card", outcome: "timeout" })?.count).toBe(1);
    expect(hist(s, "swarm_os_ingress_board_api_seconds", { source: "github", op: "issues", outcome: "4xx" })?.count).toBe(1);
    expect(counter(s, "swarm_os_ingress_board_rate_limited_total", { source: "trello", op: "card" })).toBe(1);
    expect(counter(s, "swarm_os_ingress_board_rate_limited_total", { source: "github", op: "issues" })).toBe(1);
  });
});

describe("poll metrics", () => {
  it("times each poll by source and outcome, counts listed and new cards, and records each version's first sighting", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const h = await harness({ metrics });
    const fake = new FakeBoardClient("trello");
    fake.setQueue("board-a", [boardCard(1), boardCard(2)]);
    const poller = new Poller({ store: h.store, boards: { trello: fake }, dispatcher: h.dispatcher, rooms: new DispatchRooms({ store: h.store, opener: h.opener, config: h.config }), config: h.config, clock: h.clock, log: silentLog, metrics });
    await poller.pollNow("board-a");
    h.clock.advance(120_000);
    await poller.pollNow("board-a");
    fake.failNext(new BoardApiError("rate_limited", "board API returned 429"), "board-a");
    await poller.pollNow("board-a");
    const s = metrics.snapshot();
    expect(hist(s, "swarm_os_ingress_poll_seconds", { source: "trello", outcome: "ok" })?.count).toBe(2);
    expect(hist(s, "swarm_os_ingress_poll_seconds", { source: "trello", outcome: "rate_limited" })?.count).toBe(1);
    expect(hist(s, "swarm_os_ingress_poll_listed_cards", { source: "trello" })).toMatchObject({ count: 2, sum: 4 });
    expect(hist(s, "swarm_os_ingress_poll_new_cards", { source: "trello" })).toMatchObject({ count: 2, sum: 2 });
    expect(gauge(s, "swarm_os_dispatch_queue_cards", { board: "board-a" })).toBe(2);
    expect(h.dispatcher.seen.sighting(boardCard(1).ref, boardCard(1).version)).toEqual({ at: T0, source: "poll", decided: true });
  });
});

describe("webhook metrics", () => {
  it("counts deliveries by source and outcome, times the work after the reply, and records the sighting at arrival", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const trelloJson = { id: "5f00000000000000000000c1", shortLink: "abc123", name: "Add search", desc: "", idBoard: BOARD.externalId, idList: "list-2", labels: [], closed: false, dateLastActivity: "2026-10-25T08:00:00.000Z", url: "https://trello.com/c/abc123", checklists: [], list: { id: "list-2", name: "To Do" } };
    const stub = new FetchStub().on("GET", `${API}/cards/5f00000000000000000000c1?fields=${TRELLO_CARD_FIELDS}&list=true&checklists=all`, { json: trelloJson });
    const store = new MemoryOsStore();
    await store.boards.put(BOARD);
    const clock = new FakeClock(T0);
    const seen: Array<[string, string, string, string]> = [];
    const deps: WebhookDeps = {
      store, config: testConfig(), counters: new WebhookCounters(), log: silentLog, metrics, clock,
      decide: async () => { clock.advance(1_000); },
      see: (ref, version, source, at) => { seen.push([ref.cardId, version, source, at.toISOString()]); },
      boards: { trello: new TrelloApiClient({ key: "key-a", token: "token-a", boards: store.boards, fetch: stub.fetch, metrics }) },
    };
    const post = webhookRoutes(deps).find((r) => r.method === "POST" && r.path === "/hooks/trello/:boardId")!;
    const call = (over: Partial<ApiCall>): ApiCall => ({ params: { boardId: "board-a" }, query: {}, headers: {}, body: undefined, rawBody: "", actor: null, ...over });
    const RAW = '{"action":{"type":"updateCard","data":{"card":{"id":"5f00000000000000000000c1"}}}}';
    const sign = (raw: string) => trelloSignature("app-secret-a", raw, trelloCallbackUrl("https://os.example", "board-a"));
    await (await post.handler(call({ headers: { "x-trello-webhook": sign(RAW) }, rawBody: RAW }))).work;
    await post.handler(call({ rawBody: RAW }));
    await post.handler(call({ headers: { "x-trello-webhook": sign("not json") }, rawBody: "not json" }));
    await post.handler(call({ params: { boardId: "board-z" }, rawBody: RAW }));
    const s = metrics.snapshot();
    for (const outcome of ["accepted", "rejected", "malformed", "unknown_board"]) expect(counter(s, "swarm_os_ingress_webhooks_total", { source: "trello", outcome }), outcome).toBe(1);
    expect(hist(s, "swarm_os_ingress_ingest_seconds", { source: "trello", outcome: "ok" })?.count).toBe(1);
    expect(hist(s, "swarm_os_ingress_board_api_seconds", { source: "trello", op: "card", outcome: "2xx" })?.count).toBe(1);
    expect(seen).toEqual([["abc123", "2026-10-25T08:00:00.000Z", "webhook", T0.toISOString()]]);
  });
});
```

```ts
// packages/os/tests/metrics/dispatch-metrics.test.ts
import { describe, it, expect } from "vitest";
import { OS_METRICS } from "@mnmal-ai/swarm-metrics";
import { testRegistry } from "@mnmal-ai/swarm-metrics/testing";
import { KeyedQueue } from "../../src/dispatch/queue.js";
import { harness, ev, type Harness } from "../dispatch/harness.js";
import { boardCard, deferred } from "../dispatch/fixtures.js";
import { counter, gauge, hist } from "./helpers.js";

const finish = async (h: Harness, cardId: string) => {
  const [row] = await h.store.instances.find({ cardId });
  await h.dispatcher.onExit(row.id, { reason: "completed", code: 0 });
};
const CHECKS = ["known_board", "column_and_labels", "not_in_flight", "queue_depth", "resources", "ready"];

describe("dispatch metrics", () => {
  it("measures card seen to decision, to dispatch and to attach, and launch to attach", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const h = await harness({ registration: { minCards: 1 }, metrics });
    const card = boardCard(1);
    h.dispatcher.seen.see(card.ref, card.version, "webhook");
    h.clock.advance(2_000);
    await h.dispatcher.decideCard(ev(card, "webhook"));
    const [row] = await h.store.instances.find({ cardId: "card-1" });
    h.clock.advance(8_000);
    await h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 4242 });
    const s = metrics.snapshot();
    expect(hist(s, "swarm_os_dispatch_card_seen_to_decision_seconds", { source: "webhook", outcome: "dispatch" })).toMatchObject({ count: 1, sum: 2 });
    expect(hist(s, "swarm_os_dispatch_card_seen_to_dispatch_seconds", { source: "webhook", by: "policy" })).toMatchObject({ count: 1, sum: 2 });
    expect(hist(s, "swarm_os_dispatch_card_seen_to_attach_seconds", { source: "webhook" })).toMatchObject({ count: 1, sum: 10 });
    expect(hist(s, "swarm_os_instance_launch_to_attach_seconds", { launcher: "fake" })).toMatchObject({ count: 1, sum: 8 });
    expect(hist(s, "swarm_os_dispatch_decision_to_start_seconds", { outcome: "started" })?.count).toBe(1);
    expect(counter(s, "swarm_os_dispatch_decisions_total", { outcome: "dispatch", check: "none", via: "card" })).toBe(1);
    for (const check of CHECKS) expect(hist(s, "swarm_os_dispatch_check_seconds", { check, outcome: "passed" })?.count, check).toBeGreaterThanOrEqual(1);
  });

  it("keeps a version's first sighting, so a card held and drained later reports its whole wait", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const h = await harness({ metrics });
    const [c1, c2, c3] = [boardCard(1), boardCard(2), boardCard(3)];
    for (const c of [c1, c2, c3]) h.dispatcher.seen.see(c.ref, c.version, "poll");
    await h.dispatcher.noteQueue("board-a", [c1, c2, c3]);
    await h.dispatcher.decideCard(ev(c1, "poll"));                 // dispatched: depth 3
    await h.dispatcher.decideCard(ev(c2, "poll"));                 // held: project-a has 1 of 1 running
    await h.dispatcher.reevaluateHolds("board-a");
    expect(gauge(metrics.snapshot(), "swarm_os_dispatch_held_cards", { board: "board-a" })).toBe(1);
    h.clock.advance(60_000);
    await finish(h, "card-1");
    await h.dispatcher.noteQueue("board-a", [c2, c3]);
    await h.dispatcher.reevaluateHolds("board-a");                 // card-2 goes: the board is draining
    const s = metrics.snapshot();
    expect(hist(s, "swarm_os_dispatch_card_seen_to_dispatch_seconds", { source: "poll", by: "policy" })).toMatchObject({ count: 2, max: 60 });
    expect(hist(s, "swarm_os_dispatch_card_seen_to_decision_seconds", { source: "poll", outcome: "hold" })).toMatchObject({ count: 1, sum: 0 });
    expect(counter(s, "swarm_os_dispatch_decisions_total", { outcome: "hold", check: "not_in_flight", via: "card" })).toBe(1);
    expect(counter(s, "swarm_os_dispatch_decisions_total", { outcome: "dispatch", check: "none", via: "reevaluation" })).toBe(1);
    expect(gauge(s, "swarm_os_dispatch_held_cards", { board: "board-a" })).toBe(0);
    expect(gauge(s, "swarm_os_dispatch_queue_cards", { board: "board-a" })).toBe(2);
  });

  it("times each policy check by check and outcome, up to the first that fails", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const h = await harness({ metrics });
    await h.dispatcher.decideCard(ev(boardCard(1)));               // depth 1 < min_cards 3
    const s = metrics.snapshot();
    for (const check of ["known_board", "column_and_labels", "not_in_flight"]) expect(hist(s, "swarm_os_dispatch_check_seconds", { check, outcome: "passed" })?.count, check).toBe(1);
    expect(hist(s, "swarm_os_dispatch_check_seconds", { check: "queue_depth", outcome: "failed" })?.count).toBe(1);
    expect(hist(s, "swarm_os_dispatch_check_seconds", { check: "ready" })).toBeUndefined();
    expect(counter(s, "swarm_os_dispatch_decisions_total", { outcome: "hold", check: "queue_depth", via: "card" })).toBe(1);
  });

  it("measures how long work waits for its key, by queue and key kind", async () => {
    const { metrics, clock } = testRegistry(OS_METRICS);
    const q = new KeyedQueue({ metrics, queue: "dispatch" });
    const gate = deferred();
    const a = q.run("board-a", async () => { await gate.promise; });
    const b = q.run("board-a", async () => {});
    await q.run("limits", async () => {});
    await q.run("instance:inst-1", async () => {});
    expect(gauge(metrics.snapshot(), "swarm_os_dispatch_lock_tasks", { queue: "dispatch", key: "board" })).toBe(2);
    clock.advance(500);
    gate.resolve();
    await Promise.all([a, b]);
    const s = metrics.snapshot();
    expect(gauge(s, "swarm_os_dispatch_lock_tasks", { queue: "dispatch", key: "board" })).toBe(0);
    expect(hist(s, "swarm_os_dispatch_lock_wait_seconds", { queue: "dispatch", key: "board", outcome: "ok" })).toMatchObject({ count: 2, max: 0.5 });
    expect(hist(s, "swarm_os_dispatch_lock_wait_seconds", { queue: "dispatch", key: "limits" })?.count).toBe(1);
    expect(hist(s, "swarm_os_dispatch_lock_wait_seconds", { queue: "dispatch", key: "instance" })?.count).toBe(1);
  });
});
```

```ts
// packages/os/tests/metrics/instance-metrics.test.ts
import { describe, it, expect } from "vitest";
import { OS_METRICS, type MetricsSnapshot } from "@mnmal-ai/swarm-metrics";
import { testRegistry } from "@mnmal-ai/swarm-metrics/testing";
import { InstanceMetricsStore, type InstanceMetricsRecord } from "../../src/dispatch/instance-metrics.js";
import { instanceRoutes } from "../../src/dispatch/instance-routes.js";
import { RunControl } from "../../src/dispatch/instances.js";
import { DispatchRooms } from "../../src/dispatch/room-opener.js";
import { mountDispatch, type BrainHost } from "../../src/dispatch/mount.js";
import type { ApiCall } from "../../src/dispatch/host.js";
import { meteredLauncher, LaunchError } from "../../src/launcher/launcher.js";
import { ResourceMonitor } from "../../src/resources/resources.js";
import { FakeBoardClient, FakeClock, FakeEventHub, FakeLauncher, FakeRoomOpener, MemoryOsStore } from "../../src/testing/index.js";
import { harness, ev, FakeTokens } from "../dispatch/harness.js";
import { T0, boardCard, boardRow, registrationRow, testConfig, silentLog } from "../dispatch/fixtures.js";
import { counter, gauge, hist } from "./helpers.js";

const snap = (n: number): MetricsSnapshot => ({ at: n, defs: [], counters: [], gauges: [], histograms: [] });

async function attachedRoutes() {
  const { metrics } = testRegistry(OS_METRICS);
  const h = await harness({ registration: { minCards: 1 }, metrics });
  await h.dispatcher.decideCard(ev(boardCard(1)));
  const [row] = await h.store.instances.find({ cardId: "card-1" });
  const instanceMetrics = new InstanceMetricsStore({ clock: h.clock, metrics });
  const routes = instanceRoutes({ store: h.store, dispatcher: h.dispatcher, opener: h.opener, tokens: h.tokens, clock: h.clock, log: silentLog, metrics, instanceMetrics });
  const send = (method: string, path: string, over: Partial<ApiCall>) => routes.find((r) => r.method === method && r.path === path)!
    .handler({ params: { id: row.id }, query: {}, headers: {}, body: undefined, rawBody: "", actor: { kind: "instance", instanceId: row.id }, ...over });
  return { h, row, metrics, instanceMetrics, routes, send };
}

describe("instance lifecycle metrics", () => {
  it("counts live states, heartbeat intervals, deaths and lifetimes by outcome", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const h = await harness({ registration: { minCards: 1 }, metrics });
    await h.dispatcher.decideCard(ev(boardCard(1)));
    const [row] = await h.store.instances.find({ cardId: "card-1" });
    await h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 4242 });
    h.clock.advance(15_000);
    await h.dispatcher.onHeartbeat(row.id, { tokens: 1, phase: "working", currentTask: null });
    h.clock.advance(14_000);
    await h.dispatcher.onHeartbeat(row.id, { tokens: 2, phase: "working", currentTask: null });
    await h.dispatcher.sweep();
    let s = metrics.snapshot();
    expect(hist(s, "swarm_os_instance_heartbeat_interval_seconds")).toMatchObject({ count: 2, sum: 29 });
    expect(["running", "dispatching", "unresponsive"].map((state) => gauge(s, "swarm_os_instance_live", { state }))).toEqual([1, 0, 0]);
    h.clock.advance(90_000);
    await h.dispatcher.sweep();
    h.launcher.setStatus(row.id, "gone");
    await h.dispatcher.sweep();
    s = metrics.snapshot();
    expect(counter(s, "swarm_os_instance_dead_total", { reason: "unresponsive" })).toBe(1);
    expect(counter(s, "swarm_os_instance_dead_total", { reason: "gone" })).toBe(1);
    expect(hist(s, "swarm_os_instance_lifetime_seconds", { outcome: "gone" })).toMatchObject({ count: 1, sum: 119 });
    expect(gauge(s, "swarm_os_instance_live", { state: "unresponsive" })).toBe(0);
  });

  it("counts run control by action and how it was delivered", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const h = await harness({ registration: { minCards: 1 }, metrics });
    const fake = new FakeBoardClient("trello");
    fake.setQueue("board-a", [boardCard(1)]);
    const runs = new RunControl({ store: h.store, dispatcher: h.dispatcher, launcher: h.launcher, hub: new FakeEventHub(), boards: { trello: fake }, rooms: new DispatchRooms({ store: h.store, opener: h.opener, config: h.config }), clock: h.clock, log: silentLog, metrics });
    await h.dispatcher.decideCard(ev(boardCard(1)));
    const [row] = await h.store.instances.find({ cardId: "card-1" });
    await runs.pause(row.id, "owner");                            // never attached: through the launcher
    await h.dispatcher.onAttach(row.id, { runId: "run-1", dashboardUrl: null, pid: 4242 });
    await runs.stop(row.id, "owner", "immediate");                // attached: through its stream
    await runs.resume(row.id, "owner");                           // not paused
    const s = metrics.snapshot();
    expect(counter(s, "swarm_os_instance_control_total", { action: "pause", outcome: "launcher" })).toBe(1);
    expect(counter(s, "swarm_os_instance_control_total", { action: "stop_immediate", outcome: "stream" })).toBe(1);
    expect(counter(s, "swarm_os_instance_control_total", { action: "resume", outcome: "refused" })).toBe(1);
  });

  it("times every launcher call by kind, op and outcome", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const inner = new FakeLauncher();
    const launcher = meteredLauncher(inner, metrics);
    const spec = { instanceId: "inst-1", registration: registrationRow(), cardId: "card-1", token: "inst_x", brainUrl: "http://127.0.0.1:3200" };
    const handle = await launcher.start(spec);
    await launcher.status(handle);
    inner.setStatus("inst-1", "gone");
    await launcher.status(handle);
    await launcher.stop(handle, "graceful");
    await launcher.resources();
    inner.beforeStart = () => { throw new LaunchError("spawn failed"); };
    await launcher.start({ ...spec, instanceId: "inst-2" }).catch(() => {});
    const s = metrics.snapshot();
    expect(launcher.kind).toBe("fake");
    for (const [op, outcome] of [["start", "ok"], ["start", "error"], ["status", "running"], ["status", "gone"], ["stop", "ok"], ["resources", "ok"]]) {
      expect(hist(s, "swarm_os_launcher_op_seconds", { launcher: "fake", op, outcome })?.count, `${op} ${outcome}`).toBe(1);
    }
  });

  it("publishes each resource sample as gauges", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const launcher = new FakeLauncher();
    launcher.snapshot = { host: "local", at: T0.toISOString(), cpuLoad1: 0.5, cpus: 8, memFreeMb: 4096, memTotalMb: 16384, instancesRunning: 1, claudeSessions: 2, portsInUse: [3141, 3142], tokensThisHour: { "project-a": 700, "project-b": 300 } };
    await new ResourceMonitor({ store: new MemoryOsStore(), launcher, hub: new FakeEventHub(), clock: new FakeClock(T0), log: silentLog, metrics }).sample();
    const s = metrics.snapshot();
    expect(["cpu_load", "cpus", "mem_free_bytes", "mem_total_bytes", "instances_running", "claude_sessions", "ports_in_use", "last_hour_tokens"].map((n) => gauge(s, `swarm_os_launcher_${n}`)))
      .toEqual([0.5, 8, 4096 * 1_048_576, 16384 * 1_048_576, 1, 2, 2, 1000]);
  });
});

describe("instance metrics forwards", () => {
  it("keeps each instance's latest snapshot and appends one record at most every five minutes, and at its end", () => {
    const { metrics } = testRegistry(OS_METRICS);
    const clock = new FakeClock(T0);
    const written: InstanceMetricsRecord[] = [];
    const store = new InstanceMetricsStore({ clock, write: (r) => written.push(r), metrics });
    store.put("inst-a", snap(1));
    clock.advance(15_000); store.put("inst-a", snap(2));
    expect(store.latest()).toEqual({ "inst-a": { at: T0.getTime() + 15_000, snapshot: snap(2) } });
    clock.advance(300_000); store.put("inst-a", snap(3));
    clock.advance(15_000); store.put("inst-a", snap(4));
    store.settle("inst-a"); store.settle("inst-a");
    expect(written.map((r) => [r.r, r.instanceId, r.at, r.snapshot.at])).toEqual([
      ["instance", "inst-a", T0.getTime(), 1], ["instance", "inst-a", T0.getTime() + 315_000, 3], ["instance", "inst-a", T0.getTime() + 330_000, 4]]);
    expect(gauge(metrics.snapshot(), "swarm_os_instance_metrics_entries")).toBe(1);
    clock.advance(3_600_000);
    expect(store.latest()).toEqual({});
    expect(gauge(metrics.snapshot(), "swarm_os_instance_metrics_entries")).toBe(0);
  });

  it("POST /api/instances/:id/metrics takes a snapshot from its own instance, also after its exit", async () => {
    const { h, row, instanceMetrics, routes, send } = await attachedRoutes();
    expect(routes.find((r) => r.path === "/api/instances/:id/metrics")).toMatchObject({ method: "POST", auth: ["instance"] });
    expect(await send("POST", "/api/instances/:id/metrics", { actor: { kind: "instance", instanceId: "inst-other" }, body: { snapshot: snap(1) } })).toMatchObject({ status: 403 });
    expect(await send("POST", "/api/instances/:id/metrics", { body: { snapshot: { at: "soon" } } })).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    expect(await send("POST", "/api/instances/:id/metrics", { body: { snapshot: snap(1) } })).toEqual({ status: 200, body: { ok: true } });
    await h.dispatcher.onExit(row.id, { reason: "completed", code: 0 });
    expect(await send("POST", "/api/instances/:id/metrics", { body: { snapshot: snap(2) } })).toEqual({ status: 200, body: { ok: true } });
    expect(instanceMetrics.latest()[row.id]?.snapshot).toEqual(snap(2));
  });

  it("measures each forwarded event batch, the events the run dropped, and the sessions it opened", async () => {
    const { metrics, send } = await attachedRoutes();
    const at = "2026-10-25T09:00:01.000Z";
    await send("POST", "/api/instances/:id/events", { body: { events: [{ event: "task:start", payload: {}, at }, { event: "os:events_dropped", payload: { count: 12 }, at }] } });
    await send("POST", "/api/instances/:id/sessions", { body: { role: "worker", sessionId: "sess-w1" } });
    const s = metrics.snapshot();
    expect(hist(s, "swarm_os_instance_event_batch_events")).toMatchObject({ count: 1, sum: 2 });
    expect(hist(s, "swarm_os_instance_event_batch_seconds", { outcome: "ok" })?.count).toBe(1);
    expect(counter(s, "swarm_os_instance_events_dropped_total")).toBe(12);
    expect(counter(s, "swarm_os_instance_sessions_total", { role: "worker" })).toBe(1);
  });

  it("mountDispatch keeps forwarded snapshots and appends an instance's last one when it ends", async () => {
    const store = new MemoryOsStore();
    const clock = new FakeClock(T0);
    await store.boards.put(boardRow());
    await store.registrations.put(registrationRow({ minCards: 1 }));
    const fake = new FakeBoardClient("trello");
    fake.setQueue("board-a", [boardCard(1)]);
    const written: InstanceMetricsRecord[] = [];
    const host: BrainHost = { hub: new FakeEventHub(), tokens: new FakeTokens(store), route: () => {}, addPeriodic: () => {}, dispatchGates: [] };
    const mod = mountDispatch(host, { store, config: testConfig(), rooms: new FakeRoomOpener(store, clock), clock, log: silentLog, launcher: new FakeLauncher(), boards: { trello: fake },
      metrics: testRegistry(OS_METRICS).metrics, writeMetricsRecord: (r) => written.push(r) });
    await mod.poller.pollNow("board-a");
    const [row] = await store.instances.find({ cardId: "card-1" });
    mod.instanceMetrics.put(row.id, snap(1));
    clock.advance(15_000);
    mod.instanceMetrics.put(row.id, snap(2));
    await mod.dispatcher.onExit(row.id, { reason: "completed", code: 0 });
    expect(written.map((r) => r.snapshot.at)).toEqual([1, 2]);
  });
});
```

In `instance-routes.test.ts`, `mount.test.ts` and `brain-module.test.ts`, add `POST /api/instances/:id/metrics` to each route list after `POST /api/instances/:id/sessions` (with `instance` as its auth in the first), so eleven routes become twelve.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @mnmal-ai/swarm-metrics build && cd packages/os && npx vitest run tests/metrics/ingress-metrics.test.ts tests/metrics/dispatch-metrics.test.ts tests/metrics/instance-metrics.test.ts tests/dispatch/instance-routes.test.ts tests/dispatch/mount.test.ts`
Expected: FAIL — cannot load `../../src/dispatch/instance-metrics.js`; `h.dispatcher.seen` is undefined; the route lists lack the metrics route; every `hist(...)` is `undefined`.

- [ ] **Step 3: Implement**

1. Append the block above to `OS_METRICS` and run `pnpm --filter @mnmal-ai/swarm-metrics build`.
2. Ingress:
   - `FetchStub`: `StubReply.headers` becomes the response's headers.
   - `fetchJson`, given a `meter`, runs the request inside a `swarm_os_ingress_board_api_seconds` span `{ source, op }` and ends it with `statusClass(status)`, `timeout` or `network`; a 429, or a 403 whose `x-ratelimit-remaining` header is `"0"`, also increments `swarm_os_ingress_board_rate_limited_total { source, op }`. Error codes and messages are unchanged.
   - `TrelloApiClient` passes `op: "lists"`, `"list_cards"` and `"card"`, and `GitHubApiClient` `"issues"` and `"issue"`, with their `metrics` (default `noopMetrics`).
   - `Poller`: its `KeyedQueue` is `new KeyedQueue({ metrics, queue: "poller" })`. One poll runs inside a `swarm_os_ingress_poll_seconds` span `{ source: board?.kind ?? "unknown" }` ended `ok`, `no_registration`, the `BoardApiError`'s code (`no_credentials` included) or `error`. Right after `listQueue` resolves it calls `dispatcher.seen.see(card.ref, card.version, "poll", now)` for every listed card. A good poll observes `swarm_os_ingress_poll_listed_cards` (cards listed) and `swarm_os_ingress_poll_new_cards` (cards it emitted).
   - Webhook routes: each POST increments `swarm_os_ingress_webhooks_total { source, outcome }` beside the counter it already moves (`accepted`, `rejected`, `malformed`, `unknown_board`; `no_credentials` for the missing client), takes `arrived = (deps.clock ?? systemClock).now()` first, and hands it to `ingestRefs`, which runs inside a `swarm_os_ingress_ingest_seconds` span `{ source }` (ended `error` when any `getCard` or `decide` failed) and calls `deps.see?.(card.ref, card.version, "webhook", arrived)` for each card `getCard` returns, before `decide`.
3. Dispatch:
   - `KeyedQueue`: `run` raises `swarm_os_dispatch_lock_tasks { queue, key: lockKind(key) }` at the call and lowers it when the task settles, and opens a `swarm_os_dispatch_lock_wait_seconds` span at the call, ended `ok` when the task starts. The `Dispatcher`'s is `new KeyedQueue({ metrics, queue: "dispatch" })`.
   - `card-seen.ts`: one `Map` keyed `<cardKey>@<version>` in insertion order (the oldest deleted past `maxEntries`) and one keyed by instance id.
   - `checks.ts`: `timedCheck` runs one check inside a `swarm_os_dispatch_check_seconds` span `{ check }`, ended `passed` or `failed` by the result, `error` when it throws. `runChain` wraps each check it runs with `ctx.metrics ?? noopMetrics`; `dispatchLocked` wraps its two re-checks the same way.
   - `Dispatcher`: keeps `deps.metrics ?? noopMetrics` and builds `seen = new CardSeen({ clock })`; its `ChainContext` carries the metrics. The private helper that calls the `onDecision` listeners takes a `via` (`card` from `decideCard`, `reevaluation` from `reevaluateHolds`, `command` from `dispatch()` and `holdCard`) and increments `swarm_os_dispatch_decisions_total { outcome, check: <first failing check name, or "none">, via }`. Where a decision row is stored in `dispatchLocked` step 2 and `decideCard` step 6, `seen.firstDecision(ref, version)` decides whether to observe `swarm_os_dispatch_card_seen_to_decision_seconds { source, outcome }` (brain clock, seconds). `dispatchLocked` opens `swarm_os_dispatch_decision_to_start_seconds` after step 2 and ends it `started` or `spawn_failed`; after `launcher.start` resolves, when `seen.sighting(card.ref, card.version)` exists it observes `swarm_os_dispatch_card_seen_to_dispatch_seconds { source, by: decidedBy === "policy" ? "policy" : "command" }` and calls `seen.bindInstance(instanceId, card.ref, card.version)`. Its spawn-failure path observes `swarm_os_instance_lifetime_seconds { outcome: "spawn_failed" }`. `noteQueue` sets `swarm_os_dispatch_queue_cards { board }` to the listing's length; `reevaluateHolds`, when it re-ran the chain, sets `swarm_os_dispatch_held_cards { board }` to the entries still held after the re-run.
   - Lifecycle (`Dispatcher` methods and `instances.ts`): `onAttach` observes `swarm_os_instance_launch_to_attach_seconds { launcher: launcher.kind }` (now minus `startedAt`) and, from `seen.takeInstance(id)`, `swarm_os_dispatch_card_seen_to_attach_seconds { source }`. `onHeartbeat` (not ended) observes `swarm_os_instance_heartbeat_interval_seconds` when `lastHeartbeatAt` was set, and increments `swarm_os_instance_recovered_total` where it posts `recovered`. `onExit`, after `exitState`, and the sweep's `gone` path observe `swarm_os_instance_lifetime_seconds { outcome: lifetimeOutcome(state, exitReason) }` (`exited` maps to its `exitReason`, `completed`, `nothing_to_do` or `stopped`; `failed` with `exitReason` `gone` to `gone`, with a `spawn_failed:` prefix to `spawn_failed`, otherwise `failed`; `paused` and `login_expired` to themselves). `sweep()` increments `swarm_os_instance_dead_total` with `unresponsive`, `gone` or `detached` beside each of those notices and `swarm_os_instance_stop_escalations_total` at step 3, then sets `swarm_os_instance_live { state }` for each of the three live states from `store.instances.find({ state })`.
   - `RunControl`: increments `swarm_os_instance_control_total { action, outcome }`: `pause`, `stop_graceful` and `stop_immediate` with `stream` (published), `launcher` (a run that never attached) or `refused` (not live); `resume` and `retry` with `dispatched`, `failed` (a spawn failure) or `refused` (every other `ok: false`); `republish` with `stream` per row.
   - `instance-metrics.ts`: `InstanceMetricsStore` keeps per instance `{ at, snapshot, appendedAt, appended, endedAt }`. `put` stores `{ at: clock.now().getTime(), snapshot }` and calls `write({ r: "instance", instanceId, at, snapshot })` when nothing was appended for that instance in the last `INSTANCE_RECORD_EVERY_MS`; `settle` marks it ended and writes its latest unless that one was already written. `latest()` (and `put`) drop entries ended at least `INSTANCE_ENDED_KEEP_MS` ago, and past `maxEntries` the entry with the oldest `at`; each change sets `swarm_os_instance_metrics_entries`. A throwing `write` is logged once by the caller's wiring and never reaches `put`. Appending every forward would put each run's full snapshot into the brain's day file every 15 s; every five minutes, and once at the end, keeps every run's final numbers well under the sink's daily cap.
   - `instance-routes.ts`: `POST /api/instances/:id/metrics` (auth `["instance"]`): `403 forbidden` when `actor.instanceId !== params.id`, `404 not_found` for an unknown instance, `400 bad_request` when `MetricsForwardSchema` refuses the body; an ended instance is accepted (its last forward comes just before its exit), so this route has no `409`; `instanceMetrics.put(id, body.snapshot)` and `200 { ok: true }`. `postInstanceEvents` runs inside a `swarm_os_instance_event_batch_seconds` span, observes `swarm_os_instance_event_batch_events` and adds each `os:events_dropped` event's `payload.count` to `swarm_os_instance_events_dropped_total`. The sessions route increments `swarm_os_instance_sessions_total { role }`.
4. Launcher and resources: `meteredLauncher` returns `{ kind: inner.kind, start, status, stop, resources }`, each call inside a `swarm_os_launcher_op_seconds` span `{ launcher: kind, op }` ended `ok` (or the `status` result) or `error` before rethrowing. `LocalLauncher` increments `swarm_os_launcher_child_exits_total` with `ok` (code 0), `error` (another code) or `signal` (killed by a signal) on each child's `exit`. `ResourceMonitor.sample()` sets the eight `swarm_os_launcher_*` gauges from the snapshot it got.
5. `mount.ts`: `metrics = deps.metrics ?? noopMetrics`. `boards = deps.boards ?? createBoardClients(config, store, deps.fetch, metrics)`. Keep the raw launcher for step 5's `onChildExit` (`meteredLauncher` hides the `LocalLauncher` class), and give `meteredLauncher(raw, metrics)` to the `Dispatcher`, `RunControl`, `ResourceMonitor` and `DispatchModule.launcher`. Pass `metrics` to the `Dispatcher`, `Poller`, `RunControl`, `ResourceMonitor`, the webhook deps (with `clock` and `see: (ref, version, source, at) => dispatcher.seen.see(ref, version, source, at)`) and the instance-route deps, with `instanceMetrics = new InstanceMetricsStore({ clock, write: deps.writeMetricsRecord, metrics })`. In step 4's `onChange`, an instance change with an ended state also calls `instanceMetrics.settle(row.id)`. The module exposes `instanceMetrics`.
6. `brain-module.ts`: `mountDispatch(host, { …, metrics: ctx.metrics, writeMetricsRecord: (record) => ctx.metricsSink.write(record) })`, then `ctx.services.instanceMetrics = module.instanceMetrics`, which plan 03's `GET /api/metrics` serves under `instances`.
7. `tests/dispatch/harness.ts`: the `metrics` option, passed to the `Dispatcher` and to `restart()`'s.
8. Append `CardSeen`, `InstanceMetricsStore`, `meteredLauncher`, `lifetimeOutcome` and the types `InstanceMetricsRecord`, `Sighting`, `SeenSource`, `BoardApiMeter` to the `// plan 04` block of `src/index.ts`.

- [ ] **Step 4: Run the tests, the package gate and the workspace build**

Run: `cd packages/os && npx vitest run tests/metrics tests/dispatch tests/ingress tests/launcher tests/resources`
Expected: PASS, the three new files and every earlier test (with the route lists of twelve). Then the package gate, `pnpm -w build` (exit 0), and `cd packages/cli && npx vitest run` (the CLI suite stays green).

- [ ] **Step 5: Commit**

```bash
git add packages/metrics/src/catalogue/os.ts packages/os/src/ingress packages/os/src/dispatch packages/os/src/launcher packages/os/src/resources \
  packages/os/src/testing/fetch-stub.ts packages/os/src/index.ts packages/os/tests/dispatch packages/os/tests/metrics
git -c commit.gpgsign=false commit -m "feat(os): measure ingress, dispatch, the launcher and instances, and keep each instance's forwarded metrics"
```
