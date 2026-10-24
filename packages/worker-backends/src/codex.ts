/**
 * The codex worker backend: one `codex exec --json` process per session,
 * for any role. Codex runs with the operator's own install and sign-in;
 * swarm keeps the operator's setup out with flags (codex-args.ts), enforces
 * the role's deny list and applies fnl through `swarm codex-hook`
 * (codex-hook.ts), and refuses to start a session whose hook fails its
 * self-test (codex-selftest.ts), since Codex runs a command whose hook
 * crashed. Events become swarm's progress, tokens and files in
 * codex-events.ts.
 */

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { BackendConfig, FnlCoverage, IWorkerBackend, ModelReport, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";
import { LoginExpiredError, RateLimitError, defaultWorkerGhConfigDir, gitIdentityEnvVars, withoutGitHubAccess } from "@mnmal-ai/swarm-types";
import { DEFAULT_WORKER_TOOLS } from "./claude-code.js";
import { buildCodexArgs, discoverSkillFiles, gitWritableDirs, skillRoots, tomlString } from "./codex-args.js";
import { CodexEventCollector } from "./codex-events.js";
import { guardGitConfig } from "./codex-git-guard.js";
import { redactSecrets } from "./codex-redact.js";
import { DECISIONS_FILE, HOOK_FAILURE_DENY, codexHookArgs, readDecisions, type CodexHookPolicy } from "./codex-hook.js";
import { selfTestCodexHook } from "./codex-selftest.js";
import { unenforceableRules } from "./deny-matcher.js";
import { FNL_INSTRUCTION, FnlCoverageCounter } from "./fnl-hook.js";

/** The environment variables a codex session gets from swarm's: claude-code's list without
 *  the API keys (one could switch Codex from the operator's sign-in to metered API
 *  billing), plus CODEX_HOME. */
const ALLOWED_ENV_VARS = new Set(["PATH", "HOME", "USER", "LANG", "SHELL", "TERM", "NODE_ENV", "CODEX_HOME"]);
const MAX_STDERR_BYTES = 8192;
const KILL_GRACE_MS = 5000;
/** How long after Codex exits its output may keep draining before the session ends anyway. */
const EXIT_DRAIN_MS = 2000;
const MCP_NAME = /^[A-Za-z0-9_-]+$/;
/** How long to wait on a usage limit that does not say when it resets. */
const DEFAULT_LIMIT_WAIT_MS = 30 * 60_000;

/**
 * Where codex sessions keep their decision logs: under the operator's home,
 * which a session's sandbox can read but not write, so an agent cannot forge
 * its own log. SWARM_CODEX_SESSIONS_DIR moves it (tests).
 */
function sessionsRoot(): string {
  return process.env.SWARM_CODEX_SESSIONS_DIR || join(homedir(), ".swarm", "codex-sessions");
}

function newSessionDir(): string {
  const root = sessionsRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, "s-"));
}

const SAFE_WORD = /^[A-Za-z0-9_/.,:=@%+-]+$/;
const shellQuote = (s: string) => (SAFE_WORD.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The two hook commands for a session. PreToolUse ends in `|| printf <deny>`:
 * if swarm itself fails to answer (a crash, a bad install, a kill), the
 * shell still answers deny, since Codex would otherwise allow the call.
 */
export function codexHookCommands(base: string, policy: CodexHookPolicy, logDir: string): { sessionStart: string; preToolUse: string } {
  const args = (event: "PreToolUse" | "SessionStart") => codexHookArgs(event, policy, logDir).map(shellQuote).join(" ");
  return {
    sessionStart: `${base} ${args("SessionStart")}`,
    preToolUse: `${base} ${args("PreToolUse")} || printf '%s' '${HOOK_FAILURE_DENY}'`,
  };
}
/** Process groups of live codex sessions, stopped if swarm itself exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const group of liveGroups) killGroup(group, "SIGKILL");
    });
    // Codex runs in its own process group, so a signal to swarm does not reach
    // it. Stop the sessions, then let the signal do what it would have done.
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        for (const group of liveGroups) killGroup(group, "SIGKILL");
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    }
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

const LOGIN_FAILURE: readonly RegExp[] = [
  /\b401\b[^\n]{0,20}unauthori[sz]ed/i,
  /missing bearer or basic authentication/i,
  /\bnot (?:logged|signed) in\b/i,
  /\bplease (?:run )?`?codex login`?/i,
  /\b(?:token|session|login|credentials?)\b[^\n]{0,20}\bexpired\b/i,
  /\brefresh[_ ]token\b[^\n]{0,40}\b(?:expired|invalid|revoked)\b/i,
];

/** Whether Codex's error text says its sign-in is missing or no longer valid. */
export function isCodexLoginFailure(text: string): boolean {
  return LOGIN_FAILURE.some((p) => p.test(text));
}

/**
 * A usage-limit error, or null when the text is not one. When it says when to
 * try again, swarm waits that long; when it does not, swarm waits
 * DEFAULT_LIMIT_WAIT_MS rather than failing every task that follows.
 */
export function parseCodexUsageLimit(text: string, now: Date = new Date()): RateLimitError | null {
  if (!/\b(?:usage|rate) limit\b|\btoo many requests\b/i.test(text)) return null;
  const m = /try again in\s+(\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (m) {
    const unit = m[2].toLowerCase();
    const waitMs = Number(m[1]) * (unit === "hour" ? 3_600_000 : unit === "minute" ? 60_000 : 1000);
    if (waitMs > 0 && waitMs <= 24 * 3_600_000) {
      return new RateLimitError(`Codex usage limit hit. Resets in ${m[1]} ${unit}(s).`, new Date(now.getTime() + waitMs), waitMs);
    }
  }
  return new RateLimitError(
    `Codex usage limit hit, with no reset time swarm could read. Waiting ${DEFAULT_LIMIT_WAIT_MS / 60_000} minutes.`,
    new Date(now.getTime() + DEFAULT_LIMIT_WAIT_MS),
    DEFAULT_LIMIT_WAIT_MS,
  );
}


export class CodexBackend implements IWorkerBackend {
  readonly type = "codex" as const;
  readonly supportsDirectExecution = true;
  readonly model: string | undefined;
  private readonly config: BackendConfig;
  private readonly tools: string[];
  private readonly timeoutMs: number;
  private resolvedPath: string | null | undefined;

  constructor(config: BackendConfig) {
    this.config = config;
    this.model = config.model;
    this.tools = [...(config.tools ?? DEFAULT_WORKER_TOOLS)];
    this.timeoutMs = config.timeout === 0 ? 0 : (config.timeout ?? 600) * 1000;
    for (const name of Object.keys(config.mcpServers ?? {})) {
      if (!MCP_NAME.test(name)) throw new Error(`Rejected mcpServers key with invalid characters (must match [a-zA-Z0-9_-]): "${name}"`);
    }
  }

  private codexPath(): string | null {
    if (this.resolvedPath !== undefined) return this.resolvedPath;
    if (this.config.binaryPath) {
      try {
        accessSync(this.config.binaryPath, constants.X_OK);
        this.resolvedPath = this.config.binaryPath;
      } catch {
        this.resolvedPath = null;
      }
      return this.resolvedPath;
    }
    try {
      this.resolvedPath = execFileSync("which", ["codex"], { encoding: "utf-8", stdio: "pipe" }).trim() || null;
    } catch {
      this.resolvedPath = null;
    }
    return this.resolvedPath;
  }

  async isAvailable(): Promise<boolean> {
    return this.codexPath() !== null;
  }

  /** What this role's hook enforces. */
  policy(): CodexHookPolicy {
    const fnl = this.config.fnl;
    const mcpServers = Object.keys(this.config.mcpServers ?? {});
    return {
      version: 1,
      deniedTools: [...(this.config.permissions?.deniedTools ?? [])],
      canRunCommands: this.tools.includes("Bash"),
      canEdit: this.tools.includes("Edit") || this.tools.includes("Write"),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(fnl && this.tools.includes("Bash") ? { fnl: { bin: fnl.bin, wrap: [...fnl.wrap], ...(fnl.json ? { json: true } : {}) } } : {}),
    };
  }

  /** The session's environment: claude-code's allowlist without API keys, the git identity, no GitHub. */
  sessionEnv(): NodeJS.ProcessEnv {
    let env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (ALLOWED_ENV_VARS.has(key) && value !== undefined) env[key] = value;
    }
    Object.assign(env, gitIdentityEnvVars(this.config.gitIdentity));
    env = withoutGitHubAccess(env, this.config.ghConfigDir ?? defaultWorkerGhConfigDir());
    // git inside the session cannot authenticate to a remote: no stored
    // credential helper, no SSH, no prompt. Pushing is swarm's job, and this
    // holds even when a disguised command gets past the deny list. (Set as
    // `git -c` parameters, since Codex keeps variables named *KEY* out of commands.)
    env.GIT_CONFIG_PARAMETERS = "'credential.helper=' 'core.sshCommand=false'";
    env.GIT_SSH_COMMAND = "false";
    env.GIT_TERMINAL_PROMPT = "0";
    return env;
  }

  /** The hook command, or an error when this role cannot run safely on codex. */
  private checkedHookCommand(): string {
    const base = this.config.codexHookCommand;
    if (!base) throw new Error("the codex backend has no hook command, so its deny list could not be enforced; swarm run sets one");
    const unenforceable = unenforceableRules(this.config.permissions?.deniedTools ?? []);
    if (unenforceable.length > 0) {
      throw new Error(`a codex session cannot enforce these deny rules: ${unenforceable.join(", ")}. Remove them or run this role on claude-code`);
    }
    return base;
  }

  /** Before a run takes work: Codex is installed, the deny list can be enforced, and the hook passes its self-test. */
  async preflight(cwd: string): Promise<void> {
    const base = this.checkedHookCommand();
    if (!this.codexPath()) throw new Error("codex is not installed (no `codex` on PATH)");
    const dir = newSessionDir();
    try {
      const policy = this.policy();
      const hooks = codexHookCommands(base, policy, dir);
      await selfTestCodexHook({ hookCommand: hooks.preToolUse, env: this.sessionEnv(), cwd, policy });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async execute(input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    const base = this.checkedHookCommand();
    const codex = this.codexPath();
    if (!codex) throw new Error("codex is not installed (no `codex` on PATH)");
    const cwd = input.workingDirectory || process.cwd();
    const started = Date.now();
    const sessionDir = newSessionDir();
    try {
      const policy = this.policy();
      const hooks = codexHookCommands(base, policy, sessionDir);
      const env = this.sessionEnv();
      await selfTestCodexHook({ hookCommand: hooks.preToolUse, env, cwd, policy });

      const onProgress = this.config.interactionHandler?.onProgress;
      if (input.documents && input.documents.documents.length > 0) {
        onProgress?.({
          type: "status_change",
          detail: "Document reads are not limited in codex sessions",
          timestamp: Date.now(),
          meta: { status: "doc-guard-off" },
        });
      }
      const lastMessageFile = join(sessionDir, "last-message.txt");
      // A session whose shell commands go through fnl is told to run build and
      // test commands in a form fnl digests, as claude-code sessions are.
      const context = policy.fnl ? [input.swarmContext, FNL_INSTRUCTION].filter((p) => p).join("\n\n") : input.swarmContext;
      const instructions = placeContext(context, input.task);
      const args = buildCodexArgs({
        cwd,
        gitDirs: gitWritableDirs(cwd),
        model: this.model,
        developerInstructions: instructions.developer,
        hookCommands: hooks,
        skillFiles: discoverSkillFiles(skillRoots(env, cwd)),
        mcpServers: this.config.mcpServers,
        lastMessageFile,
      });
      const collector = new CodexEventCollector(cwd, onProgress);
      const gitGuard = guardGitConfig(cwd);
      let run: RunResult;
      let tampered: string[] = [];
      try {
        run = await runCodex(codex, args, { cwd, env, stdin: instructions.stdin, timeoutMs: this.timeoutMs, onLine: (l) => collector.push(l) });
      } finally {
        collector.finish();
        tampered = gitGuard?.restore() ?? [];
      }
      if (tampered.length > 0) {
        throw new Error(
          `the codex session changed the repository's git hooks or config (${tampered.map((f) => f.split("/").slice(-2).join("/")).join(", ")}); swarm put them back and failed the session`,
        );
      }

      if (run.timedOut) throw new Error(`codex timed out after ${this.timeoutMs / 1000} seconds.`);
      const failure =
        collector.failure ?? (run.code !== 0 ? run.stderr.trim() || collector.lastError || `codex exited with ${run.code ?? run.signal}` : undefined);
      if (failure) {
        const redacted = redactSecrets(failure);
        // A login that is gone fails every later session too: a run-level stop.
        if (isCodexLoginFailure(redacted)) throw new LoginExpiredError(redacted.split("\n")[0].slice(0, 300), "codex");
        const limit = parseCodexUsageLimit(redacted);
        if (limit) throw limit;
        throw new Error(`codex exec failed: ${redacted.split("\n").slice(0, 5).join("\n  ")}`);
      }

      let output = "";
      try {
        output = readFileSync(lastMessageFile, "utf8").trim();
      } catch {
        // Codex wrote no last-message file; fall back to its last message.
      }
      output ||= collector.lastMessage.trim();
      if (!output) throw new Error("codex produced no output.");

      const log = readDecisions(join(sessionDir, DECISIONS_FILE));
      const sessionModel = log.find((e) => e.event === "SessionStart" && e.model)?.model;
      const servedBy = sessionModel ?? this.model ?? "codex";
      const tokens = collector.tokens;
      const modelReport: ModelReport = {
        requested: this.model,
        ...(sessionModel ? { sessionModel } : {}),
        responses: collector.responses > 0 ? { [servedBy]: collector.responses } : {},
        usage: { [servedBy]: { input: tokens.input, output: tokens.output } },
      };
      let fnlCoverage: FnlCoverage | undefined;
      if (policy.fnl?.json) {
        const counter = new FnlCoverageCounter();
        for (const e of log) if (e.fnl) counter.add(e.fnl);
        fnlCoverage = counter.snapshot();
      }
      return {
        output,
        latencyMs: Date.now() - started,
        tokensUsed: tokens,
        filesChanged: collector.filesChanged,
        exitCode: run.code ?? 1,
        backendUsed: "codex",
        modelReport,
        ...(fnlCoverage ? { fnlCoverage } : {}),
      };
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
}

/** The largest swarm context passed as a setting, measured as escaped for it. Linux caps one argument at 128 KiB. */
const MAX_INSTRUCTIONS_ARG = 64 * 1024;

/**
 * Where swarm's context goes: in Codex's developer instructions, the nearest
 * match to Claude Code's appended system prompt, unless it is too large for
 * one command-line argument; then it leads the task on stdin.
 */
export function placeContext(context: string, task: string): { developer: string; stdin: string } {
  // Measured after TOML escaping: newlines, quotes and control characters grow it.
  if (Buffer.byteLength(tomlString(context), "utf8") <= MAX_INSTRUCTIONS_ARG) return { developer: context, stdin: task };
  return {
    developer: "Swarm's context for this task comes first in the task message, before the task itself. Follow it as you would these instructions.",
    stdin: `<swarm-context>\n${context}\n</swarm-context>\n\n${task}`,
  };
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
}

/** Run Codex in its own process group, so a timeout stops its children too. */
function runCodex(
  bin: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; onLine: (line: string) => void },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const pid = child.pid;
    if (pid !== undefined) trackGroup(pid);
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const timer =
      o.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (pid !== undefined) killGroup(pid, "SIGTERM");
            killTimer = setTimeout(() => {
              if (pid !== undefined) killGroup(pid, "SIGKILL");
            }, KILL_GRACE_MS);
          }, o.timeoutMs)
        : undefined;
    const finish = () => {
      if (settled || exit === null) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      if (pid !== undefined) {
        killGroup(pid, "SIGKILL");
        liveGroups.delete(pid);
      }
      resolve({ code: exit.code, signal: exit.signal, stderr: stderr.slice(0, MAX_STDERR_BYTES), timedOut });
    };
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += String(d);
      if (process.env.SWARM_DEBUG) process.stderr.write(`[codex:stderr] ${d}`);
    });
    createInterface({ input: child.stdout }).on("line", o.onLine);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (pid !== undefined) liveGroups.delete(pid);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // A grandchild holding stdout open must not keep the session alive.
      drainTimer = setTimeout(finish, EXIT_DRAIN_MS);
    });
    child.on("close", () => finish());
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin);
  });
}
