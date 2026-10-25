# Swarm OS 05: Messaging, Push and Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms, participants, messages and questions, delivered over the brain's Server-Sent Events hub and Web Push. Also the one command registry and executor (authority, limits, step-up, tripwires, audit) behind every client and the chief of staff.

**Architecture:** `Messaging` (`packages/os/src/messaging/`) is the only writer of rooms, messages and questions. It redacts, stores, assigns `seq`, publishes each change through plan 03's `EventHub` with a visibility predicate built from the room, and hands push to `packages/os/src/push/`. `CommandExecutor` (`packages/os/src/commands/`) runs every command through fixed gates and leaves a `command` message and its `system` reply in the room. The HTTP handlers are plan 03 `Handler`s collected in one route table, so tests call them directly. `mountMessaging(host)` registers the table on plan 03's `ApiServer` behind `requireAuth` (and `idempotent()` where the overview asks for it). It also installs the question-expiry periodic, a standing-runner fallback, and the tripwire-backed auth hooks.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest, zod 4, `web-push` 3.6 with `@types/web-push`, `Intl.DateTimeFormat` for time zones. From plan 02: `OsStore`, rows and accessors, `newId`, `Clock`, `Logger`, `MemoryOsStore`, `FakeClock`, `makeConfig`, `makeRow`. From plan 03: `Actor`, `OsConfig`, `ApiServer`, `ApiRequest`, `Handler`, `ApiError`, `parseBody`, `requireAuth`, `idempotent`, `EventPublisher`, `FakeEventHub`, `StepUps`, `stepUpAudience`, `StandingRunners`, `AuthHooks`, `Lockdown`, `Tokens`, `apiFixture`. From plan 01 (`@mnmal-ai/swarm-types`): the room wire types.

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md` (Messaging, Security, Threat model, The first proof). Shared contracts: `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md`, in particular "Transport (decided 2026-10-25): SSE down, HTTP up" and "Brain API".

## Global Constraints

- The overview's contracts are used verbatim: `Messaging`, `Provenance`, `CommandSpec`, `CommandContext`, `CommandResult`, `COMMANDS`, `parseCommand`, `CommandExecutor`, the command table and its kinds, the routes, the stream events, `Actor` (humans carry `confirmer`), `StepUps`, `Tripwires`. Additions are listed below and in each task's Produces block. Nothing in the overview is renamed.
- Transport: "Server to client is Server-Sent Events; client to server is plain HTTP. The brain has no WebSocket." Everything this plan tells a client goes through `EventHub.publish(visibleTo, { type, payload })`: `message { message }`, `question { question }`, `stepup { stepUpId, command, expiresAt, code }`, `cooldown { cooldownUntil }`, and the instance event `command { argv: ["answer", questionId, body] }`.
- "Status codes are the contract" (overview). Inside the brain a refusal is a `CommandResult` with `ok: false` and `data.code` from plan 03's `RefusalCode` (`packages/os/src/security/refusals.ts`). Over HTTP a command answers 200 with its `CommandResult`, and a refusal is thrown as plan 03's `ApiError(code, text, extra)`, which its router renders by `REFUSAL_STATUS`: `428 stepup_required` (with `stepUpId` and `expiresAt`), `429 cooldown` (with `cooldownUntil`), `429 limit` (with `limit`), `403 forbidden | provenance_mismatch | lockdown | stepup_failed`, `400 bad_request`, `404 not_found`. A wrong or expired code is `stepup_failed`.
- Plan 03's router refuses every `/api` write without `X-Swarm-Os: 1` (`reason: "csrf_header"`), so this plan adds no check of its own. The overview exempts bearer callers; plan 03 exempts nobody, and plan 01's clients send the header. `POST /api/commands` and `POST /api/rooms/:id/messages` put plan 03's `idempotent()` after `requireAuth`: a repeated `Idempotency-Key` from the same actor within 10 minutes returns the first reply.
- Wire types come from plan 01's `packages/types/src/os-protocol.ts` (`@mnmal-ai/swarm-types`) and are never redeclared: `SendBody`, `SendResponse`, `ReadResponse`, `RoomMessageView`, `AskBody`, `AskResponse`, `QuestionStatus`, `WhoResponse`, `InstanceCommandArgv`, `OS_QUESTION_LONG_POLL_MS`.
- Shapes the dashboard (plan 07) is written against: `GET /api/rooms` returns a bare `RoomRow[]`; `GET /api/rooms/:id/messages` returns a bare `MessageRow[]` in `seq` order, `limit` default 50, at most 200. A `question` message's `dataJson` is `{ questionId, options? }`. A `command` message's `dataJson` is `{ argv, result }`, it carries the actor's provenance, and the result text follows as a `system` reply. There is no `room` event: a new room's first `message` event is enough.
- `registerCommand` may be called at any time. Plan 03's `Brain.start(config, { commands })` registers plan 08's CLI-backed specs from `packages/cli`, which `packages/os` never imports, so nothing assumes every command is known at module load. `GET /api/commands` and `/help` read the registry when they are called.
- "Message bodies never contain tokens or keys" (spec): `Messaging.post` runs `redactSecrets` on the body and on every string inside `data` before the row is stored. Nothing else writes `Message` rows except the tripwire audit rows (Task 7).
- "Only the chief of staff among agents can issue commands" (spec): `room` and `instance` actors are refused every command, queries included. No route executes the text of a message; a client that sees a leading `/` sends `POST /api/commands`.
- A standing command needs a step-up code "shown only in the TUI on the host (or, when deployed, in a second enrolled device's session)", accepted "within two minutes" (`stepup_ttl_seconds`, default 120). `StepUps.issue` returns the code, and it travels only in the `stepup` event. That event is published to plan 03's `stepUpAudience(requesterDeviceId)`: the host and confirmer devices other than the requesting device. The code never appears in a `CommandResult`, an error body, a stored row or a log line.
- Push follows the spec: "messages addressed to a human (questions, holds, unknown boards, dead instances, direct messages)". A `local_only` room's payload is exactly `{ roomId, kind }`; any other room's adds `roomName` and a one-line `summary` of at most 120 characters. Per-human quiet hours and per-room mute come after the first proof (spec, "The first proof") and are not in this plan.
- Waiting for a human: `ask.min_wait` defaults to 30 minutes and "a question is never given up on sooner". Quiet windows are wall-clock `HH:MM` ranges in `ask.timezone`. A registration's `askJson` overrides the brain's `os.json` `ask` key by key.
- `GET /api/questions/:id` long-polls for at most 25 seconds.
- Plan 09 reduces two files here to re-exports: `commands/gate.ts` (`LimitGate`, `LimitCheckInput`, `GateVerdict`, `NoLimitGate`, `refuse`, `refusalCode`) and `commands/tripwires.ts` (`Tripwires`). Both carry the names and signatures of plan 09's file, and this plan's tests assert only behaviour plan 09's classes keep. The executor's order is the one plan 09 wraps: lockdown, authority, cool-down, arguments, `limits.checkCommand`, step-up, tripwires, run, audit.
- Rows follow plan 02. Date fields are ISO strings, and `Repo.find` takes equality filters only. Plan 02's unindexed fields are never filtered on (`body`, `dataJson`, `provenanceJson`, `membersJson`, `permissionsJson`, `commandJson`, `proceededWith`, and the rest), and range conditions on `seq` are applied in memory. Authority comes from an actor's or a participant's kind, never from a stored `permissionsJson`: plans 04 and 06 store `[]`.
- Tests live in `packages/os/tests/**` and run on `MemoryOsStore`, `FakeClock`, `FakeEventHub` (`published`, `seenBy(actor)`), `FakePush`, `makeConfig`, `makeRow` and in-test fakes. They use no network, no Postgres and no real timers unless the test says so. The single end-to-end test (Task 14) runs on plan 03's `apiFixture`, which listens on an ephemeral loopback port.
- No `console.log` in `packages/os`; log through plan 02's `Logger`. VAPID private keys and step-up codes are never logged.
- Anonymity: `owner`, `owner-2`, `board-a`, `project-a`, `/path/to/project-a`, host name `local`, addresses from `203.0.113.0/24`, push endpoints under `https://push.example.invalid/`.
- Every task ends green: `cd packages/os && npx vitest run` and `pnpm --filter @mnmal-ai/swarm-os build`. No new GitHub workflow, no push to a remote, no `gh workflow run`.
- Plan 04 may land after this plan. Its `Dispatcher`, `Launcher` and `ResourceSnapshot` reach this plan only as types, through `packages/os/src/commands/peer-types.ts` (Task 7).
- Plan 03's composition task (its Task 11: `BrainModule`, `BrainContext`, `Periodics` with the `question_expiry` 60 s slot) was not yet written when this plan was. This plan reaches the server, the periodics, the standing runners and the auth hooks only through the `MessagingHost` adapter (Task 14), so a different shape changes that adapter and nothing else. Never edit another plan's files.
- Every class this plan adds that crosses a process, network, disk, database or model boundary, waits in a queue, or runs on a timer takes `metrics?: Metrics` (default `noopMetrics`) or reads `BrainContext.metrics`; Task 15 records the rows.

## Additions to the shared contracts

1. `ParticipantRef { id: string; kind: MessageRow["fromKind"] }` and `MessagingError` (Task 4).
2. `Messaging`'s deps gain `hub: EventPublisher` (required, since delivery goes through it), plus `ask?` (the brain's `os.json` `ask`) and `log?`. `Messaging` gains in-process listeners `onMessage` and `onQuestion`, which brain components such as plan 06 use where they used `subscribe` before. `answer` gains an optional fourth argument, `provenance`. An on-time answer is also published to the instance as `command { argv: ["answer", questionId, body] }`, the shape of plan 04's `publishInstanceCommand` (Tasks 4 and 5).
3. `Precedent { lookup(question: QuestionRow): Promise<string | null> }` and `NoPrecedent` in `messaging/precedent.ts` (Task 5). Plan 06's `CosPrecedent` implements it.
4. `DeviceRow.pushSubscriptionJson: string | null` (`Device.pushSubscriptionJson: field.string({ nullable: true })`). Web Push subscriptions live on the device, one per device (Task 3).
5. The `stepup` event carries `code`, as plan 07 assumes; plan 03 also lists codes through `GET /api/stepup/pending`. The push payload is `{ roomId, kind, roomName, summary }`, or exactly `{ roomId, kind }` for a `local_only` room, as plan 07's service worker reads it.
6. `CommandSpec.args` is a `z.object` whose keys are the positional words in order (`dispatch` → `{ board, card }`, `retry run` → `{ instance, fresh?: boolean }`, `say` → `{ room, text: z.array(z.string()) }`). The executor turns the argv into that object with `argvToArgs(spec, rest)` from `commands/argv-args.ts` and lets `spec.args.safeParse` decide; it never calls `spec.args.parse(rest)` on the raw array. Plan 08 owns `argv-args.ts`, but this plan runs first, so Task 7 writes it with the agreed rule and pins the rule in its tests. Plan 06's `argvFor` is the inverse. Also added: `COMMAND_KINDS`, `registerCommand(spec, into?)`, `tokenizeCommand` and `CommandRuntime` (Task 7). `commands/gate.ts` defines `LimitGate`, `LimitCheckInput` (the fields of plan 09's file plus `command`, `actor` and `roomId`), `GateVerdict`, `NoLimitGate`, `refuse` and `refusalCode`, until plan 09 provides them (Task 7).
7. `CommandExecutor` has a constructor (Task 8), and its third argument is `stepup?: { stepUpId: string; code: string }`. The overview types it `stepup?: string`, but `POST /api/commands` carries both fields. `executeConfirmed(ctx, argv)` (Task 9) runs a standing command whose step-up plan 03's `confirmStanding` already confirmed and consumed. `mountMessaging` installs it as the `StandingRunners` fallback, so `POST /api/stepup/confirm` from a confirmer can run any registered command. The chief of staff may request a standing command: it gets `stepup_required` under plan 03's `COS_SESSION_ID`, the request is announced, and only a confirmer or the host can complete it. The chief of staff never supplies a code. The host confirms its own standing commands too, as plan 09's executor test expects.
8. `Tripwires` (stub) has exactly plan 09's surface: `record(event, actor)`, `cooling(actor)` and `announce("stepup_requested", actor, argv)` (Task 7).
9. Routes and wiring: `messagingRoutes`, `MessagingHost`, `createMessaging`, `mountMessaging`, and `tripwireAuthHooks`, which replaces plan 03's `AuthHooks` in place as plan 03 expects (Tasks 11 to 14).
10. Participants: plan 04's `POST /api/instances/:id/sessions` names a session participant by its run session id, through `participants.ensureParticipant(role, sessionId, instanceId)`. Plan 04's attach route may use the same call for the instance's own participant. The run's own questions use that participant's room token (plan 01's `AttachResponse`), and their `sessionId` is `"run"` (Task 6).

## File map

| File | Responsibility | Task |
|------|----------------|------|
| `packages/os/src/messaging/redact.ts` | `redactSecrets`, `redactDeep`, the pattern table | 1 |
| `packages/os/src/messaging/wait.ts` | `computeWaitUntil`, `resolveAsk` | 2 |
| `packages/os/src/push/push.ts` | `PushSender`, `WebPushSender`, payload rules | 3 |
| `packages/os/src/push/subscriptions.ts` | subscriptions on devices, `deliverPush` | 3 |
| `packages/os/src/push/fake-push.ts` | `FakePush` (exported from `src/testing/index.ts`) | 3 |
| `packages/os/src/messaging/messaging.ts` | `Messaging`: rooms, post, publish, push trigger, visibility, questions | 4, 5 |
| `packages/os/src/messaging/precedent.ts` | `Precedent`, `NoPrecedent` | 5 |
| `packages/os/src/messaging/participants.ts` | `Participants`, `permissionsFor`, actor to sender and provenance | 6 |
| `packages/os/src/messaging/rooms.ts` | `Rooms`: system, cos, board, instance and direct rooms | 6 |
| `packages/os/src/commands/registry.ts` | kinds table, `COMMANDS`, `registerCommand`, `parseCommand`, `tokenizeCommand` | 7 |
| `packages/os/src/commands/argv-args.ts` | `argvToArgs`, `ArgvArgs` (written here first; plan 08 owns it) | 7 |
| `packages/os/src/commands/gate.ts` | `LimitGate`, `LimitCheckInput`, `GateVerdict`, `NoLimitGate`, `refuse`, `refusalCode` (plan 09's shapes) | 7 |
| `packages/os/src/commands/tripwires.ts` | `Tripwires` stub: `record`, `cooling`, `announce` (plan 09 replaces it) | 7 |
| `packages/os/src/commands/peer-types.ts` | plan 04's types, in one place | 7 |
| `packages/os/src/commands/executor.ts` | `CommandExecutor`: gates, step-up, audit | 8, 9 |
| `packages/os/src/commands/builtin.ts` | `top`, `rooms`, `instances`, `why`, `help`, `answer`, `say` | 10 |
| `packages/os/src/messaging/routes.ts` | the HTTP route table | 11, 12, 13 |
| `packages/os/src/messaging/install.ts` | `createMessaging`, `mountMessaging`, `MessagingHost` | 14 |

## Review Focus

1. **A secret pasted into a message by a worker or a human**: an `.env` line, a `ghp_` token, a PEM block. Expected: the stored row, the published `message` event and the push summary all carry the redacted text. Pinned in Task 4 (`a pasted secret never reaches the store, an event or a push`).
2. **An answer arrives after the wait expired and the worker proceeded** (overview item 3). Expected: `late: true`, `lateAnswerMessageId` set, the state stays `proceeded`, and listeners hear `late_answer`. The answer is not sent to the run. Pinned in Task 5 (`records an answer that arrives after the worker proceeded as late, with lateAnswerMessageId`).
3. **A valid session sends a standing command without a step-up code** (overview item 4). Expected: `stepup_required` and a code that only confirmers other than the requesting device and the host can see. The request is announced to every owner, and the second wrong code cools the session down and tells every owner. Pinned in Task 9 (`refuses a standing command from a valid session without a step-up code: stepup_required, code to confirmers only, request announced`) and Task 9 (`the second wrong code cools the session down and tells every owner`).
4. **A worker's room token aimed at another instance's room, or a worker's text that looks like a command.** Expected: 404 for the other room; `/stop run inst-a` from a worker is stored as text and nothing runs. Pinned in Task 13 (`a worker cannot read or send in another instance's room` and `a worker's slash text stays text`).
5. **A question from a `local_only` project reaches a phone.** Expected: the push payload is exactly `{ roomId, kind }`, so no card or question text crosses the push service. Pinned in Task 4 (`sends a local_only room's push with the room id and kind only`).

---

### Task 1: Secret redaction

**Files:**
- Create: `packages/os/src/messaging/redact.ts`
- Modify: `packages/os/src/log.ts` (plan 02's: its minimal `redactSecrets` becomes a re-export of this one, as plan 02 anticipates)
- Test: `packages/os/tests/messaging/redact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface SecretPattern { name: string; pattern: RegExp; replacement: string }
export const SECRET_PATTERNS: readonly SecretPattern[];
export function redactSecrets(text: string): string;
export function redactDeep<T>(value: T): T;   // every string inside arrays and plain objects; other values unchanged; keys untouched
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS, redactDeep, redactSecrets } from "../../src/messaging/redact.js";

const ghp = "ghp_" + "a".repeat(36);
describe("redactSecrets", () => {
  it.each([
    ["an Anthropic key", "key sk-ant-api03-abcdefghijklmnop end", "key sk-ant-[redacted] end"],
    ["a classic GitHub token", `push ${ghp} done`, "push ghp_[redacted] done"],
    ["a fine-grained GitHub token", "pat github_pat_" + "B".repeat(30), "pat github_pat_[redacted]"],
    ["a Slack bot token", "slack xoxb-1234567890-abcdef", "slack xoxb-[redacted]"],
    ["a bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123", "Authorization: Bearer [redacted]"],
    ["a brain room token", "token room_" + "Z".repeat(24) + " ok", "token room_[redacted] ok"],
    ["the host secret", "host_" + "h".repeat(32), "host_[redacted]"],
    [".env lines", "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij\nDATABASE_PASSWORD='hunter2 two'\nPORT=3000", "ANTHROPIC_API_KEY=[redacted]\nDATABASE_PASSWORD=[redacted]\nPORT=3000"],
    ["a service-account file", '{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n","client_email":"a@b.c"}', '{"private_key":"[redacted]","client_email":"a@b.c"}'],
    ["a PEM block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----", "[redacted:private-key]"],
  ])("redacts %s", (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });
  it("redacts the short forms plan 02's logger tests use", () => {
    expect(redactSecrets("a sk-ant-EXAMPLE b ghp_EXAMPLE github_pat_EXAMPLE_1 xoxb-1-EXAMPLE Bearer abc.def")).toBe("a sk-ant-[redacted] b ghp_[redacted] github_pat_[redacted] xoxb-[redacted] Bearer [redacted]");
  });
  it("leaves store ids and ordinary prose alone", () => {
    const text = "room-01HZX sess-01HABC inst-01H, the monkey: banana, board-a moved card 42 to Ready, PORT=3000";
    expect(redactSecrets(text)).toBe(text);
  });
  it("names one pattern per secret family", () => {
    expect(SECRET_PATTERNS.map((p) => p.name)).toEqual(["private-key", "anthropic", "github-pat", "github", "slack", "bearer", "brain-token", "env-assignment", "json-credential"]);
  });
});
describe("redactDeep", () => {
  it("redacts every string inside nested data and keeps the rest", () => {
    expect(redactDeep({ argv: ["say", ghp], n: 3, ok: true, nested: { t: "Bearer abcdefghijklmnopqrstu" } }))
      .toEqual({ argv: ["say", "ghp_[redacted]"], n: 3, ok: true, nested: { t: "Bearer [redacted]" } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/redact.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/redact.js"`.

- [ ] **Step 3: Implement `redact.ts`**

The table, exactly, in this order (order matters: the PEM block goes before the JSON field that may hold it):

```ts
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: "[redacted:private-key]" },
  { name: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: "sk-ant-[redacted]" },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]+/g, replacement: "github_pat_[redacted]" },
  { name: "github", pattern: /\b(gh[pousr])_[A-Za-z0-9]+/g, replacement: "$1_[redacted]" },
  { name: "slack", pattern: /\b(xox[abposr])-[A-Za-z0-9-]+/g, replacement: "$1-[redacted]" },
  { name: "bearer", pattern: /\b(Bearer\s+)[^\s"']+/g, replacement: "$1[redacted]" },
  { name: "brain-token", pattern: /\b(sess|inst|room|host)_[A-Za-z0-9_-]{16,}/g, replacement: "$1_[redacted]" },
  { name: "env-assignment", pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, replacement: "$1=[redacted]" },
  { name: "json-credential", pattern: /("(?:private_key|client_secret|refresh_token|access_token|api_key|apiKey|password|secret|token)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, replacement: '$1"[redacted]"' },
];
```

These are the families `swarm run`'s `.gitignore` seeding names (`.env`, `*.pem`, `*.key`, `credentials.json`, `service-account.json`), the overview's prefixes, and the brain's own bearer prefixes, which plan 01's `redactRoomText` strips as well. The prefix families take any length, as plan 02's minimal version does, so its tests keep passing. `redactSecrets` applies them in order with `String.prototype.replace`. In plan 02's `log.ts`, replace its own `redactSecrets` with `import { redactSecrets } from "./messaging/redact.js"` plus `export { redactSecrets }`. The logger then redacts with this table, and the package root (plan 02's `export { createLogger, redactSecrets } from "./log.js"`) exports this function, which plan 08 re-exports for the CLI.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/redact.test.ts tests/log.test.ts`
Expected: PASS, 14 tests here, and plan 02's logger tests still pass.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/redact.ts packages/os/src/log.ts packages/os/tests/messaging/redact.test.ts
git commit -m "feat(os): redact secrets from message text, data and logs"
```

---

### Task 2: How long a question waits

**Files:**
- Create: `packages/os/src/messaging/wait.ts`
- Test: `packages/os/tests/messaging/wait.test.ts`

**Interfaces:**
- Consumes: `AskConfig` from plan 02 (`packages/os/src/store/rows.ts`): `{ min_wait_minutes?: number; quiet_windows?: Array<{ start: string; end: string }>; timezone?: string }`, which is what `registrationAsk(row)` returns.
- Produces:

```ts
export type AskSettings = Required<AskConfig>;   // the os.json ask block with every key present
export function computeWaitUntil(askedAt: Date, ask: AskSettings, now: Date): Date;
export function resolveAsk(defaults: AskSettings, overrides: AskConfig): AskSettings;   // each key present in overrides wins; a timezone Intl rejects keeps the default's
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { computeWaitUntil, resolveAsk, type AskSettings } from "../../src/messaging/wait.js";

const NIGHT = [{ start: "22:00", end: "07:00" }];
const ask = (timezone: string, quiet_windows = NIGHT, min_wait_minutes = 30): AskSettings => ({ min_wait_minutes, quiet_windows, timezone });
const wait = (askedAt: string, a: AskSettings, now = askedAt) => computeWaitUntil(new Date(askedAt), a, new Date(now)).toISOString();

describe("computeWaitUntil", () => {
  it("waits the minimum when no quiet window applies", () => {
    expect(wait("2026-10-25T10:00:00Z", ask("UTC", []))).toBe("2026-10-25T10:30:00.000Z");
  });
  it("waits until the window ends when asked inside it", () => {
    expect(wait("2026-10-25T23:00:00Z", ask("UTC"))).toBe("2026-10-26T07:00:00.000Z");
  });
  it("waits through a window that starts inside the minimum wait", () => {
    expect(wait("2026-10-25T21:50:00Z", ask("UTC"))).toBe("2026-10-26T07:00:00.000Z");
  });
  it("handles a window that crossed midnight: asked at 02:00 inside the previous evening's window", () => {
    expect(wait("2026-10-26T02:00:00Z", ask("UTC"))).toBe("2026-10-26T07:00:00.000Z");
  });
  it("ignores a window that ended exactly when the question was asked", () => {
    expect(wait("2026-10-26T07:00:00Z", ask("UTC"))).toBe("2026-10-26T07:30:00.000Z");
  });
  it("reads the window in the configured zone, not UTC", () => {
    expect(wait("2026-10-25T03:00:00Z", ask("America/New_York"))).toBe("2026-10-25T11:00:00.000Z");   // 23:00 EDT, ends 07:00 EDT
    expect(wait("2026-10-25T13:30:00Z", ask("Asia/Tokyo"))).toBe("2026-10-25T22:00:00.000Z");        // 22:30 JST, ends 07:00 JST
  });
  it("follows the zone across a daylight-saving change", () => {
    expect(wait("2026-11-01T03:00:00Z", ask("America/New_York"))).toBe("2026-11-01T12:00:00.000Z");   // 23:00 EDT, ends 07:00 EST
  });
  it("merges windows that touch", () => {
    expect(wait("2026-10-25T21:50:00Z", ask("UTC", [{ start: "22:00", end: "23:00" }, { start: "23:00", end: "06:00" }]))).toBe("2026-10-26T06:00:00.000Z");
  });
  it("waits out a window the brain was down for, and nothing else", () => {
    expect(wait("2026-10-25T20:00:00Z", ask("UTC"), "2026-10-25T23:15:00Z")).toBe("2026-10-26T07:00:00.000Z");
    expect(wait("2026-10-25T20:00:00Z", ask("UTC"), "2026-10-25T21:00:00Z")).toBe("2026-10-25T20:30:00.000Z");
  });
});

describe("resolveAsk", () => {
  const brain = ask("UTC");
  it("lets the registration override each key", () => {
    expect(resolveAsk(brain, { min_wait_minutes: 60, timezone: "Asia/Tokyo" })).toEqual({ min_wait_minutes: 60, quiet_windows: NIGHT, timezone: "Asia/Tokyo" });
    expect(resolveAsk(brain, { quiet_windows: [] }).quiet_windows).toEqual([]);
  });
  it("keeps the brain's values for absent keys and for a zone Intl does not know", () => {
    expect(resolveAsk(brain, {})).toEqual(brain);
    expect(resolveAsk(brain, { timezone: "Mars/Base" }).timezone).toBe("UTC");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/wait.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/wait.js"`.

- [ ] **Step 3: Implement `wait.ts`**

The wall-clock conversion is the one non-obvious piece:

```ts
// wallClock(at, zone): { y, m, d, hh, mm, ss } from new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
//   year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at)
// offsetMs(at, zone) = Date.UTC(...wallClock(at, zone)) - (at.getTime() - at.getUTCMilliseconds())
// zonedToUtc(y, m, d, hh, mm, zone): guess = Date.UTC(y, m - 1, d, hh, mm); t = guess - offsetMs(new Date(guess), zone);
//   t = guess - offsetMs(new Date(t), zone); return new Date(t)    // the second pass settles a DST offset
// computeWaitUntil(askedAt, ask, now):
//   1. t = askedAt + min_wait_minutes.
//   2. Occurrences: for every local date from askedAt's local date − 1 to + (ceil(min_wait_minutes / 1440) + 3), each window with
//      start ≠ end gives [zonedToUtc(date, start), zonedToUtc(end <= start ? date + 1 : date, end)). Sort by start; merge occurrences that touch or overlap.
//   3. For each merged occurrence in start order: if start < t and end > askedAt and end > t, then t = end.
//   4. If now > t and now lies inside a merged occurrence built the same way around now's local date, t = that occurrence's end.
//   5. Return new Date(t).
```

Step 4 is the spec's "a question still open when a window starts waits until it ends", applied when the brain was down at the deadline. A window whose `start` equals its `end` is ignored.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/wait.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/wait.ts packages/os/tests/messaging/wait.test.ts
git commit -m "feat(os): compute a question's wait from min_wait and quiet windows in the owner's zone"
```

---

### Task 3: Web Push: transport, payload and device subscriptions

**Files:**
- Create: `packages/os/src/push/push.ts`, `packages/os/src/push/subscriptions.ts`, `packages/os/src/push/fake-push.ts`
- Modify: `packages/os/src/testing/index.ts` (append under a `// --- plan 05 ---` marker)
- Modify, only if absent (plan 02's files; the one schema change this plan needs): `packages/substrate-plugin/src/types/os-types.ts` and `packages/os/src/store/rows.ts` (the `Device` field); `packages/os/package.json` and `pnpm-lock.yaml` (`web-push`)
- Test: `packages/os/tests/push/push.test.ts`

**Interfaces:**
- Consumes: `OsStore`, `DeviceRow`, `RoomRow`, `MessageRow`, `toJson`, `readJson`, `makeRow`, `MemoryOsStore` (plan 02); `OsConfig` (plan 03); `makeConfig` (plan 02 testing); `Logger` (plan 02).
- Produces:

```ts
// push.ts
export interface WebPushSubscription { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }
export type PushPayload =
  | { roomId: string; kind: MessageRow["kind"] }                                       // local_only rooms, exactly this
  | { roomId: string; kind: MessageRow["kind"]; roomName: string; summary: string };   // every other room
export interface PushSender { send(subscription: WebPushSubscription, payload: PushPayload): Promise<"sent" | "gone"> }
export interface WebPushClient {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: WebPushSubscription, payload: string, options: { TTL: number; timeout: number }): Promise<unknown>;
}
export class PushError extends Error { constructor(readonly code: "bad_subscription" | "send_failed", message: string, readonly statusCode?: number) }
export class WebPushSender implements PushSender { constructor(vapid: NonNullable<OsConfig["push"]>, client?: WebPushClient) }   // client defaults to the web-push module
export function createPushSender(config: OsConfig): PushSender | undefined;   // undefined without config.push
export function pushPayloadFor(room: RoomRow, message: MessageRow): PushPayload;
export function oneLine(text: string, max: number): string;                    // first line, whitespace collapsed, at most max characters, "…" last when cut
// subscriptions.ts
export function parsePushSubscription(input: unknown): WebPushSubscription;    // PushError("bad_subscription") unless an https endpoint and non-empty keys
export function savePushSubscription(store: OsStore, deviceId: string, input: unknown): Promise<DeviceRow>;
export function clearPushSubscription(store: OsStore, deviceId: string): Promise<DeviceRow>;
export function deliverPush(deps: { store: OsStore; push: PushSender; log?: Logger }, humanIds: string[], payload: PushPayload): Promise<{ sent: number; gone: number }>;
// fake-push.ts, exported from src/testing/index.ts
export class FakePush implements PushSender {
  readonly sent: Array<{ subscription: WebPushSubscription; payload: PushPayload }>;
  readonly goneEndpoints: Set<string>;     // these endpoints answer "gone"
  failWith: Error | null;                  // when set, send rejects with it
  endpoints(): string[];                   // endpoints sent to so far, sorted
}
```

- Produces (schema, in plan 02's files): `Device.pushSubscriptionJson: field.string({ nullable: true })`, `DeviceRow.pushSubscriptionJson: string | null`. One subscription per device; a revoked device gets no push.

- [ ] **Step 1: Make sure the device can hold a subscription and the dependency is present**

If `DeviceRowSchema` in `packages/os/src/store/rows.ts` has no `pushSubscriptionJson`, add `pushSubscriptionJson: field.string({ nullable: true })` to `Device` in `packages/substrate-plugin/src/types/os-types.ts` and `pushSubscriptionJson: z.string().nullable()` to `DeviceRowSchema`. If `packages/os/package.json` has no `web-push`, add `"web-push": "^3.6.7"` to `dependencies` and `"@types/web-push": "^3.6.4"` to `devDependencies`, then run `pnpm install`.
Run: `cd packages/substrate-plugin && npx vitest run && cd ../os && npx vitest run`
Expected: plan 02's suites still pass (the row-schema and `osTypes` agreement tests see the field on both sides).

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { oneLine, pushPayloadFor, PushError, WebPushSender, type WebPushClient } from "../../src/push/push.js";
import { clearPushSubscription, deliverPush, savePushSubscription } from "../../src/push/subscriptions.js";
import { FakePush, MemoryOsStore, makeRow } from "../../src/testing/index.js";
import { toJson } from "../../src/store/rows.js";

const SUB = (id: string) => ({ endpoint: `https://push.example.invalid/${id}`, keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` } });
const room = (o: object = {}) => makeRow("rooms", { id: "room-a", name: "board-a#42", privacy: "normal", ...o });
const msg = (o: object = {}) => makeRow("messages", { id: "msg-1", roomId: "room-a", kind: "question", body: "Which database?\nMore detail", ...o });
const client = () => {
  const c = { vapid: [] as string[], calls: [] as unknown[][], fail: null as null | { statusCode: number } };
  const impl: WebPushClient = {
    setVapidDetails: (s, pub, priv) => { c.vapid = [s, pub, priv]; },
    sendNotification: async (...args) => { c.calls.push(args); if (c.fail) throw Object.assign(new Error("push refused"), c.fail); return {}; },
  };
  return { c, impl };
};

describe("pushPayloadFor", () => {
  it("carries only the room id and kind for a local_only room", () => {
    expect(pushPayloadFor(room({ privacy: "local_only" }), msg({ body: "Card text: migrate the billing tables?" }))).toStrictEqual({ roomId: "room-a", kind: "question" });
  });
  it("carries the room name and a one-line summary otherwise", () => {
    expect(pushPayloadFor(room(), msg())).toStrictEqual({ roomId: "room-a", kind: "question", roomName: "board-a#42", summary: "Which database?" });
  });
  it("cuts the summary to 120 characters", () => {
    expect(oneLine("x".repeat(300), 120)).toHaveLength(120);
    expect(oneLine("x".repeat(300), 120).endsWith("…")).toBe(true);
    expect(oneLine("  a   b \n c", 120)).toBe("a b");
  });
});

describe("WebPushSender", () => {
  const vapid = { vapid_public: "pub", vapid_private: "priv", subject: "mailto:owner@example.invalid" };
  it("sets the VAPID details and sends the payload as JSON", async () => {
    const { c, impl } = client();
    const sender = new WebPushSender(vapid, impl);
    expect(c.vapid).toEqual(["mailto:owner@example.invalid", "pub", "priv"]);
    await expect(sender.send(SUB("dev-phone"), { roomId: "room-a", kind: "system" })).resolves.toBe("sent");
    expect(c.calls[0]).toEqual([SUB("dev-phone"), JSON.stringify({ roomId: "room-a", kind: "system" }), { TTL: 3600, timeout: 10_000 }]);
  });
  it("reports gone for 404 and 410", async () => {
    const { c, impl } = client(); c.fail = { statusCode: 410 };
    await expect(new WebPushSender(vapid, impl).send(SUB("dev-phone"), { roomId: "room-a", kind: "system" })).resolves.toBe("gone");
  });
  it("throws PushError for any other failure", async () => {
    const { c, impl } = client(); c.fail = { statusCode: 500 };
    await expect(new WebPushSender(vapid, impl).send(SUB("dev-phone"), { roomId: "room-a", kind: "system" })).rejects.toMatchObject({ code: "send_failed", statusCode: 500 });
  });
});

describe("device subscriptions", () => {
  const setup = async () => {
    const store = new MemoryOsStore();
    for (const [id, revoked] of [["dev-phone", false], ["dev-laptop", false], ["dev-revoked", true]] as const)
      await store.devices.put(makeRow("devices", { id, humanId: "owner", pushSubscriptionJson: toJson(SUB(id)), revokedAt: revoked ? "2026-10-24T00:00:00.000Z" : null }));
    return { store, push: new FakePush() };
  };
  it("saves a valid subscription on the device and clears it", async () => {
    const { store } = await setup();
    await savePushSubscription(store, "dev-phone", SUB("dev-phone-2"));
    expect(JSON.parse((await store.devices.get("dev-phone"))!.pushSubscriptionJson!)).toEqual(SUB("dev-phone-2"));
    await clearPushSubscription(store, "dev-phone");
    expect((await store.devices.get("dev-phone"))!.pushSubscriptionJson).toBeNull();
  });
  it("refuses a subscription without keys or with a non-https endpoint", async () => {
    const { store } = await setup();
    await expect(savePushSubscription(store, "dev-phone", { endpoint: "https://push.example.invalid/x" })).rejects.toBeInstanceOf(PushError);
    await expect(savePushSubscription(store, "dev-phone", { ...SUB("x"), endpoint: "http://push.example.invalid/x" })).rejects.toMatchObject({ code: "bad_subscription" });
  });
  it("delivers to each live device of each human and drops subscriptions that are gone", async () => {
    const { store, push } = await setup();
    push.goneEndpoints.add(SUB("dev-laptop").endpoint);
    await expect(deliverPush({ store, push }, ["owner", "owner"], { roomId: "room-a", kind: "system" })).resolves.toEqual({ sent: 1, gone: 1 });
    expect(push.endpoints()).toEqual([SUB("dev-laptop").endpoint, SUB("dev-phone").endpoint]);
    expect((await store.devices.get("dev-laptop"))!.pushSubscriptionJson).toBeNull();
  });
  it("logs and carries on when a send throws", async () => {
    const { store, push } = await setup();
    push.failWith = new Error("push service down");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(deliverPush({ store, push, log }, ["owner"], { roomId: "room-a", kind: "system" })).resolves.toEqual({ sent: 0, gone: 0 });
    expect(log.error).toHaveBeenCalledWith("push failed", expect.objectContaining({ deviceId: "dev-phone" }));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/push/push.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/push/push.js"`.

- [ ] **Step 4: Implement the three files and the testing export**

- `WebPushSender`: the constructor calls `client.setVapidDetails(subject, vapid_public, vapid_private)`. `send` calls `sendNotification(subscription, JSON.stringify(payload), { TTL: 3600, timeout: 10_000 })`. An error whose `statusCode` is 404 or 410 returns `"gone"`; any other error becomes `PushError("send_failed", <redacted message>, statusCode)`. The private key is never logged or put in an error.
- `deliverPush`: dedupe `humanIds`. For each, take `store.devices.find({ humanId })` without `revokedAt` and with a subscription. Send to each device in turn: `"gone"` clears that device's subscription; a throw logs `log.error("push failed", { deviceId, error })` and moves on. Count `sent` and `gone`.
- `src/testing/index.ts`: append `// --- plan 05 ---` and `export { FakePush } from "../push/fake-push.js";`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/push/push.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/os/src/push packages/os/src/testing/index.ts packages/os/tests/push packages/os/package.json pnpm-lock.yaml packages/substrate-plugin/src/types/os-types.ts packages/os/src/store/rows.ts
git commit -m "feat(os): web push sender, payload privacy rule and per-device subscriptions"
```

---

### Task 4: Messaging core: rooms, posting, publishing, push and visibility

**Files:**
- Create: `packages/os/src/messaging/messaging.ts`
- Create: `packages/os/tests/helpers/world.ts` (shared by Tasks 4 to 14)
- Test: `packages/os/tests/messaging/messaging.test.ts`

**Interfaces:**
- Consumes: `redactSecrets`, `redactDeep` (Task 1); `AskSettings` (Task 2); `PushSender`, `deliverPush`, `pushPayloadFor` (Task 3); plan 02's `OsStore`, rows, `newId`, `toJson`, `roomMembers`, `registrationOwners`, `Clock`, `Logger`; plan 03's `Actor`, `EventPublisher`, `FakeEventHub`.
- Produces:

```ts
export interface Provenance { source: "owner" | "human" | "cos" | "worker" | "reviewer" | "arbiter" | "instance" | "card" | "webhook" | "memory" | "tool" | "system"; sessionId?: string; deviceId?: string; address?: string; instanceId?: string; cardRef?: CardRef }   // verbatim from the overview
export interface ParticipantRef { id: string; kind: MessageRow["fromKind"] }
export type MessagingErrorCode = "room_not_found" | "question_not_found" | "forbidden" | "bad_request";
export class MessagingError extends Error { constructor(readonly code: MessagingErrorCode, message: string) }
export interface MessagingDeps { store: OsStore; clock: Clock; hub: EventPublisher; push?: PushSender; ask?: AskSettings; log?: Logger }   // ask defaults to { min_wait_minutes: 30, quiet_windows: [], timezone: "UTC" }
export class Messaging {
  constructor(deps: MessagingDeps);
  openRoom(kind: RoomRow["kind"], subjectId: string | null, name: string, members: string[], privacy: RoomRow["privacy"]): Promise<RoomRow>;
  post(input: { roomId: string; from: ParticipantRef; kind: MessageRow["kind"]; body: string; data?: unknown; replyTo?: string; provenance: Provenance }): Promise<MessageRow>;
  visibleRooms(actor: Actor): Promise<RoomRow[]>;
  onMessage(listener: (message: MessageRow, room: RoomRow) => void): () => void;   // in-process, after the row is stored and published
}
```

- Produces (test helper `packages/os/tests/helpers/world.ts`): `makeWorld(opts?: { ask?: Partial<AskSettings> }): Promise<World>`, `SUB(deviceId): WebPushSubscription`, `RecordingLogger` (a `Logger` with `entries` and `errors(): string[]`, the messages logged at error level), and

```ts
export interface World {
  store: MemoryOsStore; clock: FakeClock; hub: FakeEventHub; push: FakePush; log: RecordingLogger; config: TestOsConfig; messaging: Messaging;
  actors: { phone: HumanActor; laptop: HumanActor; other: HumanActor; host: Actor; cos: Actor; workerA: Actor; workerB: Actor; instA: Actor };
  refs: { owner: ParticipantRef; owner2: ParticipantRef; workerA: ParticipantRef; workerB: ParticipantRef; workerP: ParticipantRef };
  roomOf(instanceId: "inst-a" | "inst-b" | "inst-p"): string;
  messagesIn(roomId: string): Promise<MessageRow[]>;   // seq order
}
```

The world's rows, every one built with plan 02's `makeRow` (fields not listed take its defaults):

| Rows | Values |
|------|--------|
| clock and config | `new FakeClock()` then `set("2026-10-25T10:00:00.000Z")`; `makeConfig({ owners: [{ id: "owner", name: "Owner" }, { id: "owner-2", name: "Second owner" }], ask: { min_wait_minutes: 30, quiet_windows: [], timezone: "UTC", ...opts.ask }, stepup_ttl_seconds: 120 })` |
| boards | `board-a` (name `board-a`), `board-p` (name `board-p`) |
| registrations | `reg-a`: board `board-a`, `project-a`, privacy `normal`, `ownersJson` `["owner"]`; `reg-p`: board `board-p`, `project-p`, privacy `local_only`, `ownersJson` `["owner"]` |
| participants | humans `owner` (`Owner`) and `owner-2` (`Second owner`), whose row ids are their human ids; `part-inst-a` (kind `instance`, name `project-a/42`, instance `inst-a`); workers `part-worker-a` (name `sess-worker-a`, `inst-a`), `part-worker-b` (`sess-worker-b`, `inst-b`), `part-worker-p` (`sess-worker-p`, `inst-p`) |
| rooms | one instance room each, opened before the instances with `messaging.openRoom("instance", id, "<board>#<card>", members, privacy)`: `inst-a` with `["part-inst-a", "part-worker-a"]`, `inst-b` with `["part-worker-b"]`, `inst-p` with `["part-worker-p"]` (`local_only`). The owners are not members, as in plan 04's dispatch. |
| instances | `inst-a`: `reg-a`, `board-a`, card `42`, `running`, tokens 1200, started 5 min ago, last heartbeat 10 s ago; `inst-b`: `reg-a`, card `43`, `running`; `inst-p`: `reg-p`, `board-p`, card `7`, `running`; `inst-b` and `inst-p` start now, with no heartbeat and 0 tokens; each `roomId` its room |
| devices | `dev-phone` (owner, name `phone`, not a confirmer), `dev-laptop` (owner, `laptop`, confirmer), `dev-other` (owner-2, `tablet`, confirmer), `dev-revoked` (owner, `old phone`, revoked); each `pushSubscriptionJson: toJson(SUB(id))` |
| sessions | `sess-phone` (owner, `dev-phone`, `203.0.113.7`), `sess-laptop` (owner, `dev-laptop`, `203.0.113.8`), `sess-other` (owner-2, `dev-other`, `203.0.113.9`); expiring in 24 h |
| actors | `phone`, `laptop` and `other` are those sessions' human actors (`confirmer` from the device); `host`, `cos`; `workerA` = `{ kind: "room", instanceId: "inst-a", participantId: "part-worker-a", roomId: roomOf("inst-a") }`, `workerB` likewise for `inst-b`; `instA` = the run's own room token, `{ kind: "room", instanceId: "inst-a", participantId: "part-inst-a", roomId: roomOf("inst-a") }` |

`SUB(id)` is `{ endpoint: "https://push.example.invalid/" + id, keys: { p256dh: "p256dh-" + id, auth: "auth-" + id } }`. `messaging` is `new Messaging({ store, clock, hub, push, ask: config.ask, log })`.

- [ ] **Step 1: Write the world helper and the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../src/auth/actor.js";
import { roomMembers } from "../../src/store/rows.js";
import { makeWorld, SUB, type World } from "../helpers/world.js";

let w: World;
beforeEach(async () => { w = await makeWorld(); });
type PostInput = Parameters<World["messaging"]["post"]>[0];
const post = (o: Partial<PostInput> = {}) => w.messaging.post({ roomId: w.roomOf("inst-a"), from: w.refs.workerA, kind: "text", body: "starting", provenance: { source: "worker", instanceId: "inst-a" }, ...o });
const published = (type: string) => w.hub.published.filter((e) => e.type === type);
const dm = () => w.messaging.openRoom("direct", "owner|part-worker-a", "owner & part-worker-a", ["owner", "part-worker-a"], "normal");

describe("Messaging.post", () => {
  it("assigns increasing seq per room and publishes the row it stored", async () => {
    const m1 = await post();
    const m2 = await post({ body: "next" });
    expect(m2.seq).toBeGreaterThan(m1.seq);
    expect(await w.store.messages.get(m2.id)).toEqual(m2);
    expect(m2).toMatchObject({ roomId: w.roomOf("inst-a"), fromId: "part-worker-a", fromKind: "worker", kind: "text", replyTo: null, dataJson: null, at: "2026-10-25T10:00:00.000Z" });
    expect(JSON.parse(m2.provenanceJson)).toEqual({ source: "worker", instanceId: "inst-a" });
    expect(published("message").map((e) => e.payload)).toEqual([{ message: m1 }, { message: m2 }]);
  });
  it("a pasted secret never reaches the store, an event or a push", async () => {
    const ghp = "ghp_" + "a".repeat(36);
    const m = await post({ kind: "question", body: `use ${ghp}`, data: { env: "GITHUB_TOKEN=abc123" } });
    expect(m.body).toBe("use ghp_[redacted]");
    expect(m.dataJson).toBe(JSON.stringify({ env: "GITHUB_TOKEN=[redacted]" }));
    expect(JSON.stringify([await w.store.messages.find({ roomId: m.roomId }), w.hub.published.map((e) => e.payload), w.push.sent])).not.toContain(ghp);
    expect(w.push.sent[0].payload).toMatchObject({ summary: "use ghp_[redacted]" });
  });
  it("throws room_not_found for an unknown room", async () => {
    await expect(post({ roomId: "room-missing" })).rejects.toMatchObject({ code: "room_not_found" });
  });
  it("tells in-process listeners about each stored message until they stop", async () => {
    const seen: string[] = [];
    const stop = w.messaging.onMessage((m, room) => seen.push(`${room.kind}:${m.body}`));
    await post();
    stop();
    await post({ body: "after" });
    expect(seen).toEqual(["instance:starting"]);
  });
});

describe("visibility", () => {
  it("publishes to every human, the host and the chief of staff, and to agents only in their own instance's room", async () => {
    await post();
    const [e] = published("message");
    expect([w.actors.phone, w.actors.host, w.actors.cos, w.actors.workerA, w.actors.instA].map(e.visibleTo)).toEqual([true, true, true, true, true]);
    expect([w.actors.workerB, { kind: "instance", instanceId: "inst-b" } as Actor].map(e.visibleTo)).toEqual([false, false]);
    expect(e.visibleTo({ kind: "instance", instanceId: "inst-a" })).toBe(true);
  });
  it("shows a direct room to its agent members and to no other agent", async () => {
    await post({ roomId: (await dm()).id });
    const e = published("message").at(-1)!;
    expect([w.actors.phone, w.actors.workerA, w.actors.workerB, w.actors.instA].map(e.visibleTo)).toEqual([true, true, false, false]);
  });
  it("visibleRooms: every room for humans, the host and the chief of staff; a worker's own room and its direct rooms", async () => {
    const d = await dm();
    const ids = async (a: Actor) => (await w.messaging.visibleRooms(a)).map((r) => r.id).sort();
    const all = (await w.store.rooms.find({})).map((r) => r.id).sort();
    for (const a of [w.actors.phone, w.actors.host, w.actors.cos]) expect(await ids(a)).toEqual(all);
    expect(await ids(w.actors.workerA)).toEqual([w.roomOf("inst-a"), d.id].sort());
    expect(await ids(w.actors.workerB)).toEqual([w.roomOf("inst-b")]);
  });
});

describe("openRoom", () => {
  it("returns the open room with the same kind and subject, with the members joined", async () => {
    const r1 = await w.messaging.openRoom("board", "board-a", "board-a", ["owner"], "normal");
    const r2 = await w.messaging.openRoom("board", "board-a", "board-a", ["owner-2"], "normal");
    expect(r2.id).toBe(r1.id);
    expect(roomMembers(r2).sort()).toEqual(["owner", "owner-2"]);
  });
  it("creates one room for concurrent opens of a subject, and a new room for each null subject", async () => {
    const [x, y] = await Promise.all([1, 2].map(() => w.messaging.openRoom("direct", "a|b", "a & b", ["a", "b"], "normal")));
    expect(x.id).toBe(y.id);
    expect(await w.store.rooms.find({ kind: "direct" })).toHaveLength(1);
    const [s1, s2] = [await w.messaging.openRoom("system", null, "system", [], "normal"), await w.messaging.openRoom("system", null, "system", [], "normal")];
    expect(s1.id).not.toBe(s2.id);
  });
});

describe("push", () => {
  it("pushes a question to the registration's owners, never to the sender", async () => {
    await post({ kind: "question", body: "Which database?" });
    expect(w.push.endpoints()).toEqual([SUB("dev-laptop").endpoint, SUB("dev-phone").endpoint]);
  });
  it("pushes a system message to the room's humans and the board's owners", async () => {
    const board = await w.messaging.openRoom("board", "board-a", "board-a", ["owner", "owner-2"], "normal");
    await post({ roomId: board.id, from: { id: "system", kind: "system" }, kind: "system", body: "Held board-a:42: queue below min_cards", provenance: { source: "system" } });
    expect(w.push.endpoints()).toEqual([SUB("dev-laptop"), SUB("dev-other"), SUB("dev-phone")].map((s) => s.endpoint));
  });
  it("does not push plain text unless it is addressed or direct", async () => {
    await post({ body: "working on it" });
    expect(w.push.sent).toEqual([]);
    await post({ body: "a look please", data: { to: ["owner-2"] } });
    expect(w.push.endpoints()).toEqual([SUB("dev-other").endpoint]);
    await post({ roomId: (await dm()).id, body: "a quick question" });
    expect(w.push.endpoints()).toEqual([SUB("dev-laptop"), SUB("dev-other"), SUB("dev-phone")].map((s) => s.endpoint));
  });
  it("sends a local_only room's push with the room id and kind only", async () => {
    await post({ roomId: w.roomOf("inst-p"), from: w.refs.workerP, kind: "question", body: "Card text: migrate the billing tables?" });
    const exact = { roomId: w.roomOf("inst-p"), kind: "question" };
    expect(w.push.sent.map((s) => s.payload)).toStrictEqual([exact, exact]);
  });
  it("keeps the message when push fails", async () => {
    w.push.failWith = new Error("push service down");
    await expect(post({ kind: "question", body: "Which database?" })).resolves.toMatchObject({ kind: "question" });
    expect(w.log.errors()).toContain("push failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/messaging.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/messaging.js"`.

- [ ] **Step 3: Implement `messaging.ts`**

- `openRoom` with a non-null subject runs one at a time per `kind|subjectId` (an in-flight promise map). It returns the open row (`closedAt: null`) that `rooms.find({ kind, subjectId })` gives, patching `membersJson` to the union only when the union differs. Otherwise it puts `{ id: newId("room"), kind, subjectId, name, membersJson: toJson(unique members), privacy, createdAt: now, closedAt: null }`. A null subject always puts a new row, so singleton rooms (system, cos) are found by kind first, in Task 6 and in plan 06.
- `post`, in order:
  1. The room must exist, else `MessagingError("room_not_found")`.
  2. Build the row: `seq` from `store.nextSeq(roomId)`, `body` through `redactSecrets`, `dataJson` as `toJson(redactDeep(data))` or `null`, `provenanceJson` as `toJson(provenance)`, `at` the clock's ISO time.
  3. `put` the row.
  4. Publish `{ type: "message", payload: { message: row } }` with the room's `visibleTo`.
  5. Call the `onMessage` listeners; a throwing listener is logged and skipped.
  6. Push. Posting to a closed room is allowed.
- The room's `visibleTo` is built once per event. Humans, the host and the chief of staff see every room. A `room` actor sees `actor.roomId`, and `direct` rooms whose members include its `participantId`. An `instance` actor sees the `instance` room whose `subjectId` is its `instanceId`, and `direct` rooms that list a participant of kind `instance` with that `instanceId` (loaded once from the member rows). `visibleRooms(actor)` filters `rooms.find({})` with the same rule.
- Push recipients. `data.to`, when it is a string array, is the whole list (an empty array means nobody). Otherwise, for kind `question` or `system` or a `direct` room, the list is the room's members, plus the owners (`registrationOwners`) of the instance's registration (`instance` rooms) or of every registration on the board (`board` rooms). Anything else pushes to nobody. Remove `from.id`, then call `deliverPush({ store, push, log }, ids, pushPayloadFor(room, row))`. Agent ids have no devices, so they drop out there. Without `push`, nothing is sent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/messaging.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/messaging.ts packages/os/tests/helpers/world.ts packages/os/tests/messaging/messaging.test.ts
git commit -m "feat(os): messaging core with redaction, SSE publishing by visibility and push to addressed humans"
```

---

### Task 5: Questions: ask, answer, late answers and expiry

**Files:**
- Create: `packages/os/src/messaging/precedent.ts`
- Modify: `packages/os/src/messaging/messaging.ts`
- Test: `packages/os/tests/messaging/questions.test.ts`

**Interfaces:**
- Consumes: Task 4's `Messaging` and world; `computeWaitUntil`, `resolveAsk` (Task 2); plan 02's `registrationAsk`, `RowJsonError`, `QuestionRow`, `InstanceRow`.
- Produces:

```ts
// precedent.ts
export interface Precedent { lookup(question: QuestionRow): Promise<string | null> }   // plan 06's CosPrecedent implements it
export const NoPrecedent: Precedent;                                                   // always null
// messaging.ts additions
export type QuestionChange = "asked" | "answered" | "late_answer" | "proceeded" | "expired" | "extended";
export const LIVE_INSTANCE_STATES: readonly InstanceRow["state"][];                    // ["dispatching", "running", "unresponsive"]
// on Messaging:
ask(input: { roomId: string; from: ParticipantRef; instanceId: string; sessionId: string; body: string; options?: string[] }): Promise<QuestionRow>;
answer(questionId: string, from: ParticipantRef, body: string, provenance?: Provenance): Promise<{ question: QuestionRow; late: boolean }>;
expireQuestions(now: Date, precedent: Precedent): Promise<QuestionRow[]>;              // the rows it proceeded or expired
onQuestion(listener: (question: QuestionRow, change: QuestionChange) => void): () => void;
```

Every question change publishes `{ type: "question", payload: { question } }` with the question room's `visibleTo`. An on-time answer also publishes `{ type: "command", payload: { argv: ["answer", questionId, body] } }` (plan 01's `InstanceCommandArgv`), visible only to `{ kind: "instance", instanceId: question.instanceId }`: the shape of plan 04's `publishInstanceCommand`.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoPrecedent } from "../../src/messaging/precedent.js";
import type { QuestionChange } from "../../src/messaging/messaging.js";
import { toJson, type QuestionRow } from "../../src/store/rows.js";
import { makeWorld, SUB, type World } from "../helpers/world.js";

let w: World;
beforeEach(async () => { w = await makeWorld(); });
const askA = (o: { world?: World; options?: string[] } = {}) => {
  const x = o.world ?? w;
  return x.messaging.ask({ roomId: x.roomOf("inst-a"), from: x.refs.workerA, instanceId: "inst-a", sessionId: "sess-worker-a", body: "Which database?", options: o.options });
};

describe("ask", () => {
  it("stores the question message and an open Question whose wait comes from the registration over the brain's defaults", async () => {
    w = await makeWorld({ ask: { quiet_windows: [{ start: "22:00", end: "07:00" }] } });
    await w.store.registrations.patch("reg-a", { askJson: toJson({ min_wait_minutes: 60 }) });
    const q = await askA({ options: ["Postgres", "Redis"] });
    expect(q).toMatchObject({ roomId: w.roomOf("inst-a"), instanceId: "inst-a", sessionId: "sess-worker-a", state: "open", answerMessageId: null,
      proceededWith: null, lateAnswerMessageId: null, askedAt: "2026-10-25T10:00:00.000Z", waitUntil: "2026-10-25T11:00:00.000Z" });
    expect(await w.store.questions.get(q.id)).toEqual(q);
    const m = (await w.store.messages.get(q.messageId))!;
    expect(m).toMatchObject({ kind: "question", body: "Which database?", fromKind: "worker" });
    expect(JSON.parse(m.dataJson!)).toEqual({ questionId: q.id, options: ["Postgres", "Redis"] });
    expect(w.hub.published.filter((e) => e.type === "question").map((e) => e.payload)).toEqual([{ question: q }]);
    expect(w.push.endpoints()).toEqual([SUB("dev-laptop").endpoint, SUB("dev-phone").endpoint]);
  });
});

describe("answer", () => {
  it("marks an open question answered and sends the answer to the run", async () => {
    const q = await askA();
    const { question, late } = await w.messaging.answer(q.id, w.refs.owner, "Postgres");
    expect(late).toBe(false);
    expect(question.state).toBe("answered");
    expect(await w.store.messages.get(question.answerMessageId!)).toMatchObject({ kind: "answer", body: "Postgres", replyTo: q.messageId, fromId: "owner", fromKind: "human" });
    const [command] = w.hub.published.filter((e) => e.type === "command");
    expect(command.payload).toEqual({ argv: ["answer", q.id, "Postgres"] });
    expect([{ kind: "instance", instanceId: "inst-a" }, { kind: "instance", instanceId: "inst-b" }, w.actors.phone].map((a) => command.visibleTo(a as never))).toEqual([true, false, false]);
  });
  it("records an answer that arrives after the worker proceeded as late, with lateAnswerMessageId", async () => {
    const changes: Array<[QuestionChange, string]> = [];
    w.messaging.onQuestion((x, c) => changes.push([c, x.id]));
    const q = await askA();
    w.clock.advance(31 * 60_000);
    expect((await w.messaging.expireQuestions(w.clock.now(), { lookup: async () => "Use the existing Postgres." })).map((r) => r.id)).toEqual([q.id]);
    const { question, late } = await w.messaging.answer(q.id, w.refs.owner, "Use Redis.");
    expect(late).toBe(true);
    expect(question).toMatchObject({ state: "proceeded", proceededWith: "Use the existing Postgres.", answerMessageId: null });
    expect(await w.store.messages.get(question.lateAnswerMessageId!)).toMatchObject({ kind: "answer", body: "Use Redis.", replyTo: q.messageId, fromId: "owner", fromKind: "human" });
    expect(await w.store.questions.get(q.id)).toEqual(question);
    expect(changes).toEqual([["asked", q.id], ["proceeded", q.id], ["late_answer", q.id]]);
    expect(w.hub.published.filter((e) => e.type === "command")).toEqual([]);
  });
  it("treats a second answer as late and keeps the first", async () => {
    const q = await askA();
    const first = await w.messaging.answer(q.id, w.refs.owner, "Postgres");
    const second = await w.messaging.answer(q.id, { id: "part-cos", kind: "cos" }, "Redis, on reflection");
    expect(second.late).toBe(true);
    expect(second.question).toMatchObject({ state: "answered", answerMessageId: first.question.answerMessageId });
    expect(second.question.lateAnswerMessageId).not.toBeNull();
  });
  it("refuses answers from agents and for unknown questions", async () => {
    const q = await askA();
    await expect(w.messaging.answer(q.id, w.refs.workerB, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.messaging.answer("q-missing", w.refs.owner, "x")).rejects.toMatchObject({ code: "question_not_found" });
    expect(await w.store.messages.find({ roomId: w.roomOf("inst-a"), kind: "answer" })).toEqual([]);
  });
});

describe("expireQuestions", () => {
  it("proceeds with the precedent's answer once the wait has passed, and leaves younger questions open", async () => {
    const q1 = await askA();
    w.clock.advance(20 * 60_000);
    const q2 = await askA();
    w.clock.advance(11 * 60_000);
    const lookup = vi.fn(async (x: QuestionRow) => (x.id === q1.id ? "Use Postgres, as on card 12" : null));
    expect((await w.messaging.expireQuestions(w.clock.now(), { lookup })).map((x) => x.id)).toEqual([q1.id]);
    expect(await w.store.questions.get(q1.id)).toMatchObject({ state: "proceeded", proceededWith: "Use Postgres, as on card 12" });
    expect((await w.store.questions.get(q2.id))!.state).toBe("open");
    expect((await w.messagesIn(w.roomOf("inst-a"))).at(-1)).toMatchObject({ kind: "event", replyTo: q1.messageId,
      body: "No answer by 2026-10-25T10:30:00.000Z; the worker proceeds with a past answer." });
  });
  it("proceeds on the worker's own reading with NoPrecedent", async () => {
    const q = await askA();
    w.clock.advance(31 * 60_000);
    await w.messaging.expireQuestions(w.clock.now(), NoPrecedent);
    expect(await w.store.questions.get(q.id)).toMatchObject({ state: "proceeded", proceededWith: null });
    expect((await w.messagesIn(w.roomOf("inst-a"))).at(-1)!.body).toBe("No answer by 2026-10-25T10:30:00.000Z; the worker proceeds on its own reading.");
  });
  it("marks a question whose run has ended expired, without asking for a precedent", async () => {
    const q = await askA();
    await w.store.instances.patch("inst-a", { state: "exited" });
    w.clock.advance(31 * 60_000);
    const lookup = vi.fn(async () => "x");
    expect(await w.messaging.expireQuestions(w.clock.now(), { lookup })).toMatchObject([{ id: q.id, state: "expired" }]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("extends the wait when the brain comes back inside a quiet window", async () => {
    const x = await makeWorld({ ask: { quiet_windows: [{ start: "11:00", end: "12:00" }] } });
    const q = await askA({ world: x });
    x.clock.advance(75 * 60_000);
    expect(await x.messaging.expireQuestions(x.clock.now(), NoPrecedent)).toEqual([]);
    expect(await x.store.questions.get(q.id)).toMatchObject({ state: "open", waitUntil: "2026-10-25T12:00:00.000Z" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/questions.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/precedent.js"`.

- [ ] **Step 3: Implement `precedent.ts` and the question methods**

- The wait settings for a question are `resolveAsk(deps.ask, overrides)`, where `overrides` is `registrationAsk(registration)` for the instance's registration. A `RowJsonError` is logged (`log.warn("bad askJson", { registrationId })`) and counts as `{}`.
- `ask`, in this order, so that no push for a question goes out before its row exists:
  1. Store and publish the question message: data `{ questionId, options }`, with `options` left out when none were given; provenance `{ source: <from.kind>, instanceId, sessionId }`.
  2. `put` the Question row: `id: newId("q")`, `askedAt: now`, `waitUntil: computeWaitUntil(now, settings, now)`, `state: "open"`.
  3. Publish `question`.
  4. Tell the listeners `asked`.
  5. Push the message.

  Split `post` into a private store-and-publish step and a push step, so that `ask` can put its row between the two.
- `answer`:
  1. The question must exist, else `question_not_found`. `from.kind` must be `human` or `cos`, else `forbidden`.
  2. Post an `answer` message with `replyTo: question.messageId` and data `{ questionId }`. Its provenance is the argument, or `{ source: "cos" }` / `{ source: "human" }` when absent.
  3. If the question is `open`, patch `{ state: "answered", answerMessageId }`, then publish the instance `command` event.
  4. Otherwise (`answered`, `proceeded`, `expired`), patch `{ lateAnswerMessageId }` and send nothing to the run.
  5. Publish `question`, tell the listeners, and return `late`.
- `expireQuestions(now, precedent)` takes `questions.find({ state: "open" })` with `waitUntil <= now`. For each:
  - The instance is not in `LIVE_INSTANCE_STATES`: patch it `expired`, with the event note `No answer by <waitUntil>; the run has ended, so nobody is waiting.`
  - Otherwise `computeWaitUntil(askedAt, settings, now)` is later than `now`: patch the new `waitUntil` (change `extended`).
  - Otherwise patch it `proceeded`, with `proceededWith` from `precedent.lookup` (a throw logs `precedent failed` and counts as `null`). The event note is `No answer by <waitUntil>; the worker proceeds with a past answer.`, or `…; the worker proceeds on its own reading.` when `proceededWith` is null.

  The notes are `event` messages from `{ id: "system", kind: "system" }` with `replyTo` the question message, data `{ questionId, state }` and provenance `{ source: "system" }`. `event` messages are not pushed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/questions.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging packages/os/tests/messaging/questions.test.ts
git commit -m "feat(os): questions with quiet-window waits, late answers, precedent-backed proceed and run delivery"
```

---

### Task 6: Participants and room helpers

**Files:**
- Create: `packages/os/src/messaging/participants.ts`, `packages/os/src/messaging/rooms.ts`
- Modify: `packages/os/tests/helpers/world.ts` (adds `participants` and `rooms`)
- Test: `packages/os/tests/messaging/rooms.test.ts`

**Interfaces:**
- Consumes: `Messaging`, `ParticipantRef`, `Provenance`, `MessagingError` (Task 4); plan 02's rows, `newId`, `toJson`, `roomMembers`, `registrationOwners`; plan 03's `Actor`, `OsConfig`.
- Produces:

```ts
// participants.ts
export type Permission = "send" | "read" | "who" | "ask_human" | "command";
export function permissionsFor(kind: ParticipantRow["kind"]): Permission[];   // human, cos: all five; worker, reviewer, arbiter, instance: send, read, who, ask_human
export const SYSTEM_REF: ParticipantRef;                                      // { id: "system", kind: "system" }
export class Participants {
  constructor(deps: { store: OsStore; clock: Clock; owners?: ReadonlyArray<{ id: string; name: string }> });
  ensureParticipant(kind: Exclude<ParticipantRow["kind"], "human">, name: string, instanceId?: string): Promise<ParticipantRow>;   // idempotent per (kind, name, instanceId); plan 04's sessions and attach routes call it
  ensureHuman(humanId: string, name?: string): Promise<ParticipantRow>;        // the row id is the human id
  cos(): Promise<ParticipantRow>;                                               // the one participant of kind cos, as plan 06's voice expects
  refFor(actor: Actor): Promise<ParticipantRef>;
  provenanceFor(actor: Actor): Promise<Provenance>;
}
// rooms.ts
export class Rooms {
  constructor(deps: { store: OsStore; messaging: Messaging; participants: Participants; config: Pick<OsConfig, "owners"> });
  systemRoom(): Promise<RoomRow>;
  cosRoom(humanId: string): Promise<RoomRow>;
  boardRoom(board: BoardRow): Promise<RoomRow>;
  instanceRoom(instance: Pick<InstanceRow, "id" | "registrationId" | "boardId" | "cardId">): Promise<RoomRow>;   // reads only these fields, so plan 04 can call it before it stores the row
  directRoom(a: string, b: string): Promise<RoomRow>;
}
```

- [ ] **Step 1: Write the failing test**

Add `participants` (`new Participants({ store, clock, owners: config.owners })`) and `rooms` (`new Rooms({ store, messaging, participants, config })`) to `World`, then:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { Participants, permissionsFor } from "../../src/messaging/participants.js";
import { roomMembers } from "../../src/store/rows.js";
import { makeWorld, type World } from "../helpers/world.js";

let w: World;
beforeEach(async () => { w = await makeWorld(); });
const cosId = async () => (await w.participants.cos()).id;

describe("permissionsFor", () => {
  it("gives commands to humans and the chief of staff only", () => {
    expect(permissionsFor("human")).toEqual(["send", "read", "who", "ask_human", "command"]);
    expect(permissionsFor("cos")).toEqual(["send", "read", "who", "ask_human", "command"]);
    for (const k of ["worker", "reviewer", "arbiter", "instance"] as const) expect(permissionsFor(k)).toEqual(["send", "read", "who", "ask_human"]);
  });
});

describe("Participants", () => {
  it("ensureParticipant is idempotent per kind, name and instance, even when called at once", async () => {
    const [a, b] = await Promise.all([1, 2].map(() => w.participants.ensureParticipant("worker", "sess-9", "inst-a")));
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ kind: "worker", name: "sess-9", instanceId: "inst-a", permissionsJson: JSON.stringify(permissionsFor("worker")) });
    expect((await w.participants.ensureParticipant("worker", "sess-9", "inst-b")).id).not.toBe(a.id);
    expect((await w.participants.ensureParticipant("instance", "project-a/42", "inst-a")).id).toBe("part-inst-a");
  });
  it("cos() finds the one chief-of-staff participant, or creates it", async () => {
    expect(await w.participants.cos()).toMatchObject({ kind: "cos", name: "chief of staff" });
    expect((await new Participants({ store: w.store, clock: w.clock }).cos()).id).toBe(await cosId());
  });
  it("refFor maps each actor kind to the sender it posts as", async () => {
    expect(await w.participants.refFor(w.actors.phone)).toEqual({ id: "owner", kind: "human" });
    expect(await w.participants.refFor(w.actors.host)).toEqual({ id: "host", kind: "human" });
    expect(await w.participants.refFor(w.actors.cos)).toEqual({ id: await cosId(), kind: "cos" });
    expect(await w.participants.refFor(w.actors.workerA)).toEqual({ id: "part-worker-a", kind: "worker" });
    expect(await w.participants.refFor(w.actors.instA)).toEqual({ id: "part-inst-a", kind: "instance" });
    expect(await w.participants.refFor({ kind: "instance", instanceId: "inst-a" })).toEqual({ id: "part-inst-a", kind: "instance" });
    await expect(w.participants.refFor({ kind: "room", instanceId: "inst-a", participantId: "part-gone", roomId: w.roomOf("inst-a") })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("provenanceFor carries a human's session, device and address, and marks owners", async () => {
    expect(await w.participants.provenanceFor(w.actors.phone)).toEqual({ source: "owner", sessionId: "sess-phone", deviceId: "dev-phone", address: "203.0.113.7" });
    expect(await w.participants.provenanceFor({ ...w.actors.phone, humanId: "guest" })).toMatchObject({ source: "human" });
    expect(await w.participants.provenanceFor(w.actors.host)).toEqual({ source: "owner" });
    expect(await w.participants.provenanceFor(w.actors.cos)).toEqual({ source: "cos" });
    expect(await w.participants.provenanceFor(w.actors.workerA)).toEqual({ source: "worker", instanceId: "inst-a" });
  });
});

describe("Rooms", () => {
  it("systemRoom holds the OS owners and the chief of staff, and is created once", async () => {
    const [a, b] = await Promise.all([w.rooms.systemRoom(), w.rooms.systemRoom()]);
    expect(a.id).toBe(b.id);
    expect(roomMembers(a).sort()).toEqual([await cosId(), "owner", "owner-2"].sort());
    expect(await w.store.rooms.find({ kind: "system" })).toHaveLength(1);
  });
  it("cosRoom is the one chief-of-staff room, with each human who uses it as a member", async () => {
    const a = await w.rooms.cosRoom("owner");
    const b = await w.rooms.cosRoom("guest");
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ kind: "cos", subjectId: null, name: "chief of staff" });
    expect(roomMembers(b)).toEqual(expect.arrayContaining([await cosId(), "owner", "owner-2", "guest"]));
  });
  it("boardRoom holds the board's owners and is local_only when any registration on the board is", async () => {
    const room = await w.rooms.boardRoom((await w.store.boards.get("board-p"))!);
    expect(room).toMatchObject({ kind: "board", subjectId: "board-p", name: "board-p", privacy: "local_only" });
    expect(roomMembers(room)).toEqual(expect.arrayContaining([await cosId(), "owner"]));
    expect((await w.rooms.boardRoom((await w.store.boards.get("board-a"))!)).privacy).toBe("normal");
  });
  it("instanceRoom opens the run's room from the row about to be stored, named board#card", async () => {
    const room = await w.rooms.instanceRoom({ id: "inst-new", registrationId: "reg-p", boardId: "board-p", cardId: "9" });
    expect(room).toMatchObject({ kind: "instance", subjectId: "inst-new", name: "board-p#9", privacy: "local_only" });
    expect(roomMembers(room)).toEqual(expect.arrayContaining([await cosId(), "owner"]));
    expect((await w.rooms.instanceRoom({ id: "inst-a", registrationId: "reg-a", boardId: "board-a", cardId: "42" })).id).toBe(w.roomOf("inst-a"));
  });
  it("directRoom is the same room whichever side opens it, and refuses a room with oneself", async () => {
    const a = await w.rooms.directRoom("owner", "part-worker-a");
    expect((await w.rooms.directRoom("part-worker-a", "owner")).id).toBe(a.id);
    expect(a).toMatchObject({ kind: "direct", subjectId: "owner|part-worker-a", privacy: "normal" });
    expect((await w.rooms.directRoom("owner", "part-worker-p")).privacy).toBe("local_only");
    await expect(w.rooms.directRoom("owner", "owner")).rejects.toMatchObject({ code: "bad_request" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/rooms.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/participants.js"`.

- [ ] **Step 3: Implement `participants.ts` and `rooms.ts`**

- `ensureParticipant` runs one at a time per `kind|name|instanceId` and returns `participants.find({ kind, name, instanceId: instanceId ?? null })[0]`. Otherwise it puts `{ id: newId("part"), kind, name, instanceId: instanceId ?? null, permissionsJson: toJson(permissionsFor(kind)), createdAt: now }`. `ensureHuman` puts `{ id: humanId, kind: "human", name: name ?? <owner's name> ?? humanId, … }` when `get(humanId)` is null. `cos()` (memoised) takes the first `participants.find({ kind: "cos" })`, or else puts one named `chief of staff`.
- `refFor`, by actor kind:
  - `human`: the human id.
  - `host`: `ensureHuman("host", "host")`.
  - `cos`: `cos()`.
  - `room`: the participant row, kind included; a missing row is `MessagingError("forbidden")`.
  - `instance`: the first participant of kind `instance` with that `instanceId`, else `ensureParticipant("instance", instanceId, instanceId)`.
- `provenanceFor`, by actor kind:
  - `human`: `{ source: owners.has(humanId) ? "owner" : "human", sessionId, deviceId, address }`.
  - `host`: `{ source: "owner" }`.
  - `cos`: `{ source: "cos" }`.
  - `room`: `{ source: <participant kind>, instanceId }`.
  - `instance`: `{ source: "instance", instanceId }`.
- `Rooms`:
  - `systemRoom()` and `cosRoom()` are singletons found by kind, memoised per `Rooms`. The first open row of that kind gets missing members patched into `membersJson`. Otherwise `messaging.openRoom(kind, null, name, members, "normal")` creates it: name `system` with members `[cos, ...owners]`, or name `chief of staff` with members `[cos, ...owners, humanId]`, the construction plan 06's voice uses. Owners get `ensureHuman` rows.
  - `boardRoom` is `openRoom("board", board.id, board.name, [cos, ...owners of every registration on the board], <local_only if any is>)`.
  - `instanceRoom` is `openRoom("instance", id, "<board name>#<cardId>", [instance participant, cos, ...registration owners], registration.privacy)`. The instance participant is found as in `refFor`, else `ensureParticipant("instance", "<projectName>/<cardId>", id)`, the name plan 04 gives it.
  - `directRoom(a, b)`: equal ids are `MessagingError("bad_request")`. Otherwise sort the two ids and call `openRoom("direct", "<x>|<y>", "<x> & <y>", [x, y], privacy)`, with privacy `local_only` when either id is a participant whose instance's registration is `local_only`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/rooms.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/participants.ts packages/os/src/messaging/rooms.ts packages/os/tests/helpers/world.ts packages/os/tests/messaging/rooms.test.ts
git commit -m "feat(os): participants, actor provenance and the system, cos, board, instance and direct rooms"
```

---

### Task 7: Command contracts: registry, argument parsing, gate, tripwires stub

**Files:**
- Create: `packages/os/src/commands/registry.ts`, `packages/os/src/commands/gate.ts`, `packages/os/src/commands/tripwires.ts`, `packages/os/src/commands/peer-types.ts`
- Create unless plan 08 already wrote it: `packages/os/src/commands/argv-args.ts` (plan 08 owns it; when it exists, use it and keep this task's tests, which pin the rule both plans follow)
- Test: `packages/os/tests/commands/registry.test.ts`, `packages/os/tests/commands/tripwires.test.ts`

**Interfaces:**
- Consumes: `Messaging`, `Provenance` (Task 4); `Rooms` (Task 6, for the system room in tests); plan 03's `Actor`, `OsConfig` and `RefusalCode` (`packages/os/src/security/refusals.ts`); plan 02's `OsStore`, `Clock`, `newId`, `toJson`.
- Produces:

```ts
// registry.ts
export type CommandKind = "query" | "operating" | "standing";
export interface CommandSpec<A> { name: string; summary: string; kind: CommandKind; args: z.ZodType<A>; run(ctx: CommandContext, args: A): Promise<CommandResult> }   // args must be a z.object
export interface CommandContext { actor: Actor; roomId: string; store: OsStore; dispatcher: Dispatcher; messaging: Messaging; launcher: Launcher; config: OsConfig; clock: Clock; provenance: Provenance }
export interface CommandResult { ok: boolean; text: string; data?: unknown }
export interface CommandRuntime { dispatcher: Dispatcher; launcher: Launcher }   // read at call time: the Dispatcher is built after Messaging
export const COMMAND_KINDS: Readonly<Record<string, CommandKind>>;               // the overview's 35 names, frozen; the only place kinds are declared
export const COMMANDS: CommandSpec<any>[];                                       // empty at module load; filled at brain start
export class CommandRegistryError extends Error {}
export class CommandArgsError extends Error {}
export function registerCommand(spec: CommandSpec<any>, into?: CommandSpec<any>[]): void;   // into defaults to COMMANDS
export function parseCommand(argv: string[]): { name: string; rest: string[] };
export function normalizeArgv(argv: string[]): string[];                        // trims, drops empty tokens, strips one leading "/" from the first
export function tokenizeCommand(text: string): string[] | null;                 // for clients that turn typed "/…" text into argv
// argv-args.ts (plan 08's file, written here first)
export type ArgvArgs = Record<string, unknown>;
export function argvToArgs(spec: CommandSpec<unknown>, rest: string[]): ArgvArgs;   // CommandArgsError for a token it cannot place
// gate.ts (plan 09 reduces this file to a re-export)
export type GateVerdict = { ok: true } | { ok: false; code: RefusalCode; text: string; data?: Record<string, unknown> };
export interface LimitCheckInput { ctx: CommandContext; spec: CommandSpec<unknown>; command: CommandSpec<unknown>; actor: Actor; roomId: string; args: unknown; argv: string[]; stepupSupplied: boolean }   // spec === command, actor === ctx.actor, roomId === ctx.roomId
export interface LimitGate { checkCommand(input: LimitCheckInput): Promise<GateVerdict> }
export const NoLimitGate: LimitGate;
export function refuse(code: RefusalCode, text: string, data?: Record<string, unknown>): CommandResult;   // { ok: false, text, data: { ...data, code } }
export function refusalCode(result: CommandResult): RefusalCode | null;                                    // data.code when !ok, else null
// tripwires.ts (stub with plan 09's surface; plan 09 reduces this file to a re-export)
export type TripwireEvent = "stepup_failed" | "burst" | "new_address" | "stop_all" | "hold_all";
export class Tripwires {
  constructor(deps: { store: OsStore; clock: Clock; messaging?: Messaging });
  record(event: TripwireEvent, actor: Actor): Promise<{ cooldownUntil: Date | null; notifyOwners: boolean }>;
  cooling(actor: Actor): Promise<Date | null>;
  announce(event: "stepup_requested", actor: Actor, argv: string[]): Promise<void>;
}
// peer-types.ts: re-exports of plan 04's types once its files exist on the branch
export type { Dispatcher } from "../dispatch/dispatcher.js";
export type { Launcher, ResourceSnapshot } from "../launcher/launcher.js";
```

The `args` convention, which `argvToArgs` implements and plan 08 shares:
- Positional words fill the schema's keys in declaration order, skipping boolean keys.
- `--<flag>` sets a boolean key to `true`; `--<key> <value>` sets any other key.
- A trailing `z.array(z.string())` key takes every remaining word.
- `spec.args.safeParse` decides validity.
- A positional word with no key left, or a `--name` that is no key of the schema, throws `CommandArgsError`.
- Argv values are strings, so a numeric argument uses `z.coerce.number()`.

- [ ] **Step 1: Write the failing tests**

```ts
// registry.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { argvToArgs } from "../../src/commands/argv-args.js";
import { NoLimitGate, refuse, refusalCode } from "../../src/commands/gate.js";
import { COMMAND_KINDS, CommandArgsError, CommandRegistryError, parseCommand, registerCommand, tokenizeCommand, type CommandSpec } from "../../src/commands/registry.js";

const spec = (name: string, kind: CommandSpec<unknown>["kind"], args: z.ZodType<unknown> = z.object({})): CommandSpec<unknown> =>
  ({ name, kind, summary: name, args, run: async () => ({ ok: true, text: name }) });

it("declares the overview's 35 commands and their kinds", () => {
  expect(Object.keys(COMMAND_KINDS)).toHaveLength(35);
  expect(COMMAND_KINDS).toMatchObject({ top: "query", rooms: "query", instances: "query", why: "query", help: "query", dispatch: "operating", hold: "operating",
    "override min_cards": "operating", "pause board": "operating", "stop run": "operating", "retry run": "operating", answer: "operating", say: "operating",
    sync: "operating", "substrate status": "operating", doctor: "operating", register: "standing", unregister: "standing", "set ask_first": "standing",
    "set limits": "standing", "devices revoke": "standing", "devices approve": "standing", lockdown: "standing", "lockdown release": "standing",
    "db reset": "standing", "substrate stop": "standing", upgrade: "standing", merge: "standing", uninstall: "standing" });
  expect(Object.isFrozen(COMMAND_KINDS)).toBe(true);
});
it.each([
  [["/top"], { name: "top", rest: [] }],
  [["pause", "board", "board-a"], { name: "pause board", rest: ["board-a"] }],
  [["Lockdown", "release"], { name: "lockdown release", rest: [] }],
  [["lockdown"], { name: "lockdown", rest: [] }],
  [["substrate", "stop"], { name: "substrate stop", rest: [] }],
  [["retry", "run", "inst-1", "--fresh"], { name: "retry run", rest: ["inst-1", "--fresh"] }],
  [["frobnicate", "x"], { name: "frobnicate", rest: ["x"] }],
])("parseCommand(%j)", (argv, expected) => { expect(parseCommand(argv)).toEqual(expected); });
describe("argvToArgs", () => {
  const dispatch = spec("dispatch", "operating", z.object({ board: z.string(), card: z.string() }));
  const retry = spec("retry run", "operating", z.object({ instance: z.string(), fresh: z.boolean().optional() }));
  const say = spec("say", "operating", z.object({ room: z.string(), text: z.array(z.string()) }));
  const hold = spec("hold", "operating", z.object({ board: z.string(), card: z.string(), reason: z.string().optional() }));
  it("fills positional words into the keys in declaration order", () => {
    expect(argvToArgs(dispatch, ["board-a", "42"])).toEqual({ board: "board-a", card: "42" });
    expect(argvToArgs(dispatch, ["board-a"])).toEqual({ board: "board-a" });
  });
  it("reads --flag for a boolean key and --key value for any other key", () => {
    expect(argvToArgs(retry, ["inst-1", "--fresh"])).toEqual({ instance: "inst-1", fresh: true });
    expect(argvToArgs(retry, ["inst-1"])).toEqual({ instance: "inst-1" });
    expect(argvToArgs(hold, ["board-a", "42", "--reason", "waiting on design"])).toEqual({ board: "board-a", card: "42", reason: "waiting on design" });
  });
  it("gives every remaining word to a trailing string-array key", () => {
    expect(argvToArgs(say, ["room-a", "hello", "there"])).toEqual({ room: "room-a", text: ["hello", "there"] });
  });
  it("throws for a word it cannot place and for a flag the schema does not have", () => {
    expect(() => argvToArgs(dispatch, ["board-a", "42", "extra"])).toThrow(CommandArgsError);
    expect(() => argvToArgs(retry, ["inst-1", "--now"])).toThrow(CommandArgsError);
  });
  it("leaves validity to safeParse", () => {
    expect(dispatch.args.safeParse(argvToArgs(dispatch, ["board-a"])).success).toBe(false);
    expect(say.args.safeParse(argvToArgs(say, ["room-a", "hi"])).success).toBe(true);
  });
});
describe("registerCommand", () => {
  it("adds a spec whose name and kind match the table, whenever it is called", () => {
    const list: CommandSpec<any>[] = [];
    registerCommand(spec("top", "query"), list);
    expect(list.map((s) => s.name)).toEqual(["top"]);
  });
  it("refuses a name outside the table, a different kind, args that are not an object, and a duplicate", () => {
    const list: CommandSpec<any>[] = [spec("top", "query")];
    expect(() => registerCommand(spec("frobnicate", "operating"), list)).toThrow(CommandRegistryError);
    expect(() => registerCommand(spec("lockdown", "operating"), list)).toThrow(/lockdown is standing/);
    expect(() => registerCommand(spec("say", "operating", z.array(z.string()) as never), list)).toThrow(/z\.object/);
    expect(() => registerCommand(spec("top", "query"), list)).toThrow(/already registered/);
  });
});
describe("tokenizeCommand", () => {
  it("splits a slash command and keeps quoted words together", () => {
    expect(tokenizeCommand('/say room-a "hello there"')).toEqual(["say", "room-a", "hello there"]);
    expect(tokenizeCommand("  /top  ")).toEqual(["top"]);
  });
  it("is null for text that is not a command", () => {
    for (const text of ["hello", "//not a command", "/", ""]) expect(tokenizeCommand(text), text).toBeNull();
  });
});
describe("gate helpers", () => {
  it("refuse puts the code in data and refusalCode reads it back", () => {
    const r = refuse("limit", "limit registrable_roots", { limit: "registrable_roots" });
    expect(r).toEqual({ ok: false, text: "limit registrable_roots", data: { limit: "registrable_roots", code: "limit" } });
    expect(refusalCode(r)).toBe("limit");
    expect(refusalCode({ ok: true, text: "done" })).toBeNull();
  });
  it("NoLimitGate passes everything", async () => {
    expect(await NoLimitGate.checkCommand({} as never)).toEqual({ ok: true });
  });
});
```

```ts
// tripwires.test.ts
import { beforeEach, expect, it } from "vitest";
import { Tripwires } from "../../src/commands/tripwires.js";
import type { RoomRow } from "../../src/store/rows.js";
import { makeWorld, SUB, type World } from "../helpers/world.js";

let w: World; let tw: Tripwires; let sys: RoomRow;
beforeEach(async () => { w = await makeWorld(); sys = await w.rooms.systemRoom(); tw = new Tripwires({ store: w.store, clock: w.clock, messaging: w.messaging }); });
const rows = () => w.store.messages.find({ roomId: sys.id }, { orderBy: "seq" });

it("writes an audit row for each event and cools a session on the second stepup_failed within ten minutes", async () => {
  expect(await tw.record("stepup_failed", w.actors.phone)).toEqual({ cooldownUntil: null, notifyOwners: false });
  const [row] = await rows();
  expect(row).toMatchObject({ kind: "event", body: "tripwire stepup_failed" });
  expect(JSON.parse(row.dataJson!)).toEqual({ tripwire: { event: "stepup_failed", sessionId: "sess-phone", humanId: "owner", deviceId: "dev-phone", address: "203.0.113.7", at: "2026-10-25T10:00:00.000Z" } });
  w.clock.advance(5 * 60_000);
  expect((await tw.record("stepup_failed", w.actors.phone)).cooldownUntil?.toISOString()).toBe("2026-10-25T10:15:00.000Z");
  expect((await w.store.sessions.get("sess-phone"))!.cooldownUntil).toBe("2026-10-25T10:15:00.000Z");
  expect((await tw.cooling(w.actors.phone))?.toISOString()).toBe("2026-10-25T10:15:00.000Z");
  expect(await tw.cooling(w.actors.laptop)).toBeNull();
});
it("does not cool for two failures more than ten minutes apart", async () => {
  await tw.record("stepup_failed", w.actors.phone);
  w.clock.advance(11 * 60_000);
  expect(await tw.record("stepup_failed", w.actors.phone)).toEqual({ cooldownUntil: null, notifyOwners: false });
});
it("tells every owner once when a cool-down starts, and does not extend it", async () => {
  await tw.record("stepup_failed", w.actors.phone);
  await tw.record("stepup_failed", w.actors.phone);
  const notices = (await rows()).filter((m) => m.kind === "system");
  expect(notices.map((m) => m.body)).toEqual(['Cool-down until 10:10 UTC: session sess-phone on device "phone" of owner tripped stepup_failed from 203.0.113.7. Its commands are refused until then. If this was not you, revoke the device from another device or run "swarm os lockdown" on the host.']);
  expect(w.push.endpoints()).toEqual([SUB("dev-laptop"), SUB("dev-other"), SUB("dev-phone")].map((s) => s.endpoint));
  w.clock.advance(60_000);
  expect(await tw.record("stepup_failed", w.actors.phone)).toEqual({ cooldownUntil: new Date("2026-10-25T10:10:00.000Z"), notifyOwners: false });
});
it("cools at once for the other events, and never cools anyone but a human", async () => {
  expect((await tw.record("burst", w.actors.laptop)).cooldownUntil?.toISOString()).toBe("2026-10-25T10:10:00.000Z");
  expect(await tw.record("stop_all", w.actors.cos)).toEqual({ cooldownUntil: null, notifyOwners: false });
  expect((await rows()).filter((m) => m.kind === "event").map((m) => m.body)).toEqual(["tripwire burst", "tripwire stop_all"]);
});
it("returns notifyOwners when it has no messaging to tell the owners itself", async () => {
  const bare = new Tripwires({ store: w.store, clock: w.clock });
  await bare.record("stepup_failed", w.actors.other);
  expect((await bare.record("stepup_failed", w.actors.other)).notifyOwners).toBe(true);
});
it("announce tells every owner about a step-up request and cools nothing", async () => {
  await tw.announce("stepup_requested", w.actors.phone, ["register", "board-b", "/path/to/project-b"]);
  expect((await rows()).filter((m) => m.kind === "system").map((m) => m.body)).toEqual(['Step-up requested for "register board-b /path/to/project-b" by owner on "phone" from 203.0.113.7. The code is shown only on the host or a confirmer device. If this was not you, revoke the device or run "swarm os lockdown" on the host.']);
  expect(await tw.cooling(w.actors.phone)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/commands`
Expected: FAIL, `Failed to resolve import "../../src/commands/gate.js"` and `…/tripwires.js`.

- [ ] **Step 3: Implement the four files**

- `COMMAND_KINDS`: query `top`, `rooms`, `instances`, `why`, `help`. Operating `dispatch`, `hold`, `override min_cards`, `pause board`, `resume board`, `pause run`, `resume run`, `retry run`, `stop run`, `answer`, `say`, `sync`, `logs`, `skill`, `mcp`, `substrate status`, `doctor`. Standing `register`, `unregister`, `set ask_first`, `set limits`, `devices revoke`, `devices approve`, `lockdown`, `lockdown release`, `db reset`, `substrate stop`, `upgrade`, `merge`, `uninstall`. `Object.freeze`d.
- `parseCommand` normalises, lower-cases the first two tokens for matching, and takes the two-word name when the table has it, else the first word. An unknown name comes back as it is, and the executor answers it.
- `registerCommand` throws `CommandRegistryError` in four cases: a name the table lacks (`"<name> is not in the command table"`), a different kind (`"<name> is <table kind>, not <kind>"`), args that are not a `z.ZodObject` (`"args of <name> must be a z.object"`), and a name already in `into` (`"<name> is already registered"`).
- `argvToArgs` reads `spec.args.shape`. It unwraps `optional`, `default` and `nullable` through `def.innerType` to tell boolean keys and a trailing string-array key from the rest. Keys with no token are left out, so zod reports any that are required.
- `tokenizeCommand`: trim the text. It must start with exactly one `/` followed by a non-space; split on whitespace outside double quotes.
- `gate.ts` has exactly the Produces block. `refusalCode` returns `data.code` only when it is a key of plan 03's `REFUSAL_STATUS`.
- `tripwires.ts` follows plan 09's file:
  - **Audit rows.** Each `record` writes one row in the system room: `kind: "event"`, body `tripwire <event>`, `dataJson` `{ tripwire: { event, sessionId, humanId, deviceId, address, at } }` (null where the actor has none). It is written with `store.messages.put` and `store.nextSeq`, so it is neither published nor pushed. The system room is the first open row of kind `system`; if there is none, put one named `system` with no members.
  - **Who is cooled.** Only a human actor's session. A session already cooling gets its `cooldownUntil` back with `notifyOwners: false`.
  - **When.** `stepup_failed` cools once this row and the earlier `stepup_failed` rows for that session in the last 10 minutes number two (scan the system room's latest 500 rows by `seq`). Every other event cools at once.
  - **Cooling.** Patch `cooldownUntil: now + 10 min` onto the session. With `messaging`, post the cool-down notice as a `system` message from `SYSTEM_REF` (the body the test pins; `HH:MM` is the UTC time) and return `notifyOwners: false`. Without `messaging`, return `notifyOwners: true`.
  - **`cooling`.** A human actor's `cooldownUntil` while it is later than now, else `null`.
  - **`announce`.** Posts the step-up notice as a `system` message. `<who>` is `<humanId> on "<device name>"`, `the chief of staff` or `the host`; `<address>` is the human's address, else `the brain`.
- `peer-types.ts`: the two re-export lines when `packages/os/src/dispatch/dispatcher.ts` and `packages/os/src/launcher/launcher.ts` exist on the branch. While they do not, declare `export interface Dispatcher {}` and `export interface Launcher {}` as placeholders, and `ResourceSnapshot` exactly as the overview gives it. The plan that lands second switches this file to the re-exports, and that is the only change it needs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run tests/commands`
Expected: PASS, 25 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/commands packages/os/tests/commands
git commit -m "feat(os): command table, argv-to-args parsing, limit-gate contract and the tripwires stub"
```

---

### Task 8: The executor: authority, lockdown, cool-down, arguments, limits, run and audit

**Files:**
- Create: `packages/os/src/commands/executor.ts`
- Create: `packages/os/tests/helpers/commands.ts`
- Test: `packages/os/tests/commands/executor.test.ts`

**Interfaces:**
- Consumes: Task 7's registry, `argvToArgs`, gate and `Tripwires`; `Participants`, `SYSTEM_REF`, `Rooms` (Task 6); `Messaging` (Task 4); `redactSecrets` (Task 1); plan 03's `StepUps`, `Lockdown`, `EventPublisher`; plan 02's `Logger`.
- Produces:

```ts
export interface ExecutorDeps {
  stepUps: Pick<StepUps, "issue" | "confirm" | "consume">;
  lockdown: Pick<Lockdown, "active">;
  tripwires: Pick<Tripwires, "record" | "cooling" | "announce">;
  hub: EventPublisher;
  limits?: Pick<LimitGate, "checkCommand">;   // default NoLimitGate; plan 09's SecurityGate in production
  commands?: CommandSpec<any>[];             // default COMMANDS, read on every call
  log?: Logger;
}
export class CommandExecutor {
  constructor(deps: ExecutorDeps);
  execute(ctx: CommandContext, argv: string[], stepup?: { stepUpId: string; code: string }): Promise<CommandResult>;
}
export function mayRun(actor: Actor): boolean;   // human, host and cos; never room or instance
```

- Produces (test helper `packages/os/tests/helpers/commands.ts`): `makeCommandWorld(): Promise<CommandWorld>` and `testStepUps(store, clock, ttlSeconds = 120): TestStepUps`.
  - `CommandWorld` extends `World` with `stepUps`, `lockdown` (`{ engaged: boolean; active(): boolean }`), `tripwires` (Task 7's stub with `messaging`), `gate` (`{ verdict: GateVerdict; inputs: LimitCheckInput[]; checkCommand }`, passing by default), `commands`, `executor`, `ran` (`Array<{ name, args, actor }>`), `cosRoomId`, `systemRoomId`, and `ctx(actor, roomId = cosRoomId): Promise<CommandContext>`.
  - `ctx` sets `provenance` from `participants.provenanceFor(actor)`; its `dispatcher` and `launcher` are `{}` cast to plan 04's types (peer types), which no plan 05 command touches.
  - `commands` is a fresh list. Into it `registerCommand` puts test specs that record into `ran`, each with its name as its `summary`:
    - `help` (query, `{}`) answers `help text`.
    - `say` (operating, `{ room: z.string(), text: z.array(z.string()).min(1) }`) answers `said <the words joined by spaces>`.
    - `dispatch` (operating, `{ board, card }`) answers `dispatched`.
    - `register` (standing, `{ board, path }`) answers `registered <board>`.
    - `db reset` (standing, `{}`) answers `reset`.
    - `instances` (query, `{}`) throws `new Error("store exploded: Bearer abcdefghijklmnopqrstuv")`.
  - `TestStepUps` follows plan 03's rules over the store. `issue` writes a `StepUp` row (`id: newId("stepup")`, `expiresAt` = now + ttl, `codeHash: "test:" + code`) with codes `100001`, `100002`, … and records it in `issued` and `lastCode`. `confirm` is true only for a live (unconsumed, unexpired) row and the matching code; a wrong code on a live row adds one to `failures`. `consume` needs a prior true `confirm` and sets `consumedAt`.

- [ ] **Step 1: Write the helper and the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "../../src/auth/actor.js";
import { mayRun } from "../../src/commands/executor.js";
import { refusalCode } from "../../src/commands/gate.js";
import { registerCommand } from "../../src/commands/registry.js";
import { makeCommandWorld, type CommandWorld } from "../helpers/commands.js";

let w: CommandWorld;
beforeEach(async () => { w = await makeCommandWorld(); });
const run = async (actor: Actor, argv: string[], roomId?: string) => w.executor.execute(await w.ctx(actor, roomId), argv);

describe("authority", () => {
  it("lets humans, the host and the chief of staff run commands, and no agent", () => {
    for (const a of [w.actors.phone, w.actors.host, w.actors.cos]) expect(mayRun(a)).toBe(true);
    for (const a of [w.actors.workerA, w.actors.instA, { kind: "instance", instanceId: "inst-a" } as Actor]) expect(mayRun(a)).toBe(false);
  });
  it("refuses every command from an agent, queries included, and runs nothing", async () => {
    for (const argv of [["help"], ["say", "room-a", "hi"], ["db", "reset"]]) expect(refusalCode(await run(w.actors.workerA, argv, w.roomOf("inst-a")))).toBe("forbidden");
    expect(refusalCode(await run({ kind: "instance", instanceId: "inst-a" }, ["help"], w.roomOf("inst-a")))).toBe("forbidden");
    expect(w.ran).toEqual([]);
  });
});

describe("gates", () => {
  it("answers an unknown command with not_found", async () => {
    expect(refusalCode(await run(w.actors.phone, ["frobnicate"]))).toBe("not_found");
  });
  it("refuses everyone but the host during lockdown", async () => {
    w.lockdown.engaged = true;
    expect(refusalCode(await run(w.actors.phone, ["help"]))).toBe("lockdown");
    expect(refusalCode(await run(w.actors.cos, ["help"]))).toBe("lockdown");
    expect(await run(w.actors.host, ["help"])).toMatchObject({ ok: true });
  });
  it("refuses a session that is cooling down, and only that session", async () => {
    await w.store.sessions.patch("sess-phone", { cooldownUntil: "2026-10-25T10:10:00.000Z" });
    expect(await run(w.actors.phone, ["help"])).toMatchObject({ ok: false, data: { code: "cooldown", cooldownUntil: "2026-10-25T10:10:00.000Z" } });
    expect(await run(w.actors.laptop, ["help"])).toMatchObject({ ok: true });
  });
  it("refuses bad arguments with the command's usage", async () => {
    const r = await run(w.actors.phone, ["say"]);
    expect(refusalCode(r)).toBe("bad_request");
    expect(r.text.startsWith("Usage: ")).toBe(true);
    expect(refusalCode(await run(w.actors.phone, ["say", "room-a", "hi", "--loud"]))).toBe("bad_request");
  });
  it("consults the limit gate with the parsed arguments before running, and passes on its refusal", async () => {
    w.gate.verdict = { ok: false, code: "limit", text: "limit dispatches_per_hour: 6 of 6", data: { limit: "dispatches_per_hour" } };
    expect(await run(w.actors.phone, ["dispatch", "board-a", "42"])).toEqual({ ok: false, text: "limit dispatches_per_hour: 6 of 6", data: { limit: "dispatches_per_hour", code: "limit" } });
    expect(w.gate.inputs[0]).toMatchObject({ spec: { name: "dispatch" }, command: { name: "dispatch" }, actor: w.actors.phone, roomId: w.cosRoomId,
      args: { board: "board-a", card: "42" }, argv: ["dispatch", "board-a", "42"], stepupSupplied: false });
    expect(w.ran).toEqual([]);
  });
});

describe("running and the audit log", () => {
  it("runs the command and leaves the command message and its system reply in the room", async () => {
    const r = await run(w.actors.phone, ["/say", "room-a", "hello", "there"]);
    expect(r).toEqual({ ok: true, text: "said hello there" });
    const [cmd, reply] = (await w.messagesIn(w.cosRoomId)).slice(-2);
    expect(cmd).toMatchObject({ kind: "command", fromId: "owner", fromKind: "human", body: "/say room-a hello there" });
    expect(JSON.parse(cmd.dataJson!)).toEqual({ argv: ["say", "room-a", "hello", "there"], result: r });
    expect(JSON.parse(cmd.provenanceJson)).toEqual({ source: "owner", sessionId: "sess-phone", deviceId: "dev-phone", address: "203.0.113.7" });
    expect(reply).toMatchObject({ kind: "system", fromKind: "system", body: "said hello there", replyTo: cmd.id });
    expect(w.push.sent).toEqual([]);
  });
  it("audits refusals too", async () => {
    await run(w.actors.workerA, ["help"], w.roomOf("inst-a"));
    const [cmd, reply] = (await w.messagesIn(w.roomOf("inst-a"))).slice(-2);
    expect(cmd).toMatchObject({ kind: "command", fromId: "part-worker-a" });
    expect(JSON.parse(cmd.dataJson!).result).toMatchObject({ ok: false, data: { code: "forbidden" } });
    expect(reply).toMatchObject({ kind: "system", body: "Agents cannot run commands." });
  });
  it("redacts secrets in the audited argv", async () => {
    const ghp = "ghp_" + "a".repeat(36);
    await run(w.actors.phone, ["say", "room-a", ghp]);
    expect(JSON.stringify(await w.messagesIn(w.cosRoomId))).not.toContain(ghp);
  });
  it("turns a handler that throws into a failed result, logged and audited", async () => {
    expect(await run(w.actors.phone, ["instances"])).toEqual({ ok: false, text: "/instances failed: store exploded: Bearer [redacted]" });
    expect(w.log.errors()).toContain("command failed");
    expect((await w.messagesIn(w.cosRoomId)).at(-1)!.body).toBe("/instances failed: store exploded: Bearer [redacted]");
  });
  it("reads the registry on every call, so a command registered later is found", async () => {
    registerCommand({ name: "doctor", kind: "operating", summary: "doctor: check the brain", args: z.object({}), run: async () => ({ ok: true, text: "healthy" }) }, w.commands);
    expect(await run(w.actors.phone, ["doctor"])).toEqual({ ok: true, text: "healthy" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/commands/executor.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/commands/executor.js"`.

- [ ] **Step 3: Implement `execute`'s gates, run and audit**

In this order; each refusal is a `refuse(...)` result that still goes to the audit step:
1. `argv = normalizeArgv(argv)`, `{ name, rest } = parseCommand(argv)`, and the spec found by name in `deps.commands ?? COMMANDS`. With no spec: `not_found`, `Unknown command "/<name>". GET /api/commands lists them.`
2. `lockdown.active()` and the actor is not the host: `lockdown`, `The brain is in lockdown; only the host can act.`
3. `!mayRun(actor)`: `forbidden`, `Agents cannot run commands.`
4. `tripwires.cooling(actor)` is a date: `cooldown`, `Commands from this session are paused until <ISO>.`, with `{ cooldownUntil: <ISO> }`.
5. `spec.args.safeParse(argvToArgs(spec, rest))`. A `CommandArgsError` or a failed parse is `bad_request`, `Usage: /<summary>`.
6. `limits.checkCommand({ ctx, spec, command: spec, actor, roomId, args, argv, stepupSupplied: stepup !== undefined })`. A refusal passes through as `refuse(code, text, data)`.
7. The step-up for standing commands (Task 9). Until Task 9 lands, a standing command goes straight on to step 8.
8. `spec.run(ctx, args)`. A throw is logged as `log.error("command failed", { command: name, error })` and becomes `{ ok: false, text: "/<name> failed: <first line of the message, redacted>" }`.
9. The audit. Post a `command` message in `ctx.roomId` from `participants.refFor(actor)`, with body `/<argv joined by spaces>`, data `{ argv, result }` and the context's provenance. Then post a `system` reply from `SYSTEM_REF` with the result text as its body, `replyTo` the command message, data `{ ok, code, to: [] }` (an empty `to` pushes nobody) and provenance `{ source: "system" }`. Return the result.

Build `Participants` and `Rooms` from the context (`ctx.store`, `ctx.clock`, `ctx.config.owners`, `ctx.messaging`) when needed. `openRoom` serialises, so building them per call is safe.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/commands/executor.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/commands/executor.ts packages/os/tests/helpers/commands.ts packages/os/tests/commands/executor.test.ts
git commit -m "feat(os): command executor with authority, lockdown, cool-down, limits and a room audit log"
```

---

### Task 9: The executor: step-up for standing commands

**Files:**
- Modify: `packages/os/src/commands/executor.ts`
- Test: `packages/os/tests/commands/stepup.test.ts`

**Interfaces:**
- Consumes: Task 8; plan 03's `stepUpAudience(requesterDeviceId: string | null)` and `COS_SESSION_ID` (`packages/os/src/auth/`), and its `StepUps` rules: `confirm(stepUpId, code, by)` is true for the right code on a live row when `by` may present it (the requesting session itself, the host, a confirmer device); `consume` needs that confirmation.
- Produces:

```ts
// on CommandExecutor
executeConfirmed(ctx: CommandContext, argv: string[]): Promise<CommandResult>;   // execute without the step-up gate, for a step-up plan 03's confirmStanding already confirmed and consumed; mountMessaging makes it the StandingRunners fallback
```

The step-up gate sits between the limit gate and the run, for `spec.kind === "standing"`. The requester's step-up session is the human's `sessionId`, `"host"` for the host, and plan 03's `COS_SESSION_ID` for the chief of staff.
- **No `stepup` given:**
  1. `stepUps.issue(session, argv)`, then read the row for `expiresAt`.
  2. Publish `{ type: "stepup", payload: { stepUpId, command: argv, expiresAt, code } }` to `stepUpAudience(<the human's deviceId, else null>)`.
  3. Call `tripwires.announce("stepup_requested", actor, argv)`.
  4. Return `refuse("stepup_required", "/<name> changes what the system can do. Send it again with the code shown on the host or on another confirmer device, within <stepup_ttl_seconds> seconds.", { stepUpId, expiresAt })`. No failure is counted.
- **`stepup` given:**
  - The chief of staff is refused with `forbidden`, `The chief of staff cannot supply a step-up code.`
  - A row that is missing, belongs to another session, names another argv (`stepUpCommand(row)`), is consumed or is expired is refused with `stepup_failed`, `That step-up has expired or does not belong to this command; send the command again for a new code.` No failure is counted.
  - A false `confirm` calls `tripwires.record("stepup_failed", actor)`:
    - If it says `notifyOwners`, post its cool-down notice to the system room.
    - If it returns a new `cooldownUntil`, publish `{ type: "cooldown", payload: { cooldownUntil } }` to that session only.
    - Refuse with `stepup_failed`, `That step-up code is wrong.`, and include `{ cooldownUntil }` when it is set.
  - A true `confirm` calls `consume` and runs the command.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, expect, it } from "vitest";
import type { Actor } from "../../src/auth/actor.js";
import { refusalCode } from "../../src/commands/gate.js";
import { makeCommandWorld, type CommandWorld } from "../helpers/commands.js";
import { SUB } from "../helpers/world.js";

let w: CommandWorld;
beforeEach(async () => { w = await makeCommandWorld(); });
const run = async (actor: Actor, argv: string[], stepup?: { stepUpId: string; code: string }) => w.executor.execute(await w.ctx(actor), argv, stepup);
const REGISTER = ["register", "board-b", "/path/to/project-b"];
const stepups = () => w.hub.published.filter((e) => e.type === "stepup");
const idOf = (r: { data?: unknown }) => (r.data as { stepUpId: string }).stepUpId;

it("refuses a standing command from a valid session without a step-up code: stepup_required, code to confirmers only, request announced", async () => {
  const r = await run(w.actors.phone, REGISTER);
  expect(r).toMatchObject({ ok: false, data: { code: "stepup_required", expiresAt: "2026-10-25T10:02:00.000Z" } });
  const code = w.stepUps.lastCode!;
  expect(JSON.stringify(r)).not.toContain(code);
  const [e] = stepups();
  expect(e.payload).toEqual({ stepUpId: idOf(r), command: REGISTER, expiresAt: "2026-10-25T10:02:00.000Z", code });
  expect([w.actors.laptop, w.actors.other, w.actors.host].map(e.visibleTo)).toEqual([true, true, true]);
  expect([w.actors.phone, w.actors.cos, w.actors.workerA].map(e.visibleTo)).toEqual([false, false, false]);
  expect((await w.messagesIn(w.systemRoomId)).map((m) => m.body)).toContain('Step-up requested for "register board-b /path/to/project-b" by owner on "phone" from 203.0.113.7. The code is shown only on the host or a confirmer device. If this was not you, revoke the device or run "swarm os lockdown" on the host.');
  expect(w.push.endpoints()).toEqual([SUB("dev-laptop"), SUB("dev-other"), SUB("dev-phone")].map((s) => s.endpoint));
  expect(JSON.stringify([await w.store.messages.find({}), w.log.entries])).not.toContain(code);
  expect(await w.tripwires.cooling(w.actors.phone)).toBeNull();
  expect(w.ran).toEqual([]);
});
it("the second wrong code cools the session down and tells every owner", async () => {
  const stepUpId = idOf(await run(w.actors.phone, REGISTER));
  expect(refusalCode(await run(w.actors.phone, REGISTER, { stepUpId, code: "000000" }))).toBe("stepup_failed");
  expect(await w.tripwires.cooling(w.actors.phone)).toBeNull();
  expect(await run(w.actors.phone, REGISTER, { stepUpId, code: "000000" })).toMatchObject({ ok: false, data: { code: "stepup_failed", cooldownUntil: "2026-10-25T10:10:00.000Z" } });
  expect((await w.store.sessions.get("sess-phone"))!.cooldownUntil).toBe("2026-10-25T10:10:00.000Z");
  expect((await w.messagesIn(w.systemRoomId)).some((m) => m.kind === "system" && m.body.startsWith("Cool-down until 10:10 UTC: session sess-phone"))).toBe(true);
  const cooldown = w.hub.published.filter((e) => e.type === "cooldown");
  expect(cooldown.map((e) => e.payload)).toEqual([{ cooldownUntil: "2026-10-25T10:10:00.000Z" }]);
  expect([w.actors.phone, w.actors.laptop].map(cooldown[0].visibleTo)).toEqual([true, false]);
  expect(refusalCode(await run(w.actors.phone, ["help"]))).toBe("cooldown");
  expect(w.ran).toEqual([]);
});
it("runs the command once when the right code comes back within two minutes", async () => {
  const stepUpId = idOf(await run(w.actors.phone, REGISTER));
  const code = w.stepUps.lastCode!;
  w.clock.advance(90_000);
  expect(await run(w.actors.phone, REGISTER, { stepUpId, code })).toEqual({ ok: true, text: "registered board-b" });
  expect(w.ran).toEqual([{ name: "register", args: { board: "board-b", path: "/path/to/project-b" }, actor: w.actors.phone }]);
  expect((await w.store.stepUps.get(stepUpId))!.consumedAt).toBe("2026-10-25T10:01:30.000Z");
  expect(refusalCode(await run(w.actors.phone, REGISTER, { stepUpId, code }))).toBe("stepup_failed");
  expect(w.ran).toHaveLength(1);
});
it("refuses a code for another command, another session's step-up and an expired code, without counting a failure", async () => {
  const stepUpId = idOf(await run(w.actors.phone, REGISTER));
  const code = w.stepUps.lastCode!;
  expect(refusalCode(await run(w.actors.phone, ["register", "board-c", "/path/to/project-c"], { stepUpId, code }))).toBe("stepup_failed");
  expect(refusalCode(await run(w.actors.laptop, REGISTER, { stepUpId, code }))).toBe("stepup_failed");
  w.clock.advance(121_000);
  expect(refusalCode(await run(w.actors.phone, REGISTER, { stepUpId, code }))).toBe("stepup_failed");
  expect((await w.messagesIn(w.systemRoomId)).filter((m) => m.body === "tripwire stepup_failed")).toEqual([]);
  expect(w.ran).toEqual([]);
});
it("makes the host confirm its own standing command too", async () => {
  const r = await run(w.actors.host, ["db", "reset"]);
  expect(refusalCode(r)).toBe("stepup_required");
  expect(stepups()[0].visibleTo(w.actors.host)).toBe(true);
  expect(await run(w.actors.host, ["db", "reset"], { stepUpId: idOf(r), code: w.stepUps.lastCode! })).toEqual({ ok: true, text: "reset" });
});
it("lets the chief of staff request a standing command but never complete it", async () => {
  const r = await run(w.actors.cos, REGISTER);
  expect(refusalCode(r)).toBe("stepup_required");
  expect(w.stepUps.issued.at(-1)).toMatchObject({ sessionId: "cos", command: REGISTER });
  expect([w.actors.phone, w.actors.laptop].map(stepups()[0].visibleTo)).toEqual([false, true]);
  expect(refusalCode(await run(w.actors.cos, REGISTER, { stepUpId: idOf(r), code: w.stepUps.lastCode! }))).toBe("forbidden");
  expect(w.ran).toEqual([]);
});
it("executeConfirmed runs a standing command plan 03 already confirmed, still behind authority", async () => {
  expect(await w.executor.executeConfirmed(await w.ctx(w.actors.phone, w.systemRoomId), REGISTER)).toEqual({ ok: true, text: "registered board-b" });
  expect(stepups()).toEqual([]);
  expect(refusalCode(await w.executor.executeConfirmed(await w.ctx(w.actors.workerA, w.systemRoomId), REGISTER))).toBe("forbidden");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/commands/stepup.test.ts`
Expected: FAIL. The first test gets `{ ok: true, text: "registered board-b" }` where it expects `stepup_required`, and `executeConfirmed` is not a function.

- [ ] **Step 3: Implement the step-up gate and `executeConfirmed` as the Interfaces block describes**

`executeConfirmed` shares `execute`'s pipeline with step 7 skipped. Give the pipeline a private flag rather than a second copy.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/commands/stepup.test.ts tests/commands/executor.test.ts`
Expected: PASS, 7 and 12 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/commands/executor.ts packages/os/tests/commands/stepup.test.ts
git commit -m "feat(os): step-up for standing commands, code only to confirmers, cool-down on the second wrong code"
```

---

### Task 10: Built-in commands

**Files:**
- Create: `packages/os/src/commands/builtin.ts`
- Modify: `packages/os/tests/helpers/commands.ts` (`makeCommandWorld({ builtins: true })` fills `commands` with the built-ins only)
- Test: `packages/os/tests/commands/builtin.test.ts`

**Interfaces:**
- Consumes: Task 7's registry and peer types (`ResourceSnapshot`); `mayRun` (Task 8); `Participants`, `Rooms` (Task 6); `Messaging`, `LIVE_INSTANCE_STATES` (Tasks 4 and 5); plan 02's `readJson`, rows.
- Produces:

```ts
export const BUILTIN_COMMANDS: readonly string[];                        // ["top", "rooms", "instances", "why", "help", "answer", "say"]
export function registerBuiltinCommands(into?: CommandSpec<any>[]): void;   // into defaults to COMMANDS; skips names already in `into`; help lists `into` when it runs
```

| name | kind | `args` | `summary` |
|------|------|--------|-----------|
| `top` | query | `{}` | `top: resources and live instances` |
| `rooms` | query | `{}` | `rooms: the rooms you can see` |
| `instances` | query | `{}` | `instances: the newest 20 instances` |
| `why` | query | `{ board: z.string(), card: z.string() }` | `why <board> <card>: the checks behind a card's last decision` |
| `help` | query | `{}` | `help: the commands you can run` |
| `answer` | operating | `{ question: z.string(), text: z.array(z.string()).min(1) }` | `answer <question> <text>: answer a worker's question` |
| `say` | operating | `{ room: z.string(), text: z.array(z.string()).min(1) }` | `say <room> <text>: post a message to a room` |

The `text` words are joined with single spaces.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "../../src/auth/actor.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { registerCommand } from "../../src/commands/registry.js";
import { toJson, type InstanceRow } from "../../src/store/rows.js";
import { makeRow } from "../../src/testing/index.js";
import { makeCommandWorld, type CommandWorld } from "../helpers/commands.js";

let w: CommandWorld;
beforeEach(async () => { w = await makeCommandWorld({ builtins: true }); });
const run = async (actor: Actor, argv: string[]) => w.executor.execute(await w.ctx(actor), argv);
const snap = (at: string, cpuLoad1: number) => toJson({ host: "local", at, cpuLoad1, cpus: 8, memFreeMb: 4096, memTotalMb: 16384, instancesRunning: 1, claudeSessions: 2, portsInUse: [], tokensThisHour: {} });
const askA = () => w.messaging.ask({ roomId: w.roomOf("inst-a"), from: w.refs.workerA, instanceId: "inst-a", sessionId: "sess-worker-a", body: "Which database?" });

it("registers the seven built-ins once, with the table's kinds", () => {
  expect(w.commands.map((c) => [c.name, c.kind])).toEqual([["top", "query"], ["rooms", "query"], ["instances", "query"], ["why", "query"], ["help", "query"], ["answer", "operating"], ["say", "operating"]]);
  registerBuiltinCommands(w.commands);
  expect(w.commands).toHaveLength(7);
});
it("top shows the newest resource snapshot and each live instance", async () => {
  await w.store.resources.put(makeRow("resources", { host: "local", at: "2026-10-25T09:59:00.000Z", snapshotJson: snap("2026-10-25T09:59:00.000Z", 0.9) }));
  await w.store.resources.put(makeRow("resources", { host: "local", at: "2026-10-25T09:59:45.000Z", snapshotJson: snap("2026-10-25T09:59:45.000Z", 0.5) }));
  await w.store.instances.patch("inst-b", { state: "exited" });
  const r = await run(w.actors.phone, ["top"]);
  expect(r.text.split("\n")).toEqual([
    "local: load 0.50 on 8 CPUs, 4096 of 16384 MB free, 1 instance, 2 Claude sessions",
    "inst-a  board-a:42  project-a  running  1200 tokens  5m  heartbeat 10s ago",
    "inst-p  board-p:7  project-p  running  0 tokens  0m  no heartbeat",
  ]);
  const data = r.data as { snapshot: { cpuLoad1: number }; instances: InstanceRow[] };
  expect(data.snapshot.cpuLoad1).toBe(0.5);
  expect(data.instances.map((i) => [i.id, i.tokenHash])).toEqual([["inst-a", ""], ["inst-p", ""]]);
});
it("top says so when there is no snapshot and nothing running", async () => {
  for (const id of ["inst-a", "inst-b", "inst-p"]) await w.store.instances.patch(id, { state: "exited" });
  expect((await run(w.actors.phone, ["top"])).text).toBe("No resource snapshot yet.\nNo instances running.");
});
it("rooms and instances list what the caller can see", async () => {
  expect((await run(w.actors.cos, ["rooms"])).text.split("\n")).toContain(`${w.roomOf("inst-a")}  instance  board-a#42`);
  expect((await run(w.actors.phone, ["instances"])).text.split("\n")).toEqual([
    "inst-b  board-a:43  running  started 2026-10-25T10:00:00.000Z",
    "inst-p  board-p:7  running  started 2026-10-25T10:00:00.000Z",
    "inst-a  board-a:42  running  started 2026-10-25T09:55:00.000Z",
  ]);
});
it("why explains a card's last decision with each check", async () => {
  await w.store.decisions.put(makeRow("decisions", { boardId: "board-a", cardId: "42", cardVersion: "v1", outcome: "dispatch", decidedAt: "2026-10-25T09:00:00.000Z", decidedBy: "policy", reason: null, checksJson: "[]" }));
  await w.store.decisions.put(makeRow("decisions", { boardId: "board-a", cardId: "42", cardVersion: "v2", outcome: "hold", decidedAt: "2026-10-25T09:30:00.000Z", decidedBy: "policy", reason: "queue below min_cards",
    checksJson: toJson({ checks: [{ name: "known_board", passed: true, detail: "registered" }, { name: "queue_depth", passed: false, detail: "2 of 3 cards" }], card: null, sticky: null, override: null, readiness: null }) }));
  const r = await run(w.actors.phone, ["why", "board-a", "42"]);
  expect(r.text.split("\n")).toEqual(["board-a:42 hold (decided 2026-10-25T09:30:00.000Z by policy): queue below min_cards", "pass known_board: registered", "FAIL queue_depth: 2 of 3 cards"]);
  expect(await run(w.actors.phone, ["why", "board-z", "1"])).toEqual({ ok: false, text: "No board named board-z." });
  expect(await run(w.actors.phone, ["why", "board-a", "7"])).toMatchObject({ ok: true, text: "No decision recorded for board-a:7." });
});
it("help lists the commands the caller can run, read when it runs", async () => {
  registerCommand({ name: "doctor", kind: "operating", summary: "doctor: check the brain", args: z.object({}), run: async () => ({ ok: true, text: "ok" }) }, w.commands);
  expect((await run(w.actors.phone, ["help"])).text.split("\n")).toEqual(["/answer <question> <text>: answer a worker's question", "/doctor: check the brain",
    "/help: the commands you can run", "/instances: the newest 20 instances", "/rooms: the rooms you can see", "/say <room> <text>: post a message to a room",
    "/top: resources and live instances", "/why <board> <card>: the checks behind a card's last decision"]);
});
it("answer answers a question as the caller, and says when the answer is late", async () => {
  const q = await askA();
  expect(await run(w.actors.phone, ["answer", q.id, "Use", "Postgres"])).toEqual({ ok: true, text: `Answered ${q.id}.`, data: { questionId: q.id, late: false } });
  expect(await w.store.messages.get((await w.store.questions.get(q.id))!.answerMessageId!)).toMatchObject({ body: "Use Postgres", fromId: "owner" });
  expect(await run(w.actors.cos, ["answer", q.id, "Redis"])).toEqual({ ok: true, text: `Answered ${q.id}; the worker had already moved on, so the answer is recorded as late.`, data: { questionId: q.id, late: true } });
  expect(await run(w.actors.phone, ["answer", "q-missing", "x"])).toEqual({ ok: false, text: "No question q-missing." });
});
it("say posts to a room by name or id as the caller", async () => {
  const board = await w.rooms.boardRoom((await w.store.boards.get("board-a"))!);
  expect(await run(w.actors.phone, ["say", "board-a", "taking", "a", "look"])).toMatchObject({ ok: true, text: "Posted to board-a." });
  expect((await w.messagesIn(board.id)).at(-1)).toMatchObject({ kind: "text", body: "taking a look", fromId: "owner" });
  expect(await run(w.actors.phone, ["say", board.id, "again"])).toMatchObject({ ok: true });
  expect(await run(w.actors.phone, ["say", "room-nope", "hi"])).toEqual({ ok: false, text: "No room room-nope." });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/commands/builtin.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/commands/builtin.js"`.

- [ ] **Step 3: Implement `builtin.ts`**

- `top`. The first line comes from the newest `ResourceSnapshotRow` by `at`: `<host>: load <cpuLoad1, two decimals> on <cpus> CPUs, <memFreeMb> of <memTotalMb> MB free, <n> instance(s), <n> Claude session(s)`, read with `readJson` and the overview's `ResourceSnapshot` fields. With no snapshot it is `No resource snapshot yet.` Then come the instances in `LIVE_INSTANCE_STATES`, oldest start first (id breaks ties), each as `<id>  <board name>:<card>  <projectName>  <state>  <tokens> tokens  <elapsed>  <heartbeat>`. `<elapsed>` is `<m>m`, or `<h>h<mm>m` from an hour on. `<heartbeat>` is `heartbeat <s>s ago` or `no heartbeat`. With none it is `No instances running.` The data is `{ snapshot, instances }`, with every `tokenHash` set to `""`, as plan 04 publishes instances.
- `rooms`: `<id>  <kind>  <name>`, plus `  (closed)` for a closed room, over `messaging.visibleRooms(actor)`.
- `instances`: the newest 20 by `startedAt`, latest first (id breaks ties): `<id>  <board name>:<card>  <state>  started <startedAt>`.
- `why`. Find the board by id, then by name, then by `externalId`. Take the decision for `(board.id, card)` with the latest `decidedAt`. `checksJson` is either a check array or plan 04's record `{ checks, … }`; read both. The first line is `<board name>:<card> <outcome> (decided <decidedAt> by <decidedBy>)`, plus `: <reason>` when there is one. Each check line is `pass <name>: <detail>` or `FAIL <name>: <detail>`.
- `help`: `/<summary>` for every spec in `into` the actor `mayRun`, sorted by name; data `{ commands: [{ name, kind, summary }] }`.
- `answer`: `messaging.answer(question, participants.refFor(actor), text, ctx.provenance)`. `question_not_found` becomes `{ ok: false, text: "No question <id>." }`.
- `say`: a room in `visibleRooms(actor)` by id, else by name. The post is `text` from `refFor(actor)` with the context's provenance. `{ ok: false, text: "No room <room>." }` when there is none.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/commands/builtin.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/commands/builtin.ts packages/os/tests/helpers/commands.ts packages/os/tests/commands/builtin.test.ts
git commit -m "feat(os): built-in top, rooms, instances, why, help, answer and say commands"
```

---

### Task 11: Human routes: rooms, messages, answers and push subscriptions

**Files:**
- Create: `packages/os/src/messaging/routes.ts`
- Create: `packages/os/tests/helpers/routes.ts`
- Test: `packages/os/tests/messaging/routes.test.ts`

**Interfaces:**
- Consumes: plan 03's `ApiRequest`, `Handler`, `ApiError`, `parseBody` (`packages/os/src/api/`) and `Actor`; Tasks 3 to 9.
- Produces:

```ts
export interface RouteDef { method: "GET" | "POST" | "DELETE"; path: string; auth: Array<Actor["kind"]>; idempotent?: true; handler: Handler }
export interface MessagingRouteDeps {
  store: OsStore; messaging: Messaging; participants: Participants; rooms: Rooms; executor: CommandExecutor; config: OsConfig; clock: Clock;
  runtime: () => CommandRuntime; commands?: CommandSpec<any>[]; log?: Logger; longPollMs?: number;   // longPollMs defaults to OS_QUESTION_LONG_POLL_MS
}
export function messagingRoutes(deps: MessagingRouteDeps): RouteDef[];
export function contextFor(deps: MessagingRouteDeps, actor: Actor, roomId: string): Promise<CommandContext>;   // provenance from participants.provenanceFor; dispatcher and launcher from runtime()
```

| Route | `auth` | Body or query | 200 body |
|-------|--------|---------------|----------|
| `GET /api/rooms` | human, host | | `RoomRow[]` from `visibleRooms` |
| `GET /api/rooms/:id/messages` | human, host | `beforeSeq?`, `limit?` (integer 1 to 200, default 50) | `MessageRow[]`, the newest `limit` with `seq < beforeSeq`, in `seq` order |
| `POST /api/rooms/:id/messages` | human, host; `idempotent` | `{ kind: "text", body: 1..16000 chars, replyTo?: string }` | the stored `MessageRow` |
| `POST /api/questions/:id/answer` | human, host, cos | `{ body: 1..16000 chars }` | `{ question, late }` |
| `POST /api/push/subscribe` | human | `{ subscription }` | `{ ok: true }` |
| `DELETE /api/push/subscribe` | human | | `{ ok: true }` |

These errors are thrown as `ApiError`, and plan 03's router renders them:
- a room the actor cannot see (`not_found`);
- an unknown question (`not_found`);
- `MessagingError("forbidden")` (`forbidden`);
- a bad query or a `PushError` (`bad_request`).

A bad body comes from `parseBody`. `Repo.find` has no range filter, so `beforeSeq` and `limit` are applied in memory over `messages.find({ roomId }, { orderBy: "seq" })`.

- [ ] **Step 1: Write the route-call helper and the failing test**

`tests/helpers/routes.ts` exports `routeCaller(routes: RouteDef[])`, which returns `(method, path, actor, o?: { params?, query?, body? }) => Promise<unknown>`. It finds the route by method and path template and calls its handler with `{ actor, params, query: new URLSearchParams(query), body, headers: {} }`, cast to `ApiRequest`. It also exports `routeDeps(w: CommandWorld, o?: { longPollMs?: number })`, which builds `MessagingRouteDeps` from the world with `runtime: () => ({ dispatcher: {} as never, launcher: {} as never })` and `commands: w.commands`.

```ts
import { beforeEach, expect, it } from "vitest";
import { messagingRoutes } from "../../src/messaging/routes.js";
import type { MessageRow, RoomRow } from "../../src/store/rows.js";
import { makeCommandWorld, type CommandWorld } from "../helpers/commands.js";
import { routeCaller, routeDeps } from "../helpers/routes.js";
import { SUB } from "../helpers/world.js";

let w: CommandWorld; let call: ReturnType<typeof routeCaller>;
beforeEach(async () => { w = await makeCommandWorld(); call = routeCaller(messagingRoutes(routeDeps(w))); });

it("GET /api/rooms returns the caller's visible rooms as a bare array", async () => {
  const rooms = (await call("GET", "/api/rooms", w.actors.phone)) as RoomRow[];
  expect(rooms.map((r) => r.id).sort()).toEqual((await w.store.rooms.find({})).map((r) => r.id).sort());
});
it("GET /api/rooms/:id/messages pages by beforeSeq in seq order", async () => {
  const room = w.roomOf("inst-b");
  for (const body of ["m1", "m2", "m3", "m4", "m5"]) await w.messaging.post({ roomId: room, from: w.refs.workerB, kind: "text", body, provenance: { source: "worker" } });
  const page = (query: Record<string, string>) => call("GET", "/api/rooms/:id/messages", w.actors.phone, { params: { id: room }, query }) as Promise<MessageRow[]>;
  expect((await page({ limit: "2" })).map((m) => m.body)).toEqual(["m4", "m5"]);
  const all = await page({});
  expect((await page({ beforeSeq: String(all[3].seq), limit: "2" })).map((m) => m.body)).toEqual(["m2", "m3"]);
  await expect(page({ limit: "500" })).rejects.toMatchObject({ code: "bad_request" });
  await expect(call("GET", "/api/rooms/:id/messages", w.actors.phone, { params: { id: "room-missing" } })).rejects.toMatchObject({ code: "not_found" });
});
it("POST /api/rooms/:id/messages posts text as the caller with its session's provenance, and never runs it", async () => {
  const m = (await call("POST", "/api/rooms/:id/messages", w.actors.phone, { params: { id: w.cosRoomId }, body: { kind: "text", body: "/db reset" } })) as MessageRow;
  expect(m).toMatchObject({ kind: "text", body: "/db reset", fromId: "owner", fromKind: "human", roomId: w.cosRoomId });
  expect(JSON.parse(m.provenanceJson)).toEqual({ source: "owner", sessionId: "sess-phone", deviceId: "dev-phone", address: "203.0.113.7" });
  expect([w.ran, w.stepUps.issued]).toEqual([[], []]);
  await expect(call("POST", "/api/rooms/:id/messages", w.actors.phone, { params: { id: w.cosRoomId }, body: { kind: "answer", body: "x" } })).rejects.toMatchObject({ code: "bad_request" });
});
it("POST /api/questions/:id/answer answers as the caller and reports a late answer", async () => {
  const q = await w.messaging.ask({ roomId: w.roomOf("inst-a"), from: w.refs.workerA, instanceId: "inst-a", sessionId: "sess-worker-a", body: "Which database?" });
  expect(await call("POST", "/api/questions/:id/answer", w.actors.phone, { params: { id: q.id }, body: { body: "Postgres" } })).toMatchObject({ question: { id: q.id, state: "answered" }, late: false });
  expect(await call("POST", "/api/questions/:id/answer", w.actors.laptop, { params: { id: q.id }, body: { body: "Redis" } })).toMatchObject({ late: true });
  await expect(call("POST", "/api/questions/:id/answer", w.actors.phone, { params: { id: "q-missing" }, body: { body: "x" } })).rejects.toMatchObject({ code: "not_found" });
});
it("push subscribe stores the subscription on the caller's device, and delete clears it", async () => {
  await expect(call("POST", "/api/push/subscribe", w.actors.phone, { body: { subscription: SUB("dev-phone-new") } })).resolves.toEqual({ ok: true });
  expect(JSON.parse((await w.store.devices.get("dev-phone"))!.pushSubscriptionJson!)).toEqual(SUB("dev-phone-new"));
  await expect(call("POST", "/api/push/subscribe", w.actors.phone, { body: { subscription: { endpoint: "http://push.example.invalid/x" } } })).rejects.toMatchObject({ code: "bad_request" });
  await expect(call("DELETE", "/api/push/subscribe", w.actors.phone)).resolves.toEqual({ ok: true });
  expect((await w.store.devices.get("dev-phone"))!.pushSubscriptionJson).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/routes.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/routes.js"`.

- [ ] **Step 3: Implement the six routes in `routes.ts` as the table describes**

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/routes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/routes.ts packages/os/tests/helpers/routes.ts packages/os/tests/messaging/routes.test.ts
git commit -m "feat(os): rooms, messages, answer and push-subscription routes"
```

---

### Task 12: Command routes

**Files:**
- Modify: `packages/os/src/messaging/routes.ts`
- Test: `packages/os/tests/messaging/command-routes.test.ts`

**Interfaces:**
- Consumes: Task 11's route table and helpers; `CommandExecutor` (Tasks 8 and 9); `refusalCode`, `mayRun`; plan 03's `ApiError`, whose status comes from `REFUSAL_STATUS`.
- Produces:

| Route | `auth` | Body | 200 body |
|-------|--------|------|----------|
| `POST /api/commands` | human, host; `idempotent` | `{ room: string, argv: string[] (1 to 64 items), stepUpId?: string, code?: string }` | the `CommandResult` |
| `GET /api/commands` | human, host | | `Array<{ name, kind, summary }>`: the commands registered when it is called, that the caller `mayRun`, sorted by name |

A refusal result is thrown as `new ApiError(code, result.text, <result.data without code>)`. Plan 03's router then renders it as `{ error: { code, message, ...extra } }` with `REFUSAL_STATUS[code]`. `stepUpId` and `code` travel together: one without the other is `bad_request`, `stepUpId and code go together.` A room the caller cannot see is `not_found`.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "../../src/auth/actor.js";
import { registerCommand } from "../../src/commands/registry.js";
import { messagingRoutes } from "../../src/messaging/routes.js";
import { makeCommandWorld, type CommandWorld } from "../helpers/commands.js";
import { routeCaller, routeDeps } from "../helpers/routes.js";

let w: CommandWorld; let call: ReturnType<typeof routeCaller>;
beforeEach(async () => { w = await makeCommandWorld(); call = routeCaller(messagingRoutes(routeDeps(w))); });
const command = (actor: Actor, body: unknown) => call("POST", "/api/commands", actor, { body });
const REGISTER = ["register", "board-b", "/path/to/project-b"];

it("answers 200 with the CommandResult", async () => {
  expect(await command(w.actors.phone, { room: w.cosRoomId, argv: ["help"] })).toEqual({ ok: true, text: "help text" });
});
it("answers 428 stepup_required with stepUpId and no code, then runs the command when stepUpId and code come back", async () => {
  const err = await command(w.actors.phone, { room: w.cosRoomId, argv: REGISTER }).catch((e) => e);
  expect(err).toMatchObject({ code: "stepup_required", status: 428, extra: { stepUpId: expect.any(String), expiresAt: "2026-10-25T10:02:00.000Z" } });
  expect(JSON.stringify({ message: err.message, extra: err.extra })).not.toContain(w.stepUps.lastCode!);
  expect(await command(w.actors.phone, { room: w.cosRoomId, argv: REGISTER, stepUpId: err.extra.stepUpId, code: w.stepUps.lastCode })).toEqual({ ok: true, text: "registered board-b" });
});
it("maps the other refusals to their statuses", async () => {
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: REGISTER, stepUpId: "stepup-missing", code: "000000" })).rejects.toMatchObject({ code: "stepup_failed", status: 403 });
  w.gate.verdict = { ok: false, code: "limit", text: "limit dispatches_per_hour: 6 of 6", data: { limit: "dispatches_per_hour" } };
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: ["dispatch", "board-a", "42"] })).rejects.toMatchObject({ code: "limit", status: 429, extra: { limit: "dispatches_per_hour" } });
  w.gate.verdict = { ok: false, code: "provenance_mismatch", text: "provenance does not match", data: { mismatch: ["address"] } };
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: ["help"] })).rejects.toMatchObject({ code: "provenance_mismatch", status: 403 });
  w.gate.verdict = { ok: true };
  await w.store.sessions.patch("sess-phone", { cooldownUntil: "2026-10-25T10:10:00.000Z" });
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: ["help"] })).rejects.toMatchObject({ code: "cooldown", status: 429, extra: { cooldownUntil: "2026-10-25T10:10:00.000Z" } });
  w.lockdown.engaged = true;
  await expect(command(w.actors.laptop, { room: w.cosRoomId, argv: ["help"] })).rejects.toMatchObject({ code: "lockdown", status: 403 });
});
it("refuses a bad body, half a step-up, a room the caller cannot see and an unknown command", async () => {
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: [] })).rejects.toMatchObject({ code: "bad_request" });
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: REGISTER, stepUpId: "stepup-1" })).rejects.toMatchObject({ code: "bad_request" });
  await expect(command(w.actors.phone, { room: "room-missing", argv: ["help"] })).rejects.toMatchObject({ code: "not_found", status: 404 });
  await expect(command(w.actors.phone, { room: w.cosRoomId, argv: ["frobnicate"] })).rejects.toMatchObject({ code: "not_found" });
});
it("GET /api/commands lists whatever is registered when it is called", async () => {
  const list = async (a: Actor) => (await call("GET", "/api/commands", a)) as Array<{ name: string; kind: string; summary: string }>;
  expect((await list(w.actors.phone)).map((c) => c.name)).toEqual(["db reset", "dispatch", "help", "instances", "register", "say"]);
  registerCommand({ name: "doctor", kind: "operating", summary: "doctor: check the brain", args: z.object({}), run: async () => ({ ok: true, text: "ok" }) }, w.commands);
  expect((await list(w.actors.phone)).map((c) => c.name)).toContain("doctor");
  expect((await list(w.actors.host)).find((c) => c.name === "register")).toEqual({ name: "register", kind: "standing", summary: "register" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/command-routes.test.ts`
Expected: FAIL, `no route POST /api/commands` from the route caller.

- [ ] **Step 3: Add the two routes to `messagingRoutes`, after the six from Task 11**

The POST handler builds the context with `contextFor(deps, actor, room)` and calls `deps.executor.execute(ctx, argv, stepup)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/command-routes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/routes.ts packages/os/tests/messaging/command-routes.test.ts
git commit -m "feat(os): command routes with the status-code contract and a live command list"
```

---

### Task 13: Room-token routes for the run's sessions

**Files:**
- Modify: `packages/os/src/messaging/routes.ts`
- Test: `packages/os/tests/messaging/room-routes.test.ts`

**Interfaces:**
- Consumes: plan 01's `SendBody`, `SendResponse`, `ReadResponse`, `RoomMessageView`, `AskBody`, `AskResponse`, `QuestionStatus`, `WhoResponse` and `OS_QUESTION_LONG_POLL_MS` (`@mnmal-ai/swarm-types`); `Messaging.onQuestion` (Task 5); `Rooms.directRoom`, `Participants`, `permissionsFor` (Task 6); `oneLine` (Task 3).
- Produces (all `auth: ["room"]`):

| Route | Body or query | 200 body |
|-------|---------------|----------|
| `POST /api/rooms/:id/send` | `SendBody`: `body` 1..16000 chars, `to?` a participant id | `SendResponse { messageId, seq }` |
| `GET /api/rooms/:id/read` | `sinceSeq?` (integer ≥ 0, default 0), `from?` | `ReadResponse`: at most 100 `RoomMessageView`s with `seq > sinceSeq` (and `fromId === from`), in `seq` order |
| `POST /api/rooms/:id/ask` | `AskBody`: `body` 1..16000 chars, `options?` up to 10 strings of 1..200 chars | `AskResponse { questionId }` |
| `GET /api/questions/:id` | | `QuestionStatus`, after waiting up to `longPollMs` for an open question to change |
| `GET /api/rooms/:id/who` | | `WhoResponse` |

Rules:
- **Scope.** `:id` must be a room the room actor can see (its own room, or a direct room that lists it), else `not_found`. `ask` takes only the actor's own room. A question is visible only to a room actor whose `instanceId` is the question's. The participant must have the route's permission (`send`, `read`, `ask_human`, `who`) by `permissionsFor(kind)`, else `forbidden`.
- **send.** The body is stored as `text` and never executed. With `to`, the message goes to `rooms.directRoom(actor.participantId, to)`. The target must be a human (an owner id counts, through `ensureHuman`), the chief of staff, or a participant of the same instance. Any other target is `forbidden`, and an unknown one is `not_found`.
- **ask.** `sessionId` is the participant's name (the run session id, as plan 04 names session participants), or `"run"` for the instance's own participant.
- **Long-poll.** Register the `onQuestion` listener first, then read the row, so that an answer landing in between is not missed. Answer as soon as the state is not `open`, or when `longPollMs` passes.
- **`QuestionStatus`.**
  - `answered`: `answer` is the answer message's body and `from` its `fromKind`.
  - `proceeded`: `proceededWith` is the row's, and `proceededSource` is `"precedent"` when it is non-null.
  - Every field that does not apply is `null`.
- **who.** The room's members, plus the participants with the actor's `instanceId`, sorted by id. Each is `{ id, kind, name, doing }`, where `doing` is `oneLine` of its latest message body in this room (80 characters), or `null`.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, expect, it } from "vitest";
import type { AskResponse, ReadResponse, SendResponse, WhoResponse } from "@mnmal-ai/swarm-types";
import { messagingRoutes } from "../../src/messaging/routes.js";
import { makeCommandWorld, type CommandWorld } from "../helpers/commands.js";
import { routeCaller, routeDeps } from "../helpers/routes.js";
import { SUB } from "../helpers/world.js";

let w: CommandWorld; let call: ReturnType<typeof routeCaller>;
beforeEach(async () => { w = await makeCommandWorld(); call = routeCaller(messagingRoutes(routeDeps(w, { longPollMs: 50 }))); });
const roomA = () => w.roomOf("inst-a");
const say = (body: string, from = w.refs.workerA) => w.messaging.post({ roomId: roomA(), from, kind: "text", body, provenance: { source: "worker" } });
const ask = async (body = "Which database?") => ((await call("POST", "/api/rooms/:id/ask", w.actors.workerA, { params: { id: roomA() }, body: { body } })) as AskResponse).questionId;

it("send posts the worker's text to its room and answers with the message id and seq", async () => {
  const r = (await call("POST", "/api/rooms/:id/send", w.actors.workerA, { params: { id: roomA() }, body: { body: "tests are green" } })) as SendResponse;
  expect(await w.store.messages.get(r.messageId)).toMatchObject({ roomId: roomA(), kind: "text", body: "tests are green", fromId: "part-worker-a", fromKind: "worker", seq: r.seq });
});
it("a worker's slash text stays text", async () => {
  await call("POST", "/api/rooms/:id/send", w.actors.workerA, { params: { id: roomA() }, body: { body: "/stop run inst-a" } });
  expect((await w.messagesIn(roomA())).at(-1)).toMatchObject({ kind: "text", body: "/stop run inst-a" });
  expect([w.ran, await w.store.messages.find({ kind: "command" })]).toEqual([[], []]);
});
it("send with to opens the direct room with a human, and refuses a participant of another run", async () => {
  const r = (await call("POST", "/api/rooms/:id/send", w.actors.workerA, { params: { id: roomA() }, body: { body: "a quick question", to: "owner" } })) as SendResponse;
  const m = (await w.store.messages.get(r.messageId))!;
  expect(await w.store.rooms.get(m.roomId)).toMatchObject({ kind: "direct", subjectId: "owner|part-worker-a" });
  expect(w.push.endpoints()).toEqual([SUB("dev-laptop").endpoint, SUB("dev-phone").endpoint]);
  await expect(call("POST", "/api/rooms/:id/send", w.actors.workerA, { params: { id: roomA() }, body: { body: "hi", to: "part-worker-b" } })).rejects.toMatchObject({ code: "forbidden" });
});
it("a worker cannot read or send in another instance's room", async () => {
  const other = w.roomOf("inst-b");
  await w.messaging.post({ roomId: other, from: w.refs.workerB, kind: "text", body: "private to inst-b", provenance: { source: "worker" } });
  await expect(call("GET", "/api/rooms/:id/read", w.actors.workerA, { params: { id: other } })).rejects.toMatchObject({ code: "not_found", status: 404 });
  await expect(call("POST", "/api/rooms/:id/send", w.actors.workerA, { params: { id: other }, body: { body: "hello" } })).rejects.toMatchObject({ code: "not_found" });
  await expect(call("GET", "/api/rooms/:id/who", w.actors.workerA, { params: { id: other } })).rejects.toMatchObject({ code: "not_found" });
});
it("read returns the messages after sinceSeq, tagged by sender kind, and filters by sender", async () => {
  const first = await say("one");
  await say("two", w.refs.owner);
  const all = (await call("GET", "/api/rooms/:id/read", w.actors.workerA, { params: { id: roomA() }, query: { sinceSeq: String(first.seq - 1) } })) as ReadResponse;
  expect(all.messages.map((m) => [m.body, m.fromKind])).toEqual([["one", "worker"], ["two", "human"]]);
  expect(Object.keys(all.messages[0]).sort()).toEqual(["at", "body", "fromId", "fromKind", "id", "kind", "replyTo", "seq"]);
  expect(((await call("GET", "/api/rooms/:id/read", w.actors.workerA, { params: { id: roomA() }, query: { from: "owner" } })) as ReadResponse).messages.map((m) => m.body)).toEqual(["two"]);
});
it("ask creates a question for the participant's session, and the run's own token asks as the run", async () => {
  expect(await w.store.questions.get(await ask())).toMatchObject({ instanceId: "inst-a", sessionId: "sess-worker-a", state: "open" });
  const own = (await call("POST", "/api/rooms/:id/ask", w.actors.instA, { params: { id: roomA() }, body: { body: "Resume or start fresh?" } })) as AskResponse;
  expect((await w.store.questions.get(own.questionId))!.sessionId).toBe("run");
});
it("GET /api/questions/:id waits for the answer", async () => {
  const questionId = await ask();
  const pending = call("GET", "/api/questions/:id", w.actors.workerA, { params: { id: questionId } });
  await w.messaging.answer(questionId, w.refs.owner, "Postgres");
  expect(await pending).toEqual({ questionId, state: "answered", answer: "Postgres", from: "human", proceededWith: null, proceededSource: null });
});
it("GET /api/questions/:id returns the open question when the wait ends, and a proceeded one with its source", async () => {
  const questionId = await ask();
  expect(await call("GET", "/api/questions/:id", w.actors.workerA, { params: { id: questionId } })).toEqual({ questionId, state: "open", answer: null, from: null, proceededWith: null, proceededSource: null });
  w.clock.advance(31 * 60_000);
  await w.messaging.expireQuestions(w.clock.now(), { lookup: async () => "Use Postgres, as on card 12" });
  expect(await call("GET", "/api/questions/:id", w.actors.workerA, { params: { id: questionId } })).toEqual({ questionId, state: "proceeded", answer: null, from: null, proceededWith: "Use Postgres, as on card 12", proceededSource: "precedent" });
  await expect(call("GET", "/api/questions/:id", w.actors.workerB, { params: { id: questionId } })).rejects.toMatchObject({ code: "not_found" });
});
it("who lists the run's participants and what each last said", async () => {
  await say("running the migration tests now");
  expect(((await call("GET", "/api/rooms/:id/who", w.actors.workerA, { params: { id: roomA() } })) as WhoResponse).participants).toEqual([
    { id: "part-inst-a", kind: "instance", name: "project-a/42", doing: null },
    { id: "part-worker-a", kind: "worker", name: "sess-worker-a", doing: "running the migration tests now" },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/os && npx vitest run tests/messaging/room-routes.test.ts`
Expected: FAIL, `no route POST /api/rooms/:id/send` from the route caller.

- [ ] **Step 3: Add the five routes to `messagingRoutes`, after Task 12's two, with the rules above**

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/os && npx vitest run tests/messaging/room-routes.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the package suite and the build**

Run: `cd packages/os && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/routes.ts packages/os/tests/messaging/room-routes.test.ts
git commit -m "feat(os): room-token send, read, ask, question long-poll and who routes"
```

---

### Task 14: Mount on the brain, replace the auth hooks, export

**Files:**
- Create: `packages/os/src/messaging/install.ts`
- Modify: `packages/os/src/index.ts` (append the plan 05 block)
- Test: `packages/os/tests/messaging/install.test.ts`, `packages/os/tests/messaging/http.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 13. From plan 03: `ApiServer.route(method, path, ...chain)`, `requireAuth(kinds)`, `idempotent()`, `StandingRunners.fallback(run)` with `StandingRun = (argv, requester) => Promise<StandingResult>`, `AuthHooks` (`onNewAddress(session, address)`, `onStepUpFailed(stepUp, by)`), `StepUps`, `Lockdown`, `apiFixture`, `rawRequest`; the `question_expiry` Periodics slot (60 s) of plan 03's composition task.
- Produces:

```ts
export interface MessagingHost {   // what plan 03's Brain hands this plan; its composition task adapts its own objects to it
  store: OsStore; config: OsConfig; clock: Clock; log: Logger; hub: EventPublisher;
  server: Pick<ApiServer, "route">;
  periodic(slot: "question_expiry", run: () => Promise<void>): void;
  standingRunners: Pick<StandingRunners, "fallback">;
  authHooks: AuthHooks;                                   // replaced in place
  stepUps: Pick<StepUps, "issue" | "confirm" | "consume">;
  lockdown: Pick<Lockdown, "active">;
}
export interface MessagingParts { messaging: Messaging; participants: Participants; rooms: Rooms; push: PushSender | undefined }
export function createMessaging(host: Pick<MessagingHost, "store" | "config" | "clock" | "log" | "hub">): Promise<MessagingParts>;   // before the Dispatcher, which takes `messaging`; opens the system room
export interface MountedMessaging { executor: CommandExecutor; tripwires: Tripwires }
export function mountMessaging(host: MessagingHost, parts: MessagingParts, opts: { runtime: () => CommandRuntime; precedent: () => Precedent; limits?: Pick<LimitGate, "checkCommand"> }): MountedMessaging;
export function tripwireAuthHooks(deps: { store: OsStore; clock: Clock; hub: EventPublisher; tripwires: Pick<Tripwires, "record"> }): AuthHooks;
```

`mountMessaging`, in order:
1. `registerBuiltinCommands()` into `COMMANDS`.
2. Build `Tripwires` with `messaging`, and `CommandExecutor` with `limits ?? NoLimitGate` (plan 09 passes its `SecurityGate`).
3. Register every `messagingRoutes` entry as `server.route(method, path, requireAuth(auth), ...(idempotent ? [idempotent()] : []), handler)`.
4. Set the `question_expiry` periodic to `messaging.expireQuestions(clock.now(), opts.precedent())`. The precedent is read on each tick, because plan 06 builds its precedent after Messaging.
5. Install the standing-runner fallback `(argv, requester) => executor.executeConfirmed(contextFor(…, requester, <system room id>), argv)`. With it, plan 03's `POST /api/stepup/confirm` can run any registered standing command, audited in the system room.
6. `Object.assign(host.authHooks, tripwireAuthHooks(…))`.

`tripwireAuthHooks`:
- `onNewAddress(session, address)` records `new_address` for that session's human actor at the new address (`confirmer` from its device).
- `onStepUpFailed(stepUp, by)` records `stepup_failed` for `by` when it is a human. It does the same for the step-up's requesting session when that is another live session.
- Each cool-down that starts publishes `{ type: "cooldown", payload: { cooldownUntil } }` to that session only, as plan 03's default hooks do.

The `src/index.ts` block exports, under `// --- plan 05: messaging, push, commands ---`:
- `SECRET_PATTERNS`, `redactDeep`, `computeWaitUntil`, `resolveAsk`.
- `Messaging`, `MessagingError`, `LIVE_INSTANCE_STATES`, `NoPrecedent`, `Participants`, `permissionsFor`, `SYSTEM_REF`, `Rooms`.
- `messagingRoutes`, `contextFor`, `createMessaging`, `mountMessaging`, `tripwireAuthHooks`.
- `PushError`, `WebPushSender`, `createPushSender`, `pushPayloadFor`, `oneLine`, `parsePushSubscription`, `savePushSubscription`, `clearPushSubscription`, `deliverPush`.
- `COMMANDS`, `COMMAND_KINDS`, `CommandArgsError`, `CommandRegistryError`, `normalizeArgv`, `parseCommand`, `registerCommand`, `tokenizeCommand`.
- `CommandExecutor`, `mayRun`, `BUILTIN_COMMANDS`, `registerBuiltinCommands`.
- And their types.

`redactSecrets` already leaves the root through plan 02's `log.ts` line, which now re-exports this plan's (Task 1). Three groups stay off the root, because plan 09 and plan 08 export their own: the gate and tripwire names (`LimitGate`, `LimitCheckInput`, `GateVerdict`, `NoLimitGate`, `refuse`, `refusalCode`, `Tripwires`, `TripwireEvent`), and `argvToArgs`. Import them by path.

- [ ] **Step 1: Write the failing tests**

```ts
// install.test.ts
import webpush from "web-push";
import { beforeEach, expect, it, vi } from "vitest";
import * as os from "../../src/index.js";
import { COMMANDS } from "../../src/commands/registry.js";
import { BUILTIN_COMMANDS } from "../../src/commands/builtin.js";
import { Tripwires } from "../../src/commands/tripwires.js";
import { createMessaging, mountMessaging, tripwireAuthHooks, type MessagingHost } from "../../src/messaging/install.js";
import { WebPushSender } from "../../src/push/push.js";
import { makeConfig, MemoryOsStore, FakeClock, FakeEventHub } from "../../src/testing/index.js";
import { testStepUps } from "../helpers/commands.js";
import { makeWorld, type World } from "../helpers/world.js";

let w: World; let host: MessagingHost & { routes: Array<{ method: string; path: string; chain: number }>; periodics: Map<string, () => Promise<void>>; fallbacks: unknown[] };
beforeEach(async () => {
  w = await makeWorld();
  const routes: Array<{ method: string; path: string; chain: number }> = []; const periodics = new Map<string, () => Promise<void>>(); const fallbacks: unknown[] = [];
  host = { store: w.store, config: w.config, clock: w.clock, log: w.log, hub: w.hub, routes, periodics, fallbacks,
    server: { route: (method: string, path: string, ...chain: unknown[]) => { routes.push({ method, path, chain: chain.length }); } } as never,
    periodic: (slot, run) => { periodics.set(slot, run); },
    standingRunners: { fallback: (run: unknown) => { fallbacks.push(run); } } as never,
    authHooks: { onNewAddress: async () => {}, onStepUpFailed: async () => {} },
    stepUps: testStepUps(w.store, w.clock), lockdown: { active: () => false } };
});
const mount = async () => mountMessaging(host, await createMessaging(host), { runtime: () => ({}) as never, precedent: () => ({ lookup: async () => "Use Postgres, as before" }) });

it("registers every route behind requireAuth, with idempotent() on the two POSTs the overview names", async () => {
  await mount();
  expect(host.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/rooms", "GET /api/rooms/:id/messages", "POST /api/rooms/:id/messages",
    "POST /api/questions/:id/answer", "POST /api/push/subscribe", "DELETE /api/push/subscribe", "POST /api/commands", "GET /api/commands",
    "POST /api/rooms/:id/send", "GET /api/rooms/:id/read", "POST /api/rooms/:id/ask", "GET /api/questions/:id", "GET /api/rooms/:id/who"]);
  expect(host.routes.filter((r) => r.chain === 3).map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/rooms/:id/messages", "POST /api/commands"]);
  expect(host.routes.filter((r) => r.chain !== 2 && r.chain !== 3)).toEqual([]);
  expect(COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining([...BUILTIN_COMMANDS]));
});
it("runs question expiry on its periodic slot with the precedent of the moment", async () => {
  await mount();
  const q = await w.messaging.ask({ roomId: w.roomOf("inst-a"), from: w.refs.workerA, instanceId: "inst-a", sessionId: "sess-worker-a", body: "Which database?" });
  w.clock.advance(31 * 60_000);
  await host.periodics.get("question_expiry")!();
  expect(await w.store.questions.get(q.id)).toMatchObject({ state: "proceeded", proceededWith: "Use Postgres, as before" });
});
it("installs a standing-runner fallback that runs a confirmed command and audits it in the system room", async () => {
  await mount();
  const run = host.fallbacks[0] as (argv: string[], requester: unknown) => Promise<{ ok: boolean; text: string }>;
  expect(await run(["help"], w.actors.phone)).toMatchObject({ ok: true });
  const sys = (await w.store.rooms.find({ kind: "system" }))[0];
  expect((await w.store.messages.find({ roomId: sys.id, kind: "command" })).map((m) => m.body)).toEqual(["/help"]);
});
it("replaces the auth hooks in place with tripwires: a new address cools that session and tells only it", async () => {
  const hooks = host.authHooks;
  await mount();
  expect(host.authHooks).toBe(hooks);
  await hooks.onNewAddress((await w.store.sessions.get("sess-phone"))!, "203.0.113.50");
  expect((await w.store.sessions.get("sess-phone"))!.cooldownUntil).toBe("2026-10-25T10:10:00.000Z");
  const [e] = w.hub.published.filter((x) => x.type === "cooldown");
  expect(e.payload).toEqual({ cooldownUntil: "2026-10-25T10:10:00.000Z" });
  expect([w.actors.phone, w.actors.laptop].map(e.visibleTo)).toEqual([true, false]);
});
it("tripwireAuthHooks counts a failed confirmation against the human who presented it", async () => {
  const tripwires = new Tripwires({ store: w.store, clock: w.clock, messaging: w.messaging });
  const hooks = tripwireAuthHooks({ store: w.store, clock: w.clock, hub: w.hub, tripwires });
  await hooks.onStepUpFailed(null, w.actors.laptop);
  await hooks.onStepUpFailed(null, w.actors.laptop);
  expect((await tripwires.cooling(w.actors.laptop))?.toISOString()).toBe("2026-10-25T10:10:00.000Z");
});
it("createMessaging opens the system room and builds a WebPushSender only with push config", async () => {
  const store = new MemoryOsStore(); const keys = webpush.generateVAPIDKeys();
  const config = makeConfig({ push: { vapid_public: keys.publicKey, vapid_private: keys.privateKey, subject: "mailto:owner@example.invalid" } });
  const parts = await createMessaging({ store, config, clock: new FakeClock(), log: w.log, hub: new FakeEventHub() });
  expect(parts.push).toBeInstanceOf(WebPushSender);
  expect(await store.rooms.find({ kind: "system" })).toHaveLength(1);
  expect((await createMessaging({ store: new MemoryOsStore(), config: makeConfig({ push: undefined }), clock: new FakeClock(), log: w.log, hub: new FakeEventHub() })).push).toBeUndefined();
});
it("exports the surface from the package root, with plan 05's redactSecrets", () => {
  expect(os.redactSecrets("ghp_abc")).toBe("ghp_[redacted]");
  for (const name of ["Messaging", "mountMessaging", "createMessaging", "CommandExecutor", "registerCommand", "COMMANDS", "WebPushSender"]) expect(typeof (os as Record<string, unknown>)[name], name).not.toBe("undefined");
});
```

```ts
// http.e2e.test.ts: plan 03's real server on an ephemeral loopback port
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { StepUps } from "../../src/auth/stepup.js";
import { registerCommand } from "../../src/commands/registry.js";
import { createMessaging, mountMessaging } from "../../src/messaging/install.js";
import { FakeEventHub, makeRow } from "../../src/testing/index.js";
import { apiFixture } from "../helpers/api-fixture.js";
import { rawRequest } from "../helpers/http.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

it("serves the routes on plan 03's server: the 428 envelope, completion, Idempotency-Key, X-Swarm-Os and room-token scope", async () => {
  const f = await apiFixture(); close = f.close;
  const hub = new FakeEventHub();
  const stepUps = new StepUps({ store: f.store, clock: f.clock, config: f.config, hostSecret: f.hostSecret });
  const host = { store: f.store, config: f.config, clock: f.clock, log: f.log, hub, server: f.server, periodic: () => {}, standingRunners: { fallback: () => {} } as never, authHooks: f.hooks, stepUps, lockdown: f.lockdown };
  const parts = await createMessaging(host);
  mountMessaging(host, parts, { runtime: () => ({}) as never, precedent: () => ({ lookup: async () => null }) });
  registerCommand({ name: "db reset", kind: "standing", summary: "db reset: wipe the cold store", args: z.object({}), run: async () => ({ ok: true, text: "reset" }) });
  const sys = await parts.rooms.systemRoom();
  const { token } = await f.human({ confirmer: false });

  const asked = await f.request("POST", "/api/commands", { token, body: { room: sys.id, argv: ["db", "reset"] } });
  expect(asked.status).toBe(428);
  expect(asked.json.error).toMatchObject({ code: "stepup_required", stepUpId: expect.any(String) });
  const code = stepUps.codeFor(asked.json.error.stepUpId)!;
  expect(JSON.stringify(asked.json)).not.toContain(code);
  const done = await f.request("POST", "/api/commands", { token, body: { room: sys.id, argv: ["db", "reset"], stepUpId: asked.json.error.stepUpId, code } });
  expect([done.status, done.json]).toEqual([200, { ok: true, text: "reset" }]);

  const once = { token, body: { room: sys.id, argv: ["help"] }, headers: { "Idempotency-Key": "k-1" } };
  expect((await f.request("POST", "/api/commands", once)).status).toBe(200);
  const again = await f.request("POST", "/api/commands", once);
  expect([again.status, again.headers.get("idempotent-replay")]).toEqual([200, "true"]);
  expect((await f.store.messages.find({ roomId: sys.id, kind: "command" })).filter((m) => m.body === "/help")).toHaveLength(1);

  const csrf = await rawRequest(`${f.url}/api/commands`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ room: sys.id, argv: ["help"] }) });
  expect([csrf.status, csrf.json().error.code]).toEqual([403, "forbidden"]);

  for (const [id, card] of [["inst-a", "42"], ["inst-b", "43"]] as const) {
    const room = await parts.messaging.openRoom("instance", id, `board-a#${card}`, [`part-worker-${id}`], "normal");
    await f.store.instances.put(makeRow("instances", { id, cardId: card, state: "running", roomId: room.id, startedAt: f.clock.now().toISOString() }));
    await f.store.participants.put(makeRow("participants", { id: `part-worker-${id}`, kind: "worker", name: `sess-${id}`, instanceId: id }));
  }
  const [roomA, roomB] = [(await f.store.instances.get("inst-a"))!.roomId, (await f.store.instances.get("inst-b"))!.roomId];
  const roomToken = f.tokens.mintRoomToken("inst-a", "part-worker-inst-a", roomA);
  const sent = await f.request("POST", `/api/rooms/${roomA}/send`, { token: roomToken, body: { body: "tests are green" } });
  expect([sent.status, typeof sent.json.messageId]).toEqual([200, "string"]);
  expect((await f.request("GET", `/api/rooms/${roomB}/read`, { token: roomToken })).status).toBe(404);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/messaging/install.test.ts tests/messaging/http.e2e.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/messaging/install.js"`.

- [ ] **Step 3: Implement `install.ts` and append the index block as the Interfaces block describes**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run tests/messaging/install.test.ts tests/messaging/http.e2e.test.ts`
Expected: PASS, 7 and 1 tests.

- [ ] **Step 5: Run the package suite, the CLI suite and the workspace build**

Run: `cd packages/os && npx vitest run && cd ../cli && npx vitest run && cd ../.. && pnpm -w build`
Expected: every test passes, the CLI suite unchanged; the workspace build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging/install.ts packages/os/src/index.ts packages/os/tests/messaging/install.test.ts packages/os/tests/messaging/http.e2e.test.ts
git commit -m "feat(os): mount messaging and commands on the brain, with tripwire auth hooks"
```

---

### Task 15: Metrics: messages, questions, push, commands, and the `metrics` chat command

**Files:**
- Create: `packages/os/src/commands/metrics-command.ts`
- Modify: `packages/os/src/messaging/redact.ts` (an optional `onMatch` callback), `packages/os/src/messaging/messaging.ts`, `packages/os/src/push/subscriptions.ts`, `packages/os/src/commands/registry.ts` (`COMMAND_KINDS` gains `metrics: "operating"`), `packages/os/src/commands/executor.ts`, `packages/os/src/commands/tripwires.ts` (the stub accepts `metrics` and ignores it, so plan 09's final class receives it from the same construction line), `packages/os/src/messaging/routes.ts`, `packages/os/src/messaging/install.ts`, `packages/os/src/index.ts`, `packages/metrics/src/catalogue/os.ts` (the plan 05 slot)
- Modify (tests): `packages/os/tests/helpers/world.ts` (`makeWorld({ metrics })`), `packages/os/tests/helpers/commands.ts` (`makeCommandWorld({ metrics })`), `packages/os/tests/commands/registry.test.ts` (36 commands)
- Test: `packages/os/tests/metrics/messaging-metrics.test.ts`, `packages/os/tests/metrics/command-metrics.test.ts`

**Interfaces:**
- Consumes: from `@mnmal-ai/swarm-metrics` (plan 10): `Metrics`, `noopMetrics`, `MetricsSnapshot`, `topSinks`, `formatSummary`, `formatTopSinks`, `formatDuration`, `CATALOGUE`; `testRegistry` from `@mnmal-ai/swarm-metrics/testing`. From plan 03: `filterSnapshot` (`packages/os/src/brain/metrics.ts`). From plan 02: the test helpers `hist`, `counter` and `gauge` (`packages/os/tests/metrics/helpers.ts`). Tasks 1 to 14 of this plan.
- Produces:
```ts
// packages/os/src/messaging/redact.ts
export function redactSecrets(text: string, onMatch?: (pattern: string) => void): string;   // onMatch: once per replacement, with the SECRET_PATTERNS name
export function redactDeep<T>(value: T, onMatch?: (pattern: string) => void): T;
// packages/os/src/messaging/messaging.ts
export interface MessagingDeps { /* … */ metrics?: Metrics }
// packages/os/src/push/subscriptions.ts
export function countPushSubscriptions(store: OsStore): Promise<number>;                     // unrevoked devices with a subscription
export function savePushSubscription(store: OsStore, deviceId: string, input: unknown, metrics?: Metrics): Promise<DeviceRow>;
export function clearPushSubscription(store: OsStore, deviceId: string, metrics?: Metrics): Promise<DeviceRow>;
export function deliverPush(deps: { store: OsStore; push: PushSender; log?: Logger; metrics?: Metrics }, humanIds: string[], payload: PushPayload): Promise<{ sent: number; gone: number }>;
// packages/os/src/commands/registry.ts
export interface CommandContext { /* … */ metrics?: Metrics }   // the brain's handle; contextFor sets it from deps.metrics, and the executor fills it from its own when absent before spec.run (plan 08's CLI-backed commands read ctx.metrics ?? noopMetrics)
// packages/os/src/commands/executor.ts
export interface ExecutorDeps { /* … */ metrics?: Metrics }
// packages/os/src/commands/tripwires.ts (the stub)
constructor(deps: { store: OsStore; clock: Clock; messaging?: Messaging; metrics?: Metrics });
// packages/os/src/messaging/routes.ts
export interface MessagingRouteDeps { /* … */ metrics?: Metrics }
// packages/os/src/messaging/install.ts
export interface MessagingHost { /* … */ metrics?: Metrics; metricsSource?: MetricsSource }   // whoever builds the host passes BrainContext.metrics and BrainContext.brainMetrics
export function createMessaging(host: Pick<MessagingHost, "store" | "config" | "clock" | "log" | "hub" | "metrics">): Promise<MessagingParts>;
// packages/os/src/commands/metrics-command.ts
export interface MetricsSource {                     // plan 03's BrainMetrics satisfies it structurally
  snapshot(): MetricsSnapshot;
  uptimeSeconds(): number;
  instances(): Record<string, { at: number; snapshot: MetricsSnapshot }>;
  collect?(): Promise<void>;
  addCollector?(name: string, fn: () => void | Promise<void>): void;
}
export const METRICS_SUMMARY = "metrics [area]: time sinks and latencies, from the brain and each live instance";
export function metricsCommand(source: MetricsSource): CommandSpec<{ area?: string }>;      // kind "query", args z.object({ area: z.string().regex(/^[a-z][a-z0-9_]*$/).optional() })
export function registerMetricsCommand(source: MetricsSource, into?: CommandSpec<any>[]): void;   // into defaults to COMMANDS; replaces an earlier "metrics" spec in place
export function metricsReply(input: { brain: MetricsSnapshot; uptimeSeconds: number; instances: Array<{ id: string; label: string; snapshot: MetricsSnapshot }>; prefix?: string }): string;
```

`metrics [area]` is a query command: it reads and changes nothing, so it needs no step-up, and the executor's audit posts its result text as the `system` reply in the room it was issued in. That reply is the summary.
- **Prefix.** Without `area`, no filter. With one, the prefix is `swarm_<area>_`; when neither the brain's snapshot nor any instance's has a series under it and `area` does not start with `os_`, `swarm_os_<area>_` is tried, so `/metrics http` finds `swarm_os_http_*`. Nothing under either: `{ ok: true, text: "No metrics under swarm_<area>_." }`.
- **Instances.** The entries of `source.instances()` whose `Instance` row is in `LIVE_INSTANCE_STATES`, sorted by id; each labelled `<board name>:<card>` (the board's id when the row is missing).
- **Reply** (`metricsReply`), lines joined by `\n`: `Brain · up <formatDuration(uptimeSeconds)>`, plus ` · <prefix>*` with a prefix; then `formatSummary(prefix ? filterSnapshot(brain, [prefix]) : brain, { wallSeconds: uptimeSeconds, top: 10 })`; then, for each instance, a blank line, `Instance <id> · <label>` and `formatTopSinks(topSinks(filtered, 3, prefix ? { names: (n) => n.startsWith(prefix) } : undefined))` (`filtered` being the instance's snapshot through the same filter), or `no time sinks yet` when that is empty; with no instance, a blank line and `No live instance has reported metrics yet.` (`topSinks` leaves plan 10's `CONTAINER_METRICS` out unless `names` is given, so `/metrics run` still shows the run's phases.)
- **Data.** `{ prefix: <the prefix used> | null, instances: <the ids shown> }`. The command calls `source.collect?.()` first.

Catalogue rows this task adds (`room_kind` is the room's kind, or `missing` when the room does not exist; `from_kind` the sender's `fromKind`; `kind` the message kind; `command` the registered name, or `unknown` for a name not in the registry; `actor` the actor's kind; `code` a `RefusalCode`):

| Name | Kind | Unit | Labels | Recorded in |
|---|---|---|---|---|
| `swarm_os_messaging_posts_total` | counter | count | `room_kind`, `from_kind`, `kind` | `Messaging`'s store-and-publish step (so `post`, `ask` and `answer` all count), once the row is stored |
| `swarm_os_messaging_post_seconds` | histogram | seconds | `room_kind`, `outcome` | the same step: redaction, `nextSeq`, `put` and publish (push is timed on its own) |
| `swarm_os_messaging_body_bytes` | histogram | bytes | `room_kind`, `kind` | the same step, the stored (redacted) body |
| `swarm_os_messaging_redact_seconds` | histogram | seconds | `outcome` | the same step, `redactSecrets` on the body and `redactDeep` on the data |
| `swarm_os_messaging_redactions_total` | counter | count | `pattern` (a `SECRET_PATTERNS` name) | the same step, through `onMatch` |
| `swarm_os_messaging_questions_open` | gauge | count | | `ask` (+1), an on-time `answer` (−1), and `expireQuestions`, which sets it to the open rows it read minus those it closed |
| `swarm_os_messaging_question_open_seconds` | histogram | seconds | `outcome` (`answered`, `proceeded`, `expired`) | `answer` and `expireQuestions`: `now − askedAt` by the brain's clock, when a question leaves `open` |
| `swarm_os_messaging_question_changes_total` | counter | count | `change` (`asked`, `answered`, `late_answer`, `proceeded`, `expired`, `extended`) | wherever `onQuestion` listeners are told; late answers are `change: "late_answer"` |
| `swarm_os_messaging_long_poll_seconds` | histogram | seconds | `outcome` (`immediate`, `changed`, `timeout`) | `GET /api/questions/:id` |
| `swarm_os_push_send_seconds` | histogram | seconds | `outcome` (`sent`, `gone`, `failed`) | `deliverPush`, each device send |
| `swarm_os_push_failures_total` | counter | count | `status` (the push service's HTTP status, `400` to `599`, or `none`) | `deliverPush`, each failed send |
| `swarm_os_push_subscriptions` | gauge | count | | `savePushSubscription`, `clearPushSubscription`, a `gone` in `deliverPush`, and `mountMessaging` once, each from `countPushSubscriptions` |
| `swarm_os_command_seconds` | histogram | seconds | `command`, `kind` (`query`, `operating`, `standing`, or `none`), `actor`, `outcome` (`ok`, `refused`, `failed`, `error`) | `CommandExecutor.execute` and `executeConfirmed`, from the call to the end of the audit; `failed` is `ok: false` without a code, `error` a `run` that threw |
| `swarm_os_command_refusals_total` | counter | count | `command`, `code` | the executor, each refusal |
| `swarm_os_command_stage_seconds` | histogram | seconds | `command`, `stage` (`cooling`, `limits`, `stepup`, `run`, `audit`), `outcome` | the executor's stages: `tripwires.cooling`, `limits.checkCommand`, the step-up (issue, or confirm and consume), `spec.run`, the two audit posts |

```ts
  // plan 05
  { name: "swarm_os_messaging_posts_total", kind: "counter", unit: "count", help: "Messages stored, by room kind, sender kind and message kind", labels: ["room_kind", "from_kind", "kind"] },
  { name: "swarm_os_messaging_post_seconds", kind: "histogram", unit: "seconds", help: "Time to redact, store and publish one message", labels: ["room_kind", "outcome"] },
  { name: "swarm_os_messaging_body_bytes", kind: "histogram", unit: "bytes", help: "Stored message body size", labels: ["room_kind", "kind"] },
  { name: "swarm_os_messaging_redact_seconds", kind: "histogram", unit: "seconds", help: "Time to redact secrets from one message", labels: ["outcome"] },
  { name: "swarm_os_messaging_redactions_total", kind: "counter", unit: "count", help: "Secrets redacted from messages, by pattern", labels: ["pattern"] },
  { name: "swarm_os_messaging_questions_open", kind: "gauge", unit: "count", help: "Questions waiting for an answer", labels: [] },
  { name: "swarm_os_messaging_question_open_seconds", kind: "histogram", unit: "seconds", help: "How long a question stayed open, by how it closed", labels: ["outcome"] },
  { name: "swarm_os_messaging_question_changes_total", kind: "counter", unit: "count", help: "Question changes: asked, answered, late answers, proceeded, expired, extended", labels: ["change"] },
  { name: "swarm_os_messaging_long_poll_seconds", kind: "histogram", unit: "seconds", help: "Room-token question long polls, by how they ended", labels: ["outcome"] },
  { name: "swarm_os_push_send_seconds", kind: "histogram", unit: "seconds", help: "Web Push send time, by outcome", labels: ["outcome"] },
  { name: "swarm_os_push_failures_total", kind: "counter", unit: "count", help: "Web Push sends that failed, by the push service's status", labels: ["status"] },
  { name: "swarm_os_push_subscriptions", kind: "gauge", unit: "count", help: "Devices with a live push subscription", labels: [] },
  { name: "swarm_os_command_seconds", kind: "histogram", unit: "seconds", help: "Command time from request to audit, by command, kind, actor and outcome", labels: ["command", "kind", "actor", "outcome"] },
  { name: "swarm_os_command_refusals_total", kind: "counter", unit: "count", help: "Commands refused, by code", labels: ["command", "code"] },
  { name: "swarm_os_command_stage_seconds", kind: "histogram", unit: "seconds", help: "Time in each stage of the command executor", labels: ["command", "stage", "outcome"] },
```

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/commands/registry.test.ts`: the first test becomes "declares the overview's 35 commands, plan 05's metrics, and their kinds", with `toHaveLength(36)` and `metrics: "query"` added to its `toMatchObject`.

`packages/os/tests/metrics/messaging-metrics.test.ts` (per test: `({ metrics: registry } = testRegistry(CATALOGUE))`, `w = await makeWorld({ metrics: registry })`, `s = () => registry.snapshot()`; `post(o)` and `ask()` as in Tasks 4 and 5; the world posts nothing while it is built):
```ts
it("counts posts by room kind, sender kind and message kind, sizes their bodies and times them", async () => {
  await post(); await post({ body: "twelve bytes" });
  expect(counter(s(), "swarm_os_messaging_posts_total", { room_kind: "instance", from_kind: "worker", kind: "text" })).toBe(2);
  expect(hist(s(), "swarm_os_messaging_body_bytes", { room_kind: "instance", kind: "text" })).toMatchObject({ count: 2, sum: 20 });
  expect(hist(s(), "swarm_os_messaging_post_seconds", { room_kind: "instance", outcome: "ok" })?.count).toBe(2);
  await expect(post({ roomId: "room-missing" })).rejects.toMatchObject({ code: "room_not_found" });
  expect(hist(s(), "swarm_os_messaging_post_seconds", { room_kind: "missing", outcome: "error" })?.count).toBe(1);
});
it("counts redactions by pattern, times them, and puts no secret in a label", async () => {
  const ghp = "ghp_" + "a".repeat(36);
  await post({ body: `use ${ghp}`, data: { env: "GITHUB_TOKEN=abc123" } });
  expect(["github", "env-assignment"].map((pattern) => counter(s(), "swarm_os_messaging_redactions_total", { pattern }))).toEqual([1, 1]);
  expect(hist(s(), "swarm_os_messaging_redact_seconds", { outcome: "ok" })?.count).toBe(1);
  expect(JSON.stringify(s())).not.toContain(ghp);
});
it("tracks open questions, how long each stayed open by outcome, and every question change", async () => {
  const q1 = await ask();
  expect(gauge(s(), "swarm_os_messaging_questions_open")).toBe(1);
  w.clock.advance(5 * 60_000);
  await w.messaging.answer(q1.id, w.refs.owner, "Postgres");
  expect(gauge(s(), "swarm_os_messaging_questions_open")).toBe(0);
  await ask();
  w.clock.advance(31 * 60_000);
  await w.messaging.expireQuestions(w.clock.now(), { lookup: async () => "Use Postgres" });
  await w.messaging.answer(q1.id, w.refs.owner, "Redis after all");
  expect(["answered", "proceeded"].map((outcome) => hist(s(), "swarm_os_messaging_question_open_seconds", { outcome })).map((x) => [x?.count, x?.sum])).toEqual([[1, 300], [1, 1860]]);
  expect(["asked", "answered", "proceeded", "late_answer"].map((change) => counter(s(), "swarm_os_messaging_question_changes_total", { change }))).toEqual([2, 1, 1, 1]);
  expect(gauge(s(), "swarm_os_messaging_questions_open")).toBe(0);
});
it("times each push by outcome, counts failures by status, and keeps the subscription gauge", async () => {
  w.push.goneEndpoints.add(SUB("dev-laptop").endpoint);
  await post({ kind: "question", body: "Which database?" });
  expect(["sent", "gone"].map((outcome) => hist(s(), "swarm_os_push_send_seconds", { outcome })?.count)).toEqual([1, 1]);
  expect(gauge(s(), "swarm_os_push_subscriptions")).toBe(2);              // dev-phone and dev-other; dev-laptop's went
  w.push.failWith = new PushError("send_failed", "push service down", 503);
  await post({ kind: "question", body: "Which cache?" });
  w.push.failWith = new Error("socket hang up");
  await post({ kind: "question", body: "Which queue?" });
  expect(["503", "none"].map((status) => counter(s(), "swarm_os_push_failures_total", { status }))).toEqual([1, 1]);
  await savePushSubscription(w.store, "dev-laptop", SUB("dev-laptop-2"), registry);
  expect(gauge(s(), "swarm_os_push_subscriptions")).toBe(3);
  await clearPushSubscription(w.store, "dev-phone", registry);
  expect(gauge(s(), "swarm_os_push_subscriptions")).toBe(2);
});
it("times room-token long polls by how they ended", async () => {
  const cw = await makeCommandWorld({ metrics: registry });
  const call = routeCaller(messagingRoutes({ ...routeDeps(cw, { longPollMs: 30 }), metrics: registry }));
  const q = ((await call("POST", "/api/rooms/:id/ask", cw.actors.workerA, { params: { id: cw.roomOf("inst-a") }, body: { body: "Which?" } })) as AskResponse).questionId;
  await call("GET", "/api/questions/:id", cw.actors.workerA, { params: { id: q } });
  const waiting = call("GET", "/api/questions/:id", cw.actors.workerA, { params: { id: q } });
  await cw.messaging.answer(q, cw.refs.owner, "This one"); await waiting;
  await call("GET", "/api/questions/:id", cw.actors.workerA, { params: { id: q } });
  expect(["timeout", "changed", "immediate"].map((outcome) => hist(s(), "swarm_os_messaging_long_poll_seconds", { outcome })?.count)).toEqual([1, 1, 1]);
});
```
`packages/os/tests/metrics/command-metrics.test.ts` (per test: `registry` and `s()` as above, `w = await makeCommandWorld({ metrics: registry })`, `run(actor, argv, roomId?)` as in Task 8; `h(name, sum, labels?)` builds a one-observation seconds `HistogramSnapshot` and `snap(histograms)` a snapshot with nothing else; `BRAIN = snap([h("swarm_os_http_request_seconds", 4, { route: "/api/rooms", method: "GET", status_class: "2xx", outcome: "ok" }), h("swarm_os_command_seconds", 2, { command: "top", kind: "query", actor: "human", outcome: "ok" })])`; `INST_A = snap([h("swarm_git_command_seconds", 5), h("swarm_substrate_request_seconds", 3), h("swarm_agent_api_seconds", 9), h("swarm_merge_gate_seconds", 1), h("swarm_run_phase_seconds", 40, { phase: "execution", outcome: "ok" })])`; `INST_B = snap([h("swarm_git_command_seconds", 7)])`; `source(o)` is `{ snapshot: () => BRAIN, uptimeSeconds: () => 3_600, instances: () => ({ "inst-a": { at: 1, snapshot: INST_A }, "inst-b": { at: 1, snapshot: INST_B } }), ...o }`):
```ts
it("counts every command by name, kind, actor and outcome, and every refusal by code", async () => {
  await run(w.actors.phone, ["help"]); await run(w.actors.phone, ["frobnicate"]); await run(w.actors.phone, ["say"]);
  await run(w.actors.phone, ["instances"]); await run(w.actors.workerA, ["help"], w.roomOf("inst-a"));
  const n = (labels: Record<string, string>) => hist(s(), "swarm_os_command_seconds", labels)?.count;
  expect([n({ command: "help", kind: "query", actor: "human", outcome: "ok" }), n({ command: "unknown", kind: "none", actor: "human", outcome: "refused" }),
    n({ command: "say", kind: "operating", actor: "human", outcome: "refused" }), n({ command: "instances", kind: "query", actor: "human", outcome: "error" }),
    n({ command: "help", kind: "query", actor: "room", outcome: "refused" })]).toEqual([1, 1, 1, 1, 1]);
  expect(["not_found", "bad_request", "forbidden"].map((code) => counter(s(), "swarm_os_command_refusals_total", { code }))).toEqual([1, 1, 1]);
  expect(JSON.stringify(s())).not.toContain("frobnicate");
});
it("times the stages of a standing command up to its step-up, and its audit", async () => {
  await run(w.actors.phone, ["register", "board-b", "/path/to/project-b"]);
  const stage = (name: string) => hist(s(), "swarm_os_command_stage_seconds", { command: "register", stage: name, outcome: "ok" })?.count;
  expect(["cooling", "limits", "stepup", "run", "audit"].map(stage)).toEqual([1, 1, 1, undefined, 1]);
  expect(JSON.stringify(s())).not.toContain("/path/to/project-b");
});
it("is a query command that needs no step-up", async () => {
  expect(COMMAND_KINDS.metrics).toBe("query");
  registerMetricsCommand(source(), w.commands);
  expect(await run(w.actors.phone, ["metrics"])).toMatchObject({ ok: true });
  expect([w.hub.published.filter((e) => e.type === "stepup"), w.stepUps.issued]).toEqual([[], []]);
});
it("posts the brain's summary and each live instance's three largest sinks into the room it was issued in", async () => {
  registerMetricsCommand(source(), w.commands);
  await w.store.instances.patch("inst-b", { state: "exited" });
  const r = await run(w.actors.phone, ["metrics"], w.roomOf("inst-a"));
  const text = metricsReply({ brain: BRAIN, uptimeSeconds: 3_600, instances: [{ id: "inst-a", label: "board-a:42", snapshot: INST_A }] });
  expect(r).toEqual({ ok: true, text, data: { prefix: null, instances: ["inst-a"] } });
  expect(text.startsWith(`Brain · up ${formatDuration(3_600)}\n${formatSummary(BRAIN, { wallSeconds: 3_600, top: 10 })}`)).toBe(true);
  expect(text).toContain(`Instance inst-a · board-a:42\n${formatTopSinks(topSinks(INST_A, 3))}`);
  expect(text).not.toContain("inst-b");
  expect((await w.messagesIn(w.roomOf("inst-a"))).at(-1)).toMatchObject({ kind: "system", body: text });
});
it("keeps one area on the brain and on each instance, tries os_<area> for a bare word, and says when nothing matches", async () => {
  registerMetricsCommand(source(), w.commands);
  const http = await run(w.actors.phone, ["metrics", "os_http"]);
  expect(await run(w.actors.phone, ["metrics", "http"])).toEqual(http);
  expect([http.text.includes("swarm_os_http_request_seconds"), http.text.includes("swarm_os_command_seconds")]).toEqual([true, false]);
  expect((await run(w.actors.phone, ["metrics", "run"])).text).toContain("swarm_run_phase_seconds");
  expect(await run(w.actors.phone, ["metrics", "nothing"])).toEqual({ ok: true, text: "No metrics under swarm_nothing_." });
  expect(refusalCode(await run(w.actors.phone, ["metrics", "../etc"]))).toBe("bad_request");
});
it("gives each command's run the brain's handle as ctx.metrics", async () => {
  let seen: unknown;
  registerCommand({ name: "doctor", kind: "operating", summary: "doctor: check the brain", args: z.object({}), run: async (ctx) => { seen = ctx.metrics; return { ok: true, text: "ok" }; } }, w.commands);
  await run(w.actors.phone, ["doctor"]);
  expect(seen).toBe(registry);
});
it("replaces an earlier metrics spec in the list, so a brain started again in one process reads its own source", async () => {
  registerMetricsCommand(source({ uptimeSeconds: () => 1 }), w.commands);
  registerMetricsCommand(source({ uptimeSeconds: () => 7_200 }), w.commands);
  expect(w.commands.filter((c) => c.name === "metrics")).toHaveLength(1);
  expect((await run(w.actors.phone, ["metrics"])).text).toContain(formatSummary(BRAIN, { wallSeconds: 7_200, top: 10 }));
});
it("mountMessaging hands its metrics to Messaging, registers metrics when given a source, and sets the subscription gauge", async () => {
  const world = await makeWorld();
  const host = { store: world.store, config: world.config, clock: world.clock, log: world.log, hub: world.hub, server: { route: () => {} } as never,
    periodic: () => {}, standingRunners: { fallback: () => {} } as never, authHooks: { onNewAddress: async () => {}, onStepUpFailed: async () => {} },
    stepUps: testStepUps(world.store, world.clock), lockdown: { active: () => false }, metrics: registry, metricsSource: source() };
  const parts = await createMessaging(host);
  mountMessaging(host, parts, { runtime: () => ({}) as never, precedent: () => ({ lookup: async () => null }) });
  await vi.waitFor(() => expect(gauge(s(), "swarm_os_push_subscriptions")).toBe(3));
  await parts.messaging.post({ roomId: world.roomOf("inst-b"), from: world.refs.workerB, kind: "text", body: "hi", provenance: { source: "worker" } });
  expect([counter(s(), "swarm_os_messaging_posts_total", { room_kind: "instance" }), COMMANDS.some((c) => c.name === "metrics")]).toEqual([1, true]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd packages/os && npx vitest run tests/metrics/messaging-metrics.test.ts tests/metrics/command-metrics.test.ts tests/commands/registry.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/commands/metrics-command.js"`, `COMMAND_KINDS` has 35 names, and the other assertions find no series.

- [ ] **Step 3: Implement, recording each row where its table line says**

- `redact.ts`: before each pattern's `replace`, count its matches with `text.match(pattern)?.length` and call `onMatch(name)` that many times, so the `$1` replacements stay as they are. `redactDeep` passes `onMatch` down. Both default to no callback, so the logger and plan 02's callers are unchanged.
- `messaging.ts`: `deps.metrics ?? noopMetrics`. The private store-and-publish step (Task 5's split of `post`) runs under a span of `swarm_os_messaging_post_seconds` labelled with the room's kind (`missing` when the room is not found, ended `error`), times the redaction with `time("swarm_os_messaging_redact_seconds", {}, …)`, and after the `put` counts the post and observes `Buffer.byteLength(row.body)`. `ask`, `answer` and `expireQuestions` move the questions gauge and observe the open seconds as the table says, and the one place that calls the `onQuestion` listeners also counts `swarm_os_messaging_question_changes_total{change}`. Push goes through `deliverPush` with the same `metrics`.
- `subscriptions.ts`: `deliverPush` spans each send and ends it `sent`, `gone` or `failed`; a failure counts `swarm_os_push_failures_total` with `String(err.statusCode)` when the error is a `PushError` carrying a status from 400 to 599, else `none`. After a `gone`, and in `savePushSubscription` and `clearPushSubscription`, set the gauge from `countPushSubscriptions(store)`.
- `registry.ts`: `COMMAND_KINDS` gains `metrics: "operating"` (36 names). `registerBuiltinCommands` does not register it: it needs a source, so `mountMessaging` does. `CommandContext` gains the optional `metrics`; it is optional so that every context other plans build stays valid.
- `executor.ts`: the pipeline's labels come from step 1 (`command` is the spec's name, or `unknown` when there is none; `kind` the spec's, or `none`); a span of `swarm_os_command_seconds` covers steps 1 to 9 and ends with the outcome; a refusal counts `swarm_os_command_refusals_total`; the cool-down read, the limit gate, the step-up, `spec.run` and the audit each run under `time("swarm_os_command_stage_seconds", { command, stage }, …)` (a stage that throws still records `error` and rethrows as before). No argv word, room id or step-up id becomes a label. `spec.run` receives `{ ...ctx, metrics: ctx.metrics ?? metrics }`.
- `routes.ts`: `contextFor` sets `metrics: deps.metrics ?? noopMetrics`. `GET /api/questions/:id` spans `swarm_os_messaging_long_poll_seconds`: `immediate` when the question is not `open` at the first read, `changed` when the listener fires, `timeout` when `longPollMs` passes. The push routes pass `deps.metrics` to `savePushSubscription` and `clearPushSubscription`.
- `metrics-command.ts` to the Interfaces and rules above; `run` reads the board name with `store.boards.get(row.boardId)`.
- `install.ts`: `createMessaging` gives `host.metrics` to `Messaging`; `mountMessaging` gives it to `Tripwires`, `CommandExecutor` and `messagingRoutes`, calls `registerMetricsCommand(host.metricsSource)` when the host has one, and sets `swarm_os_push_subscriptions` once from `countPushSubscriptions` (not awaited; a failure is logged). Wherever the brain builds the `MessagingHost` from its `BrainContext` (the `messagingBrainModule` the overview's rulings ask this plan to export), it passes `metrics: ctx.metrics` and `metricsSource: ctx.brainMetrics`, so the running brain has the `metrics` command.
- The test helpers: `makeWorld({ metrics })` hands it to `Messaging`; `makeCommandWorld({ metrics })` hands it to `makeWorld` and to the executor.
- Append the entries above in the plan 05 slot of `packages/metrics/src/catalogue/os.ts`, and add `countPushSubscriptions`, `metricsCommand`, `registerMetricsCommand`, `metricsReply`, `METRICS_SUMMARY` and the `MetricsSource` type to the plan 05 block of `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run tests/metrics/messaging-metrics.test.ts tests/metrics/command-metrics.test.ts tests/commands/registry.test.ts`
Expected: PASS, 5, 8 and the registry file's tests.

- [ ] **Step 5: Run the package suites and the build**

Run: `cd packages/os && npx vitest run && cd ../metrics && npx vitest run && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build`
Expected: every test passes, Tasks 1 to 14's included and plan 10's `catalogue.test.ts`; the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/messaging packages/os/src/push packages/os/src/commands packages/os/src/index.ts packages/metrics/src/catalogue/os.ts packages/os/tests/helpers/world.ts packages/os/tests/helpers/commands.ts packages/os/tests/metrics/messaging-metrics.test.ts packages/os/tests/metrics/command-metrics.test.ts packages/os/tests/commands/registry.test.ts
git -c commit.gpgsign=false commit -m "feat(os): measure messages, questions, push and commands, and the metrics chat command"
```
