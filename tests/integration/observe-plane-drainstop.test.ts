/**
 * observe() -> swarm/Observation + drainstop promotion into cortext — drives a
 * REAL SubstrateClient against a REAL spawned Substrate sidecar running the
 * swarm plugin and cortext (the context store the drainstop promotes into).
 *
 * E2E-gated like the other real-sidecar suites: runs only under
 * `SWARM_SDK_E2E=1`. Each test spawns its OWN sidecar (memory store, ephemeral
 * port) through the test setup's `startTestSubstrate()`, so every test starts
 * from an empty store and the counts below are exact.
 *
 * ----------------------------------------------------------------------------
 * Ground truth (swarm Substrate plugin + @mnmal-ai/cortext 1.0.0-alpha.7):
 *
 *   1. `observe({ kind, content, tags?, confidence? })` writes
 *      `swarm/createObservation` (the Observation type lives in the swarm
 *      namespace; the previous engine's separate `plane` namespace is gone). `content -> body`,
 *      `tags -> comma-separated string`, unset `confidence -> 0`, and `isAnchor`
 *      is never written (the confidence=50 calibration anchor is seeded by the
 *      drainstop).
 *
 *   2. The drainstop runs on its hourly schedule and on the plugin's manual
 *      trigger route (`TRIGGER_DRAINSTOP_PATH`). A freshly spawned sidecar's
 *      schedule has not fired within a test, so only the trigger runs it.
 *
 *   3. Restart durability (criterion 3) needs a durable store, so it runs the
 *      sidecar on the test stack's Postgres (`testPostgresUrl("cold")`: 42337,
 *      or a loopback `SWARM_TEST_POSTGRES_URL` on that port — never the
 *      production `SWARM_SUBSTRATE_POSTGRES_URL`) and skips with the reason
 *      when none answers.
 * ----------------------------------------------------------------------------
 */

import { randomUUID } from "node:crypto";
import { type DrainstopResult, SubstrateClient, TRIGGER_DRAINSTOP_PATH } from "@mnmal-ai/swarm-substrate";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { startTestSubstrate, stopTestSubstrate, type TestSubstrate } from "../setup/isolated-substrate.js";
import { testPostgresUrl } from "../setup/test-postgres.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";
const CORTEXT = "cortext";

/** One trivial query on a short-timeout, single-connection handle; false on any error. */
async function probePgReachable(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.end({ timeout: 5 });
    } catch {
      // never connected — nothing to drain.
    }
  }
}

const OBSERVATION_FIELDS = {
  id: true,
  kind: true,
  body: true,
  tags: true,
  confidence: true,
  isAnchor: true,
} as const;

interface ObservationRow {
  id: string;
  kind: string;
  body: string;
  tags: string;
  confidence: number | null;
  isAnchor: boolean | null;
}

// --- Per-test teardown (no orphaned sidecars) ----------------------------------

async function boot(opts: { postgres?: string } = {}): Promise<TestSubstrate> {
  return startTestSubstrate({
    meta: false,
    cortext: true,
    recall: "none",
    ...(opts.postgres !== undefined ? { postgres: { cold: opts.postgres } } : {}),
  });
}

afterEach(async () => {
  // Every pair this file started, including one still booting after a timeout.
  await stopTestSubstrate();
});

/** POST the manual drainstop trigger and return the parsed {@link DrainstopResult}. */
async function triggerDrainstop(url: string): Promise<DrainstopResult> {
  const res = await fetch(`${url}${TRIGGER_DRAINSTOP_PATH}`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as DrainstopResult;
}

async function observations(client: SubstrateClient): Promise<ObservationRow[]> {
  return client.query<ObservationRow>("Observation", {}, OBSERVATION_FIELDS);
}

describe.skipIf(!RUN_E2E)("observe() -> swarm/Observation (real Substrate sidecar)", () => {
  it(
    "lands a swarm/Observation row carrying the supplied kind/content/tags/confidence",
    async () => {
      const sidecar = await boot();
      const client = new SubstrateClient(sidecar.cold.url);

      const observation = {
        kind: "rationale",
        content: "chose a memory-backed store so observations stay ephemeral",
        tags: ["phase-5", "plane"],
        confidence: 70,
      };

      // observe() awaits the mutate round trip end to end, so the write is
      // stored by the time it resolves — no polling needed.
      const created = await client.observe(observation);
      expect(created).not.toBeNull();
      expect(created?.id).toBeTruthy();

      // No drainstop has run, so no anchor exists; the filter keeps the
      // assertion robust to one anyway.
      const landed = (await observations(client)).filter((r) => r.isAnchor !== true);
      expect(landed).toHaveLength(1);

      const row = landed[0]!;
      expect(row.id).toBe(created?.id);
      expect(row.kind).toBe(observation.kind);
      // content maps to the Observation `body` field.
      expect(row.body).toBe(observation.content);
      // tags ride as a comma-separated string on the wire.
      expect(row.tags).toBe(observation.tags.join(","));
      expect(row.confidence).toBe(observation.confidence);
      // observe() never writes the calibration anchor.
      expect(row.isAnchor).not.toBe(true);
    },
    60000,
  );
});

describe.skipIf(!RUN_E2E)("manual drainstop -> promotes high-signal observations into cortext", () => {
  it(
    "promotes exactly the high-signal subset and never overrides the confidence=50 anchor across ticks",
    async () => {
      const sidecar = await boot();
      const client = new SubstrateClient(sidecar.cold.url);
      const context = new SubstrateClient(sidecar.cold.url, { namespace: CORTEXT });

      // >=5 observations spanning every single-source promotion rule plus
      // low-signal noise that must NOT promote. Bodies are unique so the
      // promoted rows and survivors are individually identifiable.
      const foldBack = "fold the retry-budget insight back into the planner";
      const archHigh = "adopt a memory-backed store so observations stay ephemeral";
      const rule = "[testing] always add a regression test when fixing a bug";
      const archLow = "maybe revisit the edges store wiring later";
      const rationale = "chose substrate to keep transport parity with prod";

      const written = await Promise.all([
        // fold-back-candidate -> cortext/Todo (any age).
        client.observe({ kind: "fold-back-candidate", content: foldBack, tags: ["phase-5", "fold"], confidence: 60 }),
        // architectural && confidence > 80 -> cortext/Decision.
        client.observe({ kind: "architectural", content: archHigh, tags: ["phase-5", "arch"], confidence: 90 }),
        // user-framing && confidence === 100 -> cortext/AgentRule.
        client.observe({ kind: "user-framing", content: rule, tags: ["phase-5", "rule"], confidence: 100 }),
        // architectural but confidence === 50 (not > 80): stays.
        client.observe({ kind: "architectural", content: archLow, tags: ["phase-5", "arch-low"], confidence: 50 }),
        // rationale: no promotion rule, 72h TTL, age ~0 -> stays.
        client.observe({ kind: "rationale", content: rationale, tags: ["phase-5", "rationale"], confidence: 70 }),
      ]);
      expect(written).toHaveLength(5);
      expect(written.every((w) => Boolean(w?.id))).toBe(true);

      // --- First tick: seeds the anchor + promotes the high-signal subset ----
      const first = await triggerDrainstop(sidecar.cold.url);
      expect(first.failures).toEqual([]);
      expect(first.anchorSeeded).toBe(true);
      expect(first.promoted).toEqual({ todos: 1, decisions: 1, agentRules: 1 });

      // The exact high-signal subset is now in cortext...
      const todos = await context.query<{ notes: string }>("Todo", {}, { notes: true });
      const decisions = await context.query<{ choice: string }>("Decision", {}, { choice: true });
      const rules = await context.query<{ rule: string; category: string; active: boolean }>(
        "AgentRule",
        {},
        { rule: true, category: true, active: true },
      );
      expect(todos).toHaveLength(1);
      expect(decisions).toHaveLength(1);
      expect(rules).toHaveLength(1);
      // ...each carrying the source observation's content.
      expect(todos[0]!.notes).toContain(foldBack);
      // Decision promotion works on cortext alpha.7 (the previous engine's plane refused it,
      // an upstream issue): the architectural observation's body is the choice.
      expect(decisions[0]!.choice).toBe(archHigh);
      // user-framing body convention '[category] rule text' splits on promote;
      // the rule lands inactive (active=false) pending review.
      expect(rules[0]!.category).toBe("testing");
      expect(rules[0]!.rule.trim()).toBe("always add a regression test when fixing a bug");
      expect(rules[0]!.active).toBe(false);

      // The two low-signal observations are NOT promoted: they survive, while
      // the three promoted sources were deleted after their target writes.
      // Exactly one drainstop-seeded anchor sits alongside them.
      const rows = await observations(client);
      const anchors = rows.filter((r) => r.isAnchor === true);
      const survivors = rows.filter((r) => r.isAnchor !== true);
      expect(anchors).toHaveLength(1);
      expect(survivors.map((r) => r.body).sort()).toEqual([archLow, rationale].sort());

      // --- Calibration anchor: confidence=50, never overridden across ticks --
      expect(anchors[0]!.confidence).toBe(50);

      // Run the trigger twice more. The anchor is immune to promotion + TTL and
      // is seeded only once: later ticks re-seed nothing, promote nothing, and
      // leave the anchor's confidence pinned at 50.
      for (let tick = 0; tick < 2; tick++) {
        const again = await triggerDrainstop(sidecar.cold.url);
        expect(again.anchorSeeded).toBe(false);
        expect(again.promoted).toEqual({ todos: 0, decisions: 0, agentRules: 0 });

        const stillAnchor = (await observations(client)).find((r) => r.isAnchor === true);
        expect(stillAnchor?.confidence).toBe(50);
      }

      // No duplicate promotions accumulated across the repeated ticks.
      expect(await context.query("Todo", {}, { id: true })).toHaveLength(1);
      expect(await context.query("Decision", {}, { id: true })).toHaveLength(1);
      expect(await context.query("AgentRule", {}, { id: true })).toHaveLength(1);
    },
    60000,
  );
});

describe.skipIf(!RUN_E2E)("restart durability — drainstop promotions survive a sidecar restart on Postgres", () => {
  it(
    "retains promoted cortext rows after stop()+restart against the same Postgres",
    async (ctx) => {
      // A memory-store sidecar loses every row when it stops, so durability is
      // observable only on Postgres.
      const pgUrl = testPostgresUrl("cold");
      if (!(await probePgReachable(pgUrl))) {
        ctx.skip(
          `restart durability needs a reachable Postgres; none at ${pgUrl}. ` +
            "Bring up docker-compose.test.yml (alt-port 42337), e.g. with SWARM_SDK_PG=1, to exercise it.",
        );
        return;
      }

      // A per-run marker: the shared alt-port store keeps rows from earlier runs.
      const marker = randomUUID();
      const foldBack = `fold the retry-budget insight back into the planner [${marker}]`;
      const rule = `[testing] keep promotions durable [${marker}]`;

      // --- Sidecar #1: write + drainstop-promote into cortext on Postgres ------
      const first = await boot({ postgres: pgUrl });
      const writer = new SubstrateClient(first.cold.url);
      const written = await Promise.all([
        writer.observe({ kind: "fold-back-candidate", content: foldBack, tags: ["phase-5", "fold"], confidence: 60 }),
        writer.observe({ kind: "user-framing", content: rule, tags: ["phase-5", "rule"], confidence: 100 }),
      ]);
      expect(written.every((w) => Boolean(w?.id))).toBe(true);

      const promote = await triggerDrainstop(first.cold.url);
      expect(promote.promoted.todos).toBeGreaterThanOrEqual(1);
      expect(promote.promoted.agentRules).toBeGreaterThanOrEqual(1);

      const marked = async (url: string) => {
        const context = new SubstrateClient(url, { namespace: CORTEXT });
        const todos = (await context.query<{ notes: string }>("Todo", {}, { notes: true })).filter((r) =>
          r.notes.includes(marker),
        );
        const rules = (await context.query<{ rule: string }>("AgentRule", {}, { rule: true })).filter((r) =>
          r.rule.includes(marker),
        );
        return { todos, rules };
      };
      const before = await marked(first.cold.url);
      expect(before.todos).toHaveLength(1);
      expect(before.rules).toHaveLength(1);

      // --- Stop sidecar #1, restart against the SAME Postgres ------------------
      await first.stop();
      const second = await boot({ postgres: pgUrl });

      const after = await marked(second.cold.url);
      expect(after.todos).toHaveLength(1);
      expect(after.rules).toHaveLength(1);
      expect(after.todos[0]!.notes).toContain(foldBack);
      expect(after.rules[0]!.rule.trim()).toBe(`keep promotions durable [${marker}]`);
    },
    60000,
  );
});
