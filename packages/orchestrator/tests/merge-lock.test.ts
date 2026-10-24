import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileMergeQueue, repoKeyFromRemote } from "../src/source-control/merge-lock.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "swarm-merge-lock-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEY = "github.com/o/r#main";
const fast = { pollMs: 10, heartbeatMs: 20, staleMs: 200, guardRetryMs: 5, guardStaleMs: 500 };
const lockFile = () => readdirSync(dir).find((f) => f.endsWith(".lock") && !f.endsWith(".line.lock"));
const q = (pid: number, extra: Partial<ConstructorParameters<typeof FileMergeQueue>[1]> = {}) =>
  new FileMergeQueue(KEY, { dir, host: "here", pid, isAlive: () => true, ...fast, ...extra });

describe("repoKeyFromRemote", () => {
  it("gives one key for every URL form of one GitHub repository", () => {
    const forms = [
      "git@github.com:O/R.git",
      "https://github.com/o/r",
      "https://github.com/o/r.git/",
      "ssh://git@github.com/o/r",
      "https://x-access-token@github.com/O/r.git",
    ];
    for (const f of forms) expect(repoKeyFromRemote(f, "main")).toBe("github.com/o/r#main");
  });
  it("keeps the base and a local path apart", () => {
    expect(repoKeyFromRemote("git@github.com:o/r.git", "release/2")).toBe("github.com/o/r#release/2");
    expect(repoKeyFromRemote("/tmp/x/remote.git", "main")).toBe("local//tmp/x/remote#main");
  });
});

describe("FileMergeQueue", () => {
  it("takes and releases a turn, leaving no lock behind", async () => {
    const turn = await q(1).take({ project: "a", goalId: "g1" });
    expect(lockFile()).toBeDefined();
    expect(turn.waitedMs).toBeLessThan(1000);
    await turn.release();
    expect(lockFile()).toBeUndefined();
  });

  it("does not let a waiter that failed hold up the line: its ticket goes once it stops polling", async () => {
    const a = await q(1).take({ project: "a", goalId: "ga" });
    const pb = q(2).take({ project: "b", goalId: "gb" });
    await new Promise((r) => setTimeout(r, 30)); // b is in line behind a
    chmodSync(dir, 0o555); // the lock directory cannot be written: b's next poll throws
    try {
      await expect(pb).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    await a.release();
    const pc = q(3).take({ project: "c", goalId: "gc" });
    pc.catch(() => {});
    const got = await Promise.race([pc.then(() => "turn"), new Promise((r) => setTimeout(() => r("stuck"), 2000))]);
    expect(got).toBe("turn");
    await (await pc).release();
  });

  it("fails rather than waits forever when a stale line guard cannot be removed", async () => {
    // Learn the guard's name from a turn, then leave a stale guard behind in a directory that cannot be written.
    await (await q(1).take({ project: "a", goalId: "ga" })).release();
    const line = readdirSync(dir).find((f) => f.endsWith(".line.json"))!;
    const guard = join(dir, line.replace(/\.line\.json$/, ".line.lock"));
    writeFileSync(guard, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
    chmodSync(dir, 0o555);
    try {
      const p = q(2).take({ project: "b", goalId: "gb" });
      p.catch(() => {});
      const got = await Promise.race([p.then(() => "turn", () => "failed"), new Promise((r) => setTimeout(() => r("stuck"), 2000))]);
      expect(got).toBe("failed");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("hands turns out first come, first served", async () => {
    const order: string[] = [];
    const a = await q(1).take({ project: "a", goalId: "ga" });
    const waits: number[] = [];
    const pb = q(2).take({ project: "b", goalId: "gb" }, (w) => waits.push(w.ahead)).then((t) => { order.push("b"); return t; });
    await new Promise((r) => setTimeout(r, 30));
    const pc = q(3).take({ project: "c", goalId: "gc" }).then((t) => { order.push("c"); return t; });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]);
    await a.release();
    const b = await pb;
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["b"]);
    await b.release();
    await (await pc).release();
    expect(order).toEqual(["b", "c"]);
    expect(waits[0]).toBe(1);
  });

  it("takes over a lock whose holder on this host has died", async () => {
    const dead = await q(4242).take({ project: "dead", goalId: "gx" });
    void dead; // never released: the process "died"
    const turn = await q(1, { isAlive: (pid) => pid !== 4242 }).take({ project: "a", goalId: "g1" });
    expect(turn.tookOverFrom).toBe("dead");
    await turn.release();
  });

  it("respects a fresh lock from another host, and takes over a stale one", async () => {
    const other = await new FileMergeQueue(KEY, { dir, host: "there", pid: 7, isAlive: () => false, ...fast, heartbeatMs: 10_000 }).take({ project: "far", goalId: "gf" });
    void other;
    let got = false;
    const p = q(1, { isAlive: () => false }).take({ project: "a", goalId: "g1" }).then((t) => { got = true; return t; });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(false); // another host's pid is never checked locally
    const t = await p; // after staleMs (200 ms) without a heartbeat, it is taken over
    expect(t.tookOverFrom).toBe("far");
    await t.release();
  });

  it("waits on a young corrupt lock and takes over an old one", async () => {
    const holder = await q(9).take({ project: "x", goalId: "g9" });
    const name = lockFile()!;
    await holder.release();
    writeFileSync(join(dir, name), "{not json");
    let got = false;
    const p = q(1).take({ project: "a", goalId: "g1" }).then((t) => { got = true; return t; });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(false);
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(dir, name), old, old);
    await (await p).release();
  });

  it("never deletes another holder's lock on release", async () => {
    const first = await q(5, { isAlive: () => true }).take({ project: "x", goalId: "g5" });
    // Simulate a takeover: replace the lock with someone else's.
    const name = lockFile()!;
    const rec = JSON.parse(readFileSync(join(dir, name), "utf8"));
    writeFileSync(join(dir, name), JSON.stringify({ ...rec, ticket: "someone-else" }));
    await first.release();
    expect(existsSync(join(dir, name))).toBe(true);
  });

  it("takes over from a real process that was killed (real pid check)", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    const ghost = await new FileMergeQueue(KEY, { dir, host: "here", pid: child.pid!, ...fast, heartbeatMs: 60_000 }).take({ project: "ghost", goalId: "gg" });
    void ghost;
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const t = await new FileMergeQueue(KEY, { dir, host: "here", pid: process.pid, ...fast }).take({ project: "a", goalId: "g1" });
    expect(t.tookOverFrom).toBe("ghost");
    await t.release();
  });
});
