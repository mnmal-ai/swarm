/**
 * `swarm run` stops its dashboard right before it prints the session summary
 * and captures what the run learned, so DashboardServer.stop() must not wait
 * for the people watching. It used to: it closed each WebSocket politely and
 * then waited for the HTTP server's close, which only comes once every
 * connection has ended. A viewer slow to answer the close frame, or a request
 * still arriving, kept it pending; under Bun, which the compiled binary runs
 * on, an ordinary open page was enough, and the run ended without its summary
 * or its learning capture.
 */

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";

const sockets: net.Socket[] = [];
const servers: DashboardServer[] = [];
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.length = 0;
  // Whatever a test left listening is closed here, so a stop() regression
  // cannot leak a listener into the next test (stop() may run twice).
  await Promise.all(servers.splice(0).map((server) => settlesWithin(server.stop(), 2_000)));
});

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

/** A dashboard on an ephemeral port: it listens on 0, and the OS's choice is read back. */
async function startDashboard(): Promise<{ server: DashboardServer; port: number }> {
  const server = new DashboardServer(new SwarmEventBus(), 0);
  servers.push(server);
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = server.listeningPort;
    if (port !== null) return { server, port };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("dashboard never listened");
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  sockets.push(socket);
  return socket;
}

/** A viewer that sends `request` and then reads, answering nothing (not even a close frame). */
async function deafViewer(port: number, request: string, waitFor?: string): Promise<net.Socket> {
  const socket = await connect(port);
  let received = "";
  const seen = new Promise<void>((resolve) => {
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (waitFor === undefined || received.includes(waitFor)) resolve();
    });
  });
  socket.write(request);
  await (waitFor === undefined ? new Promise((r) => setTimeout(r, 100)) : seen);
  return socket;
}

/** Whether the server ends `socket` within `ms`. */
function closedWithin(socket: net.Socket, ms: number): Promise<boolean> {
  if (socket.closed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("DashboardServer.stop() does not wait for viewers", () => {
  it("resolves while a viewer's WebSocket never answers the close frame, and drops that viewer", async () => {
    const { server, port } = await startDashboard();
    const viewer = await deafViewer(
      port,
      `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      "101 Switching Protocols",
    );

    expect(await settlesWithin(server.stop(), 2_000)).toBe(true);
    expect(await closedWithin(viewer, 2_000)).toBe(true);
  });

  it("resolves while a viewer's request is still arriving, and drops that connection", async () => {
    const { server, port } = await startDashboard();
    const viewer = await deafViewer(port, `GET / HTTP/1.1\r\nHost: localhost:${port}\r\n`);

    expect(await settlesWithin(server.stop(), 2_000)).toBe(true);
    expect(await closedWithin(viewer, 2_000)).toBe(true);
  });
});
