/**
 * swarm uninstall — Remove swarm from the current project or globally.
 *
 * Modes:
 *   swarm uninstall          Remove .swarm/ and generated skill files from cwd
 *   swarm uninstall --global Stop the sidecars and remove the installed swarm binary
 *   swarm uninstall --all    Both: project cleanup then global removal
 *
 * Reads .swarm/.swarm-meta.json (written by swarm init) to discover
 * skill files created outside .swarm/. Falls back to checking known
 * paths if the manifest is missing.
 */

import { basename, dirname, resolve, join } from "node:path";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  lstatSync,
  rmSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

// ESM-only packages loaded dynamically
let p: typeof import("@clack/prompts");
let pc: typeof import("picocolors");

// Known skill file paths that swarm init may create
const KNOWN_SKILL_PATHS = [
  ".claude/commands/prepare-for-swarm.md",
  ".cursor/rules/prepare-for-swarm.mdc",
  ".github/copilot-instructions.md",
  "SWARM-PROMPT.md",
];

import type { SwarmMeta } from "./swarm-meta.js";
export type { SwarmMeta } from "./swarm-meta.js";

function countFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
  } catch {
    // Ignore permission errors
  }
  return count;
}

/**
 * Strip swarm-managed content from copilot-instructions.md
 * instead of deleting the whole file (other tools may use it).
 */
/**
 * Check if a relative path is safe to delete (stays within cwd, no traversal).
 */
export function isSafeRelativePath(relPath: string, cwd: string): boolean {
  const absPath = resolve(cwd, relPath);
  return absPath.startsWith(cwd + "/");
}

export function stripCopilotSwarmSection(filePath: string): boolean {
  const content = readFileSync(filePath, "utf-8");
  const beginMarker = "<!-- swarm:begin";
  const endMarker = "<!-- swarm:end -->";
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);

  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return false;

  const before = content.slice(0, beginIdx).trimEnd();
  const after = content.slice(endIdx + endMarker.length).trimStart();
  const cleaned = [before, after].filter(Boolean).join("\n\n") + "\n";

  if (cleaned.trim() === "") {
    // File is now empty — remove it
    rmSync(filePath);
  } else {
    writeFileSync(filePath, cleaned);
  }
  return true;
}

export async function runUninstall(flags: Record<string, string>): Promise<void> {
  p = await import("@clack/prompts");
  pc = (await import("picocolors")).default;

  const globalOnly = flags["global"] === "true";
  const all = flags["all"] === "true";
  const skipConfirm = flags["yes"] === "true";

  // --global: just remove the npm package
  if (globalOnly) {
    await uninstallGlobal(skipConfirm);
    return;
  }

  // Default or --all: project-level uninstall
  await uninstallProject(skipConfirm);

  if (all) {
    console.log("");
    await uninstallGlobal(skipConfirm);
  }
}

async function uninstallProject(skipConfirm: boolean): Promise<void> {
  const cwd = process.cwd();
  const swarmDir = resolve(cwd, ".swarm");

  if (!existsSync(swarmDir)) {
    p.log.error("No .swarm/ directory found in the current directory.");
    p.log.info(`Run ${pc.cyan("swarm init")} to create one.`);
    process.exit(1);
  }

  // Detect symlink
  const isSymlink = lstatSync(swarmDir).isSymbolicLink();

  // Read manifest for skill files
  let meta: SwarmMeta = {};
  const metaPath = join(swarmDir, ".swarm-meta.json");
  if (!isSymlink && existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    } catch {
      // Ignore parse errors — fall back to discovery
    }
  }

  // Discover skill files to remove
  const skillFiles: string[] = [];
  const sourceList = meta.skill_files?.length ? meta.skill_files : KNOWN_SKILL_PATHS;

  for (const relPath of sourceList) {
    if (!isSafeRelativePath(relPath, cwd)) {
      continue;
    }
    const absPath = resolve(cwd, relPath);
    if (existsSync(absPath)) {
      skillFiles.push(relPath);
    }
  }

  // Build removal summary
  p.intro(pc.red("swarm uninstall"));

  const removals: string[] = [];

  if (isSymlink) {
    removals.push(`${pc.cyan(".swarm/")}  ${pc.dim("(symlink — target will NOT be deleted)")}`);
  } else {
    const fileCount = countFiles(swarmDir);
    removals.push(`${pc.cyan(".swarm/")}  ${pc.dim(`(${fileCount} files)`)}`);
  }

  for (const f of skillFiles) {
    if (f === ".github/copilot-instructions.md") {
      removals.push(`${pc.cyan(f)}  ${pc.dim("(swarm section only)")}`);
    } else {
      removals.push(`${pc.cyan(f)}`);
    }
  }

  console.log("");
  console.log("  This will remove:");
  for (const r of removals) {
    console.log(`    ${r}`);
  }
  console.log("");

  // Confirm
  if (!skipConfirm) {
    const confirmed = await p.confirm({
      message: "Proceed?",
      initialValue: false,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.outro("Cancelled.");
      process.exit(0);
    }
  }

  // Remove skill files
  for (const relPath of skillFiles) {
    const absPath = resolve(cwd, relPath);
    try {
      if (relPath === ".github/copilot-instructions.md") {
        if (stripCopilotSwarmSection(absPath)) {
          p.log.success(`Stripped swarm section from ${pc.cyan(relPath)}`);
        } else {
          p.log.warn(`No swarm markers found in ${pc.cyan(relPath)} — skipped`);
        }
        continue;
      }
      rmSync(absPath);
      p.log.success(`Removed ${pc.cyan(relPath)}`);
    } catch (err) {
      p.log.warn(`Could not remove ${relPath}: ${(err as Error).message}`);
    }
  }

  // Remove .swarm/
  try {
    if (isSymlink) {
      unlinkSync(swarmDir);
      p.log.success(`Removed symlink ${pc.cyan(".swarm/")}`);
    } else {
      rmSync(swarmDir, { recursive: true, force: true });
      p.log.success(`Removed ${pc.cyan(".swarm/")}`);
    }
  } catch (err) {
    p.log.error(`Could not remove .swarm/: ${(err as Error).message}`);
    process.exit(1);
  }

  p.outro(pc.green("Swarm removed from this project."));
}

/**
 * What `swarm uninstall --global` does besides removing the binary, and what
 * it leaves: every Substrate sidecar swarm started is stopped first (nothing
 * could stop them once the CLI is gone), and the runtime, stack directories
 * and Postgres compose files stay, with the data in their Docker volumes.
 */
export function globalUninstallNotes(home: string = homedir()): { before: string[]; after: string[] } {
  const substrate = join(home, ".swarm", "substrate");
  return {
    before: [`Stop every Substrate sidecar swarm started (stack directories in ${join(substrate, "stacks")})`],
    after: [
      `Left in place: ${substrate} (the Substrate runtime and stack directories) and ${join(home, ".swarm", "infrastructure")}`,
      "(the Postgres compose files; the data stays in their Docker volumes). Remove them by hand if you no longer need them.",
    ],
  };
}

/**
 * The directories scripts/install.sh installs the binary into, and so the only
 * ones `swarm uninstall --global` deletes from: its default /usr/local/bin,
 * the documented `--install-dir ~/.local/bin`, and $SWARM_INSTALL_DIR.
 */
export function installDirs(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = ["/usr/local/bin", join(home, ".local", "bin")];
  const custom = env.SWARM_INSTALL_DIR?.trim();
  if (custom) dirs.push(resolve(custom));
  return dirs;
}

/** The `swarm` the shell would run, or null. */
function swarmOnPath(): string | null {
  try {
    const found = execFileSync("sh", ["-c", "command -v swarm"], { encoding: "utf-8", stdio: "pipe" }).trim();
    return found === "" ? null : found;
  } catch {
    return null;
  }
}

export interface BinaryLookup {
  execPath?: string;
  /** process.argv[1]: `/$bunfs/...` (or empty) inside the compiled binary. */
  entry?: string;
  isBun?: boolean;
  onPath?: () => string | null;
}

/**
 * The swarm binary `uninstall --global` removes: this process's own executable
 * when it is the compiled binary the installer placed, otherwise (node or tsx
 * running the sources) the `swarm` on PATH. Null when there is none.
 */
export function installedBinary(lookup: BinaryLookup = {}): string | null {
  const execPath = lookup.execPath ?? process.execPath;
  const entry = lookup.entry ?? process.argv[1] ?? "";
  const isBun = lookup.isBun ?? !!process.versions.bun;
  if (isBun && (entry === "" || entry.startsWith("/$bunfs/"))) return execPath;
  return (lookup.onPath ?? swarmOnPath)();
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Why `path` must not be deleted, or null when it may: it must be named
 * `swarm` and sit directly in one of `dirs` (compared after resolving
 * symlinked directories). Nothing else is ever removed.
 */
export function refuseRemoval(path: string, dirs: readonly string[]): string | null {
  if (basename(path) !== "swarm") return `${path} is not a swarm binary; refusing to delete it.`;
  const where = realDir(dirname(path));
  if (dirs.some((d) => realDir(d) === where)) return null;
  return (
    `${path} is outside the directories the installer uses (${dirs.join(", ")}); refusing to delete it. ` +
    `Remove it by hand if it is yours: rm ${path}`
  );
}

/**
 * Delete the binary, through sudo (which may prompt) when the directory is not
 * writable. Returns the path removed; throws when it could not be.
 */
export function removeInstalledBinary(path: string): string {
  try {
    unlinkSync(path);
    return path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
  }
  execFileSync("sudo", ["rm", "-f", path], { stdio: "inherit" });
  if (existsSync(path)) throw new Error(`sudo rm -f ${path} left the file in place`);
  return path;
}

async function uninstallGlobal(skipConfirm: boolean): Promise<void> {
  p.intro(pc.red("swarm uninstall --global"));
  const notes = globalUninstallNotes();

  const binary = installedBinary();
  if (binary === null) {
    p.log.warn("No installed swarm binary found (this is not the compiled binary, and no swarm is on PATH); nothing to remove.");
    p.outro("Nothing to do.");
    return;
  }
  const refusal = refuseRemoval(binary, installDirs());
  if (refusal !== null) {
    p.log.error(refusal);
    process.exit(1);
  }

  console.log("");
  console.log("  This will:");
  for (const line of notes.before) console.log(`    ${line}`);
  console.log(`    remove ${pc.cyan(binary)}`);
  console.log("");

  if (!skipConfirm) {
    const confirmed = await p.confirm({
      message: "Remove swarm CLI globally?",
      initialValue: false,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.outro("Cancelled.");
      process.exit(0);
    }
  }

  const { stopAllStacks } = await import("../substrate/ready.js");
  const stopped = (await stopAllStacks({ log: (line) => p.log.info(line) })).filter((r) => r.stopped).length;
  if (stopped > 0) p.log.success(`Stopped ${stopped} Substrate sidecar${stopped === 1 ? "" : "s"}.`);

  try {
    p.log.success(`Removed ${removeInstalledBinary(binary)}`);
  } catch (err) {
    p.log.error(`Could not remove ${binary}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const still = swarmOnPath();
  if (still !== null && still !== binary) {
    p.log.warn(`Another swarm is still on PATH: ${still} (installed some other way; remove it by hand).`);
  }

  for (const line of notes.after) console.log(pc.dim(`  ${line}`));
  p.outro(pc.green("Done."));
}
