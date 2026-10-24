/**
 * Tests that the DashboardServer correctly handles "backend:progress" events.
 *
 * Verifies:
 * 1. Progress events are stored in the rolling event log
 * 2. tool_call progress events update latestActivity in session state
 * 3. Progress events are broadcast to WebSocket clients
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";
import type { ProgressEvent } from "@mnmal-ai/swarm-types";

// Use a high port to avoid conflicts with other tests or services
let nextPort = 13141;
function getPort(): number {
  return nextPort++;
}

/** Connect a WebSocket and wait for the initial state message. */
function connectWs(port: number, timeoutMs = 3000): Promise<{ ws: WebSocket; initialState: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for initial state")), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "state") {
        clearTimeout(timer);
        resolve({ ws, initialState: msg.payload });
      }
    });
  });
}

/** Wait for the next WebSocket message. */
function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

const servers: DashboardServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    await server.stop();
  }
  servers.length = 0;
});

describe("DashboardServer: backend:progress events", () => {
  it("broadcasts backend:progress events to WebSocket clients", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    // Connect a WS client and consume the initial state
    const { ws } = await connectWs(port);

    // Emit a progress event on the bus
    const progressEvent: ProgressEvent = {
      type: "tool_call",
      detail: "Calling: Read /src/index.ts",
      timestamp: Date.now(),
      meta: { toolName: "Read" },
    };

    const msgPromise = waitForMessage(ws);
    eventBus.emit("backend:progress", progressEvent);

    const received = await msgPromise;
    expect(received.type).toBe("backend:progress");
    expect((received.payload as Record<string, unknown>).type).toBe("tool_call");
    expect((received.payload as Record<string, unknown>).detail).toBe("Calling: Read /src/index.ts");

    ws.close();
  });

  it("stores progress events in the rolling event log visible on reconnect", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    // Emit several progress events before any client connects
    const events: ProgressEvent[] = [
      { type: "session_init", detail: "Session initialized", timestamp: Date.now() },
      { type: "tool_call", detail: "Calling: Grep pattern", timestamp: Date.now() },
      { type: "model_response", detail: "Model thinking...", timestamp: Date.now() },
    ];

    for (const ev of events) {
      eventBus.emit("backend:progress", ev);
    }

    // Now connect — the initial state should include all 3 events
    const { ws, initialState } = await connectWs(port);

    const stateEvents = initialState.events as Array<{ type: string }>;
    const progressEvents = stateEvents.filter((e) => e.type === "backend:progress");
    expect(progressEvents.length).toBe(3);

    ws.close();
  });

  it("updates latestActivity for tool_call progress events", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    // Emit a tool_call progress event
    eventBus.emit("backend:progress", {
      type: "tool_call",
      detail: "Calling: Write /tmp/output.ts",
      timestamp: Date.now(),
    });

    // Connect and check the initial state
    const { ws, initialState } = await connectWs(port);
    expect(initialState.latestActivity).toBe("Calling: Write /tmp/output.ts");

    ws.close();
  });

  it("does not update latestActivity for non-tool_call progress events", async () => {
    const port = getPort();
    const eventBus = new SwarmEventBus();
    const server = new DashboardServer(eventBus, port);
    servers.push(server);

    // Emit only a model_response event (not tool_call)
    eventBus.emit("backend:progress", {
      type: "model_response",
      detail: "Thinking about the problem...",
      timestamp: Date.now(),
    });

    // Connect and check — latestActivity should not be set
    const { ws, initialState } = await connectWs(port);
    expect(initialState.latestActivity).toBeUndefined();

    ws.close();
  });
});
