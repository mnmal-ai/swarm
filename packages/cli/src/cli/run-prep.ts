/**
 * What `swarm run` does to the work repo before any goal is touched, so a
 * project needs no launcher script around it:
 *
 * - one run per project at a time (`.swarm/run.lock`);
 * - the base branch brought up to date (`source_control.sync_base_branch`);
 * - the project's own setup command (`setup_command`).
 *
 * Every refusal is a RunPrepError with a message written for the person at
 * the terminal; `swarm run` prints it and exits 1 before any work starts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";

export class RunPrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunPrepError";
  }
}

// ---------------------------------------------------------------------------
// Run lock
// ---------------------------------------------------------------------------

interface RunLock {
  pid: number;
  run_id: string;
  started_at: string;
}

export function runLockPath(swarmPath: string): string {
  return join(swarmPath, "run.lock");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the project's run lock. Throws RunPrepError when another live swarm
 * process holds it; a lock left by a dead process is replaced. Returns the
 * function that releases it (safe to call more than once).
 */
export function acquireRunLock(swarmPath: string, runId: string, pid: number = process.pid): () => void {
  const path = runLockPath(swarmPath);
  if (existsSync(path)) {
    let held: Partial<RunLock> = {};
    try { held = JSON.parse(readFileSync(path, "utf-8")) as Partial<RunLock>; } catch { /* unreadable: treat as stale */ }
    if (typeof held.pid === "number" && held.pid !== pid && processAlive(held.pid)) {
      throw new RunPrepError(
        `a swarm run is already going for this project (pid ${held.pid}, ${held.run_id ?? "unknown run"}, since ${held.started_at ?? "?"}).\n` +
        `  Wait for it, or if it is not running any more remove ${path}`,
      );
    }
  }
  mkdirSync(swarmPath, { recursive: true });
  const lock: RunLock = { pid, run_id: runId, started_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n", "utf-8");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(path, "utf-8")) as Partial<RunLock>;
      if (current.pid === pid) rmSync(path, { force: true });
    } catch { /* already gone */ }
  };
}

// ---------------------------------------------------------------------------
// Base branch sync
// ---------------------------------------------------------------------------

export interface BaseSyncResult {
  before: string;
  after: string;
  /** Commits the fast-forward brought in. */
  commits: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Fetch `remote` and fast-forward `baseBranch` to `remote/baseBranch`. The
 * repo must have `baseBranch` checked out with a clean tree; anything else,
 * or a base that cannot be fast-forwarded, is a RunPrepError.
 *
 * `ignore` names paths (absolute) that do not count as dirt, with everything
 * under them: the swarm directory, when it lives inside the work repo, since
 * swarm itself writes there (goals.json, learned/, telemetry, the run lock).
 */
export function syncBaseBranch(repoRoot: string, remote: string, baseBranch: string, ignore: string[] = []): BaseSyncResult {
  const current = git(repoRoot, ["branch", "--show-current"]);
  if (current !== baseBranch) {
    throw new RunPrepError(
      `source_control.sync_base_branch is on, but ${repoRoot} has "${current || "a detached HEAD"}" checked out, not ${baseBranch}.\n` +
      `  Check out ${baseBranch} (or turn sync_base_branch off) and run again`,
    );
  }
  const ignored = ignore
    .map((p) => relative(resolve(repoRoot), resolve(p)))
    .filter((rel) => rel !== "" && !rel.startsWith(".."));
  const isIgnored = (file: string): boolean => ignored.some((ig) => file === ig || file.startsWith(ig + "/"));
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line.length > 3 && !isIgnored(line.slice(3).trim().replace(/^"|"$/g, "")))
    .join("\n");
  if (dirty.length > 0) {
    throw new RunPrepError(
      `source_control.sync_base_branch is on, but ${repoRoot} has uncommitted changes:\n` +
      dirty.split("\n").slice(0, 10).map((l) => `    ${l}`).join("\n") +
      (dirty.split("\n").length > 10 ? "\n    …" : "") +
      `\n  Commit or stash them and run again`,
    );
  }
  try {
    git(repoRoot, ["remote", "get-url", remote]);
  } catch {
    throw new RunPrepError(`source_control.sync_base_branch is on, but ${repoRoot} has no remote named "${remote}"`);
  }
  const before = git(repoRoot, ["rev-parse", "HEAD"]);
  try {
    git(repoRoot, ["fetch", "--quiet", remote, baseBranch]);
  } catch (err) {
    throw new RunPrepError(`git fetch ${remote} ${baseBranch} failed in ${repoRoot}:\n  ${stderrOf(err)}`);
  }
  try {
    git(repoRoot, ["merge", "--ff-only", "--quiet", `${remote}/${baseBranch}`]);
  } catch (err) {
    throw new RunPrepError(
      `${baseBranch} in ${repoRoot} cannot be fast-forwarded to ${remote}/${baseBranch}: it has commits the remote does not.\n` +
      `  ${stderrOf(err)}\n  Push or drop them and run again`,
    );
  }
  const after = git(repoRoot, ["rev-parse", "HEAD"]);
  const commits = before === after ? 0 : parseInt(git(repoRoot, ["rev-list", "--count", `${before}..${after}`]), 10);
  return { before, after, commits };
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  const text = e.stderr ? String(e.stderr).trim() : (e.message ?? String(err));
  return text.split("\n").join("\n  ");
}

// ---------------------------------------------------------------------------
// Setup command
// ---------------------------------------------------------------------------

/**
 * Run the project's `setup_command` in the work repo with `sh -c`, sharing
 * the terminal. Resolves when it exits 0; rejects with RunPrepError otherwise.
 */
export function runSetupCommand(repoRoot: string, command: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd: repoRoot, env, stdio: "inherit" });
    child.on("error", (err) => reject(new RunPrepError(`setup_command could not start: ${err.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new RunPrepError(
        `setup_command failed (${signal ? `signal ${signal}` : `exit ${code}`}) in ${repoRoot}:\n    ${command}`,
      ));
    });
  });
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Errors in the config keys this module and the dashboard read, so a typo
 * stops the run before any work instead of being silently ignored.
 */
export function validateRunPrepConfig(projectConfig: unknown): string[] {
  if (projectConfig === null || typeof projectConfig !== "object") return [];
  const cfg = projectConfig as Record<string, unknown>;
  const errors: string[] = [];

  const sc = cfg.source_control;
  if (sc !== undefined && sc !== null && typeof sc === "object") {
    const sync = (sc as Record<string, unknown>).sync_base_branch;
    if (sync !== undefined && typeof sync !== "boolean") {
      errors.push(`source_control.sync_base_branch must be true or false (got ${JSON.stringify(sync)})`);
    }
  }

  if (cfg.setup_command !== undefined && (typeof cfg.setup_command !== "string" || cfg.setup_command.trim() === "")) {
    errors.push(`setup_command must be a non-empty shell command string (got ${JSON.stringify(cfg.setup_command)})`);
  }

  if (cfg.dashboard !== undefined) {
    const d = cfg.dashboard;
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      errors.push(`dashboard must be an object: { "port": 3141, "lan": false }`);
    } else {
      const { port, lan } = d as Record<string, unknown>;
      if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
        errors.push(`dashboard.port must be an integer from 1 to 65535 (got ${JSON.stringify(port)})`);
      }
      if (lan !== undefined && typeof lan !== "boolean") {
        errors.push(`dashboard.lan must be true or false (got ${JSON.stringify(lan)})`);
      }
    }
  }

  const backends = cfg.backends;
  if (backends !== null && typeof backends === "object") {
    for (const [role, backend] of Object.entries(backends as Record<string, unknown>)) {
      if (backend === null || typeof backend !== "object") continue;
      const auth = (backend as Record<string, unknown>).auth;
      if (auth !== undefined && auth !== "subscription" && auth !== "api_key") {
        errors.push(`backends.${role}.auth must be "subscription" or "api_key" (got ${JSON.stringify(auth)})`);
      }
    }
  }

  return errors;
}

export function assertValidRunPrepConfig(projectConfig: unknown, configPath: string): void {
  const errors = validateRunPrepConfig(projectConfig);
  if (errors.length === 0) return;
  throw new Error(`Invalid config in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}
