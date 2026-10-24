/**
 * Process-group helpers — regression test for the orphan-grandchild bug.
 *
 * The bug: when swarm spawned a worker (`bash -c <verify_script>`) that
 * itself spawned a long-lived grandchild (`pnpm vercel:dev` → `node vercel
 * dev --listen 3000`), and the worker exited for any reason — completion,
 * timeout, watchdog, kill — only the worker died. The grandchild was
 * reparented to launchd and kept holding port 3000, silently sabotaging
 * every subsequent worker run.
 *
 * The fix: spawn each worker in its own POSIX process group and signal the
 * group (not the leader pid) on every cleanup path. These tests exercise
 * that contract end-to-end with a real grandchild that binds a real port,
 * so a future regression — someone refactors the spawn site and forgets
 * `detached: true`, or replaces the group kill with a leader kill — fails
 * loudly here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { spawnInGroup, killGroup } from "../src/process-group.js";

// Track any child we spawn so afterEach can mop it up if a test fails before
// reaching its own cleanup. This is the test-harness equivalent of the
// orchestrator-side group kill we're testing.
const spawned: ChildProcess[] = [];

afterEach(async () => {
  for (const child of spawned) {
    if (child.pid !== undefined) {
      try {
        await killGroup(child.pid, { graceMs: 1000 });
      } catch {
        // ignore — best-effort teardown
      }
    }
  }
  spawned.length = 0;
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

async function isPortBound(port: number): Promise<boolean> {
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Build a shell snippet that backgrounds a port-listening node grandchild and exits. */
function grandchildScript(port: number, lifetimeSec = 30): string {
  // Single-quoted to keep our shell from interpolating; the embedded node -e
  // script binds the port and sleeps so it outlives the worker shell.
  const body = `const net=require('node:net');net.createServer(()=>{}).listen(${port},'127.0.0.1');setTimeout(()=>{},${lifetimeSec * 1000});`;
  return `node -e ${JSON.stringify(body)} & disown; exit 0`;
}

describe("spawnInGroup / killGroup — port-holding grandchild scenario", () => {
  it("kills a grandchild that outlives its parent shell", async () => {
    const port = await pickEphemeralPort();

    // Spawn a shell that backgrounds the grandchild and exits 0. This mirrors
    // the reported scenario: verify_script returns success while leaving a
    // long-lived `pnpm vercel:dev` behind.
    const child = spawnInGroup("bash", ["-c", grandchildScript(port)], { stdio: "ignore" });
    spawned.push(child);
    expect(child.pid).toBeTypeOf("number");

    // Wait for the worker shell to exit (it backgrounded the grandchild and quit).
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);

    // Confirm the grandchild is now an orphan holding the port — this is the
    // exact state that previously broke subsequent worker runs.
    const bound = await waitFor(() => isPortBound(port), 3000);
    expect(bound).toBe(true);

    // Signal the process group. Even though the leader shell already exited,
    // the group lives on because the grandchild is still a member.
    const result = await killGroup(child.pid!, { graceMs: 2000 });
    expect(result.sigkillRequired).toBe(false);

    // Port must be free now. If we ever regress to a leader-only kill, this
    // assertion stays bound and the test fails.
    const freed = await waitFor(async () => !(await isPortBound(port)), 3000);
    expect(freed).toBe(true);
  }, 15000);

  it("regression sanity: a plain (non-grouped) spawn leaks the grandchild", async () => {
    // Pin down the bug: prove that without process-group semantics, signaling
    // the leader pid leaves the grandchild running. The grandchild is in the
    // parent (test runner) process group, not in a group reachable via the
    // leader's pid — so `process.kill(leader.pid)` is a no-op once the leader
    // has reaped and there is no group to walk. We capture the grandchild pid
    // explicitly so this test cleans up after itself instead of leaking a
    // port-holding orphan into the next test.
    const port = await pickEphemeralPort();

    const script = `
      node -e 'const net=require("node:net");net.createServer(()=>{}).listen(${port},"127.0.0.1");setTimeout(()=>{},30000);' &
      echo $!
      disown
      exit 0
    `;
    const child = spawn("bash", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
    spawned.push(child);

    let stdoutBuf = "";
    child.stdout!.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
    });
    await once(child, "exit");

    const grandchildPid = Number(stdoutBuf.trim());
    expect(Number.isFinite(grandchildPid)).toBe(true);

    expect(await waitFor(() => isPortBound(port), 3000)).toBe(true);

    // The "naive" cleanup most callers reach for: signal the leader. The
    // leader is already reaped; the grandchild is unaffected.
    try {
      process.kill(child.pid!, "SIGTERM");
    } catch {
      // ESRCH expected
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(await isPortBound(port)).toBe(true);

    // Explicit teardown using the captured pid — real swarm code does this by
    // putting the worker in a process group so killGroup walks the tree.
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // already gone
    }
    expect(await waitFor(async () => !(await isPortBound(port)), 3000)).toBe(true);
  }, 15000);

  it("kills a still-running worker and its grandchild together", async () => {
    // Variant of the first test where the worker shell is still alive at kill
    // time. Both the leader and the grandchild must die.
    const port = await pickEphemeralPort();

    const child = spawnInGroup(
      "bash",
      ["-c", `node -e 'const net=require("node:net");net.createServer(()=>{}).listen(${port},"127.0.0.1");setInterval(()=>{},1000);'`],
      { stdio: "ignore" },
    );
    spawned.push(child);

    await waitFor(() => isPortBound(port), 3000);
    expect(child.killed).toBe(false);

    await killGroup(child.pid!, { graceMs: 2000 });

    const freed = await waitFor(async () => !(await isPortBound(port)), 3000);
    expect(freed).toBe(true);
  }, 15000);

  it("is idempotent on an already-drained group", async () => {
    const child = spawnInGroup("bash", ["-c", "exit 0"], { stdio: "ignore" });
    spawned.push(child);
    await once(child, "exit");
    // After the leader and any descendants are gone, killGroup should return
    // cleanly without throwing. Callers wire it into every exit path,
    // including ones that race with the natural exit.
    await expect(killGroup(child.pid!, { graceMs: 500 })).resolves.toEqual({
      sigkillRequired: false,
    });
  });

  it("forces SIGKILL when the group ignores SIGTERM", async () => {
    // A grandchild that traps SIGTERM and refuses to die. The grace window
    // expires; killGroup escalates to SIGKILL and reports sigkillRequired.
    const child = spawnInGroup(
      "bash",
      ["-c", `trap '' TERM; sleep 30 & wait`],
      { stdio: "ignore" },
    );
    spawned.push(child);

    // Give the trap a moment to install.
    await new Promise((r) => setTimeout(r, 100));

    const result = await killGroup(child.pid!, { graceMs: 300 });
    expect(result.sigkillRequired).toBe(true);
  }, 10000);
});
