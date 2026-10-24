/**
 * POSIX process-group helpers for clean subprocess-tree cleanup.
 *
 * When a parent spawns a child that itself spawns descendants (`bash -c`
 * launching `pnpm vercel:dev` launching `node vercel dev`...), killing only
 * the immediate child does NOT kill the descendants — POSIX reparents them
 * to init/launchd, where they continue to hold ports, file locks, and any
 * other resources they acquired. The orchestrator's next run then trips
 * over the orphans.
 *
 * The fix is to put each spawn in its own process group at creation time
 * and signal the group (not the leader pid) on every cleanup path. Group
 * walking is atomic and recursive — no race window for late forks, no
 * heuristic `pkill -f` pattern matching that can hit unrelated processes
 * from concurrent swarm sessions.
 *
 * POSIX-only by design. Windows has no process-group equivalent; callers
 * needing Windows support must use job objects (CreateJobObject +
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) via a separate code path.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Spawn `command` as the leader of a new POSIX process group.
 *
 * `detached: true` performs `setsid()` at exec time, making the child the
 * leader of a new session and process group whose pgid equals the child's
 * pid. Descendants spawned by the child inherit this pgid, so a later
 * `killGroup(child.pid)` reaches every transitive descendant.
 *
 * Note: we deliberately do NOT call `child.unref()`. The standard "detached
 * + unref" recipe lets the child outlive the parent (useful for daemons),
 * but here we want the opposite: the orchestrator owns the lifecycle and
 * is responsible for tearing the tree down.
 */
export function spawnInGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (process.platform === "win32") {
    throw new Error(
      "spawnInGroup is POSIX-only. Windows has no process groups; " +
        "callers needing Windows support must use job objects.",
    );
  }
  return spawn(command, args as string[], { ...options, detached: true });
}

/**
 * Signal the process group led by `pid` with SIGTERM, then SIGKILL any
 * stragglers after `graceMs`. Resolves once the group is fully drained or
 * SIGKILL has been delivered.
 *
 * Idempotent: calling this on an already-drained group returns immediately
 * with `sigkillRequired: false`. Safe to invoke from every cleanup path
 * (normal exit, timeout, watchdog, panic, finally block).
 *
 * The POSIX primitive is `kill(-pgid, sig)` — a negative pid argument means
 * "the process group with this id," not "this specific process." Node
 * surfaces this verbatim via `process.kill(-pid, sig)`. The negative-pid
 * convention is the only correct way to signal a group; `pkill -P` walks
 * one level and races with concurrent forks, and `pkill -f` heuristics
 * match unrelated processes across sessions.
 */
export async function killGroup(
  pid: number,
  options: { graceMs?: number } = {},
): Promise<{ sigkillRequired: boolean }> {
  const graceMs = options.graceMs ?? 5000;

  if (!signalGroup(pid, "SIGTERM")) {
    return { sigkillRequired: false };
  }

  // Poll for the group to drain rather than waitpid'ing the leader: the
  // leader may already be reaped while the group lives on through its other
  // members (a backgrounded grandchild outlasting the shell that spawned
  // it is exactly the case this whole helper exists to handle).
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!groupAlive(pid)) {
      return { sigkillRequired: false };
    }
  }

  signalGroup(pid, "SIGKILL");
  return { sigkillRequired: true };
}

const POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw err;
  }
}

function groupAlive(pid: number): boolean {
  try {
    // Signal 0 is the existence probe — no side effects, just checks that
    // we have permission to signal the target.
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}
