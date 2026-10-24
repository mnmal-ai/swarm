/**
 * The dashboard server streams a short summary of each session's transcript,
 * not the whole prompt and response: one real run's four transcript events
 * were 1.8 MB of a 1.9 MB state snapshot that every page received on connect.
 * A page fetches a full transcript only when someone opens it. Any other long
 * string in an event is cut to a bounded length with a marker saying how much
 * was dropped.
 */

import { describe, it, expect, afterEach } from "vitest";
import { networkInterfaces } from "node:os";
import WebSocket from "ws";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";

let nextPort = 18141;
const servers: DashboardServer[] = [];
afterEach(async () => {
  for (const server of servers) await server.stop();
  servers.length = 0;
});

function start(): { port: number; bus: SwarmEventBus } {
  const port = nextPort++;
  const bus = new SwarmEventBus();
  servers.push(new DashboardServer(bus, port));
  return { port, bus };
}

/** The state snapshot a page receives when it connects, and the next live message after it. */
function connect(port: number): Promise<{ ws: WebSocket; state: { events: Array<{ type: string; payload: Record<string, unknown> }> }; next: () => Promise<{ type: string; payload: Record<string, unknown> }> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for state")), 3000);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const waiters: Array<(m: { type: string; payload: Record<string, unknown> }) => void> = [];
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "state") {
        clearTimeout(timer);
        resolve({ ws, state: msg.payload, next: () => new Promise((r) => (queue.length ? r(queue.shift()!) : waiters.push(r))) });
        return;
      }
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    });
  });
}

/** The id the server gave a session's transcript, read from the state snapshot's summary. */
async function transcriptIdFor(port: number, sessionId: string, role = "worker"): Promise<string> {
  const { ws, state } = await connect(port);
  ws.close();
  const event = state.events.find((e) => e.type === "transcript" && e.payload.sessionId === sessionId && e.payload.role === role);
  return String(event?.payload.transcriptId);
}

const PROMPT = "p".repeat(300_000);
const RESPONSE = "r".repeat(120_000);
const transcript = (sessionId: string) => ({
  sessionId,
  role: "worker" as const,
  taskId: "t1",
  timestamp: "2026-01-01T00:00:00.000Z",
  prompt: PROMPT,
  response: RESPONSE,
  tokens: { input: 1200, output: 340 },
  backend: "claude-code",
});

describe("DashboardServer: transcripts and long payloads", () => {
  it("keeps a summary of each transcript in the state snapshot, not the prompt and response", async () => {
    const { port, bus } = start();
    bus.emit("transcript", transcript("s1"));
    const { ws, state } = await connect(port);
    const event = state.events.find((e) => e.type === "transcript");
    expect(event?.payload).toMatchObject({ sessionId: "s1", role: "worker", backend: "claude-code", tokens: { input: 1200, output: 340 }, promptBytes: 300_000, responseBytes: 120_000 });
    expect(event?.payload).not.toHaveProperty("prompt");
    expect(event?.payload).not.toHaveProperty("response");
    expect(JSON.stringify(state).length).toBeLessThan(20_000);
    ws.close();
  });

  it("broadcasts the same summary to connected pages", async () => {
    const { port, bus } = start();
    const { ws, next } = await connect(port);
    bus.emit("transcript", transcript("s2"));
    const msg = await next();
    expect(msg.type).toBe("transcript");
    expect(msg.payload).toMatchObject({ sessionId: "s2", promptBytes: 300_000 });
    expect(msg.payload).not.toHaveProperty("prompt");
    ws.close();
  });

  it("serves a session's full transcript on request, and 404 for one it doesn't hold", async () => {
    const { port, bus } = start();
    bus.emit("transcript", transcript("s3"));
    const id = await transcriptIdFor(port, "s3");
    const res = await fetch(`http://127.0.0.1:${port}/api/transcript/${id}`);
    expect(res.status).toBe(200);
    const full = (await res.json()) as { prompt: string; response: string };
    expect(full.prompt.length).toBe(300_000);
    expect(full.response.length).toBe(120_000);
    expect((await fetch(`http://127.0.0.1:${port}/api/transcript/nope`)).status).toBe(404);
  });

  it("cuts any other long string in an event, saying how much was dropped", async () => {
    const { port, bus } = start();
    bus.emit("backend:progress", { type: "model_response", detail: "x".repeat(50_000), timestamp: Date.now() });
    const { ws, state } = await connect(port);
    const detail = String(state.events.find((e) => e.type === "backend:progress")?.payload.detail);
    expect(detail.length).toBeLessThan(9_000);
    expect(detail).toMatch(/truncated, \d+ KB/);
    ws.close();
  });

  // Needs a network address on this machine to try; skipped (visibly) without one.
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  it.skipIf(lan === undefined)("answers only on this machine by default: no address on the network reaches it", async () => {
    const { port, bus } = start();
    bus.emit("transcript", transcript("s4"));
    const id = await transcriptIdFor(port, "s4");
    await expect(fetch(`http://${lan}:${port}/api/transcript/${id}`)).rejects.toThrow();
  });

  it("refuses a malformed session id with 400", async () => {
    const { port } = start();
    await connect(port).then(({ ws }) => ws.close());
    expect((await fetch(`http://127.0.0.1:${port}/api/transcript/%E0%A4%A`)).status).toBe(400);
  });

  it("keeps the newest 100 transcripts, and drops the oldest past a size budget", async () => {
    const { port, bus } = start();
    bus.emit("transcript", { ...transcript("n0"), prompt: "p", response: "r" });
    const first = await transcriptIdFor(port, "n0");
    for (let i = 1; i < 101; i++) bus.emit("transcript", { ...transcript(`n${i}`), prompt: "p", response: "r" });
    const last = await transcriptIdFor(port, "n100");
    expect((await fetch(`http://127.0.0.1:${port}/api/transcript/${first}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/transcript/${last}`)).status).toBe(200);

    const big = "b".repeat(3 * 1024 * 1024);
    bus.emit("transcript", { ...transcript("big0"), prompt: big, response: "r" });
    const firstBig = await transcriptIdFor(port, "big0");
    for (let i = 1; i < 12; i++) bus.emit("transcript", { ...transcript(`big${i}`), prompt: big, response: "r" });
    const lastBig = await transcriptIdFor(port, "big11");
    expect((await fetch(`http://127.0.0.1:${port}/api/transcript/${firstBig}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/transcript/${lastBig}`)).status).toBe(200);
  });

  it("scrubs keys, tokens and home folders from a transcript before holding it", async () => {
    const { port, bus } = start();
    const secret = "sk-" + "a".repeat(30);
    bus.emit("transcript", { ...transcript("s5"), prompt: `use ${secret} from /home/user/project`, response: "Bearer " + "t".repeat(30) });
    const id = await transcriptIdFor(port, "s5");
    const full = (await (await fetch(`http://127.0.0.1:${port}/api/transcript/${id}`)).json()) as { prompt: string; response: string };
    expect(full.prompt).not.toContain(secret);
    expect(full.prompt).toContain("[REDACTED]");
    expect(full.prompt).not.toContain("/home/user/");
    expect(full.response).toBe("[REDACTED]");
  });

  it("cuts long strings even in deeply nested payloads", async () => {
    let deep: Record<string, unknown> = { leaf: "y".repeat(50_000) };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    const { port, bus } = start();
    bus.emit("orchestration:event", { eventType: "deep", detail: "d", data: deep } as never);
    const { ws, state } = await connect(port);
    expect(JSON.stringify(state).length).toBeLessThan(20_000);
    ws.close();
  });

  it("keeps a worker's and a reviewer's transcript apart when they share a session id", async () => {
    const { port, bus } = start();
    bus.emit("transcript", { ...transcript("shared"), prompt: "WORKER PROMPT", response: "w" });
    bus.emit("transcript", { ...transcript("shared"), role: "reviewer", prompt: "REVIEWER PROMPT", response: "r" });
    const workerId = await transcriptIdFor(port, "shared", "worker");
    const reviewerId = await transcriptIdFor(port, "shared", "reviewer");
    expect(workerId).not.toBe(reviewerId);
    const worker = (await (await fetch(`http://127.0.0.1:${port}/api/transcript/${workerId}`)).json()) as { prompt: string };
    const reviewer = (await (await fetch(`http://127.0.0.1:${port}/api/transcript/${reviewerId}`)).json()) as { prompt: string };
    expect(worker.prompt).toBe("WORKER PROMPT");
    expect(reviewer.prompt).toBe("REVIEWER PROMPT");
  });

  it("never throws on a payload it can't serialise", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    let deep: Record<string, unknown> = circular;
    for (let i = 0; i < 10; i++) deep = { child: deep };
    circular.self = circular;
    const { port, bus } = start();
    expect(() => bus.emit("orchestration:event", { eventType: "x", detail: "d", data: deep } as never)).not.toThrow();
    const { ws, state } = await connect(port);
    expect(state.events.some((e) => e.type === "orchestration:event")).toBe(true);
    ws.close();
  });
});
