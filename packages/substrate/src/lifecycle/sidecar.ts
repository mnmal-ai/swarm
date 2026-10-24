/**
 * One sidecar's process: `<node> <runtime>/node_modules/@mnmal-ai/substrate/dist/substrate.js serve`,
 * detached, bound to 127.0.0.1 on the spec's port, with its stack directory as
 * `SUBSTRATE_PLUGIN_DIR`. Output goes to `<stack dir>/server.log` (fresh per
 * start) and the pid to `<stack dir>/server.pid`.
 *
 * `ensureSidecar` leaves a healthy sidecar alone, waits for one that is still
 * booting, and otherwise starts one and polls `/health` every 500 ms for up to
 * 15 s; a child that exits during boot fails at once with the last lines of its
 * log. `stopSidecar` signals a pid only when it is this stack's sidecar: its
 * argv is exactly `<node> <stack's substrate.js, resolved> serve` and its
 * working directory is the stack directory (see {@link sidecarProcessCheck}).
 * Any other process at that pid (a reused pid, another project's Substrate, the
 * sibling sidecar) is never signalled. SIGTERM, up to 5 s, then SIGKILL.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isLocalOnlyEnv,
  LocalOnlyViolation,
  loopbackViolation,
  postgresLoopbackViolation,
} from "../local-only.js";
import type { RuntimeInfo } from "./runtime.js";
import { type SidecarSpec, sidecarUrl } from "./specs.js";
import { stackDirFor } from "./stacks.js";

export const SIDECAR_POLL_INTERVAL_MS = 500;
export const SIDECAR_BOOT_TIMEOUT_MS = 15_000;
export const SIDECAR_STOP_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 20;

export interface EnsureSidecarOptions {
  /** Absolute path to the node binary (from `resolveNode`). */
  node: string;
  runtime: RuntimeInfo;
  /** The spec's stack directory (from `ensureStackDir`). */
  stackDir: string;
  quiet?: boolean;
  /** How long to wait for `/health` after a start. Default 15 s. */
  bootTimeoutMs?: number;
}

export interface SidecarStatus {
  label: SidecarSpec["label"];
  /** The loopback URL the sidecar answers on. */
  endpoint: string;
  /** From `server.pid`, when there is one. */
  pid: number | null;
  /** True when this call spawned the process. */
  started: boolean;
}

/** The sidecar did not come up; the message carries the tail of its log. */
export class SidecarStartError extends Error {
  override readonly name = "SidecarStartError";
  constructor(
    message: string,
    readonly logFile: string,
  ) {
    super(message);
  }
}

function log(quiet: boolean | undefined, message: string): void {
  if (!quiet) console.log(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Who a sidecar writes as while auth is off. */
export function systemActorFor(spec: Pick<SidecarSpec, "scope">): string {
  return spec.scope === "meta" ? "swarm-meta" : "swarm";
}

/**
 * The sidecar's environment: the caller's, without any
 * `SUBSTRATE_*` variable (a stray `SUBSTRATE_AUTH_MODE` would turn
 * auth on), plus `SUBSTRATE_DATABASE_URL`, `SUBSTRATE_PLUGIN_DIR`,
 * `SUBSTRATE_SYSTEM_ACTOR`, `HOST=127.0.0.1` and `PORT`.
 */
export function sidecarEnv(
  spec: SidecarSpec,
  stackDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^SUBSTRATE_/.test(key) || key === "HOST" || key === "PORT") continue;
    env[key] = value;
  }
  env.SUBSTRATE_DATABASE_URL = spec.postgresUrl;
  env.SUBSTRATE_PLUGIN_DIR = stackDir;
  env.SUBSTRATE_SYSTEM_ACTOR = systemActorFor(spec);
  env.HOST = "127.0.0.1";
  env.PORT = String(spec.port);
  return env;
}

/** `GET <url>/health` answered ok within 2 s. */
export async function sidecarHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The Ollama URL a stack's recall config names, if any. */
function recallBaseUrl(stackDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(stackDir, "substrate-recall.config.json"), "utf8")) as {
      embedder?: { baseUrl?: unknown };
    };
    return typeof raw.embedder?.baseUrl === "string" ? raw.embedder.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/** The local_only re-check against what this sidecar would actually use. */
function assertSidecarLocalOnly(spec: SidecarSpec, stackDir: string): void {
  const violations = [
    postgresLoopbackViolation(`${spec.label} sidecar Postgres URL`, spec.postgresUrl),
    loopbackViolation(
      `Embedder URL (ollama, ${join(stackDir, "substrate-recall.config.json")})`,
      recallBaseUrl(stackDir),
    ),
  ].filter((v): v is string => v !== null);
  if (violations.length > 0) throw new LocalOnlyViolation(violations);
}

/** The pid in `spec`'s `server.pid`, or null. */
export function readSidecarPid(spec: Pick<SidecarSpec, "label" | "stack">): number | null {
  return readPid(join(stackDirFor(spec), "server.pid"));
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface ProcessInfo {
  /** Live and not a zombie. */
  alive: boolean;
  /** The exact argv, where the platform gives it (Linux `/proc/<pid>/cmdline`). */
  argv: string[] | null;
  /** The command line as one string (`ps -ww -o command=`), where argv is not available. */
  command: string | null;
  /** The working directory (`/proc/<pid>/cwd`, or `lsof -a -p <pid> -d cwd -Fn`). */
  cwd: string | null;
}

const GONE: ProcessInfo = { alive: false, argv: null, command: null, cwd: null };

/** `path` resolved through symlinks, or `path` itself when it cannot be. */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The working directory of `pid` from lsof (macOS), or null. */
function lsofCwd(pid: number): string | null {
  for (const lsof of ["lsof", "/usr/sbin/lsof"]) {
    try {
      const out = execFileSync(lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = out.split("\n").find((l) => l.startsWith("n"));
      return line === undefined ? null : line.slice(1);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return null;
}

/** Whether `pid` is a live (not zombie) process, with its argv or command line and its cwd when they can be read. */
export function processInfo(pid: number): ProcessInfo {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return GONE;
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const status = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) S ...`; comm may itself contain ")".
    const state = status.slice(status.lastIndexOf(")") + 1).trim()[0];
    const argv = cmdline.split("\0");
    if (argv[argv.length - 1] === "") argv.pop();
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
    return { alive: state !== "Z", argv, command: argv.join(" "), cwd };
  } catch {
    /* no /proc (macOS): ask ps and lsof */
  }
  try {
    const out = execFileSync("ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return GONE;
    const match = /^(\S+)\s+(.*)$/s.exec(out);
    const stat = match?.[1] ?? out;
    const alive = !stat.startsWith("Z");
    return { alive, argv: null, command: match?.[2] ?? null, cwd: alive ? lsofCwd(pid) : null };
  } catch {
    // ps exits non-zero when the pid is gone.
    return GONE;
  }
}

/** The `substrate.js` a stack's sidecar runs: through the stack's `node_modules` link, symlinks resolved. */
export function serveBinFor(stackDir: string): string {
  return realpathOr(join(stackDir, "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js"));
}

/**
 * Whether `info` is the sidecar of `stackDir`: argv exactly
 * `<node> <serveBinFor(stackDir)> serve` (on macOS, where only the joined
 * command line is available, it must end with ` <bin> serve`), and the working
 * directory is the stack directory. `reason` says what failed.
 */
export function sidecarProcessCheck(info: ProcessInfo, stackDir: string): { ours: boolean; reason: string } {
  if (!info.alive) return { ours: false, reason: "not running" };
  const bin = serveBinFor(stackDir);
  const argvOk =
    info.argv !== null
      ? info.argv.length === 3 && info.argv[1] === bin && info.argv[2] === "serve"
      : info.command !== null && info.command.endsWith(` ${bin} serve`);
  if (!argvOk) {
    return { ours: false, reason: `its command line is not '<node> ${bin} serve' (${info.command ?? "unreadable"})` };
  }
  if (info.cwd === null || realpathOr(info.cwd) !== realpathOr(stackDir)) {
    return { ours: false, reason: `its working directory is ${info.cwd ?? "unreadable"}, not ${stackDir}` };
  }
  return { ours: true, reason: "" };
}

function logTail(logFile: string): string {
  try {
    const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return "(no log)";
  }
}

async function pollHealthy(url: string, timeoutMs: number, stop: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(SIDECAR_POLL_INTERVAL_MS);
    if (stop()) return false;
    if (await sidecarHealthy(url)) return true;
  }
  return false;
}

/**
 * Why `<stackDir>/node_modules` does not lead to the runtime's substrate.js,
 * naming the path and the fix. `swarm substrate start` (re)writes the stack
 * directory, which (re)links a missing or stray symlink; a real directory is
 * left alone there on purpose, so it has to be removed by hand first.
 */
export function runtimeLinkProblem(stackDir: string, runtimeDir: string): string {
  const link = join(stackDir, "node_modules");
  const target = join(runtimeDir, "node_modules");
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(link);
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    return `${link} is missing. Run \`swarm substrate start\`, which links it to the Substrate runtime (${target}).`;
  }
  if (!stat.isSymbolicLink()) {
    return (
      `${link} is a real directory, not the link to the Substrate runtime (${target}), and swarm does not ` +
      `replace a directory it did not create. Remove it (rm -rf ${link}) and run \`swarm substrate start\`, which links it.`
    );
  }
  const points = readlinkSync(link);
  if (realpathOr(resolve(stackDir, points)) === realpathOr(target)) {
    const bin = join(target, "@mnmal-ai", "substrate", "dist", "substrate.js");
    return (
      `${bin} is missing: the Substrate runtime in ${runtimeDir} is incomplete. ` +
      `Remove ${runtimeDir} and run \`swarm substrate start\`, which reinstalls it.`
    );
  }
  return `${link} links to ${points}, not to the Substrate runtime (${target}). Run \`swarm substrate start\`, which relinks it.`;
}

/**
 * Ensure `spec`'s sidecar answers `/health` (see the module doc). Under
 * `SWARM_SUBSTRATE_LOCAL_ONLY` it first refuses a non-loopback Postgres or
 * embedder, before probing or spawning anything.
 */
export async function ensureSidecar(spec: SidecarSpec, opts: EnsureSidecarOptions): Promise<SidecarStatus> {
  const { stackDir, quiet } = opts;
  if (isLocalOnlyEnv()) assertSidecarLocalOnly(spec, stackDir);
  const url = sidecarUrl(spec);
  const pidFile = join(stackDir, "server.pid");
  const logFile = join(stackDir, "server.log");
  const bootTimeoutMs = opts.bootTimeoutMs ?? SIDECAR_BOOT_TIMEOUT_MS;
  const name = `Substrate sidecar (${spec.label}, port ${spec.port})`;

  log(quiet, `[swarm] Checking ${name}...`);
  if (await sidecarHealthy(url)) {
    log(quiet, `[swarm] Checking ${name}... running`);
    return { label: spec.label, endpoint: url, pid: readPid(pidFile), started: false };
  }

  // A sidecar this stack started earlier may still be booting: wait for it
  // rather than start a second one on the same port.
  const bin = serveBinFor(stackDir);
  if (bin !== realpathOr(opts.runtime.substrateBin)) {
    throw new SidecarStartError(runtimeLinkProblem(stackDir, opts.runtime.runtimeDir), logFile);
  }
  const previous = readPid(pidFile);
  if (previous !== null) {
    const info = processInfo(previous);
    const check = sidecarProcessCheck(info, stackDir);
    if (!check.ours && info.alive) {
      log(quiet, `[swarm] ${pidFile} names pid ${previous}, which is not this stack's sidecar (${check.reason}); ignoring it.`);
    }
    if (check.ours) {
      log(quiet, `[swarm] Checking ${name}... waiting for pid ${previous}`);
      if (await pollHealthy(url, bootTimeoutMs, () => !processInfo(previous).alive)) {
        log(quiet, `[swarm] ${name} ready on ${url}`);
        return { label: spec.label, endpoint: url, pid: previous, started: false };
      }
      if (processInfo(previous).alive) {
        throw new SidecarStartError(
          `${name} is running (pid ${previous}) but not answering ${url}/health. ` +
            `Stop it (swarm substrate stop) and start again. Last lines of ${logFile}:\n${logTail(logFile)}`,
          logFile,
        );
      }
    }
    rmSync(pidFile, { force: true });
  }

  log(quiet, `[swarm] Checking ${name}... starting`);
  const fd = openSync(logFile, "w", 0o600);
  let spawnError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let pid: number | undefined;
  try {
    const child = spawn(opts.node, [bin, "serve"], {
      cwd: stackDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: sidecarEnv(spec, stackDir),
    });
    child.once("error", (err) => {
      spawnError = err;
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(fd);
  }
  if (pid !== undefined) writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });

  const up = await pollHealthy(url, bootTimeoutMs, () => spawnError !== undefined || exit !== undefined);
  if (up) {
    log(quiet, `[swarm] ${name} ready on ${url}`);
    return { label: spec.label, endpoint: url, pid: pid ?? null, started: true };
  }

  if (spawnError !== undefined || exit !== undefined) {
    rmSync(pidFile, { force: true });
    const how =
      spawnError !== undefined
        ? `could not start (${spawnError.message})`
        : `exited during startup (${exit?.signal ?? `code ${exit?.code}`})`;
    throw new SidecarStartError(
      `${name} ${how}: ${opts.node} ${opts.runtime.substrateBin} serve. Last lines of ${logFile}:\n${logTail(logFile)}`,
      logFile,
    );
  }
  throw new SidecarStartError(
    `${name} did not answer ${url}/health within ${bootTimeoutMs / 1000} s (pid ${pid}, still running). ` +
      `Last lines of ${logFile}:\n${logTail(logFile)}`,
    logFile,
  );
}

export interface StopSidecarOptions {
  /** Defaults to the spec's stack directory. */
  stackDir?: string;
  /** How long SIGTERM gets before SIGKILL. Default 5 s. */
  timeoutMs?: number;
}

export interface StopSidecarResult {
  /** True when a running sidecar was signalled and is gone. */
  stopped: boolean;
  pid: number | null;
  /** Why nothing was stopped. */
  reason?: string;
}

async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processInfo(pid).alive) return true;
    await sleep(100);
  }
  return !processInfo(pid).alive;
}

/**
 * Stop `spec`'s sidecar from its `server.pid`: SIGTERM, wait up to 5 s, then
 * SIGKILL. A pid that is gone, or that is not this stack's sidecar
 * ({@link sidecarProcessCheck}), is not signalled; its pid file is removed and
 * `reason` says why.
 */
export async function stopSidecar(spec: SidecarSpec, opts: StopSidecarOptions = {}): Promise<StopSidecarResult> {
  const stackDir = opts.stackDir ?? stackDirFor(spec);
  const pidFile = join(stackDir, "server.pid");
  if (!existsSync(pidFile)) return { stopped: false, pid: null, reason: "no server.pid" };
  const pid = readPid(pidFile);
  if (pid === null) {
    rmSync(pidFile, { force: true });
    return { stopped: false, pid: null, reason: "server.pid holds no pid" };
  }
  const info = processInfo(pid);
  if (!info.alive) {
    rmSync(pidFile, { force: true });
    return { stopped: false, pid, reason: "not running" };
  }
  const check = sidecarProcessCheck(info, stackDir);
  if (!check.ours) {
    rmSync(pidFile, { force: true });
    return {
      stopped: false,
      pid,
      reason: `pid ${pid} is not this stack's Substrate sidecar: ${check.reason}. Removed ${pidFile}; nothing was signalled.`,
    };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* gone between the check and the signal */
  }
  if (!(await waitGone(pid, opts.timeoutMs ?? SIDECAR_STOP_TIMEOUT_MS))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
    await waitGone(pid, 2_000);
  }
  rmSync(pidFile, { force: true });
  const gone = !processInfo(pid).alive;
  return gone ? { stopped: true, pid } : { stopped: false, pid, reason: `pid ${pid} survived SIGKILL` };
}
