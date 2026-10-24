/**
 * The plugin routes over HTTP (`MemorySubstrateServer.inject`): the onboard
 * record, the manual drainstop trigger and the promotion rejection, all
 * mounted under `/substrate/v1/plugins/swarm/`.
 */
import { TRIGGER_DRAINSTOP_PATH } from "@mnmal-ai/swarm-substrate-shared";
import { queryAll } from "@mnmal-ai/substrate/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_RATCHET_STEP,
  buildOnboardInstructions,
  createSwarmSubstratePlugin,
  REJECT_PROMOTION_PATH,
} from "../src/index.js";
import { createCortextFixture } from "./cortext-fixture.js";
import { bootTestServer, type TestServer } from "./harness.js";

const ONBOARD_PATH = "/substrate/v1/plugins/swarm/onboard";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(scope: "cold" | "meta" | "combined" = "cold"): Promise<TestServer> {
  server = await bootTestServer({ scope, coordinators: scope === "meta" ? [] : [createCortextFixture()] });
  return server;
}

async function createObservation(s: TestServer, params: Record<string, unknown>): Promise<string> {
  const res = await s.inject({
    method: "POST",
    url: "/substrate/v1/mutate",
    body: {
      "swarm/createObservation": {
        params: { ts: new Date().toISOString(), context: null, tags: "", ttlHours: null, isAnchor: null, ...params },
        fields: { id: true },
      },
    },
  });
  const env = res.json() as { data: Record<string, { id: string }>; errors?: unknown[] };
  expect(env.errors ?? []).toEqual([]);
  return env.data["swarm/createObservation"]!.id;
}

describe("plugin routes", () => {
  it("exports the trigger path from the shared package", () => {
    expect(TRIGGER_DRAINSTOP_PATH).toBe("/substrate/v1/plugins/swarm/trigger-drainstop");
    expect(REJECT_PROMOTION_PATH).toBe("/substrate/v1/plugins/swarm/reject-promotion");
  });

  it("POST trigger-drainstop runs the drainstop and returns its result", async () => {
    const s = await boot();
    await createObservation(s, { kind: "fold-back-candidate", body: "promote me", confidence: null });

    const res = await s.inject({ method: "POST", url: TRIGGER_DRAINSTOP_PATH });

    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      promoted: { todos: 1, decisions: 0, agentRules: 0 },
      absorbed: 0,
      expired: 0,
      anchorSeeded: true,
      failures: [],
      truncated: false,
    });
    const again = await s.inject({ method: "POST", url: TRIGGER_DRAINSTOP_PATH });
    expect(again.status).toBe(200);
    expect(again.json()).toMatchObject({ promoted: { todos: 0 }, anchorSeeded: false });
  });

  it("GET onboard returns the plugin's onboardInstructions", async () => {
    const s = await boot();
    const res = await s.inject({ method: "GET", url: ONBOARD_PATH });

    expect(res.status).toBe(200);
    const plugin = createSwarmSubstratePlugin({ scope: "cold" });
    expect(res.json()).toEqual(plugin.onboardInstructions);
    expect(res.json()).toEqual(buildOnboardInstructions({ scope: "cold", namespace: "swarm", contextNamespace: "cortext" }));
    const body = res.json() as {
      summary: string;
      types: Record<string, string>;
      workflows: Record<string, { frameKey: string }>;
    };
    expect(body.summary).toEqual(expect.any(String));
    expect(Object.keys(body.types)).toContain("swarm/Observation");
    expect(Object.keys(body.types)).toContain("swarm-docs/Section");
    expect(body.workflows.prepareTask?.frameKey).toBe("swarm/prepareTask");
    expect(body.workflows.persistTaskTelemetry?.frameKey).toBe("swarm/persistTaskTelemetry");
  });

  it("lists the plugin onboard under the aggregated onboard", async () => {
    const s = await boot();
    const res = await s.inject({ method: "GET", url: "/substrate/v1/onboard" });
    expect(res.status).toBe(200);
    const body = res.json() as { instructions: { plugins: Record<string, unknown> } };
    expect(body.instructions.plugins.swarm).toEqual(createSwarmSubstratePlugin({ scope: "cold" }).onboardInstructions);
  });

  it("a meta-scope instance serves onboard but no drainstop", async () => {
    const s = await boot("meta");
    const onboard = await s.inject({ method: "GET", url: ONBOARD_PATH });
    expect(onboard.status).toBe(200);
    const body = onboard.json() as { types: Record<string, string>; workflows: Record<string, unknown> };
    expect(Object.keys(body.types).every((t) => t.startsWith("swarm_meta/"))).toBe(true);
    expect(body.workflows).not.toHaveProperty("prepareTask");

    const trigger = await s.inject({ method: "POST", url: TRIGGER_DRAINSTOP_PATH });
    expect(trigger.status).toBe(404);
  });

  it("POST reject-promotion archives a promoted row and ratchets the anchor once", async () => {
    const s = await boot();
    await createObservation(s, { kind: "fold-back-candidate", body: "a promotion a human will reject", confidence: null });
    expect((await s.inject({ method: "POST", url: TRIGGER_DRAINSTOP_PATH })).status).toBe(200);
    const [todo] = await queryAll<{ id: string }>(s.engine, "cortext", "Todo", {}, ["id"]);

    const res = await s.inject({ method: "POST", url: REJECT_PROMOTION_PATH, body: { targetType: "Todo", targetId: todo!.id } });

    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      targetType: "Todo",
      targetId: todo!.id,
      targetArchived: true,
      alreadyRejected: false,
      anchorConfidenceBefore: 50,
      anchorConfidenceAfter: 50 + ANCHOR_RATCHET_STEP,
    });
    const [archived] = await queryAll<{ archived: boolean }>(s.engine, "cortext", "Todo", { id: todo!.id }, ["archived"]);
    expect(archived?.archived).toBe(true);

    const retry = await s.inject({ method: "POST", url: REJECT_PROMOTION_PATH, body: { targetType: "Todo", targetId: todo!.id } });
    expect(retry.status).toBe(200);
    expect(retry.json()).toMatchObject({ alreadyRejected: true, anchorConfidenceAfter: 50 + ANCHOR_RATCHET_STEP });
  });

  it("reject-promotion recognises a concern-recurrence Todo as a promotion", async () => {
    const s = await boot();
    for (let i = 0; i < 3; i++) await createObservation(s, { kind: "concern", body: `recurring ${i}`, tags: "ci", confidence: null });
    expect((await s.inject({ method: "POST", url: TRIGGER_DRAINSTOP_PATH })).json()).toMatchObject({ promoted: { todos: 1 } });
    const [todo] = await queryAll<{ id: string }>(s.engine, "cortext", "Todo", {}, ["id"]);

    const res = await s.inject({ method: "POST", url: REJECT_PROMOTION_PATH, body: { targetType: "Todo", targetId: todo!.id } });

    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ targetArchived: true, alreadyRejected: false, anchorConfidenceAfter: 50 + ANCHOR_RATCHET_STEP });
  });

  it("reject-promotion refuses bad bodies, unknown rows and rows the drainstop did not promote", async () => {
    const s = await boot();
    const bad = await s.inject({ method: "POST", url: REJECT_PROMOTION_PATH, body: { targetType: "Memory", targetId: "x" } });
    expect(bad.status).toBe(400);
    expect(bad.json()).toMatchObject({ code: "bad_target_type" });

    const missing = await s.inject({ method: "POST", url: REJECT_PROMOTION_PATH, body: { targetType: "Todo", targetId: "no-such-id" } });
    expect(missing.status).toBe(404);

    const created = await s.engine.mutate({
      frame: {
        "cortext/createTodo": {
          params: { title: "hand-written", area: "x", status: "open", priority: "low", notes: "no lineage" },
          fields: { id: true },
        },
      },
      ctx: { identity: { kind: "system", id: "routes-test", grants: { "*": ["read", "mutate"] } } },
    });
    const id = (created.data["cortext/createTodo"] as { id: string }).id;
    const foreign = await s.inject({ method: "POST", url: REJECT_PROMOTION_PATH, body: { targetType: "Todo", targetId: id } });
    expect(foreign.status).toBe(400);
    expect(foreign.json()).toMatchObject({ code: "not_a_promotion" });
  });
});
