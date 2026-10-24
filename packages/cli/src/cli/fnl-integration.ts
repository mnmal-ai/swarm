/**
 * swarm run's side of fnl (https://github.com/mnmal-ai/fnl): checking the
 * project's `fnl` block at startup and finding an fnl that supports what the
 * worker hook needs before any session uses it. The hook itself lives in
 * @mnmal-ai/swarm-worker-backends (fnl-hook.ts).
 *
 * The hook calls `fnl rewrite --deny RULE… --wrap PATTERN… -- CMD` and
 * `fnl rewrite --check-invokes-fnl -- CMD`, so an fnl whose help doesn't list
 * both flags is too old: the integration stays off, with one warning, and
 * commands run as the model wrote them.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { FnlBackendConfig, FnlConfig, ProjectConfig } from "@mnmal-ai/swarm-types";

const FNL_KEYS = ["enabled", "bin", "wrap"];
const REQUIRED_FLAGS = ["--deny", "--check-invokes-fnl"];

/** Problems with a project's `fnl` block, one message each; empty when valid. */
export function validateFnlConfig(fnl: unknown): string[] {
  if (fnl === undefined) return [];
  if (fnl === null || typeof fnl !== "object" || Array.isArray(fnl)) {
    return [`fnl must be an object like { "enabled": true, "wrap": ["make build"] } (got ${JSON.stringify(fnl)})`];
  }
  const f = fnl as Record<string, unknown>;
  const errors: string[] = [];
  if (f.enabled !== undefined && typeof f.enabled !== "boolean") {
    errors.push(`fnl.enabled must be true or false (got ${JSON.stringify(f.enabled)})`);
  }
  if (f.bin !== undefined && (typeof f.bin !== "string" || f.bin.trim() === "")) {
    errors.push(`fnl.bin must be the path to fnl (got ${JSON.stringify(f.bin)})`);
  }
  if (f.wrap !== undefined) {
    const ok = Array.isArray(f.wrap) && f.wrap.every((p) => typeof p === "string" && p.trim() !== "" && !/[\r\n]/.test(p));
    if (!ok) errors.push(`fnl.wrap must be a list of one-line command patterns, e.g. ["make build"] (got ${JSON.stringify(f.wrap)})`);
  }
  for (const key of Object.keys(f)) {
    if (!FNL_KEYS.includes(key)) errors.push(`fnl.${key} is not a setting (known: ${FNL_KEYS.join(", ")})`);
  }
  return errors;
}

/** Fail fast on a malformed `fnl` block, with every problem and the config file named. */
export function assertValidFnlConfig(projectConfig: ProjectConfig, configPath: string): void {
  const errors = validateFnlConfig(projectConfig.fnl);
  if (errors.length === 0) return;
  throw new Error(`Invalid fnl in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `name` on PATH, as an absolute path. */
function findOnPath(name: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = resolve(join(dir, name));
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** fnl's help text, or undefined when it can't be run. */
function fnlHelp(bin: string): string | undefined {
  try {
    return execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    return typeof out === "string" && out !== "" ? out : undefined;
  }
}

/** fnl's own version (`fnl --version`), or undefined when it doesn't say. */
function fnlVersion(bin: string): string | undefined {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    return /^v?\d+\.\d+/.test(out) ? out.replace(/^v/, "").split(/\s+/)[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fnl the worker hook should use, or a warning saying why the
 * integration is off. Nothing when the block is missing or not enabled.
 */
export function resolveFnl(
  config: FnlConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { fnl?: FnlBackendConfig; version?: string; warning?: string } {
  if (!config?.enabled) return {};
  const configured = config.bin?.trim();
  // A path (absolute, or relative to where swarm runs) is used as given; a
  // bare name is looked up on PATH like a shell would.
  const name = configured || "fnl";
  const bin = isAbsolute(name) || name.includes("/") ? resolve(name) : findOnPath(name, env.PATH);
  if (!bin || !isExecutableFile(bin)) {
    return {
      warning: `fnl is enabled in config.json but fnl isn't installed${configured ? ` at ${configured}` : " on PATH"}; commands run without it. Install: gh api repos/mnmal-ai/fnl/contents/install.sh -H "Accept: application/vnd.github.raw" | bash`,
    };
  }
  const help = fnlHelp(bin) ?? "";
  const missing = REQUIRED_FLAGS.filter((flag) => !help.includes(flag));
  if (missing.length > 0) {
    return {
      warning: `fnl at ${bin} is too old for swarm (its rewrite command lacks ${missing.join(" and ")}); commands run without it. Update with: fnl upgrade`,
    };
  }
  // An fnl that explains each decision (`rewrite --json`) lets sessions count
  // how many build commands it digested; an older one still works, uncounted.
  const json = help.includes("--json");
  const version = fnlVersion(bin);
  return {
    fnl: { bin, wrap: [...(config.wrap ?? [])], json },
    ...(version ? { version } : {}),
    ...(json
      ? {}
      : { warning: `fnl${version ? ` ${version}` : ""} at ${bin} can't explain its decisions (rewrite --json), so build-command coverage isn't counted. Update with: fnl upgrade` }),
  };
}
