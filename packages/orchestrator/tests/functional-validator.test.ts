import { describe, it, expect } from "vitest";
import net from "node:net";
import { runFunctionalChecks } from "../src/orchestrator/functional-validator.js";

describe("runFunctionalChecks", () => {
  it("passes when command exits 0", async () => {
    const results = await runFunctionalChecks(
      [{ description: "true exits 0", command: "true" }],
      "/tmp",
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when command exits non-zero", async () => {
    const results = await runFunctionalChecks(
      [{ description: "false exits 1", command: "false" }],
      "/tmp",
    );
    expect(results[0].passed).toBe(false);
  });

  it("fails on timeout", async () => {
    const results = await runFunctionalChecks(
      [{ description: "slow", command: "node -e \"setTimeout(()=>{},60000)\"", timeout_seconds: 1 }],
      "/tmp",
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain("timeout");
  });

  it("runs multiple checks sequentially", async () => {
    const results = await runFunctionalChecks(
      [
        { description: "pass", command: "true" },
        { description: "fail", command: "false" },
        { description: "pass again", command: "echo ok" },
      ],
      "/tmp",
    );
    expect(results).toHaveLength(3);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[2].passed).toBe(true);
  });

  it("blocks commands not in the allow-list", async () => {
    const results = await runFunctionalChecks(
      [{ description: "blocked", command: "rm -rf /" }],
      "/tmp",
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain("does not match any allowed prefix");
  });

  // Regression: a verify script that backgrounds a long-lived service (the
  // canonical case being `pnpm vercel:dev &`) must not leave the service
  // running after the check completes. Without the process-group sweep, the
  // backgrounded grandchild outlives the worker shell, holds its port, and
  // sabotages the next worker run. This test exercises the wiring end-to-end
  // through the public runFunctionalChecks API, not just the helper.
  it("sweeps backgrounded grandchildren after a check exits 0", async () => {
    const port = await pickEphemeralPort();
    const grandchild = `node -e 'const net=require("node:net");net.createServer(()=>{}).listen(${port},"127.0.0.1");setTimeout(()=>{},30000);'`;
    // The verify command exits immediately while the grandchild is still
    // listening — mirroring the reported scenario exactly. Pre-fix, this
    // would pass the check but leak the port; post-fix, the group sweep
    // reaps the grandchild before the call returns.
    const results = await runFunctionalChecks(
      [{ description: "backgrounds a server", command: `bash -c "${grandchild} & disown; exit 0"` }],
      "/tmp",
    );
    expect(results[0].passed).toBe(true);

    // Give any remaining I/O a moment to settle, then assert the port is free.
    await new Promise((r) => setTimeout(r, 200));
    expect(await isPortBound(port)).toBe(false);
  }, 10000);
});

function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no port")));
      }
    });
    server.on("error", reject);
  });
}

function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(200);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}
