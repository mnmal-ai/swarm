# Swarm OS 02: OS Store, Journal and OS Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the brain a durable state layer: the `swarm-os` Substrate namespace (plugin scope `os`), the `OsStore` contract with an in-memory and a Substrate implementation, a write-ahead journal that carries writes through an OS-stack outage, and `ensureOsStack`, which brings the brain's own Substrate stack up.

**Architecture:** The swarm Substrate plugin gains scope `os`, which serves only `swarm-os`, from one sidecar in the brain's dedicated stack (`~/.swarm/substrate/stacks/<compose_project>-cold`), started through the existing lifecycle with an explicit `SidecarSpec` and never through `process.env`. The new package `@mnmal-ai/swarm-os` declares every row as a strict zod schema, so `MemoryOsStore` refuses what Substrate refuses; `SubstrateOsStore` maps `Repo` calls onto autoCRUD in `swarm-os`; `journaledStore` appends each write to an fsynced ndjson journal before the store, serves from a `MemoryOsStore` snapshot while the store is unreachable, and replays in journal order when it returns.

**Tech Stack:** TypeScript ESM (`module: Node18`), zod 4.6, ulid 3, vitest 3, `@mnmal-ai/swarm-substrate` (client and lifecycle), the Substrate 1.0.0-alpha.7 SDK (`defineNamespace`, `field`) in the plugin, docker compose with the repo's `docker-compose.dedicated.yml`, a Bun text import for the binary.

**Spec:** `docs/superpowers/specs/2026-10-25-swarm-os-design.md`, with the shared contracts in `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md`, whose names this plan uses verbatim.

## Global Constraints

- "The brain's own state lives in Substrate, in a dedicated stack the brain owns (the "OS stack"), in new types under a `swarm-os` namespace … Per-project stacks are untouched and stay `local_only` where they are today." (spec) `ensureOsStack` never writes `process.env` and never touches a project's stack.
- "While the stack is unreachable the brain keeps serving reads from its last snapshot … commands and messages that must not be lost … are appended to a journal on local disk, acted on, and replayed into Substrate when it returns. The journal is a write-ahead log for the OS stack, not a second store: nothing is read from it except on replay." (spec)
- "Nothing only in memory. Every registration, instance, decision, room, message, device and session is a store row before the brain acts on it; when the store is unreachable the action is appended to the journal first." (overview)
- "Store ids are `<kind>-<ulid>` … `newId(kind: string): string` lives in `packages/os/src/store/ids.ts`." (overview)
- "`packages/os/src/log.ts`: `createLogger(name): Logger` with `info|warn|error(msg, fields?)`, JSON lines to stderr, `redactSecrets` applied to every field. No `console.log` in `packages/os`." (overview)
- "`packages/os` … `"type": "module"`, `"version": "1.0.0-alpha.0"`, `"license": "Apache-2.0"`, depend on siblings with `"workspace:*"`, extend `../../tsconfig.base.json`, test with `vitest run`, build with `tsc`." (overview)
- "Anonymity of the tree: no personal names, client names, hostnames or home-directory paths in code, tests, fixtures or docs. Examples use `board-a`, `project-a`, `owner`, `/path/to/project`." (overview)
- "No new GitHub workflows and no trigger changes." (overview) Nothing in this plan pushes, opens a PR or dispatches a workflow; commits stay local.
- "Tests never touch the real `~/.swarm`, never bind the default ports 32337-32341, and never start Docker unless you opt in. Run them with `ANTHROPIC_API_KEY` unset." (CLAUDE.md) Nor 42337-42341.
- "Do not send a bare param as a filter; use `where` with an operator. Do not send numbers as strings." "Do not declare swarm types outside `packages/substrate-plugin/src/types/`." (CLAUDE.md)
- Conventional Commit prefixes on every commit; never commit `packages/cli/src/version.ts`, which the build regenerates. (CLAUDE.md)
- Tests read sibling workspace packages from their `dist/`: after changing a package, run `pnpm -w build` (or that package's build) before a dependent package's tests.
- Every class this plan adds that crosses a process, network, disk, database or model boundary, waits in a queue, or runs on a timer takes `metrics?: Metrics` (default `noopMetrics`) or reads `BrainContext.metrics`; Task 11 records the rows.

## Review Focus

1. **Two subsystems write one row at once** (a heartbeat patch and a stop patch on the same instance). The store must end in journal order, and marking a later entry replayed must never cover an earlier one that has not reached the store. Pinned in Task 8, "concurrent writes reach the store in journal order".
2. **The journal's disk cannot be written** (a full disk, a path that is a file). The write fails loudly, naming the path, and nothing reaches Substrate without its entry. Pinned in Task 7, "rejects with JournalError naming a directory it cannot create", and Task 8, "a journal that cannot be written fails the write and leaves the store untouched".
3. **A caller writes a date with `new Date().toString()`, a number as a string, an unknown enum value or an extra key.** Substrate refuses each, so `MemoryOsStore`, which every later plan tests on, must refuse the same row at the same call. Pinned in Task 4 (row schemas agree with `osTypes`) and Task 5 (contract: "put and patch refuse a row that breaks its type", "find refuses …").
4. **Substrate comes back empty** (a memory store restarted, a volume wiped) while the brain holds a backlog. Entries for rows it no longer has are superseded, counted and logged, and replay finishes instead of wedging. Pinned in Task 8, "marks and counts a superseded entry …", and Task 10, replay into a fresh sidecar.
5. **Credentials inside error text**: a Postgres URL with its password in an `OsStackError`, a token in a logged field or in an `Error`'s message. Neither is ever printed. Pinned in Task 3 (redaction of fields and errors) and Task 9, "… never the credentials".

---

## File map

| Path | Responsibility |
|------|----------------|
| `packages/substrate-shared/src/constants.ts` | `SWARM_OS_NAMESPACE`, `osNamespaceFor`, `SWARM_OS_TYPE_NAMES` |
| `packages/substrate-plugin/src/types/os-types.ts` | `osTypes`, the thirteen `swarm-os` types |
| `packages/substrate-plugin/src/{plugin,namespaces,bootstrap,onboard,index}.ts`, `config.schema.json` | scope `os` |
| `packages/substrate/src/lifecycle/{specs,stacks,ready,postgres}.ts` | an `os`-scope sidecar spec; `DedicatedPostgres.services` |
| `packages/os/{package.json,tsconfig.json,vitest.config.ts}` | the package |
| `packages/os/src/index.ts` | public surface: the plan-02 export block |
| `packages/os/src/log.ts`, `packages/os/src/clock.ts` | `createLogger`, `redactSecrets`; `Clock`, `systemClock` |
| `packages/os/src/store/ids.ts` | `newId`, `ID_PREFIX`, `CardRef`, `cardKey` |
| `packages/os/src/store/rows.ts` | row schemas and types, typed JSON accessors |
| `packages/os/src/store/store.ts` | `OsStore`, `Repo`, repo tables, `OsStoreError`, write validation |
| `packages/os/src/store/memory-store.ts` | `MemoryOsStore` |
| `packages/os/src/store/substrate-store.ts` | `SubstrateOsStore` |
| `packages/os/src/journal/journal.ts` | `Journal`, `journaledStore` |
| `packages/os/src/stack/os-stack.ts`, `packages/os/src/stack/compose-embed.ts` | `ensureOsStack`; the compose template embedded for the binary |
| `packages/os/src/testing/*` | `FakeClock`, `makeConfig`, `makeRow`, `FakeSubstrateClient`, `MemoryOsStore` re-export |
| `packages/os/tests/**` | unit tests; `tests/store/contract.ts` is the shared `OsStore` suite |
| `tests/integration/os-store.test.ts` | E2E on a real os-scope sidecar, under `SWARM_SDK_E2E=1` only |

## Contract notes

Verified against Substrate 1.0.0-alpha.7 (the pinned `SUBSTRATE_VERSION`) in-process while writing this plan. Task 1's tests pin the first two against the plugin; `FakeSubstrateClient` (Task 6) mirrors all of them, and Task 10 runs the store against a real sidecar:

- `create<Type>` takes the caller's `id` and answers `id_exists` for an id that is live or was deleted. The OS id (`room-01J…`) is the Substrate row id; an id is never reused after a delete.
- `createdAt`, `updatedAt`, `createdBy` and `updatedBy` are row metadata. Sending one in create or update params answers `client_supplied_server_field`; a declared non-nullable `createdAt` makes every create answer `missing_required_field`. Selecting `_metadata: { createdAt: true }` reads the stamped time, and `where`/`orderBy` on `createdAt` use it.
- `update<Type>` of a missing or deleted id answers `not_found`; `delete<Type>` of one answers `{ deleted: false }`.
- A nullable field never written is left out of a projection; dates come back exactly as written.
- `{ eq: null }` matches null; `orderBy: [{ f: "desc" }]` breaks ties by id ascending; a `where` on an `indexed: false` field answers `unindexed_field`; a string for a number answers `invalid_field_type`; `shortId` is engine-allocated and refused as a param.

Additions to and departures from the overview, each owned by the task named:

- `osTypes` (Task 1): `createdAt` is `field.date({ nullable: true })` on Room, Participant, Memory and Session, forced by the above; the row types keep `createdAt: string`, read from `_metadata`. Seventeen body and JSON-blob fields take `{ indexed: false }`, the convention `swarm-types.ts` and `meta-types.ts` follow for text never filtered on. `Instance` gains two nullable strings, `phase` and `currentTask`, which plan 04 fills from heartbeats and plan 07 shows. The object is declared with `satisfies`, as `meta-types.ts` is.
- Lifecycle (Task 2): `SidecarSpec.scope` gains `"os"`; `DedicatedPostgres` gains `services`, because the dedicated template requires both port variables and would otherwise start a second, unused Postgres.
- `ensureOsStack` (Task 9) composes `ensureDedicatedPostgres`, `ensureAllSidecars({ specs: [osSpec] })` and `ensureTypesRegistered` from `ready.ts` rather than calling `ensureSubstrateReady({ isolated })`, which resolves a cold and a meta spec from `process.env` and checks swarm's own types. Putting the OS stack into the brain's environment would leak it into every instance and every CLI-as-function call.
- `journaledStore` (Task 8) returns `JournaledOsStore`, an `OsStore` plus `replay()` and `degraded`; `Journal` (Task 7) takes an optional second argument `{ clock, log }`. `replay()` is the journal's one replayer: the brain's start-up and its periodic replay call it, never a second loop over `unreplayed()`, so two replayers never mark one journal.
- `nextSeq` is monotonic per room, not contiguous: a room first numbered while the store is unreachable starts at the clock's milliseconds (Task 8).
- `decisionChecks` returns a structural `DecisionCheck[]` (Task 4), to which plan 04's `CheckResult` is assignable.
- `CardRef`, `cardKey` and `ID_PREFIX` live in `ids.ts` (Task 4); `Clock` in `src/clock.ts` (Task 3).
- `src/testing/index.ts` is created here; plans 04, 05 and 06 append `FakeLauncher` and `FakeBoardClient`, `FakePush`, and `FakeSdk` to it.
- `tests/integration/os-store.test.ts` (Task 10) matches the `os-*.test.ts` row the overview gives plan 09; plan 09's files sit beside it.

---

### Task 1: The `swarm-os` namespace under plugin scope `os`

**Files:**
- Modify: `packages/substrate-shared/src/constants.ts`, `packages/substrate-shared/src/index.ts`
- Create: `packages/substrate-plugin/src/types/os-types.ts`
- Modify: `packages/substrate-plugin/src/plugin.ts`, `packages/substrate-plugin/src/namespaces.ts`, `packages/substrate-plugin/src/bootstrap.ts`, `packages/substrate-plugin/src/onboard.ts`, `packages/substrate-plugin/src/index.ts`, `packages/substrate-plugin/config.schema.json`
- Modify: `CLAUDE.md`, `AGENTS.md` (the Namespaces and Types sections)
- Test: `packages/substrate-plugin/test/schema.test.ts`, `packages/substrate-plugin/test/bootstrap.test.ts`, `packages/substrate-plugin/test/routes.test.ts`

**Interfaces:**
- Consumes: `defineNamespace`, `field`, `TypeInput` from `@mnmal-ai/substrate/sdk`.
- Produces:

```ts
// packages/substrate-shared/src/constants.ts, exported from its index.ts
export function osNamespaceFor(swarmNamespace: string): string;   // `${swarmNamespace}-os`
export const SWARM_OS_NAMESPACE: string;                          // osNamespaceFor(SWARM_NAMESPACE) === "swarm-os"
export const SWARM_OS_TYPE_NAMES: readonly ["Board", "Registration", "Instance", "DispatchDecision", "Room", "Participant",
  "Message", "Question", "ResourceSnapshot", "Memory", "Device", "Session", "StepUp"];   // `as const`
export type SwarmOsTypeName = (typeof SWARM_OS_TYPE_NAMES)[number];

// packages/substrate-plugin
export const osTypes;                                   // src/types/os-types.ts: `{…} satisfies Record<SwarmOsTypeName, TypeInput>`; re-exported from src/index.ts
//   Instance.fields also carries phase and currentTask: field.string({ nullable: true }) each
export type SwarmScope = "cold" | "meta" | "combined" | "os";
// buildNamespaces({ scope: "os", namespace }) returns [defineNamespace(osNamespaceFor(namespace), osTypes)]
```

- [ ] **Step 1: Write the failing tests**

In `test/schema.test.ts`, use the three imports below in place of the existing shared-package and harness imports, and append the rest:

```ts
import { SWARM_META_TYPE_NAMES, SWARM_OS_TYPE_NAMES, SWARM_TYPE_NAMES } from "@mnmal-ai/swarm-substrate-shared";
import { osTypes } from "../src/types/os-types.js";
import { bootTestServer, type TestServer } from "./harness.js";

type Def = { type?: string; enum?: readonly string[]; nullable?: boolean };

/** A valid create body: enums their first value, nullable fields null, createdAt left to Substrate. */
function sampleParams(fields: Record<string, Def>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(fields)) {
    if (name === "createdAt") continue;
    if (def.nullable === true) out[name] = null;
    else if (def.enum !== undefined) out[name] = def.enum[0];
    else if (def.type === "number") out[name] = 1;
    else if (def.type === "boolean") out[name] = false;
    else if (def.type === "date") out[name] = "2026-01-01T00:00:00.000Z";
    else out[name] = "x";
  }
  return out;
}
const frame = (s: TestServer, op: "mutate" | "query", key: string, params: object, fields: object) =>
  s.inject({ method: "POST", url: `/substrate/v1/${op}`, body: { [key]: { params, fields } } }).then((r) => r.json() as Envelope);

describe("swarm-os namespace (scope os)", () => {
  it("osTypes declares exactly the thirteen SWARM_OS_TYPE_NAMES", () => {
    expect(Object.keys(osTypes).sort()).toEqual([...SWARM_OS_TYPE_NAMES].sort());
  });

  it("Instance carries the heartbeat's phase and currentTask as nullable strings", () => {
    const defs = osTypes.Instance.fields as Record<string, Def>;
    for (const name of ["phase", "currentTask"]) expect(defs[name], name).toMatchObject({ type: "string", nullable: true });
  });

  it("os scope publishes swarm-os with every OS type and no other swarm namespace", async () => {
    const s = await bootTestServer({ scope: "os" });
    try {
      const res = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm-os" });
      expect(res.status).toBe(200);
      expect(Object.keys((res.json() as NamespaceSchema).types).sort()).toEqual([...SWARM_OS_TYPE_NAMES].sort());
      for (const ns of ["swarm", "swarm-docs", "swarm_meta"]) {
        expect((await s.inject({ method: "GET", url: `/substrate/v1/schema/${ns}` })).status, ns).toBe(404);
      }
    } finally {
      await s.stop();
    }
  });

  it("every OS type round-trips through autoCRUD under an id the caller chose", async () => {
    const s = await bootTestServer({ scope: "os" });
    try {
      for (const type of SWARM_OS_TYPE_NAMES) {
        const id = `${type.toLowerCase()}-roundtrip`;
        const defs = osTypes[type].fields as Record<string, Def>;
        const fields = { id: true, ...Object.fromEntries(Object.keys(defs).map((f) => [f, true])) };
        const created = await frame(s, "mutate", `swarm-os/create${type}`, { id, ...sampleParams(defs) }, fields);
        expect(created.errors ?? [], type).toEqual([]);
        const read = await frame(s, "query", `swarm-os/${type}`, { id }, fields);
        expect((read.data[`swarm-os/${type}`] as Array<{ id: string }>).map((r) => r.id), type).toEqual([id]);
      }
    } finally {
      await s.stop();
    }
  });

  it("createdAt is Substrate's row metadata: refused on create, stamped, read from _metadata", async () => {
    const s = await bootTestServer({ scope: "os" });
    try {
      const params = { id: "room-createdat", ...sampleParams(osTypes.Room.fields as Record<string, Def>) };
      const refused = await frame(s, "mutate", "swarm-os/createRoom", { ...params, createdAt: "2026-01-01T00:00:00.000Z" }, { id: true });
      expect(refused.errors?.[0]?.code).toBe("client_supplied_server_field");
      expect((await frame(s, "mutate", "swarm-os/createRoom", params, { id: true })).errors ?? []).toEqual([]);
      const read = await frame(s, "query", "swarm-os/Room", { id: params.id }, { id: true, _metadata: { createdAt: true } });
      const [row] = read.data["swarm-os/Room"] as Array<{ _metadata: { createdAt: string } }>;
      expect(Number.isNaN(Date.parse(row!._metadata.createdAt))).toBe(false);
    } finally {
      await s.stop();
    }
  });
});
```

In `test/bootstrap.test.ts`, add to "builds each scope's namespaces", change the enum assertion in "keeps config.schema.json in step with the zod schema", and add one test:

```ts
    expect(namespacesOf({ scope: "os" })).toEqual(["swarm-os"]);
    expect(namespacesOf({ scope: "os", namespace: "hive" })).toEqual(["hive-os"]);
// …
    expect(schema.properties.scope?.enum).toEqual(["cold", "meta", "combined", "os"]);
// …
  it("an os instance schedules no drainstop", () => {
    expect(bootstrap(withDefaults({ scope: "os" })).schedule).toEqual([]);
  });
```

In `test/routes.test.ts`, import `type SwarmScope` from `../src/plugin.js` and `SWARM_OS_TYPE_NAMES` from `@mnmal-ai/swarm-substrate-shared`, widen `boot`, and add:

```ts
async function boot(scope: SwarmScope = "cold"): Promise<TestServer> {
  server = await bootTestServer({ scope, coordinators: scope === "cold" || scope === "combined" ? [createCortextFixture()] : [] });
  return server;
}

  it("an os-scope instance serves onboard with the OS types only, and no drainstop", async () => {
    const s = await boot("os");
    const onboard = await s.inject({ method: "GET", url: ONBOARD_PATH });
    expect(onboard.status).toBe(200);
    const body = onboard.json() as { types: Record<string, string>; workflows: Record<string, unknown> };
    expect(Object.keys(body.types).sort()).toEqual(SWARM_OS_TYPE_NAMES.map((t) => `swarm-os/${t}`).sort());
    expect(body.workflows).toEqual({});
    expect((await s.inject({ method: "POST", url: TRIGGER_DRAINSTOP_PATH })).status).toBe(404);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/substrate-plugin && npx vitest run test/schema.test.ts test/bootstrap.test.ts test/routes.test.ts`
Expected: FAIL. `schema.test.ts` cannot load `../src/types/os-types.js`; `bootstrap.test.ts` throws `BootstrapConfigError` for `scope: "os"` and the enum assertion differs; the os test in `routes.test.ts` fails to boot.

- [ ] **Step 3: Add the shared constants**

In `constants.ts`, below `metaNamespaceFor`, add `osNamespaceFor`, `SWARM_OS_NAMESPACE`, `SWARM_OS_TYPE_NAMES` (the thirteen names in the order of the Interfaces block, `as const`) and `SwarmOsTypeName`, each with a one-line doc comment like its neighbours; export all four from `src/index.ts`.

- [ ] **Step 4: Declare `osTypes` in `packages/substrate-plugin/src/types/os-types.ts`**

Copy the overview's `osTypes` field for field (`import { field, type TypeInput } from "@mnmal-ai/substrate/sdk"`, `export const osTypes = {…} satisfies Record<SwarmOsTypeName, TypeInput>;`, a module doc comment in the style of `meta-types.ts`), with exactly these changes:

1. `createdAt` on Room, Participant, Memory and Session is `field.date({ nullable: true })`, with the comment that `meta-types.ts` puts on `Decision.createdAt` (row metadata: a client value is refused, so a non-nullable field would make every create fail; Substrate stamps it and `_metadata.createdAt` reads it).
2. These seventeen fields take `indexed: false` (merged with `nullable: true` where the overview has it): Registration `description`, `askJson`, `skipLabelsJson`, `ownersJson`; Instance `exitReason`; DispatchDecision `checksJson`, `reason`; Room `membersJson`; Participant `permissionsJson`; Message `body`, `dataJson`, `provenanceJson`; Question `proceededWith`; ResourceSnapshot `snapshotJson`; Memory `body`; Device `publicKey`; StepUp `commandJson`.
3. Instance gains `phase: field.string({ nullable: true })` and `currentTask: field.string({ nullable: true })` after `tokens`, each with a one-line comment: the run's phase and current task from its latest heartbeat, null until the first one.

- [ ] **Step 5: Add scope `os` to the plugin**

- `plugin.ts`: `SwarmScope` gains `"os"`; `servesSwarm` becomes `resolved.scope === "cold" || resolved.scope === "combined"`; the module doc and the `scope`/`namespace` comments say that `os` serves only `<namespace>-os`, the Swarm OS brain's store, with no resolvers and no drainstop.
- `namespaces.ts`: `case "os": return [defineNamespace(osNamespaceFor(ns), osTypes)];`, and a line for `os` in the module doc.
- `bootstrap.ts`: `scope: z.enum(["cold", "meta", "combined", "os"])`.
- `config.schema.json`: the `scope` enum gains `"os"`; its description ends "…, 'combined' serves all three, 'os' serves <namespace>-os (the Swarm OS brain's store) and nothing else."; the `namespace` description adds "and the OS namespace <namespace>-os".
- `onboard.ts`: `cold` is `scope === "cold" || scope === "combined"`, `meta` is `scope === "meta" || scope === "combined"`. For `os`, `types` is `qualified(osNamespaceFor(ns), OS_TYPE_LINES)`, `workflows` is `{}`, and `summary` is "The Swarm OS brain's store: boards and their registrations, instances, dispatch decisions, rooms, messages, questions, resource snapshots, memory, and its humans' devices, sessions and step-up codes." `OS_TYPE_LINES`:

```ts
const OS_TYPE_LINES: Readonly<Record<string, string>> = {
  Board: "A task source the brain watches: a Trello board or GitHub repository, its queue column and webhook secret.",
  Registration: "A board bound to a project: swarm path, repo, host, limits, min_cards, privacy, ask overrides, owners.",
  Instance: "One dispatched swarm run for one card: state, launcher handle, room, heartbeats, tokens.",
  DispatchDecision: "The policy chain's verdict on one card version: outcome, each check's result, reason.",
  Room: "A messaging channel (system, board, instance, direct or the chief of staff's) and its members.",
  Participant: "A human or an agent in the messaging space, with its permissions.",
  Message: "One message in a room: sender, kind, body, provenance, seq.",
  Question: "A worker's question to a human: wait deadline, state, answer, what it proceeded with.",
  ResourceSnapshot: "One launcher resource report for a host.",
  Memory: "A standing order, preference, past answer or decision note the chief of staff recalls.",
  Device: "A human's enrolled passkey device.",
  Session: "A human session bound to one device: token hash, address, expiry, cool-down.",
  StepUp: "A step-up code issued for one standing command.",
};
```

- `src/index.ts`: `export { osTypes } from "./types/os-types.js";`.

- [ ] **Step 6: Document the namespace**

In `CLAUDE.md` under "### Namespaces": "Swarm owns three namespaces" becomes "Swarm owns four namespaces"; after the `swarm-docs` bullet add
"- `swarm-os` — the Swarm OS brain's own stack (`swarm os`): one sidecar with plugin scope `os` in `~/.swarm/substrate/stacks/<compose_project>-cold`. **13 types:** Board, Registration, Instance, DispatchDecision, Room, Participant, Message, Question, ResourceSnapshot, Memory, Device, Session, StepUp."
and in "## Do Not", "All 15 swarm types, 5 meta types and 2 docs types" becomes "All 15 swarm types, 5 meta types, 2 docs types and 13 os types". In `AGENTS.md` under "## Namespaces and Types", after the `swarm-docs` bullet add
"- `swarm-os` (the brain's OS stack, plugin scope `os`): 13 types: Board, Registration, Instance, DispatchDecision, Room, Participant, Message, Question, ResourceSnapshot, Memory, Device, Session, StepUp."

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @mnmal-ai/swarm-substrate-shared build && cd packages/substrate-plugin && npx vitest run`
Expected: PASS, every test file.

Run: `pnpm -w build && env -u ANTHROPIC_API_KEY pnpm turbo test --filter=@mnmal-ai/swarm-cli`
Expected: the build exits 0 with turbo's summary showing every task successful (the CLI's prebuild packs the plugin with scope `os`); the CLI suite passes.

- [ ] **Step 8: Commit**

```bash
git add packages/substrate-shared/src/constants.ts packages/substrate-shared/src/index.ts \
  packages/substrate-plugin/src packages/substrate-plugin/config.schema.json packages/substrate-plugin/test \
  CLAUDE.md AGENTS.md
git commit -m "feat(substrate-plugin): swarm-os namespace with the brain's thirteen types under scope os"
```

### Task 2: An `os`-scope sidecar in the lifecycle

**Files:**
- Modify: `packages/substrate/src/lifecycle/specs.ts`, `packages/substrate/src/lifecycle/stacks.ts`, `packages/substrate/src/lifecycle/ready.ts`, `packages/substrate/src/lifecycle/postgres.ts`
- Test: `packages/substrate/src/lifecycle/stacks.test.ts`, `packages/substrate/src/lifecycle/ready.test.ts`, `packages/substrate/src/lifecycle/postgres.dedicated.test.ts` (create)

**Interfaces:**
- Consumes: `SWARM_OS_TYPE_NAMES` (Task 1).
- Produces:

```ts
// specs.ts
interface SidecarSpec { scope: "cold" | "meta" | "os"; /* every other field unchanged */ }
// postgres.ts
export interface DedicatedPostgres {
  composeFile?: string; composeProject?: string; composeEnv?: Record<string, string>;
  /** Compose services to bring up (appended after `--wait`); every service when absent. */
  services?: readonly string[];
}
// stacks.ts: an os spec's swarm.config.json names the base namespace ("swarm-os" -> "swarm") and its package.json lists no cortext
// ready.ts: ensureTypesRegistered(client, [osSpec]) checks spec.namespace against SWARM_OS_TYPE_NAMES, and nothing else
```

- [ ] **Step 1: Write the failing tests**

Append to `describe("ensureStackDir")` in `stacks.test.ts`:

```ts
  it("writes an os-scope stack under <compose_project>-cold, naming the base namespace and no cortext", () => {
    const os: SidecarSpec = { label: "cold", scope: "os", namespace: "swarm-os", port: 49338, postgresUrl: "memory", stack: "swarm-os" };
    const dir = ensureStackDir(os, { runtimeDir, embedder: { ...OLLAMA, kind: "none" }, contextNamespace: "cortext" });
    expect(dir).toBe(join(home, ".swarm", "substrate", "stacks", "swarm-os-cold"));
    expect(readJson(join(dir, "swarm.config.json"))).toEqual({ scope: "os", namespace: "swarm", contextNamespace: "cortext" });
    const deps = Object.keys((readJson(join(dir, "package.json")) as { dependencies: object }).dependencies).sort();
    expect(deps).toEqual(["@mnmal-ai/substrate", "@mnmal-ai/swarm-substrate-plugin"]);
    expect(existsSync(join(dir, "substrate-recall.config.json"))).toBe(false);
  });
```

In `ready.test.ts`, add `SWARM_OS_TYPE_NAMES` to the shared import, then:

```ts
const os: SidecarSpec = { label: "cold", scope: "os", namespace: "swarm-os", port: 49338, postgresUrl: "memory", stack: "swarm-os" };
function osSchema(): SubstrateSchema {
  return { namespaces: { "swarm-os": { types: entries(SWARM_OS_TYPE_NAMES), queries: {}, mutations: {} } } };
}

  it("checks an os sidecar against the swarm-os types only", async () => {
    await expect(ensureTypesRegistered(stubClient(osSchema()), [os])).resolves.toBeUndefined();
    const missing = osSchema();
    delete missing.namespaces["swarm-os"].types.Device;
    await expect(ensureTypesRegistered(stubClient(missing), [os])).rejects.toThrow(/swarm-os\/Device/);
    await expect(ensureTypesRegistered(stubClient({ namespaces: {} }), [os])).rejects.toThrow(/namespace 'swarm-os'/);
  });
```

Create `postgres.dedicated.test.ts`:

```ts
/**
 * ensureDedicatedPostgres's compose call, with execFileSync recorded instead
 * of run: no Docker. Both URLs name a loopback port nothing listens on.
 */
import { createServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ argv: [] as string[][], env: [] as NodeJS.ProcessEnv[] }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn((_file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.argv.push(args);
    calls.env.push(opts.env ?? {});
    return "";
  }),
}));
const { ensureDedicatedPostgres } = await import("./postgres.js");

async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return `postgresql://swarm:swarm@127.0.0.1:${port}/swarm`;
}

const dedicated = {
  composeFile: "/path/to/docker-compose.dedicated.yml",
  composeProject: "swarm-os",
  composeEnv: { SWARM_DEDICATED_PG_PORT: "49337", SWARM_DEDICATED_META_PG_PORT: "49337" },
};

describe("ensureDedicatedPostgres", () => {
  beforeEach(() => {
    calls.argv.length = 0;
    calls.env.length = 0;
  });

  it("brings up only the services it names", async () => {
    const url = await closedUrl();
    await expect(ensureDedicatedPostgres({ ...dedicated, services: ["swarm-substrate"] }, { postgresUrl: url, metaPostgresUrl: url }, true)).resolves.toBe(false);
    expect(calls.argv).toEqual([["compose", "-p", "swarm-os", "-f", "/path/to/docker-compose.dedicated.yml", "up", "-d", "--wait", "swarm-substrate"]]);
    expect(calls.env[0]).toMatchObject({ SWARM_DEDICATED_PG_PORT: "49337", SWARM_DEDICATED_META_PG_PORT: "49337" });
  });

  it("brings up every service when it names none", async () => {
    const url = await closedUrl();
    await ensureDedicatedPostgres(dedicated, { postgresUrl: url, metaPostgresUrl: url }, true);
    expect(calls.argv).toEqual([["compose", "-p", "swarm-os", "-f", "/path/to/docker-compose.dedicated.yml", "up", "-d", "--wait"]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/substrate && npx vitest run src/lifecycle/stacks.test.ts src/lifecycle/ready.test.ts src/lifecycle/postgres.dedicated.test.ts`
Expected: FAIL. The os `swarm.config.json` names `"swarm-os"` instead of `"swarm"`; the os check asks for `swarm` and `swarm-docs`; the first compose argv lacks `"swarm-substrate"`.

- [ ] **Step 3: Implement**

- `specs.ts`: `scope: "cold" | "meta" | "os"`, documenting `os` as the Swarm OS brain's store (`swarm-os`), one sidecar labelled `cold` in its own stack.
- `stacks.ts` `baseNamespace`: for `os`, `spec.namespace` without its `-os` suffix, else `SWARM_NAMESPACE` (mirrors the `_meta` branch). The cortext dependency already depends on `scope === "cold"`; leave it.
- `ready.ts` `expectedNamespaces`: for `os`, `[{ ns: spec.namespace, types: SWARM_OS_TYPE_NAMES, queries: [], mutations: [] }]`.
- `postgres.ts`: `DedicatedPostgres.services`; the argv is `["compose", "-p", project, "-f", file, "up", "-d", "--wait", ...(dedicated.services ?? [])]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/substrate && npx vitest run`
Expected: PASS, every test file.

Run: `pnpm -w build && env -u ANTHROPIC_API_KEY pnpm turbo test --filter=@mnmal-ai/swarm-cli`
Expected: build exit 0; the CLI suite passes.

- [ ] **Step 5: Commit**

```bash
git add packages/substrate/src/lifecycle/specs.ts packages/substrate/src/lifecycle/stacks.ts \
  packages/substrate/src/lifecycle/ready.ts packages/substrate/src/lifecycle/postgres.ts \
  packages/substrate/src/lifecycle/stacks.test.ts packages/substrate/src/lifecycle/ready.test.ts \
  packages/substrate/src/lifecycle/postgres.dedicated.test.ts
git commit -m "feat(substrate): run an os-scope sidecar in a dedicated stack"
```

### Task 3: Scaffold `@mnmal-ai/swarm-os` with logging, a clock and the first test doubles

**Files:**
- Create: `packages/os/package.json`, `packages/os/tsconfig.json`, `packages/os/vitest.config.ts`
- Create: `packages/os/src/index.ts`, `packages/os/src/log.ts`, `packages/os/src/clock.ts`
- Create: `packages/os/src/testing/index.ts`, `packages/os/src/testing/clock.ts`, `packages/os/src/testing/config.ts`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)
- Test: `packages/os/tests/log.test.ts`, `packages/os/tests/testing/doubles.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
// src/clock.ts
export interface Clock { now(): Date }
export const systemClock: Clock;                       // now() is new Date()

// src/log.ts
export type LogFields = Record<string, unknown>;
export interface Logger { info(msg: string, fields?: LogFields): void; warn(msg: string, fields?: LogFields): void; error(msg: string, fields?: LogFields): void }
export interface CreateLoggerOptions { sink?: (line: string) => void; clock?: Clock }   // defaults: process.stderr.write(line + "\n"), systemClock
export function createLogger(name: string, opts?: CreateLoggerOptions): Logger;
export function redactSecrets(text: string): string;  // minimal; plan 05's messaging/redact.ts may take its place

// src/testing/clock.ts
export const TEST_EPOCH = "2026-01-01T00:00:00.000Z";
export class FakeClock implements Clock {
  constructor(start?: Date | string);                  // default TEST_EPOCH
  now(): Date;                                         // a fresh Date each call
  advance(ms: number): void;
  set(at: Date | string): void;
}

// src/testing/config.ts — the overview's OsConfig (z.infer of OsConfigSchema), field for field
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export interface TestOsConfig {
  version: 1;
  bind: { host: string; port: number };
  public_url: string;
  host_trust: "owner" | "shared";
  launcher: { kind: "local" } | { kind: "remote"; hosts: Array<{ name: string; ssh: string }> };
  os_stack: { port: number; postgres_url: string; compose_project: string };
  push?: { vapid_public: string; vapid_private: string; subject: string };
  owners: Array<{ id: string; name: string }>;
  limits: { max_instances: number; tokens_per_hour: number; tokens_per_day: number; dispatches_per_hour: number; registrable_roots: string[]; launcher_hosts: string[] };
  poll_interval_seconds: number;
  ask: { min_wait_minutes: number; quiet_windows: Array<{ start: string; end: string }>; timezone: string };
  boards: { trello?: { key: string; token: string }; github?: { token: string } };
  cos: { model: string; auth: "subscription" | "api_key"; max_turns: number };
  session_ttl_hours: number;
  stepup_ttl_seconds: number;
}
export function makeConfig(overrides?: DeepPartial<TestOsConfig>): TestOsConfig;
```

Plan 03's `OsConfig` is structurally this type; its schema test should assert `OsConfigSchema.parse(makeConfig())` equals `makeConfig()`.

- [ ] **Step 1: Create the package files**

`packages/os/package.json`:

```json
{
  "name": "@mnmal-ai/swarm-os",
  "version": "1.0.0-alpha.0",
  "description": "Swarm OS: the brain daemon (swarm os), starting with its store, write-ahead journal and OS stack.",
  "license": "Apache-2.0",
  "type": "module",
  "main": "dist/src/index.js",
  "types": "dist/src/index.d.ts",
  "exports": {
    ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" },
    "./testing": { "types": "./dist/src/testing/index.d.ts", "import": "./dist/src/testing/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:ci": "vitest run --reporter=verbose --reporter=json --outputFile=test-results.json"
  },
  "dependencies": {
    "@mnmal-ai/swarm-substrate": "workspace:*",
    "@mnmal-ai/swarm-substrate-shared": "workspace:*",
    "@mnmal-ai/swarm-types": "workspace:*",
    "ulid": "^3.0.2",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/os/tsconfig.json` and `packages/os/vitest.config.ts`, as `packages/cli` has them:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "Node18", "moduleResolution": "Node16", "outDir": "./dist", "rootDir": "." },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests", "src/**/*.test.ts"]
}
```

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { globals: true, environment: "node", include: ["tests/**/*.test.ts", "src/**/*.test.ts"], testTimeout: 30000 },
});
```

Run: `pnpm install`
Expected: exit 0; `pnpm-lock.yaml` gains the `packages/os` importer and `ulid@3.0.2` (fetched from npmjs).

- [ ] **Step 2: Write the failing tests**

`packages/os/tests/log.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLogger, redactSecrets } from "../src/log.js";
import { FakeClock, TEST_EPOCH } from "../src/testing/index.js";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger("store", { sink: (line) => lines.push(line), clock: new FakeClock() }) };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("createLogger", () => {
  it("writes one JSON line per call with at, level, logger, msg and the fields", () => {
    const { lines, log } = capture();
    log.info("store.ready", { repos: 13 });
    log.warn("store.slow", { ms: 2500 });
    log.error("store.failed", { code: "unreachable" });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { at: TEST_EPOCH, level: "info", logger: "store", msg: "store.ready", repos: 13 },
      { at: TEST_EPOCH, level: "warn", logger: "store", msg: "store.slow", ms: 2500 },
      { at: TEST_EPOCH, level: "error", logger: "store", msg: "store.failed", code: "unreachable" },
    ]);
  });

  it("never lets a field overwrite at, level, logger or msg", () => {
    const { lines, log } = capture();
    log.info("store.ready", { at: "x", level: "debug", logger: "y", msg: "z", n: 1 });
    expect(JSON.parse(lines[0]!)).toEqual({ at: TEST_EPOCH, level: "info", logger: "store", msg: "store.ready", n: 1 });
  });

  it("redacts secrets in the message and in nested field values", () => {
    const { lines, log } = capture();
    log.warn("auth failed for Bearer abc.def.ghi", { request: { headers: ["x-token: ghp_EXAMPLE"] } });
    expect(lines[0]).not.toMatch(/abc\.def\.ghi|ghp_EXAMPLE/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "auth failed for Bearer [redacted]", request: { headers: ["x-token: ghp_[redacted]"] } });
  });

  it("writes an Error field as its name and redacted message", () => {
    const { lines, log } = capture();
    log.error("store.failed", { err: new Error("key sk-ant-EXAMPLE leaked") });
    expect(JSON.parse(lines[0]!).err).toEqual({ name: "Error", message: "key sk-ant-[redacted] leaked" });
  });

  it("still writes the line when a field cannot be serialized", () => {
    const { lines, log } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.info("store.odd", { cyclic, big: 10n, ok: true });
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "store.odd", cyclic: "[unserializable]", big: "[unserializable]", ok: true });
  });
});

describe("redactSecrets", () => {
  it("masks sk-ant-, ghp_, github_pat_, xoxb- and Bearer tokens and leaves other text alone", () => {
    expect(redactSecrets("a sk-ant-EXAMPLE b")).toBe("a sk-ant-[redacted] b");
    expect(redactSecrets("ghp_EXAMPLE")).toBe("ghp_[redacted]");
    expect(redactSecrets("github_pat_EXAMPLE_1")).toBe("github_pat_[redacted]");
    expect(redactSecrets("xoxb-1-EXAMPLE")).toBe("xoxb-[redacted]");
    expect(redactSecrets("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets("board-a moved card 42 to Ready")).toBe("board-a moved card 42 to Ready");
  });

  it("no module under src calls console.*", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders = walk(src).filter((f) => f.endsWith(".ts") && /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
```

`packages/os/tests/testing/doubles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeClock, makeConfig, TEST_EPOCH } from "../../src/testing/index.js";

describe("FakeClock", () => {
  it("starts at TEST_EPOCH, advances, sets, and hands out copies", () => {
    const clock = new FakeClock();
    expect(clock.now().toISOString()).toBe(TEST_EPOCH);
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:01:30.000Z");
    clock.set("2026-02-01T00:00:00.000Z");
    clock.now().setUTCFullYear(2000);
    expect(clock.now().toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("makeConfig", () => {
  it("returns the overview's defaults with anonymous values", () => {
    const config = makeConfig();
    expect(config).toEqual({
      version: 1,
      bind: { host: "127.0.0.1", port: 3200 },
      public_url: "https://brain.example",
      host_trust: "owner",
      launcher: { kind: "local" },
      os_stack: { port: 49338, postgres_url: "postgresql://swarm:swarm@127.0.0.1:49337/swarm", compose_project: "swarm-os" },
      owners: [{ id: "part-owner", name: "owner" }],
      limits: { max_instances: 2, tokens_per_hour: 2_000_000, tokens_per_day: 20_000_000, dispatches_per_hour: 6, registrable_roots: ["/path/to/projects"], launcher_hosts: ["local"] },
      poll_interval_seconds: 120,
      ask: { min_wait_minutes: 30, quiet_windows: [], timezone: "UTC" },
      boards: {},
      cos: { model: "claude-sonnet-5-5", auth: "subscription", max_turns: 20 },
      session_ttl_hours: 24,
      stepup_ttl_seconds: 120,
    });
  });

  it("deep-merges overrides, replaces arrays, and returns a fresh object each call", () => {
    const config = makeConfig({ os_stack: { port: 50_000 }, limits: { registrable_roots: ["/path/to/project"] } });
    expect(config.os_stack).toEqual({ port: 50_000, postgres_url: "postgresql://swarm:swarm@127.0.0.1:49337/swarm", compose_project: "swarm-os" });
    expect(config.limits).toMatchObject({ max_instances: 2, registrable_roots: ["/path/to/project"] });
    config.owners.push({ id: "part-b", name: "b" });
    expect(makeConfig().owners).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run`
Expected: FAIL, `Failed to load url ../src/log.js` and `../../src/testing/index.js`.

- [ ] **Step 4: Implement**

- `src/clock.ts`: `Clock` and `systemClock`.
- `src/log.ts`: `createLogger` builds `{ ...serializedFields, at: clock.now().toISOString(), level, logger: name, msg: redactSecrets(msg) }` (base keys last, so they win) and hands `JSON.stringify` of it to the sink. Each field value is serialized on its own with a replacer that redacts every string and turns any `Error` into `{ name, message }` (message redacted, no stack); a value whose serialization throws (a cycle, a BigInt) becomes `"[unserializable]"`. `redactSecrets` replaces, globally and in this order, `sk-ant-[A-Za-z0-9_-]+` → `sk-ant-[redacted]`, `ghp_[A-Za-z0-9]+` → `ghp_[redacted]`, `github_pat_[A-Za-z0-9_]+` → `github_pat_[redacted]`, `xoxb-[A-Za-z0-9-]+` → `xoxb-[redacted]`, `\bBearer\s+[^\s"']+` → `Bearer [redacted]`. Default sink: `process.stderr.write(line + "\n")`.
- `src/testing/clock.ts`: `TEST_EPOCH`, `FakeClock`.
- `src/testing/config.ts`: `TestOsConfig`, `DeepPartial`, and `makeConfig`, which deep-clones the defaults the test lists and merges `overrides` into them (plain objects merge key by key; arrays and scalars replace; `undefined` is skipped).
- `src/testing/index.ts`:

```ts
/**
 * Test doubles for the brain, shared by every plan's tests. Plan 02 creates
 * this file; plans 04, 05 and 06 append FakeLauncher and FakeBoardClient,
 * FakePush, and FakeSdk below their own plan markers.
 */
// --- plan 02 ---
export { FakeClock, TEST_EPOCH } from "./clock.js";
export { makeConfig } from "./config.js";
export type { DeepPartial, TestOsConfig } from "./config.js";
```

- `src/index.ts`:

```ts
/**
 * `@mnmal-ai/swarm-os`: the Swarm OS brain. Each plan appends one export
 * block, marked with its number (docs/superpowers/plans/2026-10-25-swarm-os/).
 */

// --- plan 02: logging, clock, store, journal, OS stack ---
export { createLogger, redactSecrets } from "./log.js";
export type { CreateLoggerOptions, LogFields, Logger } from "./log.js";
export { systemClock } from "./clock.js";
export type { Clock } from "./clock.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (2 files).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful, `packages/os/dist/src/index.js` and `packages/os/dist/src/testing/index.js` exist.

- [ ] **Step 6: Commit**

```bash
git add packages/os pnpm-lock.yaml
git commit -m "feat(os): scaffold @mnmal-ai/swarm-os with JSON logging, a clock and test doubles"
```

### Task 4: Ids, row schemas and the `OsStore` types

**Files:**
- Create: `packages/os/src/store/ids.ts`, `packages/os/src/store/rows.ts`, `packages/os/src/store/store.ts`, `packages/os/src/testing/rows.ts`
- Modify: `packages/os/src/index.ts`, `packages/os/src/testing/index.ts`, `packages/os/package.json` (devDependency), `pnpm-lock.yaml`
- Test: `packages/os/tests/store/ids.test.ts`, `packages/os/tests/store/rows.test.ts`, `packages/os/tests/store/schema-parity.test.ts`

**Interfaces:**
- Consumes: `SWARM_OS_TYPE_NAMES`, `SwarmOsTypeName` (Task 1); `osTypes` from `@mnmal-ai/swarm-substrate-plugin` (Task 1, tests only); `TEST_EPOCH` (Task 3).
- Produces:

```ts
// src/store/store.ts — OsStore and Repo exactly as the overview declares them
export interface OsStore {
  boards: Repo<BoardRow>; registrations: Repo<RegistrationRow>; instances: Repo<InstanceRow>;
  decisions: Repo<DispatchDecisionRow>; rooms: Repo<RoomRow>; participants: Repo<ParticipantRow>;
  messages: Repo<MessageRow>; questions: Repo<QuestionRow>; resources: Repo<ResourceSnapshotRow>;
  memories: Repo<MemoryRow>; devices: Repo<DeviceRow>; sessions: Repo<SessionRow>; stepUps: Repo<StepUpRow>;
  /** Next message seq for a room, monotonic per room. */
  nextSeq(roomId: string): Promise<number>;
  /** Health of the underlying store; false when unreachable. */
  ping(): Promise<boolean>;
}
export interface Repo<T extends { id: string }> {
  get(id: string): Promise<T | null>;
  put(row: T): Promise<T>;                 // create or replace, idempotent on id
  patch(id: string, fields: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  find(where: Partial<T>, opts?: { limit?: number; orderBy?: keyof T; desc?: boolean }): Promise<T[]>;
}
export type RepoName = Exclude<keyof OsStore, "nextSeq" | "ping">;
export const REPO_NAMES: readonly RepoName[];        // boards, registrations, instances, decisions, rooms, participants, messages, questions, resources, memories, devices, sessions, stepUps
export const REPO_TYPES: Readonly<Record<RepoName, SwarmOsTypeName>>;   // boards→Board, registrations→Registration, instances→Instance, decisions→DispatchDecision, rooms→Room, participants→Participant, messages→Message, questions→Question, resources→ResourceSnapshot, memories→Memory, devices→Device, sessions→Session, stepUps→StepUp
export const ROW_SCHEMAS;                            // `{ boards: BoardRowSchema, … } as const`, keyed by RepoName
export const UNINDEXED_FIELDS: Readonly<Record<RepoName, readonly string[]>>;   // Task 1's seventeen indexed: false fields, by repo
export function stampsCreatedAt(repo: RepoName): boolean;                       // true for rooms, participants, memories, sessions
export type RowOf<K extends RepoName> = OsStore[K] extends Repo<infer T> ? T : never;
export type OsStoreErrorCode = "not_found" | "deleted" | "refused" | "unreachable";
export class OsStoreError extends Error {
  override readonly name = "OsStoreError";
  constructor(readonly code: OsStoreErrorCode, readonly repo: RepoName, readonly id: string | null, message: string, options?: ErrorOptions);
}

// src/store/rows.ts
export const isoDate;                                // z.iso.datetime()
export const BoardRowSchema, RegistrationRowSchema, InstanceRowSchema, DispatchDecisionRowSchema, RoomRowSchema,
  ParticipantRowSchema, MessageRowSchema, QuestionRowSchema, ResourceSnapshotRowSchema, MemoryRowSchema,
  DeviceRowSchema, SessionRowSchema, StepUpRowSchema;                                  // z.strictObject
export type BoardRow = z.infer<typeof BoardRowSchema>;   // … one per schema, the names OsStore uses
export interface AskConfig { min_wait_minutes?: number; quiet_windows?: Array<{ start: string; end: string }>; timezone?: string }
export const AskConfigSchema: z.ZodType<AskConfig>;  // strict; HH:MM windows, as os.json's ask block
export interface DecisionCheck { name: string; passed: boolean; detail: string }
export class RowJsonError extends Error { readonly field: string; readonly rowId: string }   // message "<field> of <rowId> is not valid: <reason>"
export function readJson<T>(rowId: string, field: string, text: string, schema: z.ZodType<T>): T;
export function toJson(value: unknown): string;      // TypeError when JSON cannot carry the value
export function registrationAsk(row: RegistrationRow): AskConfig;           // {} when askJson is null
export function registrationSkipLabels(row: RegistrationRow): string[];
export function registrationOwners(row: RegistrationRow): string[];
export function decisionChecks(row: DispatchDecisionRow): DecisionCheck[];
export function roomMembers(row: RoomRow): string[];
export function participantPermissions(row: ParticipantRow): string[];
export function messageData(row: MessageRow): unknown;                      // null when dataJson is null
export function stepUpCommand(row: StepUpRow): string[];
// plans 04 and 05 read snapshotJson and provenanceJson with readJson and their own schemas

// src/store/ids.ts
export const ID_PREFIX: Readonly<Record<RepoName, string>>;
export function newId(kind: string): string;         // `${kind}-${ulid}`, monotonic; TypeError unless kind matches /^[a-z][a-z0-9]*$/
export interface CardRef { boardId: string; cardId: string }
export function cardKey(ref: CardRef): string;       // `${boardId}:${cardId}`

// src/testing/rows.ts
export function makeRow<K extends RepoName>(repo: K, overrides?: Partial<RowOf<K>>): RowOf<K>;
```

- [ ] **Step 1: Add the plugin as a test-only dependency**

In `packages/os/package.json` `devDependencies`, add `"@mnmal-ai/swarm-substrate-plugin": "workspace:*"` (the parity test reads `osTypes` from it). Run: `pnpm install`. Expected: exit 0.

- [ ] **Step 2: Write the failing tests**

`packages/os/tests/store/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cardKey, ID_PREFIX, newId } from "../../src/store/ids.js";

describe("newId", () => {
  it("prefixes the kind to a 26-character ULID", () => {
    expect(newId("reg")).toMatch(/^reg-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is strictly increasing, also within one millisecond", () => {
    const ids = Array.from({ length: 1000 }, () => newId("msg"));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
  });

  it("refuses a kind that is not lowercase letters and digits", () => {
    for (const kind of ["", "Reg", "re-g", "re g", "1reg"]) expect(() => newId(kind), kind).toThrow(TypeError);
  });

  it("ID_PREFIX names one kind per repo", () => {
    expect(ID_PREFIX).toEqual({
      boards: "board", registrations: "reg", instances: "inst", decisions: "dec", rooms: "room", participants: "part",
      messages: "msg", questions: "q", resources: "res", memories: "mem", devices: "dev", sessions: "sess", stepUps: "step",
    });
  });
});

describe("cardKey", () => {
  it("joins board and card with a colon", () => {
    expect(cardKey({ boardId: "board-a", cardId: "42" })).toBe("board-a:42");
  });
});
```

`packages/os/tests/store/rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decisionChecks, messageData, participantPermissions, registrationAsk, registrationOwners, registrationSkipLabels,
  roomMembers, RowJsonError, stepUpCommand, toJson,
} from "../../src/store/rows.js";
import { makeRow } from "../../src/testing/index.js";

describe("JSON accessors", () => {
  it("read back what toJson wrote", () => {
    expect(roomMembers(makeRow("rooms", { membersJson: toJson(["part-owner", "part-cos"]) }))).toEqual(["part-owner", "part-cos"]);
    expect(registrationSkipLabels(makeRow("registrations", { skipLabelsJson: toJson(["design"]) }))).toEqual(["design"]);
    expect(registrationOwners(makeRow("registrations", { ownersJson: toJson(["part-owner"]) }))).toEqual(["part-owner"]);
    expect(participantPermissions(makeRow("participants", { permissionsJson: toJson(["send", "read"]) }))).toEqual(["send", "read"]);
    expect(stepUpCommand(makeRow("stepUps", { commandJson: toJson(["unregister", "reg-a"]) }))).toEqual(["unregister", "reg-a"]);
    const checks = [{ name: "known_board", passed: true, detail: "board-a" }];
    expect(decisionChecks(makeRow("decisions", { checksJson: toJson(checks) }))).toEqual(checks);
    expect(messageData(makeRow("messages", { dataJson: toJson({ card: 42 }) }))).toEqual({ card: 42 });
    expect(messageData(makeRow("messages", { dataJson: null }))).toBeNull();
  });

  it("registrationAsk is {} without askJson and the parsed overrides with it", () => {
    expect(registrationAsk(makeRow("registrations", { askJson: null }))).toEqual({});
    const ask = { min_wait_minutes: 45, quiet_windows: [{ start: "22:00", end: "07:00" }], timezone: "UTC" };
    expect(registrationAsk(makeRow("registrations", { askJson: toJson(ask) }))).toEqual(ask);
  });

  it("throw RowJsonError naming the field and the row for bad JSON or the wrong shape", () => {
    const room = makeRow("rooms", { membersJson: "{not json" });
    expect(() => roomMembers(room)).toThrow(RowJsonError);
    expect(() => roomMembers(room)).toThrow(`membersJson of ${room.id} is not valid`);
    expect(() => registrationAsk(makeRow("registrations", { askJson: toJson({ min_wait_minutes: "soon" }) }))).toThrow(/askJson/);
    expect(() => registrationAsk(makeRow("registrations", { askJson: toJson({ quiet_windows: [{ start: "10pm", end: "07:00" }] }) }))).toThrow(RowJsonError);
  });

  it("toJson refuses what JSON cannot carry", () => {
    expect(() => toJson(undefined)).toThrow(TypeError);
  });
});
```

`packages/os/tests/store/schema-parity.test.ts`:

```ts
import { SWARM_OS_TYPE_NAMES } from "@mnmal-ai/swarm-substrate-shared";
import { osTypes } from "@mnmal-ai/swarm-substrate-plugin";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { REPO_NAMES, REPO_TYPES, ROW_SCHEMAS, stampsCreatedAt, UNINDEXED_FIELDS } from "../../src/store/store.js";
import { makeRow } from "../../src/testing/index.js";

type Kind = { type: string; nullable: boolean; options?: string[] };
type Def = { type: string; nullable?: boolean; enum?: readonly string[]; indexed?: boolean };
const defsOf = (repo: (typeof REPO_NAMES)[number]) => osTypes[REPO_TYPES[repo]].fields as Record<string, Def>;

/** What a zod row field accepts, in osTypes' terms. */
function zodKind(schema: z.ZodType): Kind {
  const def = (schema as unknown as { def: { type: string; format?: string; innerType?: z.ZodType } }).def;
  if (def.type === "nullable") return { ...zodKind(def.innerType!), nullable: true };
  if (def.type === "enum") return { type: "enum", nullable: false, options: [...(schema as unknown as { options: string[] }).options] };
  if (def.type === "string" && def.format === "datetime") return { type: "date", nullable: false };
  return { type: def.type, nullable: false };
}
const fieldKind = (d: Def): Kind => ({ type: d.enum ? "enum" : d.type, nullable: d.nullable === true, ...(d.enum ? { options: [...d.enum] } : {}) });

describe("row schemas and osTypes", () => {
  it("REPO_TYPES maps the thirteen repos onto the thirteen OS types once each", () => {
    expect(REPO_NAMES).toHaveLength(13);
    expect(REPO_NAMES.map((r) => REPO_TYPES[r]).sort()).toEqual([...SWARM_OS_TYPE_NAMES].sort());
  });

  it("every row schema is id plus exactly its type's fields, kind for kind", () => {
    for (const repo of REPO_NAMES) {
      const shape = ROW_SCHEMAS[repo].shape as Record<string, z.ZodType>;
      expect(Object.keys(shape).sort(), repo).toEqual(["id", ...Object.keys(defsOf(repo))].sort());
      for (const [name, d] of Object.entries(defsOf(repo))) {
        // createdAt is stamped by Substrate: nullable in the type, present on every row.
        const want = name === "createdAt" ? { type: "date", nullable: false } : fieldKind(d);
        expect(zodKind(shape[name]!), `${repo}.${name}`).toEqual(want);
      }
    }
  });

  it("UNINDEXED_FIELDS and stampsCreatedAt agree with osTypes", () => {
    for (const repo of REPO_NAMES) {
      const unindexed = Object.entries(defsOf(repo)).filter(([, d]) => d.indexed === false).map(([n]) => n);
      expect([...UNINDEXED_FIELDS[repo]].sort(), repo).toEqual(unindexed.sort());
      expect(stampsCreatedAt(repo), repo).toBe("createdAt" in defsOf(repo));
    }
  });

  it("InstanceRow has the heartbeat's phase and currentTask, null until the first heartbeat", () => {
    const inst = makeRow("instances");
    expect([inst.phase, inst.currentTask]).toEqual([null, null]);
    expect(ROW_SCHEMAS.instances.safeParse({ ...inst, phase: "review", currentTask: "task-3" }).success).toBe(true);
    expect(ROW_SCHEMAS.instances.safeParse({ ...inst, phase: 3 }).success).toBe(false);
  });

  it("makeRow builds a valid row of every repo, nullable fields null", () => {
    for (const repo of REPO_NAMES) {
      const row = makeRow(repo) as Record<string, unknown>;
      expect(ROW_SCHEMAS[repo].safeParse(row).success, repo).toBe(true);
      for (const [name, d] of Object.entries(defsOf(repo))) if (d.nullable && name !== "createdAt") expect(row[name], `${repo}.${name}`).toBeNull();
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/store`
Expected: FAIL, `Failed to load url ../../src/store/ids.js` (and `rows.js`, `store.js`).

- [ ] **Step 4: Implement**

- `src/store/rows.ts`: for each of the overview's thirteen types, `export const <Type>RowSchema = z.strictObject({ id: z.string().min(1), …fields })` and `export type <Type>Row = z.infer<typeof <Type>RowSchema>`, mapping `field.string()` → `z.string()`, `field.number()` → `z.number()`, `field.boolean()` → `z.boolean()`, `field.enum(v)` → `z.enum(v)` (same values, same order), `field.date()` → `isoDate`, `{ nullable: true }` → `.nullable()`; `createdAt` (Room, Participant, Memory, Session) is plain `isoDate`; `InstanceRowSchema` includes Task 1's `phase` and `currentTask` (`z.string().nullable()`). `readJson` parses `text` (`JSON.parse`), validates with `schema`, and turns either failure into `RowJsonError(field, rowId, reason)`; each accessor is one `readJson` call (`z.array(z.string())` for the string lists, `z.array(z.strictObject({ name: z.string(), passed: z.boolean(), detail: z.string() }))` for checks, `AskConfigSchema` for ask, `z.unknown()` for data).
- `src/store/store.ts`: the interfaces above verbatim, then the tables and `OsStoreError` (its `message` is used as given; callers pass `"<repo> <id>: <reason>"`).
- `src/store/ids.ts`: one module-level `monotonicFactory()` from `ulid`; `ID_PREFIX` as the test lists it.
- `src/testing/rows.ts`: `makeRow` returns `{ id: newId(ID_PREFIX[repo]), …defaults, …overrides }` where the defaults are: each enum its first value; numbers `0`, except Registration `minCards: 3`, `maxInstances: 1` and Message `seq: 1`; booleans `false`; dates `TEST_EPOCH`; nullable fields `null`; JSON fields `"[]"`, except Registration `ownersJson` and Room `membersJson` `'["part-owner"]'`, Message `provenanceJson` `'{"source":"system"}'`, ResourceSnapshot `snapshotJson` `"{}"`, StepUp `commandJson` `'["help"]'`; other strings fixed anonymous values (`board-a`, `project-a`, `/path/to/project`, `/path/to/project/.swarm`, `owner`, `local`, `Ready`).
- Exports: every value and type in this task's Produces block from the plan-02 block of `src/index.ts`, except `makeRow`, which goes to the plan-02 block of `src/testing/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (5 files).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful.

- [ ] **Step 6: Commit**

```bash
git add packages/os pnpm-lock.yaml
git commit -m "feat(os): store ids, row schemas and the OsStore contract types"
```

### Task 5: `MemoryOsStore` and the shared `OsStore` contract

**Files:**
- Create: `packages/os/src/store/memory-store.ts`
- Modify: `packages/os/src/store/store.ts` (write validation), `packages/os/src/index.ts`, `packages/os/src/testing/index.ts`
- Test: `packages/os/tests/store/contract.ts` (the shared suite, not itself a test file), `packages/os/tests/store/memory-store.test.ts`

**Interfaces:**
- Consumes: everything Task 4 produces.
- Produces:

```ts
// src/store/store.ts — each throws OsStoreError("refused", repo, id, "<repo> <id>: <path>: <issue>; …")
export function assertValidRow<K extends RepoName>(repo: K, row: unknown): asserts row is RowOf<K>;
export function assertValidPatch<K extends RepoName>(repo: K, id: string, fields: unknown): asserts fields is Partial<RowOf<K>>;
export function assertValidWhere<K extends RepoName>(repo: K, where: unknown): asserts where is Partial<RowOf<K>>;

// src/store/memory-store.ts
export class MemoryOsStore implements OsStore { constructor() }   // also exported from src/testing/index.ts
```

Validation rules, shared by both stores and by `journaledStore`:
- `assertValidRow`: `ROW_SCHEMAS[repo].safeParse(row)` (strict: an extra key is refused).
- `assertValidPatch`: `schema.omit({ id: true, createdAt: true }).partial().strict()` for a stamped repo, `schema.omit({ id: true }).partial().strict()` otherwise, so `id`, `createdAt` and unknown keys are refused.
- `assertValidWhere`: every key is `id` or a schema key not in `UNINDEXED_FIELDS[repo]`; every value is `null` or passes that field's schema with `.nullable()` unwrapped.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/store/contract.ts`:

```ts
/**
 * The behaviour every OsStore shares, run against each implementation. Rows
 * keep makeRow's createdAt (TEST_EPOCH): a store over Substrate stamps
 * createdAt itself, from a FakeClock that reads TEST_EPOCH.
 */
import { describe, expect, it } from "vitest";
import { type OsStore, REPO_NAMES, type Repo, type RepoName } from "../../src/store/store.js";
import { makeRow, TEST_EPOCH } from "../../src/testing/index.js";

const repoOf = (store: OsStore, repo: RepoName) => store[repo] as unknown as Repo<{ id: string }>;
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

export function describeOsStoreContract(label: string, make: () => OsStore | Promise<OsStore>): void {
  describe(`${label}: OsStore contract`, () => {
    it("put then get returns the row, for every repo", async () => {
      const store = await make();
      for (const repo of REPO_NAMES) {
        const row = makeRow(repo);
        expect(await repoOf(store, repo).put(row), repo).toEqual(row);
        expect(await repoOf(store, repo).get(row.id), repo).toEqual(row);
      }
    });

    it("put is create-or-replace and idempotent on id; get of an unknown id is null", async () => {
      const store = await make();
      const room = makeRow("rooms", { name: "board-a" });
      await store.rooms.put(room);
      await store.rooms.put({ ...room, name: "board-b" });
      await store.rooms.put({ ...room, name: "board-b" });
      expect(await store.rooms.find({})).toEqual([{ ...room, name: "board-b" }]);
      expect(await store.rooms.get("room-unknown")).toBeNull();
    });

    it("returns copies: changing a returned row changes nothing stored", async () => {
      const store = await make();
      const board = makeRow("boards", { name: "board-a" });
      const returned = await store.boards.put(board);
      returned.name = "changed";
      expect((await store.boards.get(board.id))?.name).toBe("board-a");
    });

    it("patch merges the fields and returns the whole row; an unknown id is not_found", async () => {
      const store = await make();
      const inst = makeRow("instances", { state: "dispatching" });
      await store.instances.put(inst);
      const patched = await store.instances.patch(inst.id, { state: "running", runId: "run-a", tokens: 1200 });
      expect(patched).toEqual({ ...inst, state: "running", runId: "run-a", tokens: 1200 });
      expect(await store.instances.get(inst.id)).toEqual(patched);
      await expect(store.instances.patch("inst-unknown", { state: "failed" })).rejects.toMatchObject({ name: "OsStoreError", code: "not_found" });
    });

    it("delete removes the row and is idempotent; a deleted id is never reused", async () => {
      const store = await make();
      const msg = makeRow("messages");
      await store.messages.put(msg);
      await store.messages.delete(msg.id);
      await store.messages.delete(msg.id);
      expect(await store.messages.get(msg.id)).toBeNull();
      await expect(store.messages.put(msg)).rejects.toMatchObject({ code: "deleted" });
    });

    it("createdAt stays as first written: a replace keeps it and a patch of it is refused", async () => {
      const store = await make();
      const room = makeRow("rooms");
      await store.rooms.put(room);
      await store.rooms.put({ ...room, createdAt: "2026-06-01T00:00:00.000Z" });
      expect((await store.rooms.get(room.id))?.createdAt).toBe(TEST_EPOCH);
      await expect(store.rooms.patch(room.id, { createdAt: "2026-06-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "refused" });
    });

    it("put and patch refuse a row that breaks its type", async () => {
      const store = await make();
      const msg = makeRow("messages");
      const broken: Array<Record<string, unknown>> = [
        { ...msg, seq: "1" }, { ...msg, kind: "shout" }, { ...msg, at: new Date(0).toString() }, { ...msg, extra: true }, { ...msg, body: null },
      ];
      for (const row of broken) await expect(repoOf(store, "messages").put(row as { id: string })).rejects.toMatchObject({ code: "refused" });
      await store.messages.put(msg);
      await expect(store.messages.patch(msg.id, { seq: "2" } as unknown as { seq: number })).rejects.toMatchObject({ code: "refused" });
      await expect(store.messages.patch(msg.id, { id: "msg-other" })).rejects.toMatchObject({ code: "refused" });
      expect(await store.messages.get(msg.id)).toEqual(msg);
    });

    it("find matches every given field, null included, in id order", async () => {
      const store = await make();
      const a = makeRow("instances", { boardId: "board-a", state: "running", runId: "run-a" });
      const b = makeRow("instances", { boardId: "board-a", state: "dispatching", runId: null });
      const c = makeRow("instances", { boardId: "board-b", state: "running", runId: null });
      for (const row of [c, a, b]) await store.instances.put(row);
      expect(ids(await store.instances.find({ state: "running" }))).toEqual([a.id, c.id]);
      expect(ids(await store.instances.find({ runId: null }))).toEqual([b.id, c.id]);
      expect(ids(await store.instances.find({ boardId: "board-a", state: "running" }))).toEqual([a.id]);
      expect(await store.instances.find({ boardId: "board-z" })).toEqual([]);
    });

    it("find orders by a field either way, breaks ties by id ascending, and limits", async () => {
      const store = await make();
      const roomId = "room-a";
      const m1 = makeRow("messages", { roomId, seq: 1 });
      const m2 = makeRow("messages", { roomId, seq: 2 });
      const m2b = makeRow("messages", { roomId, seq: 2 });
      const m3 = makeRow("messages", { roomId, seq: 3 });
      for (const m of [m3, m2b, m1, m2]) await store.messages.put(m);
      expect(ids(await store.messages.find({ roomId }, { orderBy: "seq" }))).toEqual([m1.id, m2.id, m2b.id, m3.id]);
      expect(ids(await store.messages.find({ roomId }, { orderBy: "seq", desc: true }))).toEqual([m3.id, m2.id, m2b.id, m1.id]);
      expect(ids(await store.messages.find({ roomId }, { orderBy: "seq", desc: true, limit: 2 }))).toEqual([m3.id, m2.id]);
      expect(ids(await store.messages.find({ roomId }))).toEqual([m1.id, m2.id, m2b.id, m3.id]);
    });

    it("find refuses an unindexed field, an undeclared field and a value of the wrong type", async () => {
      const store = await make();
      await expect(store.messages.find({ body: "hello" })).rejects.toMatchObject({ code: "refused" });
      await expect(store.messages.find({ nope: 1 } as unknown as { body: string })).rejects.toMatchObject({ code: "refused" });
      await expect(store.messages.find({ seq: "1" } as unknown as { seq: number })).rejects.toMatchObject({ code: "refused" });
    });

    it("nextSeq counts per room from 1, above any seq stored, and never repeats under concurrency", async () => {
      const store = await make();
      expect(await store.nextSeq("room-a")).toBe(1);
      expect(await store.nextSeq("room-a")).toBe(2);
      expect(await store.nextSeq("room-b")).toBe(1);
      await store.messages.put(makeRow("messages", { roomId: "room-c", seq: 41 }));
      expect(await store.nextSeq("room-c")).toBe(42);
      const seqs = await Promise.all(Array.from({ length: 5 }, () => store.nextSeq("room-d")));
      expect(new Set(seqs).size).toBe(5);
    });

    it("ping is true while the store is reachable", async () => {
      expect(await (await make()).ping()).toBe(true);
    });
  });
}
```

`packages/os/tests/store/memory-store.test.ts`:

```ts
import { MemoryOsStore } from "../../src/store/memory-store.js";
import { describeOsStoreContract } from "./contract.js";

describeOsStoreContract("MemoryOsStore", () => new MemoryOsStore());
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/store/memory-store.test.ts`
Expected: FAIL, `Failed to load url ../../src/store/memory-store.js`.

- [ ] **Step 3: Implement**

- `store.ts`: the three validators, per the rules above.
- `memory-store.ts`, one map of rows and one set of deleted ids per repo, every row stored and returned as a `structuredClone`:
  - `put`: `assertValidRow`; a deleted id rejects `deleted`; replacing a row of a stamped repo keeps the stored `createdAt`.
  - `patch`: `assertValidPatch`; a missing id rejects `not_found`; merge and return the whole row.
  - `delete`: removes the row, records the id as deleted, resolves when there was nothing.
  - `find`: `assertValidWhere`; rows equal (`===`) on every given key, `null` matching `null`; sorted by `opts.orderBy ?? "id"` (strings, numbers and booleans by `<`, `false` before `true`), descending on `desc`, ties by id ascending; then `limit`.
  - `nextSeq(roomId)`: `max(this room's counter, the highest seq stored in the room) + 1`, recorded as the room's counter.
  - `ping`: `true`.
- Append `export { MemoryOsStore } from "./store/memory-store.js";` to the plan-02 block of `src/index.ts`, and `export { MemoryOsStore } from "../store/memory-store.js";` to that of `src/testing/index.ts`; export the three validators from `src/index.ts` next to `OsStoreError`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (6 files; the contract reports 12 tests for MemoryOsStore).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful.

- [ ] **Step 5: Commit**

```bash
git add packages/os
git commit -m "feat(os): MemoryOsStore and the shared OsStore contract suite"
```

### Task 6: `SubstrateOsStore` over `swarm-os`

**Files:**
- Create: `packages/os/src/testing/fake-substrate.ts`, `packages/os/src/store/substrate-store.ts`
- Modify: `packages/os/src/index.ts`, `packages/os/src/testing/index.ts`
- Test: `packages/os/tests/store/substrate-store.test.ts`

**Interfaces:**
- Consumes: `SubstrateClient`, `SubstrateFrameError`, `SubstrateHttpError`, `SubstrateTimeoutError`, `FieldSelection` from `@mnmal-ai/swarm-substrate`; `SWARM_OS_NAMESPACE` (Task 1); the store tables and validators (Tasks 4, 5); `FakeClock` (Task 3).
- Produces:

```ts
// src/store/substrate-store.ts
export type OsSubstrateClient = Pick<SubstrateClient, "namespace" | "query" | "mutate" | "isHealthy">;
export class SubstrateOsStore implements OsStore {
  constructor(client: OsSubstrateClient);           // TypeError unless client.namespace === SWARM_OS_NAMESPACE
}

// src/testing/fake-substrate.ts (exported from src/testing/index.ts)
export interface FakeSubstrateCall { op: "query" | "mutate"; name: string; params: Record<string, unknown>; fields: FieldSelection }
export class FakeSubstrateClient implements OsSubstrateClient {
  constructor(opts?: { namespace?: string; clock?: Clock });   // defaults "swarm-os", new FakeClock()
  readonly namespace: string;
  down: boolean;                                    // query/mutate reject with TypeError("fetch failed"); isHealthy() resolves false
  readonly calls: FakeSubstrateCall[];              // every call, including those it rejects
  failNext(op: "query" | "mutate", name: string, error: unknown): void;   // the next matching call rejects with `error`, once
  rows(type: SwarmOsTypeName): Array<Record<string, unknown>>;            // copies of the live stored bodies, with id, without _metadata
  query<T>(typeName: string, params: Record<string, unknown>, fields: FieldSelection): Promise<T[]>;
  mutate<T>(mutationName: string, params: Record<string, unknown>, fields: FieldSelection): Promise<T>;
  isHealthy(): Promise<boolean>;
}
```

`FakeSubstrateClient` emulates the autoCRUD behaviour listed under Contract notes, at the level of `SubstrateClient`'s methods (after pagination), throwing real `SubstrateFrameError(\`${namespace}/${name}\`, code, message)`s:
- `create<T>`: refuses `createdAt`/`updatedAt`/`createdBy`/`updatedBy` (`client_supplied_server_field`), a key outside `ROW_SCHEMAS` for the type (`unknown_field`), and an id that is live or was deleted (`id_exists`); stores the body; stamps `_metadata.createdAt = clock.now().toISOString()`. It answers the projection of the stored row.
- `update<T>`: `not_found` for a missing or deleted id; the same metadata and unknown-key refusals; merges.
- `delete<T>`: marks the id deleted; answers `{ id, deleted: true }`, or `{ id, deleted: false }` when there was nothing.
- query `<T>`: honours `id`, `where` (each key `{ eq: value }` and nothing else, `unsupported_filter` otherwise; `unindexed_field` for a key in `UNINDEXED_FIELDS`), `orderBy` (`[{ field: dir }]`, ties by id ascending, id ascending by default) and `limit`; never returns deleted rows.
- Projection: the selected keys present in the body (absent keys omitted), `id`, and `_metadata: { createdAt }` when `_metadata` is selected.
- It does not check field types; the stores validate before they call it.

`SubstrateOsStore` mapping (`T = REPO_TYPES[repo]`; `body` = every schema key but `id` and, for a stamped repo, `createdAt`):

| Repo call | Substrate call |
|-----------|----------------|
| selection | `{ id: true, <each body key>: true }`, plus `_metadata: { createdAt: true }` for a stamped repo |
| `get(id)` | `query(T, { id }, selection)`; first row or `null` |
| `put(row)` | `assertValidRow`; `get(row.id)`; existing → `mutate("update"+T, { id, …body }, selection)`, else `mutate("create"+T, { id, …body }, selection)`; `id_exists` on create → `deleted` |
| `patch(id, f)` | `assertValidPatch`; `mutate("update"+T, { id, …f }, selection)` |
| `delete(id)` | `mutate("delete"+T, { id }, { id: true, deleted: true })` |
| `find(w, o)` | `assertValidWhere`; `query(T, { where: { k: { eq: v } }… /* only when w has keys */, orderBy: [{ [o.orderBy ?? "id"]: o.desc ? "desc" : "asc" }], limit /* only when given */ }, selection)` |
| decode | `{ id, <each body key>: raw[key] ?? null }`, plus `createdAt: raw._metadata.createdAt` for a stamped repo |
| `nextSeq(roomId)` | serialised per room; the first call per room reads `query("Message", { where: { roomId: { eq: roomId } }, orderBy: [{ seq: "desc" }], limit: 1 }, { id: true, seq: true })` (0 when empty), later calls count in memory, and a failed read caches nothing; a message written through this store raises an initialised room's counter to at least its `seq` |
| `ping()` | `client.isHealthy()` |

Errors become `OsStoreError(code, repo, id, "<repo> <id>: <cause message>", { cause })`: `SubstrateFrameError` `not_found` → `not_found`, `id_exists` on create → `deleted`, any other code → `refused`; `SubstrateHttpError` with status ≥ 500 → `unreachable`, other statuses → `refused`; `SubstrateTimeoutError` and every other error (a `fetch failed` `TypeError`) → `unreachable`. Each write is one `mutate`, so each envelope carries the single idempotency key `SubstrateClient` mints for it. Writes to one id must not race; `journaledStore` serialises them.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/store/substrate-store.test.ts`:

```ts
import { SubstrateFrameError, SubstrateHttpError, SubstrateTimeoutError } from "@mnmal-ai/swarm-substrate";
import { describe, expect, it } from "vitest";
import { SubstrateOsStore } from "../../src/store/substrate-store.js";
import { FakeClock, FakeSubstrateClient, makeRow } from "../../src/testing/index.js";
import { describeOsStoreContract } from "./contract.js";

function fresh() {
  const client = new FakeSubstrateClient({ clock: new FakeClock() });
  return { client, store: new SubstrateOsStore(client) };
}

describeOsStoreContract("SubstrateOsStore over FakeSubstrateClient", () => fresh().store);

describe("SubstrateOsStore on the wire", () => {
  it("refuses a client bound to any namespace but swarm-os", () => {
    expect(() => new SubstrateOsStore(new FakeSubstrateClient({ namespace: "swarm" }))).toThrow(/swarm-os/);
  });

  it("creates under the OS id with every field but createdAt, numbers as numbers", async () => {
    const { client, store } = fresh();
    const msg = makeRow("messages", { seq: 7 });
    await store.messages.put(msg);
    const create = client.calls.find((c) => c.name === "createMessage");
    expect(create?.params).toEqual(msg);
    expect(typeof create?.params.seq).toBe("number");
    const room = makeRow("rooms");
    await store.rooms.put(room);
    const { createdAt: _stamped, ...roomBody } = room;
    expect(client.calls.find((c) => c.name === "createRoom")?.params).toEqual(roomBody);
  });

  it("replaces and patches through update with the id, never createdAt", async () => {
    const { client, store } = fresh();
    const room = makeRow("rooms");
    await store.rooms.put(room);
    await store.rooms.put({ ...room, name: "board-b" });
    const { createdAt: _stamped, ...roomBody } = room;
    expect(client.calls.filter((c) => c.name === "updateRoom").map((c) => c.params)).toEqual([{ ...roomBody, name: "board-b" }]);
    const inst = makeRow("instances");
    await store.instances.put(inst);
    await store.instances.patch(inst.id, { state: "running" });
    expect(client.calls.at(-1)).toMatchObject({ op: "mutate", name: "updateInstance", params: { id: inst.id, state: "running" } });
    expect(Object.keys(client.calls.at(-1)!.params).sort()).toEqual(["id", "state"]);
  });

  it("reads every declared field plus _metadata.createdAt, and never stores createdAt", async () => {
    const { client, store } = fresh();
    const room = makeRow("rooms");
    await store.rooms.put(room);
    client.calls.length = 0;
    expect(await store.rooms.get(room.id)).toEqual(room);
    expect(client.calls).toEqual([{
      op: "query", name: "Room", params: { id: room.id },
      fields: { id: true, kind: true, subjectId: true, name: true, membersJson: true, privacy: true, closedAt: true, _metadata: { createdAt: true } },
    }]);
    expect(client.rows("Room")[0]).not.toHaveProperty("createdAt");
  });

  it("finds with where eq per key, orderBy defaulting to id, and limit only when asked", async () => {
    const { client, store } = fresh();
    await store.messages.find({ roomId: "room-a", replyTo: null }, { orderBy: "seq", desc: true, limit: 2 });
    await store.messages.find({});
    expect(client.calls.map((c) => c.params)).toEqual([
      { where: { roomId: { eq: "room-a" }, replyTo: { eq: null } }, orderBy: [{ seq: "desc" }], limit: 2 },
      { orderBy: [{ id: "asc" }] },
    ]);
  });

  it("maps Substrate's refusals and transport failures onto OsStoreError codes", async () => {
    const { client, store } = fresh();
    client.failNext("mutate", "createBoard", new SubstrateFrameError("swarm-os/createBoard", "invalid_field_type", "expected a number"));
    await expect(store.boards.put(makeRow("boards"))).rejects.toMatchObject({ name: "OsStoreError", code: "refused", repo: "boards" });
    client.failNext("query", "Board", new SubstrateTimeoutError("query", 30_000));
    await expect(store.boards.get("board-x")).rejects.toMatchObject({ code: "unreachable" });
    client.failNext("query", "Board", new SubstrateHttpError("query", 503, "Service Unavailable"));
    await expect(store.boards.find({})).rejects.toMatchObject({ code: "unreachable" });
    client.failNext("query", "Board", new SubstrateHttpError("query", 400, "Bad Request"));
    await expect(store.boards.find({})).rejects.toMatchObject({ code: "refused" });
    client.down = true;
    await expect(store.boards.get("board-x")).rejects.toMatchObject({ code: "unreachable" });
    expect(await store.ping()).toBe(false);
  });

  it("nextSeq reads the room's highest seq once, then counts; a message written later raises the count", async () => {
    const { client, store } = fresh();
    await store.messages.put(makeRow("messages", { roomId: "room-a", seq: 9 }));
    client.calls.length = 0;
    expect(await store.nextSeq("room-a")).toBe(10);
    expect(await store.nextSeq("room-a")).toBe(11);
    expect(client.calls).toEqual([{
      op: "query", name: "Message",
      params: { where: { roomId: { eq: "room-a" } }, orderBy: [{ seq: "desc" }], limit: 1 }, fields: { id: true, seq: true },
    }]);
    await store.messages.put(makeRow("messages", { roomId: "room-a", seq: 30 }));
    expect(await store.nextSeq("room-a")).toBe(31);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/store/substrate-store.test.ts`
Expected: FAIL, `Failed to load url ../../src/store/substrate-store.js`.

- [ ] **Step 3: Implement `FakeSubstrateClient`, then `SubstrateOsStore`, per the rules and table above**

Append `export { SubstrateOsStore } from "./store/substrate-store.js";` and `export type { OsSubstrateClient } from "./store/substrate-store.js";` to the plan-02 block of `src/index.ts`; `export { FakeSubstrateClient } from "./fake-substrate.js";` and `export type { FakeSubstrateCall } from "./fake-substrate.js";` to that of `src/testing/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (7 files).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful.

- [ ] **Step 5: Commit**

```bash
git add packages/os
git commit -m "feat(os): SubstrateOsStore over the swarm-os namespace"
```

### Task 7: The write-ahead `Journal`

**Files:**
- Create: `packages/os/src/journal/journal.ts`
- Modify: `packages/os/src/index.ts`
- Test: `packages/os/tests/journal/journal.test.ts`

**Interfaces:**
- Consumes: `REPO_NAMES`, `OsStore` (Task 4); `Clock`, `systemClock`, `Logger`, `createLogger` (Task 3).
- Produces:

```ts
// src/journal/journal.ts
export interface JournalEntry { seq: number; at: string; op: "put" | "patch" | "delete"; type: keyof OsStore; id: string; payload: unknown }
export interface JournalOptions { clock?: Clock; log?: Logger }       // defaults systemClock, createLogger("journal")
export class JournalError extends Error { override readonly name = "JournalError" }
export class Journal {
  constructor(dir: string, opts?: JournalOptions);                    // <os_home>/journal
  readonly dir: string;
  append(entry: Omit<JournalEntry, "seq" | "at">): Promise<JournalEntry>;
  unreplayed(): Promise<JournalEntry[]>;
  markReplayed(upToSeq: number): Promise<void>;
}
```

On disk (the format is left to this plan by the spec): `<dir>/journal-<n>.ndjson`, one entry per line, append-only; `<dir>/replayed.json`, `{ "upToSeq": <n> }`. One `Journal` per directory per process.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/journal/journal.test.ts`:

```ts
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal, JournalError } from "../../src/journal/journal.js";
import { createLogger } from "../../src/log.js";
import { FakeClock, TEST_EPOCH } from "../../src/testing/index.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-os-journal-"));
  roots.push(root);
  return root;
}
const tempDir = () => join(tempRoot(), "journal");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const put = (id: string) => ({ op: "put" as const, type: "rooms" as const, id, payload: { id } });
const ndjson = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort();

describe("Journal", () => {
  it("append assigns increasing seqs and the clock's time; unreplayed returns them in order", async () => {
    const clock = new FakeClock();
    const journal = new Journal(tempDir(), { clock });
    const a = await journal.append(put("room-a"));
    clock.advance(1_000);
    const b = await journal.append({ op: "patch", type: "rooms", id: "room-a", payload: { name: "b" } });
    const c = await journal.append({ op: "delete", type: "rooms", id: "room-a", payload: null });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect([a.at, b.at]).toEqual([TEST_EPOCH, "2026-01-01T00:00:01.000Z"]);
    expect(await journal.unreplayed()).toEqual([a, b, c]);
  });

  it("markReplayed hides entries up to the mark, also for a new Journal on the same directory", async () => {
    const dir = tempDir();
    const journal = new Journal(dir);
    for (const id of ["room-a", "room-b", "room-c"]) await journal.append(put(id));
    await journal.markReplayed(2);
    expect((await journal.unreplayed()).map((e) => e.seq)).toEqual([3]);
    expect((await new Journal(dir).unreplayed()).map((e) => e.seq)).toEqual([3]);
    await journal.markReplayed(1);
    expect((await journal.unreplayed()).map((e) => e.seq)).toEqual([3]);
  });

  it("each instance appends to a new file; markReplayed removes older fully replayed files; seq carries on", async () => {
    const dir = tempDir();
    const first = new Journal(dir);
    await first.append(put("room-a"));
    await first.append(put("room-b"));
    const second = new Journal(dir);
    expect((await second.append(put("room-c"))).seq).toBe(3);
    expect(ndjson(dir)).toEqual(["journal-1.ndjson", "journal-2.ndjson"]);
    await second.markReplayed(3);
    expect(ndjson(dir)).toEqual(["journal-2.ndjson"]);
    expect((await new Journal(dir).append(put("room-d"))).seq).toBe(4);
  });

  it("skips a torn last line with a warning, and throws JournalError naming file and line for a broken one", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const log = createLogger("journal", { sink: (line) => lines.push(line) });
    await new Journal(dir, { log }).append(put("room-a"));
    const file = join(dir, "journal-1.ndjson");
    appendFileSync(file, '{"seq":2,"at":"2026-01-01T00:00:00.000Z","op":"put","ty');
    expect((await new Journal(dir, { log }).unreplayed()).map((e) => e.seq)).toEqual([1]);
    expect(lines.some((line) => JSON.parse(line).msg === "journal.torn_line")).toBe(true);
    writeFileSync(file, `not json\n${readFileSync(file, "utf8")}`);
    const err = await new Journal(dir, { log }).unreplayed().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JournalError);
    expect((err as Error).message).toContain("journal-1.ndjson:1");
  });

  it("keeps its directory 0700 and its files 0600", async () => {
    const dir = tempDir();
    const journal = new Journal(dir);
    await journal.append(put("room-a"));
    await journal.markReplayed(1);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
  });

  it("gives concurrent appends distinct seqs and keeps every one", async () => {
    const journal = new Journal(tempDir());
    const entries = await Promise.all(Array.from({ length: 20 }, (_, i) => journal.append(put(`room-${i}`))));
    expect(new Set(entries.map((e) => e.seq)).size).toBe(20);
    expect((await journal.unreplayed()).map((e) => e.id).sort()).toEqual(entries.map((e) => e.id).sort());
  });

  it("refuses an entry whose type is not a repo", async () => {
    await expect(new Journal(tempDir()).append({ op: "put", type: "ping", id: "x", payload: null })).rejects.toBeInstanceOf(JournalError);
  });

  it("rejects with JournalError naming a directory it cannot create", async () => {
    const notADir = join(tempRoot(), "file");
    writeFileSync(notADir, "");
    const err = await new Journal(join(notADir, "journal")).append(put("room-a")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JournalError);
    expect((err as Error).message).toContain(join(notADir, "journal"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/journal/journal.test.ts`
Expected: FAIL, `Failed to load url ../../src/journal/journal.js`.

- [ ] **Step 3: Implement `Journal`**

- Initialise once, lazily, on the first call: create `dir` (mode `0700`, then `chmod 0700`; any failure is a `JournalError` naming `dir`), read `replayed.json` (absent means 0), scan every `journal-<n>.ndjson` for its highest seq. The next seq is `max(mark, highest) + 1`; this instance's own file is `journal-<highest n + 1>.ndjson`, created (mode `0600`) on its first append, so a torn file is never appended to.
- `append`: refuse an `op` outside put/patch/delete, a `type` outside `REPO_NAMES` or an empty `id` with `JournalError`; appends run one at a time; the line is `JSON.stringify({ seq, at: clock.now().toISOString(), op, type, id, payload }) + "\n"`, written through one `FileHandle` opened `"a"` and `datasync()`ed before `append` resolves.
- `unreplayed`: read the files in `n` order. A final segment with no newline is a torn line: skip it and `log.warn("journal.torn_line", { file })`. Any complete line that does not parse, or does not match the entry shape (a zod schema of `JournalEntry` with `type` in `REPO_NAMES`), throws `JournalError` with `<file>:<line>` in its message. Return the entries above the mark, by seq.
- `markReplayed(n)`: ignore `n` at or below the current mark; write `replayed.json` to a temp file (mode `0600`), `datasync`, rename over the old one; then delete every journal file other than this instance's own whose highest seq is `≤ n`.
- Append `export { Journal, JournalError } from "./journal/journal.js";` and `export type { JournalEntry, JournalOptions } from "./journal/journal.js";` to the plan-02 block of `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (8 files).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful.

- [ ] **Step 5: Commit**

```bash
git add packages/os
git commit -m "feat(os): write-ahead journal on local disk"
```

### Task 8: `journaledStore`: journal first, snapshot reads, in-order replay

**Files:**
- Modify: `packages/os/src/journal/journal.ts`, `packages/os/src/index.ts`
- Test: `packages/os/tests/journal/journaled-store.test.ts`

**Interfaces:**
- Consumes: `OsStore`, `RepoName`, `OsStoreError`, `OsStoreErrorCode`, the validators (Tasks 4, 5); `MemoryOsStore` (Task 5); `SubstrateOsStore`, `FakeSubstrateClient` (Task 6, tests); `Journal`, `JournalError` (Task 7); `Clock`, `Logger` (Task 3).
- Produces:

```ts
// src/journal/journal.ts
export interface ReplayReport {
  applied: number;
  superseded: number;                     // entries whose row a later write had already removed: `deleted` or `not_found`
  failed: Array<{ seq: number; type: RepoName; id: string; code: OsStoreErrorCode; message: string }>;   // refused, marked, not retried
  pending: number;                        // entries still unreplayed (the store went away mid-replay)
}
export interface JournaledOsStore extends OsStore {
  replay(): Promise<ReplayReport>;
  readonly degraded: boolean;             // true while unreplayed entries exist or the last store call was unreachable
}
export interface JournaledStoreOptions { clock?: Clock; log?: Logger }   // defaults systemClock, createLogger("journal")
export function journaledStore(store: OsStore, journal: Journal, snapshot: MemoryOsStore, opts?: JournaledStoreOptions): JournaledOsStore;
```

Rules (the tests below pin each):
1. On the first call of any method, read `journal.unreplayed()` once; `degraded` starts true when it is non-empty.
2. Every `OsStore` method (not `replay` itself), when `degraded`, first asks `store.ping()` and, if true, awaits `replay()`, which clears `degraded` when nothing is left. A write does this before it joins the write chain, so it never waits on itself.
3. Writes (`put`, `patch`, `delete`) run one at a time, in call order, through one promise chain; reads and `ping` do not wait for it.
4. A write is validated first (`assertValidRow`, `assertValidPatch`), so an invalid one is refused and never journaled. Then it is appended (`payload`: the row, the fields, or `null` for a delete); a `JournalError` rejects the write with nothing sent to the store.
5. Not degraded: apply it to the store. Success: `markReplayed(seq)`, mirror the store's result into the snapshot, resolve with the store's result (a failed mark is logged as `journal.mark_failed` and the write still resolves). `unreachable`: set `degraded` and apply it to the snapshot as rule 6 says. Any other `OsStoreError`: `markReplayed(seq)` and reject with it.
6. Degraded: apply to the snapshot and resolve with its result; the entry stays for replay. A `patch` the snapshot answers `not_found` rejects `OsStoreError("unreachable", repo, id, …)`, saying the write is journaled but no snapshot of the row exists.
7. Reads: degraded → the snapshot. Otherwise the store; mirror the rows it returns into the snapshot (`snapshot[repo].put`, a `deleted` refusal logged and ignored); an `unreachable` failure sets `degraded` and answers from the snapshot; any other error rejects.
8. `nextSeq(roomId)` asks the store unless `degraded`; a store call that fails `unreachable` sets `degraded` and asks the snapshot instead. From the store, `n = max(store.nextSeq(roomId), lastIssued + 1)`, with `lastIssued` 0 for a room this process has not numbered. From the snapshot, `n = max(snapshot.nextSeq(roomId), lastIssued + 1)` when this process has issued a seq for the room, else `max(snapshot.nextSeq(roomId), clock.now().getTime())`, which is above any counted seq. Record `n` as the room's `lastIssued` synchronously after the await.
9. `replay()` queues its work on the write chain (two replays in a row: the second finds nothing): for each unreplayed entry in seq order, apply it to the store (`put` → `put(payload)`, `patch` → `patch(id, payload)`, `delete` → `delete(id)`) and mirror the result into the snapshot. Applied, superseded (`deleted`, `not_found`, logged `journal.superseded`) and refused (logged `journal.replay_refused`, recorded in `failed`) entries are marked one by one; `unreachable` stops the run, leaving `degraded` set and the rest counted in `pending`. It logs `journal.replayed` with the counts.
10. `ping()` is `store.ping()`.

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/journal/journaled-store.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubstrateFrameError } from "@mnmal-ai/swarm-substrate";
import { afterEach, describe, expect, it } from "vitest";
import { Journal, journaledStore, JournalError } from "../../src/journal/journal.js";
import { createLogger } from "../../src/log.js";
import { MemoryOsStore } from "../../src/store/memory-store.js";
import { SubstrateOsStore } from "../../src/store/substrate-store.js";
import { FakeClock, FakeSubstrateClient, makeRow, TEST_EPOCH } from "../../src/testing/index.js";
import { describeOsStoreContract } from "../store/contract.js";

const quiet = createLogger("test", { sink: () => {} });
const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-os-journaled-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(dir = join(tempRoot(), "journal")) {
  const clock = new FakeClock();
  const client = new FakeSubstrateClient({ clock });
  const base = new SubstrateOsStore(client);
  const journal = new Journal(dir, { clock, log: quiet });
  const store = journaledStore(base, journal, new MemoryOsStore(), { clock, log: quiet });
  return { dir, client, base, journal, store };
}
const mutations = (client: FakeSubstrateClient) => client.calls.filter((c) => c.op === "mutate");
const empty = { applied: 0, superseded: 0, failed: [], pending: 0 };

describeOsStoreContract("journaledStore with its store up", () => setup().store);

describe("journaledStore", () => {
  it("writes reach the store and leave nothing unreplayed while it is up", async () => {
    const { client, journal, store } = setup();
    const room = makeRow("rooms");
    await store.rooms.put(room);
    expect(client.rows("Room").map((r) => r.id)).toEqual([room.id]);
    expect(await journal.unreplayed()).toEqual([]);
    expect(store.degraded).toBe(false);
  });

  it("store down then up: writes are journaled and served from the snapshot, then replayed in order", async () => {
    const { client, journal, store } = setup();
    const kept = makeRow("rooms", { name: "kept" });
    await store.rooms.put(kept);
    client.down = true;
    const room = makeRow("rooms", { name: "board-a" });
    const msg = makeRow("messages", { roomId: room.id, seq: 1 });
    await store.rooms.put(room);
    await store.rooms.patch(room.id, { name: "board-b" });
    await store.messages.put(msg);
    expect(store.degraded).toBe(true);
    expect(await store.rooms.get(room.id)).toMatchObject({ name: "board-b" });
    expect(ids(await store.rooms.find({}))).toEqual([kept.id, room.id]);
    expect((await journal.unreplayed()).map((e) => `${e.op} ${e.type}`)).toEqual(["put rooms", "patch rooms", "put messages"]);
    expect(client.rows("Room").map((r) => r.id)).toEqual([kept.id]);
    client.down = false;
    expect(await store.replay()).toEqual({ ...empty, applied: 3 });
    expect(store.degraded).toBe(false);
    expect(await journal.unreplayed()).toEqual([]);
    expect(client.rows("Room").find((r) => r.id === room.id)).toMatchObject({ name: "board-b" });
    expect(client.rows("Message").map((r) => r.id)).toEqual([msg.id]);
    expect(mutations(client).slice(-3).map((c) => c.name)).toEqual(["createRoom", "updateRoom", "createMessage"]);
  });

  it("the first write after the store returns replays the backlog before itself", async () => {
    const { client, store } = setup();
    client.down = true;
    const a = makeRow("rooms");
    await store.rooms.put(a);
    client.down = false;
    const b = makeRow("rooms");
    await store.rooms.put(b);
    expect(mutations(client).map((c) => c.params.id)).toEqual([a.id, b.id]);
    expect(store.degraded).toBe(false);
  });

  it("duplicate replay is idempotent: the second run applies nothing", async () => {
    const { client, store } = setup();
    client.down = true;
    await store.rooms.put(makeRow("rooms"));
    client.down = false;
    expect((await store.replay()).applied).toBe(1);
    const sent = mutations(client).length;
    expect(await store.replay()).toEqual(empty);
    expect(mutations(client)).toHaveLength(sent);
  });

  it("after a crash between append and markReplayed, a new journaledStore replays the entry once more, rows unchanged", async () => {
    const { base, client, dir } = setup();
    const journal = new Journal(dir, { log: quiet });
    const room = makeRow("rooms");
    const msg = makeRow("messages", { roomId: room.id, seq: 1 });
    await journal.append({ op: "put", type: "rooms", id: room.id, payload: room });      // reached the store; the mark did not
    await base.rooms.put(room);
    await journal.append({ op: "put", type: "messages", id: msg.id, payload: msg });    // journaled, never written
    const restarted = journaledStore(base, new Journal(dir, { log: quiet }), new MemoryOsStore(), { log: quiet });
    expect(await restarted.replay()).toEqual({ ...empty, applied: 2 });
    expect(client.rows("Room")).toHaveLength(1);
    expect(await base.rooms.get(room.id)).toEqual(room);
    expect(await base.messages.get(msg.id)).toEqual(msg);
    expect(await new Journal(dir, { log: quiet }).unreplayed()).toEqual([]);
  });

  it("marks and counts a superseded entry, reports a refused one, and retries neither", async () => {
    const { base, client, dir } = setup();
    const journal = new Journal(dir, { log: quiet });
    const gone = makeRow("rooms");
    await base.rooms.put(gone);
    await base.rooms.delete(gone.id);
    await journal.append({ op: "put", type: "rooms", id: gone.id, payload: gone });
    await journal.append({ op: "patch", type: "instances", id: "inst-missing", payload: { state: "running" } });
    const board = makeRow("boards");
    const refused = await journal.append({ op: "put", type: "boards", id: board.id, payload: board });
    client.failNext("mutate", "createBoard", new SubstrateFrameError("swarm-os/createBoard", "invalid_field_type", "expected a date"));
    const restarted = journaledStore(base, new Journal(dir, { log: quiet }), new MemoryOsStore(), { log: quiet });
    const report = await restarted.replay();
    expect(report).toMatchObject({ applied: 0, superseded: 2, pending: 0 });
    expect(report.failed).toEqual([{ seq: refused.seq, type: "boards", id: board.id, code: "refused", message: expect.stringContaining("invalid_field_type") }]);
    expect(await new Journal(dir, { log: quiet }).unreplayed()).toEqual([]);
    expect(await restarted.replay()).toEqual(empty);
  });

  it("a write the store refuses while up rejects to the caller and leaves nothing pending", async () => {
    const { client, journal, store } = setup();
    client.failNext("mutate", "createBoard", new SubstrateFrameError("swarm-os/createBoard", "invalid_field_type", "expected a date"));
    await expect(store.boards.put(makeRow("boards"))).rejects.toMatchObject({ code: "refused" });
    expect(await journal.unreplayed()).toEqual([]);
    expect(store.degraded).toBe(false);
  });

  it("refuses an invalid write before it reaches the journal", async () => {
    const { dir, store } = setup();
    await expect(store.messages.put({ ...makeRow("messages"), seq: "1" } as never)).rejects.toMatchObject({ code: "refused" });
    expect(existsSync(join(dir, "journal-1.ndjson"))).toBe(false);
  });

  it("nextSeq stays monotonic across an outage; a room first numbered while down starts at the clock's milliseconds", async () => {
    const { client, store } = setup();
    expect(await store.nextSeq("room-a")).toBe(1);
    expect(await store.nextSeq("room-a")).toBe(2);
    client.down = true;
    expect(await store.nextSeq("room-a")).toBe(3);
    expect(await store.nextSeq("room-b")).toBe(Date.parse(TEST_EPOCH));
    expect(await store.nextSeq("room-b")).toBe(Date.parse(TEST_EPOCH) + 1);
    client.down = false;
    expect(await store.nextSeq("room-a")).toBe(4);
    expect(await store.nextSeq("room-b")).toBe(Date.parse(TEST_EPOCH) + 2);
  });

  it("a patch while down of a row the snapshot never saw stays journaled and rejects unreachable", async () => {
    const { base, client, journal, store } = setup();
    const inst = makeRow("instances", { state: "running" });
    await base.instances.put(inst);
    client.down = true;
    await expect(store.instances.patch(inst.id, { state: "paused" })).rejects.toMatchObject({ code: "unreachable" });
    expect((await journal.unreplayed()).map((e) => e.op)).toEqual(["patch"]);
    client.down = false;
    await store.replay();
    expect((await base.instances.get(inst.id))?.state).toBe("paused");
  });

  it("concurrent writes reach the store in journal order", async () => {
    const { client, journal, store } = setup();
    const inst = makeRow("instances", { tokens: 0 });
    await store.instances.put(inst);
    await Promise.all([1, 2, 3, 4, 5].map((tokens) => store.instances.patch(inst.id, { tokens })));
    expect(client.calls.filter((c) => c.name === "updateInstance").map((c) => c.params.tokens)).toEqual([1, 2, 3, 4, 5]);
    expect((await store.instances.get(inst.id))?.tokens).toBe(5);
    expect(await journal.unreplayed()).toEqual([]);
  });

  it("a journal that cannot be written fails the write and leaves the store untouched", async () => {
    const notADir = join(tempRoot(), "file");
    writeFileSync(notADir, "");
    const { client } = setup();
    const store = journaledStore(new SubstrateOsStore(client), new Journal(join(notADir, "journal"), { log: quiet }), new MemoryOsStore(), { log: quiet });
    await expect(store.rooms.put(makeRow("rooms"))).rejects.toBeInstanceOf(JournalError);
    expect(mutations(client)).toEqual([]);
  });

  it("ping reports the underlying store", async () => {
    const { client, store } = setup();
    expect(await store.ping()).toBe(true);
    client.down = true;
    expect(await store.ping()).toBe(false);
  });
});

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/journal/journaled-store.test.ts`
Expected: FAIL, `journaledStore is not a function` (no such export yet).

- [ ] **Step 3: Implement `journaledStore` in `src/journal/journal.ts`, per rules 1 to 10**

Append `journaledStore` and the types `JournaledOsStore`, `JournaledStoreOptions`, `ReplayReport` to the `./journal/journal.js` export lines of `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (9 files).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful.

- [ ] **Step 5: Commit**

```bash
git add packages/os
git commit -m "feat(os): journaledStore with snapshot reads and in-order replay"
```

### Task 9: `ensureOsStack` brings the brain's own stack up

**Files:**
- Create: `packages/os/src/stack/os-stack.ts`, `packages/os/src/stack/compose-embed.ts`
- Modify: `packages/os/src/index.ts`, `packages/os/package.json` (build script), `turbo.json`
- Test: `packages/os/tests/stack/os-stack.test.ts`

**Interfaces:**
- Consumes: `ensureDedicatedPostgres`, `ensureAllSidecars`, `ensureTypesRegistered`, `resolveEmbedderSettings`, `isMemoryStore`, `sidecarUrl`, `DEFAULT_CONTEXT_NAMESPACE`, `SubstrateClient`, `SidecarSpec` from `@mnmal-ai/swarm-substrate` (Task 2's `scope: "os"` and `services`); `SWARM_OS_NAMESPACE` (Task 1); `Logger`, `createLogger` (Task 3).
- Produces:

```ts
// src/stack/os-stack.ts
export interface OsStackConfig { port: number; postgres_url: string; compose_project: string }   // os.json os_stack
export interface OsStackLifecycle {
  ensureDedicatedPostgres: typeof ensureDedicatedPostgres;
  ensureAllSidecars: typeof ensureAllSidecars;
  ensureTypesRegistered: typeof ensureTypesRegistered;
}
export interface EnsureOsStackOptions {
  osHome?: string;                                   // default $SWARM_OS_HOME, else ~/.swarm/os (the overview's rule); plan 03 passes its osHome()
  pluginTarball?: string;                            // plan 03 passes the CLI's resolvePluginTarball().path; without it an installed runtime must exist
  runtimeDir?: string;                               // default ~/.swarm/substrate/runtime
  beforeReinstall?: () => Promise<void> | void;      // plan 03 passes the CLI's stopAllStacks
  bootTimeoutMs?: number;
  log?: Logger;                                      // default createLogger("os-stack")
  lifecycle?: Partial<OsStackLifecycle>;             // tests; defaults are the real functions
}
export type OsStackErrorCode = "postgres_unreachable" | "compose_template_missing";
export class OsStackError extends Error { override readonly name = "OsStackError"; readonly code: OsStackErrorCode }
export const OS_STACK_POSTGRES_SERVICE = "swarm-substrate";
export function osComposeFile(osHome: string): string;             // join(osHome, "stack", "docker-compose.dedicated.yml")
export function osSidecarSpec(config: { os_stack: OsStackConfig }): SidecarSpec;
export function loadComposeTemplate(): Promise<string>;
export function ensureOsStack(config: { os_stack: OsStackConfig }, opts?: EnsureOsStackOptions): Promise<SubstrateClient>;   // a swarm-os client
```

`ensureOsStack` takes any object with an `os_stack` block, so plan 03 passes its whole `OsConfig`; it also exports `osSidecarSpec` for `swarm os stop|status` (`stopSidecar(osSidecarSpec(config))`). The template's `swarm-substrate` service creates the database `swarm`, so `os_stack.postgres_url` names `/swarm` (as `makeConfig` does).

- [ ] **Step 1: Write the failing tests**

`packages/os/tests/stack/os-stack.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stackDirFor } from "@mnmal-ai/swarm-substrate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/log.js";
import { ensureOsStack, loadComposeTemplate, osComposeFile, osSidecarSpec, OsStackError } from "../../src/stack/os-stack.js";
import { makeConfig } from "../../src/testing/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TEMPLATE = join(REPO_ROOT, "docker-compose.dedicated.yml");
const PG_URL = "postgresql://swarm:swarm@127.0.0.1:49337/swarm";
const quiet = createLogger("test", { sink: () => {} });

/** The three lifecycle steps, recorded in order instead of run. */
function recorder(opts: { postgresUp?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    lifecycle: {
      ensureDedicatedPostgres: vi.fn(async (...args: unknown[]) => (calls.push(["postgres", args]), opts.postgresUp ?? true)),
      ensureAllSidecars: vi.fn(async (...args: unknown[]) => (calls.push(["sidecars", args]), [])),
      ensureTypesRegistered: vi.fn(async (...args: unknown[]) => void calls.push(["types", args])),
    },
  };
}

describe("ensureOsStack", () => {
  let home: string;
  let osHome: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "swarm-os-stack-"));
    process.env.HOME = home;
    osHome = join(home, "os");
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("names one os-scope sidecar, labelled cold, in the compose project's stack", () => {
    const spec = osSidecarSpec(makeConfig());
    expect(spec).toEqual({
      label: "cold", scope: "os", namespace: "swarm-os", port: 49338, postgresUrl: PG_URL,
      postgresUrlSource: "os.json os_stack.postgres_url", stack: "swarm-os",
    });
    expect(stackDirFor(spec)).toBe(join(home, ".swarm", "substrate", "stacks", "swarm-os-cold"));
  });

  it("brings its Postgres up from the dedicated template, the swarm-substrate service only", async () => {
    const { calls, lifecycle } = recorder();
    await ensureOsStack(makeConfig(), { osHome, log: quiet, lifecycle });
    const file = osComposeFile(osHome);
    expect(calls[0]).toEqual(["postgres", [
      { composeFile: file, composeProject: "swarm-os", composeEnv: { SWARM_DEDICATED_PG_PORT: "49337", SWARM_DEDICATED_META_PG_PORT: "49337" }, services: ["swarm-substrate"] },
      { postgresUrl: PG_URL, metaPostgresUrl: PG_URL },
      true,
    ]]);
    expect(readFileSync(file, "utf8")).toBe(readFileSync(TEMPLATE, "utf8"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("skips Postgres for a memory store", async () => {
    const { calls, lifecycle } = recorder();
    await ensureOsStack(makeConfig({ os_stack: { postgres_url: "memory" } }), { osHome, log: quiet, lifecycle });
    expect(calls.map(([step]) => step)).toEqual(["sidecars", "types"]);
    expect(existsSync(osComposeFile(osHome))).toBe(false);
  });

  it("stops when its Postgres stays down, naming host, port and compose project but never the credentials", async () => {
    const { calls, lifecycle } = recorder({ postgresUp: false });
    const err = await ensureOsStack(makeConfig(), { osHome, log: quiet, lifecycle }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OsStackError);
    expect(err).toMatchObject({ code: "postgres_unreachable" });
    expect((err as Error).message).toContain("127.0.0.1:49337");
    expect((err as Error).message).toContain("swarm-os");
    expect((err as Error).message).not.toContain("swarm:swarm");
    expect(calls.map(([step]) => step)).toEqual(["postgres"]);
  });

  it("starts exactly its own sidecar with no embedder, passing tarball, runtime, hook and timeout through", async () => {
    const { calls, lifecycle } = recorder();
    const beforeReinstall = async () => {};
    await ensureOsStack(makeConfig(), {
      osHome, log: quiet, lifecycle, beforeReinstall, bootTimeoutMs: 20_000,
      pluginTarball: "/path/to/swarm-substrate-plugin.tgz", runtimeDir: "/path/to/runtime",
    });
    const [, [quietFlag, opts]] = calls.find(([step]) => step === "sidecars")!;
    expect(quietFlag).toBe(true);
    expect(opts).toMatchObject({
      specs: [osSidecarSpec(makeConfig())], embedder: { kind: "none" }, contextNamespace: "cortext",
      pluginTarball: "/path/to/swarm-substrate-plugin.tgz", runtimeDir: "/path/to/runtime", beforeReinstall, bootTimeoutMs: 20_000,
    });
  });

  it("checks the swarm-os types and returns a swarm-os client on the sidecar's loopback URL", async () => {
    const { calls, lifecycle } = recorder();
    const client = await ensureOsStack(makeConfig(), { osHome, log: quiet, lifecycle });
    expect(client.endpoint).toBe("http://127.0.0.1:49338");
    expect(client.namespace).toBe("swarm-os");
    expect(calls.find(([step]) => step === "types")).toEqual(["types", [client, [osSidecarSpec(makeConfig())], true]]);
  });

  it("leaves process.env as it found it", async () => {
    const before = { ...process.env };
    await ensureOsStack(makeConfig(), { osHome, log: quiet, lifecycle: recorder().lifecycle });
    expect(process.env).toEqual(before);
  });

  it("reads the dedicated compose template outside a Bun binary, and writes it under ~/.swarm/os by default", async () => {
    expect(await loadComposeTemplate()).toBe(readFileSync(TEMPLATE, "utf8"));
    const saved = process.env.SWARM_OS_HOME;
    delete process.env.SWARM_OS_HOME;
    try {
      await ensureOsStack(makeConfig(), { log: quiet, lifecycle: recorder().lifecycle });
      expect(existsSync(join(home, ".swarm", "os", "stack", "docker-compose.dedicated.yml"))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.SWARM_OS_HOME = saved;
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/os && npx vitest run tests/stack/os-stack.test.ts`
Expected: FAIL, `Failed to load url ../../src/stack/os-stack.js`.

- [ ] **Step 3: Embed the compose template for the binary**

`packages/os/src/stack/compose-embed.ts`, the pattern of `packages/cli/src/server/dashboard-embed.ts`:

```ts
// Resolved by Bun's bundler at compile time: the dedicated compose template
// becomes a string constant in the binary. Under Node this module fails to
// load (no `with { type: "text" }`), and os-stack.ts reads the file instead.

// @ts-ignore — Bun text import
import template from "./docker-compose.dedicated.yml" with { type: "text" };
export default template as string;
```

In `packages/os/package.json`, `"build": "tsc && cp ../../docker-compose.dedicated.yml dist/src/stack/docker-compose.dedicated.yml"`. In `turbo.json`, add a task so the copy is rebuilt when the template changes:

```json
"@mnmal-ai/swarm-os#build": {
  "dependsOn": ["^build"],
  "env": ["SWARM_VERSION_OVERRIDE"],
  "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/docker-compose.dedicated.yml"],
  "outputs": ["dist/**"]
}
```

- [ ] **Step 4: Implement `src/stack/os-stack.ts`**

- `osSidecarSpec`: `{ label: "cold", scope: "os", namespace: SWARM_OS_NAMESPACE, port, postgresUrl: postgres_url, postgresUrlSource: "os.json os_stack.postgres_url", stack: compose_project }`.
- `loadComposeTemplate`: `await import("./compose-embed.js")` and use its default when it is a string naming `swarm-substrate`; otherwise (Node, vitest) walk up from this module's directory, at most six levels, to the first `docker-compose.dedicated.yml` naming `swarm-substrate` (`dist/src/stack/` under Node, the repo root from `src/stack/`); none → `OsStackError("compose_template_missing")`.
- `ensureOsStack`, in this order, every lifecycle call with `quiet: true`, never writing `process.env`:
  1. Unless `isMemoryStore(postgres_url)`: write the template to `osComposeFile(osHome)` (directory `0700`, file `0600`, rewritten only when its content differs), then `ensureDedicatedPostgres({ composeFile, composeProject: compose_project, composeEnv: { SWARM_DEDICATED_PG_PORT: <port of postgres_url, "5432" when absent>, SWARM_DEDICATED_META_PG_PORT: <the same>, }, services: [OS_STACK_POSTGRES_SERVICE] }, { postgresUrl: postgres_url, metaPostgresUrl: postgres_url }, true)`. The meta variable only satisfies the template's interpolation; the `swarm-meta` service is never started. `false` → `OsStackError("postgres_unreachable", …)` whose message names `host:port` (from `new URL(postgres_url)`, never the URL itself), the compose project, and the command that starts it (`docker compose -p <project> -f <file> up -d --wait swarm-substrate`).
  2. `ensureAllSidecars(true, { specs: [spec], embedder: resolveEmbedderSettings({ SWARM_EMBEDDER_KIND: "none" }), contextNamespace: DEFAULT_CONTEXT_NAMESPACE, …pluginTarball, runtimeDir, beforeReinstall, bootTimeoutMs only when given })`.
  3. `client = new SubstrateClient(sidecarUrl(spec), { namespace: SWARM_OS_NAMESPACE })`; `ensureTypesRegistered(client, [spec], true)`.
  4. `log.info("os_stack.ready", { endpoint: client.endpoint, stack: compose_project })`; return `client`.
- Exports: every value and type in this task's Produces block from the plan-02 block of `src/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (10 files).

Run: `pnpm -w build && ls packages/os/dist/src/stack/docker-compose.dedicated.yml`
Expected: build exit 0, every turbo task successful; the file is listed.

- [ ] **Step 6: Commit**

```bash
git add packages/os turbo.json
git commit -m "feat(os): ensureOsStack brings the brain's own Substrate stack up"
```

### Task 10: The store and replay on a real os-scope sidecar

**Files:**
- Create: `tests/integration/os-store.test.ts`
- Modify: `tests/integration/package.json` (dependency), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `ensureOsStack`, `osSidecarSpec`, `EnsureOsStackOptions` (Task 9); `SubstrateOsStore` (Task 6); `MemoryOsStore` (Task 5); `Journal`, `journaledStore` (Tasks 7, 8); `REPO_NAMES`, `REPO_TYPES`, `Repo`, `OsStore` (Task 4); `createLogger` (Task 3); `makeConfig`, `makeRow`, `TestOsConfig` from `@mnmal-ai/swarm-os/testing`; `stackDirFor`, `stopSidecar` from `@mnmal-ai/swarm-substrate`; `REPO_ROOT`, `RESERVED_PORTS` from `tests/setup/isolated-substrate.ts`.
- Produces: nothing new.

- [ ] **Step 1: Write the test**

`tests/integration/os-store.test.ts`:

```ts
/**
 * The swarm-os store on a real os-scope Substrate sidecar that ensureOsStack
 * brings up itself: a temp HOME, a runtime directory linking the workspace's
 * Substrate and the built plugin, the memory store, an ephemeral port.
 * Runs only under SWARM_SDK_E2E=1, after `pnpm -w build`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger, ensureOsStack, type EnsureOsStackOptions, Journal, journaledStore, MemoryOsStore, type OsStore,
  osSidecarSpec, REPO_NAMES, REPO_TYPES, type Repo, SubstrateOsStore,
} from "@mnmal-ai/swarm-os";
import { makeConfig, makeRow, type TestOsConfig } from "@mnmal-ai/swarm-os/testing";
import { stackDirFor, stopSidecar, type SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, RESERVED_PORTS } from "../setup/isolated-substrate.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";
const quiet = createLogger("os-store-e2e", { sink: () => {} });

/** A loopback port nothing listens on, outside the reserved ranges. */
async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((done) => server.close(() => done()));
    if (port > 0 && !RESERVED_PORTS.has(port)) return port;
  }
}

/** A runtime directory findInstalledRuntime accepts: the workspace's Substrate and built plugin, linked, plus a marker. */
function linkedRuntime(root: string): string {
  const scope = join(root, "runtime", "node_modules", "@mnmal-ai");
  mkdirSync(scope, { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules", "@mnmal-ai", "substrate"), join(scope, "substrate"), "dir");
  symlinkSync(join(REPO_ROOT, "packages", "substrate-plugin"), join(scope, "swarm-substrate-plugin"), "dir");
  writeFileSync(join(root, "runtime", ".installed-e2e"), "");
  return join(root, "runtime");
}

/** A row as Substrate returns it: createdAt is the server's own time. */
const fromServer = (row: object) => ("createdAt" in row ? { ...row, createdAt: expect.any(String) } : row);

describe.skipIf(!RUN_E2E)("swarm-os store on a real os-scope sidecar", () => {
  let root: string;
  let savedHome: string | undefined;
  let config: TestOsConfig;
  let opts: EnsureOsStackOptions;
  let client: SubstrateClient;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-os-e2e-")));
    savedHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    config = makeConfig({ os_stack: { port: await freePort(), postgres_url: "memory", compose_project: "swarm-os-e2e" } });
    opts = { runtimeDir: linkedRuntime(root), osHome: join(root, "os"), log: quiet };
    client = await ensureOsStack(config, opts);
  }, 90_000);

  afterAll(async () => {
    if (config !== undefined) await stopSidecar(osSidecarSpec(config));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("serves the thirteen swarm-os types and no other swarm namespace", async () => {
    const res = await fetch(`${client.endpoint}/substrate/v1/schema/swarm-os`);
    const types = Object.keys(((await res.json()) as { types: Record<string, unknown> }).types);
    expect(types.sort()).toEqual(Object.values(REPO_TYPES).sort());
    for (const ns of ["swarm", "swarm-docs", "swarm_meta"]) {
      expect((await fetch(`${client.endpoint}/substrate/v1/schema/${ns}`)).status, ns).toBe(404);
    }
  });

  it("runs from <compose_project>-cold with scope os and namespace swarm", () => {
    const dir = stackDirFor(osSidecarSpec(config));
    expect(dir).toBe(join(root, "home", ".swarm", "substrate", "stacks", "swarm-os-e2e-cold"));
    expect(JSON.parse(readFileSync(join(dir, "swarm.config.json"), "utf8"))).toMatchObject({ scope: "os", namespace: "swarm" });
  });

  it("round-trips a row of every repo", async () => {
    const store = new SubstrateOsStore(client);
    for (const repo of REPO_NAMES) {
      const row = makeRow(repo);
      const repoStore = store[repo] as unknown as Repo<{ id: string }>;
      await repoStore.put(row);
      expect(await repoStore.get(row.id), repo).toEqual(fromServer(row));
    }
  });

  it("filters, orders, patches, deletes and numbers messages as MemoryOsStore does", async () => {
    const scenario = async (store: OsStore) => {
      const room = makeRow("rooms", { kind: "instance" });
      await store.rooms.put(room);
      for (const body of ["first", "second", "third"]) {
        await store.messages.put(makeRow("messages", { roomId: room.id, body, seq: await store.nextSeq(room.id) }));
      }
      const latest = await store.messages.find({ roomId: room.id }, { orderBy: "seq", desc: true, limit: 2 });
      await store.messages.patch(latest[0]!.id, { body: "third, edited" });
      await store.messages.delete(latest[1]!.id);
      const after = await store.messages.find({ roomId: room.id }, { orderBy: "seq" });
      return { latest: latest.map((m) => [m.seq, m.body]), after: after.map((m) => [m.seq, m.body]), next: await store.nextSeq(room.id) };
    };
    const onSubstrate = await scenario(new SubstrateOsStore(client));
    expect(onSubstrate).toEqual(await scenario(new MemoryOsStore()));
    expect(onSubstrate).toEqual({ latest: [[3, "third"], [2, "second"]], after: [[1, "first"], [3, "third, edited"]], next: 4 });
  });

  it("replays what was journaled while the sidecar was down into the sidecar that replaced it", async () => {
    const journaled = journaledStore(new SubstrateOsStore(client), new Journal(join(root, "journal"), { log: quiet }), new MemoryOsStore(), { log: quiet });
    await stopSidecar(osSidecarSpec(config));
    const room = makeRow("rooms");
    const msg = makeRow("messages", { roomId: room.id, seq: 1 });
    await journaled.rooms.put(room);
    await journaled.messages.put(msg);
    expect(journaled.degraded).toBe(true);
    await ensureOsStack(config, opts); // a new sidecar on the memory store: it starts empty
    expect(await journaled.replay()).toEqual({ applied: 2, superseded: 0, failed: [], pending: 0 });
    const store = new SubstrateOsStore(client);
    expect(await store.rooms.get(room.id)).toEqual(fromServer(room));
    expect(await store.messages.get(msg.id)).toEqual(msg);
  }, 60_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd tests/integration && npx vitest run os-store.test.ts`
Expected: FAIL, `Failed to resolve import "@mnmal-ai/swarm-os"` (the integration package does not depend on it yet).

- [ ] **Step 3: Add the dependency**

In `tests/integration/package.json` `dependencies`, add `"@mnmal-ai/swarm-os": "workspace:*"`. Run: `pnpm install && pnpm -w build`. Expected: both exit 0.

- [ ] **Step 4: Run it, plain and E2E**

Run: `cd tests/integration && env -u ANTHROPIC_API_KEY npx vitest run os-store.test.ts`
Expected: 5 skipped, 0 failed.

Run: `cd tests/integration && env -u ANTHROPIC_API_KEY SWARM_SDK_E2E=1 npx vitest run os-store.test.ts`
Expected: 5 passed (the global setup also boots its own cold and meta pair first). Nothing binds 32337-32341 or 42337-42341, no Docker runs, and `~/.swarm` is untouched.

- [ ] **Step 5: Run every suite and the build**

Run: `env -u ANTHROPIC_API_KEY pnpm turbo test && pnpm -w build`
Expected: every turbo test task passes (the CLI suite, `@mnmal-ai/swarm-os`, `@mnmal-ai/swarm-substrate`, `@mnmal-ai/swarm-substrate-plugin` and the integration package included); the build exits 0.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/os-store.test.ts tests/integration/package.json pnpm-lock.yaml
git commit -m "test(integration): swarm-os store and journal replay on a real os-scope sidecar"
```

### Task 11: Metrics

The store layer's share of the owner's metrics requirement: every `SubstrateOsStore` call by op, row kind and outcome, with rows per read and errors by code; the caller's view through `journaledStore` (write time by outcome, the write chain's queue, reads served from the snapshot while the store is down, the outage itself); the journal's append time, size, depth and bytes on disk, and each replay; and `ensureOsStack` step by step. Plan 03 hands `BrainContext.metrics` to every constructor named here.

**Files:**
- Modify: `packages/os/package.json` (`"@mnmal-ai/swarm-metrics": "workspace:*"` in `dependencies`; later plans assume it), `pnpm-lock.yaml`
- Modify: `packages/metrics/src/catalogue/os.ts` (this plan's block, in the `// plan 02` slot of `OS_METRICS`)
- Modify: `packages/os/src/store/substrate-store.ts`, `packages/os/src/journal/journal.ts`, `packages/os/src/stack/os-stack.ts`
- Create: `packages/os/tests/metrics/helpers.ts` (snapshot lookups; plans 03 to 09 may reuse them)
- Test: `packages/os/tests/metrics/store-metrics.test.ts`, `packages/os/tests/stack/os-stack.test.ts` (append)

**Interfaces:**
- Consumes: `Metrics`, `noopMetrics`, `Labels`, `MetricsSnapshot`, `OS_METRICS` from `@mnmal-ai/swarm-metrics`, `testRegistry` from `@mnmal-ai/swarm-metrics/testing` (plan 10); Tasks 3 to 9.
- Produces:

```ts
// src/store/substrate-store.ts
export class SubstrateOsStore implements OsStore {
  constructor(client: OsSubstrateClient, opts?: { metrics?: Metrics });   // default noopMetrics
}
// src/journal/journal.ts
export interface JournalOptions { clock?: Clock; log?: Logger; metrics?: Metrics }
export interface JournaledStoreOptions { clock?: Clock; log?: Logger; metrics?: Metrics }
// src/stack/os-stack.ts
export interface EnsureOsStackOptions { /* Task 9's fields */ metrics?: Metrics }
export type OsStackStep = "template" | "postgres" | "sidecars" | "types";

// tests/metrics/helpers.ts
export function hist(s: MetricsSnapshot, name: string, labels?: Labels): HistogramSnapshot | undefined;   // the first series of that name whose labels include `labels`
export function counter(s: MetricsSnapshot, name: string, labels?: Labels): number;                      // the sum over matching series, 0 when none
export function gauge(s: MetricsSnapshot, name: string, labels?: Labels): number | undefined;
```

Catalogue rows (`kind` is a `RepoName`, `messages` for `next_seq` and `none` for `ping`; `code` is an `OsStoreErrorCode`):

| Name | Kind | Unit | Labels (values) | Recorded in |
|---|---|---|---|---|
| `swarm_os_store_op_seconds` | histogram | seconds | `op` (`get`, `put`, `patch`, `delete`, `find`, `next_seq`, `ping`), `kind`, `outcome` (`ok`, `not_found`, `deleted`, `refused`, `unreachable`) | `SubstrateOsStore`: each public `Repo` method, `nextSeq` and `ping` (a `false` ping ends `unreachable`) |
| `swarm_os_store_read_rows` | histogram | count | `op` (`get`, `find`), `kind` | `SubstrateOsStore` `get` (0 or 1) and `find` |
| `swarm_os_store_errors_total` | counter | count | `op`, `kind`, `code` | `SubstrateOsStore`, for every `OsStoreError` it throws |
| `swarm_os_store_write_seconds` | histogram | seconds | `op` (`put`, `patch`, `delete`), `kind`, `outcome` (`stored`, `journaled`, `refused`, `unreachable`, `journal_error`) | `journaledStore`'s writes, from the call to the result its caller gets (rules 4 to 6) |
| `swarm_os_store_write_wait_seconds` | histogram | seconds | `op` (`put`, `patch`, `delete`), `outcome` (`ok`) | `journaledStore`: from a write's call to its turn on the write chain (rule 3) |
| `swarm_os_store_queued_writes` | gauge | count | none | `journaledStore`: writes called and not yet settled, raised synchronously at the call |
| `swarm_os_store_snapshot_reads_total` | counter | count | `op` (`get`, `find`, `next_seq`), `kind` | `journaledStore`, each read answered from the snapshot (degraded, or the store call failed `unreachable`) |
| `swarm_os_store_degraded` | gauge | count | none | `journaledStore`: 1 while `degraded`, else 0, set on every change |
| `swarm_os_store_outage_seconds` | histogram | seconds | none | `journaledStore`: each spell `degraded` is true |
| `swarm_os_store_stack_seconds` | histogram | seconds | `step` (`OsStackStep`), `outcome` (`ok`, `error`) | `ensureOsStack`, each step it runs (a memory store skips `template` and `postgres`) |
| `swarm_os_journal_append_seconds` | histogram | seconds | `outcome` (`ok`, `error`) | `Journal.append`, lazy initialisation and `datasync` included |
| `swarm_os_journal_append_bytes` | histogram | bytes | none | `Journal.append`: the line's UTF-8 length |
| `swarm_os_journal_unreplayed_entries` | gauge | count | none | `Journal`: highest seq minus the replayed mark, set at initialisation, on every append and on every `markReplayed` |
| `swarm_os_journal_disk_bytes` | gauge | bytes | none | `Journal`: the `journal-*.ndjson` files' sizes, summed at initialisation, raised by each append, lowered by the files `markReplayed` deletes |
| `swarm_os_journal_mark_seconds` | histogram | seconds | `outcome` (`ok`, `error`) | `Journal.markReplayed` (temp file, `datasync`, rename, deletions) |
| `swarm_os_journal_read_seconds` | histogram | seconds | `outcome` (`ok`, `error`) | `Journal.unreplayed` |
| `swarm_os_journal_torn_lines_total` | counter | count | none | `Journal.unreplayed`, beside its `journal.torn_line` warning |
| `swarm_os_journal_replay_seconds` | histogram | seconds | `outcome` (`complete`, `stopped`) | `JournaledOsStore.replay`, when it found at least one entry (`stopped`: the store went away mid-run) |
| `swarm_os_journal_replayed_entries_total` | counter | count | `outcome` (`applied`, `superseded`, `failed`) | `JournaledOsStore.replay`, per entry it marks |

The `MetricDef` entries, appended in the `// plan 02` slot:

```ts
  // plan 02
  { name: "swarm_os_store_op_seconds", kind: "histogram", unit: "seconds", help: "OS store calls on Substrate, by op, row kind and outcome", labels: ["op", "kind", "outcome"] },
  { name: "swarm_os_store_read_rows", kind: "histogram", unit: "count", help: "Rows returned per OS store read", labels: ["op", "kind"] },
  { name: "swarm_os_store_errors_total", kind: "counter", unit: "count", help: "OS store errors, by op, row kind and code", labels: ["op", "kind", "code"] },
  { name: "swarm_os_store_write_seconds", kind: "histogram", unit: "seconds", help: "Brain writes through the journal, by op, row kind and where they landed", labels: ["op", "kind", "outcome"] },
  { name: "swarm_os_store_write_wait_seconds", kind: "histogram", unit: "seconds", help: "Time a write waited for its turn on the write chain", labels: ["op", "outcome"] },
  { name: "swarm_os_store_queued_writes", kind: "gauge", unit: "count", help: "Writes called and not yet settled", labels: [] },
  { name: "swarm_os_store_snapshot_reads_total", kind: "counter", unit: "count", help: "Reads served from the snapshot while the store was unreachable", labels: ["op", "kind"] },
  { name: "swarm_os_store_degraded", kind: "gauge", unit: "count", help: "1 while the OS store is degraded, else 0", labels: [] },
  { name: "swarm_os_store_outage_seconds", kind: "histogram", unit: "seconds", help: "Each spell the OS store was degraded", labels: [] },
  { name: "swarm_os_store_stack_seconds", kind: "histogram", unit: "seconds", help: "ensureOsStack, by step and outcome", labels: ["step", "outcome"] },
  { name: "swarm_os_journal_append_seconds", kind: "histogram", unit: "seconds", help: "Journal appends, datasync included", labels: ["outcome"] },
  { name: "swarm_os_journal_append_bytes", kind: "histogram", unit: "bytes", help: "Size of each journal line", labels: [] },
  { name: "swarm_os_journal_unreplayed_entries", kind: "gauge", unit: "count", help: "Journal entries not yet replayed into the store", labels: [] },
  { name: "swarm_os_journal_disk_bytes", kind: "gauge", unit: "bytes", help: "Bytes of journal files on disk", labels: [] },
  { name: "swarm_os_journal_mark_seconds", kind: "histogram", unit: "seconds", help: "Journal markReplayed calls", labels: ["outcome"] },
  { name: "swarm_os_journal_read_seconds", kind: "histogram", unit: "seconds", help: "Journal reads of the unreplayed entries", labels: ["outcome"] },
  { name: "swarm_os_journal_torn_lines_total", kind: "counter", unit: "count", help: "Torn last lines skipped while reading the journal", labels: [] },
  { name: "swarm_os_journal_replay_seconds", kind: "histogram", unit: "seconds", help: "Journal replays that found entries, by outcome", labels: ["outcome"] },
  { name: "swarm_os_journal_replayed_entries_total", kind: "counter", unit: "count", help: "Journal entries marked by replay, by outcome", labels: ["outcome"] },
```

- [ ] **Step 1: Add the dependency and write the failing tests**

In `packages/os/package.json` `dependencies`, add `"@mnmal-ai/swarm-metrics": "workspace:*"`. Run: `pnpm install`. Expected: exit 0.

`packages/os/tests/metrics/helpers.ts`:

```ts
import type { HistogramSnapshot, Labels, MetricsSnapshot } from "@mnmal-ai/swarm-metrics";

const has = (have: Labels, want: Labels) => Object.entries(want).every(([k, v]) => have[k] === v);
export const hist = (s: MetricsSnapshot, name: string, labels: Labels = {}): HistogramSnapshot | undefined =>
  s.histograms.find((h) => h.name === name && has(h.labels, labels));
export const counter = (s: MetricsSnapshot, name: string, labels: Labels = {}): number =>
  s.counters.filter((c) => c.name === name && has(c.labels, labels)).reduce((n, c) => n + c.value, 0);
export const gauge = (s: MetricsSnapshot, name: string, labels: Labels = {}): number | undefined =>
  s.gauges.find((g) => g.name === name && has(g.labels, labels))?.value;
```

`packages/os/tests/metrics/store-metrics.test.ts`:

```ts
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OS_METRICS } from "@mnmal-ai/swarm-metrics";
import { testRegistry } from "@mnmal-ai/swarm-metrics/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Journal, journaledStore } from "../../src/journal/journal.js";
import { createLogger } from "../../src/log.js";
import { MemoryOsStore } from "../../src/store/memory-store.js";
import { SubstrateOsStore } from "../../src/store/substrate-store.js";
import { FakeClock, FakeSubstrateClient, makeRow } from "../../src/testing/index.js";
import { counter, gauge, hist } from "./helpers.js";

const quiet = createLogger("test", { sink: () => {} });
const roots: string[] = [];
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-os-metrics-"));
  roots.push(root);
  return join(root, "journal");
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const put = (id: string) => ({ op: "put" as const, type: "rooms" as const, id, payload: { id } });

describe("SubstrateOsStore metrics", () => {
  it("times every call by op, row kind and outcome, with rows per read", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const store = new SubstrateOsStore(new FakeSubstrateClient({ clock: new FakeClock() }), { metrics });
    const room = makeRow("rooms");
    await store.rooms.put(room);
    await store.rooms.get(room.id);
    await store.rooms.get("room-unknown");
    await store.rooms.find({});
    await store.rooms.patch(room.id, { name: "board-b" });
    await store.rooms.delete(room.id);
    await store.nextSeq("room-a");
    await store.ping();
    await expect(store.instances.patch("inst-unknown", { state: "failed" })).rejects.toMatchObject({ code: "not_found" });
    const s = metrics.snapshot();
    for (const op of ["put", "find", "patch", "delete"]) expect(hist(s, "swarm_os_store_op_seconds", { op, kind: "rooms", outcome: "ok" })?.count, op).toBe(1);
    expect(hist(s, "swarm_os_store_op_seconds", { op: "get", kind: "rooms", outcome: "ok" })?.count).toBe(2);   // put's own existence check is not a get
    expect(hist(s, "swarm_os_store_op_seconds", { op: "next_seq", kind: "messages", outcome: "ok" })?.count).toBe(1);
    expect(hist(s, "swarm_os_store_op_seconds", { op: "ping", kind: "none", outcome: "ok" })?.count).toBe(1);
    expect(hist(s, "swarm_os_store_op_seconds", { op: "patch", kind: "instances", outcome: "not_found" })?.count).toBe(1);
    expect(hist(s, "swarm_os_store_read_rows", { op: "get", kind: "rooms" })).toMatchObject({ count: 2, sum: 1 });
    expect(hist(s, "swarm_os_store_read_rows", { op: "find", kind: "rooms" })).toMatchObject({ count: 1, sum: 1 });
    expect(counter(s, "swarm_os_store_errors_total", { op: "patch", kind: "instances", code: "not_found" })).toBe(1);
  });

  it("counts unreachable calls, and a ping that finds the store down", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    const client = new FakeSubstrateClient({ clock: new FakeClock() });
    const store = new SubstrateOsStore(client, { metrics });
    client.down = true;
    await expect(store.boards.get("board-x")).rejects.toMatchObject({ code: "unreachable" });
    expect(await store.ping()).toBe(false);
    const s = metrics.snapshot();
    expect(counter(s, "swarm_os_store_errors_total", { op: "get", kind: "boards", code: "unreachable" })).toBe(1);
    expect(hist(s, "swarm_os_store_op_seconds", { op: "ping", kind: "none", outcome: "unreachable" })?.count).toBe(1);
  });
});

describe("Journal metrics", () => {
  it("times and sizes appends, and tracks unreplayed entries and bytes on disk across files", async () => {
    const dir = tempDir();
    const first = new Journal(dir, { log: quiet });
    await first.append(put("room-a"));
    await first.append(put("room-b"));
    const { metrics } = testRegistry(OS_METRICS);
    const second = new Journal(dir, { log: quiet, metrics });
    await second.append(put("room-c"));
    const size = (file: string) => statSync(join(dir, file)).size;
    let s = metrics.snapshot();
    expect(hist(s, "swarm_os_journal_append_seconds", { outcome: "ok" })?.count).toBe(1);
    expect(hist(s, "swarm_os_journal_append_bytes")).toMatchObject({ count: 1, sum: size("journal-2.ndjson") });
    expect(gauge(s, "swarm_os_journal_unreplayed_entries")).toBe(3);
    expect(gauge(s, "swarm_os_journal_disk_bytes")).toBe(size("journal-1.ndjson") + size("journal-2.ndjson"));
    await second.markReplayed(3);
    s = metrics.snapshot();
    expect(hist(s, "swarm_os_journal_mark_seconds", { outcome: "ok" })?.count).toBe(1);
    expect(gauge(s, "swarm_os_journal_unreplayed_entries")).toBe(0);
    expect(gauge(s, "swarm_os_journal_disk_bytes")).toBe(size("journal-2.ndjson"));
  });

  it("counts torn lines and failed appends", async () => {
    const dir = tempDir();
    await new Journal(dir, { log: quiet }).append(put("room-a"));
    appendFileSync(join(dir, "journal-1.ndjson"), '{"seq":2,"at":"2026-01-01T00:00:00.000Z","op":"put","ty');
    const { metrics } = testRegistry(OS_METRICS);
    await new Journal(dir, { log: quiet, metrics }).unreplayed();
    await new Journal(join(dir, "journal-1.ndjson", "journal"), { log: quiet, metrics }).append(put("room-b")).catch(() => {});   // a directory under a regular file
    const s = metrics.snapshot();
    expect(counter(s, "swarm_os_journal_torn_lines_total")).toBe(1);
    expect(hist(s, "swarm_os_journal_read_seconds", { outcome: "ok" })?.count).toBe(1);
    expect(hist(s, "swarm_os_journal_append_seconds", { outcome: "error" })?.count).toBe(1);
  });
});

describe("journaledStore metrics", () => {
  function setup() {
    const { metrics, clock } = testRegistry(OS_METRICS);
    const brainClock = new FakeClock();
    const client = new FakeSubstrateClient({ clock: brainClock });
    const journal = new Journal(tempDir(), { clock: brainClock, log: quiet, metrics });
    const store = journaledStore(new SubstrateOsStore(client, { metrics }), journal, new MemoryOsStore(), { clock: brainClock, log: quiet, metrics });
    return { metrics, clock, client, store };
  }

  it("counts writes by where they landed, snapshot reads and the outage while the store is down, then the replay", async () => {
    const { metrics, clock, client, store } = setup();
    const kept = makeRow("rooms");
    await store.rooms.put(kept);
    client.down = true;
    await store.rooms.put(makeRow("rooms"));
    await store.rooms.get(kept.id);
    await store.rooms.find({});
    await store.nextSeq("room-a");
    let s = metrics.snapshot();
    expect(hist(s, "swarm_os_store_write_seconds", { op: "put", kind: "rooms", outcome: "stored" })?.count).toBe(1);
    expect(hist(s, "swarm_os_store_write_seconds", { op: "put", kind: "rooms", outcome: "journaled" })?.count).toBe(1);
    expect(counter(s, "swarm_os_store_errors_total", { op: "put", kind: "rooms", code: "unreachable" })).toBe(1);
    expect(counter(s, "swarm_os_store_snapshot_reads_total", { op: "get", kind: "rooms" })).toBe(1);
    expect(counter(s, "swarm_os_store_snapshot_reads_total", { op: "find", kind: "rooms" })).toBe(1);
    expect(counter(s, "swarm_os_store_snapshot_reads_total", { op: "next_seq", kind: "messages" })).toBe(1);
    expect(gauge(s, "swarm_os_store_degraded")).toBe(1);
    expect(gauge(s, "swarm_os_journal_unreplayed_entries")).toBe(1);
    clock.advance(30_000);
    client.down = false;
    await store.replay();
    s = metrics.snapshot();
    expect(hist(s, "swarm_os_journal_replay_seconds", { outcome: "complete" })?.count).toBe(1);
    expect(counter(s, "swarm_os_journal_replayed_entries_total", { outcome: "applied" })).toBe(1);
    expect(gauge(s, "swarm_os_store_degraded")).toBe(0);
    expect(hist(s, "swarm_os_store_outage_seconds")).toMatchObject({ count: 1, sum: 30 });
  });

  it("measures the write chain's depth and each write's wait for its turn", async () => {
    const { metrics, store } = setup();
    const inst = makeRow("instances", { tokens: 0 });
    await store.instances.put(inst);
    const writes = [1, 2, 3].map((tokens) => store.instances.patch(inst.id, { tokens }));
    expect(gauge(metrics.snapshot(), "swarm_os_store_queued_writes")).toBe(3);
    await Promise.all(writes);
    const s = metrics.snapshot();
    expect(gauge(s, "swarm_os_store_queued_writes")).toBe(0);
    expect(hist(s, "swarm_os_store_write_wait_seconds", { op: "patch", outcome: "ok" })?.count).toBe(3);
  });
});
```

Append to `describe("ensureOsStack")` in `packages/os/tests/stack/os-stack.test.ts` (importing `OS_METRICS`, `testRegistry` and `hist` from `../metrics/helpers.js`):

```ts
  it("times each step it runs, and the step that failed", async () => {
    const { metrics } = testRegistry(OS_METRICS);
    await ensureOsStack(makeConfig(), { osHome, log: quiet, lifecycle: recorder().lifecycle, metrics });
    await ensureOsStack(makeConfig(), { osHome, log: quiet, lifecycle: recorder({ postgresUp: false }).lifecycle, metrics }).catch(() => {});
    await ensureOsStack(makeConfig({ os_stack: { postgres_url: "memory" } }), { osHome, log: quiet, lifecycle: recorder().lifecycle, metrics });
    const s = metrics.snapshot();
    expect(hist(s, "swarm_os_store_stack_seconds", { step: "template", outcome: "ok" })?.count).toBe(2);
    expect(hist(s, "swarm_os_store_stack_seconds", { step: "postgres", outcome: "ok" })?.count).toBe(1);
    expect(hist(s, "swarm_os_store_stack_seconds", { step: "postgres", outcome: "error" })?.count).toBe(1);
    for (const step of ["sidecars", "types"]) expect(hist(s, "swarm_os_store_stack_seconds", { step, outcome: "ok" })?.count, step).toBe(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mnmal-ai/swarm-metrics build && cd packages/os && npx vitest run tests/metrics/store-metrics.test.ts tests/stack/os-stack.test.ts`
Expected: FAIL. The constructors ignore `metrics`, so every `hist(...)` is `undefined`, every `counter(...)` is 0 and every `gauge(...)` is `undefined`.

- [ ] **Step 3: Implement**

1. Append the block above to `OS_METRICS` and run `pnpm --filter @mnmal-ai/swarm-metrics build`.
2. `SubstrateOsStore`: keep `opts.metrics ?? noopMetrics`. Each public `Repo` method of each repo, `nextSeq` and `ping` runs inside a `swarm_os_store_op_seconds` span labelled `{ op, kind }`, ended `ok` or with the `OsStoreError`'s `code`; before rethrowing, increment `swarm_os_store_errors_total { op, kind, code }`. `get` observes `swarm_os_store_read_rows` 0 or 1 and `find` the length it returns. `put`'s existence check calls a private, unmetered read, so it is part of the `put` span and never a `get`. `ping` ends `ok` for `true` and `unreachable` for `false`.
3. `Journal`: keep `opts.metrics ?? noopMetrics`.
   - `append` runs inside a `swarm_os_journal_append_seconds` span (lazy initialisation and `datasync` included), ended `ok` or `error` before a `JournalError` is rethrown; it observes the line's `Buffer.byteLength` in `swarm_os_journal_append_bytes`.
   - Initialisation sums the sizes of the `journal-*.ndjson` files it scans into the disk-bytes count and sets both gauges. The journal keeps its highest seq and its mark, so `swarm_os_journal_unreplayed_entries` is `max(0, highest - mark)`, set after initialisation, each append and each `markReplayed`; `swarm_os_journal_disk_bytes` rises by each line's bytes and falls by the size of each file `markReplayed` deletes (`stat` before `unlink`).
   - `markReplayed` runs inside a `swarm_os_journal_mark_seconds` span; `unreplayed` inside `swarm_os_journal_read_seconds`, incrementing `swarm_os_journal_torn_lines_total` where it logs `journal.torn_line`.
4. `journaledStore`: keep `opts.metrics ?? noopMetrics`.
   - Each write raises `swarm_os_store_queued_writes` synchronously when it is called, before its first `await`, and lowers it when it settles. It opens a `swarm_os_store_write_wait_seconds` span `{ op }` at the call, ended `ok` when its turn on the chain begins, and a `swarm_os_store_write_seconds` span `{ op, kind }` at the call, ended `stored` (the store took it), `journaled` (applied to the snapshot under rule 5's `unreachable` or rule 6), `refused` (validation, or a store refusal other than `unreachable`), `unreachable` (rule 6's patch with no snapshot row) or `journal_error`.
   - Every read the snapshot answers, under rule 7 or rule 8, increments `swarm_os_store_snapshot_reads_total { op, kind }` (`next_seq` with `kind: "messages"`).
   - One private setter changes `degraded`: it sets `swarm_os_store_degraded`, opens a `swarm_os_store_outage_seconds` span when it turns true and ends it when it turns false.
   - `replay()`, when it finds at least one entry, runs inside a `swarm_os_journal_replay_seconds` span ended `complete`, or `stopped` when an `unreachable` ends the run; each entry it marks increments `swarm_os_journal_replayed_entries_total` with `applied`, `superseded` or `failed`.
5. `ensureOsStack`: keep `opts.metrics ?? noopMetrics`. Steps 1 to 3 of Task 9 run as `template` (writing the compose file), `postgres` (`ensureDedicatedPostgres` and its `false` → `OsStackError`), `sidecars` (`ensureAllSidecars`) and `types` (`ensureTypesRegistered`), each inside a `swarm_os_store_stack_seconds` span `{ step }` ended `ok` or `error` before rethrowing; a memory store runs neither of the first two. When plan 10 gave `SubstrateClient` a metrics option, pass the same handle to the client this function builds, so the brain's Substrate requests are counted on plan 10's rows too.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/os && npx vitest run`
Expected: PASS (11 files; every earlier file unchanged).

Run: `pnpm -w build`
Expected: exit 0, every turbo task successful.

- [ ] **Step 5: Commit**

```bash
git add packages/os pnpm-lock.yaml packages/metrics/src/catalogue/os.ts
git -c commit.gpgsign=false commit -m "feat(os): measure the OS store, the journal, replay and the OS stack's bring-up"
```
