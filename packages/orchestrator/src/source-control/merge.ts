/**
 * Merge-as-you-go helpers for `source_control.merge_prs`: which goals may be
 * merged, and the merge gate command. The git and gh steps live on
 * SourceControlManager.mergeGoal.
 */

import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { MergePrsGateConfig } from "@mnmal-ai/swarm-types";
import { defaultWorkerGhConfigDir } from "@mnmal-ai/swarm-types";
import { MERGE_PRS_DEFAULT_GATE_TIMEOUT_MS } from "./commit-policy.js";

/** Task verdicts that leave a goal eligible to merge. "skipped" (a task that
 *  was never reviewed) is not one of them. */
export const MERGE_ELIGIBLE_VERDICTS: ReadonlySet<string> = new Set([
  "approved",
  "completed_with_notes",
  "completed_with_deferrals",
]);

/** A label normalized for comparison: lower case, single spaces, no space
 *  around a colon. `swarm_merge:false` and `Swarm_Merge : false` match. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s*:\s*/g, ":").replace(/\s+/g, " ");
}

export type MergeEligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * Pure: whether a done goal may be merged. Every task must have ended with an
 * eligible verdict (none failed, rejected or skipped), and the source item
 * must carry none of the skip labels. The reason is swarm's own text, safe to
 * post on the PR and the source item.
 */
export function mergeEligibility(input: {
  verdicts: readonly string[];
  labels: readonly string[];
  skipLabels: readonly string[];
}): MergeEligibility {
  // The reason names the configured label, never the item's own label text,
  // so nothing from the item reaches the comment swarm posts.
  const hit = input.skipLabels.find((skip) => input.labels.some((l) => normalizeLabel(l) === normalizeLabel(skip)));
  if (hit !== undefined) return { eligible: false, reason: `the card is labelled "${hit}", so a person merges it` };
  if (input.verdicts.length === 0) return { eligible: false, reason: "no task of this goal has a review verdict" };
  const bad = input.verdicts.filter((v) => !MERGE_ELIGIBLE_VERDICTS.has(v));
  if (bad.length > 0) {
    const kinds = [...new Set(bad)].join(", ");
    return { eligible: false, reason: `${bad.length} of ${input.verdicts.length} task(s) did not pass review (${kinds})` };
  }
  return { eligible: true };
}

/**
 * The variables the merge gate inherits from swarm's environment. The gate
 * runs the goal branch's own code (its Makefile, its tests), which agents
 * wrote, so it gets what a build needs and no provider API key or GitHub
 * token (and `gh` gets an empty config). It is not a sandbox: it keeps HOME
 * and DOCKER_HOST, which builds need for caches and containers, so it can
 * read what the user's home directory holds, as the workers that wrote the
 * code could. `gate.env` adds anything else.
 */
export const GATE_INHERITED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "CI",
  "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR",
  "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR",
  "NVM_DIR", "PNPM_HOME", "BUN_INSTALL", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT",
  "DOCKER_HOST", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
] as const;

/** Pure: the merge gate's environment. The inherited allowlist from `base`,
 *  then `gate.env`, then GH_CONFIG_DIR pointed at an empty directory so `gh`
 *  inside the gate has no login. */
export function gateEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> | undefined, ghConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of GATE_INHERITED_ENV) if (base[name] !== undefined) env[name] = base[name];
  Object.assign(env, extra ?? {});
  env.GH_CONFIG_DIR = ghConfigDir;
  return env;
}

/** Mask common secret shapes in text swarm logs or emits: Anthropic, OpenAI
 *  and AWS keys, GitHub tokens, bearer tokens and `key=` values. */
export function redactGateOutput(text: string): string {
  return text
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "sk-ant-***")
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA***")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "ghX_***")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]{20,}/gi, "$1***")
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi, "$1***");
}

/** The outcome of one run of the merge gate. */
export interface GateResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The last lines of the command's output (stdout then stderr), for the run log. */
  tail: string;
}

const TAIL_LINES = 40;

/** The last `n` non-empty lines of `text`. */
export function tailLines(text: string, n = TAIL_LINES): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-n).join("\n");
}

/** The gate's working directory: `cwd` resolved inside `repoRoot`. Throws when
 *  it would leave the repo (validation refuses that at startup too). */
export function gateCwd(repoRoot: string, cwd: string | undefined): string {
  const root = resolve(repoRoot);
  const dir = resolve(root, cwd ?? ".");
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error(`merge gate cwd "${cwd}" is outside the work repo`);
  return dir;
}

/** How long a gate's process group gets between SIGTERM and SIGKILL. */
const GATE_KILL_GRACE_MS = 5_000;
/** Output kept from a gate run, at most, for its tail. */
const GATE_OUTPUT_CAP = 1024 * 1024;

/**
 * Run the merge gate with `sh -c` in the work repo, with {@link gateEnv}'s
 * environment. Never throws: a command that cannot start, fails or times out
 * is a failed gate. The output's tail is redacted before it leaves here.
 *
 * The gate runs in its own process group. On timeout the whole group gets
 * SIGTERM, then SIGKILL after a grace period, so children a test runner
 * started cannot outlive the gate, and the result comes from swarm's own
 * deadline rather than from the output pipes closing.
 */
export function runMergeGate(repoRoot: string, gate: MergePrsGateConfig): Promise<GateResult> {
  const started = Date.now();
  const timeout = gate.timeout_ms ?? MERGE_PRS_DEFAULT_GATE_TIMEOUT_MS;
  let cwd: string;
  try {
    cwd = gateCwd(repoRoot, gate.cwd);
  } catch (err) {
    return Promise.resolve({ passed: false, exitCode: null, timedOut: false, durationMs: 0, tail: (err as Error).message });
  }
  return new Promise((resolveP) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > GATE_OUTPUT_CAP) output = output.slice(-GATE_OUTPUT_CAP);
    };
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolveP({
        passed: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        tail: redactGateOutput(tailLines(`${output}${extra ? `\n${extra}` : ""}`)),
      });
    };

    const child = spawn("sh", ["-c", gate.command], {
      cwd,
      env: gateEnv(process.env, gate.env, defaultWorkerGhConfigDir()),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => finish(null, `the gate could not start: ${err.message}`));
    // Report on "close" (all output read), but never wait on it for long: a
    // child that kept the pipes open must not hold the result, so after
    // "exit" the group is reaped and the result is reported within a second.
    let exitCode: number | null = null;
    child.on("close", () => finish(exitCode));
    child.on("exit", (code) => {
      exitCode = code;
      killGroup("SIGKILL");
      setTimeout(() => finish(exitCode), 1_000).unref();
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        // If even SIGKILL left no exit event, report the timeout anyway.
        setTimeout(() => finish(null), 1_000).unref();
      }, GATE_KILL_GRACE_MS);
      killTimer.unref();
    }, timeout);
  });
}
