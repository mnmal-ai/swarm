/**
 * The drainstop over a composed engine: the swarm plugin (which owns
 * `swarm/Observation`) next to the cortext fixture (which owns the promotion
 * targets), driven through `runDrainstopOnce` and `expireObservations` on the
 * engine handle. Rows are seeded and read back through autoCRUD frames.
 */
import { type EngineHandle, queryAll } from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_SEED_BODY,
  createSwarmSubstratePlugin,
  ANCHOR_SEED_TAGS,
  CONCERN_RECURRENCE_MIN_GROUP_SIZE,
  DEFAULT_TTL_UNKNOWN_KIND_HOURS,
  DRAINSTOP_KIND_DEFAULTS,
  type DrainstopConfig,
  expireObservations,
  PROMOTION_AREA,
  PromotionWriteError,
  parseCategoryPrefix,
  runDrainstopOnce,
  tagSignature,
  withStrictPromotions,
} from "../src/index.js";
import { createCortextFixture, FIXTURE_REFUSED_CODE, FIXTURE_REFUSED_TITLE_MARKER } from "./cortext-fixture.js";
import { bootTestServer, type TestServer } from "./harness.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const CFG: DrainstopConfig = { planeNamespace: "swarm", contextNamespace: "cortext", now: NOW };

type ObservationInput = {
  kind: string;
  body: string;
  confidence?: number | null;
  tags?: string;
  ttlHours?: number | null;
  context?: string | null;
  ts?: Date;
};

/** Who the tests' own seed writes run as: the engine refuses an unattributed write. */
const SEEDER = { identity: { kind: "system", id: "drainstop-test", grants: { "*": ["read", "mutate"] } } };

const OBSERVATION_FIELDS = ["id", "ts", "kind", "body", "context", "confidence", "tags", "ttlHours", "isAnchor"];

let server: TestServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(withCortext = true): Promise<TestServer> {
  server = await bootTestServer({ scope: "cold", coordinators: withCortext ? [createCortextFixture()] : [] });
  return server;
}

async function observe(engine: EngineHandle, input: ObservationInput): Promise<string> {
  const key = "swarm/createObservation";
  const env = await engine.mutate({
    frame: {
      [key]: {
        params: {
          ts: (input.ts ?? NOW).toISOString(),
          kind: input.kind,
          body: input.body,
          context: input.context ?? null,
          confidence: input.confidence ?? null,
          tags: input.tags ?? "",
          ttlHours: input.ttlHours ?? null,
          isAnchor: null,
        },
        fields: { id: true },
      },
    },
    ctx: SEEDER,
  });
  expect(env.errors ?? []).toEqual([]);
  return String((env.data[key] as { id: string }).id);
}

async function rows<T = Record<string, unknown>>(
  engine: EngineHandle,
  ns: string,
  type: string,
  fields: string[],
  where?: Record<string, unknown>,
): Promise<T[]> {
  return queryAll<T>(engine, ns, type, where === undefined ? {} : { where }, ["id", ...fields]);
}

const observations = (engine: EngineHandle) => rows<Record<string, unknown>>(engine, "swarm", "Observation", OBSERVATION_FIELDS);
const nonAnchor = async (engine: EngineHandle) => (await observations(engine)).filter((o) => o.isAnchor !== true);

async function anchorId(engine: EngineHandle): Promise<string> {
  const anchors = await rows(engine, "swarm", "Observation", ["isAnchor"], { isAnchor: { eq: true } });
  expect(anchors).toHaveLength(1);
  return String(anchors[0]?.id);
}

async function updateObservation(engine: EngineHandle, id: string, patch: Record<string, unknown>): Promise<void> {
  const env = await engine.mutate({
    frame: { "swarm/updateObservation": { params: { id, ...patch }, fields: { id: true } } },
    ctx: SEEDER,
  });
  expect(env.errors ?? []).toEqual([]);
}

/** Write `count` observations in batched frames; `make(i)` gives each one's fields. */
async function observeMany(engine: EngineHandle, count: number, make: (i: number) => ObservationInput): Promise<void> {
  const BATCH = 150;
  for (let start = 0; start < count; start += BATCH) {
    const entries = [];
    for (let i = start; i < Math.min(count, start + BATCH); i++) {
      const input = make(i);
      entries.push({
        params: {
          ts: (input.ts ?? NOW).toISOString(),
          kind: input.kind,
          body: input.body,
          context: null,
          confidence: input.confidence ?? null,
          tags: input.tags ?? "",
          ttlHours: input.ttlHours ?? null,
          isAnchor: null,
        },
        fields: { id: true },
      });
    }
    const env = await engine.mutate({ frame: { "swarm/createObservation": entries }, ctx: SEEDER });
    expect(env.errors ?? []).toEqual([]);
  }
}

describe("runDrainstopOnce", () => {
  it("seeds the calibration anchor once", async () => {
    const { engine } = await boot();
    const first = await runDrainstopOnce(engine, CFG);
    const second = await runDrainstopOnce(engine, CFG);

    expect(first.anchorSeeded).toBe(true);
    expect(second.anchorSeeded).toBe(false);
    const anchors = await rows(engine, "swarm", "Observation", ["body", "confidence", "tags", "kind"], { isAnchor: { eq: true } });
    expect(anchors).toEqual([
      expect.objectContaining({ body: ANCHOR_SEED_BODY, confidence: 50, tags: ANCHOR_SEED_TAGS, kind: "user-framing" }),
    ]);
  });

  it("promotes fold-back-candidate to a Todo and deletes the observation", async () => {
    const { engine } = await boot();
    const id = await observe(engine, { kind: "fold-back-candidate", body: "Fold the retry helper back into core\nIt is duplicated." });

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.promoted).toEqual({ todos: 1, decisions: 0, agentRules: 0 });
    expect(result.failures).toEqual([]);
    expect(await nonAnchor(engine)).toEqual([]);
    const todos = await rows<Record<string, unknown>>(engine, "cortext", "Todo", ["title", "area", "status", "priority", "notes", "archived", "project"]);
    expect(todos).toEqual([
      expect.objectContaining({
        title: "Fold the retry helper back into core",
        area: PROMOTION_AREA,
        status: "open",
        priority: "medium",
        archived: false,
        project: null,
      }),
    ]);
    expect(todos[0]?.notes).toContain("It is duplicated.");
    expect(todos[0]?.notes).toContain(`swarm/Observation id=${id}`);
  });

  it("promotes architectural with confidence > 80 to a Decision with no session", async () => {
    const { engine } = await boot();
    const promoted = await observe(engine, { kind: "architectural", body: "Keep promotion copy-then-delete", confidence: 81, context: "drainstop.ts" });
    const kept = await observe(engine, { kind: "architectural", body: "At the threshold, not over it", confidence: 80 });

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.promoted).toEqual({ todos: 0, decisions: 1, agentRules: 0 });
    expect((await nonAnchor(engine)).map((o) => o.id)).toEqual([kept]);
    const decisions = await rows<Record<string, unknown>>(engine, "cortext", "Decision", ["topic", "choice", "rationale", "sessionId", "status"]);
    expect(decisions).toEqual([
      expect.objectContaining({
        topic: "Keep promotion copy-then-delete",
        choice: "Keep promotion copy-then-delete",
        status: "active",
      }),
    ]);
    expect(decisions[0]?.sessionId).toBeNull();
    expect(decisions[0]?.rationale).toContain("drainstop.ts");
    expect(decisions[0]?.rationale).toContain(`swarm/Observation id=${promoted}`);
    // No synthetic session row is written to point the Decision at.
    expect(await rows(engine, "cortext", "SessionLog", ["branch"])).toEqual([]);
  });

  it("promotes user-framing with confidence 100 to an AgentRule", async () => {
    const { engine } = await boot();
    await observe(engine, { kind: "user-framing", body: "[git] Never force-push a shared branch", confidence: 100 });
    await observe(engine, { kind: "user-framing", body: "Say what a command costs before running it", confidence: 100 });
    const kept = await observe(engine, { kind: "user-framing", body: "[git] Almost certain", confidence: 99 });

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.promoted).toEqual({ todos: 0, decisions: 0, agentRules: 2 });
    expect((await nonAnchor(engine)).map((o) => o.id)).toEqual([kept]);
    const rules = await rows<Record<string, unknown>>(engine, "cortext", "AgentRule", ["rule", "category", "active", "severity", "rationale"]);
    expect(rules).toHaveLength(2);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "Never force-push a shared branch", category: "git", active: false }),
        expect.objectContaining({ rule: "Say what a command costs before running it", category: "miscellaneous", active: false }),
      ]),
    );
    for (const rule of rules) expect(rule.rationale).toContain("swarm/Observation id=");
  });

  it("promotes a recurring concern once and absorbs later ones into the same Todo", async () => {
    const { engine } = await boot();
    for (let i = 0; i < CONCERN_RECURRENCE_MIN_GROUP_SIZE; i++) {
      await observe(engine, { kind: "concern", body: `flaky upload test #${i}`, tags: i === 0 ? "ci, flaky" : "flaky,ci,ci" });
    }
    const pair = [
      await observe(engine, { kind: "concern", body: "slow build", tags: "build" }),
      await observe(engine, { kind: "concern", body: "slow build again", tags: "build" }),
    ];

    const first = await runDrainstopOnce(engine, CFG);
    expect(first.promoted.todos).toBe(1);
    expect((await nonAnchor(engine)).map((o) => o.id).sort()).toEqual([...pair].sort());
    const todos = await rows<Record<string, unknown>>(engine, "cortext", "Todo", ["title", "notes"]);
    expect(todos).toEqual([expect.objectContaining({ title: "Recurrent concern: ci,flaky" })]);
    expect(todos[0]?.notes).toContain("flaky upload test #2");

    const later = await observe(engine, { kind: "concern", body: "flaky upload test, again", tags: "flaky,ci" });
    const second = await runDrainstopOnce(engine, CFG);
    expect(second.promoted.todos).toBe(0);
    expect(second.absorbed).toBe(1);
    const after = await rows<Record<string, unknown>>(engine, "cortext", "Todo", ["title", "notes"]);
    expect(after).toHaveLength(1);
    expect(after[0]?.notes).toContain(`- id=${later} ts=`);
    expect((await nonAnchor(engine)).map((o) => o.id).sort()).toEqual([...pair].sort());
  });

  it("expires observations past their kind TTL and keeps the anchor", async () => {
    const { engine } = await boot();
    await runDrainstopOnce(engine, CFG); // seeds the anchor
    const expiring = [
      await observe(engine, { kind: "rationale", body: "72h" }),
      await observe(engine, { kind: "pattern", body: "168h" }),
      await observe(engine, { kind: "concern", body: "168h, no recurrence group", tags: "lonely" }),
      await observe(engine, { kind: "some-new-kind", body: "unknown kind: 168h" }),
      await observe(engine, { kind: "architectural", body: "override wins", confidence: 10, ttlHours: 100 }),
    ];
    const keeping = [
      await observe(engine, { kind: "architectural", body: "never expires", confidence: 10 }),
      await observe(engine, { kind: "open-question", body: "never expires" }),
      await observe(engine, { kind: "rationale", body: "override keeps it", ttlHours: 500 }),
      await observe(engine, { kind: "rationale", body: "zero override falls through to 72h", ttlHours: 0, ts: new Date(NOW.getTime() + 150 * HOUR_MS) }),
    ];

    const result = await runDrainstopOnce(engine, { ...CFG, now: new Date(NOW.getTime() + 200 * HOUR_MS) });

    expect(result.expired).toBe(expiring.length);
    const left = await observations(engine);
    expect(left.filter((o) => o.isAnchor === true)).toHaveLength(1);
    expect(left.filter((o) => o.isAnchor !== true).map((o) => o.id).sort()).toEqual([...keeping].sort());
  });

  it("never expires the anchor, even with a finite ttlHours", async () => {
    const { engine } = await boot();
    await runDrainstopOnce(engine, CFG);
    const anchor = await anchorId(engine);
    await updateObservation(engine, anchor, { ttlHours: 1 });

    const result = await runDrainstopOnce(engine, { ...CFG, now: new Date(NOW.getTime() + 200 * HOUR_MS) });

    expect(result.expired).toBe(0);
    expect(result.failures).toEqual([]);
    expect(await anchorId(engine)).toBe(anchor);
  });

  it("never promotes the anchor, even when it is ratcheted to confidence 100", async () => {
    const { engine } = await boot();
    await runDrainstopOnce(engine, CFG);
    const anchor = await anchorId(engine);
    // The anchor is a user-framing row; at 100 it would otherwise qualify as an AgentRule.
    await updateObservation(engine, anchor, { confidence: 100 });

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.promoted).toEqual({ todos: 0, decisions: 0, agentRules: 0 });
    expect(result.failures).toEqual([]);
    expect(await anchorId(engine)).toBe(anchor);
    expect(await rows(engine, "cortext", "AgentRule", ["rule"])).toEqual([]);
  });

  it("pages through the whole table, so a full window of never-expiring rows cannot starve a newer one", async () => {
    const { engine } = await boot();
    const FILLER = 1049;
    // Kinds that never expire and never promote, older than the row that matters.
    await observeMany(engine, FILLER, (i) => ({
      kind: i % 2 === 0 ? "architectural" : "open-question",
      body: `filler ${i}`,
      confidence: i % 2 === 0 ? 50 : null,
      ts: new Date(NOW.getTime() + i * 1000),
    }));
    const last = await observe(engine, { kind: "fold-back-candidate", body: "row 1,050: promote me", ts: new Date(NOW.getTime() + FILLER * 1000) });

    // At one page, the run stops at the cap, reports it, and the newest row waits.
    const metrics: string[] = [];
    const capped = await runDrainstopOnce(engine, { ...CFG, maxPages: 1, metric: (name) => metrics.push(name) });
    expect(capped.truncated).toBe(true);
    expect(capped.promoted.todos).toBe(0);
    expect(metrics).toContain("swarm_drainstop_truncated");

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.truncated).toBe(false);
    expect(result.promoted).toEqual({ todos: 1, decisions: 0, agentRules: 0 });
    expect(result.failures).toEqual([]);
    expect(await rows(engine, "swarm", "Observation", ["kind"], { kind: { eq: "fold-back-candidate" } })).toEqual([]);
    const todos = await rows<Record<string, unknown>>(engine, "cortext", "Todo", ["title", "notes"]);
    expect(todos).toEqual([expect.objectContaining({ title: "row 1,050: promote me" })]);
    expect(todos[0]?.notes).toContain(`swarm/Observation id=${last}`);
    expect(await rows(engine, "swarm", "Observation", ["kind"], { kind: { eq: "open-question" } })).toHaveLength(Math.floor(FILLER / 2));
  });

  it("wraps a refused cortext write in PromotionWriteError and keeps the observation", async () => {
    const { engine } = await boot();
    const refused = await observe(engine, { kind: "fold-back-candidate", body: `please ${FIXTURE_REFUSED_TITLE_MARKER} this` });

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.promoted.todos).toBe(0);
    expect(result.failures).toEqual([
      expect.objectContaining({ observationId: refused, phase: "promote_todo", code: FIXTURE_REFUSED_CODE, name: "PromotionWriteError" }),
    ]);
    expect(result.failures[0]?.message).toContain("cortext/createTodo");
    expect((await nonAnchor(engine)).map((o) => o.id)).toEqual([refused]);
    expect(await rows(engine, "cortext", "Todo", ["title"])).toEqual([]);

    // The wrapper itself: an envelope error on a strict namespace throws.
    const strict = withStrictPromotions(engine, ["cortext"]);
    const attempt = strict.mutate({
      frame: {
        "cortext/createTodo": {
          params: { title: FIXTURE_REFUSED_TITLE_MARKER, area: "x", status: "open", priority: "low" },
          fields: { id: true },
        },
      },
      ctx: SEEDER,
    });
    await expect(attempt).rejects.toBeInstanceOf(PromotionWriteError);
    await expect(attempt).rejects.toMatchObject({ code: FIXTURE_REFUSED_CODE });
  });

  it("keeps every promotable observation when the context namespace is not loaded", async () => {
    const { engine } = await boot(false);
    const ids = [
      await observe(engine, { kind: "fold-back-candidate", body: "fold" }),
      await observe(engine, { kind: "architectural", body: "decide", confidence: 90 }),
      await observe(engine, { kind: "user-framing", body: "rule", confidence: 100 }),
    ];

    const result = await runDrainstopOnce(engine, CFG);

    expect(result.promoted).toEqual({ todos: 0, decisions: 0, agentRules: 0 });
    expect(result.failures.map((f) => f.observationId).sort()).toEqual([...ids].sort());
    expect((await nonAnchor(engine)).map((o) => o.id).sort()).toEqual([...ids].sort());
  });
});

describe("expireObservations", () => {
  it("deletes expired rows on its own, without promoting or seeding", async () => {
    const { engine } = await boot();
    const old = await observe(engine, { kind: "fold-back-candidate", body: "never promoted in time" });
    const fresh = await observe(engine, { kind: "fold-back-candidate", body: "still inside 48h", ts: new Date(NOW.getTime() + 40 * HOUR_MS) });

    const expired = await expireObservations(engine, { planeNamespace: "swarm", now: new Date(NOW.getTime() + 49 * HOUR_MS) });

    expect(expired).toBe(1);
    expect((await observations(engine)).map((o) => o.id)).toEqual([fresh]);
    expect(await rows(engine, "cortext", "Todo", ["title"])).toEqual([]);
    expect(old).not.toBe(fresh);
  });
});

describe("expireObservations and the anchor", () => {
  it("keeps the anchor whatever its ttlHours", async () => {
    const { engine } = await boot();
    await runDrainstopOnce(engine, CFG);
    const anchor = await anchorId(engine);
    await updateObservation(engine, anchor, { ttlHours: 1 });

    const expired = await expireObservations(engine, { planeNamespace: "swarm", now: new Date(NOW.getTime() + 200 * HOUR_MS) });

    expect(expired).toBe(0);
    expect(await anchorId(engine)).toBe(anchor);
  });
});

describe("the plugin schedule", () => {
  it("expires observations every drainstopIntervalMs, and only where the swarm namespace is served", async () => {
    const { engine } = await boot();
    const old = await observe(engine, { kind: "rationale", body: "older than 72h", ts: new Date(Date.now() - 100 * HOUR_MS) });
    const fresh = await observe(engine, { kind: "fold-back-candidate", body: "fresh, and not promoted by the schedule", ts: new Date() });

    const plugin = createSwarmSubstratePlugin({ scope: "cold", drainstopIntervalMs: 60_000 });
    expect(plugin.schedule).toHaveLength(1);
    const [task] = plugin.schedule ?? [];
    expect(task?.intervalMs).toBe(60_000);
    const metrics: Array<{ name: string; payload: unknown }> = [];
    await task?.handler({ pluginName: "swarm", engine, metric: (name, payload) => metrics.push({ name, payload }) });

    expect((await observations(engine)).map((o) => o.id)).toEqual([fresh]);
    expect(await rows(engine, "cortext", "Todo", ["title"])).toEqual([]);
    expect(metrics).toContainEqual({ name: "swarm_observation_expiry", payload: { namespace: "swarm", expired: 1 } });
    expect(old).not.toBe(fresh);

    expect(createSwarmSubstratePlugin({ scope: "meta" }).schedule).toEqual([]);
  });
});

describe("drainstop constants and helpers", () => {
  it("keeps the source repo's TTL table and thresholds", () => {
    expect(DRAINSTOP_KIND_DEFAULTS).toEqual({
      architectural: Number.POSITIVE_INFINITY,
      pattern: 168,
      concern: 168,
      "open-question": Number.POSITIVE_INFINITY,
      "user-framing": Number.POSITIVE_INFINITY,
      "fold-back-candidate": 48,
      rationale: 72,
    });
    expect(DEFAULT_TTL_UNKNOWN_KIND_HOURS).toBe(168);
    expect(CONCERN_RECURRENCE_MIN_GROUP_SIZE).toBe(3);
  });

  it("normalises tag signatures and parses rule categories", () => {
    expect(tagSignature(" b, a ,a,, ")).toBe("a,b");
    expect(tagSignature("")).toBe("");
    expect(parseCategoryPrefix("[code-review] Read the diff")).toEqual({ category: "code-review", rule: "Read the diff" });
    expect(parseCategoryPrefix("[two words] x")).toEqual({ category: "miscellaneous", rule: "[two words] x" });
  });
});
