# Swarm OS 03: Brain Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The always-up core of `swarm os`: the `os.json` config and OS home, the brain's lifecycle and composition root (journal replay, reconcile on start, periodic tasks, signals, health, the wiring of plans 04 to 09), its HTTP API with the Server-Sent Events `EventHub` and the shared SSE client, the auth layer (passkeys, cookie and bearer sessions, devices, instance and room tokens, the host actor, step-ups, lockdown), the launchd and systemd supervisor files, and `swarm os init|start|stop|status|install|uninstall|lockdown|confirm`.

**Architecture:** All brain code lives in `packages/os` under `config/`, `auth/`, `api/`, `sse/`, `brain/` and `supervisor/`, plus the shared refusal-code list in `security/refusals.ts`. `packages/cli/src/cli/os.ts` is a thin client that loads config and either runs the brain in the foreground or calls it over loopback as the host actor. The API is one node `http` server with a small router: server-to-client traffic is SSE from one `EventHub`, client-to-server is plain HTTP, and an `Actor` only ever comes from a credential (the `swarm_os_session` cookie or a bearer token), never from a request body. `Brain.start` is the composition root: later plans attach through `BrainModule`s found among the package's exports and through a few named parts (the chief of staff, the dashboard) loaded only when their plan has landed.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), node `http` (no WebSocket in the brain), `zod` 4, `@simplewebauthn/server` 14, `web-push` 3 (VAPID key generation only), `@anthropic-ai/claude-agent-sdk` (declared here for plan 06, whose facade the brain constructs), vitest 3; plan 02's `OsStore`, `MemoryOsStore`, `Journal`, `journaledStore`, `ensureOsStack`, `SubstrateOsStore`, `createLogger`, `systemClock`.

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md`, with the shared contracts in `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md`. This plan uses the overview's names verbatim; its additions, including the shapes plans 01, 02, 04, 05, 06, 07, 08 and 09 rely on, are listed under **Contracts this plan adds**.

## Global Constraints

- **Overview names are verbatim:** `OsConfigSchema`, `Actor` (human actors carry `confirmer`), the route paths, the stream event names and payloads, the token prefixes `sess_`, `inst_`, `room_`, `host_`, `EventHub`, `openEventStream`, `parseSse`, `StepUps`, `Lockdown`, `requireAuth`. Nothing here renames an overview name.
- **Status codes are the contract.** `RefusalCode` and `REFUSAL_STATUS` (`packages/os/src/security/refusals.ts`, defined here, extended by plan 09): `bad_request` 400, `unauthenticated` 401, `forbidden` 403, `provenance_mismatch` 403, `lockdown` 403, `stepup_failed` 403, `not_found` 404, `conflict` 409, `stepup_required` 428 (with `stepUpId`, `expiresAt`), `cooldown` 429 (with `cooldownUntil`), `limit` 429 (with `limit`), `store_unavailable` 503; plus the API-only `gone` 410 for an expired enrolment. Bodies are `{ error: { code, message, ...extra } }`, finer causes in `reason`. An uncaught exception is `500 { error: { code: "internal", message: "internal error" } }`: a bug, never a designed answer. Success is 200, or 202 for a pending enrolment; a handler's value is the body as it is, bare arrays included.
- **Importing `@mnmal-ai/swarm-os` has no side effects:** no server start, no config load, no file or environment reads, no timers and no process listeners at import time, in `src/index.ts` or anything it re-exports (packages/cli loads it from the `swarm run` attachment path). `packages/os` never depends on `packages/cli`.
- **Limits live on disk.** Spec: "Machine and spend limits … live in `os.json` on disk and are read-only to the API, the chief of staff and every command. Changing them takes a file edit on the host." `loadOsConfig` deep-freezes `limits`; `os.json` is written only by `initOsHome`, and only when it does not exist yet.
- **Step-up:** "the command runs only when that code is sent back within two minutes" → `stepup_ttl_seconds` (default 120), six-digit codes, three wrong codes lock a step-up. The code reaches only the host and confirmer devices other than the requester's device: in the `stepup` event, in `GET /api/stepup/pending` and in the stream's `hello.stepUps`. The requester gets `428 stepup_required` and never the code. Every actor gets the 428 for a standing command, the host included (on the host it is a two-step are-you-sure); the code is accepted from the host or a confirmer device, never from the chief of staff.
- **Cool-down:** "new commands from that session wait ten minutes" → `COOLDOWN_MS = 600_000`, after a new address or "two failed step-up codes within ten minutes" (a wrong or an expired code; a standing command sent without a code counts for nothing).
- **Lockdown:** "`swarm os lockdown`, run on the host, revokes every human session and every worker's room token, stops dispatching, and keeps instances running and reporting (their own tokens stay valid); only the host can lift it." Every human and instance stream is closed as well; instance tokens keep working over HTTP. Engaging it is immediate and host-only (an operating command); lifting it is a standing command the host confirms with `swarm os confirm`.
- **Sessions:** "A human session is bound to the device that enrolled it, expires, and can be revoked." TTL `session_ttl_hours` (24); the login address is recorded and a different one trips `onNewAddress`. The cookie `swarm_os_session` is `HttpOnly; SameSite=Strict; Path=/; Secure`, without `Secure` only when `bind.host` is loopback and `public_url` is `http:`.
- **Enrolment:** "Enrolling a new device needs an existing device's approval and a step-up code." The first device uses the one-time link `swarm os init` prints (`<public_url>/#enrol=<code>`, single use, valid 15 minutes); later devices wait as pending enrolments kept by plan 09's `Enrolments`, approved by the standing command `devices approve <enrolmentId>`.
- **Instance tokens:** "issued at dispatch and revoked at exit."
- **Transport:** SSE streams send `retry: 3000`, a `: keepalive` comment every 15 s and `id:`/`event:`/`data:` lines from one sequence that keeps rising across restarts, with a 10,000-event replay ring and `gap` for an older id. Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` under `/api` (a `swarm_os_*` cookie and no `Authorization` header) need `X-Swarm-Os: 1`; bearer callers and cookie-less requests are exempt. CORS allows only the `public_url` origin; anything else gets 403 `forbidden`.
- **Client address:** from a loopback peer with `X-Forwarded-For` (Tailscale Serve), the first address in that header; otherwise the peer's address; `::ffff:` is stripped. Forwarding headers from any other peer are ignored.
- **Bind:** "loopback-only on a Mac unless configured otherwise" → default `127.0.0.1:3200`; a non-loopback bind requires an `https:` `public_url`.
- **OS home:** `osHome()` is `$SWARM_OS_HOME` or `~/.swarm/os` and holds `os.json`, `host.secret`, `journal/`, `instances/`, `logs/`, `cos/` (the chief of staff's working directory), `event-seq`, `lockdown.json`, `bootstrap.json` and `brain.pid`. The directory is `0700`; files holding a secret are `0600`. The OS stack's Substrate plugin directory is plan 02's stack directory, not the OS home.
- **Shared primitives:** `Clock` and `systemClock` from `packages/os/src/clock.ts`; row date fields are ISO-8601 strings (`string | null` when nullable) and this plan writes `clock.now().toISOString()`; `Repo.find` filters by equality only.
- **Ids and tokens differ:** store ids come from `newId()` (`sess-…`, `dev-…`, `stepup-…`); bearer tokens use underscores (`sess_…`). A token is never stored, only its sha256 hex.
- **No secrets in logs:** never log a bearer token, cookie, the host secret, a step-up code or `push.vapid_private`. `packages/os` logs through plan 02's `createLogger`, never `console.log`.
- **Anonymity:** examples use `owner`, `board-a`, `/path/to/…`, `brain.example.test`; no personal names, client names, real hostnames or home paths anywhere in code, tests or fixtures.
- **Tests:** vitest under `packages/os/tests/` (helpers in `packages/os/tests/helpers/`), run with `env -u ANTHROPIC_API_KEY`. Every test uses a `mkdtemp` OS home, listens on port `0` on `127.0.0.1`, and never runs `launchctl`, `systemctl`, `tailscale` or Docker. HTTP tests use node `http` or global `fetch`; SSE tests use this plan's `openEventStream`. Passkey verification is mocked (Task 7); later plans' parts are fakes injected through `deps`.
- **Verification after every task:** `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build` is green; Task 13 adds `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run`; the plan ends with `pnpm turbo build`.
- **CI:** no workflow files, no trigger changes, no push. Commits stay local, with Conventional Commit subjects.

## Review Focus

1. **The brain died after spawning an instance but before recording its handle** (a `dispatching` row, `launcherHandle: null`, live process). Expected: reconcile asks the launcher by instance id, leaves the row untouched, re-dispatches nothing and waits for the instance to attach. Test: Task 9, `keeps a dispatching row whose process is running and never re-dispatches it`.
2. **The launcher cannot answer during reconcile** (`status` throws or hangs; a remote host is down). Expected: the row stays exactly as recorded and is reported `unknown`, never marked gone, because "a run the brain cannot see is a run nobody can stop from a phone". Test: Task 9, `leaves a row alone when the launcher cannot answer`.
3. **The owner edits `os.json` by hand and gets it wrong** (bad JSON, a schema error, mode 0644, or a changed `public_url` or `bind`), then sends SIGHUP. Expected: the brain keeps its running config, logs why, keeps serving, and applies restart-only keys only after a restart. Tests: Task 1, `takes every new value except restart-only keys`; Task 10, `reload keeps the running config when os.json is broken`.
4. **A confirmer device asks for a standing command and could approve it itself.** Expected: that device never receives its own code (neither the `stepup` event, `GET /api/stepup/pending` nor `hello.stepUps` reaches it), so one device alone can ask but not approve; the host or a different confirmer device can. Tests: Task 6, `never shows a requester its own code`; Task 8, `a confirmer phone cannot see its own code`.
5. **`swarm os stop` while the brain runs under launchd or systemd.** Expected: the brain exits 0 and the supervisor does not start it again, while a crash (non-zero exit) is restarted. Tests: Task 12, `restarts only after a failure`; Task 13, `start returns 0 once the brain has stopped`.

## Contracts this plan adds

1. **Routes:** `GET /api/stepup/pending` (host, or a human on a confirmer device: the codes of step-ups requested from other devices, for `swarm os confirm` and for anyone who missed the event); `POST /api/lockdown` (host only, immediate) and `POST /api/lockdown/release` (host only, a standing command the host then confirms). `POST /api/auth/devices/:id/revoke` also accepts `{ stepUpId, code }` to run an issued request inline, as `POST /api/commands` does.
2. **Host secret:** `host.secret` holds the bare secret; the bearer is `host_<secret>` and counts only from a loopback peer with no `X-Forwarded-For` or `Forwarded` header.
3. **Codes:** `security/refusals.ts` is created here with the overview's names and plan 09's signatures (`RefusalCode`, `REFUSAL_STATUS`, `refuse`, `refusalCode`, `GateRefusedError`), plus `refusalBody` and `RefusedResult`; `gone` (410) is API-only, outside that list. Any thrown error whose `code` is in `REFUSAL_STATUS` (`GateRefusedError` included, with its `data`) renders as the envelope. An expired code is a failed one: 403 `stepup_failed`, `reason: "stepup_expired"`, counted like a wrong code.
4. **Step-ups on the wire:** `stepup { stepUpId, command, expiresAt, code }`, visible to the host and to confirmer devices other than the requesting device; `hello` on `GET /api/stream` carries `stepUps` (the same entries still pending) for those viewers (plan 08). `POST /api/stepup/confirm { stepUpId, code }` runs the stored command through `StandingRunners`; plan 05 registers its executor as the fallback runner.
5. **Passkey bodies and enrolment (plan 07's shapes):** `register/options { deviceName, enrolment?, enrolmentId? }` → `{ enrolmentId, options }` (`enrolmentId` is `"bootstrap"` for the link), `register/verify { enrolmentId, response }`, `login/options {}` → the options themselves, `login/verify { response }`; a verify finds its challenge by the `challenge` inside the response's `clientDataJSON`. `POST /api/auth/register/options` without a link answers `202 { enrolmentId, state: "pending" }` and sets `swarm_os_enrolment` (an HttpOnly cookie binding the waiting device; its secret's hash travels in `request`); it answers 403 once refused, 410 once expired, and real options once approved, after which `register/verify` completes. The store is `EnrolmentsPort` (`request`, `get`, `complete`, and the optional `approve` that `devices approve` calls), implemented by plan 09's `Enrolments`; without one, later devices get 403 with `reason: "enrolment_unavailable"`.
6. **SSE:** `EventHub` options `validate(actor)` (checked at every keepalive; a failing stream is closed) and `seqFile` (the last id, written at most once a second and on `flush()`, so ids keep rising across restarts); methods `closeWhere`, `closeAll`, `latestId`, `flush`; `EventPublisher = Pick<EventHub, "publish">` (what `FakeEventHub` satisfies); `eventRoom(event)`; `EventStreamAuthError` (401/403 stop `openEventStream` reconnecting) and `nextBackoff`.
7. **Router:** `idempotent()` (opt-in `Idempotency-Key`, 10 minutes, scoped per actor), `withStatus(status, body)`.
8. **Tokens:** `mintInstanceToken()` is pure and returns `{ token, tokenHash }` (plan 04 writes the hash into the `Instance` row it creates).
9. **Composition:** `BrainModule { name; start(ctx); stop() }` and `BrainContext` exactly as fixed for plans 04, 05 and 06 (this plan's additions merged into the same interface); modules start in the order given after every route exists and stop in reverse. The default list is `collectBrainModules` over `src/index.ts` exports named `*BrainModule`, in `MODULE_ORDER` (`messaging`, `dispatch`, `cos`, `web`, `cli-login`, `security`), plus this plan's built-in `cos` (plan 06's `createChiefOfStaff` wiring), `web` (plan 07's `registerStatic`, or a one-line page) and `cli-login` (the one `mountCliLogin` call, plan 08) wherever no plan supplies a module of that name. `ctx.periodic` (first run at start, never overlapping itself) and `ctx.registerCommands` (plan 05's `registerCommand`); the auth-side commands (`devices revoke`, `devices approve` and `lockdown release` standing, `lockdown` operating and host-only), `register` and the other registration commands being plan 08's; `Sessions.issueSession({ humanId, deviceId, address, client })`; the brain's own `journal_replay` (10 s) and `question_expiry` (60 s) tasks; `GET /health` adds `webhooksRejected` and reports `store: !store.degraded`; `BrainLauncher`/`BrainDispatcher` ports; `BRAIN_RESTART_FOUND_GONE`; `Actor` also re-exported from `api/auth-middleware.ts`.
10. **Config:** `cos.readiness_model?: string`, filled with `cos.model` by `loadOsConfig`, for plan 06's per-card readiness model; `boards.trello.secret?: string`, the Trello app secret that signs webhooks (plan 04 falls back to `Board.webhookSecret`).
11. **CLI seams:** `runOs` is one switch over `init|start|stop|status|install|uninstall|lockdown|confirm`, so plan 08's guard (one import, one line before it) sends command messages and `login` to its `runOsCommand`; `swarm os confirm <stepUpId> <code>` takes two arguments; plan 08 exports `runTop(positional, flags): Promise<number | void>` from `top.ts`; plan 01's `room-mcp` early-return block is used verbatim (`runRoomMcp(process.env): Promise<number>`).
12. **Obligations on later plans:** plan 04 exports `dispatchBrainModule` (name `dispatch`), which calls `mountDispatch` with a `BrainHost` built from the `BrainContext` and sets `ctx.services.dispatch` and `ctx.services.webhooksRejected` (its mount reconciles, so the brain's own `reconcile` runs only without it), and its `Launcher.status` resolves `handle: ""` by instance id; plan 05 exports `messagingBrainModule` (name `messaging`), which sets `ctx.services.messaging`, `executor` and `notifySystem`, calls `ctx.streams.setHello`, and registers its fallback standing runner; plan 06 keeps `createChiefOfStaff`, `tapDecisions` and `AgentSdkFacade` where its plan puts them, or ships a `cosBrainModule` that replaces the built-in one; plan 07 exports `registerStatic(server)` from `api/static.ts`; plan 08 exports `mountCliLogin` and `CliLogins` from `api/cli-login.ts` and adds no second `mountCliLogin` call; plan 09's `Enrolments` implements `EnrolmentsPort`, and its `devices approve` and `devices revoke` may replace this plan's defaults. Every module reads `config.*` at use time, because SIGHUP updates the object in place.

## Consumed from other plans

- **Plan 02:** `OsStore`, `Repo` (`store/store.ts`); `InstanceRow`, `DeviceRow`, `SessionRow`, `StepUpRow`, `RoomRow`, `MessageRow`, `DispatchDecisionRow`, `ResourceSnapshotRow` (`store/rows.ts`); `newId` (`store/ids.ts`); `MemoryOsStore`; `Journal` (`new Journal(dir, { clock, log })`) and `journaledStore(base, journal, snapshot, opts)` → `JournaledOsStore` (`replay(): Promise<ReplayReport>`, `degraded`; it mirrors every read into the snapshot); `ensureOsStack(config, { osHome, log })` → a `swarm-os` `SubstrateClient`, wrapped in `SubstrateOsStore`, called only from `brain/open-store.ts` (never `ensureSubstrateReady`); `createLogger`, `Logger`; `Clock`, `systemClock`; `makeConfig` (Task 1 makes it return a validated `OsConfig`), `FakeClock` (`new FakeClock(start?)`, `now()`, `advance(ms)`), `MemoryOsStore` from `src/testing/index.ts`.
- **Later plans, only where they have landed:** plan 05's `registerCommand` (`commands/registry.ts`), plan 06's `createChiefOfStaff`, `tapDecisions` (`cos/index.ts`) and `AgentSdkFacade` (`cos/sdk.ts`), plan 07's `registerStatic` (`api/static.ts`) and plan 08's `mountCliLogin` and `CliLogins` (`api/cli-login.ts`), loaded by `loadBrainParts()` through literal dynamic imports that resolve to `undefined` while the file is missing; plans 04 and 05 through their `*BrainModule` exports; plan 09's `Enrolments` through `deps.enrolments`. Plan 04's `FakeLauncher` does not exist when this plan runs, so reconcile is tested with this plan's `ScriptedLauncher`.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/os/src/config/schema.ts`, `paths.ts` | `OsConfigSchema`, `loadOsConfig`, `applyReload`; `osHome`, `osPaths` | 1 |
| `packages/os/src/config/init.ts`, `exec.ts`, `tailscale.ts` | `initOsHome`, the first-device link, `ExecFn`, Tailscale Serve | 1 |
| `packages/os/src/auth/host.ts`, `tokens.ts` | the host secret; token primitives (1) and `Tokens`, `mintInstanceToken` (2) | 1, 2 |
| `packages/os/src/testing/config.ts` | `makeConfig` returns an `OsConfig` (plan 02's file, changed at plan 02's request) | 1 |
| `packages/os/src/auth/actor.ts`, `sessions.ts`, `lockdown.ts` | `Actor`, `Sessions`, `Lockdown` | 2 |
| `packages/os/src/security/refusals.ts` | `RefusalCode`, `REFUSAL_STATUS`, `refuse`, `refusalCode`, `GateRefusedError`, `refusalBody` (plan 09 extends) | 3 |
| `packages/os/src/api/errors.ts`, `router.ts`, `guards.ts`, `server.ts` | `ApiError`, `Router`, `idempotent`, `withStatus`, request guards, `ApiServer` | 3 |
| `packages/os/src/auth/hooks.ts`, `api/auth-middleware.ts` | `AuthHooks`; `requireAuth`, `Authenticator`, cookies | 4 |
| `packages/os/src/sse/client.ts`, `hub.ts`, `api/streams.ts`, `testing/fake-event-hub.ts` | SSE both sides, the stream routes, `FakeEventHub` | 5 |
| `packages/os/src/auth/stepup.ts`, `standing.ts` | `StepUps`, `StandingRunners`, `requestStanding`, `confirmStanding` | 6 |
| `packages/os/src/auth/passkeys.ts` | `Passkeys`, `WebAuthn`, `EnrolmentsPort` | 7 |
| `packages/os/src/auth/index.ts`, `api/auth-routes.ts` | `createAuthServices`, the auth, step-up, `me` and lockdown routes | 8 |
| `packages/os/src/brain/ports.ts`, `recovery.ts`, `reconcile.ts` | `BrainLauncher`, `BrainDispatcher`, `warmSnapshot`, `reconcile` | 9 |
| `packages/os/src/brain/periodic.ts`, `module.ts`, `open-store.ts`, `brain.ts` | `Periodics`, `BrainModule`, `BrainContext`, `collectBrainModules`, `openOsStore`, `Brain` | 10 |
| `packages/os/src/brain/parts.ts`, `builtin-modules.ts`, `auth/commands.ts` | `loadBrainParts`, the built-in `cos`, `web` and `cli-login` modules, `authCommands` | 11 |
| `packages/os/src/supervisor/launchd.ts`, `systemd.ts`, `index.ts` | supervisor files, install, uninstall | 12 |
| `packages/cli/src/cli/os.ts`, `optional-command.ts`, `main.ts` | `runOs`, `runOptionalCommand`, the `os`/`top`/`room-mcp` dispatch | 13 |

Every task appends its exports to the `// --- plan 03: brain core ---` block of `packages/os/src/index.ts` (append-only); `FakeEventHub` goes to `src/testing/index.ts`.

---

### Task 1: `os.json`, the OS home, and everything `swarm os init` writes

**Files:**
- Create: `packages/os/src/config/schema.ts`, `packages/os/src/config/paths.ts`, `packages/os/src/config/exec.ts`, `packages/os/src/config/tailscale.ts`, `packages/os/src/config/init.ts`
- Create: `packages/os/src/auth/tokens.ts` (primitives only), `packages/os/src/auth/host.ts`
- Modify: `packages/os/src/testing/config.ts` (plan 02's file, changed at its request: `makeConfig` returns a validated `OsConfig`), `packages/os/package.json` (dependency lines only, Step 1), `packages/os/src/index.ts` (open the plan 03 block)
- Test: `packages/os/tests/config.test.ts`, `packages/os/tests/config-init.test.ts`, `packages/os/tests/helpers/os-home.ts`, `packages/os/tests/helpers/clock.ts`

**Interfaces:**
- Consumes: plan 02's `makeConfig`, `DeepPartial`, `newId`, `FakeClock`, `Logger`.
- Produces:
```ts
// packages/os/src/config/schema.ts
export const OsConfigSchema;            // verbatim from 00-overview.md, plus cos.readiness_model and boards.trello.secret, both z.string().optional()
export type OsConfig = z.infer<typeof OsConfigSchema>;
export class OsConfigError extends Error { constructor(message: string, readonly path?: string) }
export function loadOsConfig(path?: string): OsConfig;                       // default osPaths().config
export const RESTART_REQUIRED_KEYS: readonly ["bind", "public_url", "os_stack", "launcher"];
export function applyReload(target: OsConfig, next: OsConfig): string[];     // mutates target; returns the restart-only keys that differ
// packages/os/src/config/paths.ts
export interface OsPaths { home: string; config: string; hostSecret: string; journal: string; instances: string; logs: string; cos: string;
  eventSeq: string; pid: string; lockdown: string; bootstrap: string }
export function osHome(env?: NodeJS.ProcessEnv, userHome?: string): string;
export function osPaths(home?: string): OsPaths;
export function isLoopbackHost(host: string): boolean;                       // 127.0.0.0/8, ::1, localhost
export function assertPrivateFile(path: string, what: string): void;
export function writePrivateFile(path: string, content: string): void;       // internal: not exported from index.ts
// packages/os/src/config/exec.ts
export type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export function execFileRunner(): ExecFn;                                    // execFile, never a shell; resolves with the exit code instead of throwing
// packages/os/src/config/tailscale.ts
export async function tailscaleOrigin(exec: ExecFn): Promise<string>;        // "https://" + Self.DNSName without its trailing dot
export async function tailscaleServe(exec: ExecFn, port: number): Promise<void>;   // tailscale serve --bg --https=443 http://127.0.0.1:<port>
// packages/os/src/config/init.ts
export const BOOTSTRAP_TTL_MS = 15 * 60_000;
export interface BootstrapRecord { tokenHash: string; humanId: string; expiresAt: string }
export interface InitOptions { home: string; publicUrl?: string; ownerName?: string; port?: number; registrableRoots?: string[]; tailscale?: boolean; exec?: ExecFn; now?: () => Date }
export interface InitResult { paths: OsPaths; config: OsConfig; created: string[]; keptExisting: boolean; enrolLink: string }
export async function initOsHome(opts: InitOptions): Promise<InitResult>;
export function defaultOsConfig(input: { publicUrl: string; ownerName: string; port: number; registrableRoots: string[]; vapid: { publicKey: string; privateKey: string }; timezone: string }): OsConfig;
export function issueBootstrapLink(paths: OsPaths, config: OsConfig, now?: Date): string;   // `${public_url}/#enrol=${code}`; single use, BOOTSTRAP_TTL_MS
export function readBootstrap(path: string): BootstrapRecord | null;
// packages/os/src/auth/tokens.ts (primitives)
export const TOKEN_PREFIX = { session: "sess_", instance: "inst_", room: "room_", host: "host_" } as const;
export function newToken(prefix: string): string;                            // prefix + randomBytes(32).toString("base64url") (43 chars)
export function hashToken(token: string): string;                            // sha256 hex
export function tokenKind(token: string): "human" | "instance" | "room" | "host" | null;
export function safeEqual(a: string, b: string): boolean;                    // timingSafeEqual; false on a length mismatch
// packages/os/src/auth/host.ts
export function createHostSecret(path: string): void;                        // keeps an existing file; else randomBytes(32) base64url + "\n", mode 0600
export function readHostSecret(path: string): HostSecret;                    // OsConfigError when missing or not 0600
export class HostSecret { constructor(value: string); bearer(): string; /* "host_" + value */ verifyBearer(presented: string): boolean; deriveKey(label: string): Buffer /* HMAC-SHA256(value, label) */ }
// packages/os/src/testing/config.ts (replaces plan 02's interface)
export type TestOsConfig = OsConfig;
export function makeConfig(overrides?: DeepPartial<OsConfig>): OsConfig;     // OsConfigSchema.parse(plan 02's defaults deep-merged with overrides; arrays replace)
// packages/os/tests/helpers/os-home.ts and clock.ts
export function tempOsHome(): OsPaths & { cleanup(): void };
export function freshHome(): string;                                         // a path in a new temp directory, not created yet
export const MINIMAL_CONFIG: Record<string, unknown>;   // version 1, bind {}, public_url https://brain.example.test, launcher local, os_stack { postgres_url },
                                                        // owners [{ id: "part-owner", name: "owner" }], limits {… registrable_roots ["/path/to/projects"], launcher_hosts ["local"] }, ask {}, cos {}
export function writeConfig(paths: OsPaths, config: unknown, mode?: number): void;   // default mode 0o600
export const T0: Date;                                                       // 2026-10-25T12:00:00.000Z
export function testClock(): FakeClock;                                      // new FakeClock(T0)
export function testLog(): Logger & { info: Mock; warn: Mock; error: Mock };
```

- [ ] **Step 1: Add the runtime dependencies this plan and plan 06 need**

Run `grep -nE '"(zod|@simplewebauthn/server|web-push|@anthropic-ai/claude-agent-sdk|@types/web-push)"' packages/os/package.json` and leave out of the next command anything plan 02 already declares, then:
Run: `pnpm --filter @mnmal-ai/swarm-os add zod@^4.6.5 @simplewebauthn/server@^14.0.3 web-push@^3.6.7 @anthropic-ai/claude-agent-sdk@^0.2.50 && pnpm --filter @mnmal-ai/swarm-os add -D @types/web-push@^3.6.4`
Expected: the packages appear in `packages/os/package.json`; these dependency lines are the plan's only edit to plan 02's manifest.

- [ ] **Step 2: Write the failing tests**

`packages/os/tests/config.test.ts`:
```ts
it("honours SWARM_OS_HOME and defaults to ~/.swarm/os", () => {
  expect(osHome({ SWARM_OS_HOME: "/path/to/os" }, "/path/to/user")).toBe("/path/to/os");
  expect(osHome({}, "/path/to/user")).toBe(join("/path/to/user", ".swarm", "os"));
  expect(osPaths("/path/to/os")).toEqual({ home: "/path/to/os", config: "/path/to/os/os.json", hostSecret: "/path/to/os/host.secret",
    journal: "/path/to/os/journal", instances: "/path/to/os/instances", logs: "/path/to/os/logs", cos: "/path/to/os/cos",
    eventSeq: "/path/to/os/event-seq", pid: "/path/to/os/brain.pid", lockdown: "/path/to/os/lockdown.json", bootstrap: "/path/to/os/bootstrap.json" });
});
it("loads a 0600 os.json, fills the schema defaults and the readiness model", () => {
  const home = tempOsHome(); writeConfig(home, MINIMAL_CONFIG);
  const cfg = loadOsConfig(home.config);
  expect(cfg.bind).toEqual({ host: "127.0.0.1", port: 3200 });
  expect(cfg.os_stack).toMatchObject({ port: 49338, compose_project: "swarm-os" });
  expect(cfg.ask).toEqual({ min_wait_minutes: 30, quiet_windows: [], timezone: "UTC" });
  expect(cfg.cos).toEqual({ model: "claude-sonnet-5-5", auth: "subscription", max_turns: 20, readiness_model: "claude-sonnet-5-5" });
  expect([cfg.host_trust, cfg.poll_interval_seconds, cfg.session_ttl_hours, cfg.stepup_ttl_seconds, cfg.boards]).toEqual(["owner", 120, 24, 120, {}]);
  writeConfig(home, { ...MINIMAL_CONFIG, cos: { readiness_model: "claude-haiku-5" } });
  expect(loadOsConfig(home.config).cos.readiness_model).toBe("claude-haiku-5");
  writeConfig(home, { ...MINIMAL_CONFIG, boards: { trello: { key: "k", token: "t", secret: "s" } } });
  expect(loadOsConfig(home.config).boards.trello?.secret).toBe("s");
});
it("refuses an os.json other users can read, and names the fix", () => {
  const home = tempOsHome(); writeConfig(home, MINIMAL_CONFIG, 0o644);
  expect(() => loadOsConfig(home.config)).toThrow(OsConfigError);
  expect(() => loadOsConfig(home.config)).toThrow(/mode 0644.*chmod 600/);
});
it("names a missing file, invalid JSON and every schema issue", () => {
  const home = tempOsHome();
  expect(() => loadOsConfig(home.config)).toThrow(/swarm os init/);
  writeFileSync(home.config, "{", { mode: 0o600 });
  expect(() => loadOsConfig(home.config)).toThrow(/not valid JSON/);
  writeConfig(home, { ...MINIMAL_CONFIG, owners: [], public_url: "not a url" });
  expect(() => loadOsConfig(home.config)).toThrow(/public_url: .*; owners: /);
});
it("refuses a non-loopback bind unless public_url is https", () => {
  const home = tempOsHome();
  writeConfig(home, { ...MINIMAL_CONFIG, bind: { host: "0.0.0.0" }, public_url: "http://brain.example.test" });
  expect(() => loadOsConfig(home.config)).toThrow(/bind\.host 0\.0\.0\.0 is not loopback, so public_url must be https/);
});
it("freezes limits so nothing at runtime can raise them", () => {
  const home = tempOsHome(); writeConfig(home, MINIMAL_CONFIG);
  const cfg = loadOsConfig(home.config);
  expect(Object.isFrozen(cfg.limits) && Object.isFrozen(cfg.limits.registrable_roots)).toBe(true);
  expect(() => { (cfg.limits as { max_instances: number }).max_instances = 99; }).toThrow(TypeError);
});
it("takes every new value except restart-only keys, which it reports", () => {
  const target = makeConfig(); const next = structuredClone(target);
  next.limits = { ...next.limits, max_instances: target.limits.max_instances + 2 };
  next.poll_interval_seconds = 30;
  next.bind = { ...next.bind, port: target.bind.port + 1 };
  expect(applyReload(target, next)).toEqual(["bind"]);
  expect([target.limits.max_instances, target.poll_interval_seconds, target.bind.port]).toEqual([next.limits.max_instances, 30, next.bind.port - 1]);
});
it("makeConfig returns an OsConfig the schema accepts unchanged, with overrides merged", () => {
  const c = makeConfig({ os_stack: { port: 50_000 } });
  expect(OsConfigSchema.parse(c)).toEqual(c);
  expect(c.os_stack.port).toBe(50_000);
});
```
`packages/os/tests/config-init.test.ts` (`r` comes from a `beforeEach`: `initOsHome({ home: freshHome(), publicUrl: "https://brain.example.test", registrableRoots: ["/path/to/projects"], now: () => T0 })`):
```ts
it("creates the home 0700, os.json and host.secret 0600, and the journal, instances, logs and cos folders", () => {
  expect(statSync(r.paths.home).mode & 0o777).toBe(0o700);
  expect([statSync(r.paths.config).mode & 0o777, statSync(r.paths.hostSecret).mode & 0o777]).toEqual([0o600, 0o600]);
  for (const d of [r.paths.journal, r.paths.instances, r.paths.logs, r.paths.cos]) expect(statSync(d).isDirectory()).toBe(true);
  expect(r.created).toEqual(expect.arrayContaining(["os.json", "host.secret"]));
});
it("writes a valid os.json: local launcher, loopback bind, plan 02's OS stack, fresh VAPID keys, one owner, the default limits", () => {
  const cfg = loadOsConfig(r.paths.config);
  expect([cfg.launcher, cfg.bind]).toEqual([{ kind: "local" }, { host: "127.0.0.1", port: 3200 }]);
  expect(cfg.os_stack).toEqual({ port: 49338, postgres_url: "postgresql://swarm:swarm@127.0.0.1:49337/swarm", compose_project: "swarm-os" });
  expect([cfg.push?.vapid_public, cfg.push?.vapid_private, cfg.push?.subject]).toEqual([expect.stringMatching(/^[A-Za-z0-9_-]{87}$/),
    expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), "https://brain.example.test"]);
  expect(cfg.owners).toEqual([{ id: expect.stringMatching(/^part-/), name: "owner" }]);
  expect(cfg.limits).toEqual({ max_instances: 2, tokens_per_hour: 20_000_000, tokens_per_day: 120_000_000, dispatches_per_hour: 6,
    registrable_roots: ["/path/to/projects"], launcher_hosts: ["local"] });
});
it("defaults public_url to localhost on the bind port, with a mailto push subject", async () => {
  const l = await initOsHome({ home: freshHome() });
  expect([l.config.public_url, l.config.push?.subject]).toEqual(["http://localhost:3200", "mailto:owner@example.invalid"]);
});
it("prints a one-time first-device link valid for 15 minutes and stores only its hash", () => {
  expect(r.enrolLink).toMatch(/^https:\/\/brain\.example\.test\/#enrol=[A-Za-z0-9_-]{43}$/);
  const code = r.enrolLink.split("#enrol=")[1];
  expect(readBootstrap(r.paths.bootstrap)).toEqual({ tokenHash: hashToken(code), humanId: r.config.owners[0].id,
    expiresAt: new Date(T0.getTime() + BOOTSTRAP_TTL_MS).toISOString() });
  expect(readFileSync(r.paths.bootstrap, "utf8")).not.toContain(code);
  expect(statSync(r.paths.bootstrap).mode & 0o777).toBe(0o600);
});
it("keeps an existing os.json and host.secret and issues a new link", async () => {
  const before = readFileSync(r.paths.config), secret = readFileSync(r.paths.hostSecret, "utf8");
  const again = await initOsHome({ home: r.paths.home, publicUrl: "https://other.example.test", now: () => T0 });
  expect([readFileSync(r.paths.config).equals(before), readFileSync(r.paths.hostSecret, "utf8"), again.keptExisting]).toEqual([true, secret, true]);
  expect(again.enrolLink).not.toBe(r.enrolLink);
  expect(again.enrolLink.startsWith("https://brain.example.test/#enrol=")).toBe(true);
});
it("takes public_url from Tailscale and serves the bind port through it", async () => {
  const calls: Array<[string, string[]]> = [];
  const exec: ExecFn = async (cmd, args) => { calls.push([cmd, args]);
    return { code: 0, stderr: "", stdout: args[0] === "status" ? JSON.stringify({ Self: { DNSName: "brain.tailnet-example.ts.net." } }) : "" }; };
  const t = await initOsHome({ home: freshHome(), tailscale: true, exec });
  expect(t.config.public_url).toBe("https://brain.tailnet-example.ts.net");
  expect(calls).toEqual([["tailscale", ["status", "--json"]], ["tailscale", ["serve", "--bg", "--https=443", "http://127.0.0.1:3200"]]]);
});
it("keeps the bare host secret on disk, presents it as host_<secret>, and refuses a readable file", () => {
  const value = readFileSync(r.paths.hostSecret, "utf8").trim(), s = readHostSecret(r.paths.hostSecret);
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect([s.bearer(), s.verifyBearer(`host_${value}`), s.verifyBearer(`host_${value}x`), s.verifyBearer(value)]).toEqual([`host_${value}`, true, false, false]);
  chmodSync(r.paths.hostSecret, 0o644);
  expect(() => readHostSecret(r.paths.hostSecret)).toThrow(/chmod 600/);
});
it("token primitives", () => {
  expect(newToken(TOKEN_PREFIX.session)).toMatch(/^sess_[A-Za-z0-9_-]{43}$/);
  expect(hashToken("sess_a")).toMatch(/^[0-9a-f]{64}$/);
  expect(["sess_a", "inst_a", "room_a", "host_a", "Bearer a"].map(tokenKind)).toEqual(["human", "instance", "room", "host", null]);
  expect([safeEqual("abc", "abc"), safeEqual("abc", "abd"), safeEqual("abc", "ab")]).toEqual([true, false, false]);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/config.test.ts tests/config-init.test.ts`
Expected: FAIL, `Cannot find module '../src/config/schema.js'`.

- [ ] **Step 4: Implement**

- `OsConfigSchema`: the overview's object, with `readiness_model: z.string().optional()` added to `cos` and `secret: z.string().optional()` (the Trello app secret that signs webhooks) added to `boards.trello`. `loadOsConfig(path)`: missing file → `OsConfigError("no os.json at <path>: run swarm os init")`; `assertPrivateFile(path, "os.json")` (skipped on `win32`); a parse failure → `"os.json at <path> is not valid JSON: <parser message>"`; a `safeParse` failure → one error joining `"<issue.path.join('.')>: <issue.message>"` with `"; "`. Then: `bind.host` must pass `isLoopbackHost` or be `0.0.0.0`/`::`, and a non-loopback bind needs an `https:` `public_url`; owner ids are unique; `cos.readiness_model ??= cos.model`; `limits`, `limits.registrable_roots` and `limits.launcher_hosts` are frozen.
- `assertPrivateFile`: `(statSync(path).mode & 0o077) !== 0` → `OsConfigError("<what> at <path> has mode 0<octal>; other users can read it. Run: chmod 600 <path>")`. `writePrivateFile`: write `<path>.<pid>.tmp` with mode `0o600`, `chmodSync` (umask), `renameSync`.
- `applyReload`: assign every top-level key of `next` onto `target` except `RESTART_REQUIRED_KEYS`; return those whose `JSON.stringify` differs, in that order.
- `defaultOsConfig` writes exactly: `version: 1`; `bind: { host: "127.0.0.1", port }`; `public_url`; `host_trust: "owner"`; `launcher: { kind: "local" }`; `os_stack: { port: 49338, postgres_url: "postgresql://swarm:swarm@127.0.0.1:49337/swarm", compose_project: "swarm-os" }` (plan 02's compose template creates database `swarm`); `push: { vapid_public, vapid_private, subject }`, the subject being `public_url` when it is `https:` and `"mailto:owner@example.invalid"` otherwise; `owners: [{ id: newId("part"), name: ownerName }]`; the limits in the test; `poll_interval_seconds: 120`; `ask: { min_wait_minutes: 30, quiet_windows: [], timezone }`; `boards: {}`; `cos: { model: "claude-sonnet-5-5", auth: "subscription", max_turns: 20 }`; `session_ttl_hours: 24`; `stepup_ttl_seconds: 120`; then `OsConfigSchema.parse`.
- `initOsHome`: `mkdirSync(home, { recursive: true, mode: 0o700 })` then `chmodSync(home, 0o700)`; `journal`, `instances`, `logs` and `cos` at `0o700`. `public_url` = `opts.publicUrl` ?? (`opts.tailscale` ? `await tailscaleOrigin(exec)` : `http://localhost:<port>`), and `tailscaleServe` runs only while creating `os.json`. VAPID keys from `webpush.generateVAPIDKeys()` (`import webpush from "web-push"`); timezone `Intl.DateTimeFormat().resolvedOptions().timeZone`. An existing `os.json` is loaded and never rewritten (`keptExisting: true`); `createHostSecret` keeps an existing secret; every call issues a fresh link.
- `issueBootstrapLink`: code `randomBytes(32).toString("base64url")`; `writePrivateFile(paths.bootstrap, JSON.stringify({ tokenHash: hashToken(code), humanId: owners[0].id, expiresAt: now + BOOTSTRAP_TTL_MS }))`. The brain honours a link once, and only while no device is enrolled (Task 7).
- `tailscaleOrigin` and `tailscaleServe` throw `Error("tailscale <args>: <stderr>")` on a non-zero exit.
- `packages/os/src/testing/config.ts`: replace the `TestOsConfig` interface with `export type TestOsConfig = OsConfig`, keep `DeepPartial` and the defaults, and return `OsConfigSchema.parse(merged)`; if one of plan 02's defaults fails the schema, fix that default in this file.
- Index: `// --- plan 03: brain core ---`, then `export * from "./config/schema.js"`, the paths exports except `writePrivateFile`, `ExecFn`, `execFileRunner`, `initOsHome`, `issueBootstrapLink`, `readBootstrap`, `BOOTSTRAP_TTL_MS`, the token primitives, `createHostSecret`, `readHostSecret`, `HostSecret`.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS, plan 02's tests included; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/package.json pnpm-lock.yaml packages/os/src/config packages/os/src/auth packages/os/src/testing/config.ts packages/os/src/index.ts packages/os/tests/config.test.ts packages/os/tests/config-init.test.ts packages/os/tests/helpers
git commit -m "feat(os): os.json schema and reload rules, the OS home, and swarm os init's files"
```

---

### Task 2: Actor, human sessions, instance and room tokens, lockdown

**Files:**
- Create: `packages/os/src/auth/actor.ts`, `packages/os/src/auth/sessions.ts`, `packages/os/src/auth/lockdown.ts`
- Modify: `packages/os/src/auth/tokens.ts` (add `mintInstanceToken`, `Tokens`, `REVOKED_TOKEN_HASH`, `TERMINAL_STATES`), `packages/os/src/index.ts`
- Test: `packages/os/tests/auth-credentials.test.ts`, `packages/os/tests/helpers/rows.ts`

**Interfaces:**
- Consumes: Task 1 (`newToken`, `hashToken`, `safeEqual`, `HostSecret`, `writePrivateFile`, `OsConfig`); plan 02 (`OsStore`, rows, `newId`, `Clock`, `Logger`).
- Produces:
```ts
// packages/os/src/auth/actor.ts
export type Actor = …;                                   // verbatim from 00-overview.md: human actors carry confirmer: boolean
export type HumanActor = Extract<Actor, { kind: "human" }>;
export const COS_SESSION_ID = "cos";                     // StepUp.sessionId of the chief of staff's step-ups
// packages/os/src/auth/sessions.ts
export const COOLDOWN_MS = 10 * 60_000;
export class Sessions {
  constructor(deps: { store: OsStore; clock: Clock; config: OsConfig });
  issueSession(input: { humanId: string; deviceId: string; address: string; client: "web" | "cli" }): Promise<{ token: string; session: SessionRow }>;   // passkeys "web", plan 08's terminal sign-in "cli"; client is logged, not stored
  verify(token: string): Promise<{ session: SessionRow; device: DeviceRow } | null>;
  verifyById(sessionId: string): Promise<{ session: SessionRow; device: DeviceRow } | null>;
  get(sessionId: string): Promise<SessionRow | null>;
  actorOf(session: SessionRow, device: DeviceRow, address?: string): HumanActor;
  revoke(sessionId: string): Promise<void>;
  revokeForDevice(deviceId: string): Promise<string[]>;
  revokeAll(): Promise<number>;
  coolDown(sessionId: string, until: Date): Promise<SessionRow>;     // never shortens an existing cool-down
  inCoolDown(session: SessionRow): boolean;
}
// packages/os/src/auth/tokens.ts (additions)
export const REVOKED_TOKEN_HASH = "revoked";
export const TERMINAL_STATES: ReadonlySet<InstanceRow["state"]>;     // exited, failed, login_expired
export function mintInstanceToken(_instanceId?: string): { token: string; tokenHash: string };   // pure; plan 04 writes tokenHash into the Instance row it creates
export class Tokens {
  constructor(deps: { store: OsStore; hostSecret: HostSecret; lockdown: Pick<Lockdown, "tokenEpoch"> });
  verifyInstanceToken(token: string): Promise<{ instanceId: string } | null>;
  instanceLive(instanceId: string): Promise<boolean>;                 // row exists, not terminal, token not revoked
  revokeInstanceToken(instanceId: string): Promise<void>;
  mintRoomToken(instanceId: string, participantId: string, roomId: string): string;
  verifyRoomToken(token: string): Promise<{ instanceId: string; participantId: string; roomId: string } | null>;
}
// packages/os/src/auth/lockdown.ts
export interface LockdownState { active: boolean; engagedAt: string | null; engagedBy: Actor["kind"] | null; tokenEpoch: number }
export class Lockdown {
  constructor(deps: { path: string; clock: Clock; log: Logger; revoke: () => Promise<void>; onChange?: (state: LockdownState) => void });
  static readState(path: string): LockdownState;                     // missing file → { active: false, engagedAt: null, engagedBy: null, tokenEpoch: 0 }
  static writeState(path: string, state: LockdownState): void;       // writePrivateFile
  load(): Promise<void>;                                              // reads the file; while active, runs revoke() again
  engage(by: Actor): Promise<void>;                                   // active, engagedAt, engagedBy, tokenEpoch + 1 (room tokens die), persist, revoke(), onChange
  release(by: Actor & { kind: "host" }): Promise<void>;               // any other caller throws Error("only the host can release a lockdown")
  active(): boolean;
  tokenEpoch(): number;
}
// packages/os/tests/helpers/rows.ts
export function deviceRow(o?: Partial<DeviceRow>): DeviceRow;         // makeRow("devices", …): dev-1 of part-owner, not a confirmer, active
export function instanceRow(o?: Partial<InstanceRow>): InstanceRow;   // makeRow("instances", …): inst-1, board-a, card-1, running, host "local", launcherHandle "4242", roomId room-1
```
- Room token, exactly: `payload = base64url(JSON.stringify({ i: instanceId, p: participantId, r: roomId, e: lockdown.tokenEpoch() }))`, `mac = base64url(HMAC-SHA256(hostSecret.deriveKey("swarm-os/room-token/v1/" + epoch), payload))`, token `room_<payload>.<mac>`. Verification recomputes the MAC under the current epoch (`safeEqual`), requires `e === tokenEpoch()`, and `instanceLive(i)`.
- Lockdown revokes sessions (its `revoke` callback, wired in Task 8) and room tokens (the epoch); instance tokens stay valid, so running instances keep reporting.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/auth-credentials.test.ts`**

Fixture per test: `store = new MemoryOsStore()`, `clock = testClock()`, `config = makeConfig({ owners: [{ id: "part-owner", name: "owner" }] })`, `await store.devices.put(deviceRow())`, `hostSecret = new HostSecret("secret-a")`, a `Lockdown` on a temp path whose `revoke` is `() => sessions.revokeAll().then(() => {})`.
```ts
it("creates a sess_ token, stores only its hash, and expires after session_ttl_hours", async () => {
  const { token, session } = await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-1", address: "100.64.0.7", client: "web" });
  expect(token).toMatch(/^sess_[A-Za-z0-9_-]{43}$/);
  expect(session).toMatchObject({ id: expect.stringMatching(/^sess-/), tokenHash: hashToken(token), address: "100.64.0.7",
    createdAt: T0.toISOString(), expiresAt: new Date(T0.getTime() + 24 * 3_600_000).toISOString(), revokedAt: null, cooldownUntil: null });
  expect((await sessions.verify(token))?.device.id).toBe("dev-1");
  clock.advance(24 * 3_600_000 + 1);
  expect(await sessions.verify(token)).toBeNull();
});
it("refuses revoked sessions, removed owners, revoked devices and other token kinds", async () => {
  const a = await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-1", address: "a", client: "web" });
  await sessions.revoke(a.session.id);
  expect(await sessions.verify(a.token)).toBeNull();
  const b = await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-1", address: "a", client: "web" });
  config.owners = [{ id: "part-other", name: "other" }];
  expect(await sessions.verify(b.token)).toBeNull();
  config.owners = [{ id: "part-owner", name: "owner" }];
  await store.devices.patch("dev-1", { revokedAt: T0.toISOString() });
  expect([await sessions.verify(b.token), await sessions.verify(b.token.replace("sess_", "inst_"))]).toEqual([null, null]);
});
it("revokes per device and all at once, and never shortens a cool-down", async () => {
  await store.devices.put(deviceRow({ id: "dev-2" }));
  const one = (await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-1", address: "a", client: "web" })).session;
  const two = (await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-2", address: "a", client: "web" })).session;
  expect(await sessions.revokeForDevice("dev-1")).toEqual([one.id]);
  expect(await sessions.revokeAll()).toBe(1);
  const s = (await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-2", address: "a", client: "web" })).session;
  await sessions.coolDown(s.id, new Date(T0.getTime() + COOLDOWN_MS));
  const after = await sessions.coolDown(s.id, new Date(T0.getTime() + 60_000));
  expect([after.cooldownUntil, sessions.inCoolDown(after), (await store.sessions.get(two.id))?.revokedAt]).toEqual([new Date(T0.getTime() + COOLDOWN_MS).toISOString(), true, T0.toISOString()]);
});
it("actorOf carries ids, the request address and the device's confirmer flag", async () => {
  const { session } = await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-1", address: "a", client: "web" });
  expect(sessions.actorOf(session, deviceRow({ confirmer: true }), "b")).toEqual(
    { kind: "human", humanId: "part-owner", sessionId: session.id, deviceId: "dev-1", address: "b", confirmer: true });
});
it("instance tokens are minted without the store, live in Instance.tokenHash, and stop at exit or revocation", async () => {
  const { token, tokenHash } = mintInstanceToken();
  expect([token, tokenHash]).toEqual([expect.stringMatching(/^inst_[A-Za-z0-9_-]{43}$/), hashToken(token)]);
  await store.instances.put(instanceRow({ id: "inst-1", tokenHash }));
  expect(await tokens.verifyInstanceToken(token)).toEqual({ instanceId: "inst-1" });
  for (const state of ["exited", "failed", "login_expired"] as const) {
    await store.instances.patch("inst-1", { state });
    expect(await tokens.verifyInstanceToken(token)).toBeNull();
  }
  await store.instances.patch("inst-1", { state: "running" });
  await tokens.revokeInstanceToken("inst-1");
  expect([(await store.instances.get("inst-1"))?.tokenHash, await tokens.verifyInstanceToken(token)]).toEqual([REVOKED_TOKEN_HASH, null]);
});
it("room tokens round-trip and fail when tampered, when the instance ends, or after a lockdown", async () => {
  await store.instances.put(instanceRow({ id: "inst-1" }));
  const t = tokens.mintRoomToken("inst-1", "part-w1", "room-1");
  expect(t).toMatch(/^room_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  expect(await tokens.verifyRoomToken(t)).toEqual({ instanceId: "inst-1", participantId: "part-w1", roomId: "room-1" });
  const mac = t.split(".")[1];
  const forged = Buffer.from(JSON.stringify({ i: "inst-1", p: "part-w1", r: "room-2", e: 0 })).toString("base64url");
  expect(await tokens.verifyRoomToken(`room_${forged}.${mac}`)).toBeNull();
  await lockdown.engage({ kind: "host" });
  expect(await tokens.verifyRoomToken(t)).toBeNull();
});
it("lockdown persists 0600 state, bumps the epoch, and only the host lifts it", async () => {
  expect(Lockdown.readState(lockPath)).toEqual({ active: false, engagedAt: null, engagedBy: null, tokenEpoch: 0 });
  await lockdown.engage({ kind: "human", humanId: "part-owner", sessionId: "sess-1", deviceId: "dev-1", address: "a", confirmer: false });
  expect(Lockdown.readState(lockPath)).toEqual({ active: true, engagedAt: T0.toISOString(), engagedBy: "human", tokenEpoch: 1 });
  expect(statSync(lockPath).mode & 0o777).toBe(0o600);
  await expect(lockdown.release({ kind: "cos" } as never)).rejects.toThrow(/only the host/);
  await lockdown.release({ kind: "host" });
  expect([lockdown.active(), lockdown.tokenEpoch()]).toEqual([false, 1]);
});
it("engaging revokes sessions and room tokens, keeps instance tokens and instances, and load() re-applies it", async () => {
  const { token: inst, tokenHash } = mintInstanceToken();
  await store.instances.put(instanceRow({ id: "inst-1", tokenHash }));
  const sess = (await sessions.issueSession({ humanId: "part-owner", deviceId: "dev-1", address: "a", client: "web" })).token;
  await lockdown.engage({ kind: "host" });
  expect(await sessions.verify(sess)).toBeNull();
  expect(await tokens.verifyInstanceToken(inst)).toEqual({ instanceId: "inst-1" });
  expect((await store.instances.get("inst-1"))?.state).toBe("running");
  const revoke = vi.fn(async () => {});
  await new Lockdown({ path: lockPath, clock, log: testLog(), revoke }).load();
  expect(revoke).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/auth-credentials.test.ts`
Expected: FAIL, `Cannot find module '../src/auth/sessions.js'`.

- [ ] **Step 3: Implement**

- `Sessions.verify`: `tokenKind(token) === "human"`, then `store.sessions.find({ tokenHash: hashToken(token) })`; refuse when `revokedAt` is set, `Date.parse(expiresAt) <= clock.now()`, the device is missing or revoked, or `humanId` is not in `config.owners` (read at call time, so an owner removed from `os.json` and reloaded loses access). `verifyById` applies the same checks by id. `revokeAll` patches every session whose `revokedAt` is null and returns the count.
- `Tokens.verifyInstanceToken`: `store.instances.find({ tokenHash: hashToken(token) })`, refusing `TERMINAL_STATES`.
- `Lockdown` keeps its state in memory after `load`, `engage` and `release`, writes the file before calling `revoke()`, and calls `onChange` after each change.
- Index: `Actor`, `HumanActor`, `COS_SESSION_ID`, `Sessions`, `COOLDOWN_MS`, `mintInstanceToken`, `Tokens`, `REVOKED_TOKEN_HASH`, `TERMINAL_STATES`, `Lockdown`, `LockdownState`.

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/auth packages/os/src/index.ts packages/os/tests/auth-credentials.test.ts packages/os/tests/helpers/rows.ts
git commit -m "feat(os): human sessions, instance and room tokens, and the host-only lockdown"
```

---

### Task 3: Refusal codes, HTTP router, request guards, idempotency, `ApiServer` with `GET /health`

**Files:**
- Create: `packages/os/src/security/refusals.ts`, `packages/os/src/api/errors.ts`, `packages/os/src/api/router.ts`, `packages/os/src/api/guards.ts`, `packages/os/src/api/server.ts`
- Test: `packages/os/tests/api-router.test.ts`, `packages/os/tests/api-server.test.ts`, `packages/os/tests/helpers/http.ts`
- Modify: `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`OsConfig`, `isLoopbackHost`), Task 2 (`Actor`); plan 02 (`Logger`, `Clock`).
- Produces:
```ts
// packages/os/src/security/refusals.ts (plan 09 imports and extends it; the names are fixed)
export type RefusalCode = "bad_request" | "unauthenticated" | "forbidden" | "provenance_mismatch" | "lockdown" | "stepup_failed"
  | "not_found" | "conflict" | "stepup_required" | "cooldown" | "limit" | "store_unavailable";
export const REFUSAL_STATUS: Readonly<Record<RefusalCode, number>>;   // 400 401 403 403 403 403 404 409 428 429 429 503
export function refusalBody(code: string, text: string, data?: Record<string, unknown>): { error: { code: string; message: string } & Record<string, unknown> };
export interface RefusedResult { ok: false; text: string; data: Record<string, unknown> & { code: RefusalCode } }   // plan 05's CommandResult, structurally
export function refuse(code: RefusalCode, text: string, data?: Record<string, unknown>): RefusedResult;             // { ok: false, text, data: { ...data, code } }
export function refusalCode(result: { ok: boolean; data?: unknown }): RefusalCode | null;                          // data.code when !ok and it is a RefusalCode, else null
export class GateRefusedError extends Error { constructor(readonly code: RefusalCode, message: string, readonly data?: Record<string, unknown>) }
// packages/os/src/api/errors.ts
export type ApiErrorCode = RefusalCode | "gone";                       // gone: 410, API only (an expired enrolment)
export const STATUS_OF: Readonly<Record<ApiErrorCode, number>>;        // REFUSAL_STATUS plus { gone: 410 }
export class ApiError extends Error { constructor(readonly code: ApiErrorCode, message: string, readonly extra?: Record<string, unknown>); readonly status: number }
// packages/os/src/api/router.ts
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export const MAX_BODY_BYTES = 1024 * 1024, IDEMPOTENCY_TTL_MS = 10 * 60_000;
export interface ApiRequest extends IncomingMessage { params: Record<string, string>; query: URLSearchParams; rawBody: Buffer; body: unknown;
  address: string; loopback: boolean; proxied: boolean; actor?: Actor; idempotencyKey?: string }
export type Handler = (req: ApiRequest, res: ServerResponse) => unknown | Promise<unknown>;
export class Router {
  add(method: HttpMethod, path: string, chain: Handler[]): void;     // a duplicate method + path throws
  match(method: string, pathname: string): { chain: Handler[]; params: Record<string, string> } | null;
  list(): Array<{ method: HttpMethod; path: string }>;
}
export function withStatus<T>(status: number, body: T): { status: number; body: T };   // a handler's return value that answers with another 2xx
export function parseBody<T>(schema: z.ZodType<T>, req: ApiRequest): T;   // ApiError("bad_request", …, { reason: "invalid_body", issues })
export function idempotent(): Handler;                                     // opt-in; place after requireAuth
// packages/os/src/api/guards.ts
export function clientAddress(req: IncomingMessage): { address: string; loopback: boolean; proxied: boolean };
export function isBrainHost(host: string | undefined, config: OsConfig, port: number): boolean;
export function publicOrigin(config: OsConfig): string;                   // new URL(public_url).origin
export function corsHeaders(origin: string): Record<string, string>;
// packages/os/src/api/server.ts
export interface HealthReport { ok: boolean; store: boolean; launcher: boolean; instances: number; uptimeSeconds: number; webhooksRejected: number }
export interface ApiServerDeps { config: OsConfig; log: Logger; clock: Clock; health: () => Promise<HealthReport> }
export class ApiServer {
  constructor(deps: ApiServerDeps);
  route(method: HttpMethod, path: string, ...chain: Handler[]): void;
  routes(): Array<{ method: HttpMethod; path: string }>;
  listen(opts?: { host?: string; port?: number }): Promise<{ port: number; url: string }>;   // default config.bind; url is always http://127.0.0.1:<port>
  onClose(cb: () => void | Promise<void>): void;                         // run before connections drop (the hub closes its streams here)
  close(): Promise<void>;                                                 // stop accepting, run onClose callbacks, await in-flight handlers (10 s cap), drop connections
  readonly port: number | null;
}
// packages/os/tests/helpers/http.ts
export function rawRequest(url: string, o?: { method?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean }): Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json(): any }>;
```
- The request pipeline, in this order:
  1. `Host` not accepted by `isBrainHost` (loopback names on the bound port, or `public_url`'s host and port) → 403 `forbidden`, `reason: "misdirected"`.
  2. An `Origin` other than `publicOrigin(config)` → 403 `forbidden`, `reason: "bad_origin"`; the public origin gets `corsHeaders`: `Access-Control-Allow-Origin: <origin>`, `-Allow-Credentials: true`, `-Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `-Allow-Headers: Content-Type, Authorization, X-Swarm-Os, X-Swarm-Os-Client, Idempotency-Key, Last-Event-ID`, `-Max-Age: 600`, `Vary: Origin`. `OPTIONS` from it answers 204; `OPTIONS` without `Origin` falls through to 404.
  3. `POST`/`PUT`/`PATCH`/`DELETE` under `/api/` carrying a `swarm_os_session` or `swarm_os_enrolment` cookie, no `Authorization` header and no `X-Swarm-Os: 1` → 403 `forbidden`, `reason: "csrf_header"`. Bearer callers and requests without those cookies are exempt, since CSRF needs a cookie; `/hooks/*` is outside `/api/`.
  4. No route → 404 `not_found`, `reason: "no_route"`; a segment that does not decode → 400 `bad_request`, `reason: "bad_path"`.
  5. A state-changing method's body is read to at most `MAX_BODY_BYTES`, declared or streamed (over → 400 `bad_request`, `reason: "payload_too_large"`); `application/json` or `*+json` is parsed (failure → 400, `reason: "invalid_json"`); any other type leaves `body` undefined and keeps `rawBody` (webhooks verify signatures over it).
  6. The chain runs in order. A handler returning a value other than `undefined` ends it: `withStatus` sends that status and body, anything else is `200` JSON as it is (bare arrays too). A handler that wrote headers (a stream) ends it. A thrown error whose `code` is a key of `STATUS_OF` (an `ApiError`, or a `GateRefusedError` with its `data`) answers that status with `refusalBody(code, message, extra ?? data)`; anything else is logged and answered `500 internal`. JSON responses carry `Cache-Control: no-store`.
- Matching: `:name` takes one decoded segment, a trailing `*` the rest as `params["*"]`; where two routes match, the first differing segment decides, static over `:param` over `*`.
- `idempotent()`: with `Idempotency-Key`, the key is scoped to `human:<sessionId>`, `instance:<id>`, `room:<participantId>`, `host` or `addr:<address>`, plus method and path. A repeat within `IDEMPOTENCY_TTL_MS` (by `deps.clock`) returns the first status and body with `Idempotent-Replay: true`; a repeat while the first is in flight waits for it; responses of 500 and above are not kept; at most 10,000 keys, oldest evicted.
- `clientAddress`: strip `::ffff:`; `loopback` for 127.0.0.0/8 and `::1`; a loopback peer with `X-Forwarded-For` or `Forwarded` is `proxied`, and its `address` is the first `X-Forwarded-For` entry; forwarding headers from any other peer are ignored.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/api-router.test.ts`:
```ts
it("matches decoded :params and a trailing *, preferring static over :param over *", () => {
  const r = new Router(); const h: Handler = () => "x";
  r.add("GET", "/api/rooms/:id/messages", [h]); r.add("GET", "/assets/*", [h]);
  r.add("POST", "/api/auth/devices/approve", [h]); r.add("POST", "/api/auth/devices/:id", [h]);
  expect(r.match("GET", "/api/rooms/room%201/messages")?.params).toEqual({ id: "room 1" });
  expect(r.match("GET", "/assets/js/app.js")?.params).toEqual({ "*": "js/app.js" });
  expect(r.match("POST", "/api/auth/devices/approve")?.params).toEqual({});
  expect(r.match("POST", "/api/rooms/room-1/messages")).toBeNull();
  expect(() => r.match("GET", "/api/rooms/%E0%A4%A/messages")).toThrow(ApiError);
  expect(() => r.add("GET", "/assets/*", [h])).toThrow(/already/);
});
it("keeps HEAD apart from GET", () => {
  const r = new Router(); r.add("HEAD", "/hooks/trello/:boardId", [() => ""]);
  expect([r.match("GET", "/hooks/trello/board-a"), r.match("HEAD", "/hooks/trello/board-a")?.params]).toEqual([null, { boardId: "board-a" }]);
});
it("uses the shared refusal codes and statuses, plus gone for the API", () => {
  expect(REFUSAL_STATUS).toEqual({ bad_request: 400, unauthenticated: 401, forbidden: 403, provenance_mismatch: 403, lockdown: 403,
    stepup_failed: 403, not_found: 404, conflict: 409, stepup_required: 428, cooldown: 429, limit: 429, store_unavailable: 503 });
  expect(STATUS_OF).toEqual({ ...REFUSAL_STATUS, gone: 410 });
  expect(refusalBody("limit", "too many", { limit: "open_enrolments" })).toEqual({ error: { code: "limit", message: "too many", limit: "open_enrolments" } });
  const r = refuse("limit", "limit registrable_roots", { limit: "registrable_roots" });
  expect([r, refusalCode(r), refusalCode({ ok: true, text: "done" })]).toEqual([{ ok: false, text: "limit registrable_roots", data: { limit: "registrable_roots", code: "limit" } }, "limit", null]);
});
```
`packages/os/tests/api-server.test.ts` (`new ApiServer({ config: makeConfig({ public_url: "https://brain.example.test" }), log: testLog(), clock, health })` on port 0):
```ts
it("serves GET /health from the provider without auth, uncached and without CORS", async () => {
  const r = await rawRequest(`${url}/health`);
  expect([r.status, r.json()]).toEqual([200, { ok: true, store: true, launcher: true, instances: 0, uptimeSeconds: 0, webhooksRejected: 0 }]);
  expect([r.headers["cache-control"], r.headers["access-control-allow-origin"]]).toEqual(["no-store", undefined]);
});
it("answers unknown paths, refusals, 2xx variants, bare arrays and crashes with the contract shapes", async () => {
  server.route("GET", "/api/t/fail", () => { throw new ApiError("cooldown", "wait", { cooldownUntil: "2026-10-25T12:10:00.000Z" }); });
  server.route("GET", "/api/t/gate", () => { throw new GateRefusedError("limit", "over the limit", { limit: "dispatches_per_hour" }); });
  server.route("GET", "/api/t/pending", () => withStatus(202, { pending: true }));
  server.route("GET", "/api/t/list", () => [{ id: "room-1" }]);
  server.route("GET", "/api/t/crash", () => { throw new Error("secret detail"); });
  expect((await rawRequest(`${url}/nope`)).json()).toEqual({ error: { code: "not_found", message: expect.any(String), reason: "no_route" } });
  const f = await rawRequest(`${url}/api/t/fail`);
  expect([f.status, f.json()]).toEqual([429, { error: { code: "cooldown", message: "wait", cooldownUntil: "2026-10-25T12:10:00.000Z" } }]);
  const g = await rawRequest(`${url}/api/t/gate`);
  expect([g.status, g.json()]).toEqual([429, { error: { code: "limit", message: "over the limit", limit: "dispatches_per_hour" } }]);
  const p = await rawRequest(`${url}/api/t/pending`);
  expect([p.status, p.json(), (await rawRequest(`${url}/api/t/list`)).json()]).toEqual([202, { pending: true }, [{ id: "room-1" }]]);
  const c = await rawRequest(`${url}/api/t/crash`);
  expect([c.status, c.json()]).toEqual([500, { error: { code: "internal", message: "internal error" } }]);
});
it("caps bodies at 1 MiB whether declared or streamed, and parses only JSON", async () => {
  server.route("POST", "/api/t/echo", (req) => ({ body: req.body ?? null, raw: req.rawBody.toString() }));
  const json = { "x-swarm-os": "1", "content-type": "application/json" };
  for (const chunked of [false, true]) {
    const r = await rawRequest(`${url}/api/t/echo`, { method: "POST", headers: json, body: Buffer.alloc(MAX_BODY_BYTES + 1, 97), chunked });
    expect([r.status, r.json().error.reason]).toEqual([400, "payload_too_large"]);
  }
  expect((await rawRequest(`${url}/api/t/echo`, { method: "POST", headers: json, body: "{" })).json().error).toMatchObject({ code: "bad_request", reason: "invalid_json" });
  const text = await rawRequest(`${url}/api/t/echo`, { method: "POST", headers: { "x-swarm-os": "1", "content-type": "text/plain" }, body: "hello" });
  expect(text.json()).toEqual({ body: null, raw: "hello" });
});
it("refuses foreign Host and Origin, answers the public origin's preflight, and needs X-Swarm-Os on cookie writes only", async () => {
  server.route("POST", "/api/t/write", () => ({ ok: true }));
  expect((await rawRequest(`${url}/health`, { headers: { host: "evil.example" } })).json().error.reason).toBe("misdirected");
  expect((await rawRequest(`${url}/health`, { headers: { origin: "https://evil.example" } })).json().error.reason).toBe("bad_origin");
  const pre = await rawRequest(`${url}/api/t/write`, { method: "OPTIONS", headers: { origin: "https://brain.example.test" } });
  expect([pre.status, pre.headers["access-control-allow-origin"]]).toEqual([204, "https://brain.example.test"]);
  const cookieWrite = await rawRequest(`${url}/api/t/write`, { method: "POST", body: "{}", headers: { "content-type": "application/json", cookie: "swarm_os_session=x" } });
  expect(cookieWrite.json().error).toMatchObject({ code: "forbidden", reason: "csrf_header" });
  const bearerWrite = await rawRequest(`${url}/api/t/write`, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer inst_x" } });
  const plainWrite = await rawRequest(`${url}/api/t/write`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  expect([bearerWrite.status, plainWrite.status]).toEqual([200, 200]);
});
it("replays an idempotent response for 10 minutes, per key, and waits for one in flight", async () => {
  let runs = 0;
  server.route("POST", "/api/t/once", idempotent(), async () => { runs += 1; await sleep(20); return { runs }; });
  const send = (key: string) => rawRequest(`${url}/api/t/once`, { method: "POST", body: "{}",
    headers: { "x-swarm-os": "1", "content-type": "application/json", "idempotency-key": key } });
  const [a, b] = await Promise.all([send("k1"), send("k1")]);
  expect([a.json(), b.json(), runs, b.headers["idempotent-replay"]]).toEqual([{ runs: 1 }, { runs: 1 }, 1, "true"]);
  await send("k2"); expect(runs).toBe(2);
  clock.advance(IDEMPOTENCY_TTL_MS + 1); await send("k1"); expect(runs).toBe(3);
});
it("reads the client address from a loopback proxy's first X-Forwarded-For entry only", () => {
  const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;
  expect(clientAddress(req("::ffff:127.0.0.1", "100.64.0.7, 203.0.113.9"))).toEqual({ address: "100.64.0.7", loopback: true, proxied: true });
  expect(clientAddress(req("100.64.0.8", "127.0.0.1"))).toEqual({ address: "100.64.0.8", loopback: false, proxied: false });
  expect(clientAddress(req("::1"))).toEqual({ address: "::1", loopback: true, proxied: false });
});
it("close() lets an in-flight handler answer before it resolves", async () => {
  let release!: () => void;
  server.route("GET", "/api/t/slow", () => new Promise((r) => { release = () => r({ done: true }); }));
  const pending = rawRequest(`${url}/api/t/slow`);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const closing = server.close(); release();
  expect((await pending).json()).toEqual({ done: true }); await closing;
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/api-router.test.ts tests/api-server.test.ts`
Expected: FAIL, `Cannot find module '../src/api/router.js'`.

- [ ] **Step 3: Implement the five files with the pipeline and rules above**

`ApiServer` registers `GET /health` itself (`() => deps.health()`), builds each `ApiRequest` from `clientAddress(req)` and `new URL(req.url, "http://localhost")`, and tracks in-flight handler promises for `close()`. Index: everything in Interfaces except the test helper; `RefusalCode`, `REFUSAL_STATUS`, `refuse`, `refusalCode`, `GateRefusedError`, `RefusedResult` and `refusalBody` too.

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/security/refusals.ts packages/os/src/api packages/os/src/index.ts packages/os/tests/api-router.test.ts packages/os/tests/api-server.test.ts packages/os/tests/helpers/http.ts
git commit -m "feat(os): brain HTTP server with the shared refusal codes, CORS and CSRF guards, idempotency"
```

---

### Task 4: `requireAuth` over cookie and bearer credentials, `AuthHooks`

**Files:**
- Create: `packages/os/src/auth/hooks.ts`, `packages/os/src/api/auth-middleware.ts`
- Test: `packages/os/tests/api-auth.test.ts`, `packages/os/tests/helpers/api-fixture.ts`
- Modify: `packages/os/src/api/server.ts` (`ApiServerDeps.authenticator?: Authenticator`, set on every request), `packages/os/src/api/router.ts` (`ApiRequest.authenticator?: Authenticator`), `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Task 2 (`Sessions`, `Tokens`, `Lockdown`, `COOLDOWN_MS`, `Actor`), Task 1 (`HostSecret`, `tokenKind`), Task 3 (`ApiServer`, `Handler`, `ApiError`).
- Produces:
```ts
// packages/os/src/auth/hooks.ts
export const STEPUP_FAILURES_TO_COOL = 2;
export interface AuthHooks {
  onNewAddress(session: SessionRow, address: string): Promise<void>;
  onStepUpFailed(stepUp: StepUpRow | null, by: Actor): Promise<void>;
}   // one shared object; plan 05 and plan 09 replace both methods in place with Tripwires-backed ones
export function defaultAuthHooks(deps: { sessions: Sessions; clock: Clock;
  publish?: (visibleTo: (a: Actor) => boolean, event: { type: string; payload: unknown }) => unknown }): AuthHooks;
// packages/os/src/api/auth-middleware.ts
export type { Actor } from "../auth/actor.js";                    // plan 09 imports Actor from here
export const SESSION_COOKIE = "swarm_os_session";
export type AuthKind = Actor["kind"];                            // "cos" is accepted as a name and never produced by a credential
export class Authenticator {
  constructor(deps: { sessions: Sessions; tokens: Tokens; hostSecret: HostSecret; lockdown: Lockdown; hooks: AuthHooks });
  authenticate(cred: { bearer?: string; cookie?: string }, kinds: readonly AuthKind[], from: { address: string; loopback: boolean; proxied: boolean }): Promise<Actor>;
  stillValid(actor: Actor): Promise<boolean>;
}
export function credentialsFrom(req: IncomingMessage): { bearer?: string; cookie?: string };
export function requireAuth(kind: AuthKind | readonly AuthKind[]): Handler;   // sets req.actor
export function cookieSecure(config: OsConfig): boolean;        // false only for a loopback bind.host with an http: public_url
export function sessionCookie(token: string, config: OsConfig, maxAgeSeconds: number): string;
export function clearSessionCookie(config: OsConfig): string;
// packages/os/tests/helpers/api-fixture.ts
export async function apiFixture(o?: { config?: DeepPartial<OsConfig> }): Promise<{ paths: OsPaths; config: OsConfig; clock: FakeClock; log: ReturnType<typeof testLog>;
  store: MemoryOsStore; hostSecret: HostSecret; sessions: Sessions; tokens: Tokens; lockdown: Lockdown; hooks: AuthHooks; authenticator: Authenticator;
  server: ApiServer; url: string;
  human(o?: { confirmer?: boolean; address?: string; deviceId?: string }): Promise<{ token: string; sessionId: string; deviceId: string }>;
  request(method: string, path: string, o?: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; headers: Headers; json: any }>;
  close(): Promise<void> }>;   // request() adds X-Swarm-Os: 1 to writes; human() creates a device and a session at 127.0.0.1
```
- `authenticate`, in order: the bearer if present, else a cookie value starting `sess_` (other cookie values are ignored); none → 401 `unauthenticated`, `reason: "missing_credentials"`. `tokenKind` null → 401, `reason: "token_invalid"`; a kind not in `kinds` → 403 `forbidden`, `reason: "wrong_actor_kind"`. While `lockdown.active()`, human and room actors → 403 `lockdown` (host and instance pass, so running instances keep reporting). Host: `from.loopback && !from.proxied`, else 403 `forbidden`, `reason: "host_not_loopback"`; `hostSecret.verifyBearer`, else 401 `token_invalid`. Human: `sessions.verify`, else 401, `reason: "session_invalid"`; when `session.address !== from.address`, `await hooks.onNewAddress(session, from.address)` and continue with the request's address. Instance and room: the `Tokens` verifiers, else 401 `token_invalid`.
- `stillValid` (the hub's keepalive check): during a lockdown only the host; human → `sessions.verifyById` non-null; instance and room → `tokens.instanceLive`; host and cos → true.
- `defaultAuthHooks`: `onNewAddress` cools that session down for `COOLDOWN_MS`; `onStepUpFailed` counts one failure for the step-up's requesting session (when it is a real session) and one for the presenting human's session, never the host, and cools a session down once it has `STEPUP_FAILURES_TO_COOL` failures within `COOLDOWN_MS` (spec: "two failed step-up codes within ten minutes"); the counts live in memory, since plan 09's Tripwires replace the hook. Each cool-down publishes `cooldown { cooldownUntil }` to that session.
- Cookie text: `swarm_os_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<n>`, plus `; Secure` when `cookieSecure(config)`; clearing writes an empty value and `Max-Age=0`.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/api-auth.test.ts`**

The fixture adds `GET /api/t/whoami` with `requireAuth(["human", "instance", "room", "host"])` answering `req.actor`, and `GET /api/t/human` with `requireAuth("human")`.
```ts
it("needs a credential and names what was wrong with it", async () => {
  expect((await f.request("GET", "/api/t/whoami")).json).toEqual({ error: { code: "unauthenticated", message: expect.any(String), reason: "missing_credentials" } });
  expect((await f.request("GET", "/api/t/whoami", { token: "nonsense" })).json.error.reason).toBe("token_invalid");
});
it("accepts the session cookie, prefers a bearer, and ignores a cookie that is not a session", async () => {
  const h = await f.human();
  expect((await f.request("GET", "/api/t/whoami", { cookie: `${SESSION_COOKIE}=${h.token}` })).json).toEqual(
    { kind: "human", humanId: "part-owner", sessionId: h.sessionId, deviceId: h.deviceId, address: "127.0.0.1", confirmer: false });
  const { token: inst, tokenHash } = mintInstanceToken();
  await f.store.instances.put(instanceRow({ id: "inst-1", tokenHash }));
  expect((await f.request("GET", "/api/t/whoami", { token: inst, cookie: `${SESSION_COOKIE}=${h.token}` })).json).toEqual({ kind: "instance", instanceId: "inst-1" });
  expect((await f.request("GET", "/api/t/whoami", { cookie: `${SESSION_COOKIE}=${inst}` })).status).toBe(401);
  expect((await f.request("GET", "/api/t/human", { token: inst })).json.error).toMatchObject({ code: "forbidden", reason: "wrong_actor_kind" });
});
it("treats the host secret as the host only from loopback without a proxy header", async () => {
  expect((await f.request("GET", "/api/t/whoami", { token: f.hostSecret.bearer() })).json).toEqual({ kind: "host" });
  const viaProxy = await f.request("GET", "/api/t/whoami", { token: f.hostSecret.bearer(), headers: { "x-forwarded-for": "100.64.0.9" } });
  expect(viaProxy.json.error).toMatchObject({ code: "forbidden", reason: "host_not_loopback" });
  expect((await f.request("GET", "/api/t/whoami", { token: "host_wrong" })).json.error.reason).toBe("token_invalid");
});
it("during a lockdown refuses humans, and lets the host and running instances through", async () => {
  const h = await f.human();
  const { token: inst, tokenHash } = mintInstanceToken();
  await f.store.instances.put(instanceRow({ id: "inst-1", tokenHash }));
  await f.lockdown.engage({ kind: "host" });
  expect((await f.request("GET", "/api/t/whoami", { token: h.token })).json.error.code).toBe("lockdown");
  expect([(await f.request("GET", "/api/t/whoami", { token: f.hostSecret.bearer() })).status, (await f.request("GET", "/api/t/whoami", { token: inst })).status]).toEqual([200, 200]);
});
it("lets a session continue from a new address but cools it down for ten minutes", async () => {
  const h = await f.human({ address: "100.64.0.7" });
  expect((await f.request("GET", "/api/t/whoami", { token: h.token })).json.address).toBe("127.0.0.1");
  expect((await f.store.sessions.get(h.sessionId))?.cooldownUntil).toBe(new Date(T0.getTime() + COOLDOWN_MS).toISOString());
});
it("stillValid follows revocation, lockdown and instance exit", async () => {
  const h = await f.human();
  const actor = (await f.request("GET", "/api/t/whoami", { token: h.token })).json as Actor;
  await f.store.instances.put(instanceRow({ id: "inst-2", state: "exited" }));
  expect([await f.authenticator.stillValid(actor), await f.authenticator.stillValid({ kind: "instance", instanceId: "inst-2" })]).toEqual([true, false]);
  await f.sessions.revoke(h.sessionId);
  expect(await f.authenticator.stillValid(actor)).toBe(false);
  await f.lockdown.engage({ kind: "host" });
  expect(await f.authenticator.stillValid({ kind: "host" })).toBe(true);
});
it("writes the session cookie with Secure unless the brain is loopback over http", () => {
  const https = makeConfig({ public_url: "https://brain.example.test" });
  const local = makeConfig({ public_url: "http://localhost:3200", bind: { host: "127.0.0.1", port: 3200 } });
  expect(sessionCookie("sess_x", https, 86400)).toBe("swarm_os_session=sess_x; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400; Secure");
  expect(sessionCookie("sess_x", local, 86400)).toBe("swarm_os_session=sess_x; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400");
  expect(clearSessionCookie(https)).toBe("swarm_os_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/api-auth.test.ts`
Expected: FAIL, `Cannot find module '../src/api/auth-middleware.js'`.

- [ ] **Step 3: Implement `hooks.ts` and `auth-middleware.ts` with the rules above, wire `authenticator` into `ApiServer` (a route using `requireAuth` on a server built without one is a wiring bug and answers 500), and export everything in Interfaces except the fixture from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/auth/hooks.ts packages/os/src/api packages/os/src/index.ts packages/os/tests/api-auth.test.ts packages/os/tests/helpers/api-fixture.ts
git commit -m "feat(os): requireAuth over the session cookie and bearer tokens, with new-address cool-down"
```

---

### Task 5: Server-Sent Events: `parseSse`, `openEventStream`, `EventHub`, the stream routes, `FakeEventHub`

**Files:**
- Create: `packages/os/src/sse/client.ts`, `packages/os/src/sse/hub.ts`, `packages/os/src/api/streams.ts`, `packages/os/src/testing/fake-event-hub.ts`
- Test: `packages/os/tests/sse-parse.test.ts`, `packages/os/tests/sse-hub.test.ts`, `packages/os/tests/api-streams.test.ts`
- Modify: `packages/os/src/testing/index.ts` (one line: `export { FakeEventHub } from "./fake-event-hub.js";`), `packages/os/tests/helpers/http.ts` (add `rawStream`), `packages/os/tests/helpers/api-fixture.ts` (adds `hub`, with `validate: authenticator.stillValid`, and the stream routes), `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Task 2 (`Actor`, `Sessions`, `Lockdown`), Task 3 (`ApiServer`, `onClose`), Task 4 (`requireAuth`, `Authenticator`); plan 02 (`Clock`, `RoomRow`, `InstanceRow`, `ResourceSnapshotRow`, `OsStore`).
- Produces (the overview's code block, plus the additions marked +):
```ts
// packages/os/src/sse/client.ts
export interface SseParseState { buffer: string; lastId: number | null; eventType: string; data: string[]; retry: number | null }
export function initialSseState(lastId?: number | null): SseParseState;                                       // +
export function parseSse(chunk: string, state: SseParseState): { events: Array<{ id: number | null; type: string; data: string }>; state: SseParseState };
export class EventStreamAuthError extends Error { constructor(readonly status: 401 | 403) }                     // +
export function nextBackoff(attempt: number, range: [number, number]): number;                                  // + min(range[1], range[0] * 2 ** attempt)
export interface EventStreamHandle { close(): void; readonly lastEventId: number | null }
export function openEventStream(url: string, opts: { headers: Record<string, string>; lastEventId?: number; onEvent: (e: { id: number | null; type: string; data: unknown }) => void;
  onOpen?: () => void; onError?: (err: Error) => void; fetchImpl?: typeof fetch; backoffMs?: [number, number] }): EventStreamHandle;
// packages/os/src/sse/hub.ts
export interface HubEvent { id: number; type: string; payload: unknown; visibleTo: (actor: Actor) => boolean }
export type EventPublisher = Pick<EventHub, "publish">;                                                         // +
export const RING_SIZE = 10_000, KEEPALIVE_MS = 15_000, SSE_RETRY_MS = 3_000;
export function eventRoom(event: { type: string; payload: unknown }): string | null;                            // +
export class EventHub {
  constructor(opts?: { ringSize?: number; keepaliveMs?: number; clock?: Clock; validate?: (actor: Actor) => Promise<boolean>; seqFile?: string });   // + validate, seqFile
  attach(req: IncomingMessage, res: ServerResponse, actor: Actor, opts: { rooms: string[] | "all"; lastEventId?: number; hello: () => Promise<unknown> }): () => void;
  publish(visibleTo: HubEvent["visibleTo"], event: { type: string; payload: unknown }): HubEvent;
  replayAfter(id: number, actor: Actor): HubEvent[] | "gap";
  closeWhere(filter: (actor: Actor) => boolean): number;                                                        // +
  closeAll(): void;                                                                                             // +
  latestId(): number;                                                                                           // +
  flush(): void;                                                                                                // + writes seqFile now
}
// packages/os/src/api/streams.ts
export type HelloProvider = (actor: Actor) => Promise<{ rooms: RoomRow[]; instances: InstanceRow[]; resources: unknown | null }>;
export function defaultHello(store: OsStore): HelloProvider;   // human or host: every room, every non-terminal instance, the latest ResourceSnapshot's parsed snapshotJson; otherwise empty
export interface StreamRoutes { setHello(provider: HelloProvider): void }                                      // plan 05 scopes rooms with visibleRooms
export interface HelloStepUp { stepUpId: string; command: string[]; expiresAt: string; code: string }   // one entry of plan 08's hello.stepUps
export function registerStreamRoutes(server: ApiServer, deps: { hub: EventHub; store: OsStore; sessions: Sessions; lockdown: Lockdown;
  pendingStepUps?: (actor: Actor) => Promise<HelloStepUp[]> }): StreamRoutes;   // Task 8 supplies pendingStepUps
// packages/os/src/testing/fake-event-hub.ts
export class FakeEventHub implements EventPublisher {
  published: HubEvent[];
  publish(visibleTo: HubEvent["visibleTo"], event: { type: string; payload: unknown }): HubEvent;
  seenBy(actor: Actor): HubEvent[];                                           // published events visible to actor, in order
  attachFake(actor: Actor, onEvent: (e: HubEvent) => void): () => void;       // synchronous delivery of later visible events
  replayAfter(id: number, actor: Actor): HubEvent[] | "gap";
  closeWhere(filter: (actor: Actor) => boolean): number;
}
// packages/os/tests/helpers/http.ts (addition)
export function rawStream(url: string, o: { headers?: Record<string, string>; ms: number }): Promise<{ status: number; headers: IncomingHttpHeaders; text: string; ended: boolean }>;   // reads for ms, then aborts; ended: the server closed it first
```
- Wire format: `attach` writes status 200 with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `Connection: keep-alive`, calls `flushHeaders()`, `socket.setNoDelay(true)` and `socket.setTimeout(0)`, then `retry: 3000\n\n`, then `id: <lastEventId ?? latestId()>\nevent: hello\ndata: <json>\n\n`, then the replay (`id:`/`event:`/`data:` per event; `"gap"` → `id: <latestId()>\nevent: gap\ndata: {}\n\n`), then live events. The stream is registered before `hello()` is awaited; live events arriving meanwhile are queued and written after the replay, skipping ids already written. `data` is one `JSON.stringify` line. Every `keepaliveMs` the hub writes `: keepalive\n\n` to each stream, then closes those whose `validate(actor)` is false. A stream whose `res.writableLength` passes 1 MiB is closed (the client resumes with `Last-Event-ID`). The keepalive timer is `unref()`ed and runs only while streams exist.
- Ids: one sequence per brain. With `seqFile`, the first id is the stored number + 1 (1 when the file is missing or unreadable), and the latest id is written to it at most once a second (an unref'd timer after a publish) and by `flush()`; without one, ids start at 1. The ring keeps the last `ringSize`. `replayAfter(id)`: `id > latestId()` or `id < oldest - 1` → `"gap"` (so an id from before a restart gets `gap`), else the events after `id` that `visibleTo(actor)`.
- `rooms` filter: `eventRoom` is `payload.message.roomId` for `message`, `payload.question.roomId` for `question`, and `null` for every other type; an event whose `eventRoom` is non-null reaches a stream only when its room is listed or the stream has `"all"`; room-less events (`instance`, `decision`, `resources`, `stepup`, `cooldown`, `lockdown`, `command`) are filtered by `visibleTo` alone.
- `parseSse` follows the SSE spec: lines end in `\n`, `\r\n` or `\r`; a trailing partial line stays in `buffer`; `:` lines are comments; `field: value` drops one leading space; `id` (without NUL) sets `lastId` (`Number`, `null` when not a number); `retry` digits set `retry`; a blank line dispatches when `data` is non-empty (`type` defaults to `"message"`, `data` lines joined with `\n`, `id` = `lastId`) and resets `eventType` and `data`.
- `openEventStream`: `fetch(url, { headers: { ...headers, Accept: "text/event-stream", "Last-Event-ID": <last> when known }, signal })`; 401 or 403 → `onError(new EventStreamAuthError(status))` and stop; another failure, a non-200 or the stream ending → `onError` and reconnect after `nextBackoff(attempt, backoffMs ?? [1000, 30000])`, `attempt` reset after each successful open; `data` is `JSON.parse`d (the raw string when that fails); `close()` aborts and stops reconnecting.
- Routes: `GET /api/stream` → `requireAuth(["human", "host"])`; `rooms` query `all` (default) or a comma list of at most 200 non-empty ids (else 400 `bad_request`); `lastEventId` from the `Last-Event-ID` header; `hello()` returns `{ actor, ...await provider(actor), cooldownUntil? (a human in cool-down), lockdown: lockdown.active(), stepUps? }`, where `stepUps` (plan 08, so a `swarm top` opened after a request still sees its code) is `await pendingStepUps(actor)` for the host and for humans on confirmer devices, and absent for everyone else or without the dep. `GET /api/instances/:id/stream` → `requireAuth("instance")`; during a lockdown 403 `lockdown`; an id other than the token's → 403 `forbidden`, `reason: "not_own_instance"`; `hello()` returns `{}`. `server.onClose(() => hub.closeAll())`.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/sse-parse.test.ts`:
```ts
const parseAll = (chunks: string[], s = initialSseState()) => chunks.reduce((acc, c) => {
  const r = parseSse(c, acc.state); return { events: [...acc.events, ...r.events], state: r.state }; },
  { events: [] as Array<{ id: number | null; type: string; data: string }>, state: s });
it("parses an event split mid-line and mid-event across chunks", () => {
  expect(parseAll(["id: 17\nev", "ent: message\nda", "ta: {\"a\":1}\n", "\n"]).events).toEqual([{ id: 17, type: "message", data: "{\"a\":1}" }]);
});
it("handles CRLF, comments, multi-line data, the default type, inherited ids and retry", () => {
  const r = parseAll([": keepalive\r\n\r\nid: 5\r\ndata: a\r\ndata: b\r\n\r\ndata: c\n\nretry: 3000\n\n"]);
  expect(r.events).toEqual([{ id: 5, type: "message", data: "a\nb" }, { id: 5, type: "message", data: "c" }]);
  expect([r.state.lastId, r.state.retry]).toEqual([5, 3000]);
});
it("dispatches nothing for an event without data, and keeps a partial line", () => {
  const r = parseAll(["event: hello\n\nid: 9\ndata: {\"x\""]);
  expect([r.events, r.state.buffer]).toEqual([[], "data: {\"x\""]);
});
it("backs off exponentially between the bounds", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map((a) => nextBackoff(a, [1000, 30000]))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});
```
`packages/os/tests/sse-hub.test.ts` (per test: a raw node `http` server on port 0 at `url` whose handler pushes the request's `last-event-id` header into `lastEventIds` and attaches `{ kind: "host" }` to `hub = new EventHub({ ringSize: 3, keepaliveMs: 50, validate: async () => valid })`, with `rooms` from the `rooms` query (`"all"` when absent), `lastEventId` from that header and `hello: async () => ({})`; `valid` starts `true`; `refusing` is a second server at `refusing.url` that answers every request 401 and counts them in `refusing.requests`):
```ts
it("writes the SSE headers, retry and hello first, then visible events with rising ids", async () => {
  const head = await rawStream(url, { ms: 50 });
  expect(head.headers).toMatchObject({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  expect(head.text.startsWith("retry: 3000\n\nid: 0\nevent: hello\n")).toBe(true);
  const seen: Array<{ id: number | null; type: string }> = [];
  const s = openEventStream(url, { headers: {}, onEvent: (e) => seen.push(e) });
  await vi.waitFor(() => expect(seen[0]?.type).toBe("hello"));
  const first = hub.publish(() => true, { type: "instance", payload: { instance: { id: "inst-1" } } });
  hub.publish(() => false, { type: "instance", payload: { instance: { id: "inst-2" } } });
  hub.publish(() => true, { type: "decision", payload: { decision: { id: "dec-1" } } });
  await vi.waitFor(() => expect(seen.map((e) => e.type)).toEqual(["hello", "instance", "decision"]));
  expect([first.id, seen[1].id, seen[2].id]).toEqual([1, 1, 3]);
  s.close();
});
it("filters room events by the stream's rooms", async () => {
  const seen: Array<{ type: string; data: any }> = [];
  const s = openEventStream(`${url}?rooms=room-1`, { headers: {}, onEvent: (e) => seen.push(e) });
  await vi.waitFor(() => expect(seen[0]?.type).toBe("hello"));
  hub.publish(() => true, { type: "message", payload: { message: { id: "msg-2", roomId: "room-2" } } });
  hub.publish(() => true, { type: "message", payload: { message: { id: "msg-1", roomId: "room-1" } } });
  hub.publish(() => true, { type: "instance", payload: { instance: { id: "inst-1" } } });
  await vi.waitFor(() => expect(seen.map((e) => e.type)).toEqual(["hello", "message", "instance"]));
  expect(seen[1].data.message.id).toBe("msg-1");
  expect([eventRoom({ type: "question", payload: { question: { roomId: "room-3" } } }), eventRoom({ type: "stepup", payload: {} })]).toEqual(["room-3", null]);
  s.close();
});
it("replays after Last-Event-ID and sends gap for an id older than the ring", () => {
  const a = hub.publish(() => true, { type: "x", payload: {} }); hub.publish(() => true, { type: "x", payload: {} });
  const c = hub.publish(() => true, { type: "x", payload: {} });
  expect((hub.replayAfter(a.id, { kind: "host" }) as HubEvent[]).map((e) => e.id)).toEqual([a.id + 1, c.id]);
  for (let i = 0; i < 3; i += 1) hub.publish(() => true, { type: "x", payload: {} });
  expect(hub.replayAfter(a.id, { kind: "host" })).toBe("gap");
});
it("keeps ids rising across a restart through seqFile, so an id from before it gets gap", () => {
  const seqFile = join(tempOsHome().home, "event-seq");
  const before = new EventHub({ seqFile });
  const first = before.publish(() => true, { type: "x", payload: {} }), last = before.publish(() => true, { type: "x", payload: {} });
  before.flush();
  const after = new EventHub({ seqFile });
  expect(after.publish(() => true, { type: "x", payload: {} }).id).toBe(last.id + 1);
  expect(after.replayAfter(first.id, { kind: "host" })).toBe("gap");
});
it("sends a keepalive comment and closes streams that stop validating", async () => {
  const open = await rawStream(url, { ms: 120 });
  expect([open.ended, open.text]).toEqual([false, expect.stringContaining(": keepalive\n\n")]);
  valid = false;
  const cut = await rawStream(url, { ms: 300 });
  expect([cut.ended, cut.text]).toEqual([true, expect.stringContaining(": keepalive\n\n")]);
});
it("reconnects with Last-Event-ID after a drop, and stops on 401", async () => {
  const seen: Array<{ id: number | null; type: string }> = [];
  const s = openEventStream(url, { headers: {}, onEvent: (e) => seen.push(e), backoffMs: [10, 10] });
  await vi.waitFor(() => expect(seen[0]?.type).toBe("hello"));
  const ev = hub.publish(() => true, { type: "instance", payload: {} });
  await vi.waitFor(() => expect(seen.at(-1)?.id).toBe(ev.id));
  expect(hub.closeWhere(() => true)).toBe(1);
  await vi.waitFor(() => expect(lastEventIds).toEqual([undefined, String(ev.id)]));
  s.close();
  const errors: Error[] = [];
  const r = openEventStream(refusing.url, { headers: {}, onEvent: () => {}, onError: (e) => errors.push(e), backoffMs: [10, 10] });
  await vi.waitFor(() => expect(errors[0]).toBeInstanceOf(EventStreamAuthError));
  await new Promise((done) => setTimeout(done, 50));
  expect([refusing.requests, errors.length]).toEqual([1, 1]);
  r.close();
});
it("FakeEventHub records events and delivers them to fake actors", () => {
  const fake = new FakeEventHub(); const got: string[] = [];
  fake.attachFake({ kind: "host" }, (e) => got.push(e.type));
  fake.publish((a) => a.kind === "host", { type: "stepup", payload: {} });
  fake.publish((a) => a.kind === "instance", { type: "command", payload: {} });
  expect([got, fake.published.length, fake.seenBy({ kind: "host" }).map((e) => e.type)]).toEqual([["stepup"], 2, ["stepup"]]);
});
```
`packages/os/tests/api-streams.test.ts` (the Task 4 fixture, its hub at `keepaliveMs: 100`, with the stream routes):
```ts
it("opens a human stream with hello, and refuses instance tokens there", async () => {
  const h = await f.human({ confirmer: true }); const seen: any[] = [];
  const s = openEventStream(`${f.url}/api/stream?rooms=all`, { headers: { Authorization: `Bearer ${h.token}` }, onEvent: (e) => seen.push(e) });
  await vi.waitFor(() => expect(seen[0]).toMatchObject({ type: "hello", data: { actor: { kind: "human", confirmer: true },
    rooms: [], instances: [], resources: null, lockdown: false } }));
  s.close();
  const { token, tokenHash } = mintInstanceToken();
  await f.store.instances.put(instanceRow({ id: "inst-1", tokenHash }));
  expect((await f.request("GET", "/api/stream", { token })).status).toBe(403);
});
it("serves an instance its own command stream only, and none during a lockdown", async () => {
  const one = mintInstanceToken(), two = mintInstanceToken();
  await f.store.instances.put(instanceRow({ id: "inst-1", tokenHash: one.tokenHash }));
  await f.store.instances.put(instanceRow({ id: "inst-2", tokenHash: two.tokenHash }));
  const seen: any[] = [];
  const s = openEventStream(`${f.url}/api/instances/inst-1/stream`, { headers: { Authorization: `Bearer ${one.token}` }, onEvent: (e) => seen.push(e) });
  await vi.waitFor(() => expect(seen[0]).toMatchObject({ type: "hello", data: {} }));
  f.hub.publish((a) => a.kind === "instance" && a.instanceId === "inst-1", { type: "command", payload: { argv: ["pause"] } });
  await vi.waitFor(() => expect(seen[1]).toMatchObject({ type: "command", data: { argv: ["pause"] } }));
  s.close();
  expect((await f.request("GET", "/api/instances/inst-2/stream", { token: one.token })).json.error.reason).toBe("not_own_instance");
  await f.lockdown.engage({ kind: "host" });
  expect((await f.request("GET", "/api/instances/inst-1/stream", { token: one.token })).json.error.code).toBe("lockdown");
});
it("refuses a revoked session's next request at once and closes its open stream within one keepalive", async () => {
  const h = await f.human(); const errors: Error[] = []; let opened = 0;
  const s = openEventStream(`${f.url}/api/stream`, { headers: { Authorization: `Bearer ${h.token}` }, onEvent: () => {},
    onOpen: () => { opened += 1; }, onError: (e) => errors.push(e), backoffMs: [10, 10] });
  await vi.waitFor(() => expect(opened).toBe(1));
  await f.store.sessions.patch(h.sessionId, { revokedAt: T0.toISOString() });      // revoked behind the API's back: nothing calls closeWhere
  expect((await f.request("GET", "/api/t/human", { token: h.token })).status).toBe(401);
  await vi.waitFor(() => expect(errors.some((e) => e instanceof EventStreamAuthError)).toBe(true), { timeout: 250 });
  expect(f.hub.closeWhere(() => true)).toBe(0);                                     // nothing is left open
  s.close();
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/sse-parse.test.ts tests/sse-hub.test.ts tests/api-streams.test.ts`
Expected: FAIL, `Cannot find module '../src/sse/client.js'`.

- [ ] **Step 3: Implement `client.ts`, `hub.ts`, `streams.ts` and `FakeEventHub` with the rules above; export from the index block everything in Interfaces except `FakeEventHub` (exported from `src/testing/index.ts`) and the test helper**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/sse packages/os/src/api/streams.ts packages/os/src/testing packages/os/src/index.ts packages/os/tests/sse-parse.test.ts packages/os/tests/sse-hub.test.ts packages/os/tests/api-streams.test.ts packages/os/tests/helpers
git commit -m "feat(os): SSE event hub with replay, persisted ids and keepalive validation, the stream routes and the shared client"
```

---

### Task 6: Step-ups and standing runners

**Files:**
- Create: `packages/os/src/auth/stepup.ts`, `packages/os/src/auth/standing.ts`
- Test: `packages/os/tests/auth-stepup.test.ts`
- Modify: `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`HostSecret`), Task 2 (`Sessions`, `COS_SESSION_ID`, `Actor`), Task 3 (`ApiError`), Task 4 (`AuthHooks`), Task 5 (`EventPublisher`; `FakeEventHub` in tests).
- Produces:
```ts
// packages/os/src/auth/stepup.ts
export const STEPUP_CODE_DIGITS = 6, STEPUP_MAX_FAILURES = 3;
export const HOST_SESSION_ID = "host";                   // StepUp.sessionId of a standing request the host made
export function hashCode(hostSecret: HostSecret, code: string): string;   // HMAC-SHA256(deriveKey("swarm-os/stepup-code/v1"), code), hex: someone who can only read the store cannot invert it
export function stepUpAudience(requesterDeviceId: string | null): (a: Actor) => boolean;   // the host, or a human on a confirmer device other than the requester's
export class StepUpError extends Error { constructor(readonly reason: "stepup_missing" | "stepup_consumed" | "stepup_expired" | "stepup_locked" | "stepup_unconfirmed", message: string) }
export class StepUps {
  constructor(deps: { store: OsStore; clock: Clock; config: OsConfig; hostSecret: HostSecret; randomCode?: () => string });
  issue(sessionId: string, command: string[]): Promise<{ stepUpId: string; code: string }>;
  confirm(stepUpId: string, code: string, by: Actor): Promise<boolean>;
  consume(stepUpId: string): Promise<StepUpRow>;
  open(): Promise<StepUpRow[]>;                             // unconsumed, unexpired, unlocked
  codeFor(stepUpId: string): string | null;                 // held in memory while pending; null after consume, expiry or a brain restart
  requesterDevice(row: StepUpRow): Promise<string | null>;  // the requesting session's deviceId; null for the host and the chief of staff
  canPresent(row: StepUpRow, by: Actor): Promise<boolean>;  // who may send the code back
  canSee(row: StepUpRow, viewer: Actor): Promise<boolean>;  // who may read the code
}
// packages/os/src/auth/standing.ts
export interface StandingResult { ok: boolean; text: string; data?: unknown }
export type StandingRun = (argv: string[], requester: Actor) => Promise<StandingResult>;
export class StandingRunners { register(prefix: string[], run: StandingRun): void; /* replaces an earlier runner for the prefix */ fallback(run: StandingRun): void; find(argv: string[]): StandingRun | null }
export interface StandingDeps { store: OsStore; clock: Clock; config: OsConfig; sessions: Sessions; stepUps: StepUps; runners: StandingRunners; hub: EventPublisher; hooks: AuthHooks }
export async function requestStanding(deps: StandingDeps, actor: Actor, argv: string[]): Promise<{ stepUpId: string; expiresAt: string }>;   // always a step-up, the host's requests included
export async function confirmStanding(deps: StandingDeps, by: Actor, stepUpId: string, code: string, expectArgv?: string[]): Promise<{ stepUpId: string; command: string[]; result: StandingResult }>;
export async function requesterOf(deps: Pick<StandingDeps, "sessions">, row: StepUpRow): Promise<Actor | null>;   // the host for HOST_SESSION_ID, the chief of staff for COS_SESSION_ID, else the live session's human; null once that session is revoked or expired
export function stepUpRequired(pending: { stepUpId: string; expiresAt: string }): ApiError;   // stepup_required (428) with stepUpId and expiresAt, never the code
```
- `issue`: six digits (`randomInt(0, 1_000_000)` zero-padded, or `randomCode()`), regenerated while equal to another pending code; the row is `{ id: newId("stepup"), sessionId, commandJson: JSON.stringify(command), codeHash: hashCode(code), issuedAt: now, expiresAt: now + stepup_ttl_seconds, consumedAt: null, failures: 0 }`.
- `canPresent`: the host (so a request typed on the host is a two-step are-you-sure), or a human with `confirmer: true`, the requester's own confirmer device included (it never receives its own code, so it can only present one it was told); never the chief of staff, an instance or a room token. `canSee`: the host, or a human with `confirmer: true` whose device is not the requester's. The requester's device can never read its own code, which is what keeps one device from both asking and approving.
- `confirm` returns false for a missing, consumed, expired or locked row and when `!canPresent`; a wrong code also adds one to `failures`; the right code returns true and marks the id confirmed in this process. `consume` throws `StepUpError` (`stepup_unconfirmed` without that mark), else sets `consumedAt`, forgets the code and returns the row.
- `requestStanding`: every actor that may issue commands gets a step-up, the host included; a human in cool-down → `ApiError("cooldown", …, { cooldownUntil })`; instance and room actors → 403 `forbidden`, `reason: "no_authority"`; no runner (the longest registered prefix, else the fallback) → 409 `conflict`, `reason: "no_runner"`; otherwise `issue` under the requester's session id (`HOST_SESSION_ID` for the host, `COS_SESSION_ID` for the chief of staff), publish `stepup { stepUpId, command, expiresAt, code }` to `stepUpAudience(requester's deviceId, or null for the host and the chief of staff)`, and return `{ stepUpId, expiresAt }`.
- `confirmStanding`, in order: no row → 404 `not_found`, `reason: "no_such_stepup"`; `expectArgv` given and different → 409 `conflict`, `reason: "stepup_mismatch"`; consumed or locked → 409 with that reason; `!canPresent` → 403 `forbidden`, `reason: "not_confirmer"`; expired → `await hooks.onStepUpFailed(row, by)` then `ApiError("stepup_failed", …, { reason: "stepup_expired" })` (403: an expired code counts as a failed one); no runner → 409 `no_runner` (the step-up stays open); `requesterOf` null → 409 `requester_session_invalid`; a wrong code → `await hooks.onStepUpFailed(row, by)` then `ApiError("stepup_failed")` (403); then `consume` and run the stored argv as the requester.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/auth-stepup.test.ts`**

Fixture: `MemoryOsStore`, `testClock()`, `makeConfig({ stepup_ttl_seconds: 120, owners: [{ id: "part-owner", name: "owner" }] })`, devices `dev-1` (phone, confirmer), `dev-2` (laptop, confirmer), `dev-3` (tablet, not a confirmer) with a session each; `phone`, `laptop` and `tablet` are their actors and `host = { kind: "host" }`; `hub = new FakeEventHub()`; a runner on `["devices", "revoke"]` that records its calls in `runnerCalls` and answers `{ ok: true, text: "revoked" }`.
```ts
it("issues a six-digit code, stores only its keyed hash, and expires it after stepup_ttl_seconds", async () => {
  const { stepUpId, code } = await stepUps.issue(phone.sessionId, ["devices", "revoke", "dev-3"]);
  const row = (await store.stepUps.get(stepUpId))!;
  expect(code).toMatch(/^\d{6}$/);
  expect(row).toMatchObject({ sessionId: phone.sessionId, commandJson: '["devices","revoke","dev-3"]', codeHash: hashCode(secret, code),
    issuedAt: T0.toISOString(), expiresAt: new Date(T0.getTime() + 120_000).toISOString(), consumedAt: null, failures: 0 });
  expect([row.codeHash.includes(code), stepUps.codeFor(stepUpId)]).toEqual([false, code]);
  clock.advance(120_001);
  expect([await stepUps.confirm(stepUpId, code, host), await stepUps.open()]).toEqual([false, []]);
});
it("never shows a requester its own code", async () => {
  const pending = await requestStanding(deps, phone, ["devices", "revoke", "dev-3"]);
  const row = (await store.stepUps.get(pending.stepUpId))!;
  expect(await Promise.all([phone, laptop, tablet, host].map((a) => stepUps.canSee(row, a)))).toEqual([false, true, false, true]);
  expect([hub.seenBy(phone), hub.seenBy(tablet)]).toEqual([[], []]);
  expect(hub.seenBy(laptop).map((e) => [e.type, e.payload])).toEqual([["stepup", { stepUpId: pending.stepUpId,
    command: ["devices", "revoke", "dev-3"], expiresAt: pending.expiresAt, code: stepUps.codeFor(pending.stepUpId) }]]);
  expect(JSON.stringify(stepUpRequired(pending))).not.toContain(stepUps.codeFor(pending.stepUpId)!);
});
it("lets the host and confirmer devices present the code, and never the chief of staff", async () => {
  const row = (await store.stepUps.get((await stepUps.issue(tablet.sessionId, ["devices", "revoke", "dev-2"])).stepUpId))!;
  expect(await Promise.all([host, phone, laptop, tablet, { kind: "cos" } as Actor, { kind: "instance", instanceId: "inst-1" } as Actor].map((a) => stepUps.canPresent(row, a))))
    .toEqual([true, true, true, false, false, false]);
});
it("counts wrong codes and locks a step-up after three", async () => {
  const { stepUpId, code } = await stepUps.issue(phone.sessionId, ["devices", "revoke", "dev-3"]);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 3; i += 1) expect(await stepUps.confirm(stepUpId, wrong, host)).toBe(false);
  expect([(await store.stepUps.get(stepUpId))?.failures, await stepUps.confirm(stepUpId, code, host)]).toEqual([3, false]);
});
it("consume needs a confirmation in this process and works once", async () => {
  const { stepUpId, code } = await stepUps.issue(phone.sessionId, ["devices", "revoke", "dev-3"]);
  await expect(stepUps.consume(stepUpId)).rejects.toMatchObject({ reason: "stepup_unconfirmed" });
  expect(await stepUps.confirm(stepUpId, code, laptop)).toBe(true);
  expect([(await stepUps.consume(stepUpId)).consumedAt, stepUps.codeFor(stepUpId)]).toEqual([T0.toISOString(), null]);
  await expect(stepUps.consume(stepUpId)).rejects.toMatchObject({ reason: "stepup_consumed" });
});
it("requestStanding gives everyone a step-up, the host included; a cooling-down session waits; an instance has no authority", async () => {
  const mine = await requestStanding(deps, host, ["devices", "revoke", "dev-3"]);
  expect([(await store.stepUps.get(mine.stepUpId))?.sessionId, runnerCalls]).toEqual([HOST_SESSION_ID, []]);
  expect([hub.seenBy(phone).length, hub.seenBy(laptop).length, hub.seenBy(tablet).length]).toEqual([1, 1, 0]);   // no requesting device: every confirmer sees it
  expect((await confirmStanding(deps, host, mine.stepUpId, stepUps.codeFor(mine.stepUpId)!)).result).toEqual({ ok: true, text: "revoked" });
  await sessions.coolDown(phone.sessionId, new Date(T0.getTime() + COOLDOWN_MS));
  await expect(requestStanding(deps, phone, ["devices", "revoke", "dev-3"])).rejects.toMatchObject({ code: "cooldown", status: 429 });
  await expect(requestStanding(deps, { kind: "instance", instanceId: "inst-1" }, ["devices", "revoke", "dev-3"]))
    .rejects.toMatchObject({ code: "forbidden", extra: { reason: "no_authority" } });
  await expect(requestStanding(deps, laptop, ["upgrade"])).rejects.toMatchObject({ code: "conflict", extra: { reason: "no_runner" } });
});
it("confirmStanding runs the stored command as the requester, and says why it will not", async () => {
  const id = (await requestStanding(deps, phone, ["devices", "revoke", "dev-3"])).stepUpId, code = stepUps.codeFor(id)!;
  await expect(confirmStanding(deps, tablet, id, code)).rejects.toMatchObject({ extra: { reason: "not_confirmer" } });
  await expect(confirmStanding(deps, phone, id, code, ["devices", "revoke", "dev-2"])).rejects.toMatchObject({ extra: { reason: "stepup_mismatch" } });
  const failed = vi.spyOn(deps.hooks, "onStepUpFailed");
  await expect(confirmStanding(deps, host, id, code === "000000" ? "000001" : "000000")).rejects.toMatchObject({ code: "stepup_failed", status: 403 });
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ id }), host);
  expect(await confirmStanding(deps, laptop, id, code)).toEqual({ stepUpId: id, command: ["devices", "revoke", "dev-3"], result: { ok: true, text: "revoked" } });
  expect(runnerCalls).toEqual([[["devices", "revoke", "dev-3"], expect.objectContaining({ kind: "human", sessionId: phone.sessionId })]]);
  const late = (await requestStanding(deps, laptop, ["devices", "revoke", "dev-1"])).stepUpId, lateCode = stepUps.codeFor(late)!;
  clock.advance(120_001);
  await expect(confirmStanding(deps, host, late, lateCode)).rejects.toMatchObject({ code: "stepup_failed", status: 403, extra: { reason: "stepup_expired" } });
  expect(failed).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/auth-stepup.test.ts`
Expected: FAIL, `Cannot find module '../src/auth/stepup.js'`.

- [ ] **Step 3: Implement `stepup.ts` and `standing.ts` with the rules above; export them from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/auth/stepup.ts packages/os/src/auth/standing.ts packages/os/src/index.ts packages/os/tests/auth-stepup.test.ts
git commit -m "feat(os): step-up codes only the host and other confirmers see, and standing runners"
```

---

### Task 7: Passkeys, the first-device link, and pending enrolments

**Files:**
- Create: `packages/os/src/auth/passkeys.ts`
- Test: `packages/os/tests/auth-passkeys.test.ts`, `packages/os/tests/helpers/webauthn.ts`
- Modify: `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`readBootstrap`, `hashToken`, `HostSecret`, `OsPaths`), Task 2 (`Sessions`, `Lockdown`), Task 3 (`ApiError`), Task 6 (`hashCode`); `@simplewebauthn/server` (`generateRegistrationOptions`, `verifyRegistrationResponse`, `generateAuthenticationOptions`, `verifyAuthenticationResponse`; `isoBase64URL`, `isoUint8Array` from `@simplewebauthn/server/helpers`).
- Produces:
```ts
// packages/os/src/auth/passkeys.ts
export type EnrolmentState = "pending" | "approved" | "refused" | "expired";
export interface EnrolmentView { id: string; humanId: string; deviceName: string; secretHash: string; state: EnrolmentState; confirmer: boolean }
export interface EnrolmentsPort {                 // implemented by plan 09's Enrolments (pending enrolments as system-room messages)
  request(input: { humanId: string; deviceName: string; address: string; secretHash: string }): Promise<EnrolmentView>;   // a refusal throws an error whose code is a RefusalCode
  get(id: string): Promise<EnrolmentView | null>;
  complete(id: string, deviceId: string): Promise<void>;   // the approved device has registered; the enrolment is spent
  approve?(ctx: unknown, id: string, opts: { confirmer: boolean }): Promise<{ ok: boolean; text: string; data?: unknown }>;   // plan 09's; the devices approve command calls it (Task 11)
}
export interface WebAuthn { generateRegistrationOptions: typeof generateRegistrationOptions; verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions; verifyAuthenticationResponse: typeof verifyAuthenticationResponse }
export const simpleWebAuthn: WebAuthn;
export const CHALLENGE_TTL_MS = 5 * 60_000, MAX_PENDING_CHALLENGES = 100;
export function relyingParty(config: OsConfig): { rpID: string; rpName: "Swarm OS"; origin: string };   // hostname and origin of public_url
export const BOOTSTRAP_ENROLMENT_ID = "bootstrap";      // the enrolmentId the first device's options carry
export type RegistrationStart = { kind: "options"; enrolmentId: string; options: PublicKeyCredentialCreationOptionsJSON }
                              | { kind: "pending"; enrolmentId: string; newSecret?: string };          // newSecret only when this call created the enrolment
export interface SessionOutcome { token: string; expiresAt: string; humanId: string; deviceId: string }
export function challengeOf(response: unknown): string | null;   // the challenge in response.response.clientDataJSON (base64url JSON); null when it does not parse
export class Passkeys {
  constructor(deps: { store: OsStore; config: OsConfig; clock: Clock; sessions: Sessions; lockdown: Lockdown; hostSecret: HostSecret;
    bootstrapPath: string; enrolments?: EnrolmentsPort; webauthn?: WebAuthn });
  registrationOptions(input: { deviceName: string; humanId?: string; enrolment?: string; pending?: { id: string; secret: string }; address: string }): Promise<RegistrationStart>;   // enrolment: the link code; pending: the swarm_os_enrolment cookie
  verifyRegistration(input: { enrolmentId: string; response: RegistrationResponseJSON; address: string }): Promise<SessionOutcome>;
  loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyLogin(input: { response: AuthenticationResponseJSON; address: string }): Promise<SessionOutcome>;
}
// packages/os/tests/helpers/webauthn.ts
export function fakeWebAuthn(o?: { verified?: boolean }): WebAuthn & { registrationCalls: unknown[]; authenticationCalls: unknown[] };
export function registrationResponse(id: string, challenge: string): RegistrationResponseJSON;       // clientDataJSON: base64url JSON { type: "webauthn.create", challenge, origin }
export function authenticationResponse(id: string, challenge: string): AuthenticationResponseJSON;   // the same with type "webauthn.get"
export class FakeEnrolments implements EnrolmentsPort { requests: unknown[]; completed: Array<[string, string]>; set(id: string, patch: Partial<EnrolmentView>): void }   // ids enr-1, enr-2, …
```
- Passkey verification in tests is **mocked**: `fakeWebAuthn` keeps the real option generators and replaces the two verifiers with recorders that resolve `{ verified, registrationInfo: { credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 } } }` and `{ verified, authenticationInfo: { credentialID: response.id, newCounter: credential.counter + 1 } }`, cast to the library's result types. The tests assert what the brain passes them; real authenticator round-trips belong to plan 07's browser tests.
- Registration options: `rpName "Swarm OS"`, `rpID`, `userName` = the owner's name, `userID: isoUint8Array.fromUTF8String(humanId)`, `attestationType: "none"`, `authenticatorSelection: { residentKey: "required", userVerification: "required" }`, `excludeCredentials` = the human's active devices, `timeout: CHALLENGE_TTL_MS`. Login options: `{ rpID, userVerification: "required", timeout: CHALLENGE_TTL_MS }` (discoverable credentials). Both verifiers get `expectedChallenge` = the issued challenge, `expectedOrigin`, `expectedRPID` and `requireUserVerification: true`; login also gets `credential: { id, publicKey: isoBase64URL.toBuffer(device.publicKey), counter }` and then sets the device's counter to `newCounter`. Devices store `publicKey` as `isoBase64URL.fromBuffer(...)`; new devices get `id: newId("dev")`, `enrolledAt: now`, `revokedAt: null`, and an active device holding the same `credentialId` → 409 `conflict`, `reason: "credential_exists"`.
- Challenges live in memory, keyed by the challenge string, so a verify finds its own through `challengeOf(response)` (plan 07 sends no challenge id); single use, at most `MAX_PENDING_CHALLENGES`, oldest dropped; a lost one only means the person retries. A registration challenge remembers its `enrolmentId`.
- `registrationOptions`, in order: lockdown → `lockdown`; a `humanId` not in `owners` → 400, `reason: "unknown_human"` (default: the first owner). With `enrolment` (the link code): it must match `readBootstrap(bootstrapPath)`'s hash, be unexpired, and no active device may exist, else 403 `forbidden`, `reason: "bootstrap_invalid"`; the answer is `{ kind: "options", enrolmentId: BOOTSTRAP_ENROLMENT_ID, options }`. Without one: no active device → 403, `reason: "bootstrap_required"`; no `enrolments` → 403, `reason: "enrolment_unavailable"`. With `pending` (the cookie) whose record exists: a secret whose `hashCode` differs → 403, `reason: "enrolment_secret"`; `refused` → 403, `reason: "enrolment_refused"`; `expired` → `ApiError("gone")`; `pending` → `{ kind: "pending", enrolmentId }`; `approved` → `{ kind: "options", enrolmentId, options }` bound to that enrolment. Otherwise a new secret (`randomBytes(32)` base64url) and `enrolments.request({ humanId, deviceName, address, secretHash: hashCode(hostSecret, secret) })` → `{ kind: "pending", enrolmentId, newSecret }`.
- `verifyRegistration`: the bootstrap path re-checks that no device exists, creates the device with `confirmer: false`, deletes `bootstrap.json`; the enrolment path re-reads the record (still `approved`, else the reasons above), creates the device with its `confirmer`, then `enrolments.complete(id, deviceId)`. Both end with `sessions.issueSession({ …, client: "web" })`. Failures: an unknown or used challenge, a `clientDataJSON` that does not parse, or a challenge issued for another `enrolmentId` → 400, `reason: "challenge_unknown"`, an old one → `"challenge_expired"`; a verifier that throws or answers `verified: false`, an unknown or revoked credential at login, or a human no longer in `owners` → 401 `unauthenticated`, `reason: "passkey_invalid"`. A challenge is spent by its first verify, successful or not.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/auth-passkeys.test.ts`**

Fixture: `config = makeConfig({ public_url: "https://brain.example.test", owners: [{ id: "part-owner", name: "owner" }] })`, a temp OS home with a host secret, `enrolToken` from `issueBootstrapLink(paths, config, T0)`, `webauthn = fakeWebAuthn()`, `enrolments = new FakeEnrolments()`, and `enrolFirstDevice()` (options and verify with `cred-1` through the link).
```ts
it("asks for a resident, user-verified passkey on public_url's relying party", async () => {
  const start = await passkeys.registrationOptions({ deviceName: "phone", enrolment: enrolToken, address: "x" });
  if (start.kind !== "options") throw new Error("expected options");
  expect(start.options).toMatchObject({ rp: { name: "Swarm OS", id: "brain.example.test" }, user: { name: "owner" }, attestation: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" } });
});
it("enrols the first device through the link, once", async () => {
  const start = await passkeys.registrationOptions({ deviceName: "phone", enrolment: enrolToken, address: "x" }) as Extract<RegistrationStart, { kind: "options" }>;
  expect(start.enrolmentId).toBe(BOOTSTRAP_ENROLMENT_ID);
  const out = await passkeys.verifyRegistration({ enrolmentId: start.enrolmentId, response: registrationResponse("cred-1", start.options.challenge), address: "100.64.0.7" });
  expect(webauthn.registrationCalls[0]).toMatchObject({ expectedChallenge: start.options.challenge, expectedOrigin: "https://brain.example.test",
    expectedRPID: "brain.example.test", requireUserVerification: true });
  expect(out).toMatchObject({ token: expect.stringMatching(/^sess_/), humanId: "part-owner", deviceId: expect.stringMatching(/^dev-/) });
  expect(await store.devices.find({ credentialId: "cred-1" })).toEqual([expect.objectContaining({ humanId: "part-owner", name: "phone",
    publicKey: "AQIDBA", counter: 0, confirmer: false, revokedAt: null })]);
  expect(existsSync(paths.bootstrap)).toBe(false);
  await expect(passkeys.registrationOptions({ deviceName: "again", enrolment: enrolToken, address: "x" })).rejects.toMatchObject({ extra: { reason: "bootstrap_invalid" } });
});
it("refuses an expired link, and asks for one while no device exists", async () => {
  await expect(passkeys.registrationOptions({ deviceName: "x", address: "x" })).rejects.toMatchObject({ extra: { reason: "bootstrap_required" } });
  clock.advance(BOOTSTRAP_TTL_MS + 1);
  await expect(passkeys.registrationOptions({ deviceName: "x", enrolment: enrolToken, address: "x" })).rejects.toMatchObject({ extra: { reason: "bootstrap_invalid" } });
});
it("holds a later device as a pending enrolment, then registers it once approved", async () => {
  await enrolFirstDevice();
  const first = await passkeys.registrationOptions({ deviceName: "laptop", address: "100.64.0.8" });
  expect(first).toEqual({ kind: "pending", enrolmentId: "enr-1", newSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  const secret = (first as { newSecret: string }).newSecret;
  expect(enrolments.requests).toEqual([{ humanId: "part-owner", deviceName: "laptop", address: "100.64.0.8", secretHash: hashCode(hostSecret, secret) }]);
  expect(await passkeys.registrationOptions({ deviceName: "laptop", pending: { id: "enr-1", secret }, address: "x" })).toEqual({ kind: "pending", enrolmentId: "enr-1" });
  enrolments.set("enr-1", { state: "approved", confirmer: true });
  const start = await passkeys.registrationOptions({ deviceName: "laptop", pending: { id: "enr-1", secret }, address: "x" }) as Extract<RegistrationStart, { kind: "options" }>;
  expect(start.options.excludeCredentials).toEqual([expect.objectContaining({ id: "cred-1" })]);
  const out = await passkeys.verifyRegistration({ enrolmentId: start.enrolmentId, response: registrationResponse("cred-2", start.options.challenge), address: "x" });
  expect((await store.devices.get(out.deviceId))?.confirmer).toBe(true);
  expect(enrolments.completed).toEqual([["enr-1", out.deviceId]]);
});
it("answers a wrong secret and a refusal with forbidden, an expired enrolment with gone, and no store with enrolment_unavailable", async () => {
  await enrolFirstDevice();
  const { newSecret } = await passkeys.registrationOptions({ deviceName: "laptop", address: "x" }) as { newSecret: string };
  await expect(passkeys.registrationOptions({ deviceName: "laptop", pending: { id: "enr-1", secret: "wrong" }, address: "x" })).rejects.toMatchObject({ extra: { reason: "enrolment_secret" } });
  enrolments.set("enr-1", { state: "refused" });
  await expect(passkeys.registrationOptions({ deviceName: "laptop", pending: { id: "enr-1", secret: newSecret }, address: "x" })).rejects.toMatchObject({ code: "forbidden", extra: { reason: "enrolment_refused" } });
  enrolments.set("enr-1", { state: "expired" });
  await expect(passkeys.registrationOptions({ deviceName: "laptop", pending: { id: "enr-1", secret: newSecret }, address: "x" })).rejects.toMatchObject({ code: "gone", status: 410 });
  await expect(withoutEnrolments.registrationOptions({ deviceName: "laptop", address: "x" })).rejects.toMatchObject({ extra: { reason: "enrolment_unavailable" } });
});
it("spends a challenge on its first verify and refuses old ones", async () => {
  const a = await passkeys.registrationOptions({ deviceName: "phone", enrolment: enrolToken, address: "x" }) as Extract<RegistrationStart, { kind: "options" }>;
  await passkeys.verifyRegistration({ enrolmentId: a.enrolmentId, response: registrationResponse("cred-1", a.options.challenge), address: "x" });
  await expect(passkeys.verifyRegistration({ enrolmentId: a.enrolmentId, response: registrationResponse("cred-9", a.options.challenge), address: "x" }))
    .rejects.toMatchObject({ extra: { reason: "challenge_unknown" } });
  const b = await passkeys.loginOptions(); clock.advance(CHALLENGE_TTL_MS + 1);
  await expect(passkeys.verifyLogin({ response: authenticationResponse("cred-1", b.challenge), address: "x" }))
    .rejects.toMatchObject({ extra: { reason: "challenge_expired" } });
  await expect(passkeys.verifyLogin({ response: { id: "cred-1", response: { clientDataJSON: "not-json" } } as never, address: "x" }))
    .rejects.toMatchObject({ extra: { reason: "challenge_unknown" } });
});
it("logs in with the stored credential, advances its counter, and refuses removed owners", async () => {
  await enrolFirstDevice();
  const options = await passkeys.loginOptions();
  expect(options).toMatchObject({ rpId: "brain.example.test", userVerification: "required" });
  const out = await passkeys.verifyLogin({ response: authenticationResponse("cred-1", options.challenge), address: "100.64.0.7" });
  expect(webauthn.authenticationCalls[0]).toMatchObject({ credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 }, requireUserVerification: true });
  expect([out.humanId, (await store.devices.find({ credentialId: "cred-1" }))[0].counter]).toEqual(["part-owner", 1]);
  config.owners = [{ id: "part-other", name: "other" }];
  const again = await passkeys.loginOptions();
  await expect(passkeys.verifyLogin({ response: authenticationResponse("cred-1", again.challenge), address: "x" }))
    .rejects.toMatchObject({ code: "unauthenticated", extra: { reason: "passkey_invalid" } });
});
it("refuses registration and login during a lockdown", async () => {
  await lockdown.engage({ kind: "host" });
  await expect(passkeys.loginOptions()).rejects.toMatchObject({ code: "lockdown" });
  await expect(passkeys.registrationOptions({ deviceName: "x", enrolment: enrolToken, address: "x" })).rejects.toMatchObject({ code: "lockdown" });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/auth-passkeys.test.ts`
Expected: FAIL, `Cannot find module '../src/auth/passkeys.js'`.

- [ ] **Step 3: Implement `passkeys.ts` with the rules above; export it from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/auth/passkeys.ts packages/os/src/index.ts packages/os/tests/auth-passkeys.test.ts packages/os/tests/helpers/webauthn.ts
git commit -m "feat(os): passkey registration and login, the first-device link, and pending enrolments"
```

---

### Task 8: `AuthServices` and the auth, step-up, `me` and lockdown routes

**Files:**
- Create: `packages/os/src/auth/index.ts`, `packages/os/src/api/auth-routes.ts`
- Test: `packages/os/tests/api-auth-routes.test.ts`, `packages/os/tests/helpers/auth-fixture.ts`
- Modify: `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1 to 7.
- Produces:
```ts
// packages/os/src/auth/index.ts
export interface PendingStepUp { stepUpId: string; command: string[]; expiresAt: string; code: string | null;   // null once a restart has lost the code
  requester: { kind: "host" } | { kind: "cos" } | { kind: "human"; deviceId: string; address: string } }
export interface AuthServices { hostSecret: HostSecret; sessions: Sessions; tokens: Tokens; lockdown: Lockdown; stepUps: StepUps; runners: StandingRunners;
  passkeys: Passkeys; authenticator: Authenticator; hooks: AuthHooks; standing: StandingDeps; enrolments?: EnrolmentsPort;
  issueSession: Sessions["issueSession"];                       // bound; plan 08's terminal sign-in reaches it through Task 11
  pendingStepUps(viewer: Actor): Promise<PendingStepUp[]> }     // the open step-ups viewer canSee, newest first
export async function createAuthServices(deps: { store: OsStore; config: OsConfig; clock: Clock; log: Logger; paths: OsPaths; hub: EventHub;
  webauthn?: WebAuthn; enrolments?: EnrolmentsPort }): Promise<AuthServices>;
export function registerAuthStandingRunners(auth: AuthServices, deps: { store: OsStore; clock: Clock; hub: EventHub }): void;
export const ENROLMENT_COOKIE = "swarm_os_enrolment";
// packages/os/src/api/auth-routes.ts
export function registerAuthRoutes(server: ApiServer, deps: { config: OsConfig; store: OsStore; clock: Clock; hub: EventHub; auth: AuthServices }): void;
// packages/os/tests/helpers/auth-fixture.ts
export async function authFixture(o?: { config?: DeepPartial<OsConfig>; enrolments?: EnrolmentsPort }): Promise<{ config: OsConfig; clock: FakeClock; store: MemoryOsStore;
  hub: EventHub; auth: AuthServices; server: ApiServer; url: string; enrolToken: string; host: string;   // host: the host bearer
  request(method: string, path: string, o?: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; headers: Headers; json: any }>;
  firstDevice(): Promise<{ token: string; deviceId: string }>;                                          // through the init link
  device(name: string, o?: { confirmer?: boolean }): Promise<{ token: string; deviceId: string; sessionId: string }>;   // a Device row and a session, put directly
  stream(token: string): Promise<{ events: Array<{ type: string; data: any }>; close(): void }>;      // openEventStream on /api/stream; resolves once hello has arrived
  close(): Promise<void> }>;
```
- `createAuthServices` reads `host.secret`, builds the services, and wires `Lockdown` with `revoke` = `sessions.revokeAll()` then `hub.closeWhere((a) => a.kind !== "host")` (room tokens die with the epoch; instance tokens stay valid), and `onChange` = `hub.publish(() => true, { type: "lockdown", payload: { active } })`; it awaits `lockdown.load()` and builds `hooks` with `defaultAuthHooks({ sessions, clock, publish: hub.publish.bind(hub) })`.
- Default runners: `["devices", "revoke", id]` sets the device's `revokedAt`, revokes its sessions, closes its streams, and answers `{ ok: true, text: "Revoked <name> (<id>) and <n> sessions" }` (an unknown or revoked device answers `ok: false`); `["lockdown", "release"]` releases only for a host requester, else `{ ok: false, text: "Only the host can lift a lockdown: run swarm os lockdown release on the host." }`. Plan 09 may register its own `devices revoke` runner; the `devices approve` command is Task 11's, over plan 09's `Enrolments.approve`.
- Routes (cookie-authenticated writes need `X-Swarm-Os: 1`, from Task 3):

| Route | Auth | Body (zod) | Answer |
|---|---|---|---|
| `POST /api/auth/register/options` | none | `{ deviceName: string 1-64 trimmed, humanId?, enrolment?, enrolmentId? }` (`enrolment`: the link code); the `swarm_os_enrolment` cookie, whose id a body `enrolmentId` must equal (a different one, or one without the cookie → 403 `forbidden`, `reason: "enrolment_secret"`) | `options` → `{ enrolmentId, options }`; `pending` → `withStatus(202, { enrolmentId, state: "pending" })`, setting `swarm_os_enrolment=<enrolmentId>.<secret>; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=900` (plus `; Secure` as for the session cookie) when a secret was issued |
| `POST /api/auth/register/verify` | none | `{ enrolmentId, response: z.looseObject({ id: z.string() }) }` | sets the session cookie and clears the enrolment cookie; `{ humanId, deviceId, expiresAt }`, plus `token` only with `X-Swarm-Os-Client: cli` |
| `POST /api/auth/login/options` | none | `{}` | the options themselves (`PublicKeyCredentialRequestOptionsJSON`) |
| `POST /api/auth/login/verify` | none | `{ response: z.looseObject({ id: z.string() }) }` | sets the cookie; `{ humanId, deviceId, expiresAt }`, plus `token` only with `X-Swarm-Os-Client: cli` |
| `POST /api/auth/logout` | human | none | revokes the session, closes its streams, clears the cookie; `{ ok: true }` |
| `POST /api/auth/devices/:id/revoke` | human, host | `{ stepUpId?, code? }` | standing `["devices", "revoke", id]` |
| `POST /api/stepup/confirm` | host, human | `{ stepUpId, code: /^\d{6}$/ }` | `confirmStanding(by, stepUpId, code)` → `{ stepUpId, command, result }` |
| `GET /api/stepup/pending` | host, human | none | `{ pending: await auth.pendingStepUps(actor) }` |
| `GET /api/me` | human | none | `{ humanId, name, deviceId, confirmer, vapidPublic: config.push?.vapid_public ?? null }` |
| `POST /api/lockdown` | host | none | engages at once (an operating command, host only); `{ active: true, engagedAt }` |
| `POST /api/lockdown/release` | host | `{ stepUpId?, code? }` | standing `["lockdown", "release"]`: a 428 first, then the host confirms (`swarm os confirm`) |

- The fixture and the brain register the stream routes with `pendingStepUps: (a) => auth.pendingStepUps(a)`, keeping the entries whose `code` is known.
- A standing route with both `stepUpId` and `code` calls `confirmStanding(actor, stepUpId, code, argv)`; with neither it calls `requestStanding` and throws `stepUpRequired(pending)`, the host included; a confirmed run answers `{ stepUpId, command, result }`. The session cookie's `Max-Age` is `session_ttl_hours * 3600`.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/api-auth-routes.test.ts`**

`f = await authFixture({ enrolments: new FakeEnrolments() })` unless a test says otherwise.
```ts
it("enrols the first device through the link, sets the session cookie, and answers /api/me", async () => {
  const o = await f.request("POST", "/api/auth/register/options", { body: { deviceName: "phone", enrolment: f.enrolToken } });
  const v = await f.request("POST", "/api/auth/register/verify", { body: { enrolmentId: o.json.enrolmentId, response: registrationResponse("cred-1", o.json.options.challenge) } });
  expect(v.json).toEqual({ humanId: "part-owner", deviceId: expect.stringMatching(/^dev-/), expiresAt: expect.any(String) });
  const cookie = v.headers.get("set-cookie")!;
  expect(cookie).toMatch(/swarm_os_session=sess_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400; Secure/);
  const me = await f.request("GET", "/api/me", { cookie: cookie.split(";")[0] });
  expect(me.json).toEqual({ humanId: "part-owner", name: "owner", deviceId: v.json.deviceId, confirmer: false, vapidPublic: f.config.push?.vapid_public ?? null });
});
it("returns the session token in the body only to the CLI client", async () => {
  await f.firstDevice();
  const login = async (cli: boolean) => {
    const o = await f.request("POST", "/api/auth/login/options", { body: {} });
    return f.request("POST", "/api/auth/login/verify", { body: { response: authenticationResponse("cred-1", o.json.challenge) },
      headers: cli ? { "x-swarm-os-client": "cli" } : {} });
  };
  expect((await login(false)).json).not.toHaveProperty("token");
  expect((await login(true)).json.token).toMatch(/^sess_/);
});
it("keeps a later device waiting with 202 until approved, then completes it; refused is 403 and expired is 410", async () => {
  await f.firstDevice();
  const asked = await f.request("POST", "/api/auth/register/options", { body: { deviceName: "laptop" } });
  expect([asked.status, asked.json]).toEqual([202, { enrolmentId: "enr-1", state: "pending" }]);
  const enrolCookie = asked.headers.get("set-cookie")!.split(";")[0];
  expect(enrolCookie).toMatch(/^swarm_os_enrolment=enr-1\.[A-Za-z0-9_-]{43}$/);
  expect((await f.request("POST", "/api/auth/register/options", { cookie: enrolCookie, body: { deviceName: "laptop" } })).status).toBe(202);
  (f.auth.enrolments as FakeEnrolments).set("enr-1", { state: "approved", confirmer: true });
  expect((await f.request("POST", "/api/auth/register/options", { body: { deviceName: "laptop", enrolmentId: "enr-1" } })).json.error.reason).toBe("enrolment_secret");
  const o = await f.request("POST", "/api/auth/register/options", { cookie: enrolCookie, body: { deviceName: "laptop", enrolmentId: "enr-1" } });
  const v = await f.request("POST", "/api/auth/register/verify", { cookie: enrolCookie, body: { enrolmentId: o.json.enrolmentId, response: registrationResponse("cred-2", o.json.options.challenge) } });
  expect(v.json).toEqual({ humanId: "part-owner", deviceId: expect.stringMatching(/^dev-/), expiresAt: expect.any(String) });
  expect(v.headers.get("set-cookie")).toMatch(/swarm_os_enrolment=; .*Max-Age=0/);
  for (const [state, status, code] of [["refused", 403, "forbidden"], ["expired", 410, "gone"]] as const) {
    const later = await f.request("POST", "/api/auth/register/options", { body: { deviceName: state } });
    (f.auth.enrolments as FakeEnrolments).set(later.json.enrolmentId, { state });
    const again = await f.request("POST", "/api/auth/register/options", { cookie: later.headers.get("set-cookie")!.split(";")[0], body: { deviceName: state } });
    expect([again.status, again.json.error.code]).toEqual([status, code]);
  }
});
it("a confirmer phone cannot see its own code; another confirmer can, and the phone may relay it", async () => {
  const phone = await f.device("phone", { confirmer: true }), laptop = await f.device("laptop", { confirmer: true }), tablet = await f.device("tablet");
  const phoneStream = await f.stream(phone.token), laptopStream = await f.stream(laptop.token);
  const asked = await f.request("POST", `/api/auth/devices/${tablet.deviceId}/revoke`, { token: phone.token });
  expect([asked.status, asked.json.error]).toEqual([428, { code: "stepup_required", message: expect.any(String), stepUpId: expect.stringMatching(/^stepup-/), expiresAt: expect.any(String) }]);
  const id = asked.json.error.stepUpId;
  await vi.waitFor(() => expect(laptopStream.events.find((e) => e.type === "stepup")?.data).toMatchObject({ stepUpId: id, code: expect.stringMatching(/^\d{6}$/) }));
  expect(phoneStream.events.filter((e) => e.type === "stepup")).toEqual([]);
  expect((await f.request("GET", "/api/stepup/pending", { token: phone.token })).json.pending).toEqual([]);
  const [seen] = (await f.request("GET", "/api/stepup/pending", { token: laptop.token })).json.pending;
  expect(seen).toMatchObject({ stepUpId: id, command: ["devices", "revoke", tablet.deviceId], requester: { kind: "human", deviceId: phone.deviceId } });
  const lateLaptop = await f.stream(laptop.token), latePhone = await f.stream(phone.token);   // plan 08: a terminal opened later still sees the code
  expect([lateLaptop.events[0].data.stepUps, latePhone.events[0].data.stepUps]).toEqual([[expect.objectContaining({ stepUpId: id, code: seen.code })], []]);
  lateLaptop.close(); latePhone.close();
  expect((await f.request("POST", "/api/stepup/confirm", { token: tablet.token, body: { stepUpId: id, code: seen.code } })).json.error.reason).toBe("not_confirmer");
  const relayed = await f.request("POST", `/api/auth/devices/${tablet.deviceId}/revoke`, { token: phone.token, body: { stepUpId: id, code: seen.code } });
  expect([relayed.json.result.ok, (await f.request("GET", "/api/me", { token: tablet.token })).status]).toEqual([true, 401]);
  phoneStream.close(); laptopStream.close();
});
it("two failed codes within ten minutes cool the requesting session down, and one does not", async () => {
  const phone = await f.device("phone"), laptop = await f.device("laptop");
  const ask = () => f.request("POST", `/api/auth/devices/${laptop.deviceId}/revoke`, { token: phone.token });
  const id = (await ask()).json.error.stepUpId;
  const code = (await f.request("GET", "/api/stepup/pending", { token: f.host })).json.pending[0].code as string;
  const wrong = { stepUpId: id, code: code === "000000" ? "000001" : "000000" };
  const failed = await f.request("POST", "/api/stepup/confirm", { token: f.host, body: wrong });
  expect([failed.status, failed.json.error.code, (await ask()).status]).toEqual([403, "stepup_failed", 428]);
  await f.request("POST", "/api/stepup/confirm", { token: f.host, body: wrong });
  const again = await ask();
  expect([again.status, again.json.error.code, again.json.error.cooldownUntil]).toEqual([429, "cooldown", expect.any(String)]);
});
it("logout revokes the session and clears the cookie", async () => {
  const phone = await f.firstDevice();
  const out = await f.request("POST", "/api/auth/logout", { token: phone.token });
  expect([out.json, out.headers.get("set-cookie")]).toEqual([{ ok: true }, expect.stringContaining("Max-Age=0")]);
  expect((await f.request("GET", "/api/me", { token: phone.token })).status).toBe(401);
});
it("lockdown from the host cuts off every human until the host lifts it", async () => {
  const phone = await f.firstDevice();
  expect((await f.request("POST", "/api/lockdown", { token: f.host })).json).toEqual({ active: true, engagedAt: T0.toISOString() });
  expect((await f.request("GET", "/api/me", { token: phone.token })).json.error.code).toBe("lockdown");
  expect((await f.request("POST", "/api/auth/login/options", { body: {} })).json.error.code).toBe("lockdown");
  expect((await f.request("POST", "/api/lockdown/release", { token: phone.token })).status).toBe(403);
  expect((await f.request("POST", "/api/lockdown", { token: f.host, headers: { "x-forwarded-for": "100.64.0.9" } })).json.error.reason).toBe("host_not_loopback");
  const lift = await f.request("POST", "/api/lockdown/release", { token: f.host });
  expect([lift.status, lift.json.error.code]).toEqual([428, "stepup_required"]);       // the host confirms its own standing request
  const [own] = (await f.request("GET", "/api/stepup/pending", { token: f.host })).json.pending;
  expect([own.requester, (await f.request("POST", "/api/stepup/confirm", { token: f.host, body: { stepUpId: own.stepUpId, code: own.code } })).json.result.ok]).toEqual([{ kind: "host" }, true]);
  expect((await f.request("GET", "/api/me", { token: phone.token })).json.error.reason).toBe("session_invalid");
});
it("registers no route that could write configuration", () => {
  expect(f.server.routes().filter((r) => /config|limits/.test(r.path))).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/api-auth-routes.test.ts`
Expected: FAIL, `Cannot find module '../src/api/auth-routes.js'`.

- [ ] **Step 3: Implement `auth/index.ts` and `auth-routes.ts` with the table and runners above; export `AuthServices`, `createAuthServices`, `registerAuthStandingRunners`, `ENROLMENT_COOKIE`, `registerAuthRoutes` from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/auth/index.ts packages/os/src/api/auth-routes.ts packages/os/src/index.ts packages/os/tests/api-auth-routes.test.ts packages/os/tests/helpers/auth-fixture.ts
git commit -m "feat(os): passkey, enrolment, logout, device, step-up, me and lockdown routes"
```

---

### Task 9: Start-up recovery: snapshot warm-up and reconcile

**Files:**
- Create: `packages/os/src/brain/ports.ts`, `packages/os/src/brain/recovery.ts`, `packages/os/src/brain/reconcile.ts`
- Test: `packages/os/tests/brain-recovery.test.ts`, `packages/os/tests/helpers/brain-fakes.ts`
- Modify: `packages/os/src/index.ts`

**Interfaces:**
- Consumes: plan 02 (`journaledStore`, `Journal`, `OsStore`, `MemoryOsStore`, `OsStoreError`, `makeRow`, `InstanceRow`), Task 2 (`TERMINAL_STATES`), Task 5 (`EventPublisher`, `FakeEventHub`).
- Produces:
```ts
// packages/os/src/brain/ports.ts: structural slices of plan 04's Launcher and Dispatcher, which satisfy them without importing this file
export interface BrainLauncher { status(handle: { instanceId: string; host: string; handle: string }): Promise<"running" | "gone">; resources(): Promise<unknown> }
export interface BrainDispatcher { reevaluateHolds(boardId: string): Promise<void> }
export const NO_DISPATCHER: BrainDispatcher;             // re-evaluates nothing
// packages/os/src/brain/recovery.ts
export const SNAPSHOT_REPOS = ["boards", "registrations", "instances", "rooms", "participants", "devices", "sessions"] as const;
export async function warmSnapshot(store: OsStore): Promise<number>;   // reads every row of SNAPSHOT_REPOS through the journaled store, which mirrors each into its snapshot
// packages/os/src/brain/reconcile.ts
export const LIVE_STATES: ReadonlySet<InstanceRow["state"]>;   // dispatching, running, paused, unresponsive
export const BRAIN_RESTART_FOUND_GONE = "brain_restart_found_gone";   // the brain's own exit reason, not a run's RunExitReason
export const STATUS_TIMEOUT_MS = 10_000;
export interface ReconcileReport { kept: string[]; gone: string[]; pausedGone: string[]; unknown: string[]; boardsReevaluated: string[] }
export async function reconcile(deps: { store: OsStore; launcher: BrainLauncher; dispatcher: BrainDispatcher; clock: Clock; log: Logger; hub?: EventPublisher; statusTimeoutMs?: number }): Promise<ReconcileReport>;
// packages/os/tests/helpers/brain-fakes.ts
export class ScriptedLauncher implements BrainLauncher { statuses: Map<string, "running" | "gone" | Error | "hang">; calls: Array<{ instanceId: string; host: string; handle: string }>; resourcesFail: boolean }   // unscripted ids are "gone"
export class FakeDispatcher implements BrainDispatcher { reevaluated: string[] }
export function switchableStore(base: MemoryOsStore): OsStore & { down: boolean };   // while down, every call throws plan 02's OsStoreError("unreachable", …) and ping() is false
```
- `reconcile` is the brain's recovery for a brain without plan 04's dispatch module (an injected launcher: these tests, other harnesses). With the module, `mountDispatch` reconciles through plan 04's `Dispatcher.reconcile()`, and the brain does not run this one (Task 10).
- Rules, asked one row at a time with `{ instanceId: row.id, host: row.host, handle: row.launcherHandle ?? "" }`:

| recorded state | `running` | `gone` | throws or exceeds `statusTimeoutMs` |
|---|---|---|---|
| `dispatching` | kept as it is; the instance attaches with its token | `exited`, `exitReason: BRAIN_RESTART_FOUND_GONE`, `endedAt: now` | kept as it is, reported `unknown`, `log.warn` |
| `running`, `unresponsive` | kept as it is | as above | as above |
| `paused` | kept | stays `paused` (spec: a paused instance "checkpoints and exits"), `endedAt` set if null, no re-evaluation | as above |

  After the rows, `dispatcher.reevaluateHolds(boardId)` runs once per board with a newly exited row, in first-seen order (a throw is logged and the rest still run), and each changed row is published as `instance { instance }` to humans and the host.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/brain-recovery.test.ts`**

`instanceRow` and `deviceRow` (Task 2's helpers) build on plan 02's `makeRow`, so every row passes its strict schemas.
```ts
it("keeps a dispatching row whose process is running and never re-dispatches it", async () => {
  const row = instanceRow({ id: "inst-1", state: "dispatching", launcherHandle: null });
  await store.instances.put(row); launcher.statuses.set("inst-1", "running");
  const report = await reconcile({ store, launcher, dispatcher, clock, log, hub });
  expect(launcher.calls).toEqual([{ instanceId: "inst-1", host: "local", handle: "" }]);
  expect(await store.instances.get("inst-1")).toEqual(row);
  expect([report.kept, dispatcher.reevaluated, hub.published]).toEqual([["inst-1"], [], []]);
});
it("marks gone instances exited and re-evaluates each board once", async () => {
  await store.instances.put(instanceRow({ id: "inst-2", state: "running" }));
  await store.instances.put(instanceRow({ id: "inst-3", state: "unresponsive" }));
  const report = await reconcile({ store, launcher, dispatcher, clock, log, hub });
  for (const id of ["inst-2", "inst-3"]) expect(await store.instances.get(id)).toMatchObject({ state: "exited", exitReason: BRAIN_RESTART_FOUND_GONE, endedAt: T0.toISOString() });
  expect([report.gone, dispatcher.reevaluated]).toEqual([["inst-2", "inst-3"], ["board-a"]]);
  expect(hub.seenBy({ kind: "host" }).map((e) => (e.payload as { instance: InstanceRow }).instance.state)).toEqual(["exited", "exited"]);
});
it("leaves a row alone when the launcher cannot answer", async () => {
  const a = instanceRow({ id: "inst-4" }), b = instanceRow({ id: "inst-5" });
  await store.instances.put(a); await store.instances.put(b); await store.instances.put(instanceRow({ id: "inst-6" }));
  launcher.statuses.set("inst-4", new Error("ssh: host unreachable")); launcher.statuses.set("inst-5", "hang");
  const report = await reconcile({ store, launcher, dispatcher, clock, log, hub, statusTimeoutMs: 20 });
  expect([await store.instances.get("inst-4"), await store.instances.get("inst-5")]).toEqual([a, b]);
  expect([report.unknown, report.gone]).toEqual([["inst-4", "inst-5"], ["inst-6"]]);
  expect(log.warn).toHaveBeenCalledTimes(2);
});
it("leaves a gone paused instance paused and asks nothing about finished ones", async () => {
  await store.instances.put(instanceRow({ id: "inst-7", state: "paused", endedAt: null }));
  for (const state of ["exited", "failed", "login_expired"] as const) await store.instances.put(instanceRow({ id: `inst-${state}`, state }));
  const report = await reconcile({ store, launcher, dispatcher, clock, log, hub });
  expect(await store.instances.get("inst-7")).toMatchObject({ state: "paused", endedAt: T0.toISOString() });
  expect([report.pausedGone, launcher.calls.map((c) => c.instanceId), dispatcher.reevaluated]).toEqual([["inst-7"], ["inst-7"], []]);
});
it("warms the snapshot with the snapshot repositories only", async () => {
  const base = new MemoryOsStore(), snapshot = new MemoryOsStore();
  await base.devices.put(deviceRow()); await base.instances.put(instanceRow());
  await base.messages.put(makeRow("messages", { id: "msg-1" }));
  const store = journaledStore(base, new Journal(tempOsHome().journal), snapshot);
  expect(await warmSnapshot(store)).toBe(2);
  expect([await snapshot.devices.get("dev-1"), await snapshot.messages.get("msg-1")]).toEqual([deviceRow(), null]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/brain-recovery.test.ts`
Expected: FAIL, `Cannot find module '../src/brain/reconcile.js'`.

- [ ] **Step 3: Implement `ports.ts`, `recovery.ts` and `reconcile.ts` with the rules above; export them from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/brain packages/os/src/index.ts packages/os/tests/brain-recovery.test.ts packages/os/tests/helpers/brain-fakes.ts
git commit -m "feat(os): snapshot warm-up and reconcile of live instances on brain start"
```

---

### Task 10: Periodic tasks, brain modules and the `Brain` lifecycle

**Files:**
- Create: `packages/os/src/brain/periodic.ts`, `packages/os/src/brain/module.ts`, `packages/os/src/brain/parts.ts` (the `BrainParts` interface only), `packages/os/src/brain/open-store.ts`, `packages/os/src/brain/brain.ts`
- Modify: `packages/os/src/api/server.ts` (add `export type Api = ApiServer`), `packages/os/src/index.ts`
- Test: `packages/os/tests/brain-periodic.test.ts`, `packages/os/tests/brain.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 9; plan 02 (`journaledStore`, `JournaledOsStore`, `Journal`, `ensureOsStack`, `SubstrateOsStore`, `systemClock`, `createLogger`).
- Produces:
```ts
// packages/os/src/brain/periodic.ts
export interface PeriodicTask { name: string; everyMs: number; run(): Promise<void> }   // plan 04's PeriodicTask, structurally
export interface Timers { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void }
export const JOURNAL_REPLAY_EVERY_MS = 10_000, QUESTION_EXPIRY_EVERY_MS = 60_000;
export class Periodics {
  constructor(deps: { log: Logger; timers?: Timers });
  add(task: PeriodicTask): void;          // a duplicate name throws; a task added after start() starts at once
  list(): Array<{ name: string; everyMs: number }>;
  start(): void;                          // each task runs once now, then every everyMs; a tick while its previous run is in flight is skipped;
                                          // a failure is logged ("periodic_failed", { name, message }) and never thrown
  stop(): Promise<void>;                  // clears every interval and awaits runs in flight
  runNow(name: string): Promise<void>;
}
// packages/os/src/brain/module.ts: the shape plans 04, 05 and 06 bind to, word for word
export interface BrainModule { name: string; start(ctx: BrainContext): Promise<void>; stop(): Promise<void> }
export interface BrainContext { config: OsConfig; store: JournaledOsStore; api: Api; hub: EventHub; clock: Clock; log: Logger; periodic(name: string, everyMs: number, fn: () => Promise<void>): void; registerCommands(specs: CommandSpec[]): void }
export interface BrainContext { paths: OsPaths; baseStore: OsStore; auth: AuthServices; streams: StreamRoutes; services: BrainServices; inject: BrainInject; swarmCommand: string[] | null; startedAt: Date }   // plan 03's additions, merged into the same interface
export interface CommandSpecLike { name: string; summary: string; kind: "query" | "operating" | "standing" }
type CommandSpec = CommandSpecLike;   // local: plan 05's CommandSpec does not exist when this lands; its specs satisfy this shape (tsc emits the alias into module.d.ts)
export interface BrainServices {          // what one module hands the next; later plans add fields by declaration merging
  dispatch?: { dispatcher: unknown; readiness: { fill(readiness: unknown): void }; launcher: unknown };   // plan 04's DispatchModule, structurally
  messaging?: { expireQuestions(now: Date, precedent: Precedent): Promise<unknown> };                  // plan 05's Messaging
  executor?: unknown;                       // plan 05's CommandExecutor
  notifySystem?: (text: string) => Promise<void>;   // a system message in the system room (plan 05)
  precedent?: Precedent;                    // plan 06's CosPrecedent
  webhooksRejected?: () => number;          // plan 04's counter
}
export interface Precedent { lookup(question: QuestionRow): Promise<string | null> }   // plan 05's Precedent, structurally
export const NO_PRECEDENT: Precedent;       // always null
export interface BrainInject { launcher?: unknown; boards?: unknown; push?: unknown; sdk?: unknown; fetch?: unknown }   // what tests and plan 09's harness hand to modules
export const MODULE_ORDER: readonly ["messaging", "dispatch", "cos", "web", "cli-login", "security"];
export function collectBrainModules(namespace: Record<string, unknown>): BrainModule[];   // exports named *BrainModule with name, start and stop; MODULE_ORDER first, then the rest by name
// packages/os/src/brain/parts.ts
export interface BrainParts { registerCommand?: (spec: CommandSpecLike) => void }   // Task 11 adds the other parts and loadBrainParts
// packages/os/src/brain/open-store.ts
export async function openOsStore(config: OsConfig, paths: OsPaths, log: Logger, ensure?: typeof ensureOsStack): Promise<OsStore>;
// packages/os/src/brain/brain.ts
export class BrainStartError extends Error {}
export interface BrainDeps {
  paths?: OsPaths; configPath?: string; clock?: Clock; log?: Logger;
  store?: OsStore; journal?: Journal; snapshot?: MemoryOsStore;        // the base store; default openOsStore(...)
  launcher?: BrainLauncher; dispatcher?: BrainDispatcher;              // also ctx.inject.launcher; reconcile runs with them when no module provides dispatch
  boards?: unknown; push?: unknown; sdk?: unknown; fetch?: unknown;    // ctx.inject
  enrolments?: EnrolmentsPort; webauthn?: WebAuthn;
  modules?: BrainModule[];                                             // started in the order given; default [] (Task 11: defaultBrainModules)
  commands?: readonly CommandSpecLike[];                               // plan 08's, registered before any module starts
  parts?: BrainParts;                                                  // default {} (Task 11: loadBrainParts())
  swarmCommand?: string[]; listen?: { host?: string; port?: number }; signals?: boolean; timers?: Timers;
}
export class Brain {
  static start(config: OsConfig, deps?: BrainDeps): Promise<Brain>;
  readonly ctx: BrainContext; readonly periodics: Periodics; readonly url: string; readonly stopped: Promise<void>; readonly reconciled: ReconcileReport | null;
  health(): Promise<HealthReport>;
  reload(): Promise<{ applied: boolean; restartRequired: string[]; error?: string }>;
  handleSignal(signal: "SIGTERM" | "SIGINT" | "SIGHUP"): void;
  stop(): Promise<void>;                                               // idempotent
}
```
- `Brain.start`, in this order (Task 11 adds to steps 8 and 9):
  1. `paths = deps.paths ?? osPaths()`, `clock = deps.clock ?? systemClock`, `log = deps.log ?? createLogger("brain")`; `mkdirSync(paths.cos, { recursive: true, mode: 0o700 })`.
  2. `base = deps.store ?? await openOsStore(config, paths, log)` (`new SubstrateOsStore(await ensure(config, { osHome: paths.home, log }))`; a failure is a `BrainStartError` naming `os_stack.port` and `paths.logs`, and the supervisor restarts the brain). `store = journaledStore(base, deps.journal ?? new Journal(paths.journal, { clock, log }), deps.snapshot ?? new MemoryOsStore(), { clock, log })`; `await store.replay()` (a store that is down leaves it degraded and the start goes on); `await warmSnapshot(store)`.
  3. `hub = new EventHub({ clock, seqFile: paths.eventSeq, validate: (a) => auth.authenticator.stillValid(a) })`.
  4. `auth = await createAuthServices({ store, config, clock, log, paths, hub, webauthn, enrolments })` (this loads `lockdown.json` and, while it is active, revokes again); `registerAuthStandingRunners`.
  5. `api = new ApiServer({ config, log, clock, health: () => this.health(), authenticator: auth.authenticator })`; `api.onClose(() => hub.closeAll())`; `registerAuthRoutes`; `streams = registerStreamRoutes(api, { hub, store, sessions: auth.sessions, lockdown: auth.lockdown, pendingStepUps })`, `pendingStepUps` as in Task 8.
  6. `periodics.add({ name: "journal_replay", everyMs: JOURNAL_REPLAY_EVERY_MS, run: async () => { if (store.degraded && (await base.ping())) await store.replay(); } })`.
  7. Build `ctx`: `periodic(name, everyMs, fn)` is `periodics.add({ name, everyMs, run: fn })`; `registerCommands` calls `parts.registerCommand` for each spec and throws `Error("no command registry in this build (plan 05's commands/registry.ts)")` without it; `inject` comes from `deps`; `swarmCommand = deps.swarmCommand ?? null`.
  8. Commands: a non-empty `deps.commands` goes through `ctx.registerCommands`, and a missing registry makes it `BrainStartError("deps.commands needs plan 05's command registry")`.
  9. Modules: `deps.modules ?? []`, each `await module.start(ctx)` in the order given, after every route above exists. A throw stops the modules already started, in reverse (their errors logged), closes the API and the hub, and rejects with `BrainStartError("brain module <name> failed: <message>")`.
  10. With `services.messaging`: `ctx.periodic("question_expiry", QUESTION_EXPIRY_EVERY_MS, () => messaging.expireQuestions(clock.now(), services.precedent ?? NO_PRECEDENT).then(() => {}))`.
  11. Without `services.dispatch` and with `deps.launcher`: `this.reconciled = await reconcile({ store, launcher, dispatcher: deps.dispatcher ?? NO_DISPATCHER, clock, log, hub })`; with neither, `log.warn("no launcher: live instances stay as recorded")`. Plan 04's mount reconciles inside its own module.
  12. `await api.listen(deps.listen ?? config.bind)`.
  13. `periodics.start()`; with `deps.signals ?? true`, `process.on("SIGTERM" | "SIGINT", …)` → `handleSignal`, which stops, and `"SIGHUP"` → `reload()`.
- `stop()`: remove the brain's signal listeners, `periodics.stop()`, each module's `stop()` in reverse order (errors logged), `hub.flush()`, `api.close()`, then resolve `stopped`.
- `health()`: `store: !store.degraded`; `launcher`: `services.dispatch?.launcher ?? deps.launcher` answered `resources()` within 2 s; `instances`: rows in `LIVE_STATES`; `uptimeSeconds`: whole seconds since `startedAt` by `clock`; `webhooksRejected: services.webhooksRejected?.() ?? 0`; `ok: store && launcher`.
- `reload()`: `loadOsConfig(deps.configPath ?? paths.config)`; a failure is logged ("reload_refused", { reason }) and leaves the config as it is (`applied: false`); otherwise `applyReload(ctx.config, next)`, logging the restart-only keys it reports.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/brain-periodic.test.ts` (`timers` records `{ fn, ms }` for each `setInterval` and `cleared` for each `clearInterval`; a test fires `fn()` itself):
```ts
it("runs each task once at start, then on its interval", async () => {
  const run = vi.fn(async () => {}); periodics.add({ name: "a", everyMs: 15_000, run }); periodics.start();
  await flushMicrotasks();
  expect([run.mock.calls.length, timers.calls.map((c) => c.ms)]).toEqual([1, [15_000]]);
  timers.calls[0].fn(); await flushMicrotasks();
  expect(run).toHaveBeenCalledTimes(2);
});
it("skips a tick while the previous run is in flight, logs failures and keeps going", async () => {
  let release!: () => void; const slow = vi.fn(() => new Promise<void>((r) => { release = r; }));
  const bad = vi.fn(async () => { throw new Error("boom"); });
  periodics.add({ name: "slow", everyMs: 1000, run: slow }); periodics.add({ name: "bad", everyMs: 1000, run: bad }); periodics.start();
  timers.calls[0].fn(); expect(slow).toHaveBeenCalledTimes(1);
  release(); await flushMicrotasks(); timers.calls[0].fn(); expect(slow).toHaveBeenCalledTimes(2);
  timers.calls[1].fn(); await flushMicrotasks();
  expect(bad).toHaveBeenCalledTimes(2);
  expect(log.error).toHaveBeenCalledWith("periodic_failed", { name: "bad", message: "boom" });
});
it("starts a task added after start at once, refuses duplicate names, and stop() awaits runs in flight", async () => {
  periodics.start(); const late = vi.fn(async () => {}); periodics.add({ name: "late", everyMs: 1000, run: late });
  await flushMicrotasks(); expect(late).toHaveBeenCalledTimes(1);
  expect(() => periodics.add({ name: "late", everyMs: 1000, run: late })).toThrow(/late/);
  let release!: () => void; periodics.add({ name: "slow", everyMs: 1000, run: () => new Promise<void>((r) => { release = r; }) });
  let stopped = false; const stopping = periodics.stop().then(() => { stopped = true; });
  await flushMicrotasks(); expect(stopped).toBe(false); release(); await stopping;
  expect(timers.cleared).toHaveLength(2);
});
```
`packages/os/tests/brain.test.ts` (`config` from a temp OS home's `os.json`, written by `writeConfig` and read by `loadOsConfig`; `createHostSecret(paths.hostSecret)` beforehand; `start(extra)` = `Brain.start(config, { paths, configPath: paths.config, store, clock, log, launcher, dispatcher, listen: { port: 0 }, signals: false, timers, modules: [], parts: {}, ...extra })`, the empty `modules` and `parts` keeping Task 11's defaults out of these tests; `fakeModule(name, record, o?)` returns a `BrainModule` that pushes `"start <name>"` and `"stop <name>"` into `record` and runs `o.onStart(ctx)`):
```ts
it("starts on an in-memory store, reconciles before it listens, serves /health and stops", async () => {
  await store.instances.put(instanceRow({ id: "inst-1" })); await store.instances.put(instanceRow({ id: "inst-2" }));
  launcher.statuses.set("inst-1", "running");
  const brain = await start();
  expect([brain.reconciled?.kept, brain.reconciled?.gone, dispatcher.reevaluated]).toEqual([["inst-1"], ["inst-2"], ["board-a"]]);
  expect(await (await fetch(`${brain.url}/health`)).json()).toEqual({ ok: true, store: true, launcher: true, instances: 1, uptimeSeconds: 0, webhooksRejected: 0 });
  clock.advance(5_000); expect((await brain.health()).uptimeSeconds).toBe(5);
  await brain.stop(); await brain.stop();
  await expect(fetch(`${brain.url}/health`)).rejects.toThrow();
});
it("starts modules in the order given after the routes exist, and stops them in reverse", async () => {
  const record: string[] = [];
  const a = fakeModule("a", record, { onStart: (ctx) => {
    expect(ctx.api.routes()).toEqual(expect.arrayContaining([{ method: "GET", path: "/api/me" }, { method: "GET", path: "/api/stream" }]));
    ctx.services.dispatch = { dispatcher: {}, readiness: { fill() {} }, launcher }; ctx.services.webhooksRejected = () => 3; } });
  const b = fakeModule("b", record, { onStart: (ctx) => { ctx.api.route("GET", "/api/t/b", () => ({ b: true })); ctx.periodic("b", 1000, async () => {}); } });
  const brain = await start({ modules: [a, b] });
  expect([record, brain.reconciled, (await brain.health()).webhooksRejected]).toEqual([["start a", "start b"], null, 3]);
  expect([await (await fetch(`${brain.url}/api/t/b`)).json(), brain.periodics.list().map((p) => p.name)]).toEqual([{ b: true }, ["journal_replay", "b"]]);
  await brain.stop();
  expect(record).toEqual(["start a", "start b", "stop b", "stop a"]);
});
it("a module that fails to start stops the ones already started, in reverse, and fails the start", async () => {
  const record: string[] = [];
  const modules = [fakeModule("a", record), fakeModule("b", record), fakeModule("c", record, { onStart: () => { throw new Error("no board token"); } }), fakeModule("d", record)];
  await expect(start({ modules })).rejects.toThrow(/brain module c failed: no board token/);
  expect(record).toEqual(["start a", "start b", "start c", "stop b", "stop a"]);
});
it("registers deps.commands through plan 05's registry before any module starts, and refuses them without one", async () => {
  const registerCommand = vi.fn(); const record: string[] = [];
  const brain = await start({ commands: [CMD_A, CMD_B], parts: { registerCommand }, modules: [fakeModule("m", record, { onStart: () => { record.push(`${registerCommand.mock.calls.length} commands`); } })] });
  expect([registerCommand.mock.calls.slice(-2), record[1]]).toEqual([[[CMD_A], [CMD_B]], `${registerCommand.mock.calls.length} commands`]);   // Task 11 registers the auth-side commands first
  await brain.stop();
  await expect(start({ commands: [CMD_A], parts: {} })).rejects.toThrow(/plan 05's command registry/);
});
it("runs question expiry when a module provides messaging, with its precedent or none", async () => {
  const expireQuestions = vi.fn(async () => []);
  const brain = await start({ modules: [fakeModule("m", [], { onStart: (ctx) => { ctx.services.messaging = { expireQuestions }; } })] });
  await brain.periodics.runNow("question_expiry");
  expect(expireQuestions).toHaveBeenCalledWith(clock.now(), NO_PRECEDENT);
  await brain.stop();
});
it("collectBrainModules keeps *BrainModule exports, in MODULE_ORDER and then by name", () => {
  const m = (name: string) => ({ name, start: async () => {}, stop: async () => {} });
  const found = collectBrainModules({ zBrainModule: m("zeta"), cosBrainModule: m("cos"), messagingBrainModule: m("messaging"), aBrainModule: m("alpha"), notAModule: m("x"), brokenBrainModule: { name: "y" } });
  expect(found.map((x) => x.name)).toEqual(["messaging", "cos", "alpha", "zeta"]);
});
it("reports health honestly: a degraded store, no launcher, and replays once the store answers", async () => {
  const sw = switchableStore(new MemoryOsStore());
  const brain = await start({ store: sw, launcher: undefined });
  sw.down = true; await brain.ctx.store.devices.put(deviceRow()).catch(() => {});
  expect(await brain.health()).toMatchObject({ ok: false, store: false, launcher: false });
  sw.down = false; await brain.periodics.runNow("journal_replay");
  expect([brain.ctx.store.degraded, await sw.devices.get("dev-1")]).toEqual([false, deviceRow()]);
  await brain.stop();
});
it("reload keeps the running config when os.json is broken, and applies limits but not restart-only keys", async () => {
  const brain = await start();
  writeConfig(paths, { ...MINIMAL_CONFIG, limits: { ...(MINIMAL_CONFIG.limits as object), max_instances: 3 }, bind: { port: 4000 } });
  expect(await brain.reload()).toEqual({ applied: true, restartRequired: ["bind"] });
  expect([brain.ctx.config.limits.max_instances, brain.ctx.config.bind.port]).toEqual([3, 3200]);
  writeFileSync(paths.config, "{ not json", { mode: 0o600 });
  expect(await brain.reload()).toEqual({ applied: false, restartRequired: [], error: expect.stringMatching(/not valid JSON/) });
  chmodSync(paths.config, 0o644);
  expect((await brain.reload()).error).toMatch(/0644/);
  expect([brain.ctx.config.limits.max_instances, (await fetch(`${brain.url}/health`)).status]).toEqual([3, 200]);
  await brain.stop();
});
it("handles SIGTERM by stopping, SIGHUP by reloading, and removes its listeners", async () => {
  const before = process.listenerCount("SIGTERM");
  const brain = await start({ signals: true });
  expect(process.listenerCount("SIGTERM")).toBe(before + 1);
  const reload = vi.spyOn(brain, "reload"); brain.handleSignal("SIGHUP"); expect(reload).toHaveBeenCalledTimes(1);
  brain.handleSignal("SIGTERM"); await brain.stopped;
  expect(process.listenerCount("SIGTERM")).toBe(before);
});
it("starts in lockdown when lockdown.json says so, and never writes os.json", async () => {
  await store.devices.put(deviceRow());
  await store.sessions.put(makeRow("sessions", { id: "sess-1", humanId: "part-owner", deviceId: "dev-1", revokedAt: null, expiresAt: "2026-10-26T12:00:00.000Z" }));
  Lockdown.writeState(paths.lockdown, { active: true, engagedAt: T0.toISOString(), engagedBy: "host", tokenEpoch: 1 });
  const bytes = readFileSync(paths.config);
  const brain = await start();
  expect((await store.sessions.get("sess-1"))?.revokedAt).not.toBeNull();
  expect((await fetch(`${brain.url}/api/auth/login/options`, { method: "POST", headers: { "x-swarm-os": "1", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  await brain.reload();
  await fetch(`${brain.url}/api/lockdown/release`, { method: "POST", headers: { authorization: `Bearer ${brain.ctx.auth.hostSecret.bearer()}` } });
  expect(readFileSync(paths.config).equals(bytes)).toBe(true);
  await brain.stop();
});
it("names the OS stack port and the logs folder when the stack will not come up", async () => {
  const ensure = vi.fn(async () => { throw new Error("docker: not running"); });
  await expect(openOsStore(config, paths, log, ensure)).rejects.toThrow(/49338.*logs|logs.*49338/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/brain-periodic.test.ts tests/brain.test.ts`
Expected: FAIL, `Cannot find module '../src/brain/periodic.js'`.

- [ ] **Step 3: Implement the four files with the order and rules above; export `Api`, `Periodics`, `PeriodicTask`, `Timers`, the interval constants, `BrainModule`, `BrainContext`, `BrainServices`, `BrainInject`, `CommandSpecLike`, `Precedent`, `NO_PRECEDENT`, `MODULE_ORDER`, `collectBrainModules`, `openOsStore`, `Brain`, `BrainDeps`, `BrainParts`, `BrainStartError` from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/brain packages/os/src/api/server.ts packages/os/src/index.ts packages/os/tests/brain-periodic.test.ts packages/os/tests/brain.test.ts
git commit -m "feat(os): brain lifecycle with ordered modules, periodic tasks, reload, signals and health"
```

---

### Task 11: Default composition: the auth-side commands, the chief of staff, terminal sign-in, the dashboard

**Files:**
- Create: `packages/os/src/brain/builtin-modules.ts`, `packages/os/src/auth/commands.ts`
- Modify: `packages/os/src/brain/parts.ts` (the other parts and `loadBrainParts`), `packages/os/src/brain/brain.ts` (defaults for `parts` and `modules`, and the auth-side commands), `packages/os/src/index.ts`
- Test: `packages/os/tests/brain-composition.test.ts`

**Interfaces:**
- Consumes: Task 10 (`Brain`, `BrainModule`, `BrainContext`, `collectBrainModules`, `MODULE_ORDER`, `NO_PRECEDENT`), Task 8 (`AuthServices`); through `loadBrainParts` only: plan 05's `registerCommand` (`commands/registry.ts`), plan 06's `createChiefOfStaff`, `tapDecisions` (`cos/index.ts`) and `AgentSdkFacade` (`cos/sdk.ts`), plan 07's `registerStatic` (`api/static.ts`), plan 08's `mountCliLogin` and `CliLogins` (`api/cli-login.ts`).
- Produces:
```ts
// packages/os/src/auth/commands.ts: the auth-side commands, CommandSpec-shaped for plan 05's registerCommand
export interface AuthCommandSpec extends CommandSpecLike { kind: "operating" | "standing"; args: z.ZodType<Record<string, unknown>>;
  run(ctx: { actor: Actor }, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; data?: unknown }> }
export function authCommands(auth: AuthServices, deps: { store: OsStore; clock: Clock; hub: EventHub }): AuthCommandSpec[];
  // devices revoke { device }, devices approve { enrolment, confirmer = false } and lockdown release {} are standing; lockdown {} is operating and host-only
// packages/os/src/brain/parts.ts
export interface CosHandlePort {                 // plan 06's CosHandle, structurally
  cos: unknown; precedent: Precedent; periodics: readonly { name: string; everyMs: number; tick(): Promise<void> }[];
  start(opts: { events: unknown; schedule?: boolean }): Promise<void>; stop(): void;
}
export interface CosWiringDeps { store: OsStore; messaging: unknown; executor: unknown; config: OsConfig; clock: Clock; sdk: unknown; log: Logger;
  runtime: () => { dispatcher: unknown; launcher: unknown } }   // plan 06's CreateCosDeps, structurally; runtime is read at call time
export interface BrainParts {                    // Task 10's interface, completed
  registerCommand?: (spec: CommandSpecLike) => void;                      // plan 05
  createChiefOfStaff?: (deps: CosWiringDeps) => Promise<CosHandlePort>;   // plan 06
  tapDecisions?: (dispatcher: unknown) => unknown;                        // plan 06
  createSdk?: (config: OsConfig, paths: OsPaths) => unknown;              // new AgentSdkFacade({ model: cos.model, auth: cos.auth, cwd: paths.cos, claudePath: null })
  registerStatic?: (api: Api) => Promise<void>;                           // plan 07
  mountCliLogin?: (api: Api, logins: unknown) => void;                    // plan 08
  CliLogins?: new (deps: { store: OsStore; messaging: unknown; clock: Clock; publicUrl: string;
    issueSession(input: { humanId: string; deviceId: string; address: string }): Promise<{ token: string; expiresAt: string }> }) => unknown;   // plan 08
}
export const DASHBOARD_MISSING_HTML = "<!doctype html><meta charset=\"utf-8\"><title>Swarm OS</title><p>The dashboard is not built into this brain.</p>";
export function isMissingModule(err: unknown, file: string): boolean;     // ERR_MODULE_NOT_FOUND (Node), or "Cannot find module" (Bun), naming file
export async function loadBrainParts(): Promise<BrainParts>;
// packages/os/src/brain/builtin-modules.ts
export function cosModule(parts: BrainParts, o?: { sdk?: unknown }): BrainModule;        // name "cos"
export function dashboardModule(parts: BrainParts): BrainModule;                        // name "web"
export function cliLoginModule(parts: BrainParts): BrainModule;                         // name "cli-login"
export function defaultBrainModules(parts: BrainParts, namespace: Record<string, unknown>, o?: { sdk?: unknown }): BrainModule[];
  // collectBrainModules(namespace), plus each built-in whose name no discovered module has (cos only with parts.createChiefOfStaff,
  // cli-login only with parts.mountCliLogin), all in MODULE_ORDER
```
- `loadBrainParts` imports `../commands/registry.js`, `../cos/index.js`, `../cos/sdk.js`, `../api/static.js` and `../api/cli-login.js` with literal `import()` calls, each on a line under `// @ts-ignore -- <plan>'s file; absent until it lands` (so `tsc` passes before and after; Bun bundles a literal import once the file exists), casts each module `as unknown as` its port, and leaves a part `undefined` when `isMissingModule` says its file is missing. Any other import error is thrown.
- `Brain.start` now uses `parts = deps.parts ?? await loadBrainParts()` and `modules = deps.modules ?? defaultBrainModules(parts, await import("../index.js"), { sdk: deps.sdk })`, and at step 8, before `deps.commands`, registers `authCommands(...)` through `ctx.registerCommands` when `parts.registerCommand` exists. `devices revoke` runs the same revocation as the `["devices", "revoke"]` runner; `devices approve` calls `auth.enrolments?.approve(ctx, enrolment, { confirmer })` and without it answers `{ ok: false, text: "Device enrolment is not available in this build." }`; `lockdown` (operating; plan 09's gate keeps it to the host) engages as `ctx.actor` and answers `ok: false` for anyone else; `lockdown release` (standing) releases only for the host. `register`, `unregister`, `set ask_first` and `set limits` are plan 08's and arrive in `deps.commands`.
- `cosModule.start(ctx)`: without `parts.createChiefOfStaff` it returns at once; without `services.messaging`, `services.executor` or `services.dispatch` it logs that the chief of staff waits for plans 04 and 05, and returns. Otherwise `handle = await parts.createChiefOfStaff({ store, messaging, executor, config, clock, log, sdk: o.sdk ?? parts.createSdk?.(config, paths), runtime: () => ({ dispatcher: dispatch.dispatcher, launcher: dispatch.launcher }) })`, `dispatch.readiness.fill(handle.cos)`, `ctx.periodic(p.name, p.everyMs, p.tick)` for each of `handle.periodics`, `services.precedent = handle.precedent`, and `await handle.start({ events: parts.tapDecisions ? parts.tapDecisions(dispatch.dispatcher) : { onDecision: () => () => {} }, schedule: false })` (the brain owns the timers; this runs after every route exists and before the brain listens, which the chief of staff's subscriptions do not need). A rejection anywhere in that (missing prompts, no model) is logged ("cos_start_failed") and posted with `services.notifySystem?.("The chief of staff could not start: <reason>. Cards are assessed by static readiness until it can.")`; the readiness slot keeps plan 04's `StaticReadiness`, and the module's start resolves so the brain starts. `stop()` calls `handle.stop()`.
- `dashboardModule.start(ctx)`: `await parts.registerStatic(ctx.api)` when present; when it is missing or throws (logged), and `ctx.api.routes()` has no `GET /`, `GET /` answers 200 `text/html; charset=utf-8` with `DASHBOARD_MISSING_HTML`.
- `cliLoginModule.start(ctx)`: without `parts.mountCliLogin`, `parts.CliLogins` or `services.messaging` it returns at once; otherwise `parts.mountCliLogin(ctx.api, new parts.CliLogins({ store, messaging, clock, publicUrl: config.public_url, issueSession: async (i) => { const { token, session } = await ctx.auth.issueSession({ ...i, client: "cli" }); return { token, expiresAt: session.expiresAt }; } }))`. This is the one `mountCliLogin` call plan 08's Task 1 asks for; plan 08 finds it in place and adds no second one (registering a route twice throws at start).

- [ ] **Step 1: Write the failing tests in `packages/os/tests/brain-composition.test.ts`**

`provider` is a test module named `"messaging"` that copies the fakes in `provided` into `ctx.services`: `provided.messaging = { expireQuestions: vi.fn(async () => []) }`, `provided.executor = {}`, `provided.notifySystem = vi.fn(async () => {})` and `provided.dispatch = { dispatcher: DISPATCHER, readiness: { fill: vi.fn() }, launcher }`; `start(parts, extra)` is Task 10's helper with `modules: [provider, cosModule(parts, { sdk: SDK }), dashboardModule(parts), cliLoginModule(parts)]` and `parts: { registerCommand, ...parts }`.
```ts
it("wires the chief of staff: readiness, its deps, periodics, precedent, start before the brain listens, stop", async () => {
  const handle = { cos: COS, precedent: PRECEDENT, periodics: [{ name: "cos.answers", everyMs: 30_000, tick: vi.fn(async () => {}) }], start: vi.fn(async () => {}), stop: vi.fn() };
  const createChiefOfStaff = vi.fn(async () => handle), tapDecisions = vi.fn(() => EVENTS);
  const brain = await start({ createChiefOfStaff, tapDecisions });
  const deps = createChiefOfStaff.mock.calls[0][0];
  expect(deps).toMatchObject({ store: brain.ctx.store, messaging: provided.messaging, executor: provided.executor, sdk: SDK });
  expect(deps.runtime()).toEqual({ dispatcher: DISPATCHER, launcher });
  expect(provided.dispatch.readiness.fill).toHaveBeenCalledWith(COS);
  expect(brain.periodics.list()).toEqual(expect.arrayContaining([{ name: "cos.answers", everyMs: 30_000 }, { name: "question_expiry", everyMs: 60_000 }]));
  await brain.periodics.runNow("question_expiry");
  expect(provided.messaging.expireQuestions).toHaveBeenCalledWith(clock.now(), PRECEDENT);
  expect([handle.start.mock.calls, tapDecisions.mock.calls]).toEqual([[[{ events: EVENTS, schedule: false }]], [[DISPATCHER]]]);
  await brain.stop(); expect(handle.stop).toHaveBeenCalledTimes(1);
});
it("starts without a chief of staff when it cannot start, and says so in the system room", async () => {
  const brain = await start({ createChiefOfStaff: vi.fn(async () => { throw new Error("prompts/system.md is missing"); }) });
  expect(provided.dispatch.readiness.fill).not.toHaveBeenCalled();
  expect(provided.notifySystem).toHaveBeenCalledWith(expect.stringMatching(/chief of staff could not start: prompts\/system\.md is missing/));
  await brain.periodics.runNow("question_expiry");
  expect(provided.messaging.expireQuestions).toHaveBeenCalledWith(clock.now(), NO_PRECEDENT);
  expect((await fetch(`${brain.url}/health`)).status).toBe(200);
  await brain.stop();
});
it("registers the auth-side commands before plan 08's, and nothing named register", async () => {
  const brain = await start({}, { commands: [CMD_A] });
  const specs = registerCommand.mock.calls.map(([spec]) => spec as AuthCommandSpec);
  expect(specs.map((c) => [c.name, c.kind])).toEqual([["devices revoke", "standing"], ["devices approve", "standing"], ["lockdown", "operating"], ["lockdown release", "standing"], [CMD_A.name, CMD_A.kind]]);
  expect(await specs[1].run({ actor: { kind: "host" } }, { enrolment: "enr-1", confirmer: false })).toEqual({ ok: false, text: "Device enrolment is not available in this build." });
  expect([await specs[2].run({ actor: { kind: "cos" } }, {}), await specs[3].run({ actor: { kind: "cos" } }, {})]).toEqual([expect.objectContaining({ ok: false }), expect.objectContaining({ ok: false })]);
  await brain.stop();
});
it("mounts plan 08's terminal sign-in with a session issuer of the shape it expects", async () => {
  const mountCliLogin = vi.fn(); let issuer!: (i: { humanId: string; deviceId: string; address: string }) => Promise<{ token: string; expiresAt: string }>;
  class CliLogins { constructor(deps: { issueSession: typeof issuer }) { issuer = deps.issueSession; } }
  const brain = await start({ mountCliLogin, CliLogins });
  expect(mountCliLogin).toHaveBeenCalledWith(brain.ctx.api, expect.any(CliLogins));
  await brain.ctx.store.devices.put(deviceRow());
  expect(await issuer({ humanId: "part-owner", deviceId: "dev-1", address: "100.64.0.7" })).toEqual({ token: expect.stringMatching(/^sess_/), expiresAt: expect.any(String) });
  await brain.stop();
});
it("serves the dashboard through registerStatic, or a one-line page when it is missing or fails", async () => {
  const withWeb = await start({ registerStatic: async (api) => api.route("GET", "/", (_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("dash"); }) });
  expect(await (await fetch(`${withWeb.url}/`)).text()).toBe("dash"); await withWeb.stop();
  for (const parts of [{}, { registerStatic: async () => { throw new Error("no embedded build"); } }]) {
    const brain = await start(parts);
    const page = await fetch(`${brain.url}/`);
    expect([page.status, page.headers.get("content-type"), await page.text()]).toEqual([200, "text/html; charset=utf-8", DASHBOARD_MISSING_HTML]);
    await brain.stop();
  }
});
it("defaultBrainModules adds the built-ins a plan has not replaced, in MODULE_ORDER", () => {
  const m = (name: string) => ({ name, start: async () => {}, stop: async () => {} });
  const parts = { createChiefOfStaff: vi.fn(), mountCliLogin: vi.fn() };
  expect(defaultBrainModules(parts, { dispatchBrainModule: m("dispatch"), messagingBrainModule: m("messaging") }).map((x) => x.name)).toEqual(["messaging", "dispatch", "cos", "web", "cli-login"]);
  const own = m("cos");
  expect(defaultBrainModules(parts, { cosBrainModule: own }).find((x) => x.name === "cos")).toBe(own);
  expect(defaultBrainModules({}, {}).map((x) => x.name)).toEqual(["web"]);
});
it("finds missing parts by file name and loads whatever has landed", async () => {
  const node = Object.assign(new Error("Cannot find module '/path/to/dist/cos/index.js' imported from /path/to/dist/brain/parts.js"), { code: "ERR_MODULE_NOT_FOUND" });
  const bun = new Error("Cannot find module './../api/static.js' from '/$bunfs/root/swarm'");
  const inner = Object.assign(new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"), { code: "ERR_MODULE_NOT_FOUND" });
  expect([isMissingModule(node, "cos/index.js"), isMissingModule(bun, "api/static.js"), isMissingModule(inner, "cos/index.js")]).toEqual([true, true, false]);
  const parts = await loadBrainParts();
  for (const p of Object.values(parts)) expect(p === undefined || typeof p === "function").toBe(true);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/brain-composition.test.ts`
Expected: FAIL, `Cannot find module '../src/brain/builtin-modules.js'`.

- [ ] **Step 3: Implement `parts.ts`, `builtin-modules.ts`, `auth/commands.ts` and the `brain.ts` defaults with the rules above; export `loadBrainParts`, `BrainParts`, `CosHandlePort`, `CosWiringDeps`, `DASHBOARD_MISSING_HTML`, `isMissingModule`, `cosModule`, `dashboardModule`, `cliLoginModule`, `defaultBrainModules`, `authCommands`, `AuthCommandSpec` from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/brain packages/os/src/auth/commands.ts packages/os/src/index.ts packages/os/tests/brain-composition.test.ts
git commit -m "feat(os): default brain composition with the auth commands, chief of staff, terminal sign-in and dashboard"
```

---

### Task 12: Supervisor files, install and uninstall

**Files:**
- Create: `packages/os/src/supervisor/launchd.ts`, `packages/os/src/supervisor/systemd.ts`, `packages/os/src/supervisor/index.ts`
- Test: `packages/os/tests/supervisor.test.ts`
- Modify: `packages/os/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`ExecFn`).
- Produces:
```ts
// packages/os/src/supervisor/index.ts
export interface SupervisorSpec { command: string[]; home: string; env: Record<string, string> }   // command ends in "os", "start"; home is the OS home
export interface SupervisorTarget { platform: NodeJS.Platform; userHome: string; uid: number; run: ExecFn; env?: NodeJS.ProcessEnv }
export function supervisorEnv(env: NodeJS.ProcessEnv): Record<string, string>;   // only PATH, SWARM_OS_HOME and SWARM_NODE, when set
export async function installSupervisor(spec: SupervisorSpec, target: SupervisorTarget): Promise<{ kind: "launchd" | "systemd"; path: string; commands: string[][] }>;
export async function uninstallSupervisor(target: SupervisorTarget): Promise<{ kind: "launchd" | "systemd"; removed: string | null; commands: string[][] }>;
export function installedSupervisor(target: Pick<SupervisorTarget, "platform" | "userHome" | "env">): { kind: "launchd" | "systemd"; path: string } | null;
// packages/os/src/supervisor/launchd.ts
export const LAUNCHD_LABEL = "ai.mnmal.swarm-os";
export function launchdPlistPath(userHome: string): string;            // <userHome>/Library/LaunchAgents/ai.mnmal.swarm-os.plist
export function launchdPlist(spec: SupervisorSpec): string;
// packages/os/src/supervisor/systemd.ts
export const SYSTEMD_UNIT = "swarm-os.service";
export function systemdUnitPath(userHome: string, env?: NodeJS.ProcessEnv): string;   // ${XDG_CONFIG_HOME:-<userHome>/.config}/systemd/user/swarm-os.service
export function systemdUnit(spec: SupervisorSpec): string;
```
- The plist, every value XML-escaped (`&`, `<`, `>`, `"`): `Label` `ai.mnmal.swarm-os`; `ProgramArguments` one `<string>` per command word; `EnvironmentVariables` from `spec.env`; `WorkingDirectory` the OS home; `RunAtLoad` `<true/>`; `KeepAlive` `<dict><key>SuccessfulExit</key><false/></dict>`, so launchd restarts the brain after a crash but not after the clean exit 0 of `swarm os stop`; `ThrottleInterval` `10`; `StandardOutPath` `<home>/logs/brain.out.log`; `StandardErrorPath` `<home>/logs/brain.err.log`.
- The unit: `[Unit]` `Description=Swarm OS brain`, `After=network-online.target`, `Wants=network-online.target`; `[Service]` `Type=simple`, `ExecStart=` each word double-quoted (`\` and `"` backslash-escaped, `%` doubled), `WorkingDirectory=<home>`, one `Environment="KEY=value"` per variable (same escaping), `Restart=on-failure`, `RestartSec=10`, `StandardOutput=append:<home>/logs/brain.out.log`, `StandardError=append:<home>/logs/brain.err.log`; `[Install]` `WantedBy=default.target`.
- Commands: macOS install writes the plist (mode 0644, it holds no secret), runs `launchctl bootout gui/<uid>/ai.mnmal.swarm-os` (a failure is ignored: nothing was loaded), then `launchctl bootstrap gui/<uid> <path>` (a failure throws its stderr); uninstall runs the same `bootout` (failure ignored) and removes the file. Linux install writes the unit, runs `systemctl --user daemon-reload` and `systemctl --user enable --now swarm-os.service` (a failure throws); uninstall runs `systemctl --user disable --now swarm-os.service` (failure ignored), removes the file and runs `daemon-reload`. Any other platform → `Error("swarm os install supports macOS (launchd) and Linux (systemd user units)")`.

- [ ] **Step 1: Write the failing tests in `packages/os/tests/supervisor.test.ts`**

`spec = { command: ["/path/to/swarm", "os", "start"], home: "/path/to/os", env: { PATH: "/usr/bin:/bin" } }`; `fakeRun` records each call and answers `{ code: 0, stdout: "", stderr: "" }` unless told otherwise.
```ts
it("writes a launchd agent that starts at login and restarts only after a failure", () => {
  const plist = launchdPlist(spec);
  expect(plist).toMatch(/<key>Label<\/key>\s*<string>ai\.mnmal\.swarm-os<\/string>/);
  expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/path\/to\/swarm<\/string>\s*<string>os<\/string>\s*<string>start<\/string>\s*<\/array>/);
  expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/path\/to\/os\/logs\/brain\.err\.log<\/string>/);
  expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
  expect(launchdPlist({ ...spec, command: ["/path/to/a&b<c", "os", "start"] })).toContain("<string>/path/to/a&amp;b&lt;c</string>");
  expect(launchdPlistPath("/path/to/user")).toBe("/path/to/user/Library/LaunchAgents/ai.mnmal.swarm-os.plist");
});
it("writes a systemd user unit that restarts only after a failure, quoting what systemd would read", () => {
  const unit = systemdUnit({ ...spec, command: ["/path/to/50% swarm", "os", "start"] });
  expect(unit).toContain('ExecStart="/path/to/50%% swarm" "os" "start"');
  expect(unit).toContain("Restart=on-failure\nRestartSec=10\n");
  expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
  expect(unit).toContain("StandardError=append:/path/to/os/logs/brain.err.log");
  expect(unit).toContain("[Install]\nWantedBy=default.target");
  expect(systemdUnitPath("/path/to/user", {})).toBe("/path/to/user/.config/systemd/user/swarm-os.service");
  expect(systemdUnitPath("/path/to/user", { XDG_CONFIG_HOME: "/path/to/xdg" })).toBe("/path/to/xdg/systemd/user/swarm-os.service");
});
it("carries only PATH, SWARM_OS_HOME and SWARM_NODE into the supervisor", () => {
  expect(supervisorEnv({ PATH: "/usr/bin", SWARM_OS_HOME: "/path/to/os", SWARM_NODE: "/path/to/node", ANTHROPIC_API_KEY: "sk-ant-x", GH_TOKEN: "ghp_x", HOME: "/path/to/user" }))
    .toEqual({ PATH: "/usr/bin", SWARM_OS_HOME: "/path/to/os", SWARM_NODE: "/path/to/node" });
});
it("installs and uninstalls the launchd agent", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "supervisor-")); const run = fakeRun({ failFirst: true });   // the first bootout fails: nothing was loaded yet
  const out = await installSupervisor(spec, { platform: "darwin", userHome, uid: 501, run });
  expect([out.kind, existsSync(out.path)]).toEqual(["launchd", true]);
  expect(out.commands).toEqual([["launchctl", "bootout", "gui/501/ai.mnmal.swarm-os"], ["launchctl", "bootstrap", "gui/501", out.path]]);
  expect(installedSupervisor({ platform: "darwin", userHome })).toEqual({ kind: "launchd", path: out.path });
  expect((await uninstallSupervisor({ platform: "darwin", userHome, uid: 501, run })).removed).toBe(out.path);
  expect(existsSync(out.path)).toBe(false);
  await expect(installSupervisor(spec, { platform: "darwin", userHome, uid: 501, run: fakeRun({ failBootstrap: "Bootstrap failed: 5" }) })).rejects.toThrow(/Bootstrap failed: 5/);
});
it("installs and uninstalls the systemd unit, and refuses other platforms", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "supervisor-")); const run = fakeRun();
  const out = await installSupervisor(spec, { platform: "linux", userHome, uid: 1000, run, env: {} });
  expect(out.commands).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "swarm-os.service"]]);
  expect((await uninstallSupervisor({ platform: "linux", userHome, uid: 1000, run, env: {} })).commands)
    .toEqual([["systemctl", "--user", "disable", "--now", "swarm-os.service"], ["systemctl", "--user", "daemon-reload"]]);
  await expect(installSupervisor(spec, { platform: "win32", userHome, uid: 0, run })).rejects.toThrow(/supports macOS \(launchd\) and Linux/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/supervisor.test.ts`
Expected: FAIL, `Cannot find module '../src/supervisor/index.js'`.

- [ ] **Step 3: Implement the three files with the rules above; export them from the index block**

- [ ] **Step 4: Run the package suite and the build**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && pnpm build`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/supervisor packages/os/src/index.ts packages/os/tests/supervisor.test.ts
git commit -m "feat(os): launchd agent and systemd unit for the brain, restarted only after a failure"
```

---

### Task 13: `swarm os` and the `os`, `top` and `room-mcp` dispatch in `main.ts`

**Files:**
- Create: `packages/cli/src/cli/os.ts`, `packages/cli/src/cli/optional-command.ts`
- Modify: `packages/cli/src/cli/main.ts` (Step 4 says exactly where), `packages/cli/package.json` (`"@mnmal-ai/swarm-os": "workspace:*"` in `dependencies`), `pnpm-lock.yaml`
- Test: `packages/cli/tests/os-cli.test.ts`, `packages/cli/tests/os-main.test.ts`

**Interfaces:**
- Consumes: from `@mnmal-ai/swarm-os`: `osHome`, `osPaths`, `loadOsConfig`, `OsConfigError`, `initOsHome`, `readHostSecret`, `Lockdown`, `Brain`, `BrainDeps`, `installSupervisor`, `uninstallSupervisor`, `installedSupervisor`, `supervisorEnv`, `execFileRunner`, `ExecFn`, `HealthReport`; from the CLI: `swarmSelfCommand()` (`./codex-hook.js`).
- Produces:
```ts
// packages/cli/src/cli/optional-command.ts
export function isMissingModule(err: unknown, file: string): boolean;     // ERR_MODULE_NOT_FOUND (Node, tsx) or "Cannot find module" (Bun), naming file
export async function runOptionalCommand(name: string, file: string, load: () => Promise<number | void>): Promise<number | null>;
  // file missing → stderr "swarm <name> is not available in this build yet." and 1; a number → that code; undefined → null (the command keeps running on its own handles); any other error is thrown
// packages/cli/src/cli/os.ts
export const OS_SUBCOMMANDS: readonly ["init", "start", "stop", "status", "install", "uninstall", "lockdown", "confirm"];
export interface OsCliDeps { env?: NodeJS.ProcessEnv; out?: (line: string) => void; err?: (line: string) => void; fetch?: typeof fetch; exec?: ExecFn;
  platform?: NodeJS.Platform; userHome?: string; uid?: number; self?: string[];
  startBrain?: (config: OsConfig, deps: BrainDeps) => Promise<{ url: string; stopped: Promise<void> }>;
  pid?: number; processCommand?: (pid: number) => Promise<string | null>; kill?: (pid: number, signal: NodeJS.Signals | 0) => void; sleep?: (ms: number) => Promise<void> }
export async function runOs(positional: string[], flags: Record<string, string>, deps?: OsCliDeps): Promise<number>;
export function brainUrl(config: OsConfig): string;                        // http://127.0.0.1:<bind.port>
```
- `runOs` is one `switch (positional[0])` over `OS_SUBCOMMANDS`, so plan 08's guard (`if (routesToOsCommand(positional)) return runOsCommand(positional, flags);`, one import and one line before the switch) sends command messages and `login` to plan 08. An empty argument list → usage, 0; any other subcommand → usage, 1. Calls to the brain go to `brainUrl(config)` with `Authorization: Bearer <readHostSecret(paths.hostSecret).bearer()>`; a rejected `fetch` means the brain is not running. A process is live when `processCommand(pid)` is non-null; the defaults are `ps -o command= -p <pid>` through `exec` (null on a non-zero exit), `process.kill`, a `setTimeout` sleep and `process.pid`.
- Subcommands, with the lines they print (tests match them):
  - `init [--public-url <url>] [--tailscale] [--owner <name>] [--port <n>] [--roots <a,b>]` → `initOsHome({ home: osHome(env), … })`; `Swarm OS home: <home>`, `Config: <path> (limits live here; nothing in the API can change them)`, when kept `os.json exists; public_url stays <url> (changing it invalidates every enrolled passkey)`, `Open this link on your phone within 15 minutes to enrol it (one use):`, `  <link>`, `Next: swarm os install (supervised) or swarm os start (this terminal).`; 0.
  - `start` → `loadOsConfig` (an `OsConfigError` prints its message, 1); a `brain.pid` naming a live process whose command contains `os start` → `The brain is already running (pid <n>).`, 1; else write `brain.pid`, `startBrain(config, { configPath, paths, swarmCommand: self })` (default `Brain.start`, `self` default `swarmSelfCommand()`), print `Brain listening on <url>`, await `stopped`, remove `brain.pid`, 0.
  - `stop` → no `brain.pid`, or one naming no live process → remove the file, `The brain is not running.`, 0; a pid whose command does not contain `os start` → `brain.pid points at pid <n>, which is not a swarm brain; not signalling it.`, remove the file, 1; else `SIGTERM`, poll `kill(pid, 0)` every 200 ms for up to 10 s → `Brain stopped.`, 0 (a timeout prints that it is still running, 1).
  - `status` → `GET /health` → `brain: up <n>s at <url> · store ✓|✗ · launcher ✓|✗ · instances <n> · webhooks rejected <n>`, `lockdown: off` or `lockdown: on since <engagedAt>` (from `Lockdown.readState`), `supervisor: launchd|systemd|not installed`; 0. Unreachable → `brain: not running at <url>` plus the other two lines, 1.
  - `install` → `installSupervisor({ command: [...self, "os", "start"], home, env: supervisorEnv(env) }, { platform, userHome, uid, run: exec })` → `Installed the <kind> unit at <path>; the brain starts now and at every login.`; `uninstall` → `Removed <path>.` or `No supervisor unit is installed.`; an error prints its message, 1.
  - `lockdown` → `POST /api/lockdown` → `Lockdown engaged: every session and room token is revoked and dispatching has stopped; instances keep running. Lift it on this host with swarm os lockdown release.`; with the brain unreachable, `Lockdown.writeState(paths.lockdown, { active: true, engagedAt: now, engagedBy: "host", tokenEpoch: previous + 1 })` and the same line plus ` The brain is not running; it applies this when it starts.`; 0. `lockdown release` → `POST /api/lockdown/release` answers 428 with `stepUpId`; `GET /api/stepup/pending` gives its code, and the command prints `Lifting the lockdown needs one more step. Run: swarm os confirm <stepUpId> <code>`; 0. Unreachable → the file with `active: false` and `Lockdown released (the brain is not running). People sign in again with their passkeys.`; 0.
  - `confirm` → no further words: `GET /api/stepup/pending` → one line per entry, `<stepUpId> · <command joined> · from <device, the host or the chief of staff> · code <code> · <seconds>s left`, then `Confirm one with: swarm os confirm <stepUpId> <code>`, or `No standing command is waiting for confirmation.`; 0. `confirm <stepUpId> <code>` → `POST /api/stepup/confirm { stepUpId, code }` → `Confirmed: <command joined>` and the result's text; 0 when `result.ok`, else 1. An error envelope prints `<code>: <message>`, 1; one word only → usage, 1.

- [ ] **Step 1: Write the failing tests**

`packages/cli/tests/os-cli.test.ts` (each test sets `SWARM_OS_HOME` to a temp dir and runs `initOsHome` there; `deps` also carries `platform: "darwin"` and a fresh temp `userHome`, so no real supervisor file is read; `deps.out`/`deps.err` collect lines into `out`/`err`; `fetch` is a stub that records each request in `requests` and answers from the table `answer(route, status, body)` fills, and `unreachable()` makes it reject every request until the next `answer`):
```ts
it("init writes the OS home and prints the one-time link", async () => {
  const code = await runOs(["init"], { "public-url": "https://brain.example.test" }, deps);
  expect(code).toBe(0);
  expect(out).toEqual(expect.arrayContaining([expect.stringMatching(/^  https:\/\/brain\.example\.test\/#enrol=[A-Za-z0-9_-]{43}$/)]));
  expect(statSync(join(home, "os.json")).mode & 0o777).toBe(0o600);
});
it("status prints the brain's health, lockdown and supervisor, and says when the brain is down", async () => {
  answer("GET /health", 200, { ok: true, store: true, launcher: false, instances: 2, uptimeSeconds: 42, webhooksRejected: 1 });
  expect(await runOs(["status"], {}, deps)).toBe(0);
  expect(out).toEqual(["brain: up 42s at http://127.0.0.1:3200 · store ✓ · launcher ✗ · instances 2 · webhooks rejected 1", "lockdown: off", "supervisor: not installed"]);
  unreachable();
  expect([await runOs(["status"], {}, deps), out.at(-3)]).toEqual([1, "brain: not running at http://127.0.0.1:3200"]);
});
it("confirm lists pending step-ups with their codes, and confirms one as the host", async () => {
  answer("GET /api/stepup/pending", 200, { pending: [{ stepUpId: "stepup-1", command: ["devices", "revoke", "dev-2"], expiresAt: "2026-10-25T12:02:00.000Z", code: "482913", requester: { kind: "human", deviceId: "dev-1", address: "100.64.0.7" } }] });
  expect(await runOs(["confirm"], {}, deps)).toBe(0);
  expect(out[0]).toMatch(/^stepup-1 · devices revoke dev-2 · from dev-1 · code 482913 · \d+s left$/);
  answer("POST /api/stepup/confirm", 200, { stepUpId: "stepup-1", command: ["devices", "revoke", "dev-2"], result: { ok: true, text: "Revoked laptop (dev-2) and 1 sessions" } });
  expect(await runOs(["confirm", "stepup-1", "482913"], {}, deps)).toBe(0);
  const req = requests.at(-1)!;
  expect([req.method, req.url, req.headers.authorization, req.body]).toEqual(["POST", "http://127.0.0.1:3200/api/stepup/confirm",
    `Bearer host_${readFileSync(join(home, "host.secret"), "utf8").trim()}`, { stepUpId: "stepup-1", code: "482913" }]);
  expect(out.slice(-2)).toEqual(["Confirmed: devices revoke dev-2", "Revoked laptop (dev-2) and 1 sessions"]);
  answer("POST /api/stepup/confirm", 403, { error: { code: "stepup_failed", message: "That code is not right." } });
  expect([await runOs(["confirm", "stepup-1", "000000"], {}, deps), err.at(-1)]).toEqual([1, "stepup_failed: That code is not right."]);
  expect(await runOs(["confirm", "stepup-1"], {}, deps)).toBe(1);
});
it("lockdown goes through the brain, or into lockdown.json when the brain is down", async () => {
  answer("POST /api/lockdown", 200, { active: true, engagedAt: "2026-10-25T12:00:00.000Z" });
  expect(await runOs(["lockdown"], {}, deps)).toBe(0);
  unreachable();
  expect(await runOs(["lockdown"], {}, deps)).toBe(0);
  expect(Lockdown.readState(join(home, "lockdown.json"))).toMatchObject({ active: true, engagedBy: "host", tokenEpoch: 1 });
  expect(out.at(-1)).toMatch(/The brain is not running; it applies this when it starts\.$/);
  expect([await runOs(["lockdown", "release"], {}, deps), Lockdown.readState(join(home, "lockdown.json")).active]).toEqual([0, false]);
  answer("POST /api/lockdown/release", 428, { error: { code: "stepup_required", message: "confirm it", stepUpId: "stepup-9", expiresAt: "2026-10-25T12:02:00.000Z" } });
  answer("GET /api/stepup/pending", 200, { pending: [{ stepUpId: "stepup-9", command: ["lockdown", "release"], expiresAt: "2026-10-25T12:02:00.000Z", code: "123456", requester: { kind: "host" } }] });
  expect([await runOs(["lockdown", "release"], {}, deps), out.at(-1)]).toEqual([0, "Lifting the lockdown needs one more step. Run: swarm os confirm stepup-9 123456"]);
});
it("start writes brain.pid, returns 0 once the brain has stopped, and refuses a second brain", async () => {
  let finish!: () => void; const stopped = new Promise<void>((r) => { finish = r; });
  const startBrain = vi.fn(async () => ({ url: "http://127.0.0.1:3200", stopped }));
  const running = runOs(["start"], {}, { ...deps, startBrain, pid: 4242, self: ["/path/to/swarm"] });
  await vi.waitFor(() => expect(readFileSync(join(home, "brain.pid"), "utf8")).toBe("4242"));
  expect(startBrain.mock.calls[0][1]).toMatchObject({ configPath: join(home, "os.json"), swarmCommand: ["/path/to/swarm"] });
  finish();
  expect([await running, existsSync(join(home, "brain.pid")), out.at(-1)]).toEqual([0, false, "Brain listening on http://127.0.0.1:3200"]);
  writeFileSync(join(home, "brain.pid"), "4242");
  expect(await runOs(["start"], {}, { ...deps, startBrain, processCommand: async () => "/path/to/swarm os start", kill: () => {} })).toBe(1);
});
it("stop signals only a swarm brain", async () => {
  writeFileSync(join(home, "brain.pid"), "4242"); const kill = vi.fn();
  expect(await runOs(["stop"], {}, { ...deps, processCommand: async () => "/usr/bin/vim notes.txt", kill })).toBe(1);
  expect(kill).not.toHaveBeenCalled();
  writeFileSync(join(home, "brain.pid"), "4242"); let alive = true;
  const k = vi.fn((_pid: number, sig: NodeJS.Signals | 0) => { if (sig === "SIGTERM") alive = false; else if (!alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); });
  expect(await runOs(["stop"], {}, { ...deps, processCommand: async () => "/path/to/swarm os start", kill: k, sleep: async () => {} })).toBe(0);
  expect(k).toHaveBeenCalledWith(4242, "SIGTERM");
});
it("install hands the supervisor this swarm's own command and the safe environment", async () => {
  const exec = fakeExec(); const userHome = mkdtempSync(join(tmpdir(), "user-"));
  expect(await runOs(["install"], {}, { ...deps, exec, platform: "darwin", userHome, uid: 501, self: ["/path/to/swarm"], env: { ...env, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-x" } })).toBe(0);
  const plist = readFileSync(join(userHome, "Library/LaunchAgents/ai.mnmal.swarm-os.plist"), "utf8");
  expect(plist).toMatch(/<string>\/path\/to\/swarm<\/string>\s*<string>os<\/string>\s*<string>start<\/string>/);
  expect(plist).not.toContain("ANTHROPIC_API_KEY");
});
it("runOptionalCommand reports a missing command file and rethrows anything else", async () => {
  const missing = Object.assign(new Error("Cannot find module '/path/to/cli/top.js' imported from /path/to/cli/main.js"), { code: "ERR_MODULE_NOT_FOUND" });
  expect(await runOptionalCommand("top", "top.js", async () => { throw missing; })).toBe(1);
  expect(stderr).toContain("swarm top is not available in this build yet.");
  expect(await runOptionalCommand("top", "top.js", async () => { throw new Error("Cannot find module './top.js' from '/$bunfs/root/swarm'"); })).toBe(1);
  await expect(runOptionalCommand("top", "top.js", async () => { throw Object.assign(new Error("Cannot find module 'ink'"), { code: "ERR_MODULE_NOT_FOUND" }); })).rejects.toThrow(/ink/);
  expect([await runOptionalCommand("top", "top.js", async () => 3), await runOptionalCommand("top", "top.js", async () => undefined)]).toEqual([3, null]);
});
it("answers an unknown subcommand with usage and 1", async () => {
  expect(await runOs(["nonsense"], {}, deps)).toBe(1);
  expect(err.join("\n")).toMatch(/swarm os (init|start|stop|status|install|uninstall|lockdown|confirm)/);
});
```
`packages/cli/tests/os-main.test.ts` spawns `main.ts` through the tsx loader with a preloaded `fetch` stub (it answers `GET /health` with `{ ok: true, store: true, launcher: true, instances: 0, uptimeSeconds: 7, webhooksRejected: 0 }`, rejects every other request, and appends each URL to a file the test reads back as `run.requests`), as `tests/drainstop.test.ts` does, using `isolateSubstrateProject()` and its fixture:
```ts
it("swarm os status skips the project-level Substrate block and starts no project stack", () => {
  projectConfig({ local_only: true });                       // with the project block this exits 1 on the next line's endpoint
  saveGlobalConfig({ substrate_url: "http://10.1.2.3:32338" });
  writeOsHome({ port: 45999 });                               // SWARM_OS_HOME in the child env: os.json (bind.port 45999) and host.secret
  const run = swarm("os", "status");
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain("brain: up 7s at http://127.0.0.1:45999");
  expect(run.requests).toEqual(["http://127.0.0.1:45999/health"]);
}, 60_000);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/os-cli.test.ts tests/os-main.test.ts`
Expected: FAIL, `Cannot find module '../src/cli/os.js'`, and `swarm os status` prints the top-level help and exits 1.

- [ ] **Step 3: Add the dependency, then implement `optional-command.ts` and `os.ts` with the rules above**

Run: `pnpm --filter @mnmal-ai/swarm-cli add @mnmal-ai/swarm-os@workspace:*` (skip it when plan 01 already added the line: `grep -n swarm-os packages/cli/package.json`). `os.ts` imports `@mnmal-ai/swarm-os` at the top; it is itself loaded only by `swarm os`.

- [ ] **Step 4: Dispatch `os`, `top` and `room-mcp` in `main.ts` before any project or Substrate work**

These are the exact edits; the three commands get no `case` in the `switch`.
1. `BOOLEAN_FLAGS` (lines 14 to 20): add `"tailscale"`, so `swarm os init --tailscale` does not swallow the next word.
2. Right after the `codex-hook` block (ends at line 140) and before `parseArgs(args)`, plan 01's block. Run `grep -n 'room-mcp' packages/cli/src/cli/main.ts` first: when plan 01 has already added it, change nothing. Otherwise add it with one `@ts-ignore` line, because `room-mcp.ts` arrives with plan 01; until then the import fails and `main()`'s catch prints `Cannot find module …` to stderr and exits 1, with nothing on stdout:
```ts
  // Hidden command: each Claude Code session of a `swarm run --os` starts it as its
  // swarm-room MCP server (os-attach.ts). Stdout is the MCP channel, so it runs before
  // the project-Substrate bootstrap below, which prints and may start sidecars.
  if (command === "room-mcp") {
    // @ts-ignore -- packages/cli/src/cli/room-mcp.ts is plan 01's file
    const { runRoomMcp } = await import("./room-mcp.js");
    process.exit(await runRoomMcp(process.env));
  }
```
3. Right after the `--help` short-circuit (ends at line 160) and before the project-level Substrate block (line 162), so neither reads a `.swarm/` config, applies its stack or starts a sidecar:
```ts
  // The brain and its terminal client belong to no project: they never read a .swarm/
  // config, apply its Substrate stack or start its sidecars (the brain runs its own OS stack).
  if (command === "os") {
    const { runOs } = await import("./os.js");
    process.exit(await runOs(positional, parsed));
  }
  if (command === "top") {
    const { runOptionalCommand } = await import("./optional-command.js");
    const code = await runOptionalCommand("top", "top.js", async () => {
      // @ts-ignore -- packages/cli/src/cli/top.ts is plan 08's file
      const mod = (await import("./top.js")) as unknown as { runTop(positional: string[], flags: Record<string, string>): Promise<number | void> };
      return mod.runTop(positional, parsed);
    });
    if (code === null) return;       // the TUI keeps running on its own handles
    process.exit(code);
  }
```
4. `SUBSTRATE_SKIP_COMMANDS` (lines 187 to 196): add `"os", "top", "room-mcp"` with the comment `// the brain and its clients never start a project stack`, so even a later move of the dispatch keeps them off it.
5. `printHelp`'s command list, after the `upgrade` line: `  os <cmd>          Run and control the Swarm OS brain (init|start|stop|status|install|uninstall|lockdown|confirm)` and `  top               Live view of the Swarm OS brain`.

- [ ] **Step 5: Run the CLI suite, the package suites and the whole build**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run && cd ../os && env -u ANTHROPIC_API_KEY npx vitest run && cd ../.. && pnpm turbo build`
Expected: PASS everywhere (the existing CLI suite included); every turbo build task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/os.ts packages/cli/src/cli/optional-command.ts packages/cli/src/cli/main.ts packages/cli/package.json pnpm-lock.yaml packages/cli/tests/os-cli.test.ts packages/cli/tests/os-main.test.ts
git commit -m "feat(cli): swarm os init, start, stop, status, install, uninstall, lockdown and confirm"
```
