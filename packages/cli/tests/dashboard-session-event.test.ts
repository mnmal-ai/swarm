/**
 * Tests the DashboardServer SessionEvent stream.
 *
 * The Substrate client speaks HTTP only, so the stream polls the SessionEvent
 * query on a fixed interval and broadcasts each new row to dashboard WS
 * clients as `substrate:sessionEvent`.
 *
 * Verifies:
 * 1. Poll — rows the query returns are broadcast to dashboard clients.
 * 2. Dedup — a row with an eventId already pushed is never re-broadcast, across ticks.
 * 3. A failing poll tick keeps the dashboard serving, and a later tick recovers.
 * 4. Escape hatch — SWARM_DISABLE_SUBSCRIBE still forces the plain poll loop.
 * 5. No Substrate client — the dashboard still constructs and stops cleanly.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { DashboardServer } from "../src/server/index.js";

let nextPort = 15141;
function getPort(): number {
  return nextPort++;
}

/** Connect a WebSocket and wait for the initial state message. */
function connectWs(port: number, timeoutMs = 3000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for initial state")), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "state") {
        clearTimeout(timer);
        resolve(ws);
      }
    });
  });
}

/** Collect every `substrate:sessionEvent` eventId a socket receives. */
function collectSessionEvents(ws: WebSocket): string[] {
  const received: string[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "substrate:sessionEvent") received.push((msg.payload as { eventId: string }).eventId);
  });
  return received;
}

/**
 * Minimal SubstrateClient stand-in: the stream only calls `query`. `rows` is
 * what the next poll returns; `fail` makes the next poll throw.
 */
class FakeSubstrateClient {
  queryCalls = 0;
  lastQuery: { typeName: string; params: Record<string, unknown>; fields: unknown } | null = null;
  rows: Record<string, unknown>[];
  fail = false;

  constructor(rows: Record<string, unknown>[] = []) {
    this.rows = rows;
  }

  async query<T>(typeName: string, params: Record<string, unknown>, fields: unknown): Promise<T[]> {
    this.queryCalls++;
    this.lastQuery = { typeName, params, fields };
    if (this.fail) throw new Error("sidecar unreachable");
    return this.rows as T[];
  }
}

const servers: DashboardServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) ws.close();
  sockets.length = 0;
  for (const server of servers) await server.stop();
  servers.length = 0;
  delete process.env.SWARM_DISABLE_SUBSCRIBE;
  delete process.env.SWARM_POLL_FALLBACK;
  vi.restoreAllMocks();
});

function makeServer(port: number, client?: FakeSubstrateClient): DashboardServer {
  const server = new DashboardServer(new SwarmEventBus(), port, undefined, false, client as unknown as SubstrateClient | undefined);
  servers.push(server);
  return server;
}

describe("DashboardServer: SessionEvent stream", () => {
  it("polls SessionEvent and pushes new rows to dashboard clients", async () => {
    const port = getPort();
    const row = { eventId: "evt-1", sessionId: "sess-1", role: "worker", inputTokens: 4200, outputTokens: 300, latencyMs: 1234, timestamp: new Date().toISOString() };
    const client = new FakeSubstrateClient([row]);
    makeServer(port, client);

    const ws = await connectWs(port);
    sockets.push(ws);
    const received = collectSessionEvents(ws);

    await vi.waitFor(() => expect(received).toContain("evt-1"), { timeout: 4000, interval: 20 });
    expect(client.lastQuery?.typeName).toBe("SessionEvent");
    expect(client.lastQuery?.fields).toMatchObject({ eventId: true, inputTokens: true, latencyMs: true });
  });

  it("dedups by eventId — a row returned by every poll is pushed only once", async () => {
    const port = getPort();
    const row = { eventId: "evt-dup", sessionId: "s", role: "worker", timestamp: "t" };
    const client = new FakeSubstrateClient([row]);
    makeServer(port, client);

    const ws = await connectWs(port);
    sockets.push(ws);
    const received = collectSessionEvents(ws);

    await vi.waitFor(() => expect(received).toContain("evt-dup"), { timeout: 4000, interval: 20 });
    // The same row on later ticks, then a new one: wait for the new one, then
    // the duplicate must not have been re-pushed (broadcasts are FIFO).
    const ticksSoFar = client.queryCalls;
    await vi.waitFor(() => expect(client.queryCalls).toBeGreaterThan(ticksSoFar), { timeout: 4000, interval: 20 });
    client.rows = [row, { eventId: "evt-sentinel", sessionId: "s", role: "worker", timestamp: "t" }];
    await vi.waitFor(() => expect(received).toContain("evt-sentinel"), { timeout: 4000, interval: 20 });
    expect(received).toEqual(["evt-dup", "evt-sentinel"]);
  });

  it("keeps serving when a poll fails, and picks up rows on a later tick", async () => {
    const port = getPort();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new FakeSubstrateClient();
    client.fail = true;
    makeServer(port, client);

    const ws = await connectWs(port);
    sockets.push(ws);
    const received = collectSessionEvents(ws);

    await vi.waitFor(() => expect(client.queryCalls).toBeGreaterThan(0), { timeout: 4000, interval: 20 });
    client.fail = false;
    client.rows = [{ eventId: "evt-after", sessionId: "s", role: "reviewer", timestamp: "t" }];
    await vi.waitFor(() => expect(received).toContain("evt-after"), { timeout: 4000, interval: 20 });
  });

  it("honors the SWARM_* escape hatch — still a plain poll loop", async () => {
    process.env.SWARM_DISABLE_SUBSCRIBE = "1";
    const port = getPort();
    const client = new FakeSubstrateClient([{ eventId: "evt-flag", sessionId: "s", role: "worker", timestamp: "t" }]);
    makeServer(port, client);

    const ws = await connectWs(port);
    sockets.push(ws);
    const received = collectSessionEvents(ws);

    await vi.waitFor(() => expect(received).toContain("evt-flag"), { timeout: 4000, interval: 20 });
    expect(client.queryCalls).toBeGreaterThan(0);
  });

  it("constructs and stops cleanly with no Substrate client", async () => {
    const port = getPort();
    const server = makeServer(port); // no client
    const ws = await connectWs(port);
    sockets.push(ws);
    // Nothing to assert beyond no throw — afterEach stops the server.
    expect(server).toBeInstanceOf(DashboardServer);
  });
});
