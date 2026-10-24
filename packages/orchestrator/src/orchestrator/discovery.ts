/**
 * Discovery phase — run build/test/lint commands to understand project state
 * before decomposing goals into tasks.
 *
 * This eliminates blind task decomposition by giving the orchestrator actual
 * error output from the project's current state.
 */

import { once } from "node:events";
import { spawnInGroup, killGroup } from "@mnmal-ai/swarm-types";

export interface DiscoveryCommand {
  /** The shell command to run (e.g., "npm test", "swift build") */
  command: string;
  /** Working directory for the command */
  cwd: string;
  /** Timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Human-readable label (e.g., "build", "test", "lint") */
  label: string;
}

export interface DiscoveryResult {
  /** The command that was run */
  command: string;
  label: string;
  /** Whether the command exited with code 0 */
  success: boolean;
  /** Exit code */
  exitCode: number;
  /** Combined stdout */
  stdout: string;
  /** Combined stderr */
  stderr: string;
  /** Duration in ms */
  durationMs: number;
  /** Timestamp of when discovery was run */
  timestamp: number;
}

export interface DiscoveryPhaseResult {
  /** All discovery commands and their results */
  results: DiscoveryResult[];
  /** Summary: how many passed, how many failed */
  summary: string;
  /** Concatenated error output for feeding to the orchestrator's task decomposition */
  errorContext: string;
}

/**
 * Run a discovery phase: execute one or more commands to understand
 * the current project state before decomposing goals into tasks.
 */
export async function runDiscovery(
  commands: DiscoveryCommand[],
): Promise<DiscoveryPhaseResult> {
  const results: DiscoveryResult[] = [];

  for (const cmd of commands) {
    const start = Date.now();
    const outcome = await runDiscoveryCommand(cmd);
    results.push({
      command: cmd.command,
      label: cmd.label,
      success: outcome.success,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout.slice(-5000), // last 5000 chars to stay within budget
      stderr: outcome.stderr.slice(-5000),
      durationMs: Date.now() - start,
      timestamp: start,
    });
  }

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const summary = `Discovery: ${passed}/${results.length} passed, ${failed} failed`;

  // Concatenate error output for orchestrator context
  const errorContext = results
    .filter((r) => !r.success)
    .map((r) => `[${r.label}] exit ${r.exitCode}:\n${r.stderr || r.stdout}`)
    .join("\n\n---\n\n");

  return { results, summary, errorContext };
}

const MAX_STDOUT_BYTES = 1024 * 1024;

/** After a command exits, how long discovery waits for the rest of its
 *  output: the pipes are read separately from the exit. */
const DRAIN_MS = 2_000;

/**
 * Run one discovery command in its own POSIX process group, capture
 * stdout/stderr, and sweep the group on every exit path.
 *
 * Discovery commands are typically build/test/lint runners that exit cleanly,
 * but they (or their toolchain) can spawn workers, watchers, language servers,
 * or backgrounded services. Putting each command in a process group and
 * sweeping at the end keeps the orchestrator's view of "the discovery phase
 * is done" honest — no orphans left behind to interfere with the next phase.
 */
async function runDiscoveryCommand(
  cmd: DiscoveryCommand,
): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = cmd.timeoutMs ?? 60000;

  const child = spawnInGroup("bash", ["-c", cmd.command], {
    cwd: cmd.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    return { success: false, exitCode: 1, stdout: "", stderr: "spawn failed (no pid)" };
  }
  const pid = child.pid;
  // Both pipes closed and the process gone: only then is the output complete.
  const closed = once(child, "close").catch(() => undefined);

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutBytes < MAX_STDOUT_BYTES) {
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout += slice.toString("utf-8");
      stdoutBytes += slice.length;
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes < MAX_STDOUT_BYTES) {
      const remaining = MAX_STDOUT_BYTES - stderrBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr += slice.toString("utf-8");
      stderrBytes += slice.length;
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killGroup(pid).catch(() => {});
  }, timeoutMs);

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  try {
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    exitCode = code;
    exitSignal = signal;
  } finally {
    clearTimeout(timer);
    await killGroup(pid).catch(() => {});
  }
  // `exit` can arrive before the last of the output, which is read from the
  // pipes on its own. Wait for them to close (the group is killed, so they
  // do), but never long: a descendant that left the group can hold one open.
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise((resolve) => { drainTimer = setTimeout(resolve, DRAIN_MS); })]);
  clearTimeout(drainTimer);

  if (timedOut) {
    return { success: false, exitCode: exitCode ?? 124, stdout, stderr: stderr || "timeout" };
  }
  if (exitSignal) {
    return { success: false, exitCode: exitCode ?? 1, stdout, stderr: stderr || `killed by ${exitSignal}` };
  }
  return { success: exitCode === 0, exitCode: exitCode ?? 1, stdout, stderr };
}
