# Swarm OS 08: `swarm top`, the `swarm os` Commands and CLI Commands as Room Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `swarm top`, a terminal client with the dashboard's layout; the `swarm os` command subcommands with terminal sign-in; the brain's registration commands; and the CLI-as-functions refactor that lets any room run `sync`, `logs`, `skill`, `mcp`, `substrate status`, `substrate stop`, `doctor`, `merge`, `db reset`, `upgrade` and `uninstall`.

**Architecture:** The TUI lives in `packages/os/src/tui/`. A pure core turns brain events and keys into state (`state.ts`, `keys.ts`, `step-up.ts`) and state into exactly `rows` strings of `columns` cells (`render.ts`). A thin shell (`screen.ts`, `app.ts`) owns the alternate screen, raw mode, resize and a 10 fps render scheduler. `client.ts` and `credentials.ts` are the terminal's client of the brain: events come down `GET /api/stream?rooms=all` through plan 03's `openEventStream`, and everything goes up as plain HTTP. `swarm top` (`packages/cli/src/cli/top.ts`) and `swarm os …` (`packages/cli/src/cli/os-commands.ts`) share that client, and terminal sign-in is a device grant: `swarm os login` polls `GET /api/auth/cli/:nonce` until a signed-in dashboard calls `POST /api/auth/cli/:nonce/approve` (`packages/os/src/api/cli-login.ts`). `packages/os` never depends on `packages/cli`, so CLI-backed commands live entirely in `packages/cli/src/cli/as-function/`. Each descriptor wraps an existing `run*` function. `withCapturedProcess` routes its console, stdout, stderr and `process.exit` through an `AsyncLocalStorage`, restores env and cwd afterwards, and runs one command at a time. `prepareProjectEnv` is the in-process stand-in for main.ts's project-Substrate preamble. `room.ts` turns each descriptor into a `CommandSpec` whose I/O is the room. `swarm os start` hands those specs to the brain with `Brain.start(config, { commands: cliBackedCommands() })`, together with the registration commands from `packages/os/src/commands/registrations.ts`, and plan 03 registers them through plan 05's `registerCommand`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `module: Node18`), vitest (default `forks` pool, because `process.chdir` is unavailable in worker threads), Node built-ins only for the terminal (`node:readline` keypress decoding, `setRawMode`, `process.stdout`, `node:async_hooks` `AsyncLocalStorage`, `node:http` for the test brain), plan 03's SSE client, global `fetch`, zod (already in `packages/os`), `@clack/prompts` (already in the CLI).

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md` (sections "Clients", "Commands are messages", "Threat model"), with the shared contracts in `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md` ("Transport", "Brain API", "Messaging and commands"). Where this plan and the spec disagree, the spec wins.

## Global Constraints

- The overview's contracts are used verbatim: `Actor`, the routes and status codes under "Brain API", the stream events under "Transport", and `CommandSpec`, `CommandContext`, `CommandResult`, `COMMANDS`, `parseCommand` and the command table's names and kinds. Plan 08 adds only what its tasks' **Produces** blocks name.
- Transport is SSE down and HTTP up. Plan 08 opens no WebSocket and adds no `ws` use. The TUI reads `GET /api/stream?rooms=all` through plan 03's `openEventStream`. It sends with `POST /api/rooms/:id/messages`, `POST /api/questions/:id/answer`, `POST /api/commands` and `POST /api/stepup/confirm`. Every POST carries `X-Swarm-Os: 1`, and `POST /api/commands` and `POST /api/rooms/:id/messages` also carry an `Idempotency-Key`.
- Standing commands go through the executor's step-up every time. The only plan-08 code that calls `POST /api/stepup/confirm` is the TUI's Enter on a step-up it was shown. `swarm os <command>` sends `stepUpId` and `code` only when the person passes `--stepup` and `--code`.
- A step-up code is displayed only from a `stepup` event, in the TUI. `swarm os <command>` never prints one, whatever the brain's reply contains.
- The host secret (`<os_home>/host.secret`, sent as `Bearer host_<secret>`) goes only to a loopback brain URL (127.0.0.0/8, `::1`, `localhost`).
- No Ink, no blessed and no new dependency of any kind in `packages/os` or `packages/cli`; nothing native or wasm.
- `packages/os` never imports `packages/cli`, because `packages/cli` already imports `@mnmal-ai/swarm-os`. Command specs built from CLI code reach the brain only through `Brain.start(config, { commands })` in `swarm os start`.
- main.ts keeps the form plans 01 and 03 give it: `room-mcp`, `os` and `top` are early returns before the Substrate bootstrap, not switch cases. Plan 08's main.ts edits, which move the flag parser and the `sync` body, leave them as they are.
- No `console.*` in `packages/os/src`. The TUI writes to the stdout it is given, and the brain logs with `createLogger`.
- Output that a CLI-backed command sends to a room is ANSI-stripped, passed through `redactSecrets` (plan 05) and capped at 16 000 characters.
- Commands run from a room act only on a registered project's directories. A room may not pass `--swarm-path`, `--repo-path`, `--dir`, `--yes` or `-y`. A command with no project runs in a fresh empty directory, never in the brain's working directory.
- In a terminal every existing command behaves exactly as before: a prompt seam falls through to the original prompt when no command I/O is active. `cd packages/cli && npx vitest run` stays green after every task.
- Anonymity: no personal names, client names, hostnames or home-directory paths in code, tests, fixtures or docs. Use `owner`, `board-a`, `project-a`, `host-a`, `/path/to/project-a`, `https://brain.example.test`.
- Tests never touch the real `~/.swarm`. They point `HOME` and `SWARM_OS_HOME` at temp directories, bind only `127.0.0.1:0`, and run with `ANTHROPIC_API_KEY` unset.
- No new GitHub workflows and no trigger changes.
- File ownership. Plan 08 creates the overview's plan-08 paths. It also creates these carve-outs, each a new file inside another plan's directory, as plan 07 does with `static.ts`: `packages/os/src/api/cli-login.ts`, `packages/os/src/commands/registrations.ts`, `packages/os/src/commands/argv-args.ts`, `packages/cli/src/cli/args.ts` and `packages/cli/src/cli/sync.ts`. It edits other plans' files only at these touch points:
  - in plan 03's `os.ts`, one import and one guard line (Task 8) and one `Brain.start` argument (Task 14)
  - in plan 03's composition root, one `mountCliLogin` call (Task 1)
  - in `packages/os/src/index.ts`, its own `// plan 08` block
  - main.ts, `db.ts`, `skill.ts` and `uninstall.ts`, exactly where Tasks 8, 10, 12 and 13 say
- Tests for `packages/os` live in `packages/os/tests/` and import sources by relative path. Tests for `packages/cli` live in `packages/cli/tests/` and import `@mnmal-ai/swarm-os`, so build it first with `pnpm --filter @mnmal-ai/swarm-os build`.
- **Task gate**, the last step of every task: `pnpm turbo build --filter=@mnmal-ai/swarm-os --filter=@mnmal-ai/swarm-cli && cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run && cd ../cli && env -u ANTHROPIC_API_KEY npx vitest run`. Expected: both builds exit 0 and every test file passes.

## Review Focus

1. **A multi-line paste into the TUI's input line.** Expected: the paste lands as one line, with newlines turned into spaces, and nothing is sent until the person presses Enter. Pinned in Task 6 (`a paste with newlines inserts one line and sends nothing`).
2. **The brain restarts, or the network drops, while `swarm top` is open.** Expected: the top line says offline. A line typed meanwhile stays in the input, and a send that fails puts its line back. On reconnect the stream resumes from `Last-Event-ID`: a `gap` refills from REST, and replayed instance events older than the fresh `hello` cannot roll the table back. Pinned in Task 2 (`reconnects with Last-Event-ID`), Task 3 (`ignores replayed instance…`, `a gap marks…`, `puts a line that could not be sent back`) and Task 6 (`Enter while offline keeps the line`).
3. **An operating command whose flags would destroy something or reach outside the project.** `/sync --force` wipes the cold store. `/skill add /some/file` copies any readable file into the store, and `/skill show` would then print it to the room. Expected: refused with the reason and the command to use instead; nothing runs. Pinned in Task 12.
4. **Two CLI-backed commands for different projects at once, or one that applies a dedicated stack's env.** Expected: they run one after the other, and the second command and the brain itself see env and cwd as they were before the first. Pinned in Task 10 (`runs one capture at a time`, `restores process.env exactly`) and Task 12 (`applies a dedicated project's stack for the run only`).
5. **Wide characters (CJK, emoji) in a message or a room name.** Expected: the pane border stays in its column and every row stays exactly the terminal's width. Pinned in Task 4 (`wide characters keep every row exactly columns wide`).

---

### Task 1: Terminal sign-in routes in the brain

A terminal cannot run WebAuthn, so `swarm os login` uses a device grant. The terminal invents a nonce and a poll secret and polls with them. A signed-in person opens `<public_url>/#cli-login=<nonce>` and approves. The brain then mints an ordinary `sess_…` session for the approver's human and device, bound to the address of the terminal that collects it.

**Files:**
- Create: `packages/os/src/api/cli-login.ts`
- Create: `packages/os/tests/helpers/world.ts`
- Modify: plan 03's composition root in `packages/os/src/brain/`, where `mountDispatch` (plan 04) and `registerWebRoutes` (plan 07) are called. Add one call: `mountCliLogin(server, new CliLogins({ store, messaging, clock, publicUrl: config.public_url, issueSession }))`.
- Modify: `packages/os/src/index.ts` (open the `// plan 08` block)
- Test: `packages/os/tests/api/cli-login.test.ts`

**Interfaces:**
- Consumes: `Actor` (overview). Plan 03's session issuer, the function its `POST /api/auth/login/verify` uses to write a `Session` row and mint its `sess_` bearer, wrapped to the shape of `issueSession` below. From plan 02: `OsStore` and `newId`; from `packages/os/src/testing/index.ts`: `MemoryOsStore`, `FakeClock` (`new FakeClock(start: Date)`, `now(): Date`, `advance(ms)`), `FakeLauncher` and `makeConfig(overrides)`. From plan 05: `Messaging` (`openRoom`, and `post` with `from: { id: string; kind: MessageRow["fromKind"] }`, the shape plan 04 also assumes) and `CommandContext`.
- Produces:

```ts
// packages/os/src/api/cli-login.ts
export const CLI_LOGIN_TTL_MS = 600_000;
export const CLI_LOGIN_POLL_MS = 2_000;
export const CLI_LOGIN_MAX_PENDING = 100;
export function isCliNonce(value: string): boolean;            // 43 characters of [A-Za-z0-9_-]: 32 random bytes, base64url
export function cliLoginApproveUrl(publicUrl: string, nonce: string): string;   // `${publicUrl without trailing "/"}/#cli-login=${nonce}`
export interface CliLoginPoll { nonce: string; pollSecret: string | undefined; address: string }   // pollSecret: the X-Swarm-Os-Poll header
export interface CliLoginReply { status: number; body: unknown }
export interface CliLoginDeps {
  store: OsStore; messaging: Messaging; clock: Clock; publicUrl: string;
  issueSession(input: { humanId: string; deviceId: string; address: string }): Promise<{ token: string; expiresAt: string }>;
}
export class CliLogins {
  constructor(deps: CliLoginDeps);
  poll(input: CliLoginPoll): Promise<CliLoginReply>;
  approve(nonce: string, actor: Actor | null): Promise<CliLoginReply>;
}
export interface CliLoginRoute { method: "GET" | "POST"; path: string; auth: "none" | "human"; handle(req: { params: Record<string, string>; headers: Record<string, string | undefined>; actor: Actor | null; address: string }): Promise<CliLoginReply> }
export function cliLoginRoutes(logins: CliLogins): CliLoginRoute[];   // GET /api/auth/cli/:nonce (none), POST /api/auth/cli/:nonce/approve (human)
export interface CliLoginServer { mount(route: CliLoginRoute): void }  // the composition root adapts plan 03's router: request → { params, lower-cased headers, actor, address as plan 03 computes Actor.address }
export function mountCliLogin(server: CliLoginServer, logins: CliLogins): void;
// packages/os/tests/helpers/world.ts
export const OWNER: Extract<Actor, { kind: "human" }>;     // part-owner, sess-1, dev-1, 127.0.0.1, confirmer false
export function newWorld(config?: Parameters<typeof makeConfig>[0]): Promise<{ store: MemoryOsStore; clock: FakeClock; messaging: Messaging; system: RoomRow; dir: string; config: OsConfig; ctx(roomId: string, actor?: Actor): CommandContext }>;
```

Replies, exactly. Error bodies are `{ error: { code, message, …extra } }`:

| call | condition | status and body |
|---|---|---|
| poll | malformed nonce | 400 `bad_request` "The sign-in nonce must be 43 base64url characters." |
| poll | missing or malformed poll secret | 400 `bad_request` "The X-Swarm-Os-Poll header must carry 43 base64url characters." |
| poll | first poll of a nonce while fewer than 100 are waiting | 202 `{ state: "pending", expiresAt, intervalMs: 2000, approveUrl }`; the nonce is now bound to the secret's SHA-256 |
| poll | first poll while 100 are waiting | 429 `limit` "Too many terminal sign-ins are waiting; try again in a few minutes.", `limit: "cli_logins_pending"` |
| poll | a different secret than the first poll's | 404 `not_found` "No terminal is waiting for this sign-in.", `reason: "unknown"` |
| poll | pending | 202 as above |
| poll | approved | mint with the poll's `address`; 200 `{ state: "approved", token, expiresAt, humanId, deviceId }`; the entry becomes consumed |
| poll | consumed | 404 `not_found` "This sign-in was already collected.", `reason: "consumed"` |
| poll or approve | more than `CLI_LOGIN_TTL_MS` after the first poll, not collected | 404 `not_found` "This sign-in expired before it was approved.", `reason: "expired"` |
| approve | actor not `human` | 403 `forbidden` "Only a signed-in person can approve a terminal sign-in." |
| approve | nonce never polled | 404 `not_found` "No terminal is waiting for this sign-in.", `reason: "unknown"` |
| approve | already approved or consumed | 409 `conflict` "This sign-in is already approved." |
| approve | pending | 200 `{ ok: true }` |

- [ ] **Step 1: Write the test helper and the failing test**

```ts
// packages/os/tests/helpers/world.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "../../src/index.js";
import type { CommandContext } from "../../src/commands/registry.js";
import { Messaging } from "../../src/messaging/messaging.js";
import { FakeClock, FakeLauncher, MemoryOsStore, makeConfig } from "../../src/testing/index.js";

export const OWNER = { kind: "human", humanId: "part-owner", sessionId: "sess-1", deviceId: "dev-1", address: "127.0.0.1", confirmer: false } as const;

export async function newWorld(config: Parameters<typeof makeConfig>[0] = {}) {
  const store = new MemoryOsStore();
  const clock = new FakeClock(new Date("2026-10-25T09:00:00.000Z"));
  const messaging = new Messaging({ store, clock });   // the one place to adapt if plan 05's constructor also takes the hub (pass new FakeEventHub())
  const system = await messaging.openRoom("system", null, "system", [], "normal");
  const dir = mkdtempSync(join(tmpdir(), "plan08-"));
  const cfg = makeConfig({ owners: [{ id: "owner", name: "owner" }], ...config });
  const ctx = (roomId: string, actor: Actor = OWNER): CommandContext => ({
    actor, roomId, store, messaging, clock, config: cfg, launcher: new FakeLauncher(),
    dispatcher: {} as CommandContext["dispatcher"], provenance: { source: "owner" },
  });
  return { store, clock, messaging, system, dir, config: cfg, ctx };
}
```

```ts
// packages/os/tests/api/cli-login.test.ts
import { describe, expect, it, vi } from "vitest";
import { CLI_LOGIN_MAX_PENDING, CLI_LOGIN_TTL_MS, CliLogins, cliLoginRoutes, isCliNonce } from "../../src/api/cli-login.js";
import { OWNER, newWorld } from "../helpers/world.js";

const NONCE = "n".repeat(43);
const SECRET = "s".repeat(43);
const poll = (over: Partial<{ nonce: string; pollSecret: string | undefined; address: string }> = {}) =>
  ({ nonce: NONCE, pollSecret: SECRET, address: "127.0.0.1", ...over });

async function setup() {
  const w = await newWorld();
  const issueSession = vi.fn(async () => ({ token: "sess_terminal", expiresAt: "2026-10-26T09:00:00.000Z" }));
  const logins = new CliLogins({ store: w.store, messaging: w.messaging, clock: w.clock, publicUrl: "https://brain.example.test/", issueSession });
  const audit = async () => (await w.store.messages.find({ roomId: w.system.id }, { orderBy: "seq" })).map((m) => m.body);
  return { ...w, logins, issueSession, audit };
}

describe("CliLogins", () => {
  it("registers a nonce on its first poll and answers pending with the approve link", async () => {
    const { logins } = await setup();
    expect(await logins.poll(poll())).toEqual({
      status: 202,
      body: { state: "pending", expiresAt: "2026-10-25T09:10:00.000Z", intervalMs: 2000, approveUrl: `https://brain.example.test/#cli-login=${NONCE}` },
    });
  });

  it("mints the session for the collecting terminal's address only after a human approves, hands it out once, and audits both steps", async () => {
    const { logins, issueSession, audit } = await setup();
    await logins.poll(poll());
    expect(await logins.approve(NONCE, OWNER)).toEqual({ status: 200, body: { ok: true } });
    expect(issueSession).not.toHaveBeenCalled();
    expect(await logins.poll(poll({ address: "100.64.0.7" }))).toEqual({
      status: 200,
      body: { state: "approved", token: "sess_terminal", expiresAt: "2026-10-26T09:00:00.000Z", humanId: "part-owner", deviceId: "dev-1" },
    });
    expect(issueSession).toHaveBeenCalledWith({ humanId: "part-owner", deviceId: "dev-1", address: "100.64.0.7" });
    expect(await logins.poll(poll())).toEqual({ status: 404, body: { error: { code: "not_found", message: "This sign-in was already collected.", reason: "consumed" } } });
    expect(await audit()).toEqual([
      "Terminal sign-in approved by part-owner on device dev-1.",
      "Terminal sign-in for part-owner collected from 100.64.0.7.",
    ]);
  });

  it("never hands the token to a poller without the first poll's secret", async () => {
    const { logins } = await setup();
    await logins.poll(poll());
    await logins.approve(NONCE, OWNER);
    expect((await logins.poll(poll({ pollSecret: "t".repeat(43) }))).status).toBe(404);
    expect((await logins.poll(poll())).status).toBe(200);
  });

  it("takes approval only from a human session, once", async () => {
    const { logins } = await setup();
    await logins.poll(poll());
    expect((await logins.approve(NONCE, { kind: "cos" })).status).toBe(403);
    expect((await logins.approve(NONCE, null)).status).toBe(403);
    expect((await logins.approve("m".repeat(43), OWNER)).status).toBe(404);
    expect((await logins.approve(NONCE, OWNER)).status).toBe(200);
    expect((await logins.approve(NONCE, OWNER)).status).toBe(409);
  });

  it("expires a sign-in ten minutes after its first poll", async () => {
    const { logins, clock } = await setup();
    await logins.poll(poll());
    clock.advance(CLI_LOGIN_TTL_MS + 1);
    const expired = { status: 404, body: { error: { code: "not_found", message: "This sign-in expired before it was approved.", reason: "expired" } } };
    expect(await logins.approve(NONCE, OWNER)).toEqual(expired);
    expect(await logins.poll(poll())).toEqual(expired);
  });

  it("caps the sign-ins waiting at once and rejects malformed nonces and secrets", async () => {
    const { logins } = await setup();
    for (let i = 0; i < CLI_LOGIN_MAX_PENDING; i++) await logins.poll(poll({ nonce: String(i).padStart(43, "x") }));
    expect((await logins.poll(poll({ nonce: "z".repeat(43) }))).body).toMatchObject({ error: { code: "limit", limit: "cli_logins_pending" } });
    expect((await logins.poll(poll({ nonce: "short" }))).status).toBe(400);
    expect((await logins.poll(poll({ nonce: "y".repeat(43), pollSecret: undefined }))).status).toBe(400);
    expect(isCliNonce(NONCE)).toBe(true);
    expect(isCliNonce("a".repeat(42) + "/")).toBe(false);
  });

  it("declares the two routes with their auth", async () => {
    const { logins } = await setup();
    expect(cliLoginRoutes(logins).map((r) => [r.method, r.path, r.auth])).toEqual([
      ["GET", "/api/auth/cli/:nonce", "none"],
      ["POST", "/api/auth/cli/:nonce/approve", "human"],
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/api/cli-login.test.ts`
Expected: FAIL. `../../src/api/cli-login.js` does not exist yet.

- [ ] **Step 3: Implement `packages/os/src/api/cli-login.ts`**

Keep pending entries in a `Map` in memory. A lost sign-in is simply run again; the session it yields is a store row, written by the issuer. Each entry holds `secretHash`, `firstPolledAt`, `expiresAt` and `state` (`pending | approved | consumed`), plus the approver's `{ humanId, deviceId }`. Every call first sweeps entries more than one TTL past their expiry. Expired and consumed entries do not count toward the cap. Compare secret hashes with `timingSafeEqual`. Post the audit lines from `{ id: "system", kind: "system" }`, kind `system`, `provenance { source: "system" }`, in the room `store.rooms.find({ kind: "system" })` returns. With no system room, skip the post. The GET route reads `headers["x-swarm-os-poll"]` and passes it as `pollSecret`. The POST route passes `req.actor`.

- [ ] **Step 4: Mount the routes and export**

In plan 03's composition root, add the one call shown under **Files**. Its `CliLoginServer` adapter is the three lines that turn plan 03's request into `{ params, headers, actor, address }`. Append to `packages/os/src/index.ts`:

```ts
// --- plan 08: terminal sign-in, TUI, registration and CLI-backed commands ---
export * from "./api/cli-login.js";
```

- [ ] **Step 5: Run the test, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/api/cli-login.test.ts`
Expected: PASS (7 tests). Then run the task gate.

- [ ] **Step 6: Commit**

```bash
git add packages/os/src/api/cli-login.ts packages/os/tests/helpers/world.ts packages/os/tests/api/cli-login.test.ts packages/os/src/index.ts packages/os/src/brain
git commit -m "feat(os): terminal sign-in routes for swarm os login"
```

---

### Task 2: The terminal's client: credentials, HTTP and the event stream

**Files:**
- Create: `packages/os/src/tui/credentials.ts`, `packages/os/src/tui/client.ts`, `packages/os/src/tui/index.ts`
- Create: `packages/os/tests/tui/fake-brain.ts`
- Modify: `packages/os/src/index.ts` (plan 08 block)
- Test: `packages/os/tests/tui/credentials.test.ts`, `packages/os/tests/tui/client.test.ts`

**Interfaces:**
- Consumes: `openEventStream` and `EventStreamHandle` from `packages/os/src/sse/client.ts` (plan 03). This plan relies on it reconnecting with `Last-Event-ID`, calling `onOpen` on every connect and `onError` once per failed attempt or dropped stream, and passing `fetchImpl` and `backoffMs` through. `loadOsConfig()` (plan 03; throws when `os.json` is missing or invalid). The row types `RoomRow`, `MessageRow`, `InstanceRow`, `QuestionRow` and `DispatchDecisionRow` (plan 02). `ResourceSnapshot` (plan 04), `CommandResult` (plan 05) and `Actor`. The routes: `GET /api/stream`, `GET /api/rooms`, `GET /api/rooms/:id/messages`, `POST /api/rooms/:id/messages`, `POST /api/questions/:id/answer`, `POST /api/commands`, `POST /api/stepup/confirm`, and Task 1's `GET /api/auth/cli/:nonce`.
- Produces:

```ts
// packages/os/src/tui/credentials.ts
export const DEFAULT_BRAIN_URL = "http://127.0.0.1:3200";
export interface SessionFile { url: string; token: string; expiresAt: string; humanId: string; deviceId: string }
export interface BrainCredentials { url: string; bearer: string; actor: "host" | "session" }
export class NotSignedInError extends Error { readonly name: "NotSignedInError"; readonly url: string; readonly reason: "none" | "expired" | "other_brain" }
export function resolveOsHome(env?: NodeJS.ProcessEnv): string;                   // SWARM_OS_HOME, else ~/.swarm/os
export function isLoopbackUrl(url: string): boolean;
export function readSessionFile(osHome: string): SessionFile | null;              // null when absent or unparseable
export function writeSessionFile(osHome: string, session: SessionFile): void;     // dir 0700, file "session" 0600, temp file + rename
export function resolveBrainUrl(flagUrl: string | undefined, osHome: string, loadBind?: () => { host: string; port: number } | null): string;
export function resolveBrainCredentials(opts?: { url?: string; env?: NodeJS.ProcessEnv; now?: Date; loadBind?: () => { host: string; port: number } | null }): BrainCredentials;   // throws NotSignedInError
export function describeClientError(err: unknown, url: string): string | null;
// packages/os/src/tui/client.ts
export type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type WireRoom = Wire<RoomRow>; export type WireMessage = Wire<MessageRow>; export type WireQuestion = Wire<QuestionRow>;
export type WireInstance = Wire<InstanceRow> & { phase?: string; currentTask?: string | null };   // rendered when present (the spec's instance line)
export interface PendingStepUp { stepUpId: string; command: string[]; expiresAt: string; code: string }
export type BrainEvent = { id: number | null } & (
  | { type: "hello"; actor: Actor; rooms: WireRoom[]; instances: WireInstance[]; resources: ResourceSnapshot | null; cooldownUntil?: string | null; lockdown: boolean; stepUps?: PendingStepUp[] }
  | { type: "message"; message: WireMessage } | { type: "instance"; instance: WireInstance } | { type: "decision"; decision: Wire<DispatchDecisionRow> }
  | { type: "question"; question: WireQuestion } | { type: "resources"; snapshot: ResourceSnapshot }
  | ({ type: "stepup" } & PendingStepUp) | { type: "cooldown"; cooldownUntil: string | null } | { type: "lockdown"; active: boolean } | { type: "gap" });
export function toBrainEvent(e: { id: number | null; type: string; data: unknown }): BrainEvent | null;   // zod-checked; anything else → null
export type ConnectionStatus = { state: "connecting" } | { state: "open" } | { state: "offline"; message: string } | { state: "signed_out" };
export type CommandOutcome =
  | { kind: "ok"; result: CommandResult } | { kind: "failed"; result: CommandResult }
  | { kind: "stepup_required"; stepUpId: string; expiresAt: string | null }
  | { kind: "cooldown"; cooldownUntil: string | null; message: string } | { kind: "limit"; limit: string; message: string }
  | { kind: "forbidden"; code: string; message: string };
export function classifyCommandReply(status: number, body: unknown): CommandOutcome;   // 200 → ok | failed; 428, 429, 403 as named; anything else throws BrainHttpError
export class BrainUnreachableError extends Error { readonly url: string }
export class BrainHttpError extends Error { readonly status: number; readonly code: string }
export const STREAM_FAILURES_BEFORE_PROBE = 3;
export class BrainClient {
  constructor(opts: { url: string; bearer: string; fetch?: typeof fetch; streamBackoffMs?: [number, number] });
  connect(handlers: { onEvent(e: BrainEvent): void; onStatus(s: ConnectionStatus): void }): void;
  close(): void;
  listRooms(): Promise<WireRoom[]>;                                                         // body WireRoom[] or { rooms }
  roomMessages(roomId: string, opts?: { beforeSeq?: number; limit?: number }): Promise<WireMessage[]>;   // limit default 200; body WireMessage[] or { messages }
  postMessage(roomId: string, body: string, replyTo?: string): Promise<void>;               // { kind: "text", body, replyTo? }
  answerQuestion(questionId: string, body: string): Promise<void>;
  postCommand(room: string, argv: string[], stepUp?: { stepUpId: string; code: string }): Promise<CommandOutcome>;
  confirmStepUp(stepUpId: string, code: string): Promise<void>;
}
export function pollCliLogin(url: string, nonce: string, pollSecret: string, fetchImpl?: typeof fetch): Promise<{ status: number; body: unknown }>;
// packages/os/tests/tui/fake-brain.ts
export interface Recorded { method: string; path: string; query: string; headers: Record<string, string | string[] | undefined>; body: unknown }
export type Route = (req: Recorded) => { status: number; body?: unknown };
export interface FakeBrain { url: string; requests: Recorded[]; send(type: string, payload: unknown): void; dropStreams(): void; setStreamStatus(status: number | null): void; close(): Promise<void> }
export function startFakeBrain(routes: Record<string, Route>, opts?: { hello?: () => unknown }): Promise<FakeBrain>;
```

Rules:
- **URL:** the flag, else `os.json`'s bind (read through `loadOsConfig().bind`, with `0.0.0.0` and `::` read as `127.0.0.1`), else the session file's `url`, else `DEFAULT_BRAIN_URL`. Strip trailing slashes.
- **Credentials:** on a loopback URL with a non-empty `<os_home>/host.secret`, use `host_<trimmed contents>`. Otherwise use the session file when its `url` equals the URL and `expiresAt` is in the future. Otherwise throw `NotSignedInError` with `expired`, `other_brain` or `none`.
- **Messages:** `describeClientError` returns this text, or `null` for anything else:
  - `NotSignedInError` `none`: "Not signed in to <url>. On the brain's host this happens by itself; anywhere else run: swarm os login --url <url>"
  - `expired`: "The terminal sign-in to <url> has expired. Run: swarm os login --url <url>"
  - `other_brain`: "This terminal is signed in to a different brain. Run: swarm os login --url <url>"
  - `BrainUnreachableError`: "No brain is answering at <url>. Start it on its host with: swarm os start"
  - `BrainHttpError` 401: "The brain at <url> refused this sign-in (expired or revoked). Run: swarm os login --url <url>"
- **`classifyCommandReply`:**
  - 200: `ok` or `failed`, by the result's `ok`.
  - 428: `stepup_required`, with `error.stepUpId` and `error.expiresAt ?? null`.
  - 429 with `error.code` `cooldown`: `cooldown`, with `error.cooldownUntil ?? null`.
  - 429 with `error.code` `limit`: `limit`, with `error.limit`.
  - 403: `forbidden`, with `error.code`.
  - Any other status throws `BrainHttpError(status, error.code, error.message)`.
- **Requests:** every request carries `Authorization: Bearer <bearer>`. Every POST also carries `Content-Type: application/json` and `X-Swarm-Os: 1`, and `POST /api/commands` and `POST /api/rooms/:id/messages` add `Idempotency-Key: crypto.randomUUID()`. A rejected `fetch` becomes `BrainUnreachableError`. A non-2xx reply, other than the command codes `classifyCommandReply` names, becomes `BrainHttpError(status, error.code, error.message)`.
- **Stream:** `connect` reports `connecting`, then calls `openEventStream(`${url}/api/stream?rooms=all`, …)`. `onOpen` reports `open` and resets the failure count. `onError` reports `offline` with the error's message, and on the third consecutive failure probes `listRooms()`. A `BrainHttpError` 401 or 403 from that probe closes the handle and reports `signed_out`.

- [ ] **Step 1: Write the test brain and the failing tests**

`startFakeBrain(routes, { hello })` (in `packages/os/tests/tui/fake-brain.ts`) runs `node:http` on `127.0.0.1:0`. It records every request: method, path, query string, lower-cased headers and the parsed JSON body.
- **`GET /api/stream`** answers `200` with `content-type: text/event-stream` and writes `retry: 3000\n\n`. When `hello` is given, it then writes `id: <n>\nevent: hello\ndata: <json>\n\n`, and keeps the response open.
- **`send(type, payload)`** writes the next event to every open stream. Event ids come from one counter that starts at 1.
- **`dropStreams()`** destroys the open streams.
- **`setStreamStatus(401)`** makes later stream requests get that status, with `{ error: { code: "unauthenticated" } }`.
- **Every other request** is answered as JSON by `routes["<METHOD> <path>"]`'s `{ status, body }`, or with `404 { error: { code: "not_found" } }`.
- **`close()`** destroys the streams and closes the server.

```ts
// packages/os/tests/tui/credentials.test.ts
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainHttpError, BrainUnreachableError } from "../../src/tui/client.js";
import { NotSignedInError, describeClientError, readSessionFile, resolveBrainCredentials, resolveBrainUrl, writeSessionFile } from "../../src/tui/credentials.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "os-home-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const env = () => ({ SWARM_OS_HOME: home }) as NodeJS.ProcessEnv;
const noBind = () => null;
const now = new Date("2026-10-25T09:00:00.000Z");
const session = (url: string, expiresAt = "2026-10-26T09:00:00.000Z") =>
  writeSessionFile(home, { url, token: "sess_abc", expiresAt, humanId: "part-owner", deviceId: "dev-1" });
const thrown = (fn: () => unknown) => { try { fn(); } catch (err) { return err as NotSignedInError; } throw new Error("did not throw"); };

describe("resolveBrainCredentials", () => {
  it("signs in as host on loopback when host.secret is readable", () => {
    writeFileSync(join(home, "host.secret"), "s3cret\n");
    expect(resolveBrainCredentials({ env: env(), now, loadBind: noBind })).toEqual({ url: "http://127.0.0.1:3200", bearer: "host_s3cret", actor: "host" });
  });
  it("never sends the host secret to a brain that is not on loopback", () => {
    writeFileSync(join(home, "host.secret"), "s3cret");
    session("https://brain.example.test");
    expect(resolveBrainCredentials({ url: "https://brain.example.test/", env: env(), now, loadBind: noBind }))
      .toEqual({ url: "https://brain.example.test", bearer: "sess_abc", actor: "session" });
  });
  it("refuses an expired session, a session for another brain, and no credentials", () => {
    const at = (url: string) => () => resolveBrainCredentials({ url, env: env(), now, loadBind: noBind });
    session("https://brain.example.test", "2026-10-25T08:00:00.000Z");
    expect(thrown(at("https://brain.example.test")).reason).toBe("expired");
    session("https://other.example.test");
    expect(thrown(at("https://brain.example.test")).reason).toBe("other_brain");
    rmSync(join(home, "session"));
    const none = thrown(at("https://brain.example.test"));
    expect(none).toBeInstanceOf(NotSignedInError);
    expect(none.reason).toBe("none");
  });
  it("takes the url from the flag, then os.json's bind, then the session file, then the default", () => {
    const bind = () => ({ host: "0.0.0.0", port: 3300 });
    expect(resolveBrainUrl("http://127.0.0.1:4000/", home, bind)).toBe("http://127.0.0.1:4000");
    expect(resolveBrainUrl(undefined, home, bind)).toBe("http://127.0.0.1:3300");
    session("https://brain.example.test");
    expect(resolveBrainUrl(undefined, home, noBind)).toBe("https://brain.example.test");
    rmSync(join(home, "session"));
    expect(resolveBrainUrl(undefined, home, noBind)).toBe("http://127.0.0.1:3200");
  });
  it("writes the session file 0600 inside a 0700 directory", () => {
    const dir = join(home, "nested");
    writeSessionFile(dir, { url: "https://brain.example.test", token: "sess_abc", expiresAt: "2026-10-26T09:00:00.000Z", humanId: "part-owner", deviceId: "dev-1" });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "session")).mode & 0o777).toBe(0o600);
    expect(readSessionFile(dir)?.token).toBe("sess_abc");
  });
  it("describes client errors in words a person can act on", () => {
    const url = "http://127.0.0.1:3200";
    expect(describeClientError(new NotSignedInError(url, "none"), url)).toBe(`Not signed in to ${url}. On the brain's host this happens by itself; anywhere else run: swarm os login --url ${url}`);
    expect(describeClientError(new BrainUnreachableError(url, new Error("ECONNREFUSED")), url)).toBe(`No brain is answering at ${url}. Start it on its host with: swarm os start`);
    expect(describeClientError(new BrainHttpError(401, "unauthenticated", "revoked"), url)).toBe(`The brain at ${url} refused this sign-in (expired or revoked). Run: swarm os login --url ${url}`);
    expect(describeClientError(new Error("other"), url)).toBeNull();
  });
});
```

```ts
// packages/os/tests/tui/client.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainClient, BrainHttpError, BrainUnreachableError, classifyCommandReply, toBrainEvent, type BrainEvent, type ConnectionStatus } from "../../src/tui/client.js";
import { startFakeBrain, type FakeBrain } from "./fake-brain.js";

let brain: FakeBrain | undefined;
afterEach(async () => { await brain?.close(); brain = undefined; });
const HELLO = { actor: { kind: "host" }, rooms: [{ id: "room-cos", kind: "cos", name: "chief of staff" }], instances: [], resources: null, lockdown: false };
const MSG = { message: { id: "msg-1", roomId: "room-cos", seq: 1, kind: "text", body: "hi" } };
const streams = () => brain!.requests.filter((r) => r.path === "/api/stream");

describe("toBrainEvent", () => {
  it("types the brain's events and drops anything else", () => {
    expect(toBrainEvent({ id: 7, type: "lockdown", data: { active: true } })).toEqual({ type: "lockdown", id: 7, active: true });
    expect(toBrainEvent({ id: 8, type: "stepup", data: { stepUpId: "su-1", command: ["db", "reset"], expiresAt: "2026-10-25T09:02:00.000Z", code: "482913" } })).toMatchObject({ type: "stepup", code: "482913" });
    expect(toBrainEvent({ id: 9, type: "stepup", data: { stepUpId: "su-1", command: ["db", "reset"], expiresAt: "2026-10-25T09:02:00.000Z" } })).toBeNull();
    expect(toBrainEvent({ id: 10, type: "message", data: { message: { id: "msg-1" } } })).toBeNull();
    expect(toBrainEvent({ id: 11, type: "gap", data: {} })).toEqual({ type: "gap", id: 11 });
    expect(toBrainEvent({ id: null, type: "nonsense", data: {} })).toBeNull();
  });
});

describe("classifyCommandReply", () => {
  it("maps the brain's status codes", () => {
    expect(classifyCommandReply(200, { ok: true, text: "held" })).toEqual({ kind: "ok", result: { ok: true, text: "held" } });
    expect(classifyCommandReply(200, { ok: false, text: "no such board" })).toEqual({ kind: "failed", result: { ok: false, text: "no such board" } });
    expect(classifyCommandReply(428, { error: { code: "stepup_required", message: "needs a step-up", stepUpId: "su-1" } })).toEqual({ kind: "stepup_required", stepUpId: "su-1", expiresAt: null });
    expect(classifyCommandReply(429, { error: { code: "cooldown", message: "cooling down", cooldownUntil: "2026-10-25T09:10:00.000Z" } })).toEqual({ kind: "cooldown", cooldownUntil: "2026-10-25T09:10:00.000Z", message: "cooling down" });
    expect(classifyCommandReply(429, { error: { code: "limit", message: "limit max_instances: 1 of 1", limit: "max_instances" } })).toEqual({ kind: "limit", limit: "max_instances", message: "limit max_instances: 1 of 1" });
    expect(classifyCommandReply(403, { error: { code: "lockdown", message: "the brain is in lockdown" } })).toEqual({ kind: "forbidden", code: "lockdown", message: "the brain is in lockdown" });
    expect(() => classifyCommandReply(503, { error: { code: "store_unavailable", message: "store down" } })).toThrow(BrainHttpError);
  });
});

describe("BrainClient over HTTP", () => {
  it("sends commands, messages, answers and confirmations with the bearer, X-Swarm-Os and Idempotency-Key", async () => {
    brain = await startFakeBrain({
      "POST /api/commands": () => ({ status: 200, body: { ok: true, text: "held" } }),
      "POST /api/rooms/room-ba/messages": () => ({ status: 200, body: { message: { id: "msg-9" } } }),
      "POST /api/questions/q-1/answer": () => ({ status: 200, body: { question: { id: "q-1" }, late: false } }),
      "POST /api/stepup/confirm": () => ({ status: 200, body: { ok: true } }),
    });
    const c = new BrainClient({ url: brain.url, bearer: "host_s3cret" });
    expect(await c.postCommand("room-ba", ["hold", "board-a", "42"], { stepUpId: "su-1", code: "482913" })).toEqual({ kind: "ok", result: { ok: true, text: "held" } });
    await c.postMessage("room-ba", "on it", "msg-3");
    await c.answerQuestion("q-1", "port 3141");
    await c.confirmStepUp("su-1", "482913");
    const [cmd, msg, ans, conf] = brain.requests;
    expect(cmd.body).toEqual({ room: "room-ba", argv: ["hold", "board-a", "42"], stepUpId: "su-1", code: "482913" });
    expect(msg.body).toEqual({ kind: "text", body: "on it", replyTo: "msg-3" });
    expect(ans.body).toEqual({ body: "port 3141" });
    expect(conf.body).toEqual({ stepUpId: "su-1", code: "482913" });
    for (const r of brain.requests) {
      expect(r.headers.authorization).toBe("Bearer host_s3cret");
      expect(r.headers["x-swarm-os"]).toBe("1");
    }
    expect(cmd.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(msg.headers["idempotency-key"]).not.toBe(cmd.headers["idempotency-key"]);
  });
  it("reads rooms and messages whether or not the brain wraps them", async () => {
    brain = await startFakeBrain({
      "GET /api/rooms": () => ({ status: 200, body: { rooms: [{ id: "room-cos" }] } }),
      "GET /api/rooms/room-cos/messages": () => ({ status: 200, body: [{ id: "msg-1" }] }),
    });
    const c = new BrainClient({ url: brain.url, bearer: "sess_abc" });
    expect((await c.listRooms()).map((r) => r.id)).toEqual(["room-cos"]);
    expect((await c.roomMessages("room-cos")).map((m) => m.id)).toEqual(["msg-1"]);
    expect(brain.requests[1].query).toBe("limit=200");
  });
  it("says the brain is unreachable when nothing listens", async () => {
    const gone = await startFakeBrain({});
    const url = gone.url;
    await gone.close();
    await expect(new BrainClient({ url, bearer: "x" }).listRooms()).rejects.toBeInstanceOf(BrainUnreachableError);
  });
});

describe("BrainClient event stream", () => {
  it("opens /api/stream?rooms=all with the bearer and delivers typed events", async () => {
    brain = await startFakeBrain({}, { hello: () => HELLO });
    const events: BrainEvent[] = [];
    const statuses: ConnectionStatus[] = [];
    const c = new BrainClient({ url: brain.url, bearer: "sess_abc" });
    c.connect({ onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(["hello"]));
    brain.send("message", MSG);
    brain.send("nonsense", {});
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(["hello", "message"]));
    expect(streams()[0].query).toBe("rooms=all");
    expect(streams()[0].headers.authorization).toBe("Bearer sess_abc");
    expect(statuses[0]).toEqual({ state: "connecting" });
    expect(statuses).toContainEqual({ state: "open" });
    c.close();
  });
  it("reconnects with Last-Event-ID after the stream drops", async () => {
    brain = await startFakeBrain({}, { hello: () => HELLO });
    const statuses: ConnectionStatus[] = [];
    const c = new BrainClient({ url: brain.url, bearer: "sess_abc", streamBackoffMs: [10, 40] });
    c.connect({ onEvent: () => {}, onStatus: (s) => statuses.push(s) });
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: "open" }));
    brain.send("message", MSG);                                   // event id 2
    await new Promise((r) => setTimeout(r, 50));
    brain.dropStreams();
    await vi.waitFor(() => expect(streams()).toHaveLength(2));
    expect(streams()[1].headers["last-event-id"]).toBe("2");
    expect(statuses.map((s) => s.state)).toContain("offline");
    c.close();
  });
  it("stops reconnecting and reports signed_out when the brain refuses the sign-in", async () => {
    brain = await startFakeBrain({ "GET /api/rooms": () => ({ status: 401, body: { error: { code: "unauthenticated", message: "revoked" } } }) }, { hello: () => HELLO });
    const statuses: ConnectionStatus[] = [];
    const c = new BrainClient({ url: brain.url, bearer: "sess_old", streamBackoffMs: [10, 40] });
    c.connect({ onEvent: () => {}, onStatus: (s) => statuses.push(s) });
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: "open" }));
    brain.setStreamStatus(401);
    brain.dropStreams();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: "signed_out" }), { timeout: 3000 });
    const attempts = streams().length;
    await new Promise((r) => setTimeout(r, 200));
    expect(streams()).toHaveLength(attempts);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/credentials.test.ts tests/tui/client.test.ts`
Expected: FAIL. `../../src/tui/credentials.js` and `../../src/tui/client.js` do not exist yet.

- [ ] **Step 3: Implement `credentials.ts` and `client.ts` to the rules above**

`toBrainEvent` flattens the payload into the event (`{ type, id, ...data }`). It validates with zod: objects that carry rows use `.passthrough()` and require only the fields the TUI reads (`id`, plus `roomId` and `seq` for messages, `roomId` for instances, `messageId` and `state` for questions). `hello.lockdown` defaults to `false`. `stepup`, and each `hello.stepUps` entry, must carry `code`. `pollCliLogin` sends `GET /api/auth/cli/<nonce>` with `X-Swarm-Os-Poll: <pollSecret>` and no bearer, and turns a rejected fetch into `BrainUnreachableError`. Create `packages/os/src/tui/index.ts` re-exporting both modules, and append `export * from "./tui/index.js";` to the plan 08 block.

- [ ] **Step 4: Run the tests, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/credentials.test.ts tests/tui/client.test.ts`
Expected: PASS (6 + 8 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/tui packages/os/tests/tui packages/os/src/index.ts
git commit -m "feat(os): terminal client for the brain's event stream and HTTP API"
```

---

### Task 3: The TUI's state reducer

**Files:**
- Create: `packages/os/src/tui/state.ts`
- Create: `packages/os/tests/tui/fixture.ts`
- Modify: `packages/os/src/tui/index.ts`
- Test: `packages/os/tests/tui/state.test.ts`

**Interfaces:**
- Consumes: `BrainEvent`, `ConnectionStatus`, `CommandOutcome`, `WireRoom`, `WireMessage`, `WireInstance`, `WireQuestion` and `PendingStepUp` (Task 2); `ResourceSnapshot`, `Actor`.
- Produces:

```ts
export const HISTORY_LIMIT = 200;
export type Focus = "rooms" | "messages" | "input";
export interface StepUpPrompt extends PendingStepUp { confirming: boolean }
export interface TuiState {
  now: number; timeZone: string; actor: Actor | null; connection: ConnectionStatus; lockdown: boolean; cooldownUntil: string | null;
  snapshotEventId: number | null;                                  // the last hello's id
  rooms: WireRoom[]; instances: WireInstance[]; resources: ResourceSnapshot | null;
  messages: Record<string, WireMessage[]>;                          // by room, ascending seq, unique ids
  questions: Record<string, WireQuestion>;                          // by messageId
  loaded: Record<string, "loading" | "loaded" | "stale">; unread: Record<string, number>; roomsRefreshPending: boolean;
  selectedRoomId: string | null; requestedRoom: string | null;
  focus: Focus; input: string; pasting: boolean; scroll: number; helpOpen: boolean; status: string | null;
  stepUps: StepUpPrompt[]; nextRef: number; pending: Record<string, string>;   // ref → the line that was sent
}
export type TuiEffect =
  | { kind: "post-message"; ref: string; roomId: string; body: string; replyTo?: string }
  | { kind: "answer-question"; ref: string; questionId: string; body: string }
  | { kind: "post-command"; ref: string; roomId: string; argv: string[] }
  | { kind: "confirm-stepup"; stepUpId: string; code: string }
  | { kind: "load-history"; roomId: string } | { kind: "refresh-rooms" } | { kind: "quit" };
export interface Reduced { state: TuiState; effects: TuiEffect[] }
export type RoomListEntry = { kind: "room"; room: WireRoom } | { kind: "divider"; label: "past" };
export interface OpenQuestion { messageId: string; questionId: string | null }
export function initialTuiState(opts: { now: number; timeZone: string; requestedRoom?: string }): TuiState;   // focus "input", connection "connecting"
export function applyEvent(state: TuiState, event: BrainEvent): Reduced;
export function applyConnection(state: TuiState, status: ConnectionStatus): TuiState;
export function applyHistory(state: TuiState, roomId: string, messages: WireMessage[]): TuiState;
export function applyRooms(state: TuiState, rooms: WireRoom[]): TuiState;
export function applyTick(state: TuiState, now: number): TuiState;
export function applySendResult(state: TuiState, ref: string, result: { ok: true } | { ok: false; message: string }): TuiState;
export function applyCommandOutcome(state: TuiState, ref: string, outcome: CommandOutcome): TuiState;
export function selectRoom(state: TuiState, roomId: string): Reduced;
export function orderedRooms(state: TuiState): RoomListEntry[];
export function liveInstances(state: TuiState): WireInstance[];     // dispatching, running, unresponsive; by startedAt ascending
export function openQuestion(state: TuiState, roomId?: string): OpenQuestion | null;
```

Rules:
- **`hello`:**
  - Record `snapshotEventId`.
  - Replace `actor`, `rooms`, `instances`, `resources`, `lockdown` and `cooldownUntil`. Keep messages, because the stream replays what was missed.
  - On the first hello, select `requestedRoom` (by id, then by name ignoring case), else the `cos` room, else `system`, else the first room. An unknown `requestedRoom` sets the status `no room "<x>"; showing <name>`.
  - Selecting a room that is not loaded (or is `stale`) marks it `loading` and emits `load-history`.
- **`instance`, `resources`, `cooldown`, `lockdown`:** ignore the event when `id !== null && snapshotEventId !== null && id <= snapshotEventId`; the hello already reflects it. Otherwise upsert or replace.
- **`message`:** merge it into its room (by id, ascending seq). A message in another room counts as unread unless it is the actor's own human message (`fromKind === "human"` and `fromId === actor.humanId`). A room missing from `rooms` emits `refresh-rooms` once, until `applyRooms` clears `roomsRefreshPending`.
- **`question`:** store the event under `question.messageId`.
- **`decision`:** no change; the chief of staff narrates decisions in the rooms.
- **`gap`:** every `loaded` room becomes `stale`, and the selected room reloads.
- **`selectRoom`:** clears that room's unread count and sets `scroll` to 0.
- **`openQuestion`:** the newest message of the room, when it is a `question` whose stored `QuestionRow` is missing or in state `open`. `questionId` is that row's id, else `dataJson.questionId` when present, else `null`.
- **`applyConnection`:** `signed_out` sets the status "the brain refused this sign-in; quit and run swarm os login".
- **`applySendResult`:**
  - On success, drop the ref.
  - On failure, also restore `pending[ref]` into an empty input and set the status `not sent: <message> The line is back in the input.`
- **`applyCommandOutcome`:** drops the ref and sets the status:
  - `ok`: `null`.
  - `failed`: the first line of `result.text`.
  - `stepup_required`: `step-up <stepUpId> required: confirm the code on the brain's host`.
  - `cooldown`: `cool-down until <HH:MM>: commands wait`, and set `cooldownUntil`.
  - `limit`: `refused by the <limit> limit in os.json`.
  - `forbidden`: `refused (<code>): <message>`.

  `HH:MM` here and in Task 4 is `Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: state.timeZone })`.

- [ ] **Step 1: Write the fixture and the failing test**

```ts
// packages/os/tests/tui/fixture.ts
import type { ResourceSnapshot } from "../../src/launcher/launcher.js";
import type { BrainEvent, WireInstance, WireMessage, WireQuestion, WireRoom } from "../../src/tui/client.js";
import { applyConnection, applyEvent, applyHistory, initialTuiState, type TuiState } from "../../src/tui/state.js";

export const NOW = Date.parse("2026-10-25T09:00:00.000Z");
export const OWNER = { kind: "human", humanId: "part-owner", sessionId: "sess-1", deviceId: "dev-1", address: "127.0.0.1", confirmer: false } as const;
export const HOST = { kind: "host" } as const;
export const room = (id: string, kind: WireRoom["kind"], name: string, over: Partial<WireRoom> = {}): WireRoom =>
  ({ id, kind, name, subjectId: null, membersJson: "[]", privacy: "normal", createdAt: "2026-10-20T00:00:00.000Z", closedAt: null, ...over });
export const message = (over: Partial<WireMessage> & { id: string }): WireMessage =>
  ({ roomId: "room-cos", fromId: "part-cos", fromKind: "cos", kind: "text", body: "", dataJson: null, replyTo: null, provenanceJson: "{}", at: "2026-10-25T08:59:30.000Z", seq: 1, ...over });
export const instance = (id: string, over: Partial<WireInstance> = {}): WireInstance => {
  const card = id.replace("inst-", "");
  return { id, registrationId: "reg-a", boardId: "board-a", cardId: card, runId: null, state: "running", host: "host-a", launcherHandle: null, tokenHash: "", roomId: `room-i${card}`, startedAt: "2026-10-25T08:30:00.000Z", lastHeartbeatAt: null, endedAt: null, exitReason: null, dashboardUrl: null, tokens: 0, ...over };
};
export const question = (id: string, messageId: string, state: WireQuestion["state"]): WireQuestion =>
  ({ id, messageId, roomId: "room-cos", instanceId: "inst-42", sessionId: "sess-w1", askedAt: "2026-10-25T08:59:00.000Z", waitUntil: "2026-10-25T09:29:00.000Z", state, answerMessageId: null, proceededWith: null, lateAnswerMessageId: null });

export const ROOMS: WireRoom[] = [
  room("room-cos", "cos", "chief of staff"),
  room("room-sys", "system", "system"),
  room("room-bb", "board", "board-b", { subjectId: "board-b" }),
  room("room-ba", "board", "board-a", { subjectId: "board-a" }),
  room("room-i42", "instance", "project-a #42", { subjectId: "inst-42", createdAt: "2026-10-25T08:30:00.000Z" }),
  room("room-i7", "instance", "project-b #7", { subjectId: "inst-7", createdAt: "2026-10-25T08:55:00.000Z" }),
  room("room-d1", "direct", "owner + cos"),
  room("room-i40", "instance", "project-a #40", { subjectId: "inst-40", createdAt: "2026-10-24T10:00:00.000Z", closedAt: "2026-10-24T11:00:00.000Z" }),
];
export const INSTANCES: WireInstance[] = [
  instance("inst-7", { registrationId: "reg-b", boardId: "board-b", state: "unresponsive", startedAt: "2026-10-25T08:55:00.000Z", lastHeartbeatAt: "2026-10-25T08:57:30.000Z", tokens: 40_000, phase: "review" }),
  instance("inst-42", { runId: "run-a1", lastHeartbeatAt: "2026-10-25T08:59:50.000Z", dashboardUrl: "http://127.0.0.1:3141", tokens: 1_234_567, phase: "work", currentTask: "add retry to the poller" }),
  instance("inst-40", { state: "exited", startedAt: "2026-10-24T10:00:00.000Z", endedAt: "2026-10-24T11:00:00.000Z", tokens: 900_000 }),
];
export const RESOURCES: ResourceSnapshot = { host: "host-a", at: "2026-10-25T08:59:55.000Z", cpuLoad1: 1.2, cpus: 8, memFreeMb: 6144, memTotalMb: 16384, instancesRunning: 2, claudeSessions: 3, portsInUse: [3141], tokensThisHour: { "project-a": 1_200_000, "project-b": 40_000 } };
export const COS_MESSAGES: WireMessage[] = [
  message({ id: "msg-1", seq: 1, at: "2026-10-25T08:58:00.000Z", fromId: "part-owner", fromKind: "human", body: "what's running?" }),
  message({ id: "msg-2", seq: 2, at: "2026-10-25T08:58:20.000Z", body: 'Two runs. project-a #42 is on "add retry to the poller", 1.2M tokens in 30 minutes. project-b #7 missed its heartbeat at 08:57; I have asked the owners of board-b.' }),
  message({ id: "msg-3", seq: 3, at: "2026-10-25T08:59:00.000Z", kind: "question", body: "BUG-12 on board-b is labelled design. Take it anyway?" }),
];
type Hello = Extract<BrainEvent, { type: "hello" }>;
export const hello = (over: Partial<Hello> = {}): Hello =>
  ({ type: "hello", id: 1, actor: OWNER, rooms: ROOMS, instances: INSTANCES, resources: RESOURCES, lockdown: false, ...over });

/** The state every render golden draws: the owner in the chief of staff's room, two unread on board-a, a reply typed. */
export function fixtureState(): TuiState {
  let s = applyConnection(initialTuiState({ now: NOW, timeZone: "UTC" }), { state: "open" });
  s = applyEvent(s, hello()).state;
  s = applyHistory(s, "room-cos", COS_MESSAGES);
  s = applyEvent(s, { type: "message", id: 2, message: message({ id: "msg-a1", roomId: "room-ba", seq: 1, body: "card 42 looks ready" }) }).state;
  s = applyEvent(s, { type: "message", id: 3, message: message({ id: "msg-a2", roomId: "room-ba", seq: 2, body: "and 43" }) }).state;
  return { ...s, input: "take it anyway" };
}
```

```ts
// packages/os/tests/tui/state.test.ts
import { describe, expect, it } from "vitest";
import { applyCommandOutcome, applyConnection, applyEvent, applyHistory, applyRooms, applySendResult, initialTuiState, liveInstances, openQuestion, orderedRooms } from "../../src/tui/state.js";
import { COS_MESSAGES, NOW, ROOMS, fixtureState, hello, instance, message, question, room } from "./fixture.js";

const fresh = (requestedRoom?: string) => initialTuiState({ now: NOW, timeZone: "UTC", ...(requestedRoom ? { requestedRoom } : {}) });

describe("applyEvent", () => {
  it("hello selects the chief-of-staff room and asks for its history", () => {
    const { state, effects } = applyEvent(fresh(), hello());
    expect(state.selectedRoomId).toBe("room-cos");
    expect(state.loaded["room-cos"]).toBe("loading");
    expect(effects).toEqual([{ kind: "load-history", roomId: "room-cos" }]);
  });
  it("hello selects --room by name or id, and says so when there is no such room", () => {
    expect(applyEvent(fresh("Board-A"), hello()).state.selectedRoomId).toBe("room-ba");
    expect(applyEvent(fresh("room-i42"), hello()).state.selectedRoomId).toBe("room-i42");
    const missing = applyEvent(fresh("board-z"), hello()).state;
    expect(missing.selectedRoomId).toBe("room-cos");
    expect(missing.status).toBe('no room "board-z"; showing chief of staff');
  });
  it("hello after a reconnect refreshes rooms and instances and keeps the messages", () => {
    const next = applyEvent(fixtureState(), hello({ id: 50, rooms: [...ROOMS, room("room-i43", "instance", "project-a #43")] }));
    expect(next.state.rooms.map((r) => r.id)).toContain("room-i43");
    expect(next.state.messages["room-cos"]).toHaveLength(3);
    expect(next.effects).toEqual([]);
  });
  it("ignores replayed instance events older than the hello", () => {
    const s = applyEvent(fixtureState(), hello({ id: 50 })).state;
    const stale = applyEvent(s, { type: "instance", id: 40, instance: instance("inst-42", { state: "dispatching" }) }).state;
    expect(stale.instances.find((i) => i.id === "inst-42")?.state).toBe("running");
    const live = applyEvent(s, { type: "instance", id: 51, instance: instance("inst-42", { state: "exited" }) }).state;
    expect(liveInstances(live).map((i) => i.id)).toEqual(["inst-7"]);
  });
  it("a gap marks loaded rooms stale and reloads the selected one", () => {
    const { state, effects } = applyEvent(fixtureState(), { type: "gap", id: 60 });
    expect(state.loaded["room-cos"]).toBe("loading");
    expect(effects).toEqual([{ kind: "load-history", roomId: "room-cos" }]);
  });
  it("keeps a room's messages in seq order without duplicates", () => {
    const s = applyEvent(fixtureState(), { type: "message", id: 61, message: COS_MESSAGES[1] }).state;
    const t = applyHistory(s, "room-cos", [message({ id: "msg-0", seq: 0, body: "earlier" }), ...COS_MESSAGES]);
    expect(t.messages["room-cos"].map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
  });
  it("counts unread messages in other rooms, but not my own", () => {
    const s = fixtureState();
    expect(s.unread["room-ba"]).toBe(2);
    const mine = applyEvent(s, { type: "message", id: 62, message: message({ id: "msg-a3", roomId: "room-ba", seq: 3, fromKind: "human", fromId: "part-owner" }) }).state;
    expect(mine.unread["room-ba"]).toBe(2);
  });
  it("asks for the room list once when an event names a room it does not know", () => {
    const a = applyEvent(fixtureState(), { type: "message", id: 63, message: message({ id: "msg-x", roomId: "room-new", seq: 1 }) });
    expect(a.effects).toEqual([{ kind: "refresh-rooms" }]);
    const b = applyEvent(a.state, { type: "message", id: 64, message: message({ id: "msg-y", roomId: "room-new", seq: 2 }) });
    expect(b.effects).toEqual([]);
    expect(applyRooms(b.state, [...ROOMS, room("room-new", "instance", "project-a #43")]).roomsRefreshPending).toBe(false);
  });
  it("finds the open question, by its question row when it has one", () => {
    expect(openQuestion(fixtureState())).toEqual({ messageId: "msg-3", questionId: null });
    const asked = applyEvent(fixtureState(), { type: "message", id: 65, message: message({ id: "msg-q", seq: 4, fromKind: "worker", kind: "question", body: "Which port?" }) }).state;
    const withRow = applyEvent(asked, { type: "question", id: 66, question: question("q-1", "msg-q", "open") }).state;
    expect(openQuestion(withRow)).toEqual({ messageId: "msg-q", questionId: "q-1" });
    const answered = applyEvent(withRow, { type: "question", id: 67, question: question("q-1", "msg-q", "answered") }).state;
    expect(openQuestion(answered)).toBeNull();
    const fromData = applyEvent(fixtureState(), { type: "message", id: 68, message: message({ id: "msg-r", seq: 4, kind: "question", dataJson: '{"questionId":"q-2"}' }) }).state;
    expect(openQuestion(fromData)).toEqual({ messageId: "msg-r", questionId: "q-2" });
  });
  it("tracks cool-down and lockdown", () => {
    const s = applyEvent(applyEvent(fixtureState(), { type: "cooldown", id: 70, cooldownUntil: "2026-10-25T09:10:00.000Z" }).state, { type: "lockdown", id: 71, active: true }).state;
    expect([s.cooldownUntil, s.lockdown]).toEqual(["2026-10-25T09:10:00.000Z", true]);
  });
});

describe("orderedRooms", () => {
  it("lists cos, system, boards, live instances newest first, direct, then past instances", () => {
    expect(orderedRooms(fixtureState()).map((e) => (e.kind === "room" ? e.room.id : "--past--")))
      .toEqual(["room-cos", "room-sys", "room-ba", "room-bb", "room-i7", "room-i42", "room-d1", "--past--", "room-i40"]);
  });
});

describe("results of sends and commands", () => {
  it("puts a line that could not be sent back into the input", () => {
    const t = applySendResult({ ...fixtureState(), input: "", pending: { r1: "take it anyway" } }, "r1", { ok: false, message: "No brain is answering at http://127.0.0.1:3200." });
    expect(t.input).toBe("take it anyway");
    expect(t.status).toBe("not sent: No brain is answering at http://127.0.0.1:3200. The line is back in the input.");
    expect(t.pending).toEqual({});
  });
  it("turns command outcomes into the status line", () => {
    const s = { ...fixtureState(), pending: { r1: "/register board-b project-b /path/to/project-b/.swarm" } };
    expect(applyCommandOutcome(s, "r1", { kind: "stepup_required", stepUpId: "su-1", expiresAt: null }).status).toBe("step-up su-1 required: confirm the code on the brain's host");
    expect(applyCommandOutcome(s, "r1", { kind: "failed", result: { ok: false, text: "no such board: board-z\nmore" } }).status).toBe("no such board: board-z");
    const cool = applyCommandOutcome(s, "r1", { kind: "cooldown", cooldownUntil: "2026-10-25T09:10:00.000Z", message: "cooling down" });
    expect([cool.status, cool.cooldownUntil]).toEqual(["cool-down until 09:10: commands wait", "2026-10-25T09:10:00.000Z"]);
    expect(applyCommandOutcome(s, "r1", { kind: "limit", limit: "max_instances", message: "limit max_instances: 1 of 1" }).status).toBe("refused by the max_instances limit in os.json");
    expect(applyCommandOutcome(s, "r1", { kind: "forbidden", code: "lockdown", message: "the brain is in lockdown" }).status).toBe("refused (lockdown): the brain is in lockdown");
    expect(applyCommandOutcome(s, "r1", { kind: "ok", result: { ok: true, text: "held" } }).pending).toEqual({});
  });
  it("says so when the brain refuses the sign-in", () => {
    expect(applyConnection(fixtureState(), { state: "signed_out" }).status).toBe("the brain refused this sign-in; quit and run swarm os login");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/state.test.ts`
Expected: FAIL. `../../src/tui/state.js` does not exist yet.

- [ ] **Step 3: Implement `packages/os/src/tui/state.ts` to the rules above**

Every function returns a new state object; the reducer never mutates its input. Export it from `tui/index.ts`.

- [ ] **Step 4: Run the test, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/state.test.ts`
Expected: PASS (14 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/tui/state.ts packages/os/src/tui/index.ts packages/os/tests/tui/fixture.ts packages/os/tests/tui/state.test.ts
git commit -m "feat(os): swarm top state reducer over brain events"
```

---

### Task 4: Text, layout and `renderFrame`

**Files:**
- Create: `packages/os/src/tui/text.ts`, `packages/os/src/tui/layout.ts`, `packages/os/src/tui/render.ts`
- Modify: `packages/os/src/tui/index.ts`
- Test: `packages/os/tests/tui/text.test.ts`, `packages/os/tests/tui/render.test.ts`

**Interfaces:**
- Consumes: `TuiState`, `orderedRooms`, `liveInstances`, `openQuestion` (Task 3).
- Produces:

```ts
// text.ts
export const SGR: { reset: string; bold: string; dim: string; inverse: string; red: string; green: string; yellow: string; cyan: string };
export function stripAnsi(s: string): string;                    // removes CSI sequences: /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
export function displayWidth(s: string): number;                 // ANSI 0; combining marks, ZWJ, variation selectors 0; East Asian Wide/Fullwidth and emoji 2; else 1
export function fit(s: string, width: number): string;           // pad to width; if wider, keep at most width-1 columns, drop trailing spaces, add "…", pad
export function fitRight(s: string, width: number): string;      // pad on the left; truncate like fit when wider
export function wrap(text: string, firstWidth: number, restWidth: number): string[];   // words greedily; "\n" starts a new line; a word wider than a line is split
export function compactTokens(n: number): string;                // 999, 1.0k (<10k, one decimal), 40k, 1.2M
export function shortDuration(ms: number): string;               // 10s, 2m, 30m, 1h05m, 1d; negative → 0s
export function formatClock(iso: string, timeZone: string): string;   // HH:MM
// layout.ts
export interface TerminalSize { columns: number; rows: number }
export const MIN_COLUMNS = 80; export const MIN_ROWS = 24;
export interface Layout { tooSmall: boolean; columns: number; rows: number; instanceRows: number; roomsWidth: number; paneWidth: number; separatorTop: number; middleTop: number; middleRows: number; separatorBottom: number; inputRow: number }
export function computeLayout(size: TerminalSize): Layout;
// render.ts
export const HELP_LINES: readonly string[];
export const FOCUS_HINTS: Readonly<Record<"input" | "answer" | "rooms" | "messages", string>>;
export function renderFrame(state: TuiState, size: TerminalSize): string[];   // exactly size.rows strings, each exactly size.columns display columns
export function cursorPosition(state: TuiState, size: TerminalSize): { row: number; column: number } | null;   // 1-based; null unless focus is input
```

Rules. The goldens are the arbiter:
1. **Too small.** Below 80×24, every row is blank except row `floor(rows / 2)`, which centres `swarm top needs at least 80x24 (this terminal is <c>x<r>)` and is fitted to the width.
2. **Sizes:**
   - `instanceRows = clamp(floor(rows / 8), 3, 8)`
   - `roomsWidth = clamp(floor(columns / 4), 20, 32)`
   - `paneWidth = columns − roomsWidth − 1`
   - `middleRows = rows − instanceRows − 5`

   From the top, the rows are: 0, resources; 1, the instance header; the `instanceRows` instance rows; the top separator; `middleRows` rows of rooms, `│` and messages; the bottom separator; the input.
3. **Row 0.** The left part is ` <host>  load <cpuLoad1.toFixed(2)>/<cpus>  mem <(memFreeMb/1024).toFixed(1)>/<(memTotalMb/1024).toFixed(1)> GB free  sessions <claudeSessions>  tokens/h <compactTokens(sum of tokensThisHour)>`, or ` no resource snapshot yet`. The right part is `LOCKDOWN  ` when locked down, followed by `live `, `connecting `, `offline ` or `signed out `. The row is `fit(left, columns − width(right)) + right`.
4. **Instance table.** Columns are separated by one space after a leading space:
   - `ROOM` (R) the instance's room name, else `<boardId>:<cardId>`
   - `STATE` (13) the state
   - `PHASE` (10) `phase ?? "-"`
   - `TASK` (T) `currentTask ?? "-"`
   - `TOKENS` (7, right-aligned) `compactTokens(tokens)`
   - `UP` (6, right-aligned) `shortDuration((endedAt ?? now) − startedAt)`
   - `BEAT` (5, right-aligned) `shortDuration(now − lastHeartbeatAt)`, or `-`
   - `DASHBOARD` (22) `dashboardUrl ?? "-"`, only when `columns ≥ 120`

   With `F = columns − 48`, less 23 more with `DASHBOARD`: `R = floor(0.45 × F)` and `T = F − R`. The header uses these labels. Rows come from `liveInstances`: more than `instanceRows` show the first `instanceRows − 1` and then `  +<n> more`; none shows `  no instances running`. Blank rows fill the rest.
5. **Top separator.** `─ rooms ` + `─` × (roomsWidth − 8) + `┬` + `─ <glyph> <name> ` padded with `─` to `paneWidth` (or `no room`), fitted when wider. The glyphs are cos `@`, system `!`, board `#`, instance `~`, direct `=`. For an instance room whose instance has a `dashboardUrl`, the title is `<glyph> <name>  <dashboardUrl>`, so the run's dashboard is linked even below 120 columns.
6. **Rooms list** (`roomsWidth`). Each entry is `>` for the selected room or a space, then `<glyph> <name>`, fitted to `roomsWidth − width(badge)`, then the badge ` <unread>` (`99+` above 99) when unread is above 0. The divider row is `  past`. The window starts at `clamp(selected − middleRows + 1, 0, max(0, entries − middleRows))`.
7. **Messages pane** (`paneWidth`):
   - **Prefix:** `<HH:MM> <mark><who>: `. The marks are `? ` question, `> ` answer, `/ ` command, `* ` event, `! ` system and `+ ` file; text has none. `who` is `you` for the actor's own human messages, else `fromKind`.
   - **Wrapping:** the first line wraps at `paneWidth − 1 − width(prefix)`. Continuation lines are indented 6 spaces and wrap at `paneWidth − 7`. Each line is ` ` + content, fitted.
   - **Placement:** bottom-aligned. Show the last `middleRows` lines ending `scroll` lines above the newest, with blank rows above them.
   - **Empty states:** ` no messages yet`; ` loading…` while the room is `loading` and holds nothing; ` no room selected`.
8. **Bottom separator.** `─` × roomsWidth + `┴` + `─ <status> ` padded with `─`. The status is the first that applies: `state.status`; `cool-down until <HH:MM>: new commands wait` while `cooldownUntil` is in the future; `FOCUS_HINTS[focus]`, using `answer` instead of `input` while `openQuestion` is non-null. The hints are:
   - `input`: `Enter send  /cmd command  Tab panes  Esc rooms`
   - `answer`: `Enter answers  /cmd command  Tab panes  Esc rooms`
   - `rooms`: `j/k rooms  Enter type  Tab panes  ? help  q quit`
   - `messages`: `j/k scroll  Tab panes  ? help  q quit`
9. **Input row.** ` ? ` while `openQuestion` is non-null, else ` > `, then the input. When the input is wider than `columns − 4`, show `…` + its widest tail that fits. The cursor sits at column `4 + width(shown input)` on the last row.
10. **Help.** While `helpOpen`, the middle rows show `HELP_LINES` fitted to the width, and blank rows after them:

```
 Keys
 Up / Down     move between rooms (from any pane)
 j / k         rooms pane: move between rooms; messages pane: scroll
 PgUp / PgDn   scroll the messages pane by a page
 Tab           next pane: rooms, messages, input line
 Enter         send the line; a line starting with / is a command
 //text        send a message that starts with /
 Esc           leave the input line (then q quits)
 q             quit (rooms and messages panes); Ctrl-C quits anywhere
 ?             show or hide this help
 Step-up       Enter confirms the code on screen, Esc dismisses it
```

11. **Styles.** SGR codes, which the goldens strip:
    - row 0: inverse
    - instance header: dim
    - `STATE`: green `running`, yellow `dispatching`, red `unresponsive`
    - separators: dim, with the focused pane's title bold
    - the selected room: inverse while the rooms pane has focus, bold otherwise
    - unread badges: bold
    - `cos`: cyan
    - question lines: yellow

    Every styled run ends with `\x1b[0m`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/os/tests/tui/text.test.ts
import { describe, expect, it } from "vitest";
import { compactTokens, displayWidth, fit, fitRight, shortDuration, wrap } from "../../src/tui/text.js";

describe("text", () => {
  it("measures columns, not code units", () => {
    expect([displayWidth("abc"), displayWidth("漢字"), displayWidth("🙂"), displayWidth("\x1b[1mab\x1b[0m"), displayWidth("é")]).toEqual([3, 4, 2, 2, 1]);
  });
  it("fits to an exact width", () => {
    expect(fit("abc", 5)).toBe("abc  ");
    expect(fit("add retry to the poller", 18)).toBe("add retry to the… ");
    expect(fit("漢字漢字", 5)).toBe("漢字…");
    expect(fit("漢字漢字", 4)).toBe("漢… ");
    expect(fitRight("40k", 7)).toBe("    40k");
  });
  it("wraps words, honours newlines and splits long words", () => {
    expect(wrap("one two three", 7, 5)).toEqual(["one two", "three"]);
    expect(wrap("abcdefghij", 4, 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("a\nb", 10, 10)).toEqual(["a", "b"]);
    expect(wrap("", 5, 5)).toEqual([""]);
  });
  it("shortens tokens and durations", () => {
    expect([999, 1000, 2500, 40_000, 1_234_567].map(compactTokens)).toEqual(["999", "1.0k", "2.5k", "40k", "1.2M"]);
    expect([-5, 10_000, 150_000, 1_800_000, 3_900_000, 90_000_000].map(shortDuration)).toEqual(["0s", "10s", "2m", "30m", "1h05m", "1d"]);
  });
});
```

```ts
// packages/os/tests/tui/render.test.ts
import { describe, expect, it } from "vitest";
import { cursorPosition, renderFrame } from "../../src/tui/render.js";
import { applyConnection, applyEvent, applyRooms } from "../../src/tui/state.js";
import { displayWidth, stripAnsi } from "../../src/tui/text.js";
import { fixtureState, message } from "./fixture.js";

const SIZE = { columns: 80, rows: 24 };
const at = (columns: number) => (s: string) => s.padEnd(columns);   // every golden character is one column and one code unit

describe("renderFrame", () => {
  it("draws the 80x24 frame", () => {
    const row = at(80);
    expect(renderFrame(fixtureState(), SIZE).map(stripAnsi)).toEqual([
      row(" host-a  load 1.20/8  mem 6.0/16.0 GB free  sessions 3  tokens/h 1.2M      live"),
      row(" ROOM           STATE         PHASE      TASK                TOKENS     UP  BEAT"),
      row(" project-a #42  running       work       add retry to the…     1.2M    30m   10s"),
      row(" project-b #7   unresponsive  review     -                      40k     5m    2m"),
      row(""),
      row("─ rooms ────────────┬─ @ chief of staff ────────────────────────────────────────"),
      row(">@ chief of staff   │"),
      row(" ! system           │"),
      row(" # board-a         2│"),
      row(" # board-b          │"),
      row(" ~ project-b #7     │"),
      row(" ~ project-a #42    │"),
      row(" = owner + cos      │"),
      row("  past              │"),
      row(" ~ project-a #40    │"),
      row("                    │ 08:58 you: what's running?"),
      row('                    │ 08:58 cos: Two runs. project-a #42 is on "add retry to the'),
      row('                    │       poller", 1.2M tokens in 30 minutes. project-b #7'),
      row("                    │       missed its heartbeat at 08:57; I have asked the"),
      row("                    │       owners of board-b."),
      row("                    │ 08:59 ? cos: BUG-12 on board-b is labelled design. Take it"),
      row("                    │       anyway?"),
      row("────────────────────┴─ Enter answers  /cmd command  Tab panes  Esc rooms ───────"),
      row(" ? take it anyway"),
    ]);
  });

  it("draws the 120x40 frame, with the dashboard column", () => {
    const row = at(120);
    expect(renderFrame(fixtureState(), { columns: 120, rows: 40 }).map(stripAnsi)).toEqual([
      row(" host-a  load 1.20/8  mem 6.0/16.0 GB free  sessions 3  tokens/h 1.2M                                              live"),
      row(" ROOM                   STATE         PHASE      TASK                         TOKENS     UP  BEAT DASHBOARD"),
      row(" project-a #42          running       work       add retry to the poller        1.2M    30m   10s http://127.0.0.1:3141"),
      row(" project-b #7           unresponsive  review     -                               40k     5m    2m -"),
      ...Array(3).fill(row("")),
      row("─ rooms ──────────────────────┬─ @ chief of staff ──────────────────────────────────────────────────────────────────────"),
      row(">@ chief of staff             │"),
      row(" ! system                     │"),
      row(" # board-a                   2│"),
      row(" # board-b                    │"),
      row(" ~ project-b #7               │"),
      row(" ~ project-a #42              │"),
      row(" = owner + cos                │"),
      row("  past                        │"),
      row(" ~ project-a #40              │"),
      ...Array(16).fill(row("                              │")),
      row("                              │ 08:58 you: what's running?"),
      row('                              │ 08:58 cos: Two runs. project-a #42 is on "add retry to the poller", 1.2M tokens in 30'),
      row("                              │       minutes. project-b #7 missed its heartbeat at 08:57; I have asked the owners of"),
      row("                              │       board-b."),
      row("                              │ 08:59 ? cos: BUG-12 on board-b is labelled design. Take it anyway?"),
      row("──────────────────────────────┴─ Enter answers  /cmd command  Tab panes  Esc rooms ─────────────────────────────────────"),
      row(" ? take it anyway"),
    ]);
  });

  it("keeps every row exactly the terminal's width", () => {
    for (const size of [SIZE, { columns: 100, rows: 30 }, { columns: 120, rows: 40 }, { columns: 200, rows: 60 }]) {
      const lines = renderFrame(fixtureState(), size);
      expect(lines).toHaveLength(size.rows);
      for (const line of lines) expect(displayWidth(line)).toBe(size.columns);
    }
  });

  it("wide characters keep every row exactly columns wide", () => {
    const s = applyEvent(fixtureState(), { type: "message", id: 9, message: message({ id: "msg-w", seq: 4, body: "漢字のテスト 🙂 done ".repeat(6) }) }).state;
    const wide = applyRooms(s, s.rooms.map((r) => (r.id === "room-bb" ? { ...r, name: "看板-b 🙂 a long board name" } : r)));
    const lines = renderFrame(wide, SIZE);
    for (const line of lines) expect(displayWidth(line)).toBe(80);
    for (const line of lines.slice(6, 22).map(stripAnsi)) expect(displayWidth(line.slice(0, line.indexOf("│")))).toBe(20);
  });

  it("asks for a bigger terminal below 80x24", () => {
    const lines = renderFrame(fixtureState(), { columns: 60, rows: 20 }).map(stripAnsi);
    expect(lines).toHaveLength(20);
    expect(lines[10]).toBe("  swarm top needs at least 80x24 (this terminal is 60x20)".padEnd(60));
    expect(lines.filter((l) => l.trim() !== "")).toHaveLength(1);
  });

  it("shows the connection state and lockdown on the top line", () => {
    expect(stripAnsi(renderFrame(applyConnection(fixtureState(), { state: "offline", message: "fetch failed" }), SIZE)[0]).endsWith("offline ")).toBe(true);
    expect(stripAnsi(renderFrame({ ...fixtureState(), lockdown: true }, SIZE)[0]).endsWith("LOCKDOWN  live ")).toBe(true);
  });

  it("shows help over the middle rows", () => {
    const lines = renderFrame({ ...fixtureState(), helpOpen: true }, SIZE).map(stripAnsi);
    expect(lines[6]).toBe(" Keys".padEnd(80));
    expect(lines[10]).toBe(" Tab           next pane: rooms, messages, input line".padEnd(80));
  });

  it("links the selected instance's dashboard in the pane title", () => {
    expect(stripAnsi(renderFrame({ ...fixtureState(), selectedRoomId: "room-i42" }, SIZE)[5])).toContain("┬─ ~ project-a #42  http://127.0.0.1:3141 ─");
  });

  it("styles the selected room inverse when the rooms pane has focus", () => {
    expect(renderFrame({ ...fixtureState(), focus: "rooms" }, SIZE)[6]).toContain("\x1b[7m");
  });

  it("puts the cursor after the input text", () => {
    expect(cursorPosition(fixtureState(), SIZE)).toEqual({ row: 24, column: 18 });
    expect(cursorPosition({ ...fixtureState(), focus: "rooms" }, SIZE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/text.test.ts tests/tui/render.test.ts`
Expected: FAIL. `../../src/tui/text.js` and `../../src/tui/render.js` do not exist yet.

- [ ] **Step 3: Implement `text.ts`, `layout.ts` and `render.ts` to the rules above**

`renderFrame` builds each row as plain text cells with style runs, then applies the SGR codes. It never measures a string that already holds escapes, except through `displayWidth`. Export the three modules from `tui/index.ts`.

- [ ] **Step 4: Run the tests, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/text.test.ts tests/tui/render.test.ts`
Expected: PASS (4 + 10 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/tui/text.ts packages/os/src/tui/layout.ts packages/os/src/tui/render.ts packages/os/src/tui/index.ts packages/os/tests/tui/text.test.ts packages/os/tests/tui/render.test.ts
git commit -m "feat(os): swarm top frame renderer with golden layouts at 80x24 and 120x40"
```

---

### Task 5: Step-up codes in the TUI

The brain sends `stepup` events only to the host and to confirmer devices. The host TUI shows the code and the command over the middle of the screen, and Enter confirms with `POST /api/stepup/confirm { stepUpId, code }` as host. A TUI opened after the step-up was issued learns of it from `hello.stepUps` (contract addition 1).

**Files:**
- Create: `packages/os/src/tui/step-up.ts`
- Modify: `packages/os/src/tui/state.ts` (`stepup` and `hello.stepUps` queue prompts; `applyTick` drops expired ones), `packages/os/src/tui/render.ts` (`renderFrame` ends with `overlayStepUp` unless the frame is too small), `packages/os/src/tui/index.ts`
- Modify: `packages/os/tests/tui/fixture.ts` (add `REGISTER_STEPUP`, `RESET_STEPUP` and `withStepUps`, which Task 6 also uses)
- Test: `packages/os/tests/tui/step-up.test.ts`

**Interfaces:**
- Consumes: `TuiState`, `StepUpPrompt`, `applyEvent`, `applyTick` (Task 3); `fit` and `displayWidth` (Task 4); `computeLayout` (Task 4); `BrainClient.confirmStepUp`, `BrainHttpError` and `BrainUnreachableError` (Task 2).
- Produces:

```ts
export const STEPUP_BOX_WIDTH = 60;
export function queueStepUp(state: TuiState, stepUp: PendingStepUp): TuiState;        // once per stepUpId
export function activeStepUp(state: TuiState): StepUpPrompt | null;                    // the oldest whose expiresAt is after state.now
export function dismissStepUp(state: TuiState, stepUpId: string): TuiState;           // status "step-up dismissed; it expires on its own"
export function formatStepUpCode(code: string): string;                                // "482913" → "482 913"; anything else unchanged
export function renderStepUpBox(prompt: StepUpPrompt, waiting: number, columns: number, now: number): string[];   // 7 rows, min(60, columns − 4) wide
export function overlayStepUp(lines: string[], state: TuiState, size: TerminalSize): string[];
export type StepUpOutcome = { ok: true } | { ok: false; final: boolean; message: string };
export function confirmStepUp(client: Pick<BrainClient, "confirmStepUp">, prompt: StepUpPrompt): Promise<StepUpOutcome>;   // BrainHttpError → final; anything else → not final
export function applyStepUpResult(state: TuiState, stepUpId: string, outcome: StepUpOutcome): TuiState;
```

The box is `BW = min(60, columns − 4)` columns wide with `inner = BW − 2`. Its rows are:
1. `┌` + `─ step-up confirmation ` (with ` (<n> more waiting)` before its trailing space when others wait), padded with `─`, + `┐`
2. `│ ` + the command joined by spaces, fitted to `inner − 2`, + ` │`
3. a blank row inside `│ … │`
4. the formatted code centred in `inner`, left padding `floor((inner − width) / 2)`
5. a blank row inside `│ … │`
6. `│ ` + `expires in M:SS  Enter confirms  Esc dismisses` fitted to `inner − 2` + ` │`, where `M:SS` is the ceiling of the remaining seconds
7. `└` + `─` × inner + `┘`

`overlayStepUp` replaces the rows from `middleTop + floor((middleRows − 7) / 2)` with `floor((columns − BW) / 2)` spaces + the box row + spaces. `applyStepUpResult` statuses:
- `ok`: `step-up confirmed: <command>`, and remove the prompt.
- `final`: `step-up not confirmed: <message>`, and remove it.
- otherwise: `could not reach the brain; the step-up is still waiting`, keep it, and set `confirming` back to `false`.

- [ ] **Step 1: Write the failing test**

```ts
// added to packages/os/tests/tui/fixture.ts
export const REGISTER_STEPUP = { stepUpId: "su-1", command: ["register", "board-b", "project-b", "--min-cards", "3"], code: "482913", expiresAt: new Date(NOW + 112_000).toISOString() };
export const RESET_STEPUP = { stepUpId: "su-2", command: ["db", "reset"], code: "100200", expiresAt: new Date(NOW + 119_000).toISOString() };
/** The fixture as the host sees it, with two step-ups waiting; su-1 arrives twice. */
export function withStepUps(s: TuiState): TuiState {
  const host = applyEvent(s, hello({ id: 10, actor: HOST })).state;
  return [REGISTER_STEPUP, REGISTER_STEPUP, RESET_STEPUP].reduce((acc, e, i) => applyEvent(acc, { type: "stepup", id: 11 + i, ...e }).state, host);
}
```

```ts
// packages/os/tests/tui/step-up.test.ts
import { describe, expect, it, vi } from "vitest";
import { BrainHttpError, BrainUnreachableError } from "../../src/tui/client.js";
import { renderFrame } from "../../src/tui/render.js";
import { applyEvent, applyTick } from "../../src/tui/state.js";
import { activeStepUp, applyStepUpResult, confirmStepUp, formatStepUpCode } from "../../src/tui/step-up.js";
import { stripAnsi } from "../../src/tui/text.js";
import { HOST, NOW, RESET_STEPUP as RESET, fixtureState, hello, withStepUps } from "./fixture.js";

describe("step-up prompts", () => {
  it("queues each step-up once and shows the oldest that has not expired", () => {
    const s = withStepUps(fixtureState());
    expect(s.stepUps.map((p) => p.stepUpId)).toEqual(["su-1", "su-2"]);
    expect(activeStepUp(s)?.stepUpId).toBe("su-1");
    expect(activeStepUp(applyTick(s, NOW + 113_000))?.stepUpId).toBe("su-2");
    expect(applyTick(s, NOW + 120_000).stepUps).toEqual([]);
  });
  it("learns step-ups that were waiting before it connected from hello", () => {
    expect(applyEvent(fixtureState(), hello({ id: 20, actor: HOST, stepUps: [RESET] })).state.stepUps.map((p) => p.stepUpId)).toEqual(["su-2"]);
  });
  it("formats six-digit codes in two groups", () => {
    expect([formatStepUpCode("482913"), formatStepUpCode("AB12")]).toEqual(["482 913", "AB12"]);
  });
  it("draws the code and the command over the middle of the screen", () => {
    const lines = renderFrame(withStepUps(fixtureState()), { columns: 80, rows: 24 }).map(stripAnsi);
    const row = (s: string) => s.padEnd(80);
    expect(lines.slice(10, 17)).toEqual([
      row("          ┌─ step-up confirmation (1 more waiting) ──────────────────┐"),
      row("          │ register board-b project-b --min-cards 3                 │"),
      row("          │                                                          │"),
      row("          │                         482 913                          │"),
      row("          │                                                          │"),
      row("          │ expires in 1:52  Enter confirms  Esc dismisses           │"),
      row("          └──────────────────────────────────────────────────────────┘"),
    ]);
    expect(lines[9]).toBe(row(" # board-b          │"));
  });
  it("confirms through the brain and forgets the prompt", async () => {
    const s = withStepUps(fixtureState());
    const client = { confirmStepUp: vi.fn(async () => {}) };
    const outcome = await confirmStepUp(client, activeStepUp(s)!);
    expect(client.confirmStepUp).toHaveBeenCalledWith("su-1", "482913");
    const after = applyStepUpResult(s, "su-1", outcome);
    expect(after.stepUps.map((p) => p.stepUpId)).toEqual(["su-2"]);
    expect(after.status).toBe("step-up confirmed: register board-b project-b --min-cards 3");
  });
  it("forgets a step-up the brain refuses, and keeps one it could not reach", async () => {
    const s = withStepUps(fixtureState());
    const prompt = activeStepUp(s)!;
    const refused = await confirmStepUp({ confirmStepUp: async () => { throw new BrainHttpError(404, "not_found", "the step-up expired"); } }, prompt);
    expect(refused).toEqual({ ok: false, final: true, message: "the step-up expired" });
    expect(applyStepUpResult(s, "su-1", refused).status).toBe("step-up not confirmed: the step-up expired");
    const down = await confirmStepUp({ confirmStepUp: async () => { throw new BrainUnreachableError("http://127.0.0.1:3200", new Error("ECONNREFUSED")); } }, prompt);
    expect(down).toMatchObject({ ok: false, final: false });
    const kept = applyStepUpResult(s, "su-1", down);
    expect(kept.stepUps).toHaveLength(2);
    expect(kept.status).toBe("could not reach the brain; the step-up is still waiting");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/step-up.test.ts`
Expected: FAIL. `../../src/tui/step-up.js` does not exist yet.

- [ ] **Step 3: Implement `step-up.ts` and the two hooks in `state.ts` and `render.ts`**

- [ ] **Step 4: Run the test, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/step-up.test.ts tests/tui/render.test.ts tests/tui/state.test.ts`
Expected: PASS. The render goldens are unchanged, because the fixture has no step-ups. Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/tui/step-up.ts packages/os/src/tui/state.ts packages/os/src/tui/render.ts packages/os/src/tui/index.ts packages/os/tests/tui/fixture.ts packages/os/tests/tui/step-up.test.ts
git commit -m "feat(os): step-up codes shown and confirmed in swarm top on the host"
```

---

### Task 6: Key handling

**Files:**
- Create: `packages/os/src/tui/keys.ts`
- Modify: `packages/os/src/tui/index.ts`
- Test: `packages/os/tests/tui/keys.test.ts`

**Interfaces:**
- Consumes: `TuiState`, `Reduced`, `selectRoom`, `orderedRooms`, `openQuestion` (Task 3); `activeStepUp`, `dismissStepUp` (Task 5).
- Produces:

```ts
export type Key =
  | { kind: "char"; text: string } | { kind: "enter" } | { kind: "tab" } | { kind: "backspace" } | { kind: "escape" }
  | { kind: "up" } | { kind: "down" } | { kind: "pageup" } | { kind: "pagedown" } | { kind: "ctrl"; name: "c" | "u" }
  | { kind: "paste-start" } | { kind: "paste-end" };
export interface ReadlineKey { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
export function toKeys(str: string | undefined, key: ReadlineKey | undefined): Key[];
export function reduceKey(state: TuiState, key: Key, pageLines: number): Reduced;
export function splitCommandLine(line: string): string[] | { error: string };   // whitespace splits; "…" and '…' group; \ escapes; unterminated → { error: "unterminated quote" }
```

`toKeys` maps readline's names:
- `return` and `enter` → `enter`
- `tab`, `backspace`, `escape`, `up`, `down`, `pageup`, `pagedown`, `paste-start` and `paste-end` → themselves
- ctrl with `c` or `u` → `ctrl`
- meta with a key → `escape` followed by that key, so a quick "Esc q" still quits
- a printable `str` (no ctrl, code point ≥ 32, not DEL) → `char`
- anything else → `[]`

`reduceKey` clears `status`, then applies the first rule that matches:
1. `ctrl c` → `quit`.
2. An active step-up:
   - Enter emits `confirm-stepup` once and sets `confirming`.
   - Esc dismisses the step-up.
   - Every other key is ignored.
3. `helpOpen`: any key closes the help.
4. `paste-start` and `paste-end` toggle `pasting`. While pasting, `enter` inserts a space.
5. `up` and `down`, in any pane, move the selection through `orderedRooms`, skip the divider and stop at the ends, through `selectRoom`.
6. In the input line:
   - printable characters insert
   - `backspace` drops the last code point
   - `ctrl u` clears the line
   - `escape` moves to the rooms pane
   - `tab` cycles the panes
   - `enter` sends; see below
7. In the rooms pane:
   - `j` and `k` move rooms
   - `q` quits and `?` toggles the help
   - `enter` moves to the input line
   - `tab` cycles the panes
   - any other printable character moves to the input line and inserts itself, `/` included
8. In the messages pane:
   - `j` scrolls down to 0 and `k` scrolls up
   - `pageup` and `pagedown` scroll by `pageLines`
   - `q`, `?`, `enter`, `tab` and other printable characters behave as in the rooms pane

Tab cycles rooms → messages → input → rooms.

Enter in the input line works on `line = input.trim()`:
- An empty line does nothing.
- If the connection is not `open`, keep the line and set the status `offline; the line was kept`.
- A line starting with `//` is a message with body `line.slice(1)`.
- A line starting with `/` is a command, `argv = splitCommandLine(line.slice(1))`. An error keeps the line and sets the status `unterminated quote; nothing was sent`. An empty argv does nothing.
- An open question with a `questionId` gets `answer-question`. An open question without one gets `post-message` with `replyTo: messageId`. Anything else gets `post-message`.

Each send takes `ref = "r" + nextRef`, increments `nextRef`, records `pending[ref] = input`, clears the input and sets `scroll` to 0.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/tui/keys.test.ts
import { describe, expect, it } from "vitest";
import { reduceKey, splitCommandLine, toKeys, type Key } from "../../src/tui/keys.js";
import { applyConnection, applyEvent, type Reduced, type TuiState } from "../../src/tui/state.js";
import { fixtureState, message, question, withStepUps } from "./fixture.js";

const press = (s: TuiState, ...keys: Key[]): Reduced =>
  keys.reduce<Reduced>((acc, k) => { const r = reduceKey(acc.state, k, 15); return { state: r.state, effects: [...acc.effects, ...r.effects] }; }, { state: s, effects: [] });
const ch = (text: string): Key => ({ kind: "char", text });
const inRoomA = (input: string) => ({ ...fixtureState(), selectedRoomId: "room-ba", input });

describe("reduceKey", () => {
  it("Tab cycles the rooms pane, the messages pane and the input line", () => {
    const one = press(fixtureState(), { kind: "tab" }).state;
    expect([one.focus, press(one, { kind: "tab" }).state.focus, press(one, { kind: "tab" }, { kind: "tab" }).state.focus]).toEqual(["rooms", "messages", "input"]);
  });
  it("arrows move between rooms from any pane, skip the divider and load history", () => {
    const r = press(fixtureState(), { kind: "down" });
    expect(r.state.selectedRoomId).toBe("room-sys");
    expect(r.effects).toEqual([{ kind: "load-history", roomId: "room-sys" }]);
    expect(press({ ...fixtureState(), selectedRoomId: "room-d1" }, { kind: "down" }).state.selectedRoomId).toBe("room-i40");
    expect(press(fixtureState(), { kind: "up" }).state.selectedRoomId).toBe("room-cos");
  });
  it("selecting a room clears its unread count", () => {
    const r = press({ ...fixtureState(), selectedRoomId: "room-sys" }, { kind: "down" }).state;
    expect([r.selectedRoomId, r.unread["room-ba"]]).toEqual(["room-ba", 0]);
  });
  it("j and k move rooms in the rooms pane, scroll in the messages pane, and type in the input line", () => {
    expect(press({ ...fixtureState(), focus: "rooms" }, ch("j")).state.selectedRoomId).toBe("room-sys");
    const scrolled = press({ ...fixtureState(), focus: "messages" }, ch("k"), ch("k"), ch("j")).state;
    expect([scrolled.scroll, scrolled.selectedRoomId]).toEqual([1, "room-cos"]);
    expect(press({ ...fixtureState(), input: "" }, ch("j"), ch("k")).state.input).toBe("jk");
  });
  it("q quits from the panes and is a letter in the input line", () => {
    expect(press({ ...fixtureState(), focus: "rooms" }, ch("q")).effects).toEqual([{ kind: "quit" }]);
    expect(press({ ...fixtureState(), focus: "messages" }, ch("q")).effects).toEqual([{ kind: "quit" }]);
    expect(press({ ...fixtureState(), input: "" }, ch("q")).state.input).toBe("q");
  });
  it("? opens help from a pane and any key closes it", () => {
    const open = press({ ...fixtureState(), focus: "rooms" }, ch("?")).state;
    expect(open.helpOpen).toBe(true);
    const closed = press(open, ch("q"));
    expect([closed.state.helpOpen, closed.effects]).toEqual([false, []]);
  });
  it("Enter sends the line as a message and clears it", () => {
    const r = press(inRoomA("looks good"), { kind: "enter" });
    expect(r.effects).toEqual([{ kind: "post-message", ref: "r1", roomId: "room-ba", body: "looks good" }]);
    expect([r.state.input, r.state.pending]).toEqual(["", { r1: "looks good" }]);
  });
  it("Enter answers the open question in the room", () => {
    expect(press(fixtureState(), { kind: "enter" }).effects).toEqual([{ kind: "post-message", ref: "r1", roomId: "room-cos", body: "take it anyway", replyTo: "msg-3" }]);
    const asked = applyEvent(fixtureState(), { type: "message", id: 9, message: message({ id: "msg-q", seq: 4, fromKind: "worker", kind: "question", body: "Which port?" }) }).state;
    const withRow = applyEvent(asked, { type: "question", id: 10, question: question("q-1", "msg-q", "open") }).state;
    expect(press({ ...withRow, input: "3141" }, { kind: "enter" }).effects).toEqual([{ kind: "answer-question", ref: "r1", questionId: "q-1", body: "3141" }]);
  });
  it("a line starting with / is a command, and // sends a literal slash", () => {
    expect(press(inRoomA('/hold board-a 42 "too big for now"'), { kind: "enter" }).effects).toEqual([{ kind: "post-command", ref: "r1", roomId: "room-ba", argv: ["hold", "board-a", "42", "too big for now"] }]);
    expect(press(inRoomA("//tmp is full"), { kind: "enter" }).effects).toEqual([{ kind: "post-message", ref: "r1", roomId: "room-ba", body: "/tmp is full" }]);
  });
  it("an unterminated quote keeps the line and says why", () => {
    const r = press(inRoomA('/hold board-a 42 "too big'), { kind: "enter" });
    expect([r.effects, r.state.input, r.state.status]).toEqual([[], '/hold board-a 42 "too big', "unterminated quote; nothing was sent"]);
  });
  it("Enter while offline keeps the line and says so", () => {
    const r = press(applyConnection(fixtureState(), { state: "offline", message: "fetch failed" }), { kind: "enter" });
    expect([r.effects, r.state.input, r.state.status]).toEqual([[], "take it anyway", "offline; the line was kept"]);
  });
  it("a paste with newlines inserts one line and sends nothing", () => {
    const r = press({ ...fixtureState(), input: "" }, { kind: "paste-start" }, ch("first"), { kind: "enter" }, ch("second"), { kind: "paste-end" });
    expect([r.effects, r.state.input]).toEqual([[], "first second"]);
  });
  it("Ctrl-C quits from anywhere, the step-up box included", () => {
    expect(press(withStepUps(fixtureState()), { kind: "ctrl", name: "c" }).effects).toEqual([{ kind: "quit" }]);
  });
  it("with a step-up on screen, Enter confirms it once, Esc dismisses it and letters do nothing", () => {
    const s = withStepUps(fixtureState());
    expect(press(s, { kind: "enter" }, { kind: "enter" }).effects).toEqual([{ kind: "confirm-stepup", stepUpId: "su-1", code: "482913" }]);
    expect(press(s, ch("x")).state.input).toBe("take it anyway");
    expect(press(s, { kind: "escape" }).state.stepUps.map((p) => p.stepUpId)).toEqual(["su-2"]);
  });
  it("Backspace removes the last character, wide ones included; Ctrl-U clears", () => {
    expect(press({ ...fixtureState(), input: "ab漢" }, { kind: "backspace" }).state.input).toBe("ab");
    expect(press(fixtureState(), { kind: "ctrl", name: "u" }).state.input).toBe("");
  });
});

describe("toKeys", () => {
  it("maps readline keypresses to keys", () => {
    expect(toKeys("\r", { name: "return" })).toEqual([{ kind: "enter" }]);
    expect(toKeys(undefined, { name: "up" })).toEqual([{ kind: "up" }]);
    expect(toKeys("\u0003", { name: "c", ctrl: true })).toEqual([{ kind: "ctrl", name: "c" }]);
    expect(toKeys(undefined, { name: "q", meta: true, sequence: "\u001bq" })).toEqual([{ kind: "escape" }, { kind: "char", text: "q" }]);
    expect(toKeys("漢", { sequence: "漢" })).toEqual([{ kind: "char", text: "漢" }]);
    expect(toKeys(undefined, { name: "paste-start" })).toEqual([{ kind: "paste-start" }]);
    expect(toKeys("\u0007", { name: "g", ctrl: true })).toEqual([]);
  });
});

describe("splitCommandLine", () => {
  it.each([
    ["hold board-a 42", ["hold", "board-a", "42"]],
    ['say room-ba "two  spaces"', ["say", "room-ba", "two  spaces"]],
    ["say room-ba 'single quoted'", ["say", "room-ba", "single quoted"]],
    ['a "b\\"c"', ["a", 'b"c']],
    ["  spaced   out  ", ["spaced", "out"]],
    ['x ""', ["x", ""]],
  ])("%s", (line, argv) => expect(splitCommandLine(line)).toEqual(argv));
  it("reports an unterminated quote", () => expect(splitCommandLine('a "b')).toEqual({ error: "unterminated quote" }));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/keys.test.ts`
Expected: FAIL. `../../src/tui/keys.js` does not exist yet.

- [ ] **Step 3: Implement `packages/os/src/tui/keys.ts` to the rules above, and export it**

- [ ] **Step 4: Run the test, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/keys.test.ts`
Expected: PASS (23 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/tui/keys.ts packages/os/src/tui/index.ts packages/os/tests/tui/keys.test.ts
git commit -m "feat(os): swarm top key handling as a pure reducer"
```

---

### Task 7: The terminal shell and `swarm top`

**Files:**
- Create: `packages/os/src/tui/screen.ts`, `packages/os/src/tui/app.ts`
- Modify: `packages/os/src/tui/index.ts`
- Create: `packages/cli/src/cli/top.ts`
- Test: `packages/os/tests/tui/screen.test.ts`, `packages/os/tests/tui/app.test.ts`, `packages/cli/tests/top.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6. Main.ts's `top` early return (plan 03), which runs before the Substrate bootstrap and calls `runTop(flags)` from `./top.js`. Plan 03's `@mnmal-ai/swarm-os` dependency in `packages/cli/package.json`.
- Produces:

```ts
// screen.ts
export const MIN_FRAME_INTERVAL_MS = 100;                            // 10 fps
export const ENTER_SCREEN = "\x1b[?1049h\x1b[?2004h\x1b[?25l";      // alternate screen, bracketed paste, cursor hidden
export const LEAVE_SCREEN = "\x1b[?25h\x1b[?2004l\x1b[?1049l";
export class RenderScheduler { constructor(render: () => void, now?: () => number); request(): void; dispose(): void }   // immediate when idle ≥ 100 ms, else one trailing render
export function diffFrame(prev: string[] | null, next: string[]): string;    // null or another row count: "\x1b[2J" + every row; else only changed rows; each row "\x1b[<n>;1H" + row
export function cursorSequence(pos: { row: number; column: number } | null): string;   // "\x1b[r;cH\x1b[?25h" or "\x1b[?25l"
// app.ts
export interface TtyIn extends NodeJS.EventEmitter { isTTY?: boolean; setRawMode?(raw: boolean): unknown; resume(): unknown; pause(): unknown }
export interface TtyOut extends NodeJS.EventEmitter { isTTY?: boolean; columns?: number; rows?: number; write(chunk: string): unknown }
export type BrainClientLike = Pick<BrainClient, "connect" | "close" | "listRooms" | "roomMessages" | "postMessage" | "answerQuestion" | "postCommand" | "confirmStepUp">;
export interface RunTuiOptions { client: BrainClientLike; url?: string; stdin: TtyIn; stdout: TtyOut; room?: string; now?: () => number; timeZone?: string; signals?: NodeJS.EventEmitter }
export function runTui(opts: RunTuiOptions): Promise<number>;      // 0 on quit; 1 after a fatal error; the terminal is restored on every path
// packages/cli/src/cli/top.ts
export interface TopDeps { credentials(url?: string): BrainCredentials; makeClient(c: BrainCredentials): BrainClientLike; runTui(o: RunTuiOptions): Promise<number>; stdin: TtyIn; stdout: TtyOut; err(line: string): void; exit(code: number): void }
export function runTop(flags: Record<string, string>, deps?: Partial<TopDeps>): Promise<void>;   // flags: --url, --room
```

`runTui`:
1. Write `ENTER_SCREEN`, call `setRawMode(true)`, then `readline.emitKeypressEvents(stdin)` and `stdin.resume()`.
2. Every input goes through the reducers, then `scheduler.request()`:
   - `client.connect` events through `applyEvent`, and its statuses through `applyConnection`
   - keypresses through `toKeys`, then `reduceKey(state, key, computeLayout(size).middleRows − 1)`
   - a 1 000 ms tick through `applyTick`
3. Effects:
   - `post-message` and `answer-question` call the client, then `applySendResult`. A failure's message is `describeClientError(err, url)`, else `err.message`.
   - `post-command` calls the client, then `applyCommandOutcome`; a transport failure goes through `applySendResult`.
   - `load-history` → `roomMessages(id, { limit: HISTORY_LIMIT })` → `applyHistory`.
   - `refresh-rooms` → `listRooms()` → `applyRooms`.
   - `confirm-stepup` → `confirmStepUp` → `applyStepUpResult`.
   - `quit` ends the run.
4. To render, write `diffFrame(prev, frame) + cursorSequence(cursorPosition(state, size))` when either part changed.
5. On `resize`, take `stdout.columns` × `stdout.rows` (80×24 when unset) and draw a full frame.
6. `SIGTERM` and `SIGHUP` on `signals` (default `process`) quit.
7. Cleanup runs on every path, including a throw from `connect`, and in this order: stop the tick and the scheduler, `client.close()`, remove every listener, `setRawMode(false)`, `stdin.pause()`, and write `LEAVE_SCREEN` last.

`runTop`:
1. If stdin or stdout is not a TTY: `err("swarm top needs an interactive terminal; swarm os top prints the same summary once.")`, then `exit(1)`.
2. Get the credentials from `credentials(flags.url)`.
3. Probe with `makeClient(c).listRooms()`.
4. Any error with a `describeClientError` text: `err` that text and `exit(1)`.
5. Run `code = await runTui({ client, url, stdin, stdout, room: flags.room })`, and `exit(code)` when it is not 0.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/os/tests/tui/screen.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler, cursorSequence, diffFrame } from "../../src/tui/screen.js";

describe("RenderScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("renders at most every 100 ms and never drops the last request", () => {
    const render = vi.fn();
    const s = new RenderScheduler(render, () => Date.now());
    for (let i = 0; i < 5; i++) { s.request(); vi.advanceTimersByTime(6); }
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(render).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    s.request();
    expect(render).toHaveBeenCalledTimes(3);
  });
});

describe("diffFrame", () => {
  it("redraws everything the first time and only changed rows after", () => {
    expect(diffFrame(null, ["ab", "cd"])).toBe("\x1b[2J\x1b[1;1Hab\x1b[2;1Hcd");
    expect(diffFrame(["ab", "cd"], ["ab", "ce"])).toBe("\x1b[2;1Hce");
    expect(diffFrame(["ab", "cd"], ["ab", "cd"])).toBe("");
    expect(diffFrame(["ab"], ["ab", "cd"])).toBe("\x1b[2J\x1b[1;1Hab\x1b[2;1Hcd");
  });
  it("places or hides the cursor", () => {
    expect(cursorSequence({ row: 24, column: 18 })).toBe("\x1b[24;18H\x1b[?25h");
    expect(cursorSequence(null)).toBe("\x1b[?25l");
  });
});
```

```ts
// packages/os/tests/tui/app.test.ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTui, type BrainClientLike } from "../../src/tui/app.js";
import { BrainClient } from "../../src/tui/client.js";
import { ENTER_SCREEN, LEAVE_SCREEN } from "../../src/tui/screen.js";
import { stripAnsi } from "../../src/tui/text.js";
import { startFakeBrain, type FakeBrain } from "./fake-brain.js";
import { COS_MESSAGES, INSTANCES, NOW, OWNER, RESOURCES, ROOMS } from "./fixture.js";

class FakeIn extends PassThrough { isTTY = true; raw: boolean[] = []; setRawMode(v: boolean) { this.raw.push(v); return this; } }
class FakeOut extends EventEmitter { isTTY = true; columns = 80; rows = 24; chunks: string[] = []; write(c: string) { this.chunks.push(c); return true; } text() { return this.chunks.join(""); } }
let brain: FakeBrain | undefined;
afterEach(async () => { await brain?.close(); brain = undefined; });
const opts = { now: () => NOW, timeZone: "UTC", signals: new EventEmitter() };

describe("runTui", () => {
  it("runs against a brain: shows the chief of staff's room, answers its question, quits on Ctrl-C", async () => {
    brain = await startFakeBrain({
      "GET /api/rooms/room-cos/messages": () => ({ status: 200, body: { messages: COS_MESSAGES } }),
      "POST /api/rooms/room-cos/messages": () => ({ status: 200, body: {} }),
    }, { hello: () => ({ actor: OWNER, rooms: ROOMS, instances: INSTANCES, resources: RESOURCES, lockdown: false }) });
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const done = runTui({ client: new BrainClient({ url: brain.url, bearer: "sess_abc" }), url: brain.url, stdin, stdout, ...opts });
    await vi.waitFor(() => expect(stripAnsi(stdout.text())).toContain("what's running?"));
    expect(stdout.text().startsWith(ENTER_SCREEN)).toBe(true);
    stdin.write("take it anyway\r");
    await vi.waitFor(() => expect(brain!.requests.some((r) => r.method === "POST")).toBe(true));
    const post = brain.requests.find((r) => r.method === "POST")!;
    expect([post.path, post.body, post.headers["x-swarm-os"]]).toEqual(["/api/rooms/room-cos/messages", { kind: "text", body: "take it anyway", replyTo: "msg-3" }, "1"]);
    stdin.write("\u0003");
    expect(await done).toBe(0);
    expect(stdout.chunks.at(-1)).toBe(LEAVE_SCREEN);
    expect(stdin.raw).toEqual([true, false]);
  });

  it("redraws the whole frame at the new size on resize", async () => {
    brain = await startFakeBrain({ "GET /api/rooms/room-cos/messages": () => ({ status: 200, body: [] }) }, { hello: () => ({ actor: OWNER, rooms: ROOMS, instances: INSTANCES, resources: RESOURCES, lockdown: false }) });
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const done = runTui({ client: new BrainClient({ url: brain.url, bearer: "sess_abc" }), stdin, stdout, ...opts });
    await vi.waitFor(() => expect(stripAnsi(stdout.text())).toContain("chief of staff"));
    stdout.columns = 120;
    stdout.rows = 40;
    stdout.emit("resize");
    await vi.waitFor(() => expect(stdout.chunks.some((c) => c.startsWith("\x1b[2J") && stripAnsi(c).includes("DASHBOARD"))).toBe(true));
    stdin.write("\u0003");
    await done;
  });

  it("restores the terminal when connecting throws", async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const client = { connect: () => { throw new Error("no fetch in this runtime"); }, close: vi.fn() } as unknown as BrainClientLike;
    expect(await runTui({ client, stdin, stdout, ...opts })).toBe(1);
    expect(stdout.chunks.at(-1)).toBe(LEAVE_SCREEN);
    expect(stdin.raw).toEqual([true, false]);
  });

  it("quits on SIGTERM", async () => {
    const signals = new EventEmitter();
    const client = { connect: vi.fn(), close: vi.fn() } as unknown as BrainClientLike;
    const done = runTui({ client, stdin: new FakeIn(), stdout: new FakeOut(), ...opts, signals });
    signals.emit("SIGTERM");
    expect(await done).toBe(0);
  });
});
```

```ts
// packages/cli/tests/top.test.ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BrainUnreachableError, NotSignedInError } from "@mnmal-ai/swarm-os";
import { runTop } from "../src/cli/top.js";

const URL = "http://127.0.0.1:3200";
const tty = (isTTY = true) => ({ stdin: Object.assign(new PassThrough(), { isTTY }), stdout: Object.assign(new EventEmitter(), { isTTY, columns: 80, rows: 24, write: () => true }) });
const host = (url?: string) => ({ url: url ?? URL, bearer: "host_s3cret", actor: "host" as const });

describe("runTop", () => {
  it("needs an interactive terminal", async () => {
    const err = vi.fn(); const exit = vi.fn(); const runTui = vi.fn();
    await runTop({}, { ...tty(false), err, exit, runTui, credentials: host });
    expect(err).toHaveBeenCalledWith("swarm top needs an interactive terminal; swarm os top prints the same summary once.");
    expect(exit).toHaveBeenCalledWith(1);
    expect(runTui).not.toHaveBeenCalled();
  });
  it("says how to sign in when there are no credentials", async () => {
    const err = vi.fn(); const exit = vi.fn();
    await runTop({ url: "https://brain.example.test" }, { ...tty(), err, exit, runTui: vi.fn(), credentials: () => { throw new NotSignedInError("https://brain.example.test", "none"); } });
    expect(err).toHaveBeenCalledWith("Not signed in to https://brain.example.test. On the brain's host this happens by itself; anywhere else run: swarm os login --url https://brain.example.test");
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("says when no brain answers, before taking over the screen", async () => {
    const err = vi.fn(); const exit = vi.fn(); const runTui = vi.fn();
    const makeClient = () => ({ listRooms: async () => { throw new BrainUnreachableError(URL, new Error("ECONNREFUSED")); } }) as never;
    await runTop({}, { ...tty(), err, exit, runTui, credentials: host, makeClient });
    expect(err).toHaveBeenCalledWith(`No brain is answering at ${URL}. Start it on its host with: swarm os start`);
    expect(runTui).not.toHaveBeenCalled();
  });
  it("runs the TUI on the room asked for and passes on its exit code", async () => {
    const client = { listRooms: async () => [] } as never;
    const runTui = vi.fn(async () => 3); const exit = vi.fn();
    await runTop({ room: "board-a" }, { ...tty(), err: vi.fn(), exit, runTui, credentials: host, makeClient: () => client });
    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ client, room: "board-a", url: URL }));
    expect(exit).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui/screen.test.ts tests/tui/app.test.ts`
Expected: FAIL. `../../src/tui/screen.js` and `../../src/tui/app.js` do not exist yet.

- [ ] **Step 3: Implement `screen.ts`, `app.ts` and `packages/cli/src/cli/top.ts`**

Export `runTui`, `RunTuiOptions`, `BrainClientLike`, `TtyIn` and `TtyOut` from `tui/index.ts`. In `top.ts` the defaults are `process.stdin`, `process.stdout`, `console.error`, `process.exit`, `(url) => resolveBrainCredentials({ url })` and `(c) => new BrainClient({ url: c.url, bearer: c.bearer })`.

- [ ] **Step 4: Run the tests, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/tui && cd ../.. && pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/top.test.ts`
Expected: PASS. Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/tui/screen.ts packages/os/src/tui/app.ts packages/os/src/tui/index.ts packages/os/tests/tui/screen.test.ts packages/os/tests/tui/app.test.ts packages/cli/src/cli/top.ts packages/cli/tests/top.test.ts
git commit -m "feat(cli): swarm top, the brain's terminal client"
```

---

### Task 8: `swarm os` command subcommands, `swarm os login` and the `os.ts` guard

**Files:**
- Create: `packages/cli/src/cli/args.ts`, holding main.ts's `BOOLEAN_FLAGS`, `FLAG_ALIASES` and `parseArgs`, moved verbatim with `now` and `ask-first` added to `BOOLEAN_FLAGS`.
- Modify: `packages/cli/src/cli/main.ts`. Replace those three declarations at the top of the file with `import { parseArgs } from "./args.js";`. The `room-mcp`, `os` and `top` early returns stay where plans 01 and 03 put them.
- Create: `packages/cli/src/cli/os-commands.ts`
- Modify: `packages/cli/src/cli/os.ts` (plan 03): add one import and one guard line, described in Step 4.
- Test: `packages/cli/tests/cli-args.test.ts`, `packages/cli/tests/os-commands.test.ts`, `packages/cli/tests/os-dispatch.test.ts`

**Interfaces:**
- Consumes: `runOs(positional, flags)` in plan 03's `os.ts`; `BrainClient`, `classifyCommandReply`, `pollCliLogin`, `resolveBrainCredentials`, `resolveBrainUrl`, `resolveOsHome`, `writeSessionFile`, `readSessionFile` and `describeClientError` (Task 2, from `@mnmal-ai/swarm-os`); `isCliNonce`'s format (Task 1).
- Produces:

```ts
// args.ts
export const BOOLEAN_FLAGS: ReadonlySet<string>;
export const FLAG_ALIASES: Readonly<Record<string, string>>;
export function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] };
// os-commands.ts
export interface OsCommandEntry { name: string; usage: string; minArgs: number; firstArg?: readonly string[]; joinFrom?: number }
export const OS_COMMANDS: readonly OsCommandEntry[];
export const CLIENT_ONLY_FLAGS: ReadonlySet<string>;          // url, room, stepup, code, quiet, help, h
export function routesToOsCommand(positional: string[]): boolean;
export function buildCommandArgv(positional: string[], flags: Record<string, string>, cwd?: string): { argv: string[] } | { usage: string };
export function stepUpInstructions(name: string, stepUpId: string, expiresAt: string | null): string[];
export interface OsCommandDeps { credentials(url?: string): BrainCredentials; client(c: BrainCredentials): Pick<BrainClient, "listRooms" | "postCommand">; fetch: typeof fetch; osHome: string; out(line: string): void; err(line: string): void; sleep(ms: number): Promise<void>; randomToken(): string }
export function executeOsCommand(positional: string[], flags: Record<string, string>, deps?: Partial<OsCommandDeps>): Promise<number>;
export function runLogin(flags: Record<string, string>, deps?: Partial<OsCommandDeps>): Promise<number>;
export function runOsCommand(positional: string[], flags: Record<string, string>): Promise<void>;   // process.exit(code) when the code is not 0
```

`OS_COMMANDS`, in this order. `minArgs` counts positional words after the name; `firstArg` restricts the first of them; `joinFrom` joins the words from that index into one argument:

| name | usage | minArgs | firstArg | joinFrom |
|---|---|---|---|---|
| `register` | `swarm os register <board> <project> <swarm-path> [--queue-column <name>] [--repo-root <path>] [--host <name>] [--min-cards <n>] [--max-instances <n>] [--tokens-per-hour <n>] [--skip-labels <a,b>] [--owners <a,b>] [--ask-first] [--description <text>]` | 3 | | |
| `unregister` | `swarm os unregister <registration>` | 1 | | |
| `set` | `swarm os set ask_first <registration> on\|off \| swarm os set limits <registration> [--max-instances <n>] [--tokens-per-hour <n>] [--min-cards <n>]` | 2 | `ask_first`, `limits` | |
| `dispatch` | `swarm os dispatch <board> <card>` | 2 | | |
| `hold` | `swarm os hold <board> <card> [reason]` | 2 | | 2 |
| `override` | `swarm os override min_cards <board>` | 2 | `min_cards` | |
| `retry` | `swarm os retry run <instance> [--fresh]` | 2 | `run` | |
| `pause` | `swarm os pause board <board> \| swarm os pause run <instance>` | 2 | `board`, `run` | |
| `resume` | `swarm os resume board <board> \| swarm os resume run <instance>` | 2 | `board`, `run` | |
| `stop` | `swarm os stop run <instance> [--now]` | 2 | `run` | |
| `say` | `swarm os say <room> <text>` | 2 | | 1 |
| `rooms`, `instances`, `top` | `swarm os <name>` | 0 | | |
| `why` | `swarm os why <board> <card>` | 2 | | |

Rules:
- **`routesToOsCommand`** is true for `login` and for every name above, except `stop`, which it claims only when the next word is `run`.
- **`buildCommandArgv`** builds the argv as the name, then the positional words (joined per `joinFrom`), then every flag not in `CLIENT_ONLY_FLAGS`, in insertion order: `--<key> <value>`, or `--<key>` alone when the value is `"true"`. For `register`, the swarm path and `--repo-root` are resolved against `cwd`, because the brain's working directory is not the caller's.
- **`--stepup` and `--code`** must come together, or `buildCommandArgv` answers the usage. When both are given, `postCommand` gets them as `{ stepUpId, code }`.
- **`executeOsCommand`** hands `login` to `runLogin`. Every other subcommand works in order:
  1. Build the argv. A usage answer prints `Usage: <usage>` to stderr and exits 1.
  2. Get the credentials and list the rooms. Any `describeClientError` text goes to stderr, exit 1.
  3. Pick the room: `--room` matches an id, then a name. No match prints `No room "<x>". Rooms: <names joined by ", ">.` and exits 1. Without `--room`, the room is the one of kind `system`.
  4. Post the command and map the outcome:
     - `ok`: print `result.text` to stdout, exit 0.
     - `failed`: print it to stderr, exit 1.
     - `stepup_required`: print `stepUpInstructions` to stderr, exit 2.
     - `cooldown`: `swarm os <name>: this session is cooling down until <cooldownUntil>; every owner has been told.`, exit 3.
     - `limit`: `swarm os <name>: refused by the <limit> limit in os.json (<message>).`, exit 3.
     - `forbidden`: `swarm os <name>: refused (<code>): <message>`, exit 4.
- **`stepUpInstructions`** prints exactly these lines, the last only when `expiresAt` is known. It never prints the brain's text or data:
  1. `swarm os <name>: this is a standing command, so it needs a step-up confirmation (step-up <stepUpId>).`
  2. `The code is shown only on the brain's host, in swarm top (or on a confirmer device); it is never printed here.`
  3. `Confirm it there with Enter, or on the host run: swarm os confirm <stepUpId> <code>`
  4. `Or run this command again with: --stepup <stepUpId> --code <code>`
  5. `The code expires at <expiresAt>.`
- **`runLogin`**:
  1. `url = resolveBrainUrl(flags.url, osHome)`. Draw a nonce and a poll secret, each `randomToken()`: 32 random bytes in base64url.
  2. On the first 202, print `Open this link on a device that is signed in to the dashboard, and approve the terminal sign-in:`, `  <approveUrl>` and `Waiting for approval (the link expires at <expiresAt>)...`.
  3. While the replies are 202, keep polling after `sleep(intervalMs)`.
  4. On 200, `writeSessionFile(osHome, { url, token, expiresAt, humanId, deviceId })`, print `Signed in to <url> until <expiresAt>.` and exit 0.
  5. Map the other outcomes to stderr and exit 1:
     - 404 `expired`: `The sign-in link expired before it was approved. Run swarm os login again.`
     - other 404: `The brain no longer knows this sign-in (it restarted, or the link was already used). Run swarm os login again.`
     - 429: `The brain has too many sign-ins waiting. Try again in a few minutes.`
     - `BrainUnreachableError` on the first poll: `describeClientError`
  6. A `BrainUnreachableError` on a later poll is retried until 11 minutes have passed.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/cli-args.test.ts
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
  it("parses as main.ts always has, with --now and --ask-first as booleans", () => {
    expect(parseArgs(["stop", "run", "inst-1", "--now"])).toEqual({ flags: { now: "true" }, positional: ["stop", "run", "inst-1"] });
    expect(parseArgs(["--now", "run"])).toEqual({ flags: { now: "true" }, positional: ["run"] });
    expect(parseArgs(["status", "--project", "project-a", "-y", "--lan-dashboard", "--ask-first"])).toEqual({ flags: { project: "project-a", yes: "true", "dashboard-lan": "true", "ask-first": "true" }, positional: ["status"] });
  });
});
```

```ts
// packages/cli/tests/os-commands.test.ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyCommandReply, NotSignedInError, readSessionFile } from "@mnmal-ai/swarm-os";
import { buildCommandArgv, executeOsCommand, routesToOsCommand, runLogin } from "../src/cli/os-commands.js";

const ROOMS = [{ id: "room-sys", kind: "system", name: "system" }, { id: "room-ba", kind: "board", name: "board-a" }];
function stub(status: number, body: unknown) {
  const posts: Array<{ room: string; argv: string[]; stepUp?: unknown }> = [];
  const out: string[] = []; const err: string[] = [];
  const client = { listRooms: vi.fn(async () => ROOMS), postCommand: vi.fn(async (room: string, argv: string[], stepUp?: unknown) => { posts.push({ room, argv, ...(stepUp ? { stepUp } : {}) }); return classifyCommandReply(status, body); }) };
  const deps = { credentials: () => ({ url: "http://127.0.0.1:3200", bearer: "host_s3cret", actor: "host" as const }), client: () => client as never, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  return { posts, out, err, deps };
}

describe("routesToOsCommand", () => {
  it.each([
    [["dispatch", "board-a", "42"], true], [["stop", "run", "inst-1"], true], [["stop"], false], [["start"], false],
    [["status"], false], [["confirm", "su-1", "482913"], false], [["login"], true], [["top"], true], [["set", "limits", "reg-a"], true], [[], false],
  ])("%j → %s", (positional, expected) => expect(routesToOsCommand(positional as string[])).toBe(expected));
});

describe("buildCommandArgv", () => {
  it.each([
    [["dispatch", "board-a", "42"], {}, ["dispatch", "board-a", "42"]],
    [["hold", "board-a", "42", "waiting", "on", "design"], {}, ["hold", "board-a", "42", "waiting on design"]],
    [["override", "min_cards", "board-a"], {}, ["override", "min_cards", "board-a"]],
    [["pause", "board", "board-a"], {}, ["pause", "board", "board-a"]],
    [["resume", "run", "inst-1"], {}, ["resume", "run", "inst-1"]],
    [["retry", "run", "inst-1"], { fresh: "true" }, ["retry", "run", "inst-1", "--fresh"]],
    [["stop", "run", "inst-1"], { now: "true", url: "http://127.0.0.1:3200", room: "board-a" }, ["stop", "run", "inst-1", "--now"]],
    [["say", "board-a", "on", "it"], {}, ["say", "board-a", "on it"]],
    [["set", "ask_first", "reg-a", "on"], {}, ["set", "ask_first", "reg-a", "on"]],
    [["unregister", "reg-a"], {}, ["unregister", "reg-a"]],
    [["rooms"], {}, ["rooms"]], [["instances"], {}, ["instances"]], [["top"], {}, ["top"]],
    [["why", "board-a", "42"], {}, ["why", "board-a", "42"]],
  ])("%j %j", (positional, flags, argv) => expect(buildCommandArgv(positional, flags)).toEqual({ argv }));
  it("resolves register's paths against the caller's directory", () => {
    expect(buildCommandArgv(["register", "board-a", "project-a", ".swarm"], { "min-cards": "3", "ask-first": "true", "repo-root": "." }, "/path/to/project-a"))
      .toEqual({ argv: ["register", "board-a", "project-a", "/path/to/project-a/.swarm", "--min-cards", "3", "--ask-first", "--repo-root", "/path/to/project-a"] });
  });
  it("answers the usage for missing or wrong arguments", () => {
    expect(buildCommandArgv(["dispatch", "board-a"], {})).toEqual({ usage: "swarm os dispatch <board> <card>" });
    expect(buildCommandArgv(["pause", "card", "x"], {})).toEqual({ usage: "swarm os pause board <board> | swarm os pause run <instance>" });
    expect(buildCommandArgv(["stop", "run"], {})).toEqual({ usage: "swarm os stop run <instance> [--now]" });
    expect(buildCommandArgv(["dispatch", "board-a", "42"], { stepup: "su-1" })).toEqual({ usage: "swarm os dispatch <board> <card>" });
  });
});

describe("executeOsCommand", () => {
  it("posts the argv in the system room and prints the reply", async () => {
    const t = stub(200, { ok: true, text: "Dispatched board-a:42 as inst-9." });
    expect(await executeOsCommand(["dispatch", "board-a", "42"], {}, t.deps)).toBe(0);
    expect(t.posts).toEqual([{ room: "room-sys", argv: ["dispatch", "board-a", "42"] }]);
    expect(t.out).toEqual(["Dispatched board-a:42 as inst-9."]);
  });
  it("posts in the room --room names, and lists the rooms when it names none", async () => {
    const t = stub(200, { ok: true, text: "said" });
    expect(await executeOsCommand(["say", "board-a", "hi"], { room: "board-a" }, t.deps)).toBe(0);
    expect(t.posts[0].room).toBe("room-ba");
    expect(await executeOsCommand(["say", "board-a", "hi"], { room: "board-z" }, t.deps)).toBe(1);
    expect(t.err).toEqual(['No room "board-z". Rooms: system, board-a.']);
  });
  it("prints a refused command to stderr and exits 1", async () => {
    const t = stub(200, { ok: false, text: "no such board: board-z" });
    expect(await executeOsCommand(["dispatch", "board-z", "1"], {}, t.deps)).toBe(1);
    expect(t.err).toEqual(["no such board: board-z"]);
  });
  it("on 428 prints how to confirm, never the code, and exits 2", async () => {
    const t = stub(428, { error: { code: "stepup_required", message: "Step-up 482913 sent to confirmers.", stepUpId: "su-1", expiresAt: "2026-10-25T09:02:00.000Z", stepUpCode: "482913" } });
    expect(await executeOsCommand(["register", "board-b", "project-b", "/path/to/project-b/.swarm"], {}, t.deps)).toBe(2);
    expect(t.err).toEqual([
      "swarm os register: this is a standing command, so it needs a step-up confirmation (step-up su-1).",
      "The code is shown only on the brain's host, in swarm top (or on a confirmer device); it is never printed here.",
      "Confirm it there with Enter, or on the host run: swarm os confirm su-1 <code>",
      "Or run this command again with: --stepup su-1 --code <code>",
      "The code expires at 2026-10-25T09:02:00.000Z.",
    ]);
    expect([...t.out, ...t.err].join("\n")).not.toContain("482913");
  });
  it("sends the step-up id and code the person passes", async () => {
    const t = stub(200, { ok: true, text: "Registered." });
    await executeOsCommand(["register", "board-b", "project-b", "/path/to/project-b/.swarm"], { stepup: "su-1", code: "482913" }, t.deps);
    expect(t.posts[0].stepUp).toEqual({ stepUpId: "su-1", code: "482913" });
  });
  it("exits 3 on a cool-down or a limit and 4 on a refusal", async () => {
    const cool = stub(429, { error: { code: "cooldown", message: "cooling down", cooldownUntil: "2026-10-25T09:10:00.000Z" } });
    expect(await executeOsCommand(["dispatch", "board-a", "42"], {}, cool.deps)).toBe(3);
    expect(cool.err).toEqual(["swarm os dispatch: this session is cooling down until 2026-10-25T09:10:00.000Z; every owner has been told."]);
    const limit = stub(429, { error: { code: "limit", message: "limit max_instances: 1 of 1", limit: "max_instances" } });
    expect(await executeOsCommand(["dispatch", "board-a", "42"], {}, limit.deps)).toBe(3);
    expect(limit.err).toEqual(["swarm os dispatch: refused by the max_instances limit in os.json (limit max_instances: 1 of 1)."]);
    const locked = stub(403, { error: { code: "lockdown", message: "the brain is in lockdown" } });
    expect(await executeOsCommand(["dispatch", "board-a", "42"], {}, locked.deps)).toBe(4);
    expect(locked.err).toEqual(["swarm os dispatch: refused (lockdown): the brain is in lockdown"]);
  });
  it("says how to sign in when there are no credentials", async () => {
    const t = stub(200, {});
    const code = await executeOsCommand(["rooms"], {}, { ...t.deps, credentials: () => { throw new NotSignedInError("https://brain.example.test", "expired"); } });
    expect(code).toBe(1);
    expect(t.err).toEqual(["The terminal sign-in to https://brain.example.test has expired. Run: swarm os login --url https://brain.example.test"]);
  });
});

describe("runLogin", () => {
  const TOKEN = "n".repeat(43);
  it("prints the approve link, polls until approved and saves the session 0600", async () => {
    const osHome = mkdtempSync(join(tmpdir(), "os-home-"));
    const pending = { state: "pending", expiresAt: "2026-10-25T09:10:00.000Z", intervalMs: 2000, approveUrl: `https://brain.example.test/#cli-login=${TOKEN}` };
    const replies: Array<[number, unknown]> = [[202, pending], [202, pending], [200, { state: "approved", token: "sess_new", expiresAt: "2026-10-26T09:00:00.000Z", humanId: "part-owner", deviceId: "dev-1" }]];
    const fetch = vi.fn(async () => { const [status, body] = replies.shift()!; return new Response(JSON.stringify(body), { status }); });
    const sleep = vi.fn(async () => {}); const out: string[] = [];
    expect(await runLogin({ url: "https://brain.example.test" }, { fetch: fetch as never, osHome, sleep, randomToken: () => TOKEN, out: (l) => out.push(l), err: () => {} })).toBe(0);
    expect(fetch.mock.calls[0][0]).toBe(`https://brain.example.test/api/auth/cli/${TOKEN}`);
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get("x-swarm-os-poll")).toBe(TOKEN);
    expect(out).toEqual([
      "Open this link on a device that is signed in to the dashboard, and approve the terminal sign-in:",
      `  https://brain.example.test/#cli-login=${TOKEN}`,
      "Waiting for approval (the link expires at 2026-10-25T09:10:00.000Z)...",
      "Signed in to https://brain.example.test until 2026-10-26T09:00:00.000Z.",
    ]);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(readSessionFile(osHome)).toEqual({ url: "https://brain.example.test", token: "sess_new", expiresAt: "2026-10-26T09:00:00.000Z", humanId: "part-owner", deviceId: "dev-1" });
    expect(statSync(join(osHome, "session")).mode & 0o777).toBe(0o600);
  });
  it("stops when the link expires", async () => {
    const err: string[] = [];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "expired", reason: "expired" } }), { status: 404 }));
    expect(await runLogin({ url: "https://brain.example.test" }, { fetch: fetch as never, osHome: mkdtempSync(join(tmpdir(), "os-home-")), sleep: async () => {}, randomToken: () => TOKEN, out: () => {}, err: (l) => err.push(l) })).toBe(1);
    expect(err).toEqual(["The sign-in link expired before it was approved. Run swarm os login again."]);
  });
});
```

```ts
// packages/cli/tests/os-dispatch.test.ts
// Runs `swarm os …` through main.ts the way tests/drainstop.test.ts runs drainstop: the tsx loader,
// a fetch stub module written to the temp directory, and a temp HOME and SWARM_OS_HOME.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { writeSessionFile } from "@mnmal-ai/swarm-os";

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli/main.ts");
const TSX_LOADER = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "loader.mjs")).href;

function swarmOs(home: string, ...args: string[]) {
  const log = join(home, "requests.log");
  const stub = join(home, "fetch-stub.mjs");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: init.method ?? "GET", url, body: init.body ?? null }) + "\\n");
  const body = url.endsWith("/api/rooms") ? [{ id: "room-sys", kind: "system", name: "system" }] : { ok: true, text: "Stopping inst-1 now." };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = spawnSync(process.execPath, ["--import", TSX_LOADER, "--import", pathToFileURL(stub).href, MAIN, "os", ...args], {
    cwd: home, env: { ...process.env, HOME: home, SWARM_OS_HOME: join(home, "os") }, encoding: "utf-8", timeout: 60_000,
  });
  const requests = existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, requests };
}

describe("swarm os (dispatched by main.ts)", () => {
  it("sends `swarm os stop run <instance>` to the brain as a command, never to the daemon's stop", () => {
    const home = mkdtempSync(join(tmpdir(), "os-dispatch-"));
    writeSessionFile(join(home, "os"), { url: "http://127.0.0.1:3200", token: "sess_abc", expiresAt: "2999-01-01T00:00:00.000Z", humanId: "part-owner", deviceId: "dev-1" });
    const run = swarmOs(home, "stop", "run", "inst-1", "--now");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Stopping inst-1 now.");
    const post = run.requests.find((r: { method: string }) => r.method === "POST");
    expect(post.url).toBe("http://127.0.0.1:3200/api/commands");
    expect(JSON.parse(post.body)).toEqual({ room: "room-sys", argv: ["stop", "run", "inst-1", "--now"] });
  }, 60_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/cli-args.test.ts tests/os-commands.test.ts tests/os-dispatch.test.ts`
Expected: FAIL. `../src/cli/args.js` and `../src/cli/os-commands.js` do not exist yet, and `os-dispatch` records no `POST /api/commands`, because plan 03's `stop` takes `stop run`.

- [ ] **Step 3: Implement `args.ts` (the move), `os-commands.ts`, and switch main.ts to `parseArgs` from `./args.js`**

- [ ] **Step 4: Add the guard to `os.ts`**

Add `import { routesToOsCommand, runOsCommand } from "./os-commands.js";` to `packages/cli/src/cli/os.ts`'s imports. Make the first statement of `runOs`'s body `if (routesToOsCommand(positional)) return runOsCommand(positional, flags);`. Nothing else in `os.ts` changes. The guard runs before plan 03's switch, rather than as its `default:` branch, because `stop` is both the daemon's `swarm os stop` and `swarm os stop run <instance>`. `routesToOsCommand` claims `stop` only with `run`, every other name in `OS_COMMANDS`, and `login`. Every other subcommand, including names neither side knows, still reaches plan 03's switch and its help.

- [ ] **Step 5: Run the tests, then the task gate**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/cli-args.test.ts tests/os-commands.test.ts tests/os-dispatch.test.ts`
Expected: PASS. Then run the task gate.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/args.ts packages/cli/src/cli/main.ts packages/cli/src/cli/os-commands.ts packages/cli/src/cli/os.ts packages/cli/tests/cli-args.test.ts packages/cli/tests/os-commands.test.ts packages/cli/tests/os-dispatch.test.ts
git commit -m "feat(cli): swarm os command subcommands and swarm os login"
```

---

### Task 9: The registration commands in the brain

Plans 04, 06 and 09 take `register` from plan 08 (contract addition 4). It writes the `Board` and `Registration` rows the dispatcher reads, with plan 04's defaults (`minCards` 3, `maxInstances` 1, `host` `local`). It resolves a Trello short link to the board's 24-character id. It parses into Registration field names, which plan 09's limit gate reads: `swarmPath`, `host`, `maxInstances`, `tokensPerHour`. Its siblings are `unregister`, `set ask_first` and `set limits`.

**Files:**
- Create: `packages/os/src/commands/registrations.ts`
- Modify: `packages/os/src/index.ts` (plan 08 block)
- Test: `packages/os/tests/commands/registrations.test.ts`

**Interfaces:**
- Consumes: `CommandSpec`, `CommandContext` and `CommandResult` (plan 05); `newId` (plan 02); `GITHUB_QUEUE_LABEL` (`"swarm:goal"`, plan 04, `packages/os/src/ingress/github-api.ts`); `OsConfig.boards.trello`, `OsConfig.owners` and `OsConfig.host_trust`; `Messaging.openRoom`; `newWorld` (Task 1).
- Produces:

```ts
export const RegisterArgs: z.ZodObject<…>;     // keys in positional order: board, project, swarmPath; then queueColumn?, repoRoot?, host ("local"), description (""),
                                              // minCards (3), maxInstances (1), tokensPerHour?, skipLabels? (comma list), owners? (comma list), askFirst (false)
export const UnregisterArgs: z.ZodObject<{ registration: z.ZodString }>;
export const SetAskFirstArgs: z.ZodObject<{ registration: z.ZodString; value: z.ZodEnum<["on", "off"]> }>;
export const SetLimitsArgs: z.ZodObject<{ registration: z.ZodString; maxInstances: …; tokensPerHour: …; minCards: … }>;   // each optional
export type BoardRef = { kind: "trello"; shortLink: string } | { kind: "github"; externalId: string; name: string };
export function parseBoardRef(input: string): BoardRef | null;    // trello.com/b/<shortLink>/…, a bare 8-character short link, owner/repo, github.com/owner/repo(.git)
export function projectIsLocalOnly(swarmPath: string): boolean;   // any top-level object block with local_only: true in <swarmPath>/config.json or any domains/*/config.json; invalid JSON throws
export function registrationCommands(deps?: { fetch?: typeof fetch }): CommandSpec<any>[];   // register, unregister, "set ask_first", "set limits"; Task 14 hands them to the brain
```

Number fields use `z.coerce.number().int()`: `minCards` and `maxInstances` at least 1, `tokensPerHour` positive. `swarmPath` must be absolute, and the schema transforms it to its `realpath`. A symlinked path therefore reaches plan 09's root check as the directory it really is, and a missing one is an issue. The schema assumes plan 05 builds the object from `rest`: positional words first, `--kebab-case <value>` pairs into camelCase keys, and a bare `--flag` as `true` (contract addition 5).

`register` refuses with `ok: false` and these texts, in this order:
1. No `domains/<project>/config.json` under the swarm path: `<swarmPath> has no domain "<project>" (domains/<project>/config.json).`
2. A `local_only` project while `host_trust` is not `owner`: `<project> is local_only and this brain's host_trust is "shared": a local_only project registers only on a host the owner controls.`
3. An unrecognised board: `"<board>" is neither a Trello board link nor a GitHub owner/repo.`
4. Trello without credentials: `The brain has no Trello credentials (os.json boards.trello).`
5. A Trello lookup other than 200: `No Trello board "<shortLink>" is visible to the brain's Trello credentials.`
6. A board already registered: `<board name> is already registered to <project> (<registration id>); /unregister <registration id> first.`

The Trello lookup is `GET https://api.trello.com/1/boards/<shortLink>?fields=id,name` with `headers: { authorization: 'OAuth oauth_consumer_key="<key>", oauth_token="<token>"' }` and `signal: AbortSignal.timeout(10_000)`. A GitHub board needs no network.

The command finds or creates the `Board` row by `(kind, externalId)`: `queueColumn` is the argument, else `To Do` (Trello) or `GITHUB_QUEUE_LABEL` (GitHub); `webhookSecret` and `lastPolledAt` are `null`. Then it writes the registration:
- `privacy`: `local_only` or `normal`
- `skipLabelsJson`: the comma list, or `[]`
- `ownersJson`: the comma list, or the ids in `config.owners`
- `askJson`: `null`
- `paused` and `draining`: `false`

It opens the board's room (`openRoom("board", board.id, board.name, owners, privacy)`) unless one exists. It replies `{ ok: true, text: "Registered <name> (<kind>) to <project> as <id>: queue \"<queueColumn>\", dispatching once <minCards> cards wait, at most <maxInstances> instance<s>.", data: { registrationId, boardId } }`, adding ` It is local_only.` when it is.

`unregister`, `set ask_first` and `set limits` find the registration by id, else by a unique `projectName`. They refuse with:
- `No registration "<x>".`
- `"<x>" names several registrations (<ids>); use an id.`

`unregister` refuses with `<id> has <n> live instance(s) (<ids>); stop them first with /stop run <instance>.` while any instance on it is `dispatching`, `running` or `unresponsive`. Otherwise it deletes only the registration and replies `Unregistered <board name> from <project> (<id>); its room and history stay.`

`set ask_first` replies `ask_first is <on|off> for <project> (<id>).`

`set limits` refuses with `Give at least one of --max-instances, --tokens-per-hour, --min-cards.` when no limit is given. Otherwise it patches what is given and replies `Limits for <project> (<id>): at most <maxInstances> instance<s>, <tokensPerHour or "no"> tokens per hour, dispatching once <minCards> cards wait.`

All four are `standing`, as the overview's table fixes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/os/tests/commands/registrations.test.ts
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RegisterArgs, parseBoardRef, projectIsLocalOnly, registrationCommands } from "../../src/commands/registrations.js";
import { newWorld } from "../helpers/world.js";

function project(dir: string, domain: object = { project: "project-a" }, swarm: object = {}) {
  const path = join(dir, "project-a", ".swarm");
  mkdirSync(join(path, "domains", "project-a"), { recursive: true });
  writeFileSync(join(path, "config.json"), JSON.stringify(swarm));
  writeFileSync(join(path, "domains", "project-a", "config.json"), JSON.stringify(domain));
  return realpathSync(path);
}
const trello = () => vi.fn(async () => new Response(JSON.stringify({ id: "5f00000000000000000000aa", name: "Board A" }), { status: 200 }));
const spec = (name: string, fetch = trello()) => registrationCommands({ fetch: fetch as never }).find((s) => s.name === name)!;
const TRELLO = { boards: { trello: { key: "k", token: "t" } } };

describe("register", () => {
  it("registers a Trello board by link with the defaults the dispatcher expects", async () => {
    const w = await newWorld(TRELLO);
    const swarmPath = project(w.dir);
    const fetch = trello();
    const r = await spec("register", fetch).run(w.ctx(w.system.id), RegisterArgs.parse({ board: "https://trello.com/b/abcd1234/board-a", project: "project-a", swarmPath }));
    expect(fetch).toHaveBeenCalledWith("https://api.trello.com/1/boards/abcd1234?fields=id,name", expect.objectContaining({ headers: { authorization: 'OAuth oauth_consumer_key="k", oauth_token="t"' } }));
    const [board] = await w.store.boards.find({});
    expect(board).toMatchObject({ kind: "trello", externalId: "5f00000000000000000000aa", name: "Board A", queueColumn: "To Do", webhookSecret: null, lastPolledAt: null });
    const [reg] = await w.store.registrations.find({});
    expect(reg).toMatchObject({ boardId: board.id, projectName: "project-a", swarmPath, repoRoot: null, host: "local", description: "", minCards: 3, maxInstances: 1, tokensPerHour: null, askFirst: false, privacy: "normal", askJson: null, skipLabelsJson: "[]", ownersJson: '["owner"]', paused: false, draining: false });
    expect((await w.store.rooms.find({ kind: "board", subjectId: board.id })).map((x) => x.name)).toEqual(["Board A"]);
    expect(r).toEqual({ ok: true, text: `Registered Board A (trello) to project-a as ${reg.id}: queue "To Do", dispatching once 3 cards wait, at most 1 instance.`, data: { registrationId: reg.id, boardId: board.id } });
  });
  it("registers a GitHub repository without calling anything", async () => {
    const w = await newWorld();
    const fetch = trello();
    await spec("register", fetch).run(w.ctx(w.system.id), RegisterArgs.parse({ board: "owner-a/repo-a", project: "project-a", swarmPath: project(w.dir), maxInstances: "2" }));
    expect(fetch).not.toHaveBeenCalled();
    expect((await w.store.boards.find({}))[0]).toMatchObject({ kind: "github", externalId: "owner-a/repo-a", name: "repo-a", queueColumn: "swarm:goal" });
    expect((await w.store.registrations.find({}))[0].maxInstances).toBe(2);
  });
  it("refuses a board that is already registered", async () => {
    const w = await newWorld(TRELLO);
    const args = RegisterArgs.parse({ board: "abcd1234", project: "project-a", swarmPath: project(w.dir) });
    await spec("register").run(w.ctx(w.system.id), args);
    const again = await spec("register").run(w.ctx(w.system.id), args);
    const [reg] = await w.store.registrations.find({});
    expect(again).toEqual({ ok: false, text: `Board A is already registered to project-a (${reg.id}); /unregister ${reg.id} first.` });
  });
  it("registers a local_only project only when the owner controls the host", async () => {
    const shared = await newWorld({ ...TRELLO, host_trust: "shared" });
    const refused = await spec("register").run(shared.ctx(shared.system.id), RegisterArgs.parse({ board: "abcd1234", project: "project-a", swarmPath: project(shared.dir, { secrets: { local_only: true } }) }));
    expect(refused).toEqual({ ok: false, text: 'project-a is local_only and this brain\'s host_trust is "shared": a local_only project registers only on a host the owner controls.' });
    const owned = await newWorld({ ...TRELLO, host_trust: "owner" });
    const ok = await spec("register").run(owned.ctx(owned.system.id), RegisterArgs.parse({ board: "abcd1234", project: "project-a", swarmPath: project(owned.dir, { substrate: { local_only: true } }) }));
    expect(ok.text.endsWith(" It is local_only.")).toBe(true);
    expect((await owned.store.registrations.find({}))[0].privacy).toBe("local_only");
    expect((await owned.store.rooms.find({ kind: "board" }))[0].privacy).toBe("local_only");
  });
  it("refuses a swarm path without the project's domain, and an unknown board", async () => {
    const w = await newWorld(TRELLO);
    const swarmPath = project(w.dir);
    expect(await spec("register").run(w.ctx(w.system.id), RegisterArgs.parse({ board: "abcd1234", project: "project-b", swarmPath })))
      .toEqual({ ok: false, text: `${swarmPath} has no domain "project-b" (domains/project-b/config.json).` });
    expect(await spec("register").run(w.ctx(w.system.id), RegisterArgs.parse({ board: "not a board", project: "project-a", swarmPath })))
      .toEqual({ ok: false, text: '"not a board" is neither a Trello board link nor a GitHub owner/repo.' });
  });
  it("parses Registration field names and resolves the swarm path through symlinks", async () => {
    const w = await newWorld();
    const real = project(w.dir);
    symlinkSync(real, join(w.dir, "link"));
    expect(RegisterArgs.parse({ board: "owner-a/repo-a", project: "project-a", swarmPath: join(w.dir, "link"), maxInstances: "2", tokensPerHour: "500000", askFirst: true }))
      .toMatchObject({ swarmPath: real, host: "local", minCards: 3, maxInstances: 2, tokensPerHour: 500_000, askFirst: true });
    expect(RegisterArgs.safeParse({ board: "owner-a/repo-a", project: "project-a", swarmPath: "relative/.swarm" }).success).toBe(false);
  });
});

describe("unregister and set", () => {
  async function registered() {
    const w = await newWorld();
    await spec("register").run(w.ctx(w.system.id), RegisterArgs.parse({ board: "owner-a/repo-a", project: "project-a", swarmPath: project(w.dir) }));
    const [reg] = await w.store.registrations.find({});
    return { w, reg };
  }
  it("refuses to unregister a project with live instances, and unregisters it after", async () => {
    const { w, reg } = await registered();
    await w.store.instances.put({ id: "inst-1", registrationId: reg.id, boardId: reg.boardId, cardId: "1", runId: null, state: "running", host: "local", launcherHandle: null, tokenHash: "", roomId: "room-x", startedAt: "2026-10-25T08:00:00.000Z", lastHeartbeatAt: null, endedAt: null, exitReason: null, dashboardUrl: null, tokens: 0 } as never);
    expect(await spec("unregister").run(w.ctx(w.system.id), { registration: "project-a" })).toEqual({ ok: false, text: `${reg.id} has 1 live instance(s) (inst-1); stop them first with /stop run <instance>.` });
    await w.store.instances.patch("inst-1", { state: "exited" } as never);
    expect(await spec("unregister").run(w.ctx(w.system.id), { registration: reg.id })).toEqual({ ok: true, text: `Unregistered repo-a from project-a (${reg.id}); its room and history stay.` });
    expect(await w.store.registrations.find({})).toEqual([]);
  });
  it("sets ask_first and limits", async () => {
    const { w, reg } = await registered();
    expect(await spec("set ask_first").run(w.ctx(w.system.id), { registration: "project-a", value: "on" })).toEqual({ ok: true, text: `ask_first is on for project-a (${reg.id}).` });
    expect((await spec("set limits").run(w.ctx(w.system.id), { registration: reg.id })).ok).toBe(false);
    expect(await spec("set limits").run(w.ctx(w.system.id), { registration: reg.id, maxInstances: 2 })).toEqual({ ok: true, text: `Limits for project-a (${reg.id}): at most 2 instances, no tokens per hour, dispatching once 3 cards wait.` });
    expect((await w.store.registrations.get(reg.id))).toMatchObject({ askFirst: true, maxInstances: 2 });
  });
});

describe("helpers", () => {
  it("recognises Trello and GitHub boards", () => {
    expect(parseBoardRef("https://trello.com/b/abcd1234/board-a")).toEqual({ kind: "trello", shortLink: "abcd1234" });
    expect(parseBoardRef("abcd1234")).toEqual({ kind: "trello", shortLink: "abcd1234" });
    expect(parseBoardRef("https://github.com/owner-a/repo-a.git")).toEqual({ kind: "github", externalId: "owner-a/repo-a", name: "repo-a" });
    expect(parseBoardRef("not a board")).toBeNull();
  });
  it("finds local_only in any block of any config, failing closed on broken JSON", async () => {
    const w = await newWorld();
    expect(projectIsLocalOnly(project(w.dir))).toBe(false);
    const other = await newWorld();
    expect(projectIsLocalOnly(project(other.dir, {}, { anything: { local_only: true } }))).toBe(true);
    const broken = await newWorld();
    const path = project(broken.dir);
    writeFileSync(join(path, "config.json"), "{ not json");
    expect(() => projectIsLocalOnly(path)).toThrow(/config\.json/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/commands/registrations.test.ts`
Expected: FAIL. `../../src/commands/registrations.js` does not exist yet.

- [ ] **Step 3: Implement `packages/os/src/commands/registrations.ts` to the rules above**

`register`'s own catch turns a thrown `projectIsLocalOnly` error into `ok: false` with that error's message. The rule is the one `readProjectSubstrateConfig` in `packages/cli/src/project-substrate.ts` applies; the comment names it, because `packages/os` cannot import the CLI. Export the module from the plan 08 block.

- [ ] **Step 4: Run the test, then the task gate**

Run: `cd packages/os && env -u ANTHROPIC_API_KEY npx vitest run tests/commands/registrations.test.ts`
Expected: PASS (10 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/commands/registrations.ts packages/os/src/index.ts packages/os/tests/commands/registrations.test.ts
git commit -m "feat(os): register, unregister, set ask_first and set limits"
```

---

### Task 10: Run CLI commands in-process with captured output

**Files:**
- Create: `packages/cli/src/cli/as-function/types.ts`, `packages/cli/src/cli/as-function/capture.ts`
- Create: `packages/cli/src/cli/sync.ts`, holding the body of main.ts's `case "sync":` branch, moved verbatim (`break` becomes `return`, `parsed` becomes `flags`, `substrateClient` becomes `client` and `projectSubstrate` becomes `project`)
- Modify: `packages/cli/src/cli/main.ts`, so the `case "sync":` branch is `const { runSync } = await import("./sync.js"); await runSync(parsed, substrateClient, projectSubstrate); break;`
- Test: `packages/cli/tests/as-function-capture.test.ts`, `packages/cli/tests/sync-command.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. `capture.ts` imports only `./types.js` and Node built-ins, so `db.ts`, `skill.ts` and `uninstall.ts`, which import the prompt seam in Tasks 12 and 13, never load the brain's package.
- Produces:

```ts
// types.ts
export interface CommandIo { write(line: string): void; prompt(question: string, options: readonly string[]): Promise<string> }
export interface CliRunResult { code: number; stdout: string; stderr: string }
export interface CliCommandDescriptor {
  name: string; summary: string; kind: "operating" | "standing";
  project: "required" | "optional" | "none";                 // how the brain picks the registration whose directories the command gets
  run(args: string[], io: CommandIo): Promise<CliRunResult>;
}
// capture.ts
export class ProcessExit extends Error { readonly code: number }
export interface CaptureOptions { label: string; io?: CommandIo; cwd?: string }
export function withCapturedProcess(fn: () => Promise<void>, opts: CaptureOptions): Promise<CliRunResult>;
export function activeCommandIo(): CommandIo | null;        // the run's io inside its async context, else null
export function consumePromptContext(): string;            // stdout captured since the last call, ANSI-stripped, trimmed, at most the last 2 000 characters
export function busyCaptureLabel(): string | null;         // the label of the run in progress
// sync.ts
export function runSync(flags: Record<string, string>, client: SubstrateClient | undefined, project?: ProjectSubstrateConfig): Promise<void>;
```

`withCapturedProcess` runs `fn` after every earlier capture has settled: one at a time per process, first in, first out. For the duration it installs, and in `finally` restores to the identical functions:
- `console.log`, `console.info`, `console.debug`, `console.warn` and `console.error`
- `process.stdout.write` and `process.stderr.write`
- `process.exit`

The installed versions find the run through an `AsyncLocalStorage`. Inside the run's async context, `log`, `info`, `debug` and `stdout.write` go to stdout, and `warn`, `error` and `stderr.write` go to stderr; console arguments are formatted with `util.format` plus `\n`. `process.exit(code)` records the first code and throws `ProcessExit`. Outside the context they call the originals, so the brain's own SIGTERM handler still exits. This sketch is the routing:

```ts
const runs = new AsyncLocalStorage<CaptureState>();
const routed = <A extends unknown[], R>(original: (...a: A) => R, sink: (s: CaptureState, ...a: A) => R) =>
  (...a: A): R => { const s = runs.getStore(); return s ? sink(s, ...a) : original(...a); };
```

It also snapshots `process.env` and `process.exitCode`, sets `process.env.CI = "true"` (so `@clack/prompts` draws no spinner animation), and calls `process.chdir(opts.cwd)` when given. All three are restored in `finally`, env exactly: keys added during the run are deleted and changed ones reset. The result code is the first `process.exit` code; else a `process.exitCode` set during the run; else 1 when `fn` threw anything but `ProcessExit`, with the error's message appended to stderr plus `\n`; else 0.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/as-function-capture.test.ts
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeCommandIo, busyCaptureLabel, consumePromptContext, withCapturedProcess } from "../src/cli/as-function/capture.js";

const io = { write: () => {}, prompt: async () => "" };

describe("withCapturedProcess", () => {
  it("captures console and both streams", async () => {
    const r = await withCapturedProcess(async () => {
      console.log("a %d", 1); console.info("i"); process.stdout.write("raw\n");
      console.error("e"); console.warn("w"); process.stderr.write("err\n");
    }, { label: "t" });
    expect(r).toEqual({ code: 0, stdout: "a 1\ni\nraw\n", stderr: "e\nw\nerr\n" });
  });
  it("turns process.exit into the run's code and stops the run there", async () => {
    const r = await withCapturedProcess(async () => { console.log("before"); process.exit(3); console.log("after"); }, { label: "t" });
    expect(r).toEqual({ code: 3, stdout: "before\n", stderr: "" });
  });
  it("reports a thrown error as exit 1 with its message", async () => {
    expect(await withCapturedProcess(async () => { throw new Error("boom"); }, { label: "t" })).toEqual({ code: 1, stdout: "", stderr: "boom\n" });
  });
  it("uses process.exitCode when the command sets it and returns", async () => {
    const before = process.exitCode;
    expect((await withCapturedProcess(async () => { process.exitCode = 4; }, { label: "t" })).code).toBe(4);
    expect(process.exitCode).toBe(before);
  });
  it("restores console, the streams and process.exit, even when fn throws", async () => {
    const before = [console.log, console.error, console.warn, console.info, process.stdout.write, process.stderr.write, process.exit];
    await withCapturedProcess(async () => { throw new Error("boom"); }, { label: "t" });
    const after = [console.log, console.error, console.warn, console.info, process.stdout.write, process.stderr.write, process.exit];
    after.forEach((f, i) => expect(f).toBe(before[i]));
  });
  it("passes output from outside the run's async context through to the real console", async () => {
    const seen: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const run = withCapturedProcess(async () => { console.log("inside"); await gate; }, { label: "t" });
      await new Promise((r) => setTimeout(r, 10));
      console.log("outside");
      release();
      expect((await run).stdout).toBe("inside\n");
      expect(seen).toEqual(["outside"]);
    } finally {
      console.log = real;
    }
  });
  it("runs one capture at a time, in order, and names the one in progress", async () => {
    const order: string[] = [];
    const a = withCapturedProcess(async () => { order.push(`a ${busyCaptureLabel()}`); await new Promise((r) => setTimeout(r, 20)); order.push("a end"); }, { label: "merge" });
    const b = withCapturedProcess(async () => { order.push("b start"); }, { label: "sync" });
    await Promise.all([a, b]);
    expect(order).toEqual(["a merge", "a end", "b start"]);
    expect(busyCaptureLabel()).toBeNull();
  });
  it("restores process.env exactly and sets CI for the run", async () => {
    process.env.SWARM_TEST_KEEP = "1";
    delete process.env.SWARM_TEST_ADDED;
    const snapshot = { ...process.env };
    const r = await withCapturedProcess(async () => {
      console.log(process.env.CI);
      process.env.SWARM_TEST_ADDED = "x";
      process.env.SWARM_TEST_KEEP = "2";
    }, { label: "t" });
    expect(r.stdout).toBe("true\n");
    expect({ ...process.env }).toEqual(snapshot);
    delete process.env.SWARM_TEST_KEEP;
  });
  it("runs in opts.cwd and comes back", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capture-")));
    const before = process.cwd();
    expect((await withCapturedProcess(async () => console.log(process.cwd()), { label: "t", cwd: dir })).stdout).toBe(`${dir}\n`);
    expect(process.cwd()).toBe(before);
  });
  it("exposes the run's io and what it printed for prompts", async () => {
    let seen: unknown; let context = ""; let again = "x";
    await withCapturedProcess(async () => {
      console.log("\x1b[1mThis will remove:\x1b[0m"); console.log("  .swarm/");
      seen = activeCommandIo(); context = consumePromptContext(); again = consumePromptContext();
    }, { label: "t", io });
    expect([seen, context, again, activeCommandIo()]).toEqual([io, "This will remove:\n  .swarm/", "", null]);
  });
});
```

```ts
// packages/cli/tests/sync-command.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
vi.mock("../src/cli/seed.js", () => ({ seedSwarmContent: vi.fn(async () => ({ content: 1, routes: 0, configs: 0 })), seedSwarmContentForce: vi.fn() }));
import { seedSwarmContent } from "../src/cli/seed.js";
import { withCapturedProcess } from "../src/cli/as-function/capture.js";
import { runSync } from "../src/cli/sync.js";

describe("runSync", () => {
  it("syncs new files for the project and says what it added", async () => {
    const client = { close: vi.fn() } as unknown as SubstrateClient;
    const r = await withCapturedProcess(() => runSync({ "swarm-path": "/path/to/project-a/.swarm", project: "project-a" }, client), { label: "sync" });
    expect(r).toEqual({ code: 0, stdout: "[swarm] Syncing .swarm/ files to Substrate (new files only)...\n[swarm] Synced 1 content, 0 routes, 0 configs.\n", stderr: "" });
    expect(vi.mocked(seedSwarmContent)).toHaveBeenCalledWith(client, "/path/to/project-a/.swarm", "project-a");
  });
  it("refuses without a database, as before", async () => {
    expect(await withCapturedProcess(() => runSync({}, undefined), { label: "sync" })).toEqual({ code: 1, stdout: "", stderr: "Cannot sync without a database. Run `swarm db setup` first.\n" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-capture.test.ts tests/sync-command.test.ts`
Expected: FAIL. `../src/cli/as-function/capture.js` and `../src/cli/sync.js` do not exist yet.

- [ ] **Step 3: Implement `types.ts` and `capture.ts`, move the `sync` body into `sync.ts`, and point main.ts at it**

- [ ] **Step 4: Run the tests, then the task gate**

Run: `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-capture.test.ts tests/sync-command.test.ts`
Expected: PASS (10 + 2 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/as-function/types.ts packages/cli/src/cli/as-function/capture.ts packages/cli/src/cli/sync.ts packages/cli/src/cli/main.ts packages/cli/tests/as-function-capture.test.ts packages/cli/tests/sync-command.test.ts
git commit -m "feat(cli): run CLI commands in-process with captured output and exit"
```

---

### Task 11: CLI-backed commands as room commands

`room.ts` is the brain-facing half of a CLI-backed command. It picks the registration whose directories the command gets, refuses the flags a room may not pass, asks the room when the command prompts, and turns the captured output into the room's reply. Each descriptor becomes a `CommandSpec`, whose `args` schema comes from `packages/os`, so that `packages/cli` needs no zod of its own.

**Files:**
- Create: `packages/os/src/commands/argv-args.ts`
- Create: `packages/cli/src/cli/as-function/room.ts`
- Modify: `packages/os/src/index.ts`. In the plan 08 block, add `export * from "./commands/argv-args.js";`. Also add `export { redactSecrets } from "./messaging/redact.js";` unless plan 05's block already exports it.
- Test: `packages/cli/tests/as-function-room.test.ts`

**Interfaces:**
- Consumes: the types `CommandSpec`, `CommandContext` and `CommandResult`, and the values `redactSecrets` and `stripAnsi` (Task 4), all from `@mnmal-ai/swarm-os`. `CommandIo`, `CliRunResult` and `CliCommandDescriptor` from Task 10. `ctx.store`'s `registrations`, `rooms`, `instances` and `messages` repos, and `ctx.messaging.post`. Plan 05's executor gives a trailing array key every remaining word, `--flags` included, as plan 06's `argvFor` encodes it (contract addition 5).
- Produces:

```ts
// packages/os/src/commands/argv-args.ts
export const ArgvArgs: z.ZodObject<{ argv: z.ZodDefault<z.ZodArray<z.ZodString>> }>;   // z.object({ argv: z.array(z.string()).default([]) })
// packages/cli/src/cli/as-function/room.ts
export const CLI_PROMPT_TIMEOUT_MS = 300_000;
export const CLI_PROMPT_POLL_MS = 1_000;
export const CLI_OUTPUT_MAX_CHARS = 16_000;
export const ROOM_REFUSED_FLAGS: readonly string[];      // --swarm-path, --repo-path, --dir, --yes, -y
export function cliBackedSpec(d: CliCommandDescriptor): CommandSpec<{ argv: string[] }>;   // name, summary and kind from d; args ArgvArgs
export function roomCommandIo(ctx: CommandContext, timeoutMs?: number): CommandIo;
export function formatCliOutput(name: string, result: CliRunResult): CommandResult;
```

`cliBackedSpec(d).run(ctx, { argv })`:
1. **Refuse room flags.** The first of `ROOM_REFUSED_FLAGS` found in `argv` (also as `--flag=value`) gives `ok: false`, `/<name>: <flag> is not accepted from a room; <why>.` For the three directory flags, `<why>` is `the brain sets the project's directories from its registration`. For `--yes` and `-y`, it is `the room always asks before a command changes anything`.
2. **Find the registration** (skipped when `project` is `none`):
   - A `--project <x>` that matches a registration's `projectName` names it.
   - Otherwise the room's subject does. For a `board` room, that is the registration with that `boardId`. For an `instance` room, it is that instance's `registrationId`.
   - An unregistered `--project` on a `required` command gives `No registered project named "<x>". Registered: <names or none>.`
   - No registration on a `required` command gives `Name the project: /<name> --project <name> (registered: <names or none>).`
3. **Inject the directories.** With a registration, the descriptor gets the user's argv, then `--swarm-path <swarmPath>`, then `--repo-path <repoRoot>` when it is set, then `--project <projectName>` when the user gave none.
4. **Run.** `formatCliOutput(d.name, await d.run(args, roomCommandIo(ctx)))`.

`roomCommandIo(ctx, timeoutMs)` posts from `{ id: "system", kind: "system" }` with `provenance { source: "system" }`, in `ctx.roomId`. Posts go out in call order, through one promise chain.
- **`write(line)`** posts a `system` message.
- **`prompt(question, options)`** posts a `question` message with body `<question>\n(reply with one of: <options joined by ", ">)` and `data { prompt: "cli", options }`. It is no `Question` row, so plan 05's expiry and the chief of staff's precedent can never answer it. Then, every `CLI_PROMPT_POLL_MS`, it reads the room's newest 50 messages. The answer is the trimmed body of the first message after the question that comes from a human (`fromKind === "human"`) and has `replyTo` either null or the question's id. After `timeoutMs` it posts `No answer within 5 minutes; treated as no.` and resolves `""`.

`formatCliOutput`:
1. Strip ANSI from stdout and from stderr, trim the end of each, and join the non-empty ones with `\n`.
2. With nothing left, the text is `/<name> finished.`
3. A non-zero code appends `\n(exit <code>)`.
4. Above `CLI_OUTPUT_MAX_CHARS`, keep the first 16 000 characters and add `\n… <n> more characters not shown. Run swarm <name> on the host for the full output.`
5. Pass the result through `redactSecrets`.
6. Return `{ ok: code === 0, text, data: { exitCode: code } }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/as-function-room.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "@mnmal-ai/swarm-os";
import { CLI_PROMPT_POLL_MS, CLI_PROMPT_TIMEOUT_MS, cliBackedSpec, formatCliOutput, roomCommandIo } from "../src/cli/as-function/room.js";
import type { CliCommandDescriptor } from "../src/cli/as-function/types.js";

const REG = { id: "reg-a", boardId: "board-a", projectName: "project-a", swarmPath: "/path/to/project-a/.swarm", repoRoot: "/path/to/project-a" };
const ROOMS = [{ id: "room-sys", kind: "system", subjectId: null }, { id: "room-ba", kind: "board", subjectId: "board-a" }];
type Row = Record<string, unknown>;
/** Just the repos and the post that room.ts touches; a message's seq grows by one per post. */
function fakeContext(roomId: string) {
  const messages: Row[] = [];
  const where = (rows: Row[], w: Row) => rows.filter((r) => Object.entries(w).every(([k, v]) => r[k] === v));
  const store = {
    registrations: { find: async (w: Row) => where([REG], w), get: async (id: string) => (id === REG.id ? REG : null) },
    rooms: { get: async (id: string) => ROOMS.find((r) => r.id === id) ?? null },
    instances: { get: async () => null },
    messages: { find: async (w: Row, o: { desc?: boolean; limit?: number } = {}) => { const rows = where(messages, w).sort((a, b) => (a.seq as number) - (b.seq as number)); return (o.desc ? rows.reverse() : rows).slice(0, o.limit ?? rows.length); } },
  };
  const post = async (m: { roomId: string; from: { id: string; kind: string }; kind: string; body: string; data?: unknown; replyTo?: string }) => {
    const row = { id: `msg-${messages.length + 1}`, seq: messages.length + 1, roomId: m.roomId, fromKind: m.from.kind, kind: m.kind, body: m.body, replyTo: m.replyTo ?? null, dataJson: m.data === undefined ? null : JSON.stringify(m.data) };
    messages.push(row);
    return row;
  };
  const ctx = { actor: { kind: "human", humanId: "part-owner" }, roomId, store, messaging: { post }, provenance: { source: "owner" } } as unknown as CommandContext;
  return { ctx, messages, say: (kind: "human" | "cos", body: string, replyTo?: string) => post({ roomId, from: { id: `part-${kind}`, kind }, kind: "text", body, replyTo }) };
}
function recorder(over: Partial<CliCommandDescriptor> = {}) {
  const calls: string[][] = [];
  const d: CliCommandDescriptor = { name: "sync", summary: "Sync .swarm/ files to the Substrate store", kind: "operating", project: "required", run: async (args) => { calls.push(args); return { code: 0, stdout: "\x1b[32mSynced\x1b[0m 1 content\n", stderr: "" }; }, ...over };
  return { calls, d };
}
const DIRS = ["--swarm-path", "/path/to/project-a/.swarm", "--repo-path", "/path/to/project-a"];

describe("cliBackedSpec", () => {
  it("gives the command the directories of the project --project names", async () => {
    const { d, calls } = recorder();
    expect(await cliBackedSpec(d).run(fakeContext("room-sys").ctx, { argv: ["--project", "project-a"] })).toEqual({ ok: true, text: "Synced 1 content", data: { exitCode: 0 } });
    expect(calls).toEqual([["--project", "project-a", ...DIRS]]);
  });
  it("takes the project from a board room when none is named", async () => {
    const { d, calls } = recorder();
    await cliBackedSpec(d).run(fakeContext("room-ba").ctx, { argv: [] });
    expect(calls).toEqual([[...DIRS, "--project", "project-a"]]);
  });
  it("asks for the project when the room has none, and refuses one that is not registered", async () => {
    const { d, calls } = recorder();
    const spec = cliBackedSpec(d);
    expect(await spec.run(fakeContext("room-sys").ctx, { argv: [] })).toEqual({ ok: false, text: "Name the project: /sync --project <name> (registered: project-a)." });
    expect(await spec.run(fakeContext("room-sys").ctx, { argv: ["--project", "project-z"] })).toEqual({ ok: false, text: 'No registered project named "project-z". Registered: project-a.' });
    expect(calls).toEqual([]);
  });
  it("refuses directories and --yes from a room", async () => {
    const spec = cliBackedSpec(recorder().d);
    const ctx = fakeContext("room-ba").ctx;
    expect(await spec.run(ctx, { argv: ["--swarm-path", "/path/to/elsewhere"] })).toEqual({ ok: false, text: "/sync: --swarm-path is not accepted from a room; the brain sets the project's directories from its registration." });
    expect(await spec.run(ctx, { argv: ["--dir=/path/to/elsewhere"] })).toMatchObject({ ok: false });
    expect(await spec.run(ctx, { argv: ["-y"] })).toEqual({ ok: false, text: "/sync: -y is not accepted from a room; the room always asks before a command changes anything." });
  });
  it("runs machine-wide commands as given when no project applies", async () => {
    const doctor = recorder({ name: "doctor", project: "optional" });
    await cliBackedSpec(doctor.d).run(fakeContext("room-sys").ctx, { argv: [] });
    expect(doctor.calls).toEqual([[]]);
    const upgrade = recorder({ name: "upgrade", kind: "standing", project: "none" });
    await cliBackedSpec(upgrade.d).run(fakeContext("room-ba").ctx, { argv: ["--version", "v1.0.0-alpha.9"] });
    expect(upgrade.calls).toEqual([["--version", "v1.0.0-alpha.9"]]);
  });
  it("declares its arguments with the brain's ArgvArgs", () => {
    expect(cliBackedSpec(recorder().d).args.parse({})).toEqual({ argv: [] });
  });
});

describe("roomCommandIo", () => {
  afterEach(() => vi.useRealTimers());
  it("asks in the room and takes the next human message as the answer", async () => {
    vi.useFakeTimers();
    const room = fakeContext("room-ba");
    const io = roomCommandIo(room.ctx);
    io.write("Waiting for /merge to finish before /db reset runs.");
    const answer = io.prompt("Merge 2 pull requests that swarm left open for project-a?", ["yes", "no"]);
    await vi.advanceTimersByTimeAsync(0);
    const q = room.messages.find((m) => m.kind === "question")!;
    expect(q.body).toBe("Merge 2 pull requests that swarm left open for project-a?\n(reply with one of: yes, no)");
    expect(JSON.parse(q.dataJson as string)).toEqual({ prompt: "cli", options: ["yes", "no"] });
    await room.say("cos", "yes");
    await room.say("human", "unrelated", "msg-other");
    await room.say("human", "  yes ");
    await vi.advanceTimersByTimeAsync(CLI_PROMPT_POLL_MS);
    expect(await answer).toBe("yes");
    expect(room.messages[0].body).toBe("Waiting for /merge to finish before /db reset runs.");
  });
  it("treats no answer within five minutes as no", async () => {
    vi.useFakeTimers();
    const room = fakeContext("room-ba");
    const answer = roomCommandIo(room.ctx).prompt("Reset the cold store?", ["yes", "no"]);
    await vi.advanceTimersByTimeAsync(CLI_PROMPT_TIMEOUT_MS);
    expect(await answer).toBe("");
    expect(room.messages.map((m) => m.body)).toContain("No answer within 5 minutes; treated as no.");
  });
});

describe("formatCliOutput", () => {
  it("strips colour, appends a failing exit code and caps long output", () => {
    expect(formatCliOutput("doctor", { code: 1, stdout: "\x1b[1mSwarm Doctor\x1b[0m\n", stderr: "fix: swarm substrate start\n" })).toEqual({ ok: false, text: "Swarm Doctor\nfix: swarm substrate start\n(exit 1)", data: { exitCode: 1 } });
    const long = formatCliOutput("logs", { code: 0, stdout: "x".repeat(20_000), stderr: "" }).text;
    expect(long.startsWith(`${"x".repeat(16_000)}\n… 4000 more characters not shown.`)).toBe(true);
    expect(long.endsWith("Run swarm logs on the host for the full output.")).toBe(true);
  });
  it("never lets a secret into the room", () => {
    expect(formatCliOutput("logs", { code: 0, stdout: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n", stderr: "" }).text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });
  it("says a silent command finished", () => {
    expect(formatCliOutput("sync", { code: 0, stdout: "", stderr: "" }).text).toBe("/sync finished.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-room.test.ts`
Expected: FAIL. `../src/cli/as-function/room.js` does not exist yet.

- [ ] **Step 3: Implement `argv-args.ts` and `room.ts` to the rules above, and add the export lines**

- [ ] **Step 4: Run the test, then the task gate**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-room.test.ts`
Expected: PASS (11 tests). Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/os/src/commands/argv-args.ts packages/os/src/index.ts packages/cli/src/cli/as-function/room.ts packages/cli/tests/as-function-room.test.ts
git commit -m "feat(cli): CLI-backed commands as room commands that ask in the room"
```

---

### Task 12: Operating CLI commands from a room

**What these commands normally rely on.** main.ts's project-Substrate preamble (today lines 162-283) does three things before a command runs, and the wrapped commands depend on all three. (a) `prepareProjectSubstrate(swarmDir, resolveProjectName(swarmDir, --project))`, from `packages/cli/src/project-substrate.ts`, applies the project's dedicated-stack variables to `process.env` and enforces `local_only`. An error prints `[swarm] <message>` and exits 1. It is skipped for `init`, `uninstall` and `upgrade`. (b) For commands outside `SUBSTRATE_SKIP_COMMANDS` (`db`, `doctor`, `drainstop`, …, and `substrate stop|status`), `resolveDbConfig({ swarmDir })`, then `ensureProjectSubstrate({ quiet, dockerComposeDir, isolated })` from `packages/cli/src/substrate/ready.ts`, which `cli/substrate.ts` re-uses, yields the `SubstrateClient`. The auto-sync then runs `seedSwarmContent` and `reconcileMcpServers`. (c) `logs`, `skill` and `mcp` with no client print `This command requires a database. Run \`swarm db setup\` to configure one.` and exit 1. None of the wrapped commands uses the `SwarmQueryClient` (`FileQueryAdapter`), which only `run` takes.

`prepareProjectEnv(flags, needs)` performs (a), and with `needs: "client"` also (b), in that order. The project is the one the args name, with `--swarm-path` and `--project` set by the brain from the registration (Task 11). It runs inside `withCapturedProcess`, so the env that (a) applies is undone when the command ends. main.ts itself is not changed. Each descriptor declares the part of the preamble main.ts gives it today.

**Files:**
- Create: `packages/cli/src/cli/as-function/prompt.ts`, `packages/cli/src/cli/as-function/project-env.ts`, `packages/cli/src/cli/as-function/define.ts`, `packages/cli/src/cli/as-function/operating.ts`
- Modify: `packages/cli/src/cli/skill.ts`, so `resolveTier`'s interactive branch asks `choosePrompt` before its menu and readline prompt and keeps them when `choosePrompt` returns `null`
- Test: `packages/cli/tests/as-function-project-env.test.ts`, `packages/cli/tests/as-function-operating.test.ts`

**Interfaces:**
- Consumes: `withCapturedProcess`, `activeCommandIo`, `consumePromptContext` and `busyCaptureLabel`, plus `CommandIo`, `CliRunResult` and `CliCommandDescriptor` (Task 10); `parseArgs` (Task 8); `runSync` (Task 10). The existing entries: `runLogs(flags, positional)`, `runSkill(positional, flags, client)`, `runMcpManage(positional, flags, client)`, `runSubstrate(positional, flags, project)` and `runDoctor(flags)`. Also `prepareProjectSubstrate`, `ensureProjectSubstrate`, `resolveDbConfig`, `seedSwarmContent`, `reconcileMcpServers` and `resolveProjectName`.
- Produces:

```ts
// prompt.ts
export function confirmPrompt(message: string): Promise<boolean>;   // with an active io: io.prompt(context + "\n" + message, ["yes", "no"]) matches /^(y|yes)$/i; else clack confirm, initialValue false, cancel → false
export function choosePrompt(question: string, options: readonly string[]): Promise<string | null>;   // the active io's trimmed answer, with context; null when none is active
// project-env.ts
export type PreambleNeeds = "none" | "project" | "client";
export interface ProjectEnv { swarmPath: string; project: string; projectSubstrate?: ProjectSubstrateConfig; client: SubstrateClient | null }
export interface ProjectEnvDeps { prepareProjectSubstrate: typeof prepareProjectSubstrate; resolveDbConfig: typeof resolveDbConfig; ensureProjectSubstrate: typeof ensureProjectSubstrate; seedSwarmContent: typeof seedSwarmContent; reconcileMcpServers: typeof reconcileMcpServers }
export const REQUIRES_DATABASE = "This command requires a database. Run `swarm db setup` to configure one.";
export function prepareProjectEnv(flags: Record<string, string>, needs: PreambleNeeds, deps?: Partial<ProjectEnvDeps>): Promise<ProjectEnv>;
// define.ts
export interface ParsedArgs { positional: string[]; flags: Record<string, string> }
export const CANCELLED = "Cancelled; nothing was changed.";
export interface CliCommandDef {
  name: string; summary: string; kind: "operating" | "standing"; project: "required" | "optional" | "none"; needs: PreambleNeeds;
  refuse?(args: ParsedArgs, projectDir: string | null): string | null;      // checked before anything runs
  confirm?(args: ParsedArgs, env: ProjectEnv): Promise<string | null>;      // the room question; null when the command's own prompt confirms
  run(args: ParsedArgs, env: ProjectEnv): Promise<void>;
}
export function defineCliCommand(def: CliCommandDef, deps?: Partial<ProjectEnvDeps>): CliCommandDescriptor;
// operating.ts
export function operatingDescriptors(deps?: Partial<ProjectEnvDeps>): CliCommandDescriptor[];   // sync, logs, skill, mcp, substrate status, doctor
```

`prepareProjectEnv`:
- `swarmPath` is `flags["swarm-path"] ?? ".swarm"`, and `project` is `resolveProjectName(swarmPath, flags.project)`.
- `none` returns at once, with `client: null`.
- Otherwise it runs (a). `ProjectSubstrateConfigError` and `LocalOnlyViolation` are written as `console.error("[swarm] " + message)`, then `process.exit(1)`.
- `client` continues: `dbConfig = resolveDbConfig({ swarmDir })`. With one, it calls `ensureProjectSubstrate({ quiet: true, dockerComposeDir (docker source only), isolated (when the project has one) })`, then the auto-sync. An auto-sync error is written as `console.warn("[swarm] Auto-sync skipped: …")`.

`defineCliCommand(def).run(args, io)`:
1. `parsed = parseArgs(args)`. `projectDir` is `dirname(resolve(--swarm-path))`, or `null`.
2. A `refuse` reason returns `{ code: 1, stdout: "", stderr: reason + "\n" }` and nothing runs.
3. When `busyCaptureLabel()` is set, call `io.write("Waiting for /<label> to finish before /<name> runs.")`.
4. `withCapturedProcess` runs with `{ label: name, io, cwd: projectDir ?? a fresh mkdtemp directory, removed afterwards }`, and inside it:
   1. `env = await prepareProjectEnv(parsed.flags, needs, deps)`
   2. `q = await def.confirm?.(parsed, env)`
   3. When `q` is a string and `io.prompt(q, ["yes", "no"])` does not match `/^(y|yes)$/i`, print `CANCELLED` and return
   4. `await def.run(parsed, env)`
   5. In `finally`, `env.client?.close()`; a close error goes to captured stderr
5. Every def imports its command module inside `run`, with `await import(…)` as main.ts does, so loading the descriptors costs nothing.

The six operating defs. `project` is how the brain picks the registration; `needs` is the preamble each one gets, as main.ts gives it today:

| name | project | needs | refuse | run |
|---|---|---|---|---|
| `sync` | required | client | `--force`: `/sync --force wipes the cold store before it re-seeds. Run /db reset (it needs a step-up confirmation), then /sync.` | `runSync(flags, env.client ?? undefined, env.projectSubstrate)` |
| `logs` | optional | client | none | no client: `console.error(REQUIRES_DATABASE); process.exit(1)`; else `runLogs({ ...flags, dir: flags["swarm-path"] ?? ".swarm" }, positional)` |
| `skill` | required | client | `add <source>` unless the source starts with `https://` or resolves inside `projectDir`: `/skill add takes an https:// URL or a file inside <projectDir>.` | no client: as `logs`; else `runSkill(positional, flags, env.client)` |
| `mcp` | required | client | none | no client: as `logs`; else `runMcpManage(positional, { ...flags, dir: flags["swarm-path"] }, env.client)` |
| `substrate status` | optional | project | none | `runSubstrate(["status"], flags, env.projectSubstrate)` |
| `doctor` | optional | project | none | `runDoctor(flags)` |

The summaries are main.ts's help lines for each command.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/as-function-project-env.test.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { withCapturedProcess } from "../src/cli/as-function/capture.js";
import { prepareProjectEnv, type ProjectEnv } from "../src/cli/as-function/project-env.js";
import { dedicatedProject, isolateSubstrateProject, swarmDir } from "./substrate-project-fixture.js";

isolateSubstrateProject();
const flags = () => ({ "swarm-path": swarmDir(), project: "project-a" });

describe("prepareProjectEnv", () => {
  it("applies a dedicated project's stack for the run only", async () => {
    dedicatedProject();
    const r = await withCapturedProcess(async () => { await prepareProjectEnv(flags(), "project"); console.log(process.env.SWARM_SUBSTRATE_PORT); }, { label: "doctor" });
    expect(r.stdout).toBe("45002\n");
    expect(process.env.SWARM_SUBSTRATE_PORT).toBeUndefined();
  });
  it("brings the project's store up as main.ts does: prepare, db config, ensure, then auto-sync", async () => {
    dedicatedProject();
    const calls: string[] = [];
    const client = { close: vi.fn() } as unknown as SubstrateClient;
    const deps = {
      resolveDbConfig: vi.fn(async () => { calls.push("db"); return { source: "docker" as const, postgresUrl: "postgresql://swarm:swarm@127.0.0.1:45001/swarm", dockerComposeDir: "/path/to/infra" }; }),
      ensureProjectSubstrate: vi.fn(async () => { calls.push("ensure"); return client; }),
      seedSwarmContent: vi.fn(async () => { calls.push("seed"); return { content: 0, routes: 0, configs: 0 }; }),
      reconcileMcpServers: vi.fn(async () => { calls.push("mcp"); return []; }),
    };
    let env!: ProjectEnv;
    await withCapturedProcess(async () => { env = await prepareProjectEnv(flags(), "client", deps as never); }, { label: "skill" });
    expect(calls).toEqual(["db", "ensure", "seed", "mcp"]);
    expect(deps.ensureProjectSubstrate).toHaveBeenCalledWith({ quiet: true, dockerComposeDir: "/path/to/infra", isolated: { composeProject: "swarm-dedicated-45002" } });
    expect(deps.seedSwarmContent).toHaveBeenCalledWith(client, swarmDir(), "project-a");
    expect(env.client).toBe(client);
  });
  it("ends the run with exit 1 on a project config error, as main.ts does", async () => {
    writeFileSync(join(swarmDir(), "domains", "project-a", "config.json"), "{ not json");
    const r = await withCapturedProcess(async () => { await prepareProjectEnv(flags(), "project"); }, { label: "doctor" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[swarm\] .*config\.json is not valid JSON/);
  });
  it("does nothing for commands main.ts runs without the preamble", async () => {
    dedicatedProject();
    let env!: ProjectEnv;
    await withCapturedProcess(async () => { env = await prepareProjectEnv(flags(), "none"); }, { label: "upgrade" });
    expect(env).toEqual({ swarmPath: swarmDir(), project: "project-a", client: null });
  });
});
```

```ts
// packages/cli/tests/as-function-operating.test.ts
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
vi.mock("../src/cli/doctor.js", () => ({ runDoctor: vi.fn() }));
vi.mock("../src/cli/sync.js", () => ({ runSync: vi.fn() }));
vi.mock("../src/cli/skill.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/skill.js")>()), runSkill: vi.fn() }));
import { runDoctor } from "../src/cli/doctor.js";
import { runSync } from "../src/cli/sync.js";
import * as skill from "../src/cli/skill.js";
import { operatingDescriptors } from "../src/cli/as-function/operating.js";
import { isolateSubstrateProject, swarmDir } from "./substrate-project-fixture.js";

isolateSubstrateProject();
const roomIo = (answers: string[] = []) => { const asked: string[] = []; return { asked, io: { write: vi.fn(), prompt: vi.fn(async (q: string) => { asked.push(q); return answers.shift() ?? ""; }) } }; };
const mockClient = () => ({ mutate: vi.fn(async () => ({ id: 1 })), query: vi.fn(async () => []), close: vi.fn() }) as unknown as SubstrateClient;
const storeUp = (client = mockClient()) => ({
  resolveDbConfig: vi.fn(async () => ({ source: "env" as const, postgresUrl: "postgresql://swarm:swarm@127.0.0.1:45001/swarm" })),
  ensureProjectSubstrate: vi.fn(async () => client), seedSwarmContent: vi.fn(async () => ({ content: 0, routes: 0, configs: 0 })), reconcileMcpServers: vi.fn(async () => []),
});
const byName = (deps = {}) => new Map(operatingDescriptors(deps as never).map((d) => [d.name, d]));
const target = () => ["--swarm-path", swarmDir(), "--project", "project-a"];

describe("operating descriptors", () => {
  it("declares the six operating commands as the registry expects", () => {
    expect(operatingDescriptors().map((d) => [d.name, d.kind, d.project])).toEqual([
      ["sync", "operating", "required"], ["logs", "operating", "optional"], ["skill", "operating", "required"],
      ["mcp", "operating", "required"], ["substrate status", "operating", "optional"], ["doctor", "operating", "optional"],
    ]);
  });
  it("runs doctor in the project's directory and returns its output and exit code", async () => {
    vi.mocked(runDoctor).mockImplementation(async () => { console.log(`cwd ${process.cwd()}`); process.exit(1); });
    expect(await byName().get("doctor")!.run(target(), roomIo().io)).toEqual({ code: 1, stdout: `cwd ${realpathSync(dirname(swarmDir()))}\n`, stderr: "" });
  });
  it("runs a command with no project in an empty scratch directory, never the brain's own", async () => {
    const brainCwd = process.cwd(); let seen = "";
    vi.mocked(runDoctor).mockImplementation(async () => { seen = process.cwd(); console.log(readdirSync(".").length); });
    expect((await byName().get("doctor")!.run([], roomIo().io)).stdout).toBe("0\n");
    expect(seen).not.toBe(brainCwd);
    expect(existsSync(seen)).toBe(false);
  });
  it("refuses /sync --force and points at /db reset", async () => {
    expect(await byName().get("sync")!.run(["--force", ...target()], roomIo().io)).toEqual({ code: 1, stdout: "", stderr: "/sync --force wipes the cold store before it re-seeds. Run /db reset (it needs a step-up confirmation), then /sync.\n" });
    expect(runSync).not.toHaveBeenCalled();
  });
  it("lets /skill add read only https URLs and files inside the project", async () => {
    const d = byName(storeUp()).get("skill")!;
    const project = dirname(swarmDir());
    expect(await d.run(["add", "/etc/hosts", ...target()], roomIo().io)).toEqual({ code: 1, stdout: "", stderr: `/skill add takes an https:// URL or a file inside ${project}.\n` });
    expect((await d.run(["add", "../../escape.md", ...target()], roomIo().io)).code).toBe(1);
    expect((await d.run(["add", "http://example.com/skill.md", ...target()], roomIo().io)).code).toBe(1);
    writeFileSync(join(project, "local-skill.md"), "# skill\n");
    await d.run(["add", "https://example.com/skill.md", ...target()], roomIo().io);
    await d.run(["add", "local-skill.md", ...target()], roomIo().io);
    expect(vi.mocked(skill.runSkill).mock.calls.map((c) => c[0])).toEqual([["add", "https://example.com/skill.md"], ["add", "local-skill.md"]]);
  });
  it("says a database is needed when the project has none", async () => {
    expect(await byName({ resolveDbConfig: vi.fn(async () => null) }).get("skill")!.run(["list", ...target()], roomIo().io)).toEqual({ code: 1, stdout: "", stderr: "This command requires a database. Run `swarm db setup` to configure one.\n" });
  });
  it("asks for a skill's tier in the room when --tier is not given", async () => {
    const real = await vi.importActual<typeof import("../src/cli/skill.js")>("../src/cli/skill.js");
    vi.mocked(skill.runSkill).mockImplementation(real.runSkill);
    const client = mockClient();
    writeFileSync(join(dirname(swarmDir()), "local-skill.md"), "# local skill\n");
    const { io, asked } = roomIo(["vetted"]);
    expect((await byName(storeUp(client)).get("skill")!.run(["add", "local-skill.md", ...target()], io)).code).toBe(0);
    expect(asked[0]).toContain("Which tier for this skill: core, vetted or community?");
    expect(vi.mocked(client.mutate).mock.calls[0][1]).toMatchObject({ tier: "skills_vetted" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-project-env.test.ts tests/as-function-operating.test.ts`
Expected: FAIL. `../src/cli/as-function/project-env.js` and `../src/cli/as-function/operating.js` do not exist yet.

- [ ] **Step 3: Implement `prompt.ts`, `project-env.ts`, `define.ts`, `operating.ts`, and the seam in `skill.ts`**

In `resolveTier`'s interactive branch, first run `const chosen = await choosePrompt("Which tier for this skill: core, vetted or community?", ["core", "vetted", "community"]);`. A non-null answer maps through `TIER_LABELS[chosen.toLowerCase()]`. An unknown answer prints `${RED}Invalid selection. Use core, vetted or community.${RESET}` and calls `process.exit(1)`. `null` falls through to the existing menu and readline prompt, unchanged.

- [ ] **Step 4: Run the tests, then the task gate**

Run: `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-project-env.test.ts tests/as-function-operating.test.ts tests/skill-management.test.ts`
Expected: PASS. Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/as-function/prompt.ts packages/cli/src/cli/as-function/project-env.ts packages/cli/src/cli/as-function/define.ts packages/cli/src/cli/as-function/operating.ts packages/cli/src/cli/skill.ts packages/cli/tests/as-function-project-env.test.ts packages/cli/tests/as-function-operating.test.ts
git commit -m "feat(cli): operating CLI commands callable from any room"
```

---

### Task 13: Standing CLI commands from a room

**Files:**
- Create: `packages/cli/src/cli/as-function/standing.ts`
- Modify: `packages/cli/src/cli/db.ts`, the `reset` case. Its `p.confirm({ message: "This will wipe all data in the cold store …", initialValue: false })` and `isCancel` check become `confirmPrompt` with the same message. A `false` keeps `p.log.info("Reset cancelled."); break;`.
- Modify: `packages/cli/src/cli/uninstall.ts`, both `p.confirm` sites. They become `confirmPrompt("Proceed?")` and `confirmPrompt("Remove swarm CLI globally?")`. A `false` keeps `p.outro("Cancelled."); process.exit(0);`.
- Test: `packages/cli/tests/as-function-standing.test.ts`, `packages/cli/tests/as-function-db-reset.test.ts` (a file of its own, so that `db.ts`, which reads `HOME` at import, is first imported after the fixture sets it)

**Interfaces:**
- Consumes: `defineCliCommand`, `CANCELLED` and `confirmPrompt` (Task 12). The existing entries: `runMergeCommand(flags)`, `CheckpointPublicationFile` and `selectMergeRetries` from `merge-command.ts`; `runDb(positional, flags)`; `runSubstrate`; `runUpgrade(flags)`; `runUninstall(flags)`; `VERSION`.
- Produces:

```ts
// standing.ts
export function standingDescriptors(deps?: Partial<ProjectEnvDeps>): CliCommandDescriptor[];   // merge, db reset, substrate stop, upgrade, uninstall
```

The five standing defs. Every standing command asks exactly once in the room: either the def's `confirm`, or the command's own prompt through the seam. The executor's step-up has already passed by the time either runs.

| name | project | needs | refuse | confirm | run |
|---|---|---|---|---|---|
| `merge` | required | project | none | a `<goal>` with no open merge record: `console.error("No open pull request for goal <goal> in <project>.")`, then `process.exit(1)`; else the selected records; none selected: `null` | `runMergeCommand(flags)`, with `flags.pr` set to the goal's `pr_url` when `<goal>` is given |
| `db reset` | optional | project | none | `null` (`runDb`'s own prompt) | `runDb(["reset"], flags)` |
| `substrate stop` | optional | project | none | as below | `runSubstrate(["stop"], flags, env.projectSubstrate)` |
| `upgrade` | none | none | none | as below | `runUpgrade(flags)` |
| `uninstall` | optional | none | no `--swarm-path` and no `--global`: `Name the project to remove swarm from (/uninstall --project <name>), or pass --global.`; a swarm path not named `.swarm`: `/uninstall removes a .swarm directory; <swarmPath> is not one.` | `null` (its own prompts) | `runUninstall(flags)` |

`merge`'s `confirm` and `run` share one helper. It reads `<swarm-path>/domains/<project>/.checkpoints/checkpoint.json` with `CheckpointPublicationFile.open`, and selects with `selectMergeRetries`, where a `<goal>` becomes `{ pr: <its pr_url> }`. `merge` uses `needs: "project"`, not main.ts's store bring-up, because `runMergeCommand` never takes a client. The confirm texts are:
- `merge`: `Merge <n> pull request<s> that swarm left open for <project>?`, then one line per record, `  <goal_id>  <pr_url>  (<left_open_kind ?? "no kind">)`.
- `substrate stop` on a dedicated project: `Stop <project>'s own Substrate stack (cold and meta sidecars)? Postgres keeps running; runs that use this stack lose their store until it starts again.`
- `substrate stop` otherwise: `Stop the shared Substrate stack, which every project without its own uses (cold and meta sidecars)? Postgres keeps running; runs that use this stack lose their store until it starts again.`
- `upgrade`: `Upgrade swarm on the brain's host from v<VERSION> to <--version or "the newest release">? The brain keeps running v<VERSION> until it restarts.`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/as-function-standing.test.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/cli/merge-command.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/merge-command.js")>()), runMergeCommand: vi.fn(async () => { console.log("  Nothing to retry."); }) }));
vi.mock("../src/cli/upgrade.js", () => ({ runUpgrade: vi.fn() }));
vi.mock("../src/cli/substrate.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/substrate.js")>()), runSubstrate: vi.fn() }));
import { runMergeCommand } from "../src/cli/merge-command.js";
import { runSubstrate } from "../src/cli/substrate.js";
import { runUpgrade } from "../src/cli/upgrade.js";
import { VERSION } from "../src/version.js";
import { standingDescriptors } from "../src/cli/as-function/standing.js";
import { dedicatedProject, isolateSubstrateProject, swarmDir } from "./substrate-project-fixture.js";

isolateSubstrateProject();
const roomIo = (answers: string[]) => { const asked: string[] = []; return { asked, io: { write: vi.fn(), prompt: vi.fn(async (q: string) => { asked.push(q); return answers.shift() ?? ""; }) } }; };
const d = (name: string) => standingDescriptors().find((x) => x.name === name)!;
const target = () => ["--swarm-path", swarmDir(), "--project", "project-a"];
const PR = (n: number) => `https://github.com/owner-a/repo-a/pull/${n}`;
function checkpoint() {
  const dir = join(swarmDir(), "domains", "project-a", ".checkpoints");
  mkdirSync(dir, { recursive: true });
  const rec = (goal: string, n: number) => ({ goal_id: goal, description: goal, mode: "merge", branch: `b-${goal}`, pushed: true, merged: false, pr_url: PR(n), left_open_kind: "conflict", left_open_reason: "conflict" });
  writeFileSync(join(dir, "checkpoint.json"), JSON.stringify({ goal_publications: [rec("goal-1", 1), rec("goal-2", 2)] }));
}

describe("standing descriptors", () => {
  it("declares the five standing commands as the registry expects", () => {
    expect(standingDescriptors().map((x) => [x.name, x.kind, x.project])).toEqual([
      ["merge", "standing", "required"], ["db reset", "standing", "optional"], ["substrate stop", "standing", "optional"], ["upgrade", "standing", "none"], ["uninstall", "standing", "optional"],
    ]);
  });
  it("merge lists the pull requests it will merge and runs only after a yes", async () => {
    checkpoint();
    const no = roomIo(["no"]);
    expect(await d("merge").run(target(), no.io)).toEqual({ code: 0, stdout: "Cancelled; nothing was changed.\n", stderr: "" });
    expect(no.asked).toEqual([`Merge 2 pull requests that swarm left open for project-a?\n  goal-1  ${PR(1)}  (conflict)\n  goal-2  ${PR(2)}  (conflict)`]);
    expect(runMergeCommand).not.toHaveBeenCalled();
    await d("merge").run(target(), roomIo(["yes"]).io);
    expect(vi.mocked(runMergeCommand).mock.calls[0][0]).toMatchObject({ "swarm-path": swarmDir(), project: "project-a" });
  });
  it("merge <goal> merges that goal's pull request, and refuses a goal with none", async () => {
    checkpoint();
    const { io, asked } = roomIo(["yes"]);
    await d("merge").run(["goal-2", ...target()], io);
    expect(asked[0]).toBe(`Merge 1 pull request that swarm left open for project-a?\n  goal-2  ${PR(2)}  (conflict)`);
    expect(vi.mocked(runMergeCommand).mock.calls.at(-1)![0]).toMatchObject({ pr: PR(2) });
    expect(await d("merge").run(["goal-9", ...target()], roomIo([]).io)).toEqual({ code: 1, stdout: "", stderr: "No open pull request for goal goal-9 in project-a.\n" });
  });
  it("substrate stop names the stack it stops, and upgrade names both versions", async () => {
    dedicatedProject();
    const stop = roomIo(["yes"]);
    await d("substrate stop").run(target(), stop.io);
    expect(stop.asked).toEqual(["Stop project-a's own Substrate stack (cold and meta sidecars)? Postgres keeps running; runs that use this stack lose their store until it starts again."]);
    expect(vi.mocked(runSubstrate).mock.calls[0][0]).toEqual(["stop"]);
    const up = roomIo(["no"]);
    await d("upgrade").run(["--version", "v9.9.9"], up.io);
    expect(up.asked).toEqual([`Upgrade swarm on the brain's host from v${VERSION} to v9.9.9? The brain keeps running v${VERSION} until it restarts.`]);
    expect(runUpgrade).not.toHaveBeenCalled();
  });
  it("uninstall needs a project or --global, and confirms through its own prompt with what it will remove", async () => {
    expect(await d("uninstall").run([], roomIo([]).io)).toEqual({ code: 1, stdout: "", stderr: "Name the project to remove swarm from (/uninstall --project <name>), or pass --global.\n" });
    const { io, asked } = roomIo(["no"]);
    expect((await d("uninstall").run(target(), io)).code).toBe(0);
    expect(asked[0]).toContain("This will remove:");
    expect(asked[0]).toContain("Proceed?");
    expect(existsSync(swarmDir())).toBe(true);
  });
});
```

```ts
// packages/cli/tests/as-function-db-reset.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: vi.fn(() => { throw new Error("no process may run in this test"); }) }));
import { execFileSync } from "node:child_process";
import { standingDescriptors } from "../src/cli/as-function/standing.js";
import { homeDir, isolateSubstrateProject } from "./substrate-project-fixture.js";

isolateSubstrateProject();

describe("db reset from a room", () => {
  it("confirms through the command's own prompt and runs nothing on a no", async () => {
    mkdirSync(join(homeDir(), ".swarm", "infrastructure"), { recursive: true });
    writeFileSync(join(homeDir(), ".swarm", "infrastructure", "docker-compose.yml"), "services: {}\n");
    const asked: string[] = [];
    const io = { write: vi.fn(), prompt: vi.fn(async (q: string) => { asked.push(q); return "no"; }) };
    const r = await standingDescriptors().find((x) => x.name === "db reset")!.run([], io);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Reset cancelled.");
    expect(asked[0]).toContain("This will wipe all data in the cold store");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-standing.test.ts tests/as-function-db-reset.test.ts`
Expected: FAIL. `../src/cli/as-function/standing.js` does not exist yet.

- [ ] **Step 3: Implement `standing.ts` and the seams in `db.ts` and `uninstall.ts`**

- [ ] **Step 4: Run the tests, then the task gate**

Run: `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-standing.test.ts tests/as-function-db-reset.test.ts tests/uninstall.test.ts tests/db-sidecar.test.ts`
Expected: PASS, including the existing `uninstall` and `db` tests unchanged. Then run the task gate.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/as-function/standing.ts packages/cli/src/cli/db.ts packages/cli/src/cli/uninstall.ts packages/cli/tests/as-function-standing.test.ts packages/cli/tests/as-function-db-reset.test.ts
git commit -m "feat(cli): standing CLI commands from rooms, confirmed once in the room"
```

---

### Task 14: Hand plan 08's commands to the brain at start

**Files:**
- Create: `packages/cli/src/cli/as-function/index.ts`
- Modify: `packages/cli/src/cli/os.ts` (plan 03), the one line of the `start` subcommand that calls `Brain.start(config, …)`, wherever `runOs` starts the brain, its supervised or foreground path included. Its options object gains `commands: (await import("./as-function/index.js")).cliBackedCommands()`. A bare `Brain.start(config)` becomes `Brain.start(config, { commands: (await import("./as-function/index.js")).cliBackedCommands() })`. Nothing else in `os.ts` changes.
- Test: `packages/cli/tests/as-function-commands.test.ts`

**Interfaces:**
- Consumes: `operatingDescriptors` (Task 12), `standingDescriptors` (Task 13), `cliBackedSpec` (Task 11) and `registrationCommands` (Task 9, from `@mnmal-ai/swarm-os`). Plan 03's `Brain.start(config, { commands })`, which registers each spec through plan 05's `registerCommand` before the API starts.
- Produces:

```ts
// index.ts
export function cliBackedCommands(deps?: Partial<ProjectEnvDeps>): CommandSpec<any>[];
// every command plan 08 adds to the brain: the eleven CLI-backed specs (operating, then standing), then the four registration commands
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/as-function-commands.test.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliBackedCommands } from "../src/cli/as-function/index.js";

describe("cliBackedCommands", () => {
  it("hands the brain the fifteen commands plan 08 adds, with the kinds the registry fixes", () => {
    const specs = cliBackedCommands();
    expect(specs.map((s) => [s.name, s.kind])).toEqual([
      ["sync", "operating"], ["logs", "operating"], ["skill", "operating"], ["mcp", "operating"], ["substrate status", "operating"], ["doctor", "operating"],
      ["merge", "standing"], ["db reset", "standing"], ["substrate stop", "standing"], ["upgrade", "standing"], ["uninstall", "standing"],
      ["register", "standing"], ["unregister", "standing"], ["set ask_first", "standing"], ["set limits", "standing"],
    ]);
    for (const s of specs.slice(0, 11)) {
      expect(s.args.parse({ argv: ["--project", "project-a"] })).toEqual({ argv: ["--project", "project-a"] });
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });
  it("is what swarm os start passes to the brain", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/cli/os.ts"), "utf8");
    expect(source).toContain('commands: (await import("./as-function/index.js")).cliBackedCommands()');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os build && cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-commands.test.ts`
Expected: FAIL. `../src/cli/as-function/index.js` does not exist yet.

- [ ] **Step 3: Implement `index.ts` and change the one `Brain.start` line in `os.ts`**

`cliBackedCommands` returns `[...operatingDescriptors(deps), ...standingDescriptors(deps)].map(cliBackedSpec)`, followed by `registrationCommands()`.

- [ ] **Step 4: Run the test, then the task gate**

Run: `cd packages/cli && env -u ANTHROPIC_API_KEY npx vitest run tests/as-function-commands.test.ts`
Expected: PASS (2 tests). Then run the task gate, and `pnpm -w build` as the plan's last check.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/as-function/index.ts packages/cli/src/cli/os.ts packages/cli/tests/as-function-commands.test.ts
git commit -m "feat(cli): hand the CLI-backed and registration commands to the brain at start"
```

---

## Contract additions

Each one is also named in the **Produces** block of the task that relies on it.

1. **The `stepup` event carries `code`,** for the host and confirmer devices only (Task 5). This is the same addition plan 07 makes, as its addition 3. **`hello` gains `stepUps?: PendingStepUp[]`** for those actors, so a TUI opened after the step-up was issued still shows its code. Without it, `swarm os register` run before `swarm top` could never be confirmed.
2. **Terminal sign-in** (Task 1): `GET /api/auth/cli/:nonce` (with an `X-Swarm-Os-Poll` header) and `POST /api/auth/cli/:nonce/approve`, in `packages/os/src/api/cli-login.ts`. Plan 03's composition root makes one `mountCliLogin` call with its session issuer. Plan 07's dashboard needs a screen at `/#cli-login=<nonce>` whose "Approve" button posts the approve route.
3. **`InstanceRow` has no `phase` or `currentTask`,** which the spec's instance line shows. `WireInstance` renders them when an instance carries them (Task 4), as plan 07 does in its addition 6.
4. **`register`, `unregister`, `set ask_first` and `set limits` are plan 08's** (Task 9), because plans 04 and 09 attribute `register` to plan 08. Their args are Registration field names, as plan 09's limit gate reads them. They reach the brain with the CLI-backed commands through `Brain.start(config, { commands })` (Task 14).
5. **Plan 05's argument conversion.** A `z.object` whose keys are the positional words in order, with a bare `--flag` meaning `true` (plan 06's reading), plus `--kebab-case <value>` pairs mapped into camelCase keys. A trailing array key takes every remaining word, `--flags` included. Plan 04 reads the same contract as `spec.args.parse(rest)`. Plan 05 must reconcile the two readings; plan 08's specs follow plan 06's.
6. **`ArgvArgs`** (`packages/os/src/commands/argv-args.ts`, Task 11) is the args schema of every CLI-backed spec. It is exported so that `packages/cli` builds `CommandSpec`s without a zod dependency of its own.
