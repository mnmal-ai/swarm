/**
 * Run functional checks from definition-of-done against the project.
 *
 * TRUST MODEL: Commands are sourced from the project's definition-of-done
 * markdown, which is committed to the repository by the project owner.
 * Commands must match an allowed prefix to execute. This prevents
 * arbitrary shell execution from malformed or injected DoD content.
 */

import { once } from "node:events";
import { resolve } from "node:path";
import { spawnInGroup, killGroup, type FunctionalCheck } from "@mnmal-ai/swarm-types";

export interface FunctionalCheckResult {
  description: string;
  passed: boolean;
  error?: string;
}

/** Maximum timeout for any single functional check (seconds). */
const MAX_TIMEOUT_S = 300;

/**
 * Allowed command prefixes. Only commands starting with one of these
 * prefixes will execute. This is an allow-list, not a block-list —
 * anything not explicitly permitted is rejected.
 */
const ALLOWED_COMMAND_PREFIXES = [
  "npm ", "npx ", "yarn ", "pnpm ",
  "cargo ", "go ", "python ", "python3 ", "node ",
  "tsc ", "vitest ", "jest ", "playwright ",
  "grep ", "curl ", "echo ", "cat ", "test ",
  "timeout ", "bash -c '", "bash -c \"",
  "true", "false",
];

/**
 * Check if a command is allowed to execute.
 * Returns null if allowed, or an error message if blocked.
 */
function validateCommand(command: string): string | null {
  const trimmed = command.trimStart();
  const isAllowed = ALLOWED_COMMAND_PREFIXES.some(
    (prefix) => trimmed.startsWith(prefix),
  );
  if (!isAllowed) {
    return `Command blocked: "${trimmed.slice(0, 60)}..." does not match any allowed prefix. Allowed: ${ALLOWED_COMMAND_PREFIXES.map((p) => p.trim()).join(", ")}`;
  }
  return null;
}

/**
 * Run a list of functional checks sequentially. Each check is a shell command
 * that must exit 0 to pass. Commands run in the project's working directory
 * and must match an allowed prefix.
 */
export async function runFunctionalChecks(
  checks: FunctionalCheck[],
  cwd: string,
): Promise<FunctionalCheckResult[]> {
  const results: FunctionalCheckResult[] = [];
  const resolvedCwd = resolve(cwd);

  for (const check of checks) {
    // Allow-list check
    const blocked = validateCommand(check.command);
    if (blocked) {
      results.push({ description: check.description, passed: false, error: blocked });
      continue;
    }

    const timeoutMs = Math.min(check.timeout_seconds ?? 30, MAX_TIMEOUT_S) * 1000;
    const outcome = await runCheck(check.command, resolvedCwd, timeoutMs);
    results.push({ description: check.description, ...outcome });
  }

  return results;
}

/**
 * Run one verify command in its own POSIX process group and sweep the group
 * on every exit path.
 *
 * Why the group sweep happens even on success: verify scripts that
 * background long-lived services (e.g. `pnpm vercel:dev &`) exit 0 while
 * leaving the service running. Without an end-of-run sweep, those orphans
 * survive into the next worker run, hold their ports, and silently
 * sabotage subsequent verify passes. The sweep also covers the timeout
 * path and the "shell died but spawned descendants" path.
 */
async function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ passed: boolean; error?: string }> {
  const child = spawnInGroup("bash", ["-c", command], { cwd, stdio: "ignore" });
  if (child.pid === undefined) {
    return { passed: false, error: "spawn failed (no pid)" };
  }
  const pid = child.pid;

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
    // Always sweep — even on clean exit — so backgrounded grandchildren do
    // not survive into the next check. Errors swallowed: cleanup is
    // best-effort and must not change the check's verdict.
    await killGroup(pid).catch(() => {});
  }

  if (timedOut) return { passed: false, error: "timeout" };
  if (exitCode === 0) return { passed: true };
  if (exitSignal) return { passed: false, error: `killed by ${exitSignal}` };
  return { passed: false, error: `exited with code ${exitCode ?? "unknown"}` };
}
