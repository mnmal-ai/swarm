/**
 * The Substrate runtime: a directory under ~/.swarm/substrate/runtime holding
 * one `node_modules` with `@mnmal-ai/substrate` (the server), `@mnmal-ai/cortext`
 * (the context store) and the swarm plugin (from the tarball the CLI carries),
 * installed with the npm that ships with the Node the sidecars run on.
 *
 * The sidecar is a Node process even when swarm itself runs under Bun, so
 * {@link resolveNode} finds a Node of at least {@link NODE_VERSION_FLOOR}
 * (`SWARM_NODE`, else `node` on PATH) and never falls back to Bun.
 *
 * An install is marked done by `.installed-<hash>`, where the hash covers the
 * Substrate and cortext versions, the plugin's version and the tarball's bytes
 * (sha256). The
 * marker is written only after npm succeeds, so an interrupted or failed
 * install is never taken for a ready one: the next call starts again from a
 * clean directory.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** The `@mnmal-ai/substrate` version the runtime installs. Bump here, and only here. */
export const SUBSTRATE_VERSION = "1.0.0-alpha.7";
/** The `@mnmal-ai/cortext` version the runtime installs. */
export const CORTEXT_VERSION = "1.0.0-alpha.7";
/** The oldest Node the Substrate sidecar runs on. */
export const NODE_VERSION_FLOOR = "26.2.0";
/** The swarm plugin's package name, as the runtime and stack package.json files list it. */
export const PLUGIN_PACKAGE_NAME = "@mnmal-ai/swarm-substrate-plugin";

const NPM_REGISTRY = "https://registry.npmjs.org/";
/** An install that has not finished in ten minutes is treated as failed. */
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const NODE_FIX = "install Node 26.2 or newer, e.g. with mise or your package manager";

/** ~/.swarm/substrate (resolved per call, so a HOME change applies). */
export function substrateHome(): string {
  return join(homedir(), ".swarm", "substrate");
}

/** ~/.swarm/substrate/runtime */
export function defaultRuntimeDir(): string {
  return join(substrateHome(), "runtime");
}

/** Where `node_modules/@mnmal-ai/substrate/dist/substrate.js` lives in a runtime directory. */
export function substrateBinFor(runtimeDir: string): string {
  return join(runtimeDir, "node_modules", "@mnmal-ai", "substrate", "dist", "substrate.js");
}

// --- Node ---

export interface ResolvedNode {
  /** Absolute path to the node binary. */
  path: string;
  /** Its version without the `v` (e.g. `26.10.0`). */
  version: string;
}

/** No usable Node: none found, `SWARM_NODE` unusable, or older than {@link NODE_VERSION_FLOOR}. */
export class NodeVersionError extends Error {
  override readonly name = "NodeVersionError";
  readonly floor = NODE_VERSION_FLOOR;
  constructor(
    message: string,
    /** The version found, or null when no Node could be run. */
    readonly found: string | null,
    /** The binary checked, or null when none was found. */
    readonly nodePath: string | null,
  ) {
    super(message);
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

interface RunError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

/** `execFile` as a promise of `{ stdout, stderr }`; a failure carries both. */
function run(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const err = error as RunError;
        err.stdout = String(stdout ?? "");
        err.stderr = String(stderr ?? "");
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** An executable file named `name` in a PATH directory, or null. */
function findOnPath(name: string, pathVar = process.env.PATH ?? ""): string | null {
  for (const dir of pathVar.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
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

function parseVersion(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(version: [number, number, number], floor: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}

/**
 * The Node the sidecars run on: `SWARM_NODE` (an absolute path to a node
 * binary) when set, else `node` on PATH. Throws {@link NodeVersionError} naming
 * the version found, the floor and the fix when there is none or it is older
 * than {@link NODE_VERSION_FLOOR}. Bun is never used, even when swarm runs
 * under it.
 */
export async function resolveNode(): Promise<ResolvedNode> {
  const fromEnv = process.env.SWARM_NODE?.trim();
  let nodePath: string;
  if (fromEnv) {
    if (!isAbsolute(fromEnv)) {
      throw new NodeVersionError(
        `SWARM_NODE must be an absolute path to a node binary (got ${JSON.stringify(fromEnv)}). Fix: point it at one, or unset it to use node on PATH.`,
        null,
        null,
      );
    }
    nodePath = fromEnv;
  } else {
    const found = findOnPath("node");
    if (found === null) {
      throw new NodeVersionError(
        `No Node found: SWARM_NODE is unset and there is no node on PATH. The Substrate sidecar needs Node ${NODE_VERSION_FLOOR} or newer. ` +
          `Fix: ${NODE_FIX}, or set SWARM_NODE to its absolute path.`,
        null,
        null,
      );
    }
    nodePath = found;
  }

  let output: string;
  try {
    output = (await run(nodePath, ["--version"], { timeout: 10_000 })).stdout;
  } catch (err) {
    throw new NodeVersionError(
      `Could not run ${nodePath}${fromEnv ? " (SWARM_NODE)" : ""}: ${err instanceof Error ? err.message : String(err)}. ` +
        `The Substrate sidecar needs Node ${NODE_VERSION_FLOOR} or newer. Fix: ${NODE_FIX}.`,
      null,
      nodePath,
    );
  }
  const parsed = parseVersion(output);
  const version = parsed === null ? output.trim() : parsed.join(".");
  const floor = parseVersion(NODE_VERSION_FLOOR) as [number, number, number];
  if (parsed === null || !atLeast(parsed, floor)) {
    throw new NodeVersionError(
      `Node ${version || "(unknown version)"} at ${nodePath} is too old for the Substrate sidecar, which needs Node ${NODE_VERSION_FLOOR} or newer. ` +
        `Fix: ${NODE_FIX}${fromEnv ? ", and point SWARM_NODE at it" : ""}.`,
      version || null,
      nodePath,
    );
  }
  return { path: nodePath, version };
}

/** The npm that ships with `nodePath` (`<dir>/npm`), else npm on PATH. */
export function npmFor(nodePath: string): string {
  const beside = join(dirname(nodePath), "npm");
  if (isExecutableFile(beside)) return beside;
  return findOnPath("npm") ?? "npm";
}

// --- Runtime install ---

export interface EnsureRuntimeOptions {
  /** Where the runtime lives; normally {@link defaultRuntimeDir}. */
  runtimeDir: string;
  /** Absolute path to the swarm plugin tarball the CLI carries. */
  pluginTarball: string;
  /** Normally {@link SUBSTRATE_VERSION}. */
  substrateVersion: string;
  /** Normally {@link CORTEXT_VERSION}. */
  cortextVersion: string;
  /** Suppress progress lines. */
  quiet: boolean;
  /** The node whose npm installs; resolved with {@link resolveNode} when omitted. */
  nodePath?: string;
  /**
   * Called before an install replaces an existing runtime (its `node_modules`
   * is about to be removed), so the caller can stop sidecars running from it.
   * Not called for a first install or when this install is already done.
   */
  beforeReinstall?: () => Promise<void> | void;
}

export interface RuntimeInfo {
  runtimeDir: string;
  /** `node_modules/@mnmal-ai/substrate/dist/substrate.js` in the runtime. */
  substrateBin: string;
  /** The `.installed-<hash>` file that marks this install done. */
  installedMarker: string;
}

/** npm failed (or left no server behind) in the runtime directory. */
export class RuntimeInstallError extends Error {
  override readonly name = "RuntimeInstallError";
  constructor(
    readonly runtimeDir: string,
    detail: string,
  ) {
    super(
      `Installing the Substrate runtime in ${runtimeDir} failed: ${detail}\n` +
        `Nothing was marked installed; the next start retries from a clean directory.`,
    );
  }
}

const MARKER_PREFIX = ".installed-";

function log(quiet: boolean, message: string): void {
  if (!quiet) console.log(message);
}

/** The plugin version inside the tarball (`package/package.json`). */
async function tarballVersion(tarball: string): Promise<string> {
  try {
    const { stdout } = await run("tar", ["-xOf", tarball, "package/package.json"], { timeout: 30_000 });
    const version = (JSON.parse(stdout) as { version?: unknown }).version;
    if (typeof version !== "string" || version === "") throw new Error("package/package.json has no version");
    return version;
  } catch (err) {
    throw new Error(
      `Could not read the swarm plugin version from ${tarball}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function installHash(parts: { substrateVersion: string; cortextVersion: string; pluginVersion: string; tarballSha256: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.substrateVersion, parts.cortextVersion, parts.pluginVersion, parts.tarballSha256]))
    .digest("hex")
    .slice(0, 16);
}

/** The installed runtime in `runtimeDir` (any completed install), or null. */
export function findInstalledRuntime(runtimeDir: string = defaultRuntimeDir()): RuntimeInfo | null {
  const substrateBin = substrateBinFor(runtimeDir);
  if (!existsSync(substrateBin)) return null;
  let entries: string[];
  try {
    entries = readdirSync(runtimeDir);
  } catch {
    return null;
  }
  const marker = entries.find((f) => f.startsWith(MARKER_PREFIX));
  return marker === undefined ? null : { runtimeDir, substrateBin, installedMarker: join(runtimeDir, marker) };
}

/**
 * The environment npm runs with: the caller's, minus every `npm_config_*`
 * (a pnpm parent sets them), with npmjs as the registry, an empty user and
 * global config (so no `~/.npmrc` or global npmrc scope rule, e.g. `@mnmal-ai`
 * → GitHub Packages, applies), and the resolved Node's directory first on PATH
 * so npm runs on that Node.
 */
function npmEnv(nodePath: string, userconfig: string, globalconfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_/i.test(key)) continue;
    env[key] = value;
  }
  env.npm_config_registry = NPM_REGISTRY;
  env.npm_config_userconfig = userconfig;
  // A second empty file: npm refuses to load one file as both user and global
  // config ("double-loading config").
  env.npm_config_globalconfig = globalconfig;
  env.PATH = [dirname(nodePath), process.env.PATH ?? ""].filter((p) => p !== "").join(delimiter);
  return env;
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Install the runtime into `opts.runtimeDir` unless this exact install (same
 * versions, same tarball bytes) is already marked done. Writes the runtime's
 * `package.json`, runs `npm install --no-audit --no-fund --loglevel=error`
 * there, and writes `.installed-<hash>` only on success. A failure throws
 * {@link RuntimeInstallError} naming the directory.
 */
export async function ensureRuntimeInstalled(opts: EnsureRuntimeOptions): Promise<RuntimeInfo> {
  const { runtimeDir, pluginTarball, substrateVersion, cortextVersion, quiet } = opts;
  if (!isAbsolute(pluginTarball)) {
    throw new Error(`The swarm Substrate plugin tarball must be an absolute path (got ${JSON.stringify(pluginTarball)})`);
  }
  if (!existsSync(pluginTarball)) {
    throw new Error(`The swarm Substrate plugin tarball is missing: ${pluginTarball}`);
  }
  const nodePath = opts.nodePath ?? (await resolveNode()).path;
  const tarballSha256 = createHash("sha256").update(readFileSync(pluginTarball)).digest("hex");
  const pluginVersion = await tarballVersion(pluginTarball);
  const hash = installHash({ substrateVersion, cortextVersion, pluginVersion, tarballSha256 });
  const substrateBin = substrateBinFor(runtimeDir);
  const installedMarker = join(runtimeDir, `${MARKER_PREFIX}${hash}`);
  const info: RuntimeInfo = { runtimeDir, substrateBin, installedMarker };
  if (existsSync(installedMarker) && existsSync(substrateBin)) return info;

  // Not this install: start from a clean directory. A stale lock would pin the
  // old tarball's integrity, and a half-written node_modules is not trusted.
  // Sidecars running from the old node_modules are stopped first.
  if (existsSync(join(runtimeDir, "node_modules")) && opts.beforeReinstall !== undefined) {
    await opts.beforeReinstall();
  }
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(runtimeDir)) {
    if (entry.startsWith(MARKER_PREFIX)) rmSync(join(runtimeDir, entry), { force: true });
  }
  for (const entry of [".npmrc", "package-lock.json", "node_modules"]) {
    rmSync(join(runtimeDir, entry), { recursive: true, force: true });
  }
  const manifest = {
    private: true,
    dependencies: {
      "@mnmal-ai/substrate": substrateVersion,
      "@mnmal-ai/cortext": cortextVersion,
      [PLUGIN_PACKAGE_NAME]: `file:${pluginTarball}`,
    },
  };
  writeFileSync(join(runtimeDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const npm = npmFor(nodePath);
  log(
    quiet,
    `[swarm] Installing the Substrate runtime in ${runtimeDir} (substrate ${substrateVersion}, cortext ${cortextVersion}, swarm plugin ${pluginVersion})...`,
  );
  const started = Date.now();
  const configDir = mkdtempSync(join(tmpdir(), "swarm-npm-"));
  const userconfig = join(configDir, "npmrc");
  const globalconfig = join(configDir, "global-npmrc");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  try {
    await run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: runtimeDir,
      env: npmEnv(nodePath, userconfig, globalconfig),
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });
  } catch (err) {
    const e = err as RunError;
    const output = tail(`${e.stderr ?? ""}\n${e.stdout ?? ""}`, 20);
    throw new RuntimeInstallError(
      runtimeDir,
      `${npm} install exited ${e.code ?? "with an error"}${output ? `:\n${output}` : ` (${e.message})`}`,
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  if (!existsSync(substrateBin)) {
    throw new RuntimeInstallError(runtimeDir, `npm finished but ${substrateBin} is missing`);
  }
  writeFileSync(
    installedMarker,
    `${JSON.stringify({ substrateVersion, cortextVersion, pluginVersion, tarballSha256, installedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  log(quiet, `[swarm] Substrate runtime installed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  return info;
}
