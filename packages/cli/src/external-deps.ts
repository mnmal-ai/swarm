/**
 * External dependencies: tools swarm runs but does not ship.
 *
 * Each entry names the tool, how to ask its version, the major version swarm
 * is tested with, and the behaviours swarm relies on — so when the installed
 * major differs, the startup warning can say what might no longer hold. The
 * manifest is data: adding a tool (git, docker, Claude Code…) is one more
 * object in {@link EXTERNAL_DEPENDENCIES}, checked by the same
 * {@link checkDependencyVersion}.
 *
 * TODO(dependency reporting): reporting the installed versions back to a
 * server, so breakage from a new release is seen across installs, needs its
 * own design (what is sent, consent, where it goes). Not implemented here.
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Running a command
// ---------------------------------------------------------------------------

/**
 * Runs a command with no shell and resolves with its stdout. Rejects when it
 * cannot start (error `code` "ENOENT" when it is not installed) or exits
 * non-zero (error `stderr` holds what it printed). Injected so tests never
 * run the real tool.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

/** How long one startup check command may run. */
const COMMAND_TIMEOUT_MS = 15_000;

/** The real {@link CommandRunner}: execFile, no shell, stdin closed. */
export const defaultCommandRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** One tool swarm runs but does not ship. */
export interface ExternalDependency {
  /** The name swarm reports it by. */
  name: string;
  /** The executable swarm runs. */
  command: string;
  /** Argv that prints the version. */
  versionArgs: readonly string[];
  /** Matches the version output; capture group 1 is the version (`2.63.0`). */
  versionPattern: RegExp;
  /** The major version swarm is tested with. */
  testedMajor: number;
  /** The behaviours swarm relies on — what to check when the major differs. */
  reliesOn: readonly string[];
}

export const EXTERNAL_DEPENDENCIES = {
  gh: {
    name: "gh",
    command: "gh",
    versionArgs: ["--version"],
    versionPattern: /gh version (\d+\.\d+(?:\.\d+)?)/,
    testedMajor: 2,
    reliesOn: [
      "gh auth token --user <login> prints that account's token",
      "GH_TOKEN in the environment is honoured as the token",
      "GH_CONFIG_DIR in the environment is honoured as the config directory",
      "gh api <path> calls the REST API as the authenticated account",
      "gh pr create --title --body --base --head prints the new PR's URL",
      "gh pr view <url|branch> --json url,state,mergeCommit prints that JSON (merge_prs)",
      "gh pr merge <url> --merge merges with a merge commit (merge_prs)",
      "gh pr comment <url> --body adds a comment (merge_prs)",
      "gh auth git-credential answers git's credential requests",
    ],
  },
  fnl: {
    name: "fnl",
    command: "fnl",
    versionArgs: ["--version"],
    versionPattern: /^v?(\d+\.\d+(?:\.\d+)?)/m,
    testedMajor: 0,
    reliesOn: [
      "fnl rewrite [--deny RULE]… [--wrap PATTERN]… -- <command> prints the command to run instead and exits 0, or prints nothing and exits 1",
      "fnl rewrite --deny takes Claude Code Bash rules and never rewrites a command they match",
      "fnl rewrite --check-invokes-fnl -- <command> exits 0 when the command itself calls fnl, 1 when it doesn't",
      "fnl --help lists the rewrite flags (--deny, --check-invokes-fnl)",
      "fnl run -- '<command>' runs the command, keeps its exit code, and prints a digest of its output",
    ],
  },
} as const satisfies Record<string, ExternalDependency>;

// ---------------------------------------------------------------------------
// The version check
// ---------------------------------------------------------------------------

/** What {@link checkDependencyVersion} found. */
export interface DependencyVersionCheck {
  name: string;
  /** The installed version, or null when missing or unreadable. */
  installed: string | null;
  testedMajor: number;
  /** Set when swarm should warn: a different major, missing, or unreadable. */
  warning?: string;
}

/**
 * Run the tool's version command and compare its major with the tested one.
 * Never throws: every outcome is a result, with a warning when the operator
 * should know.
 */
export async function checkDependencyVersion(
  dep: ExternalDependency,
  run: CommandRunner = defaultCommandRunner,
): Promise<DependencyVersionCheck> {
  const base = { name: dep.name, testedMajor: dep.testedMajor };
  const tested = `${dep.name} ${dep.testedMajor}.x`;

  let output: string;
  try {
    output = await run(dep.command, dep.versionArgs);
  } catch (err) {
    const missing = (err as { code?: unknown }).code === "ENOENT";
    return {
      ...base,
      installed: null,
      warning: missing
        ? `${dep.name} is not installed; swarm is tested with ${tested}.`
        : `could not run \`${[dep.command, ...dep.versionArgs].join(" ")}\`; swarm is tested with ${tested}.`,
    };
  }

  const version = dep.versionPattern.exec(output)?.[1];
  if (!version) {
    return {
      ...base,
      installed: null,
      warning: `could not read ${dep.name}'s version from \`${[dep.command, ...dep.versionArgs].join(" ")}\`; swarm is tested with ${tested}.`,
    };
  }

  const major = Number.parseInt(version.split(".")[0], 10);
  if (major === dep.testedMajor) return { ...base, installed: version };
  return {
    ...base,
    installed: version,
    warning:
      `${dep.name} ${version} is installed, but swarm is tested with ${tested}. ` +
      `Behaviour may be unpredictable. Swarm relies on: ${dep.reliesOn.join("; ")}.`,
  };
}
