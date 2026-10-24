/**
 * Ported from the previous engine package's `src/client.test.ts`. Its transport
 * lifecycle, `transportMode` and `subscribe` cases went with the WebSocket
 * transport; the `observe` cases stay, retargeted from the previous engine's
 * `plane/createObservation` to Substrate's `swarm/createObservation`.
 */
import { OBSERVE_OP_KEY } from "@mnmal-ai/swarm-substrate-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubstrateClient } from "./client.js";

describe("SubstrateClient.observe", () => {
  // Port 9 (discard): if a stub were ever missed, nothing answers there.
  const ENDPOINT = "http://127.0.0.1:9";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function jsonResponse(bodyObj: unknown): Response {
    return new Response(JSON.stringify(bodyObj), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("the shared op-key is swarm/createObservation", () => {
    expect(OBSERVE_OP_KEY).toBe("swarm/createObservation");
  });

  it("issues a single mutate to the swarm/createObservation op-key with the mapped params", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { "swarm/createObservation": { id: "obs-1" } } }),
    );
    const client = new SubstrateClient(ENDPOINT);

    const result = await client.observe({
      kind: "architectural",
      content: "waterfall persists per-source TTL",
      tags: ["v3", "plane"],
      confidence: 75,
    });

    // Exactly one HTTP round trip, to /substrate/v1/mutate.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9/substrate/v1/mutate");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(["swarm/createObservation"]);
    const entry = body["swarm/createObservation"];
    expect(entry.fields).toEqual({ id: true });
    // content -> body; tags[] -> comma string; ts + context filled.
    expect(entry.params).toMatchObject({
      kind: "architectural",
      body: "waterfall persists per-source TTL",
      context: "",
      confidence: 75,
      tags: "v3,plane",
      ttlHours: null,
    });
    // The calibration anchor is the drainstop's: observe() never writes isAnchor.
    expect(entry.params).not.toHaveProperty("isAnchor");
    expect(typeof entry.params.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.params.ts))).toBe(false);
    // A write carries a fresh de-dupe key beside params (no header).
    expect(entry.idempotencyKey).toMatch(/.+/);
    expect(entry.params).not.toHaveProperty("idempotencyKey");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();

    expect(result).toEqual({ id: "obs-1" });
  });

  it("defaults confidence to 0 and tags to an empty string when omitted (never seeds the 50 anchor)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { "swarm/createObservation": { id: "obs-2" } } }),
    );
    const client = new SubstrateClient(ENDPOINT);

    await client.observe({ kind: "concern", content: "no extras" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body["swarm/createObservation"].params).toMatchObject({
      kind: "concern",
      body: "no extras",
      confidence: 0,
      tags: "",
    });
  });

  it("targets swarm/createObservation even when the client is configured for a different namespace", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { "swarm/createObservation": { id: "obs-3" } } }),
    );
    const client = new SubstrateClient(ENDPOINT, { namespace: "swarm_meta" });

    await client.observe({ kind: "rationale", content: "x" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body)).toEqual(["swarm/createObservation"]);
  });

  it("never throws on transport failure — swallows, logs, returns null", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SubstrateClient(ENDPOINT);

    const result = await client.observe({ kind: "concern", content: "hot path must survive" });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    // The swallowed log names the kind but not the content (PII discipline).
    expect(String(warn.mock.calls[0][0])).toContain("concern");
    expect(String(warn.mock.calls[0][0])).not.toContain("hot path must survive");
  });

  it("swallows a non-ok HTTP response too (best-effort write)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 500, statusText: "Internal Server Error" }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SubstrateClient(ENDPOINT);

    const result = await client.observe({ kind: "concern", content: "y" });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("swallows a refused frame too (Substrate answers 200 with errors)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: {}, errors: [{ message: "unknown type", code: "unknown_type", path: ["swarm/createObservation"] }] }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new SubstrateClient(ENDPOINT);

    expect(await client.observe({ kind: "concern", content: "z" })).toBeNull();
    expect(String(warn.mock.calls[0][0])).toContain("unknown_type");
  });
});
