# Swarm OS Dashboard (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Swarm OS dashboard: an installable web app, embedded in and served by the brain, where the owner signs in with a passkey, talks to the chief of staff, reads every room as a channel, answers workers' questions, runs any command with step-up confirmation, and receives Web Push on a phone.

**Architecture:** `packages/os-web` (`@mnmal-ai/swarm-os-web`) is a Vite + React 18 single-page app plus a service worker. It hears the brain through one `EventSource` on `GET /api/stream?rooms=all` and acts through plain HTTP routes, authenticated by the brain's HttpOnly session cookie, so the page never holds a token. All live state sits in one external store whose reducers are idempotent, so replayed events are harmless. Message lists are ordered by `seq` and refilled over REST after a `gap` or a fresh stream. `packages/os` embeds the build: a prebuild script writes a manifest of Bun `with { type: "file" }` imports, `web-embed.ts` loads them (or `packages/os-web/dist` from disk under Node), and `static.ts` serves them under a strict same-origin CSP.

**Tech Stack:** TypeScript, React 18, Vite 6 with `@vitejs/plugin-react` 4, `@simplewebauthn/browser` 14, `EventSource` (Server-Sent Events), the Push API and a service worker, vitest 3 with jsdom 26, @testing-library/react 16, user-event 14 and jest-dom 7, Bun file embedding (`bun build --compile`), `node:http` handlers on plan 03's router.

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md` (Clients; Messaging: Push, Visibility, Private projects; Deployment: reaching the brain from a phone; Threat model), with the shared contracts in `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md` ("Transport" and "Brain API" above all). Where this plan and the spec disagree, the spec wins; what this plan needs and the overview lacks is listed under **Contract additions**.

## Global Constraints

- **Package conventions** (overview, verbatim): "`packages/os` and `packages/os-web` are `"type": "module"`, `"version": "1.0.0-alpha.0"`, `"license": "Apache-2.0"`, depend on siblings with `"workspace:*"`, extend `../../tsconfig.base.json`, test with `vitest run`, build with `tsc` (os) or `vite build` (os-web)." os-web also has a `test:ci` script like every sibling, because CI runs `pnpm turbo test:ci` and a package without that script is silently skipped.
- **Transport** (overview, verbatim): "Server to client is **Server-Sent Events**; client to server is **plain HTTP**. The brain has no WebSocket." The dashboard opens `new EventSource("/api/stream?rooms=all")` and nothing else long-lived.
- **Auth is the brain's cookie** (overview, verbatim): "the passkey login sets a cookie `swarm_os_session` (`HttpOnly; SameSite=Strict; Path=/; Secure` …)" and "Every state-changing route (`POST`, `PUT`, `DELETE` under `/api`) requires the header `X-Swarm-Os: 1`". The dashboard never holds a session token. It never sends `X-Swarm-Os-Client`, never reads `document.cookie`, and keeps nothing about the session in `localStorage`, `sessionStorage`, IndexedDB or Cache Storage. `src/api.ts` is the only module that calls `fetch`: it always sends `credentials: "same-origin"`, and adds `X-Swarm-Os: 1` on every non-`GET`.
- **Status codes are the contract** (overview, verbatim): "`400 bad_request`, `401 unauthenticated`, `403 forbidden | provenance_mismatch | lockdown`, `404 not_found`, `409 conflict`, `428 stepup_required` (with `stepUpId`), `429 cooldown` (with `cooldownUntil`) or `429 limit` (with `limit`), `503 store_unavailable`", in the error body `{ error: { code, message, [extra] } }`.
- **Contracts verbatim**: route paths, event names and fields exactly as `00-overview.md` gives them; additions only as listed below, never renames.
- **Private projects** (overview, verbatim): "push bodies for a `local_only` project carry only the room id and message kind". The service worker turns such a payload into "A <kind> in <room name>".
- **Agents are data, not voices** (spec, Threat model): every message body, card text and worker output is rendered as text. No `dangerouslySetInnerHTML`, no Markdown or HTML rendering, and links only for `http:`/`https:` URLs.
- **Same origin only**: no third-party CDN scripts, styles or fonts. DM Sans and DM Mono arrive as `data:` URIs inside the vendored Axon tokens. The brain serves the app under `default-src 'self'`.
- **Axon**: colours, shadows and motion come only from `var(--…)` tokens in `packages/cli/src/server/axon/tokens.css` and `theme-light.css`, imported from there and never copied. Status semantics follow `dashboard/src/theme.js`: cyan for active or pending, amber for in progress or usage (tokens), green for success, magenta (`--purple`) for failure, red for destructive actions only. The only literal colours are the manifest's and `<meta name="theme-color">` values, copied from `--bg` (`#0a0f1a` dark, `#f0f4f8` light), because JSON and meta tags cannot read CSS variables.
- **Anonymity of the tree** (overview, verbatim): "no personal names, client names, hostnames or home-directory paths in code, tests, fixtures or docs. Examples use `board-a`, `project-a`, `owner`, `/path/to/project`." Test hosts use the reserved `.test` TLD.
- **No new GitHub workflows and no trigger changes** (overview, verbatim). os-web joins the existing `turbo build`/`test:ci` by being a workspace package.
- os-web imports are extensionless (`moduleResolution: "Bundler"`); `packages/os` keeps `.js` suffixes.
- Every task ends with `pnpm -w build` green and the touched package's tests green.

## Review Focus

1. **A phone loses the network while a command or message `POST` is in flight (the brain may already have acted), and the owner presses Retry.** Expected: the retry carries the same `Idempotency-Key`, so the brain returns the first result rather than running the command or posting the message twice; the bar keeps the text until something succeeds. Tests: Task 2 ("sends the Idempotency-Key it is given"), Task 7 ("retries a failed send with the same Idempotency-Key").
2. **The session expires (`session_ttl_hours`, default 24) or is revoked (`swarm os lockdown`) while the app is open.** Expected: the stream's 401 closes the `EventSource` for good; the app probes `GET /api/me`, sees 401 and shows sign-in, with no reconnect loop. Tests: Task 4 ("stops for good when the session is gone"), Task 5 ("goes back to sign-in when the brain says the session is gone").
3. **Room content is hostile**: a card or worker message containing HTML, or a compromised instance reporting `dashboardUrl: "javascript:…"`. Expected: shown as literal text; no link rendered. Tests: Task 6 ("renders bodies as text, never HTML"), Task 8 ("only links http and https", "renders no link for a javascript: dashboard URL").
4. **Push on a device that cannot do it yet**: an iPhone using Safari without the app on the Home Screen, notification permission denied, or a brain with no VAPID keys. Expected: the toggle says which one, never throws and never posts a subscription. Tests: Task 11 ("asks an iPhone user to install the app first", "says notifications are blocked…", "says push is not configured…").
5. **A push the service worker cannot read, or for a room it has no name for** (common right after install). Expected: a notification is still shown, because browsers revoke push for silent pushes: generic text, with "a private room" for an unknown room. Tests: Task 11 ("still shows a notification for a payload it cannot read", "uses 'An' before a vowel and 'a private room'…").

## Contracts this plan consumes (shapes the overview leaves open)

`src/api.ts` (Task 2) and `src/store.ts` (Task 3) are the only readers of these shapes, so a different shape from plans 03 to 05 is a change there alone.

- Plan 03, passkeys: `POST /api/auth/login/options` `{}` → `PublicKeyCredentialRequestOptionsJSON`. `POST /api/auth/login/verify` `{ response: AuthenticationResponseJSON }` → sets the cookie and returns `{ humanId, deviceId, expiresAt }`; the dashboard keeps exactly those three fields, even if a body carries more. `POST /api/auth/register/options` `{ deviceName, enrolment?, enrolmentId? }` → `200 { enrolmentId, options }` when allowed (a first-device code, or a later device that an existing device approved), `202 { enrolmentId, state: "pending" }` while waiting for approval, and `403`/`410` when refused or expired. `POST /api/auth/register/verify` `{ enrolmentId, response: RegistrationResponseJSON }` → sets the cookie, same body as login.
- Plan 03, stream: `GET /api/stream` answers 401 without a live session. `EventSource` then closes for good, which is what tells the client to probe `GET /api/me`.
- Plan 03, router: `Api` satisfies `RouteRegistrar { get(path, ...handlers) }` with `(req, res, next)` handlers, and plan 03's composition root makes the one `registerStatic(api)` call. If plan 03's router differs, the root passes an adapter, `{ get: (p, ...h) => api.<its method>("GET", p, ...h) }`; nothing else changes. Plan 03 makes `@mnmal-ai/swarm-cli` depend on `@mnmal-ai/swarm-os` (`swarm os start`), which is how the binary reaches the embedded files.
- Plan 05: `GET /api/rooms` → `RoomRow[]` and `GET /api/rooms/:id/messages?beforeSeq&limit` → `MessageRow[]`, bare arrays as for `GET /api/commands`. A page holds the newest `limit` messages (at most 100) with `seq < beforeSeq`, in any order. A question message's `dataJson` is `{ questionId, options?, to? }` (`to` absent means a human), and its answer is an `answer` message whose `replyTo` is the question message id. A command's audit message has `dataJson` `{ argv, result? }`. `argv` never includes the leading `/`. A 428 carries `error.stepUpId`; re-POSTing the same `room` and `argv` with `stepUpId` and `code` runs the command. `POST /api/push/subscribe { subscription: PushSubscriptionJSON }`; `DELETE /api/push/subscribe` with no body removes this device's subscription.
- Plan 04: `hello.instances` and `instance` events carry `InstanceRow`.

## Contract additions (Produces)

1. **The `stepup` event gains `code: string`.** The overview has "`stepup { stepUpId, command: string[], expiresAt }` (sent only to confirmer devices and the host)", but the spec has the code "shown … in a second enrolled device's session", which needs the code in the event. The brain should not send it to the device whose session issued the command. Without `code`, the dashboard's prompt asks for the code instead of showing it (Task 9).
2. **Push payload** (plan 05 sends it, plan 07's service worker reads it): `{ roomId: string; kind: MessageKind; roomName?: string; summary?: string }`. For a `local_only` room it is exactly `{ roomId, kind }`.
3. **Links**: `swarm os init` (plan 03) prints the first-device link as `<public_url>/#enrol=<code>`; notifications open `/#room=<roomId>`. Fragments are never sent to the server, so the codes stay out of its logs.
4. **Instance line fields**: the spec's instance line is "card, project, phase, current task, tokens, elapsed, last heartbeat", but the overview's `Instance` type has no `phase`, `currentTask` or project name, although heartbeats carry `phase` and `currentTask`. The dashboard renders `phase?`, `currentTask?` and `projectName?` when an `InstanceRow` carries them and "—" otherwise. Plan 04 should add them.
5. **Static paths** beyond the overview's `GET /`, `GET /assets/*`, `GET /sw.js` and `GET /manifest.webmanifest`: one exact route per embedded file, which adds `/index.html`, `/icon-192.png`, `/icon-512.png` and `/apple-touch-icon.png`.

**Behaviour the overview implies, pinned here:** replays are absorbed by idempotent reducers (messages by id, step-ups by `stepUpId`, everything else replaces state), not by event id. Every connection starts with `hello`, and a restarted brain may restart its sequence. A `gap`, or the `hello` of a new `EventSource` that replaced a failed one, refills from REST by `seq` every room the store holds messages for. Rooms it holds none for load when opened. A room opened after `hello` has no event of its own, so a `message` or `instance` naming an unknown room refetches `GET /api/rooms`.

**Cross-plan touch points (ownership exceptions, each one line or one block):** `packages/os/package.json` (plan 02's file) gains the `@mnmal-ai/swarm-os-web` dependency and a `prebuild`. Plan 03's composition root gains one `await registerStatic(api)` call, after every `/api` route. The root `.gitignore` gains the generated manifest. `packages/os/src/index.ts` gains a plan-07 export block, append-only as the overview allows. All of these are in Task 12. Plan 07 also owns these new files: `packages/os/src/api/web-manifest.generated.ts` (generated, git-ignored), `packages/os/scripts/gen-web-manifest.mjs`, `packages/os/tests/api/static.test.ts`, `packages/os/tests/api/web-embed.test.ts`, `packages/os/tests/api/http-fakes.ts` and `packages/os/tests/scripts/gen-web-manifest.test.ts`.

## File structure

```
packages/os-web/
  package.json  tsconfig.json  tsconfig.sw.json  vite.config.ts  vitest.config.ts  index.html
  public/       manifest.webmanifest  icon-192.png  icon-512.png  apple-touch-icon.png
  src/
    main.tsx              mounts <App/>; registers /sw.js in production
    App.tsx               screens: enrol | login | connected (decided by GET /api/me); owns the Client
    axon.css  app.css     Axon tokens (imported from the CLI's vendored copy) and this app's classes
    types.ts              wire types mirrored from the overview. os-web cannot import @mnmal-ai/swarm-os:
                          packages/os depends on os-web to embed it, so the reverse would be a cycle
    api.ts                the only fetch caller: credentials, X-Swarm-Os, Idempotency-Key, status side effects
    stream.ts             BrainStream: EventSource, named events, hard-failure probe and backoff, resume
    store.ts              state, idempotent event reducer, seq ordering, unread, gap refill, useStore
    client.ts context.ts  api + store + stream composition; React context
    hash.ts argv.ts format.ts url.ts messages.ts rooms.ts hooks.ts push.ts    pure helpers
    auth/                 passkeys.ts  Login.tsx  Enrol.tsx
    components/           Layout Channels Chat MessageItem QuestionBox CommandBar StepUpPrompt
                          Instances Resources PushToggle CooldownBanner (.tsx)
    sw.ts  sw/notification.ts  sw/handlers.ts    service worker; WebWorker lib; only src/sw.ts imports src/sw/
  tests/                  setup.ts  fakes.ts  render.tsx  one *.test.ts(x) per unit
packages/os/
  scripts/gen-web-manifest.mjs        prebuild: lists and checks os-web/dist, writes the manifest
  src/api/static.ts                   RouteRegistrar, content types, cache policy, security headers, registerStatic
  src/api/web-embed.ts                loadWebFiles: Bun-embedded files, else os-web/dist on disk
  src/api/web-manifest.generated.ts   generated by prebuild, git-ignored
```

---

### Task 1: Scaffold `@mnmal-ai/swarm-os-web`

**Files:**
- Create: `packages/os-web/package.json`, `packages/os-web/tsconfig.json`, `packages/os-web/vite.config.ts`, `packages/os-web/vitest.config.ts`, `packages/os-web/index.html`, `packages/os-web/src/main.tsx`, `packages/os-web/src/App.tsx`, `packages/os-web/src/axon.css`, `packages/os-web/src/app.css`, `packages/os-web/public/manifest.webmanifest`, `packages/os-web/public/icon-192.png`, `packages/os-web/public/icon-512.png`, `packages/os-web/public/apple-touch-icon.png`, `packages/os-web/tests/setup.ts`
- Modify: `pnpm-lock.yaml`
- Test: `packages/os-web/tests/manifest.test.ts`

**Interfaces:**
- Consumes: `packages/cli/src/server/axon/tokens.css` and `theme-light.css`, unchanged; the brand mark PNG embedded in `packages/cli/src/server/dashboard.html` (`class="brand-m-img"`, 1000×400, the mark in the left 400×400).
- Produces: package `@mnmal-ai/swarm-os-web` with `build` (→ `packages/os-web/dist`), `test` and `test:ci`; `exports` of `./package.json` and `./dist/*` (Task 12 imports `@mnmal-ai/swarm-os-web/dist/<file>`); a placeholder `App(): JSX.Element` (Task 5 replaces it); CSS classes for later tasks: `.axon-panel`, `.axon-card`, `.axon-btn`, `.axon-btn-primary`, `.axon-btn-secondary`, `.axon-btn-text`, `.axon-press`, `.mono`, `.sr-only`, `.badge`, and `.tone-active`, `.tone-progress`, `.tone-success`, `.tone-failure`, `.tone-danger` (`color: var(--cyan | --amber | --green | --purple | --red)`).

- [ ] **Step 1: Create the package skeleton and the failing test**

`packages/os-web/package.json`:

```json
{
  "name": "@mnmal-ai/swarm-os-web",
  "version": "1.0.0-alpha.0",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "files": ["dist"],
  "exports": { "./package.json": "./package.json", "./dist/*": "./dist/*" },
  "scripts": {
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run",
    "test:ci": "vitest run --reporter=verbose --reporter=json --outputFile=test-results.json --coverage --coverage.reporter=json-summary --coverage.reporter=text"
  },
  "dependencies": { "@simplewebauthn/browser": "^14.0.0", "react": "^18.3.0", "react-dom": "^18.3.0" },
  "devDependencies": {
    "@testing-library/dom": "^10.4.0", "@testing-library/jest-dom": "^7.0.1", "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.7.0", "jsdom": "^26.1.0", "vite": "^6.4.0", "vitest": "^3.0.0"
  }
}
```

`vitest` is listed so jest-dom's `vitest` peer resolves to the root's copy rather than a second install, which would register its matchers on another `expect`. `tsconfig.json` extends `../../tsconfig.base.json` with `module: "ESNext"`, `moduleResolution: "Bundler"`, `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`, `types: ["vite/client"]`, `noEmit: true`, `declaration: false`, `declarationMap: false`, `sourceMap: false`, `isolatedModules: true`, `include: ["src/**/*"]` and `exclude: ["src/sw.ts", "src/sw/**"]`. `vitest.config.ts`: `plugins: [react()]`, `test: { globals: true, environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"], setupFiles: ["tests/setup.ts"], env: { TZ: "UTC" } }`. `tests/setup.ts`: `import "@testing-library/jest-dom/vitest";` and `afterEach(() => { vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); })`.

`packages/os-web/tests/manifest.test.ts`:

```ts
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url));
const pngSize = (p: string) => { const b = read(p); expect(b.subarray(1, 4).toString()).toBe("PNG"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

it("is an installable standalone app at /", () => {
  const m = JSON.parse(read("../public/manifest.webmanifest").toString());
  expect(m).toMatchObject({ name: "Swarm OS", short_name: "Swarm", start_url: "/", scope: "/", display: "standalone", background_color: "#0a0f1a", theme_color: "#0a0f1a" });
  expect(m.icons).toEqual([
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);
});
it("ships the icons at the sizes the manifest names", () => {
  expect(pngSize("../public/icon-192.png")).toEqual([192, 192]);
  expect(pngSize("../public/icon-512.png")).toEqual([512, 512]);
  expect(pngSize("../public/apple-touch-icon.png")).toEqual([180, 180]);
});
it("loads Axon from the CLI's vendored tokens, not a copy", () => {
  const css = read("../src/axon.css").toString();
  expect(css).toContain('@import "../../cli/src/server/axon/tokens.css";');
  expect(css).toContain('@import "../../cli/src/server/axon/theme-light.css" (prefers-color-scheme: light);');
});
it("has no inline script or style in index.html, which the brain's CSP would block", () => {
  const html = read("../index.html").toString();
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html).not.toMatch(/<style\b/i);
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
});
```

- [ ] **Step 2: Install and run the test to verify it fails**

Run: `pnpm install && pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/manifest.test.ts`
Expected: FAIL with `ENOENT: no such file or directory` for `public/manifest.webmanifest`.

- [ ] **Step 3: Create the app shell, Axon styles, manifest and icons**

- `public/manifest.webmanifest`: exactly the fields the test pins.
- Icons, made once and committed. sips ignores `--cropOffset 0 0` and crops the centre, so `1 1` is what takes the left square that holds the mark:

```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("packages/cli/src/server/dashboard.html","utf8");const m=h.match(/class="brand-m-img" src="data:image\/png;base64,([^"]+)"/);fs.writeFileSync(process.env.TMPDIR+"/brand.png",Buffer.from(m[1],"base64"))'
sips -c 400 400 --cropOffset 1 1 "$TMPDIR/brand.png" --out "$TMPDIR/mark.png"
sips -z 512 512 "$TMPDIR/mark.png" --out packages/os-web/public/icon-512.png
sips -z 192 192 "$TMPDIR/mark.png" --out packages/os-web/public/icon-192.png
sips -z 180 180 "$TMPDIR/mark.png" --out packages/os-web/public/apple-touch-icon.png
```

- `src/axon.css`: the two `@import` lines the test pins, then the rules of `dashboard/src/axon.css` from `:root { color-scheme: light dark; }` to the end, copied verbatim (base, `.axon-panel`, `.axon-card`, `.axon-rise`, `.axon-press`, `.axon-btn*`, reduced motion). `src/app.css`: `.mono { font-family: var(--mono); }`, a standard `.sr-only`, the five tone classes, and `.badge` (10px/600, `padding: 1px 6px`, `border-radius: 4px`, `background: var(--accent-dim)`, `color: var(--accent)`), in the style of `dashboard.html`'s `.badge`.
- `index.html`: `<!doctype html>`, `lang="en"`, `<meta charset="utf-8" />`, `viewport` with `width=device-width, initial-scale=1, viewport-fit=cover`, `color-scheme` `light dark`, `theme-color` `#0a0f1a` under `(prefers-color-scheme: dark)` and `#f0f4f8` under `(prefers-color-scheme: light)`, `apple-mobile-web-app-capable` `yes`, `<link rel="manifest" href="/manifest.webmanifest" />`, `<link rel="icon" href="/icon-192.png" />`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`, `<title>Swarm OS</title>`, `<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`.
- `vite.config.ts`: `plugins: [react()]`, `base: "/"`, `build: { outDir: "dist", emptyOutDir: true }`.
- `src/main.tsx` imports `./axon.css` and `./app.css` and renders `<StrictMode><App /></StrictMode>` into `#root`. `src/App.tsx` exports `App`, which renders `<main className="axon-panel">Swarm OS</main>` until Task 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/manifest.test.ts`
Expected: PASS, `Tests  4 passed (4)`.

- [ ] **Step 5: Build**

Run: `pnpm --filter @mnmal-ai/swarm-os-web build && ls packages/os-web/dist packages/os-web/dist/assets && grep -c "prefers-color-scheme:light" packages/os-web/dist/assets/*.css && pnpm -w build`
Expected: `dist` holds `index.html`, `manifest.webmanifest`, the three PNGs and `assets/index-<hash>.js` and `.css`; the grep prints `1`; turbo reports every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web pnpm-lock.yaml
git commit -m "feat(os-web): scaffold the Swarm OS dashboard package"
```

---

### Task 2: Wire types and the HTTP client

**Files:**
- Create: `packages/os-web/src/types.ts`, `packages/os-web/src/api.ts`, `packages/os-web/tests/fakes.ts`
- Test: `packages/os-web/tests/api.test.ts`

**Interfaces:**
- Consumes: the overview's "Transport" and "Brain API" sections; the bodies under **Contracts this plan consumes**; `@simplewebauthn/browser`'s exported types `PublicKeyCredentialCreationOptionsJSON`, `PublicKeyCredentialRequestOptionsJSON`, `RegistrationResponseJSON` and `AuthenticationResponseJSON`.
- Produces (`src/types.ts`; row fields are the overview's `osTypes` plus `id`, with dates as ISO strings):

```ts
export type RoomKind = "system" | "board" | "instance" | "direct" | "cos";
export interface RoomRow { id: string; kind: RoomKind; subjectId: string | null; name: string; membersJson: string; privacy: "normal" | "local_only"; createdAt: string; closedAt: string | null }
export type FromKind = "human" | "cos" | "instance" | "worker" | "reviewer" | "arbiter" | "system";
export type MessageKind = "text" | "command" | "question" | "answer" | "event" | "file" | "system";
export interface MessageRow { id: string; roomId: string; fromId: string; fromKind: FromKind; kind: MessageKind; body: string; dataJson: string | null; replyTo: string | null; provenanceJson: string; at: string; seq: number }
export interface QuestionRow { id: string; messageId: string; roomId: string; instanceId: string; sessionId: string; askedAt: string; waitUntil: string; state: "open" | "answered" | "expired" | "proceeded"; answerMessageId: string | null; proceededWith: string | null; lateAnswerMessageId: string | null }
export type InstanceState = "dispatching" | "running" | "paused" | "unresponsive" | "exited" | "failed" | "login_expired";
export interface InstanceRow { id: string; registrationId: string; boardId: string; cardId: string; runId: string | null; state: InstanceState; host: string; roomId: string; startedAt: string; lastHeartbeatAt: string | null; endedAt: string | null; exitReason: string | null; dashboardUrl: string | null; tokens: number; phase?: string | null; currentTask?: string | null; projectName?: string | null }
export const LIVE_STATES: ReadonlySet<InstanceState>;   // dispatching, running, unresponsive
export interface ResourceSnapshot { host: string; at: string; cpuLoad1: number; cpus: number; memFreeMb: number; memTotalMb: number; instancesRunning: number; claudeSessions: number; portsInUse: number[]; tokensThisHour: Record<string, number> }
export type Actor = /* the overview's Actor union, verbatim (human carries confirmer: boolean) */;
export interface Provenance { source: "owner" | "human" | "cos" | "worker" | "reviewer" | "arbiter" | "instance" | "card" | "webhook" | "memory" | "tool" | "system"; sessionId?: string; deviceId?: string; address?: string; instanceId?: string }
export interface CommandResult { ok: boolean; text: string; data?: unknown }
export interface CommandListing { name: string; kind: "query" | "operating" | "standing"; summary: string }
export interface Me { humanId: string; name: string; deviceId: string; confirmer: boolean; vapidPublic: string | null }
export interface LoginResult { humanId: string; deviceId: string; expiresAt: string }
export interface QuestionData { questionId: string; options?: string[]; to?: "human" | "cos" }
export interface CommandData { argv: string[]; result?: CommandResult }
export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthorized";
export interface HelloEvent { type: "hello"; actor: Actor; rooms: RoomRow[]; instances: InstanceRow[]; resources: ResourceSnapshot | null; cooldownUntil?: string | null; lockdown: boolean }
export interface StepUpEvent { type: "stepup"; stepUpId: string; command: string[]; expiresAt: string; code?: string }   // code: contract addition 1
export type BrainEvent = HelloEvent | StepUpEvent
  | { type: "message"; message: MessageRow } | { type: "instance"; instance: InstanceRow } | { type: "decision"; decision: { id: string } }
  | { type: "question"; question: QuestionRow } | { type: "resources"; snapshot: ResourceSnapshot }
  | { type: "cooldown"; cooldownUntil: string } | { type: "lockdown"; active: boolean } | { type: "gap" };
export const STREAM_EVENT_TYPES: readonly BrainEvent["type"][];   // the ten names above
```

`src/api.ts`:

```ts
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) }   // details: the error body's extra fields (stepUpId, cooldownUntil, limit)
export interface ApiDeps { fetch: typeof fetch; onUnauthorized: () => void; onCooldown: (cooldownUntil: string) => void; onLockdown: () => void; base?: string }   // base defaults to "" (same origin)
export type RegisterOptionsBody = { deviceName: string; enrolment?: string; enrolmentId?: string };
export type RegisterOptionsResult = { state: "ready"; enrolmentId: string; options: PublicKeyCredentialCreationOptionsJSON } | { state: "pending"; enrolmentId: string };
export interface Api {
  loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  loginVerify(response: AuthenticationResponseJSON): Promise<LoginResult>;
  registerOptions(body: RegisterOptionsBody): Promise<RegisterOptionsResult>;
  registerVerify(enrolmentId: string, response: RegistrationResponseJSON): Promise<LoginResult>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  rooms(): Promise<RoomRow[]>;
  messages(roomId: string, opts: { beforeSeq?: number; limit: number }): Promise<MessageRow[]>;
  commands(): Promise<CommandListing[]>;
  postMessage(roomId: string, message: { body: string; replyTo?: string }, idempotencyKey: string): Promise<void>;
  answer(questionId: string, body: string): Promise<{ question: QuestionRow; late: boolean }>;
  command(request: { room: string; argv: string[]; stepUpId?: string; code?: string }, idempotencyKey: string): Promise<CommandResult>;
  confirmStepUp(stepUpId: string, code: string): Promise<void>;
  pushSubscribe(subscription: PushSubscriptionJSON): Promise<void>;
  pushUnsubscribe(): Promise<void>;
}
export function createApi(deps: ApiDeps): Api;
export function newIdempotencyKey(): string;   // crypto.randomUUID()
```

`tests/fakes.ts` (later tasks extend it): `json(body: unknown, status = 200): Reply`; `fakeFetch(routes: Record<string, Reply | Reply[]>): { fn: typeof fetch; calls: Array<{ method: string; url: string; headers: Headers; body: unknown; credentials: RequestCredentials | undefined }> }`, keyed `"METHOD /path?query"`, where an array answers in order and repeats its last entry and an unknown key answers `404 { error: { code: "not_found", message } }`; `LOGIN: LoginResult = { humanId: "part-owner", deviceId: "dev-phone-a", expiresAt: "2099-01-01T00:00:00.000Z" }`; `me(over?: Partial<Me>): Me`, defaulting to `{ humanId: "part-owner", name: "owner", deviceId: "dev-phone-a", confirmer: true, vapidPublic: "AQID" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { ApiError, createApi } from "../src/api";
import { fakeFetch, json, LOGIN, me } from "./fakes";

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes); const on = { onUnauthorized: vi.fn(), onCooldown: vi.fn(), onLockdown: vi.fn() };
  return { f, ...on, api: createApi({ fetch: f.fn, ...on }) };
}

it("sends the session cookie and the CSRF header, and never asks for a token", async () => {
  const { f, api } = setup({ "POST /api/auth/login/verify": json({ ...LOGIN, token: "sess_should_not_be_kept" }) });
  expect(await api.loginVerify({ id: "cred-1" } as never)).toEqual(LOGIN);
  expect(f.calls[0]).toMatchObject({ url: "/api/auth/login/verify", credentials: "same-origin", body: { response: { id: "cred-1" } } });
  expect(f.calls[0].headers.get("x-swarm-os")).toBe("1");
  expect(f.calls[0].headers.get("x-swarm-os-client")).toBeNull();
  expect(f.calls[0].headers.get("authorization")).toBeNull();
});
it("pages a room's messages with beforeSeq and limit", async () => {
  const { f, api } = setup({ "GET /api/rooms/room-a/messages?beforeSeq=150&limit=100": json([]), "GET /api/rooms/room-a/messages?limit=100": json([{ id: "m1" }]) });
  await api.messages("room-a", { beforeSeq: 150, limit: 100 });
  expect(await api.messages("room-a", { limit: 100 })).toEqual([{ id: "m1" }]);
  expect(f.calls.map((c) => c.url)).toEqual(["/api/rooms/room-a/messages?beforeSeq=150&limit=100", "/api/rooms/room-a/messages?limit=100"]);
});
it("maps register/options 202 to pending and 200 to ready", async () => {
  const { api } = setup({ "POST /api/auth/register/options": [json({ enrolmentId: "enr-2", state: "pending" }, 202), json({ enrolmentId: "enr-2", options: { challenge: "c" } })] });
  expect(await api.registerOptions({ deviceName: "laptop-b" })).toEqual({ state: "pending", enrolmentId: "enr-2" });
  expect(await api.registerOptions({ deviceName: "laptop-b", enrolmentId: "enr-2" })).toEqual({ state: "ready", enrolmentId: "enr-2", options: { challenge: "c" } });
});
it("sends the Idempotency-Key it is given (Review Focus 1)", async () => {
  const { f, api } = setup({ "POST /api/commands": json({ ok: true, text: "Paused board-a" }), "POST /api/rooms/room-cos/messages": json({ id: "m9" }) });
  await api.command({ room: "room-cos", argv: ["pause", "board", "board-a"] }, "key-1");
  await api.postMessage("room-cos", { body: "what's running?" }, "key-2");
  expect(f.calls[0]).toMatchObject({ method: "POST", body: { room: "room-cos", argv: ["pause", "board", "board-a"] } });
  expect(f.calls[0].headers.get("idempotency-key")).toBe("key-1");
  expect(f.calls[1]).toMatchObject({ method: "POST", body: { kind: "text", body: "what's running?" } });
  expect(f.calls[1].headers.get("idempotency-key")).toBe("key-2");
});
it("answers a question and confirms a step-up on their own routes", async () => {
  const { f, api } = setup({ "POST /api/questions/q-1/answer": json({ question: { id: "q-1", state: "answered" }, late: false }), "POST /api/stepup/confirm": json({ ok: true }) });
  await api.answer("q-1", "Use v2");
  await api.confirmStepUp("su-1", "482913");
  expect(f.calls[0].body).toEqual({ body: "Use v2" });
  expect(f.calls[1]).toMatchObject({ url: "/api/stepup/confirm", body: { stepUpId: "su-1", code: "482913" } });
});
it("turns an error body into ApiError with its extra fields, and reports a 401 once", async () => {
  const { api, onUnauthorized } = setup({ "POST /api/commands": json({ error: { code: "stepup_required", message: "Needs a code", stepUpId: "su-1" } }, 428), "GET /api/me": json({ error: { code: "unauthenticated", message: "Signed out" } }, 401) });
  await expect(api.command({ room: "room-cos", argv: ["register", "board-a"] }, "k")).rejects.toMatchObject({ status: 428, code: "stepup_required", details: { stepUpId: "su-1" } });
  await expect(api.me()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});
it("reports a cooldown and a lockdown as they happen", async () => {
  const { api, onCooldown, onLockdown } = setup({ "POST /api/commands": [json({ error: { code: "cooldown", message: "Cooling down", cooldownUntil: "2026-10-25T12:10:00.000Z" } }, 429), json({ error: { code: "lockdown", message: "Locked down" } }, 403)] });
  await expect(api.command({ room: "room-cos", argv: ["top"] }, "k1")).rejects.toBeInstanceOf(ApiError);
  await expect(api.command({ room: "room-cos", argv: ["top"] }, "k2")).rejects.toMatchObject({ code: "lockdown" });
  expect(onCooldown).toHaveBeenCalledWith("2026-10-25T12:10:00.000Z");
  expect(onLockdown).toHaveBeenCalledTimes(1);
});
it("does not report a failed passkey sign-in as a lost session", async () => {
  const { api, onUnauthorized } = setup({ "POST /api/auth/login/verify": json({ error: { code: "unauthenticated", message: "No" } }, 401) });
  await expect(api.loginVerify({} as never)).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).not.toHaveBeenCalled();
});
it("reports a network failure as ApiError with status 0", async () => {
  const api = createApi({ fetch: async () => { throw new TypeError("Failed to fetch"); }, onUnauthorized: vi.fn(), onCooldown: vi.fn(), onLockdown: vi.fn() });
  await expect(api.me()).rejects.toMatchObject({ status: 0, code: "network" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/api.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api"`.

- [ ] **Step 3: Implement `types.ts`, `api.ts` and `tests/fakes.ts`**

`api.ts` builds paths with `encodeURIComponent` on ids. It sends JSON bodies with `content-type: application/json` and `credentials: "same-origin"` on every request, adds `X-Swarm-Os: 1` on every non-`GET`, and sends `Idempotency-Key` where the signature takes one. `loginVerify` and `registerVerify` return only `{ humanId, deviceId, expiresAt }`. A non-2xx response becomes `ApiError(status, error.code, error.message, <the other error fields>)`, or `ApiError(status, "http_<status>", statusText)` when the body is not the error shape, and its side effects run before the throw:
- 401 calls `onUnauthorized()`, except on `/api/auth/login/*` and `/api/auth/register/*`, where a 401 is a failed passkey rather than a lost session.
- 429 `cooldown` calls `onCooldown(cooldownUntil)`.
- 403 `lockdown` calls `onLockdown()`.

A thrown `fetch` becomes `ApiError(0, "network", message)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/api.test.ts`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/types.ts packages/os-web/src/api.ts packages/os-web/tests
git commit -m "feat(os-web): wire types and the brain API client"
```

---

### Task 3: The store: idempotent events, seq-ordered messages, unread counts and gap refill

**Files:**
- Create: `packages/os-web/src/store.ts`
- Modify: `packages/os-web/tests/fakes.ts` (fixtures)
- Test: `packages/os-web/tests/store.test.ts`

**Interfaces:**
- Consumes: `BrainEvent`, `RoomRow`, `MessageRow`, `QuestionRow`, `InstanceRow`, `ResourceSnapshot`, `Me`, `CommandListing`, `ConnectionStatus` and `Actor` (Task 2).
- Produces (`src/store.ts`):

```ts
export const PAGE = 100;
export const MAX_GAP_PAGES = 5;
export interface RoomMessages { rows: MessageRow[]; loaded: boolean; complete: boolean; gap: { after: number; before: number } | null }   // rows ascending by seq, unique by id
export interface PendingStepUp { stepUpId: string; command: string[]; expiresAt: string; code: string | null }
export interface State {
  me: Me | null; actor: Actor | null; connection: ConnectionStatus; commands: CommandListing[];
  rooms: Record<string, RoomRow>; messages: Record<string, RoomMessages>; unread: Record<string, number>; activeRoomId: string | null;
  questions: Record<string, QuestionRow>;   // by messageId
  instances: Record<string, InstanceRow>; resources: ResourceSnapshot | null; stepUps: PendingStepUp[]; cooldownUntil: string | null; lockdown: boolean;
}
export type FetchMessages = (roomId: string, opts: { beforeSeq?: number; limit: number }) => Promise<MessageRow[]>;
export interface Store {
  getState(): State;
  subscribe(listener: () => void): () => void;
  applyEvent(event: BrainEvent): void;
  setMe(me: Me | null): void; setCommands(list: CommandListing[]): void; setConnection(status: ConnectionStatus): void;
  setCooldown(cooldownUntil: string | null): void; setLockdown(active: boolean): void;
  setActiveRoom(roomId: string): Promise<void>;   // unread → 0 at once; loads the newest PAGE the first time
  loadOlder(roomId: string): Promise<void>;       // beforeSeq = oldest held seq; fewer than PAGE back → complete
  loadGap(roomId: string): Promise<void>;         // runs fillGap again over the recorded gap
  refillRooms(): Promise<void>;                   // refillRoom for every room the store holds messages for
  dismissStepUp(stepUpId: string): void;
  whenIdle(): Promise<void>;                      // settles when every queued fill and room refresh has
}
export function createStore(deps: { fetchMessages: FetchMessages; fetchRooms: () => Promise<RoomRow[]> }): Store;
export function useStore<T>(store: Store, selector: (s: State) => T): T;   // useSyncExternalStore
```

Fixtures added to `tests/fakes.ts`:
- `room(id: string, kind: RoomKind, over?: Partial<RoomRow>): RoomRow`, with the name defaulting to `id`.
- `msg(over: Partial<MessageRow> & { roomId: string; seq: number }): MessageRow`, with id `msg-<roomId>-<seq>`, `fromId: "part-cos"`, `fromKind: "cos"`, `kind: "text"`, body `message <seq>` and `provenanceJson: '{"source":"cos"}'`.
- `seqRange(roomId, from, to): MessageRow[]`.
- `hello(over?: Partial<HelloEvent>): HelloEvent`: a human actor `part-owner` with `confirmer: true`, no rooms, instances or resources, and `lockdown: false`.
- `question(over?: Partial<QuestionRow>): QuestionRow`, `instance(over?: Partial<InstanceRow>): InstanceRow` and `snapshot(over?: Partial<ResourceSnapshot>): ResourceSnapshot`.
- `seqs(store: Store, roomId: string): number[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { createStore } from "../src/store";
import { hello, me, msg, question, room, seqRange, seqs } from "./fakes";
import type { MessageRow } from "../src/types";

function setup(initial: Record<string, MessageRow[]> = {}) {
  const pages: Record<string, MessageRow[]> = { ...initial };        // key "<room> <beforeSeq|-> <limit>"
  const calls: Array<[string, { beforeSeq?: number; limit: number }]> = [];
  const fetchMessages = vi.fn(async (roomId: string, opts: { beforeSeq?: number; limit: number }) => { calls.push([roomId, opts]); return pages[`${roomId} ${opts.beforeSeq ?? "-"} ${opts.limit}`] ?? []; });
  const fetchRooms = vi.fn(async () => [room("room-cos", "cos"), room("room-a", "board"), room("room-new", "instance")]);
  const store = createStore({ fetchMessages, fetchRooms });
  store.setMe(me());
  return { store, pages, calls, fetchRooms };
}
async function loadedRoomA(initial: MessageRow[]) {
  const s = setup({ "room-a - 100": initial });
  s.store.applyEvent(hello({ rooms: [room("room-a", "board")] }));    // no cos room, so nothing opens by itself
  await s.store.setActiveRoom("room-a");
  s.calls.length = 0;
  return s;
}

it("counts unread for a message in a room the user is not viewing", async () => {
  const { store } = setup();
  store.applyEvent(hello({ rooms: [room("room-cos", "cos"), room("room-a", "board")] }));
  await store.whenIdle();
  expect(store.getState().activeRoomId).toBe("room-cos");
  store.applyEvent({ type: "message", message: msg({ roomId: "room-a", seq: 1 }) });
  store.applyEvent({ type: "message", message: msg({ roomId: "room-cos", seq: 1 }) });
  expect(store.getState().unread["room-a"]).toBe(1);
  expect(store.getState().unread["room-cos"] ?? 0).toBe(0);
});
it("does not count the owner's own messages", () => {
  const { store } = setup();
  store.applyEvent(hello({ rooms: [room("room-cos", "cos"), room("room-a", "board")] }));
  store.applyEvent({ type: "message", message: msg({ roomId: "room-a", seq: 1, fromKind: "human", fromId: "part-owner" }) });
  expect(store.getState().unread["room-a"] ?? 0).toBe(0);
});
it("clears a room's badge when it is opened", async () => {
  const { store } = setup();
  store.applyEvent(hello({ rooms: [room("room-cos", "cos"), room("room-a", "board")] }));
  store.applyEvent({ type: "message", message: msg({ roomId: "room-a", seq: 1 }) });
  await store.setActiveRoom("room-a");
  expect(store.getState().unread["room-a"]).toBe(0);
});
it("keeps each room in seq order, and a replayed event neither duplicates a message nor counts it twice", () => {
  const { store } = setup();
  store.applyEvent(hello({ rooms: [room("room-cos", "cos"), room("room-a", "board")] }));
  for (const seq of [3, 1, 2, 3, 1]) store.applyEvent({ type: "message", message: msg({ roomId: "room-a", seq }) });
  expect(seqs(store, "room-a")).toEqual([1, 2, 3]);
  expect(store.getState().unread["room-a"]).toBe(3);
});
it("fills a live gap with beforeSeq", async () => {
  const { store, pages, calls } = await loadedRoomA(seqRange("room-a", 1, 3));
  pages["room-a 7 3"] = seqRange("room-a", 4, 6);
  store.applyEvent({ type: "message", message: msg({ roomId: "room-a", seq: 7 }) });
  await store.whenIdle();
  expect(calls).toEqual([["room-a", { beforeSeq: 7, limit: 3 }]]);
  expect(seqs(store, "room-a")).toEqual([1, 2, 3, 4, 5, 6, 7]);
});
it("refills the rooms it holds on a gap event, paging back to the seq it had", async () => {
  const { store, pages, calls } = await loadedRoomA(seqRange("room-a", 1, 3));
  Object.assign(pages, { "room-a - 100": seqRange("room-a", 150, 249), "room-a 150 100": seqRange("room-a", 50, 149), "room-a 50 46": seqRange("room-a", 4, 49) });
  store.applyEvent({ type: "gap" });
  await store.whenIdle();
  expect(calls).toEqual([["room-a", { limit: 100 }], ["room-a", { beforeSeq: 150, limit: 100 }], ["room-a", { beforeSeq: 50, limit: 46 }]]);
  expect(seqs(store, "room-a")).toEqual(Array.from({ length: 249 }, (_, i) => i + 1));
  expect(store.getState().messages["room-a"].gap).toBeNull();
});
it("stops after five pages and records what is still missing", async () => {
  const { store, pages, calls } = await loadedRoomA(seqRange("room-a", 1, 3));
  pages["room-a - 100"] = seqRange("room-a", 1001, 1100);
  for (const before of [1001, 901, 801, 701, 601]) pages[`room-a ${before} 100`] = seqRange("room-a", before - 100, before - 1);
  store.applyEvent({ type: "gap" });
  await store.whenIdle();
  expect(calls).toHaveLength(6);
  expect(store.getState().messages["room-a"].gap).toEqual({ after: 3, before: 501 });
});
it("refreshes the room list once when events name a room it does not know", async () => {
  const { store, fetchRooms } = setup();
  store.applyEvent(hello({ rooms: [room("room-cos", "cos")] }));
  store.applyEvent({ type: "message", message: msg({ roomId: "room-new", seq: 1 }) });
  store.applyEvent({ type: "message", message: msg({ roomId: "room-new", seq: 2 }) });
  await store.whenIdle();
  expect(fetchRooms).toHaveBeenCalledTimes(1);
  expect(store.getState().rooms["room-new"]?.kind).toBe("instance");
});
it("tracks cooldown, lockdown, questions and step-up prompts", () => {
  const { store } = setup();
  store.applyEvent(hello({ cooldownUntil: "2026-10-25T12:10:00.000Z", lockdown: true }));
  expect([store.getState().cooldownUntil, store.getState().lockdown]).toEqual(["2026-10-25T12:10:00.000Z", true]);
  store.applyEvent({ type: "cooldown", cooldownUntil: "2026-10-25T12:20:00.000Z" });
  store.applyEvent({ type: "lockdown", active: false });
  expect([store.getState().cooldownUntil, store.getState().lockdown]).toEqual(["2026-10-25T12:20:00.000Z", false]);
  store.applyEvent({ type: "question", question: question({ id: "q-1", messageId: "msg-q", state: "proceeded" }) });
  expect(store.getState().questions["msg-q"].state).toBe("proceeded");
  const ev = { type: "stepup", stepUpId: "su-1", command: ["register", "board-a"], expiresAt: "2026-10-25T12:02:00.000Z", code: "482913" } as const;
  store.applyEvent(ev); store.applyEvent(ev);
  expect(store.getState().stepUps).toEqual([{ stepUpId: "su-1", command: ["register", "board-a"], expiresAt: "2026-10-25T12:02:00.000Z", code: "482913" }]);
  store.dismissStepUp("su-1");
  expect(store.getState().stepUps).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/store.test.ts`
Expected: FAIL, `Failed to resolve import "../src/store"`.

- [ ] **Step 3: Implement `createStore` and `useStore` in `src/store.ts`**

Every update returns a new `State` with only the changed slices copied, so `useStore` selectors compare by reference. Every reducer is idempotent, which is how replays are absorbed. The event rules:
- `hello` replaces rooms, instances, resources, actor, `cooldownUntil` (`?? null`) and `lockdown`. If `activeRoomId` is null it opens the first `cos` room. It never refills; `gap` and the stream's resync do that.
- `message` inserts the row only if its id is new (sorted by seq). For a newly inserted row: in a loaded room whose last seq is below `seq - 1`, it queues `fillGap(room, last, seq)`; and it adds 1 to `unread[room]` unless the room is active or `fromKind === "human" && fromId === me.humanId`.
- `question` sets `questions[question.messageId]`. `instance` upserts. `resources` sets the snapshot. `stepup` adds by `stepUpId` (`code ?? null`). `cooldown` and `lockdown` set their fields.
- `gap` calls `refillRooms()`. `decision` changes nothing, because the chief of staff narrates decisions as messages.
- A `message` or `instance` naming an unknown room starts one `fetchRooms()` (none while one is in flight) and merges the result.

Fills for one room run one at a time on a per-room promise chain. Rows a refill or gap fill inserts count as unread under the same rule as events. History and `loadOlder` pages never do.

```ts
async function fillGap(roomId: string, after: number, before: number): Promise<void> {
  let pages = 0;
  while (before - after > 1 && pages < MAX_GAP_PAGES) {
    const page = await deps.fetchMessages(roomId, { beforeSeq: before, limit: Math.min(PAGE, before - after - 1) });
    if (page.length === 0) { before = after + 1; break; }          // nothing exists down there: no gap
    merge(roomId, page, { countUnread: true });
    before = Math.min(...page.map((m) => m.seq));
    pages += 1;
  }
  setGap(roomId, before - after > 1 ? { after, before } : null);
}
async function refillRoom(roomId: string): Promise<void> {          // refillRooms() runs this for each room holding messages
  const last = lastSeq(roomId);
  const page = await deps.fetchMessages(roomId, { limit: PAGE });
  merge(roomId, page, { countUnread: true });
  const oldest = page.length > 0 ? Math.min(...page.map((m) => m.seq)) : last + 1;
  if (oldest > last + 1) await fillGap(roomId, last, oldest);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/store.test.ts`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/store.ts packages/os-web/tests
git commit -m "feat(os-web): message store with idempotent events, unread counts and gap refill"
```

---

### Task 4: The event stream and the client composition

**Files:**
- Create: `packages/os-web/src/stream.ts`, `packages/os-web/src/client.ts`, `packages/os-web/src/context.ts`, `packages/os-web/tests/render.tsx`
- Modify: `packages/os-web/tests/fakes.ts` (`FakeEventSource`, `fakeApi`, `setVisibility`)
- Test: `packages/os-web/tests/stream.test.ts`

**Interfaces:**
- Consumes: `createApi`, `Api`, `ApiError` (Task 2); `createStore`, `Store`, `State`, `useStore` (Task 3); `BrainEvent`, `STREAM_EVENT_TYPES`, `ConnectionStatus` (Task 2).
- Produces:

```ts
// src/stream.ts
export interface BrainStreamLike { connect(): void; close(): void; reconnectNow(): void }
export interface BrainStreamDeps {
  url: string;                                   // "/api/stream?rooms=all"
  onEvent: (event: BrainEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onResync: () => void;                          // the first hello on an EventSource that replaced a failed one
  probeSession: () => Promise<"ok" | "unauthorized" | "offline">;
  EventSourceImpl?: typeof EventSource;          // default globalThis.EventSource
  backoffMs?: (attempt: number) => number;       // after a hard failure; default Math.min(30_000, 1000 * 2 ** attempt)
  staleAfterHiddenMs?: number;                   // 30_000
}
export class BrainStream implements BrainStreamLike { constructor(deps: BrainStreamDeps) }
// src/client.ts
export interface Client { api: Api; store: Store; stream: BrainStreamLike }
export interface ClientDeps { fetch: typeof fetch; EventSourceImpl: typeof EventSource; onUnauthorized: () => void }
export function createClient(deps: ClientDeps): Client;
// src/context.ts
export const ClientContext: React.Context<Client | null>;
export function useClient(): Client;                                    // throws outside a provider
export function useClientState<T>(selector: (s: State) => T): T;
```

Test helpers:
- `FakeEventSource extends EventTarget`, with static `instances`, `last()` and `reset()`; `url`, `init` and `readyState` (0 connecting, 1 open, 2 closed); `onopen` and `onerror`; `close()`; `open()`; `send(event: BrainEvent, id?: number)`, which dispatches `new MessageEvent(event.type, { data: JSON.stringify(<event without type>), lastEventId: String(id ?? "") })`; and `fail(readyState: 0 | 2)`, which sets `readyState` and calls `onerror`. `BrainStream` uses only `addEventListener` for the named events, `onopen`, `onerror`, `readyState` and `close`, so the fake covers it.
- `fakeApi(over?: Partial<Api>)` makes every `Api` method a `vi.fn` with a harmless default: `me` → `me()`, lists → `[]`, `loginVerify`/`registerVerify` → `LOGIN`, `command` → `{ ok: true, text: "" }`.
- `setVisibility(state: "visible" | "hidden")` redefines `document.visibilityState` and dispatches `visibilitychange`.
- `tests/render.tsx`: `renderWithClient(ui, opts?: { api?: Partial<Api>; me?: Me | null; connection?: ConnectionStatus })` builds a real store over `fakeApi` and a no-op stream (`connect`, `close` and `reconnectNow` as `vi.fn`), sets `me` (default `me()`) and `connection` (default `"open"`), wraps `ui` in `ClientContext.Provider`, and returns RTL's result plus `{ client, api, store, stream }`.

- [ ] **Step 1: Write the failing test**

```ts
import { BrainStream, type BrainStreamDeps } from "../src/stream";
import { createClient } from "../src/client";
import { FakeEventSource, fakeFetch, hello, json, me, msg, room, seqRange, seqs, setVisibility } from "./fakes";
import type { BrainEvent, ConnectionStatus } from "../src/types";

const ES = FakeEventSource as unknown as typeof EventSource;
function streamWith(over: Partial<BrainStreamDeps> = {}) {
  const events: BrainEvent[] = []; const statuses: ConnectionStatus[] = []; const onResync = vi.fn(); const probe = vi.fn(async () => "ok" as const);
  const s = new BrainStream({ url: "/api/stream?rooms=all", onEvent: (e) => events.push(e), onStatus: (x) => statuses.push(x), onResync, probeSession: probe, EventSourceImpl: ES, ...over });
  return { s, events, statuses, onResync, probe };
}
const ROOMS = [room("room-cos", "cos"), room("room-a", "board")];
beforeEach(() => { FakeEventSource.reset(); vi.useFakeTimers(); });

it("opens the stream on the same origin with the cookie, and no token in the URL", () => {
  streamWith().s.connect();
  expect(FakeEventSource.last().url).toBe("/api/stream?rooms=all");
  expect(FakeEventSource.last().url).not.toMatch(/sess_|token/);
});
it("hands every named event to onEvent", () => {
  const { s, events, statuses } = streamWith(); s.connect(); const es = FakeEventSource.last(); es.open();
  es.send(hello({ rooms: ROOMS }), 1);
  es.send({ type: "message", message: msg({ roomId: "room-a", seq: 1 }) }, 2);
  es.send({ type: "gap" }, 3);
  expect(events.map((e) => e.type)).toEqual(["hello", "message", "gap"]);
  expect(statuses.at(-1)).toBe("open");
});
it("leaves a dropped connection to the browser's own retry", async () => {
  const { s, statuses, probe } = streamWith(); s.connect(); FakeEventSource.last().open();
  FakeEventSource.last().fail(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(probe).not.toHaveBeenCalled();
  expect(statuses.at(-1)).toBe("connecting");
});
it("replaces a stream that failed for good, with backoff, while the session is still good", async () => {
  const { s, probe } = streamWith(); s.connect(); FakeEventSource.last().open();
  FakeEventSource.last().fail(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(probe).toHaveBeenCalledTimes(1);
});
it("stops for good when the session is gone (Review Focus 2)", async () => {
  const { s, statuses } = streamWith({ probeSession: async () => "unauthorized" }); s.connect(); FakeEventSource.last().open();
  FakeEventSource.last().fail(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(statuses.at(-1)).toBe("unauthorized");
});
it("replaces the stream at once when the page comes back after 30 s hidden", async () => {
  const { s } = streamWith(); s.connect(); FakeEventSource.last().open();
  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(31_000);
  setVisibility("visible");
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(FakeEventSource.instances[0].readyState).toBe(2);
});
it("refills messages by seq when a new stream replaces one that failed", async () => {
  const f = fakeFetch({ "GET /api/me": json(me()), "GET /api/rooms/room-cos/messages?limit=100": json([]), "GET /api/rooms/room-a/messages?limit=100": [json(seqRange("room-a", 1, 3)), json(seqRange("room-a", 2, 6))] });
  const client = createClient({ fetch: f.fn, EventSourceImpl: ES, onUnauthorized: vi.fn() });
  client.stream.connect(); const first = FakeEventSource.last(); first.open(); first.send(hello({ rooms: ROOMS }), 1);
  await client.store.setActiveRoom("room-a");
  expect(seqs(client.store, "room-a")).toEqual([1, 2, 3]);
  first.fail(2);
  await vi.advanceTimersByTimeAsync(1_000);
  const second = FakeEventSource.last(); expect(second).not.toBe(first);
  second.open(); second.send(hello({ rooms: ROOMS }), 1);
  await client.store.whenIdle();
  expect(seqs(client.store, "room-a")).toEqual([1, 2, 3, 4, 5, 6]);
});
it("refills on a gap event and ignores a replayed message", async () => {
  const f = fakeFetch({ "GET /api/rooms/room-cos/messages?limit=100": json([]), "GET /api/rooms/room-a/messages?limit=100": [json(seqRange("room-a", 1, 3)), json(seqRange("room-a", 1, 5))] });
  const client = createClient({ fetch: f.fn, EventSourceImpl: ES, onUnauthorized: vi.fn() });
  client.stream.connect(); const es = FakeEventSource.last(); es.open(); es.send(hello({ rooms: ROOMS }), 1);
  await client.store.setActiveRoom("room-a");
  es.send({ type: "message", message: msg({ roomId: "room-a", seq: 3 }) }, 2);   // already held: a replay
  es.send({ type: "gap" }, 3);
  await client.store.whenIdle();
  expect(seqs(client.store, "room-a")).toEqual([1, 2, 3, 4, 5]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/stream.test.ts`
Expected: FAIL, `Failed to resolve import "../src/stream"`.

- [ ] **Step 3: Implement `BrainStream`, `createClient`, `ClientContext`, `useClient`, `useClientState` and the test helpers**

`BrainStream` works like this:
- `connect()` opens `new EventSourceImpl(url)` (the cookie travels on its own, same origin), reports `"connecting"`, and registers one listener per name in `STREAM_EVENT_TYPES`. Each listener parses `data` (invalid JSON is dropped) and calls `onEvent({ type, ...data })`. `onopen` reports `"open"` and resets the backoff attempt.
- On `onerror` with `readyState` 0, the browser is retrying with `Last-Event-ID`, and the hub will replay or send `gap`, so it reports `"connecting"` and does nothing else.
- On `onerror` with `readyState` 2 (a hard failure, such as a 401), it reports `"closed"` and awaits `probeSession()`. `"unauthorized"` reports that and stops. Anything else opens a new `EventSource` after `backoffMs(attempt++)`, and that instance's first `hello` also calls `onResync()`.
- `visibilitychange` and `online` both act: when the stream is closed, connect now (cancelling a pending backoff); when the page was hidden for more than `staleAfterHiddenMs`, call `reconnectNow()`. `reconnectNow()` closes the current instance and opens a new one, which resyncs.
- `close()` removes the listeners and never reconnects.

`createClient` wires it:
- `api = createApi({ fetch, onUnauthorized, onCooldown: (u) => store.setCooldown(u), onLockdown: () => store.setLockdown(true) })`.
- `store = createStore({ fetchMessages: api.messages, fetchRooms: api.rooms })`.
- `stream = new BrainStream({ url: "/api/stream?rooms=all", EventSourceImpl, onEvent: store.applyEvent, onResync: () => void store.refillRooms(), onStatus, probeSession })`. `onStatus` calls `store.setConnection(s)`, and also `onUnauthorized()` on `"unauthorized"`. `probeSession` maps `api.me()` to `"ok"`, an `ApiError` with status 401 to `"unauthorized"`, and anything else to `"offline"`.

`onUnauthorized` may run twice for one loss (from the probe's 401 and from the status), so callers make it idempotent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/stream.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/stream.ts packages/os-web/src/client.ts packages/os-web/src/context.ts packages/os-web/tests
git commit -m "feat(os-web): brain event stream and client composition"
```

---

### Task 5: Passkey sign-in, device enrolment and the app gate

**Files:**
- Create: `packages/os-web/src/auth/passkeys.ts`, `packages/os-web/src/auth/Login.tsx`, `packages/os-web/src/auth/Enrol.tsx`, `packages/os-web/src/hash.ts`
- Modify: `packages/os-web/src/App.tsx` (replace the placeholder), `packages/os-web/tests/fakes.ts` (`fakePasskeys`, `ATTESTATION`, `ASSERTION`, `appDeps`)
- Test: `packages/os-web/tests/auth.test.tsx`, `packages/os-web/tests/app.test.tsx`

**Interfaces:**
- Consumes: `Api`, `ApiError`, `RegisterOptionsResult`, `LoginResult` (Task 2); `createClient`, `Client`, `ClientContext` (Task 4); contract addition 3 (`#enrol=<code>`).
- Produces:

```ts
// src/auth/passkeys.ts
export interface Passkeys { supported(): boolean; register(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>; authenticate(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> }
export const browserPasskeys: Passkeys;   // browserSupportsWebAuthn(), startRegistration({ optionsJSON }), startAuthentication({ optionsJSON })
// src/hash.ts
export function readHash(hash: string): { enrol: string | null; room: string | null; cliLogin: string | null };   // "#enrol=<code>", "#room=<id>", "#cli-login=<nonce>"
// src/auth/Login.tsx
export function Login(props: { api: Api; passkeys: Passkeys; onSignedIn: (result: LoginResult) => void; onEnrol: () => void }): JSX.Element;
// src/auth/Enrol.tsx: code set means first device (from swarm os init); null means a later device that needs approval
export function Enrol(props: { api: Api; passkeys: Passkeys; code: string | null; onSignedIn: (result: LoginResult) => void; pollMs?: number }): JSX.Element;   // pollMs default 3000
// src/App.tsx
export interface AppDeps { fetch: typeof fetch; EventSourceImpl: typeof EventSource; location: Pick<Location, "hash">; history: Pick<History, "replaceState">; passkeys: Passkeys }
export function browserAppDeps(): AppDeps;
export function App(props: { deps?: AppDeps }): JSX.Element;   // deps default browserAppDeps()
```

Copy, which the tests pin: Login has heading "Swarm OS", button "Sign in with a passkey", text button "Enrol this device", "This browser cannot use passkeys." when unsupported, and "Sign-in failed: <message>". Enrol has heading "Enrol this device" and input "Device name". With a code, its button is "Create passkey". Without one, it is "Request enrolment", followed by "Waiting for approval", "On a device that is already enrolled, run" and the code element `/devices approve <enrolmentId>`, and after approval a "Create passkey" button. A refusal shows "This enrolment was refused or has expired." The WebAuthn call after an approval waits for that tap, because Safari only allows `navigator.credentials.create` inside a user gesture and the approval arrives by polling.

**Terminal sign-in approval (plan 08's `swarm os login`).** A signed-in session opening `/#cli-login=<nonce>` sees heading "Approve a terminal sign-in?", the text "A terminal asked to sign in as you. Approve only if you just ran `swarm os login`.", and buttons "Approve" and "Ignore". Approve posts `POST /api/auth/cli/<nonce>/approve` (`{}`; cookie + `X-Swarm-Os: 1`) and shows "Approved. Go back to the terminal."; a 404 or 410 shows "This sign-in request has expired." Test (`approves a terminal sign-in from the fragment`): with `location.hash = "#cli-login=n-1"` and a signed-in `/api/me`, clicking "Approve" calls `api.approveCliLogin("n-1")` once and shows the success text; `readHash("#cli-login=n-1")` returns `{ enrol: null, room: null, cliLogin: "n-1" }`. `Api` gains `approveCliLogin(nonce: string): Promise<void>` in Task 2's interface.

- [ ] **Step 1: Write the failing tests**

`tests/auth.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Login } from "../src/auth/Login";
import { Enrol } from "../src/auth/Enrol";
import { ApiError } from "../src/api";
import { ASSERTION, ATTESTATION, fakeApi, fakePasskeys, LOGIN } from "./fakes";

it("signs in with a passkey", async () => {
  const api = fakeApi({ loginOptions: vi.fn(async () => ({ challenge: "c1" }) as never) });
  const passkeys = fakePasskeys(); const onSignedIn = vi.fn();
  render(<Login api={api} passkeys={passkeys} onSignedIn={onSignedIn} onEnrol={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
  expect(passkeys.authenticate).toHaveBeenCalledWith({ challenge: "c1" });
  expect(api.loginVerify).toHaveBeenCalledWith(ASSERTION);
  expect(onSignedIn).toHaveBeenCalledWith(LOGIN);
});
it("says when the browser cannot use passkeys", () => {
  render(<Login api={fakeApi()} passkeys={fakePasskeys({ supported: () => false })} onSignedIn={vi.fn()} onEnrol={() => {}} />);
  expect(screen.getByText("This browser cannot use passkeys.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
});
it("enrols the first device with the code from swarm os init", async () => {
  const api = fakeApi({ registerOptions: vi.fn(async () => ({ state: "ready", enrolmentId: "enr-1", options: { challenge: "c" } }) as never) });
  const passkeys = fakePasskeys(); const onSignedIn = vi.fn();
  render(<Enrol api={api} passkeys={passkeys} code="code-123" onSignedIn={onSignedIn} />);
  await userEvent.type(screen.getByLabelText("Device name"), "phone-a");
  await userEvent.click(screen.getByRole("button", { name: "Create passkey" }));
  expect(api.registerOptions).toHaveBeenCalledWith({ enrolment: "code-123", deviceName: "phone-a" });
  expect(passkeys.register).toHaveBeenCalledWith({ challenge: "c" });
  expect(api.registerVerify).toHaveBeenCalledWith("enr-1", ATTESTATION);
  expect(onSignedIn).toHaveBeenCalledWith(LOGIN);
});
it("waits for an existing device to approve a later device", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const registerOptions = vi.fn()
    .mockResolvedValueOnce({ state: "pending", enrolmentId: "enr-2" })
    .mockResolvedValueOnce({ state: "pending", enrolmentId: "enr-2" })
    .mockResolvedValue({ state: "ready", enrolmentId: "enr-2", options: { challenge: "c2" } });
  const api = fakeApi({ registerOptions }); const onSignedIn = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<Enrol api={api} passkeys={fakePasskeys()} code={null} onSignedIn={onSignedIn} pollMs={3000} />);
  await user.type(screen.getByLabelText("Device name"), "laptop-b");
  await user.click(screen.getByRole("button", { name: "Request enrolment" }));
  expect(await screen.findByText("Waiting for approval")).toBeInTheDocument();
  expect(screen.getByText("/devices approve enr-2")).toBeInTheDocument();
  expect(registerOptions).toHaveBeenNthCalledWith(1, { deviceName: "laptop-b" });
  await vi.advanceTimersByTimeAsync(3000);
  expect(registerOptions).toHaveBeenNthCalledWith(2, { deviceName: "laptop-b", enrolmentId: "enr-2" });
  await vi.advanceTimersByTimeAsync(3000);
  await user.click(await screen.findByRole("button", { name: "Create passkey" }));
  await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(LOGIN));
  expect(api.registerVerify).toHaveBeenCalledWith("enr-2", ATTESTATION);
});
it("says when an enrolment is refused or has expired", async () => {
  const api = fakeApi({ registerOptions: vi.fn(async () => { throw new ApiError(403, "forbidden", "Refused"); }) });
  render(<Enrol api={api} passkeys={fakePasskeys()} code={null} onSignedIn={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Device name"), "laptop-b");
  await userEvent.click(screen.getByRole("button", { name: "Request enrolment" }));
  expect(await screen.findByText("This enrolment was refused or has expired.")).toBeInTheDocument();
});
```

`tests/app.test.tsx`. `appDeps(opts?: { hash?: string; routes?: Parameters<typeof fakeFetch>[0] })` returns `AppDeps` over `fakeFetch(routes)`, `FakeEventSource`, `{ hash }`, `{ replaceState: vi.fn() }` and `fakePasskeys()`.

```tsx
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { appDeps, FakeEventSource, json, LOGIN, me } from "./fakes";

const SIGNED_OUT = json({ error: { code: "unauthenticated", message: "Signed out" } }, 401);
beforeEach(() => FakeEventSource.reset());

it("opens enrolment from the init link and takes the code out of the address bar", () => {
  const deps = appDeps({ hash: "#enrol=code-123" });
  render(<App deps={deps} />);
  expect(screen.getByRole("heading", { name: "Enrol this device" })).toBeInTheDocument();
  expect(deps.history.replaceState).toHaveBeenCalledWith(null, "", "/");
});
it("signs in with the cookie and keeps no token anywhere", async () => {
  render(<App deps={appDeps({ routes: { "GET /api/me": [SIGNED_OUT, json(me())], "POST /api/auth/login/options": json({ challenge: "c1" }), "POST /api/auth/login/verify": json({ ...LOGIN, token: "sess_should_not_be_kept" }) } })} />);
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
  expect(await screen.findByText("Signed in as owner")).toBeInTheDocument();
  expect(FakeEventSource.last().url).toBe("/api/stream?rooms=all");
  expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
});
it("goes back to sign-in when the brain says the session is gone (Review Focus 2)", async () => {
  render(<App deps={appDeps({ routes: { "GET /api/me": [json(me()), SIGNED_OUT] } })} />);
  expect(await screen.findByText("Signed in as owner")).toBeInTheDocument();
  act(() => FakeEventSource.last().fail(2));
  expect(await screen.findByRole("button", { name: "Sign in with a passkey" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/auth.test.tsx tests/app.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/auth/Login"`; the App tests fail on the missing heading.

- [ ] **Step 3: Implement `passkeys.ts`, `hash.ts`, `Login`, `Enrol` and `App`**

`App` reads `readHash(deps.location.hash)` once on mount. With an `enrol` code it calls `deps.history.replaceState(null, "", "/")` straight away, because the code is a bootstrap secret, and shows `Enrol`. Otherwise it creates a `Client` with `createClient({ fetch, EventSourceImpl, onUnauthorized })` and asks `client.api.me()` once, on mount: a `Me` means `connected`, a 401 means `login`, and while it waits the screen reads "Connecting to the brain…". Swapping the `Client` never re-runs this probe. Login's "Enrol this device" opens `Enrol` with `code={null}`. `onSignedIn` asks `api.me()` again and switches to `connected`. `Connected` calls `store.setMe(me)`, calls `stream.connect()` on mount and `stream.close()` on unmount, and renders `Signed in as {me.name}` inside `ClientContext.Provider` (Task 10 renders `Layout` here). `onUnauthorized` is idempotent: it closes the stream, replaces the `Client` with a fresh one so nothing from the old session stays in memory, and shows `login`. `Enrol` polls with `setTimeout(pollMs)` only while it is pending, stops on unmount, and maps an `ApiError` with status 403 or 410 to the refusal copy. `browserAppDeps()` returns `{ fetch: window.fetch.bind(window), EventSourceImpl: window.EventSource, location: window.location, history: window.history, passkeys: browserPasskeys }`, so `src/api.ts` stays the only module that calls `fetch(`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/auth.test.tsx tests/app.test.tsx`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/auth packages/os-web/src/hash.ts packages/os-web/src/App.tsx packages/os-web/tests
git commit -m "feat(os-web): passkey sign-in and device enrolment"
```

---

### Task 6: The chat: message kinds, provenance and answering questions

**Files:**
- Create: `packages/os-web/src/messages.ts`, `packages/os-web/src/components/Chat.tsx`, `packages/os-web/src/components/MessageItem.tsx`, `packages/os-web/src/components/QuestionBox.tsx`
- Modify: `packages/os-web/src/app.css` (`.chat`, `.msg`, `.msg-<kind>`, `.prov`, `.question-box`)
- Test: `packages/os-web/tests/chat.test.tsx`

**Interfaces:**
- Consumes: `useClient`, `useClientState` (Task 4); `State.messages`, `State.questions`, `Store.loadOlder`, `Store.loadGap` (Task 3); `Api.answer` and `ApiError` (Task 2); `QuestionData`, `CommandData`, `Provenance` and `QuestionRow` (Task 2); the plan-05 `dataJson` and `replyTo` shapes under **Contracts this plan consumes**.
- Produces:

```ts
// src/messages.ts
export function parseData<T>(row: MessageRow): T | null;                         // JSON.parse(row.dataJson), null on null or invalid
export function provenanceLabel(row: MessageRow, me: Me | null): string;        // "you" | "owner" | "chief of staff" | "worker" | …, plus " · via <source>" when the provenance source is not the sender's own
export function answerFor(question: MessageRow, rows: MessageRow[]): MessageRow | null;   // first kind "answer" with replyTo === question.id
// components
export function Chat(props: { roomId: string }): JSX.Element;
export function MessageItem(props: { message: MessageRow; answer: MessageRow | null; question: QuestionRow | null; me: Me | null; onAnswer: (questionId: string, body: string) => Promise<void> }): JSX.Element;
export function QuestionBox(props: { questionId: string; options: string[]; onAnswer: (questionId: string, body: string) => Promise<void> }): JSX.Element;
```

Each kind renders as follows; bodies are always text in a `white-space: pre-wrap` element.
- `text`, `answer` and `file`: the body.
- `command`: the body in `.mono`, then `data.result` as "✓ <text>" (`.tone-success`) or "✗ <text>" (`.tone-failure`), or "running…" (`.tone-active`) with no result yet.
- `question`: the body. Its id is `question?.id ?? data.questionId`. It is answered when `question.state === "answered"`, or, with no `QuestionRow` held (history loaded over REST), when `answerFor` finds an answer. Answered shows "Answered: <answer body>", or "Answered." when the body is not held. Otherwise, when `data.to !== "cos"` and an id is known, it shows a `QuestionBox`: textarea labelled "Your answer", button "Answer", and one button per option, which answers with that option. A `proceeded` question adds "The worker went ahead with: <proceededWith ?? "its best reading">." above the box, and a late answer is still allowed.
- `event`: a disclosure button showing the body's first line, cut to 120 characters, with `aria-expanded="false"`. Expanded, it shows the full body and the pretty-printed `dataJson`.
- `system`: centred `.tone-dim` text.
- Each message carries a `.prov` label from `provenanceLabel`, where the natural sources are `human`: `owner|human`, `cos`: `cos`, and every other kind its own name.

The `Chat` shell: a "Load older messages" button (`store.loadOlder`) while `!complete`; "Some messages are not loaded." with a "Load them" button (`store.loadGap`) while `gap`; and scroll pinned to the newest message when the reader was already at the bottom. A failed answer leaves the text in place and shows `role="alert"` "Not sent: <message>".

- [ ] **Step 1: Write the failing test**

```tsx
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "../src/components/Chat";
import { ApiError } from "../src/api";
import { msg, question } from "./fakes";
import { renderWithClient } from "./render";
import type { MessageRow } from "../src/types";

async function renderChat(rows: MessageRow[], api = {}) {
  const r = renderWithClient(<Chat roomId="room-a" />, { api: { messages: vi.fn(async () => rows), ...api } });
  await act(() => r.store.setActiveRoom("room-a"));
  return r;
}
const ask = (over: Partial<MessageRow> = {}) => msg({ roomId: "room-a", seq: 1, id: "msg-q", kind: "question", fromKind: "worker", fromId: "part-w1", body: "Which schema should the migration use?", dataJson: JSON.stringify({ questionId: "q-1" }), provenanceJson: '{"source":"worker"}', ...over });

it("shows an answer box for a question to a human and posts the answer", async () => {
  const { api } = await renderChat([ask()]);
  await userEvent.type(screen.getByLabelText("Your answer"), "Use v2");
  await userEvent.click(screen.getByRole("button", { name: "Answer" }));
  expect(api.answer).toHaveBeenCalledWith("q-1", "Use v2");
});
it("hides the box once the room holds an answer to that question", async () => {
  await renderChat([ask(), msg({ roomId: "room-a", seq: 2, kind: "answer", fromKind: "human", fromId: "part-owner", replyTo: "msg-q", body: "Use v2" })]);
  expect(screen.queryByLabelText("Your answer")).toBeNull();
  expect(screen.getByText("Answered: Use v2")).toBeInTheDocument();
});
it("hides the box when a question event says it was answered", async () => {
  const { store } = await renderChat([ask()]);
  act(() => store.applyEvent({ type: "question", question: question({ id: "q-1", messageId: "msg-q", state: "answered" }) }));
  expect(screen.queryByLabelText("Your answer")).toBeNull();
  expect(screen.getByText("Answered.")).toBeInTheDocument();
});
it("says what the worker went ahead with, and still takes a late answer", async () => {
  const { store } = await renderChat([ask()]);
  act(() => store.applyEvent({ type: "question", question: question({ id: "q-1", messageId: "msg-q", state: "proceeded", proceededWith: "use the v1 schema" }) }));
  expect(screen.getByText("The worker went ahead with: use the v1 schema.")).toBeInTheDocument();
  expect(screen.getByLabelText("Your answer")).toBeInTheDocument();
});
it("offers no answer box for a question addressed to the chief of staff", async () => {
  await renderChat([ask({ dataJson: JSON.stringify({ questionId: "q-1", to: "cos" }) })]);
  expect(screen.queryByLabelText("Your answer")).toBeNull();
});
it("keeps the typed answer when the brain cannot be reached", async () => {
  await renderChat([ask()], { answer: vi.fn(async () => { throw new ApiError(0, "network", "Failed to fetch"); }) });
  await userEvent.type(screen.getByLabelText("Your answer"), "Use v2");
  await userEvent.click(screen.getByRole("button", { name: "Answer" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not sent: Failed to fetch");
  expect(screen.getByLabelText("Your answer")).toHaveValue("Use v2");
});
it("renders bodies as text, never HTML (Review Focus 3)", async () => {
  const { container } = await renderChat([msg({ roomId: "room-a", seq: 1, body: '<img src=x onerror="alert(1)">' })]);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
});
it("collapses events by default", async () => {
  await renderChat([msg({ roomId: "room-a", seq: 1, kind: "event", fromKind: "instance", body: "task:started\ntask-3 build the parser" })]);
  const toggle = screen.getByRole("button", { name: /task:started/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/task-3 build the parser/)).toBeNull();
  await userEvent.click(toggle);
  expect(screen.getByText(/task-3 build the parser/)).toBeInTheDocument();
});
it("shows a command with its audit result", async () => {
  await renderChat([msg({ roomId: "room-a", seq: 1, kind: "command", fromKind: "human", fromId: "part-owner", body: "/pause board board-a", dataJson: JSON.stringify({ argv: ["pause", "board", "board-a"], result: { ok: true, text: "Paused board-a" } }) })]);
  expect(screen.getByText("/pause board board-a")).toHaveClass("mono");
  expect(screen.getByText("✓ Paused board-a")).toHaveClass("tone-success");
});
it("labels where a message came from", async () => {
  await renderChat([msg({ roomId: "room-a", seq: 1, fromKind: "worker", fromId: "part-w1", provenanceJson: '{"source":"card"}' }), msg({ roomId: "room-a", seq: 2, fromKind: "human", fromId: "part-owner", provenanceJson: '{"source":"owner"}' })]);
  expect(screen.getAllByTestId("prov").map((e) => e.textContent)).toEqual(["worker · via card", "you"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/chat.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/components/Chat"`.

- [ ] **Step 3: Implement `messages.ts`, `Chat`, `MessageItem` and `QuestionBox`**

`Chat` selects `messages[roomId]`, `questions` and `me`, and passes `onAnswer = (questionId, body) => api.answer(questionId, body).then(() => undefined)`. The answer reaches the room through the stream like any other message. The `.prov` label element carries `data-testid="prov"`. Nothing in `src/` uses `dangerouslySetInnerHTML`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/chat.test.tsx`
Expected: PASS, `Tests  10 passed (10)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build && grep -rn "dangerouslySetInnerHTML" packages/os-web/src`
Expected: every task successful; the grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/messages.ts packages/os-web/src/components packages/os-web/src/app.css packages/os-web/tests/chat.test.tsx
git commit -m "feat(os-web): chat with message kinds, provenance and question answers"
```

---

### Task 7: The command bar: completion, idempotent sends and step-up codes

**Files:**
- Create: `packages/os-web/src/argv.ts`, `packages/os-web/src/components/CommandBar.tsx`
- Modify: `packages/os-web/src/app.css` (`.command-bar`, `.completions`)
- Test: `packages/os-web/tests/argv.test.ts`, `packages/os-web/tests/command-bar.test.tsx`

**Interfaces:**
- Consumes: `useClient`, `useClientState` (Task 4); `State.commands`, `State.me` (Task 3); `Api.command`, `Api.postMessage`, `newIdempotencyKey`, `ApiError` (Task 2); `GET /api/commands` (plan 05), which Task 10 loads into the store.
- Produces:

```ts
export function splitArgv(input: string): string[];   // whitespace-separated; "double quotes" group; an unterminated quote runs to the end
export function completions(input: string, commands: CommandListing[], max?: number): CommandListing[];   // input starts with "/": prefix match of "/" + name; max 8
export function CommandBar(props: { roomId: string }): JSX.Element;
```

Behaviour and copy:
- The bar is an `<input aria-label="Message or /command">`.
- A value starting with `/` opens a `role="listbox"` of `role="option"` rows: `/<name>`, a "step-up" badge for `standing`, and the summary. While the list is open, Tab or Enter completes the highlighted option (the first, unless ArrowUp or ArrowDown moved it) to `/<name> `, and Escape closes the list. With the list closed, Enter submits.
- Submitting takes a fresh `newIdempotencyKey()` and keeps it until that text is sent or changed. A value starting with `/` goes to `api.command({ room: roomId, argv: splitArgv(value.slice(1)) }, key)`, anything else to `api.postMessage(roomId, { body: value }, key)`, both trimmed; empty sends nothing.
- Success with `ok` clears the value. A `CommandResult` with `ok: false` shows `role="alert"` with its `text` and keeps the value.
- A 428 `stepup_required` shows "This command needs a confirmation code from the host or a confirmer device." When `me.confirmer`, it also shows `<input aria-label="Confirmation code" inputMode="numeric">` and a "Run with code" button, which calls `api.command({ room, argv, stepUpId: error.details.stepUpId, code }, newIdempotencyKey())`.
- A network failure (status 0) shows `role="alert"` "Not sent: <message>" with a "Retry" button, which resends with the same key. Any other error shows "Not sent: <message>". In both cases the value stays.
- A 429 `cooldown` and a 403 `lockdown` add nothing here: `api.ts` has already updated the store, and Task 9's banner explains.

- [ ] **Step 1: Write the failing tests**

`tests/argv.test.ts`:

```ts
import { splitArgv } from "../src/argv";
it("splits on whitespace and keeps double-quoted text together", () => {
  expect(splitArgv('say board-a "hello there"')).toEqual(["say", "board-a", "hello there"]);
  expect(splitArgv("  pause   board board-a ")).toEqual(["pause", "board", "board-a"]);
  expect(splitArgv('say board-a "unterminated quote')).toEqual(["say", "board-a", "unterminated quote"]);
});
```

`tests/command-bar.test.tsx`:

```tsx
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandBar } from "../src/components/CommandBar";
import { ApiError } from "../src/api";
import { me } from "./fakes";
import { renderWithClient } from "./render";
import type { CommandListing } from "../src/types";

const COMMANDS: CommandListing[] = [
  { name: "pause board", kind: "operating", summary: "Stop dispatching from a board" },
  { name: "pause run", kind: "operating", summary: "Pause a run gracefully" },
  { name: "register", kind: "standing", summary: "Register a board to a project" },
  { name: "top", kind: "query", summary: "Resources and instances" },
];
function setup(opts: Parameters<typeof renderWithClient>[1] = {}, commands = COMMANDS) {
  const r = renderWithClient(<CommandBar roomId="room-cos" />, opts);
  act(() => r.store.setCommands(commands));
  return { ...r, input: screen.getByLabelText("Message or /command") };
}
const STEPUP = new ApiError(428, "stepup_required", "Needs a code", { stepUpId: "su-1" });

it("completes commands from the brain's list after a slash", async () => {
  const { input } = setup();
  await userEvent.type(input, "/pa");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("/pause board"), expect.stringContaining("/pause run")]);
  await userEvent.keyboard("{Tab}");
  expect(input).toHaveValue("/pause board ");
});
it("marks standing commands as needing a step-up code", async () => {
  const { input } = setup();
  await userEvent.type(input, "/reg");
  expect(screen.getByRole("option")).toHaveTextContent("step-up");
});
it("posts a slash command with its argv and an Idempotency-Key", async () => {
  const { input, api } = setup();
  await userEvent.type(input, "/pause board board-a{Enter}");
  expect(api.command).toHaveBeenCalledWith({ room: "room-cos", argv: ["pause", "board", "board-a"] }, expect.any(String));
  expect(input).toHaveValue("");
});
it("posts plain text as a message", async () => {
  const { input, api } = setup();
  await userEvent.type(input, "what's running?{Enter}");
  expect(api.postMessage).toHaveBeenCalledWith("room-cos", { body: "what's running?" }, expect.any(String));
});
it("on a confirmer device, takes the code and re-posts with stepUpId and code", async () => {
  const command = vi.fn().mockRejectedValueOnce(STEPUP).mockResolvedValue({ ok: true, text: "Registered board-a" });
  const { input } = setup({ api: { command }, me: me({ confirmer: true }) });
  await userEvent.type(input, "/register board-a{Enter}");
  expect(await screen.findByText("This command needs a confirmation code from the host or a confirmer device.")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Confirmation code"), "482913");
  await userEvent.click(screen.getByRole("button", { name: "Run with code" }));
  expect(command).toHaveBeenLastCalledWith({ room: "room-cos", argv: ["register", "board-a"], stepUpId: "su-1", code: "482913" }, expect.any(String));
});
it("on a device that is not a confirmer, says where the code comes from and asks for none", async () => {
  const { input } = setup({ api: { command: vi.fn().mockRejectedValue(STEPUP) }, me: me({ confirmer: false }) });
  await userEvent.type(input, "/register board-a{Enter}");
  expect(await screen.findByText("This command needs a confirmation code from the host or a confirmer device.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Confirmation code")).toBeNull();
});
it("retries a failed send with the same Idempotency-Key (Review Focus 1)", async () => {
  const postMessage = vi.fn().mockRejectedValueOnce(new ApiError(0, "network", "Failed to fetch")).mockResolvedValue(undefined);
  const { input } = setup({ api: { postMessage } });
  await userEvent.type(input, "take BUG-12 anyway{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Not sent: Failed to fetch");
  expect(input).toHaveValue("take BUG-12 anyway");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(postMessage).toHaveBeenCalledTimes(2);
  expect(postMessage.mock.calls[1][2]).toBe(postMessage.mock.calls[0][2]);
  expect(input).toHaveValue("");
});
it("still sends when the command list could not be loaded", async () => {
  const { input, api } = setup({}, []);
  await userEvent.type(input, "/top{Enter}");
  expect(api.command).toHaveBeenCalledWith({ room: "room-cos", argv: ["top"] }, expect.any(String));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/argv.test.ts tests/command-bar.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/argv"`.

- [ ] **Step 3: Implement `splitArgv`, `completions` and `CommandBar`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/argv.test.ts tests/command-bar.test.tsx`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/argv.ts packages/os-web/src/components/CommandBar.tsx packages/os-web/src/app.css packages/os-web/tests/argv.test.ts packages/os-web/tests/command-bar.test.tsx
git commit -m "feat(os-web): command bar with completion, idempotent sends and step-up codes"
```

---

### Task 8: Instance cards and the resource line

**Files:**
- Create: `packages/os-web/src/format.ts`, `packages/os-web/src/url.ts`, `packages/os-web/src/hooks.ts`, `packages/os-web/src/components/Instances.tsx`, `packages/os-web/src/components/Resources.tsx`
- Modify: `packages/os-web/src/app.css` (`.instances`, `.instance-card`, `.resources`)
- Test: `packages/os-web/tests/format.test.ts`, `packages/os-web/tests/instances.test.tsx`

**Interfaces:**
- Consumes: `State.instances`, `State.rooms`, `Store.setActiveRoom` (Task 3); `LIVE_STATES`, `InstanceRow`, `ResourceSnapshot` (Task 2); contract addition 4.
- Produces:

```ts
// src/format.ts
export function formatTokens(n: number): string;                      // the rules of dashboard/src/tokens.js: 950, 12.3k, 1.14M; missing, NaN or negative → "0"
export function formatElapsed(ms: number): string;                    // "45s" | "12m" | "1h 05m" | "2d 3h"
export function formatAgo(iso: string | null, nowMs: number): string; // "never" | "just now" (< 5 s) | "12s ago" | "3m ago" | "2h ago" | "4d ago"
// src/url.ts
export function safeHttpUrl(url: string | null | undefined): string | null;   // url when new URL(url).protocol is "http:" or "https:", else null
// src/hooks.ts
export function useNow(intervalMs: number, active?: boolean): number;         // Date.now(), re-rendered every intervalMs while active (default true)
// components
export function Instances(): JSX.Element;                                     // LIVE_STATES only, newest startedAt first; a card click opens its room
export function Resources(props: { snapshot: ResourceSnapshot | null }): JSX.Element;
```

An instance card is `<article aria-label="Instance <cardId>">`. It holds: title `rooms[roomId]?.name ?? "card <cardId>"`; `card <cardId>`; `projectName`, `phase` and `currentTask`, each "—" when absent; tokens via `formatTokens` (`.mono .tone-progress`); elapsed since `startedAt`; heartbeat via `formatAgo`, `.tone-progress` when older than 30 s; a state badge (`unresponsive` in `.tone-failure`, `running` and `dispatching` in `.tone-active`); and a "Run dashboard" link (`target="_blank" rel="noopener noreferrer"`) only when `safeHttpUrl(dashboardUrl)` is not null. With no live instances it shows "No runs in flight." The resource line reads `<host> · load <cpuLoad1 to 2 dp>/<cpus> · <memFree GB to 1 dp>/<memTotal GB to 1 dp> GB free · <instancesRunning> running · <claudeSessions> sessions · <formatTokens(sum of tokensThisHour)> tokens this hour`, with a `<details>` "Details" listing tokens per project (largest first) and ports in use. With no snapshot it reads "No resource report yet."

- [ ] **Step 1: Write the failing tests**

`tests/format.test.ts`:

```ts
import { formatAgo, formatElapsed, formatTokens } from "../src/format";
import { safeHttpUrl } from "../src/url";

it("formats tokens like the run dashboard", () => {
  expect([950, 12_345, 1_140_000, -1, Number.NaN].map((n) => formatTokens(n))).toEqual(["950", "12.3k", "1.14M", "0", "0"]);
});
it("formats elapsed time and heartbeat age", () => {
  expect([45_000, 12 * 60_000, 65 * 60_000, 51 * 3_600_000].map((n) => formatElapsed(n))).toEqual(["45s", "12m", "1h 05m", "2d 3h"]);
  const now = Date.parse("2026-10-25T12:00:00Z");
  expect([null, "2026-10-25T11:59:58Z", "2026-10-25T11:59:48Z", "2026-10-25T11:57:00Z"].map((t) => formatAgo(t, now))).toEqual(["never", "just now", "12s ago", "3m ago"]);
});
it("only links http and https URLs (Review Focus 3)", () => {
  expect(safeHttpUrl("http://127.0.0.1:3141/")).toBe("http://127.0.0.1:3141/");
  expect(safeHttpUrl("https://brain.example.test/run")).toBe("https://brain.example.test/run");
  expect(["javascript:alert(1)", "data:text/html,<p>x</p>", "not a url", null].map((u) => safeHttpUrl(u))).toEqual([null, null, null, null]);
});
```

`tests/instances.test.tsx`:

```tsx
import { act, render, screen, within } from "@testing-library/react";
import { Instances } from "../src/components/Instances";
import { Resources } from "../src/components/Resources";
import { hello, instance, room, snapshot } from "./fakes";
import { renderWithClient } from "./render";
import type { InstanceRow } from "../src/types";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-25T12:00:00Z")); });
function renderInstances(instances: InstanceRow[]) {
  const r = renderWithClient(<Instances />);
  act(() => r.store.applyEvent(hello({ rooms: [room("room-i1", "instance", { name: "project-a · card 42" })], instances })));
  return r;
}

it("shows a live instance's card, project, phase, task, tokens, elapsed and heartbeat", () => {
  renderInstances([instance({ roomId: "room-i1", cardId: "42", tokens: 1_140_000, startedAt: "2026-10-25T10:55:00Z", lastHeartbeatAt: "2026-10-25T11:59:48Z", phase: "build", currentTask: "task-3", projectName: "project-a", dashboardUrl: "http://127.0.0.1:3141/" })]);
  const card = screen.getByRole("article", { name: "Instance 42" });
  for (const text of ["project-a · card 42", "card 42", "project-a", "build", "task-3", "1.14M", "1h 05m", "12s ago"]) expect(within(card).getByText(text)).toBeInTheDocument();
  expect(within(card).getByRole("link", { name: "Run dashboard" })).toHaveAttribute("href", "http://127.0.0.1:3141/");
});
it("renders no link for a javascript: dashboard URL (Review Focus 3)", () => {
  renderInstances([instance({ cardId: "42", dashboardUrl: "javascript:alert(1)" })]);
  expect(screen.queryByRole("link", { name: "Run dashboard" })).toBeNull();
});
it("leaves out instances that have ended", () => {
  renderInstances([instance({ id: "inst-1", cardId: "41", state: "exited" }), instance({ id: "inst-2", cardId: "42", state: "running" })]);
  expect(screen.queryByRole("article", { name: "Instance 41" })).toBeNull();
  expect(screen.getByRole("article", { name: "Instance 42" })).toBeInTheDocument();
});
it("marks an unresponsive instance", () => {
  renderInstances([instance({ cardId: "42", state: "unresponsive" })]);
  expect(screen.getByText("unresponsive")).toHaveClass("tone-failure");
});
it("summarises the resource snapshot on one line", () => {
  render(<Resources snapshot={snapshot({ host: "host-a", cpuLoad1: 1.2, cpus: 8, memFreeMb: 6246, memTotalMb: 16384, instancesRunning: 2, claudeSessions: 3, tokensThisHour: { "project-a": 1_000_000, "project-b": 140_000 } })} />);
  expect(screen.getByText("host-a · load 1.20/8 · 6.1/16.0 GB free · 2 running · 3 sessions · 1.14M tokens this hour")).toBeInTheDocument();
});
```

The `instance()` fixture defaults to `{ id: "inst-1", registrationId: "reg-1", boardId: "board-a", cardId: "42", runId: null, state: "running", host: "host-a", roomId: "room-i1", startedAt: "2026-10-25T11:00:00Z", lastHeartbeatAt: null, endedAt: null, exitReason: null, dashboardUrl: null, tokens: 0 }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/format.test.ts tests/instances.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/format"`.

- [ ] **Step 3: Implement `format.ts`, `url.ts`, `hooks.ts`, `Instances` and `Resources`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/format.test.ts tests/instances.test.tsx`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/format.ts packages/os-web/src/url.ts packages/os-web/src/hooks.ts packages/os-web/src/components/Instances.tsx packages/os-web/src/components/Resources.tsx packages/os-web/src/app.css packages/os-web/tests
git commit -m "feat(os-web): instance cards and the resource line"
```

---

### Task 9: Step-up prompts for confirmers, and the cooldown and lockdown banner

**Files:**
- Create: `packages/os-web/src/components/StepUpPrompt.tsx`, `packages/os-web/src/components/CooldownBanner.tsx`
- Modify: `packages/os-web/src/format.ts` (`formatCountdown`, `formatClock`), `packages/os-web/src/components/CommandBar.tsx` (disabled during a cooldown or lockdown), `packages/os-web/src/app.css`
- Test: `packages/os-web/tests/stepup-cooldown.test.tsx`

**Interfaces:**
- Consumes: `State.stepUps`, `State.cooldownUntil`, `State.lockdown`, `State.me`, `Store.dismissStepUp` (Task 3); `Api.confirmStepUp` (Task 2); `useNow` (Task 8); `CommandBar` (Task 7); contract addition 1 (`code` in the `stepup` event).
- Produces:

```ts
export function formatCountdown(ms: number): string;   // "m:ss" from Math.ceil(ms / 1000) seconds; negative → "0:00"
export function formatClock(iso: string): string;       // local 24-hour "HH:MM" (Intl.DateTimeFormat, hourCycle "h23")
export function isCoolingDown(cooldownUntil: string | null, nowMs: number): boolean;
export function StepUpPrompt(): JSX.Element | null;      // unexpired prompts, and only when me.confirmer
export function CooldownBanner(): JSX.Element | null;    // lockdown takes precedence over cooldown
```

Copy:
- Each prompt is `role="alertdialog"`, named "Confirm a standing command", showing `/<argv joined by spaces>` in `.mono` and `expires in <m:ss>`.
- With `code`, the prompt shows the code in large `.mono` and reads "Type this code into the device that sent the command or into `swarm os confirm` on the host, or confirm here."
- Without `code` (the overview's event as written), it shows `<input aria-label="Confirmation code" inputMode="numeric">` and reads "Enter the code shown on the host to confirm."
- Its buttons are "Confirm", which calls `api.confirmStepUp(stepUpId, code)` and then `dismissStepUp` (a failure shows `role="alert"` "Not confirmed: <message>"), and "Dismiss".
- The banner is `role="status"`. In a lockdown it reads "The brain is in lockdown. Commands are refused until the host lifts it." and `CommandBar` is disabled with placeholder "Lockdown: commands are refused". During a cooldown it reads "Commands from this session are paused until <HH:MM> (<m:ss> left). Every owner has been told." and `CommandBar` is disabled with placeholder `Paused until <HH:MM>`.

- [ ] **Step 1: Write the failing test**

```tsx
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepUpPrompt } from "../src/components/StepUpPrompt";
import { CooldownBanner } from "../src/components/CooldownBanner";
import { CommandBar } from "../src/components/CommandBar";
import { formatClock, formatCountdown } from "../src/format";
import { hello, me } from "./fakes";
import { renderWithClient } from "./render";

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-10-25T12:00:00Z")); });
const STEPUP = { type: "stepup", stepUpId: "su-1", command: ["register", "board-a"], expiresAt: "2026-10-25T12:02:00.000Z", code: "482913" } as const;
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

it("shows the step-up code on a confirmer device", () => {
  const { store } = renderWithClient(<StepUpPrompt />, { me: me({ confirmer: true }) });
  act(() => store.applyEvent(STEPUP));
  const dialog = screen.getByRole("alertdialog", { name: "Confirm a standing command" });
  for (const text of ["482913", "/register board-a", "expires in 2:00"]) expect(within(dialog).getByText(text)).toBeInTheDocument();
});
it("confirms from this device with POST /api/stepup/confirm", async () => {
  const { store, api } = renderWithClient(<StepUpPrompt />, { me: me({ confirmer: true }) });
  act(() => store.applyEvent(STEPUP));
  await user().click(screen.getByRole("button", { name: "Confirm" }));
  expect(api.confirmStepUp).toHaveBeenCalledWith("su-1", "482913");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
it("asks for the code when the event carries none", async () => {
  const { store, api } = renderWithClient(<StepUpPrompt />, { me: me({ confirmer: true }) });
  const { code: _code, ...withoutCode } = STEPUP;
  act(() => store.applyEvent(withoutCode));
  await user().type(screen.getByLabelText("Confirmation code"), "482913");
  await user().click(screen.getByRole("button", { name: "Confirm" }));
  expect(api.confirmStepUp).toHaveBeenCalledWith("su-1", "482913");
});
it("shows nothing on a device that is not a confirmer", () => {
  const { store } = renderWithClient(<StepUpPrompt />, { me: me({ confirmer: false }) });
  act(() => store.applyEvent(STEPUP));
  expect(screen.queryByText("482913")).toBeNull();
});
it("drops the prompt when it expires", async () => {
  const { store } = renderWithClient(<StepUpPrompt />, { me: me({ confirmer: true }) });
  act(() => store.applyEvent(STEPUP));
  await act(() => vi.advanceTimersByTimeAsync(120_001));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
it("shows the cooldown banner and disables the command bar until cooldownUntil", async () => {
  const { store } = renderWithClient(<><CooldownBanner /><CommandBar roomId="room-cos" /></>);
  act(() => store.applyEvent(hello({ cooldownUntil: "2026-10-25T12:10:00.000Z" })));
  expect(screen.getByRole("status")).toHaveTextContent("Commands from this session are paused until 12:10 (10:00 left). Every owner has been told.");
  expect(screen.getByLabelText("Message or /command")).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByLabelText("Message or /command")).toBeEnabled();
});
it("shows the lockdown and refuses commands until it is lifted", () => {
  const { store } = renderWithClient(<><CooldownBanner /><CommandBar roomId="room-cos" /></>);
  act(() => store.applyEvent({ type: "lockdown", active: true }));
  expect(screen.getByRole("status")).toHaveTextContent("The brain is in lockdown. Commands are refused until the host lifts it.");
  expect(screen.getByLabelText("Message or /command")).toBeDisabled();
  act(() => store.applyEvent({ type: "lockdown", active: false }));
  expect(screen.getByLabelText("Message or /command")).toBeEnabled();
});
it("formats countdowns and clock times", () => {
  expect([120_000, 5_000, 600_000, -1].map((n) => formatCountdown(n))).toEqual(["2:00", "0:05", "10:00", "0:00"]);
  expect(formatClock("2026-10-25T12:10:00.000Z")).toBe("12:10");   // TZ is UTC in vitest.config.ts
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/stepup-cooldown.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/components/StepUpPrompt"`.

- [ ] **Step 3: Implement the two components, the two formatters and the `CommandBar` disabled states**

Both components and `CommandBar` use `useNow(1000, active)`, active only while there is something to count down, so an idle page does not re-render every second.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/stepup-cooldown.test.tsx tests/command-bar.test.tsx`
Expected: PASS, `Tests  16 passed (16)`.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src/components packages/os-web/src/format.ts packages/os-web/src/app.css packages/os-web/tests/stepup-cooldown.test.tsx
git commit -m "feat(os-web): step-up prompts for confirmers, and the cooldown and lockdown banner"
```

---

### Task 10: The layout: channels around the chief of staff's chat

**Files:**
- Create: `packages/os-web/src/rooms.ts`, `packages/os-web/src/components/Channels.tsx`, `packages/os-web/src/components/Layout.tsx`
- Modify: `packages/os-web/src/App.tsx` (`Connected` renders `Layout`, loads commands, honours `#room=`, signs out), `packages/os-web/src/app.css` (grid, drawer), `packages/os-web/tests/app.test.tsx`
- Test: `packages/os-web/tests/rooms.test.ts`, `packages/os-web/tests/layout.test.tsx`

**Interfaces:**
- Consumes: `Chat` (Task 6), `CommandBar` (Task 7), `Instances`, `Resources` (Task 8), `StepUpPrompt`, `CooldownBanner` (Task 9), `readHash` (Task 5), `Api.commands`, `Api.logout` (Task 2), `LIVE_STATES` (Task 2).
- Produces:

```ts
// src/rooms.ts
export interface RoomGroups { cos: RoomRow | null; boards: RoomRow[]; live: RoomRow[]; past: RoomRow[]; direct: RoomRow[]; system: RoomRow[] }
export function groupRooms(rooms: RoomRow[], instances: Record<string, InstanceRow>): RoomGroups;
// components
export function Channels(props: { onPick?: () => void }): JSX.Element;   // onPick closes the phone drawer
export function Layout(props: { onSignOut: () => void }): JSX.Element;
```

Grouping rules: `cos` is the first `cos` room. Boards, direct and system rooms are each sorted by name. An `instance` room belongs to the instance whose `roomId` matches it. It is **live** when `closedAt` is null and that instance is unknown or in `LIVE_STATES`, sorted by `startedAt` (else `createdAt`), newest first. Otherwise it is **past**, sorted by `closedAt ?? endedAt ?? createdAt`, newest first.

`Channels` is `<nav aria-label="Channels">` with the sections "Chief of staff", "Boards", "Live instances", "Past instances", "Direct" and "System", empty sections left out. Each room is a `<button>` with `aria-current="page"` when active and, when unread is above 0, `<span class="badge">N<span class="sr-only"> unread</span></span>`, so its name reads "board-a 1 unread".

`Layout` has:
- a `<header>` with `Resources`, `Instances`, a connection indicator ("live" when the stream is open, "reconnecting…" otherwise) and a "Sign out" button;
- the `nav`;
- `<main aria-label="Room">` holding `CooldownBanner`, `StepUpPrompt`, `Chat` and `CommandBar` for the active room, or "Pick a channel." when none is active.

Under 720px the nav becomes a drawer opened by a "Channels" button.

`Connected` now renders `<Layout onSignOut={…} />`. On mount it calls `api.commands()` into `store.setCommands` (`[]` on failure), and, when `readHash(location.hash).room` is set, calls `store.setActiveRoom(room)` before `stream.connect()`. Sign-out calls `api.logout()` (ignoring errors), then goes through the same path as `onUnauthorized`.

- [ ] **Step 1: Write the failing tests**

`tests/rooms.test.ts`:

```ts
import { groupRooms } from "../src/rooms";
import { instance, room } from "./fakes";

it("groups rooms into channels", () => {
  const rooms = [room("room-s", "system"), room("room-b2", "board", { name: "board-b" }), room("room-b1", "board", { name: "board-a" }), room("room-cos", "cos"), room("room-i1", "instance"), room("room-i2", "instance"), room("room-i3", "instance", { closedAt: "2026-10-25T10:00:00Z" }), room("room-d", "direct")];
  const instances = { "inst-1": instance({ id: "inst-1", roomId: "room-i1", state: "exited", endedAt: "2026-10-25T11:00:00Z" }), "inst-2": instance({ id: "inst-2", roomId: "room-i2", state: "running" }) };
  const g = groupRooms(rooms, instances);
  expect(g.cos?.id).toBe("room-cos");
  expect(g.boards.map((r) => r.name)).toEqual(["board-a", "board-b"]);
  expect(g.live.map((r) => r.id)).toEqual(["room-i2"]);
  expect(g.past.map((r) => r.id)).toEqual(["room-i1", "room-i3"]);
  expect([g.direct.map((r) => r.id), g.system.map((r) => r.id)]).toEqual([["room-d"], ["room-s"]]);
});
```

`tests/layout.test.tsx`:

```tsx
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Layout } from "../src/components/Layout";
import { hello, instance, msg, room, snapshot } from "./fakes";
import { renderWithClient } from "./render";

const ROOMS = [room("room-cos", "cos", { name: "Chief of staff" }), room("room-a", "board", { name: "board-a" })];
async function renderLayout(event = hello({ rooms: ROOMS })) {
  const r = renderWithClient(<Layout onSignOut={vi.fn()} />);
  await act(async () => { r.store.applyEvent(event); await r.store.whenIdle(); });
  return r;
}

it("shows an unread badge on a channel the user is not viewing", async () => {
  const { store } = await renderLayout();
  act(() => store.applyEvent({ type: "message", message: msg({ roomId: "room-a", seq: 1, body: "card 42 held: needs a human" }) }));
  const nav = screen.getByRole("navigation", { name: "Channels" });
  await userEvent.click(within(nav).getByRole("button", { name: "board-a 1 unread" }));
  expect(within(nav).getByRole("button", { name: "board-a" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByText("card 42 held: needs a human")).toBeInTheDocument();
});
it("puts the chief of staff's chat and the command bar in the middle", async () => {
  await renderLayout();
  expect(within(screen.getByRole("navigation", { name: "Channels" })).getByRole("button", { name: "Chief of staff" })).toHaveAttribute("aria-current", "page");
  expect(within(screen.getByRole("main", { name: "Room" })).getByLabelText("Message or /command")).toBeInTheDocument();
});
it("shows the resource line and the live instances at the top", async () => {
  await renderLayout(hello({ rooms: ROOMS, resources: snapshot({ host: "host-a" }), instances: [instance({ cardId: "42" })] }));
  const top = screen.getByRole("banner");
  expect(within(top).getByText(/^host-a · load/)).toBeInTheDocument();
  expect(within(top).getByRole("article", { name: "Instance 42" })).toBeInTheDocument();
});
```

In `tests/app.test.tsx`, both tests that wait for "Signed in as owner" now wait for `screen.findByRole("navigation", { name: "Channels" })`. Add `within` to the `@testing-library/react` import and `hello` and `room` to the `./fakes` import, then add:

```tsx
it("opens the room named in #room= on start", async () => {
  render(<App deps={appDeps({ hash: "#room=room-a", routes: { "GET /api/me": json(me()), "GET /api/commands": json([]), "GET /api/rooms/room-a/messages?limit=100": json([]) } })} />);
  await screen.findByRole("navigation", { name: "Channels" });
  act(() => { FakeEventSource.last().open(); FakeEventSource.last().send(hello({ rooms: [room("room-cos", "cos", { name: "Chief of staff" }), room("room-a", "board", { name: "board-a" })] }), 1); });
  expect(within(screen.getByRole("navigation", { name: "Channels" })).getByRole("button", { name: "board-a" })).toHaveAttribute("aria-current", "page");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/rooms.test.ts tests/layout.test.tsx tests/app.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/rooms"`, and the App tests find no "Channels" navigation.

- [ ] **Step 3: Implement `groupRooms`, `Channels` and `Layout`, and the `Connected` changes**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-os-web test`
Expected: PASS, every os-web test file, with `rooms` 1, `layout` 3 and `app` 4.

- [ ] **Step 5: Build**

Run: `pnpm -w build`
Expected: every task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web/src packages/os-web/tests
git commit -m "feat(os-web): channel layout around the chief of staff's chat"
```

---

### Task 11: Web Push: the toggle and the service worker

**Files:**
- Create: `packages/os-web/src/push.ts`, `packages/os-web/src/components/PushToggle.tsx`, `packages/os-web/src/sw.ts`, `packages/os-web/src/sw/notification.ts`, `packages/os-web/src/sw/handlers.ts`, `packages/os-web/tsconfig.sw.json`
- Modify: `packages/os-web/vite.config.ts` (service-worker entry), `packages/os-web/package.json` (`build` also type-checks the worker), `packages/os-web/src/main.tsx` (registers `/sw.js` in production), `packages/os-web/src/App.tsx` (`postRoomNames`, `listenForOpenRoom`), `packages/os-web/src/components/Layout.tsx` (`<PushToggle />` in the header)
- Test: `packages/os-web/tests/push.test.tsx`, `packages/os-web/tests/sw.test.ts`

**Interfaces:**
- Consumes: `Me.vapidPublic` (`GET /api/me`, plan 03); `Api.pushSubscribe`, `Api.pushUnsubscribe` (Task 2); `Store.setActiveRoom` (Task 3); the push payload (contract addition 2); `/#room=<id>` (contract addition 3).
- Produces:

```ts
// src/sw/notification.ts: imported only by src/sw.ts, src/sw/handlers.ts and tests
export interface PushPayload { roomId: string; kind: string; roomName?: string; summary?: string }
export type RoomNames = Record<string, string>;
export function parsePushPayload(data: unknown): PushPayload | null;   // needs string roomId and kind
export function notificationFor(payload: PushPayload | null, names: RoomNames): { title: string; body: string; roomId: string | null };
// src/sw/handlers.ts
export interface SwClient { focus(): Promise<unknown>; postMessage(message: unknown): void }
export interface SwDeps { showNotification(title: string, options: NotificationOptions): Promise<void>; readNames(): Promise<RoomNames>; writeNames(names: RoomNames): Promise<void>; matchAll(): Promise<SwClient[]>; openWindow(url: string): Promise<unknown> }
export async function onPush(data: unknown, deps: SwDeps): Promise<void>;               // shows exactly one notification, always
export async function onNotificationClick(data: unknown, deps: SwDeps): Promise<void>;  // data is notification.data: { roomId }
export async function onClientMessage(data: unknown, deps: SwDeps): Promise<void>;      // { type: "room-names", names }
// src/push.ts
export interface PushEnv { hasPush: boolean; iosNeedsInstall: boolean; permission(): NotificationPermission; requestPermission(): Promise<NotificationPermission>; registration(): Promise<{ pushManager: Pick<PushManager, "getSubscription" | "subscribe"> }> }
export function browserPushEnv(): PushEnv;
export function urlBase64ToUint8Array(base64url: string): Uint8Array;
export function postRoomNames(controller: { postMessage(message: unknown): void } | null | undefined, rooms: RoomRow[]): void;
export function listenForOpenRoom(container: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined, store: Pick<Store, "setActiveRoom">): () => void;
// src/components/PushToggle.tsx
export function PushToggle(props: { env?: PushEnv }): JSX.Element;   // env default browserPushEnv()
```

Notification copy (the spec's push body rules):
- A payload with `summary` has title `roomName ?? names[roomId] ?? "Swarm OS"` and the summary as its body.
- A payload without one, which is what a `local_only` room sends, has title "Swarm OS" and body `A|An <noun> in <names[roomId] ?? "a private room">`. The nouns are question, answer, message (`text`), command, event, file and system message, with "An" before a vowel.
- An unreadable payload has title "Swarm OS", body "Something needs your attention." and `roomId` null.
- Options are `{ body, icon: "/icon-192.png", badge: "/icon-192.png", data: { roomId } }`.

A click goes to the first window client (`focus()`, then `postMessage({ type: "open-room", roomId })`), or else to `openWindow("/#room=<encoded roomId>")`, or to `"/"` when `roomId` is null.

`PushToggle` copy, in order of precedence:
- no push and `iosNeedsInstall`: "To get notifications on this phone, add Swarm OS to the Home Screen and open it from there."
- no push: "This browser cannot receive push notifications."
- `vapidPublic === null`: "Push is not configured on the brain (no VAPID keys in os.json)."
- permission `denied`: "Notifications are blocked for this site in the browser's settings."
- subscribed: "Notifications on" with a "Turn off" button (`unsubscribe()`, then `api.pushUnsubscribe()`).
- otherwise: a "Turn on notifications" button that runs `requestPermission()`, then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublic) })`, then `api.pushSubscribe(sub.toJSON())`.

On mount, with permission granted and an existing subscription, it re-posts that subscription once. `browserPushEnv` sets `hasPush` to `"serviceWorker" in navigator && "PushManager" in window && "Notification" in window`. It sets `iosNeedsInstall` for an iPhone, iPod or iPad user agent (or `MacIntel` with touch points above 1) that is not running standalone (`matchMedia("(display-mode: standalone)")` or `navigator.standalone`). It consults `matchMedia` only for such a user agent and only when it is a function, since jsdom has none and `Layout` renders the toggle in every later test.

- [ ] **Step 1: Write the failing tests**

`tests/push.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PushToggle } from "../src/components/PushToggle";
import { listenForOpenRoom, postRoomNames, urlBase64ToUint8Array, type PushEnv } from "../src/push";
import { me, room } from "./fakes";
import { renderWithClient } from "./render";

function pushEnv(over: Partial<PushEnv> = {}) {
  const sub = { toJSON: () => ({ endpoint: "https://push.example.test/1", keys: { p256dh: "k", auth: "a" } }), unsubscribe: vi.fn(async () => true) };
  const pushManager = { getSubscription: vi.fn(async (): Promise<typeof sub | null> => null), subscribe: vi.fn(async () => sub) };
  const env: PushEnv = { hasPush: true, iosNeedsInstall: false, permission: () => "default", requestPermission: vi.fn(async () => "granted" as const), registration: async () => ({ pushManager: pushManager as never }), ...over };
  return { env, sub, pushManager };
}

it("subscribes with the brain's VAPID key and posts the subscription", async () => {
  const { env, pushManager } = pushEnv();
  const { api } = renderWithClient(<PushToggle env={env} />, { me: me({ vapidPublic: "AQID" }) });
  await userEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
  expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
  expect(api.pushSubscribe).toHaveBeenCalledWith({ endpoint: "https://push.example.test/1", keys: { p256dh: "k", auth: "a" } });
  expect(await screen.findByText("Notifications on")).toBeInTheDocument();
});
it("asks an iPhone user to install the app first (Review Focus 4)", () => {
  renderWithClient(<PushToggle env={pushEnv({ hasPush: false, iosNeedsInstall: true }).env} />);
  expect(screen.getByText("To get notifications on this phone, add Swarm OS to the Home Screen and open it from there.")).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});
it("says notifications are blocked and posts nothing when permission is denied (Review Focus 4)", async () => {
  const { api } = renderWithClient(<PushToggle env={pushEnv({ requestPermission: vi.fn(async () => "denied" as const) }).env} />);
  await userEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
  expect(await screen.findByText("Notifications are blocked for this site in the browser's settings.")).toBeInTheDocument();
  expect(api.pushSubscribe).not.toHaveBeenCalled();
});
it("says push is not configured when the brain has no VAPID key (Review Focus 4)", () => {
  renderWithClient(<PushToggle env={pushEnv().env} />, { me: me({ vapidPublic: null }) });
  expect(screen.getByText("Push is not configured on the brain (no VAPID keys in os.json).")).toBeInTheDocument();
});
it("re-posts an existing subscription on start, so a rotated one heals", async () => {
  const { env, pushManager, sub } = pushEnv({ permission: () => "granted" });
  pushManager.getSubscription.mockResolvedValue(sub);
  const { api } = renderWithClient(<PushToggle env={env} />);
  await waitFor(() => expect(api.pushSubscribe).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Notifications on")).toBeInTheDocument();
});
it("decodes a base64url VAPID key", () => {
  expect(urlBase64ToUint8Array("AQID")).toEqual(new Uint8Array([1, 2, 3]));
  expect(urlBase64ToUint8Array("-_8")).toEqual(new Uint8Array([0xfb, 0xff]));
});
it("opens the room the service worker names", () => {
  const container = new EventTarget(); const store = { setActiveRoom: vi.fn(async () => {}) };
  const stop = listenForOpenRoom(container, store);
  container.dispatchEvent(new MessageEvent("message", { data: { type: "open-room", roomId: "room-b" } }));
  expect(store.setActiveRoom).toHaveBeenCalledWith("room-b");
  stop();
});
it("tells the service worker every room's name", () => {
  const controller = { postMessage: vi.fn() };
  postRoomNames(controller, [room("room-b", "board", { name: "board-a" })]);
  expect(controller.postMessage).toHaveBeenCalledWith({ type: "room-names", names: { "room-b": "board-a" } });
});
```

`tests/sw.test.ts`:

```ts
import { notificationFor, parsePushPayload, type RoomNames } from "../src/sw/notification";
import { onClientMessage, onNotificationClick, onPush, type SwClient } from "../src/sw/handlers";

const swDeps = (names: RoomNames = {}, clients: SwClient[] = []) => ({ showNotification: vi.fn(async () => {}), readNames: vi.fn(async () => names), writeNames: vi.fn(async () => {}), matchAll: vi.fn(async () => clients), openWindow: vi.fn(async () => null) });

it("renders the generic text for a local_only payload", () => {
  expect(notificationFor(parsePushPayload({ roomId: "room-b", kind: "question" }), { "room-b": "board-a" })).toEqual({ title: "Swarm OS", body: "A question in board-a", roomId: "room-b" });
});
it("uses 'An' before a vowel and 'a private room' for a room it has no name for (Review Focus 5)", () => {
  expect(notificationFor({ roomId: "room-x", kind: "answer" }, {}).body).toBe("An answer in a private room");
});
it("shows the summary for a normal room", () => {
  expect(notificationFor({ roomId: "room-b", kind: "question", roomName: "board-a", summary: "Which schema should the migration use?" }, {})).toEqual({ title: "board-a", body: "Which schema should the migration use?", roomId: "room-b" });
});
it("still shows a notification for a payload it cannot read (Review Focus 5)", async () => {
  const deps = swDeps();
  await onPush(null, deps);
  await onPush({ kind: 7 }, deps);
  expect(deps.showNotification).toHaveBeenCalledTimes(2);
  expect(deps.showNotification).toHaveBeenCalledWith("Swarm OS", expect.objectContaining({ body: "Something needs your attention.", data: { roomId: null } }));
});
it("focuses an open window and tells it which room to open", async () => {
  const client = { focus: vi.fn(async () => undefined), postMessage: vi.fn() }; const deps = swDeps({}, [client]);
  await onNotificationClick({ roomId: "room-b" }, deps);
  expect(client.focus).toHaveBeenCalled();
  expect(client.postMessage).toHaveBeenCalledWith({ type: "open-room", roomId: "room-b" });
  expect(deps.openWindow).not.toHaveBeenCalled();
});
it("opens the room in a new window when none is open", async () => {
  const deps = swDeps();
  await onNotificationClick({ roomId: "room-b" }, deps);
  expect(deps.openWindow).toHaveBeenCalledWith("/#room=room-b");
});
it("stores the room names the page sends", async () => {
  const deps = swDeps();
  await onClientMessage({ type: "room-names", names: { "room-b": "board-a" } }, deps);
  expect(deps.writeNames).toHaveBeenCalledWith({ "room-b": "board-a" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os-web exec vitest run tests/push.test.tsx tests/sw.test.ts`
Expected: FAIL, `Failed to resolve import "../src/push"` and `"../src/sw/notification"`.

- [ ] **Step 3: Implement the worker, the page side and the build changes**

- `src/sw.ts` begins `const sw = self as unknown as ServiceWorkerGlobalScope;` (redeclaring `self` clashes with the WebWorker lib). It wires `install` → `sw.skipWaiting()`; `activate` → `waitUntil(sw.clients.claim())`; `push` → `waitUntil(onPush(<event.data.json(), or null when that throws>, deps))`; `notificationclick` → `notification.close()` then `waitUntil(onNotificationClick(notification.data, deps))`; and `message` → `waitUntil(onClientMessage(event.data, deps))`. Its `deps` keep room names as JSON in Cache Storage (`caches.open("swarm-os")`, key `/__swarm-os/room-names`) and hold nothing about the session.
- `tsconfig.sw.json` extends `./tsconfig.json` with `lib: ["ES2023", "WebWorker"]`, `types: []`, `include: ["src/sw.ts", "src/sw/**/*"]` and `exclude: []`. The `build` script becomes `tsc -p tsconfig.json && tsc -p tsconfig.sw.json && vite build`.
- `vite.config.ts` gets `build.rollupOptions: { input: { index: "index.html", sw: "src/sw.ts" }, output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") } }`. The worker shares no module with the app, so Rollup emits `dist/sw.js` as one classic script at the root, where its scope is `/`.
- `main.tsx`: `if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");`. `Connected` calls `listenForOpenRoom(navigator.serviceWorker, store)` on mount, and `postRoomNames(navigator.serviceWorker?.controller, rooms)` whenever `rooms` changes. `Layout` renders `<PushToggle />` in the header.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-os-web test`
Expected: PASS, every os-web test file, with `push` 8 and `sw` 7.

- [ ] **Step 5: Build and check the worker bundle**

Run: `pnpm --filter @mnmal-ai/swarm-os-web build && node -e 'const s=require("fs").readFileSync("packages/os-web/dist/sw.js","utf8"); if (/(^|;)\s*(import|export)\b/.test(s)) { console.error("sw.js imports a module"); process.exit(1); } console.log("sw.js is one classic script")' && pnpm -w build`
Expected: `sw.js is one classic script`; every turbo task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os-web
git commit -m "feat(os-web): web push subscription and service worker"
```

---

### Task 12: Embed the dashboard in the brain and serve it under a strict CSP

**Files:**
- Create: `packages/os/scripts/gen-web-manifest.mjs`, `packages/os/src/api/web-embed.ts`, `packages/os/src/api/static.ts`, `packages/os/tests/api/http-fakes.ts`
- Modify: plan 03's composition root (`grep -rln "requireAuth(" packages/os/src/brain packages/os/src/api` finds where the routes are registered): one call. `packages/os/package.json` (plan 02's file): dependency and `prebuild`. `packages/os/src/index.ts`: the plan-07 block. `.gitignore`. `pnpm-lock.yaml`.
- Test: `packages/os/tests/scripts/gen-web-manifest.test.ts`, `packages/os/tests/api/web-embed.test.ts`, `packages/os/tests/api/static.test.ts`

**Interfaces:**
- Consumes: plan 03's `Api` as a `RouteRegistrar`; `createLogger(name)` (plan 02, `packages/os/src/log.ts`); the os-web build with its `exports` `./dist/*` (Tasks 1 and 11).
- Produces (contract addition 5 and the overview's static routes):

```ts
// packages/os/src/api/web-embed.ts
export type WebFiles = ReadonlyMap<string, Uint8Array>;   // "/index.html", "/sw.js", "/assets/index-<hash>.js", …
export interface LoadWebFilesOptions { importManifest?: () => Promise<{ default: Record<string, string> }>; distDir?: () => string }
export async function loadWebFiles(opts?: LoadWebFilesOptions): Promise<{ files: WebFiles; source: "embedded" | "disk" | "missing" }>;
// packages/os/src/api/static.ts
import type { IncomingMessage, ServerResponse } from "node:http";
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void | Promise<void>;
export interface RouteRegistrar { get(path: string, ...handlers: RouteHandler[]): void }   // plan 03's Api, structurally
export function contentTypeFor(path: string): string;
export function cacheControlFor(path: string): string;    // "/assets/…" → "public, max-age=31536000, immutable"; anything else → "no-cache"
export function securityHeaders(): Record<string, string>;
export async function registerStatic(server: RouteRegistrar, opts?: { files?: WebFiles }): Promise<void>;   // files default (await loadWebFiles()).files; GET "/" plus one exact GET per file
// packages/os/scripts/gen-web-manifest.mjs
export function renderManifest(relPaths: string[]): string;
export function checkBuild(read: (rel: string) => string, relPaths: string[]): string[];   // [] when the build is servable
```

`securityHeaders()` returns exactly:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`connect-src 'self'` covers both `fetch` and `EventSource`; `font-src … data:` is what lets the vendored Axon fonts load. Content types: `.html` `text/html; charset=utf-8`, `.js` `text/javascript; charset=utf-8`, `.css` `text/css; charset=utf-8`, `.webmanifest` `application/manifest+json`, `.json` `application/json; charset=utf-8`, `.png` `image/png`, `.svg` `image/svg+xml`, `.ico` `image/x-icon`, `.woff2` `font/woff2`, anything else `application/octet-stream`.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/api/http-fakes.ts`:

```ts
import type { RouteHandler } from "../../src/api/static.js";
export function capture() {
  const routes = new Map<string, RouteHandler[]>();
  return { routes, server: { get: (path: string, ...handlers: RouteHandler[]) => void routes.set(path, handlers) } };
}
export function fakeRes() {
  const r = { status: 0, headers: {} as Record<string, string>, body: "" };
  return Object.assign(r, {
    writeHead(status: number, headers: Record<string, string | number>) { r.status = status; for (const [k, v] of Object.entries(headers)) r.headers[k.toLowerCase()] = String(v); return r; },
    end(body?: string | Uint8Array) { r.body = body === undefined ? "" : Buffer.from(body).toString(); },
  });
}
```

`packages/os/tests/scripts/gen-web-manifest.test.ts`:

```ts
import { checkBuild, renderManifest } from "../../scripts/gen-web-manifest.mjs";
const REQUIRED = ["index.html", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

it("renders one Bun file import per built file", () => {
  const src = renderManifest(["index.html", "assets/index-abc.js"]);
  expect(src).toContain("// @ts-nocheck");
  expect(src).toContain('import f0 from "@mnmal-ai/swarm-os-web/dist/index.html" with { type: "file" };');
  expect(src).toContain('import f1 from "@mnmal-ai/swarm-os-web/dist/assets/index-abc.js" with { type: "file" };');
  expect(src).toContain('"/assets/index-abc.js": f1');
});
it("rejects a build the CSP or the worker's scope would break", () => {
  const files: Record<string, string> = { "index.html": "<html><script>boot()</script><style>p{}</style></html>", "sw.js": 'import{n as o}from"./assets/notification-abc.js";self.addEventListener("push",o)' };
  expect(checkBuild((rel) => files[rel] ?? "", REQUIRED)).toEqual([
    "index.html has an inline <script>; the CSP (script-src 'self') would block it",
    "index.html has an inline <style>; the CSP (style-src 'self') would block it",
    "sw.js imports another module; it must be one classic script",
  ]);
});
it("names the required files a build is missing, and passes a good build", () => {
  const good = (rel: string) => (rel === "index.html" ? '<script type="module" crossorigin src="/assets/index-abc.js"></script>' : "self.addEventListener('push',()=>{})");
  expect(checkBuild(good, ["index.html"])).toEqual(REQUIRED.slice(1).map((f) => `missing ${f}`));
  expect(checkBuild(good, REQUIRED)).toEqual([]);
});
```

`packages/os/tests/api/web-embed.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadWebFiles } from "../../src/api/web-embed.js";

const dirWith = (files: Record<string, string>) => { const d = mkdtempSync(join(tmpdir(), "os-web-")); for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), body); } return d; };
const text = (b: Uint8Array | undefined) => Buffer.from(b ?? new Uint8Array()).toString();

it("reads the embedded files the manifest names", async () => {
  const d = dirWith({ "a.html": "<p>a</p>" });
  const r = await loadWebFiles({ importManifest: async () => ({ default: { "/index.html": join(d, "a.html") } }) });
  expect(r.source).toBe("embedded");
  expect(text(r.files.get("/index.html"))).toBe("<p>a</p>");
});
it("falls back to os-web's dist on disk when the manifest cannot load", async () => {
  const d = dirWith({ "index.html": "<p>i</p>", "assets/index-abc.js": "x", "sw.js": "s", ".DS_Store": "junk" });
  const r = await loadWebFiles({ importManifest: async () => { throw new TypeError('Unknown file extension ".html"'); }, distDir: () => d });
  expect(r.source).toBe("disk");
  expect([...r.files.keys()].sort()).toEqual(["/assets/index-abc.js", "/index.html", "/sw.js"]);
});
it("serves a placeholder page when nothing is built", async () => {
  const r = await loadWebFiles({ importManifest: async () => { throw new Error("absent"); }, distDir: () => join(tmpdir(), `os-web-not-built-${process.pid}`) });
  expect(r.source).toBe("missing");
  expect(text(r.files.get("/index.html"))).toContain("Run pnpm -w build.");
});
```

`packages/os/tests/api/static.test.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerStatic } from "../../src/api/static.js";
import { capture, fakeRes } from "./http-fakes.js";

const FILES = { "/index.html": "<!doctype html>", "/assets/index-abc.js": "x", "/sw.js": "s", "/manifest.webmanifest": "{}" };
async function serve(files: Record<string, string> = FILES) {
  const { routes, server } = capture();
  await registerStatic(server, { files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])) });
  const get = async (path: string) => { const res = fakeRes(); await routes.get(path)!.at(-1)!({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, () => {}); return res; };
  return { routes, get };
}

it("serves / as index.html with the strict headers", async () => {
  const res = await (await serve()).get("/");
  expect([res.status, res.body]).toEqual([200, "<!doctype html>"]);
  expect(res.headers).toMatchObject({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  for (const d of ["default-src 'self'", "script-src 'self'", "font-src 'self' data:", "connect-src 'self';", "frame-ancestors 'none'"]) expect(res.headers["content-security-policy"]).toContain(d);
});
it("caches hashed assets for a year", async () => {
  expect((await (await serve()).get("/assets/index-abc.js")).headers).toMatchObject({ "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
});
it("serves the service worker and the manifest uncached at the root", async () => {
  const { get } = await serve();
  expect((await get("/sw.js")).headers).toMatchObject({ "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  expect((await get("/manifest.webmanifest")).headers).toMatchObject({ "content-type": "application/manifest+json", "cache-control": "no-cache" });
});
it("registers / and one exact route per embedded file", async () => {
  const { routes } = await serve({ "/index.html": "i", "/sw.js": "s" });
  expect([...routes.keys()].sort()).toEqual(["/", "/index.html", "/sw.js"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-os exec vitest run tests/scripts/gen-web-manifest.test.ts tests/api/web-embed.test.ts tests/api/static.test.ts`
Expected: FAIL, `Failed to resolve import "../../scripts/gen-web-manifest.mjs"`, `"../../src/api/web-embed.js"` and `"../../src/api/static.js"`.

- [ ] **Step 3: Implement the generator, the loader, static serving and the wiring**

- `gen-web-manifest.mjs`: `renderManifest` writes a header comment ("Generated by scripts/gen-web-manifest.mjs during prebuild. Do not edit or commit."), `// @ts-nocheck`, one `import f<i> from "@mnmal-ai/swarm-os-web/dist/<rel>" with { type: "file" };` per file, `const files: Record<string, string> = { "/<rel>": f<i>, … };` and `export default files;`. `checkBuild` reports `missing <rel>` for each required file, then the inline `<script>` problem (a `<script>` with no `src=`), the inline `<style>` problem, and the worker problem (`/(^|;)\s*(import|export)\b/` in `sw.js`). `main()` runs only when the script is invoked directly. It resolves the dist from `createRequire(import.meta.url).resolve("@mnmal-ai/swarm-os-web/package.json")`, runs `pnpm --filter @mnmal-ai/swarm-os-web build` only when `dist/index.html` is missing, and lists files as sorted POSIX relative paths, skipping dotfiles. Any `checkBuild` problem is printed and exits 1. Otherwise it writes `src/api/web-manifest.generated.ts` and prints `web manifest: <n> files`. It does not rebuild a dist that is already there: turbo already runs `@mnmal-ai/swarm-os-web#build` before this package's build through `^build`, and rebuilding here would rewrite that dist while turbo may still be caching it.
- `web-embed.ts`: the default `importManifest` is `() => import("./web-manifest.generated.js")` under `// @ts-ignore`, because the file is generated by prebuild and its Bun-only imports throw under Node and vitest, which sends loading to the disk fallback. The literal specifier is what lets `bun build --compile` follow it. The default `distDir` resolves `@mnmal-ai/swarm-os-web/package.json` with `createRequire`, lazily and only in the fallback. The embedded path reads each manifest path with `readFileSync`; disk walks the dist the same way as the generator. With no `index.html` the source is `missing`, and the single `/index.html` placeholder is `<!doctype html><title>Swarm OS</title><p>The dashboard is not built. Run pnpm -w build.</p>`, logged with `warn`. Each load logs `info("dashboard files", { source, count })` with `createLogger("web")`.
- `static.ts`: each handler answers `200` with `Content-Type`, `Cache-Control`, `Content-Length` and `securityHeaders()`, then the bytes. In plan 03's composition root, after every `/api` route, add `await registerStatic(api)`, passing an adapter only if plan 03's `Api` does not match `RouteRegistrar`.
- `packages/os/package.json`: `"@mnmal-ai/swarm-os-web": "workspace:*"` in `dependencies`, and `"prebuild": "node scripts/gen-web-manifest.mjs"`, joined with `&&` to any prebuild plan 02 defined. `.gitignore` gains `packages/os/src/api/web-manifest.generated.ts` with a one-line comment. Append to `packages/os/src/index.ts`:

```ts
// plan 07: dashboard
export { cacheControlFor, contentTypeFor, registerStatic, securityHeaders, type RouteHandler, type RouteRegistrar } from "./api/static.js";
export { loadWebFiles, type LoadWebFilesOptions, type WebFiles } from "./api/web-embed.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm install && pnpm --filter @mnmal-ai/swarm-os test`
Expected: PASS, with the 10 new tests among them.

- [ ] **Step 5: Build, then check the Node fallback and the Bun embedding**

Run: `pnpm -w build`
Expected: every turbo task successful, and the os build log prints `web manifest: 8 files` (index.html, sw.js, manifest.webmanifest, three icons, and one hashed JS and one CSS asset).

Run: `node --input-type=module -e 'const { loadWebFiles } = await import("./packages/os/dist/src/api/web-embed.js"); const r = await loadWebFiles(); console.log(r.source, r.files.size)'`
Expected: `disk 8`. The path is the one a sibling-style tsconfig (`rootDir "."`, `outDir "dist"`) gives; if plan 02 chose another layout, `find packages/os/dist -name web-embed.js` shows it.

Run:

```bash
cat > "$TMPDIR/web-smoke.ts" <<EOF
import { loadWebFiles } from "$PWD/packages/os/dist/src/api/web-embed.js";
const r = await loadWebFiles(); console.log(r.source, r.files.size);
EOF
bun build --compile --outfile "$TMPDIR/web-smoke" "$TMPDIR/web-smoke.ts" && (cd / && "$TMPDIR/web-smoke")
```

Expected: `embedded 8`, from a working directory with no repository in it.

Read `scripts/compile-release-binaries.sh` and confirm it needs no change. It runs `pnpm turbo build --filter=@mnmal-ai/swarm-cli`, whose `^build` builds `@mnmal-ai/swarm-os` and so runs this prebuild after `@mnmal-ai/swarm-os-web#build`, given plan 03's cli → os dependency. Then `bun build --compile … packages/cli/src/cli/main.ts` follows the literal `import("./web-manifest.generated.js")` and embeds every `with { type: "file" }` import. `scripts/compile.sh` compiles the same entry and, as for every workspace package's `dist`, expects a prior `pnpm -w build`.

- [ ] **Step 6: Check the plan-wide constraints**

Run:

```bash
grep -rnE "dangerouslySetInnerHTML|innerHTML" packages/os-web/src
grep -rnE "localStorage|sessionStorage|document\.cookie|indexedDB|X-Swarm-Os-Client" packages/os-web/src
grep -rln "fetch(" packages/os-web/src | grep -v "^packages/os-web/src/api.ts$"
grep -rnE "https?://" packages/os-web/index.html packages/os-web/src
grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(" packages/os-web/src
if [ -f "${SWARM_ANONYMITY_PATTERNS:-$HOME/.config/swarm/anonymity-patterns}" ]; then scripts/verify-anonymous.sh; else scripts/verify-anonymous.sh --generic-only; fi
```

Expected: the five greps print nothing, and every anonymity group reports `0 hit(s)`.

- [ ] **Step 7: Commit**

```bash
git add packages/os/scripts packages/os/src/api/web-embed.ts packages/os/src/api/static.ts packages/os/src/index.ts packages/os/package.json packages/os/tests .gitignore pnpm-lock.yaml
git add -u packages/os/src    # the composition-root call in plan 03's file
git commit -m "feat(os): embed the dashboard in the brain and serve it with a strict CSP"
```
