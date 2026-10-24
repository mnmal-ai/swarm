/**
 * GitHub access for swarm.
 *
 * Two rules live here:
 *
 * 1. Swarm's own GitHub operations (opening PRs, reading and writing issues,
 *    pushing to an HTTPS GitHub remote) run as ONE account the project names
 *    in `source_control.github_account`, not whichever account `gh` happens to
 *    have active. The token for it is held by a {@link GitHubCredential} and
 *    reaches exactly those calls, each through its own env. It is never put in
 *    `process.env`, and never serialized.
 *
 * 2. Workers (and reviewers and arbiters) get no GitHub access at all: their
 *    processes carry none of {@link GITHUB_TOKEN_ENV_VARS}, and GH_CONFIG_DIR
 *    points at an empty directory, so `gh` inside a worker has no login and
 *    cannot fall back to the machine's keyring login. This removes ambient
 *    access; it is not a sandbox. Denied-command lists remain a second layer.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

/** The repository a git remote URL names. */
export interface GitRemoteRef {
  /** Host as written in the URL: `github.com`, or an SSH alias from ~/.ssh/config. */
  host: string;
  owner: string;
  repo: string;
  /** True when git reaches the remote over https (credential helpers apply). */
  https: boolean;
}

/**
 * Read `owner/repo` from a git remote URL. Understands https and http URLs
 * (with or without userinfo), `ssh://` and `git://` URLs, and scp-style SSH
 * remotes including host aliases (`git@work-alias:owner/repo.git`). A trailing
 * `.git` or `/` is dropped. Returns null for local paths, `file://` URLs and
 * anything that does not name exactly `owner/repo`.
 */
export function parseGitRemote(url: string): GitRemoteRef | null {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  let https = false;

  const urlForm = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (urlForm) {
    const scheme = urlForm[1].toLowerCase();
    if (scheme === "file") return null;
    host = urlForm[2];
    path = urlForm[3];
    https = scheme === "https";
  } else {
    // scp-like: [user@]host:path — never a local path (those have no colon
    // before the first slash).
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(trimmed);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }

  const ownerRepo = /^\/?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(path);
  if (!ownerRepo) return null;
  return { host: host.toLowerCase(), owner: ownerRepo[1], repo: ownerRepo[2], https };
}

/** Whether git reaches this remote over https on github.com — the only case
 *  in which swarm hands git its account's credential. SSH remotes use SSH keys
 *  and are left alone. */
export function isHttpsGitHubRemote(url: string): boolean {
  const ref = parseGitRemote(url);
  return ref !== null && ref.https && ref.host === "github.com";
}

// ---------------------------------------------------------------------------
// The account swarm's own GitHub operations use
// ---------------------------------------------------------------------------

/** Every environment variable through which gh (and git's gh helper) picks up
 *  a GitHub token. Workers receive none of them. */
export const GITHUB_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/**
 * Per-command git config that makes `gh` answer git's credential requests:
 * the first entry clears any helper from the user's or system git config (an
 * osxkeychain or store helper could otherwise answer as another account), the
 * second installs gh's. With GH_TOKEN in that command's env, gh answers with
 * it. Goes before the git subcommand: `git <these> push …`.
 */
export const GH_GIT_CREDENTIAL_ARGS: readonly string[] = [
  "-c", "credential.helper=",
  "-c", "credential.helper=!gh auth git-credential",
];

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * The GitHub account swarm's own operations run as, and its token.
 *
 * The token lives in a private field: it is not enumerable, JSON.stringify
 * and util.inspect show only the login, and the only way to use it is
 * {@link env}, which builds the environment for ONE gh or git call. Never
 * assign that env to `process.env` — workers inherit process.env.
 */
export class GitHubCredential {
  readonly login: string;
  readonly #token: string;

  constructor(login: string, token: string) {
    this.login = login;
    this.#token = token;
  }

  /**
   * The environment for one gh or git call made as this account: a copy of
   * `base` (default: process.env) with GH_TOKEN set to this account's token
   * and every other GitHub token variable removed, so no ambient token can
   * win instead.
   */
  env(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const name of GITHUB_TOKEN_ENV_VARS) delete env[name];
    env.GH_TOKEN = this.#token;
    return env;
  }

  /** `text` with every occurrence of the token masked, for error messages
   *  built from a CLI's output. */
  redact(text: string): string {
    return this.#token ? text.split(this.#token).join("●●●●") : text;
  }

  toJSON(): { login: string } {
    return { login: this.login };
  }

  toString(): string {
    return `GitHubCredential(${this.login})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Workers get no GitHub access
// ---------------------------------------------------------------------------

/**
 * The environment for a worker's processes, from `env`: every GitHub token
 * variable removed and GH_CONFIG_DIR set to `ghConfigDir` — an empty
 * directory — so gh finds no login and never reads the machine's (whose
 * keyring entries it locates through the hosts file in its config dir).
 * Returns a copy; `env` is not changed.
 */
export function withoutGitHubAccess<T extends Record<string, string | undefined>>(env: T, ghConfigDir: string): T {
  const isolated: Record<string, string | undefined> = { ...env };
  for (const name of GITHUB_TOKEN_ENV_VARS) delete isolated[name];
  isolated.GH_CONFIG_DIR = ghConfigDir;
  return isolated as T;
}

/**
 * Create a new empty directory for workers' GH_CONFIG_DIR. It is removed when
 * this process exits. `swarm run` makes one per run and hands it to every
 * role's backend.
 */
export function createEmptyGhConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-worker-gh-"));
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover empty temp directory is harmless.
    }
  });
  return dir;
}

let sharedDefaultDir: string | undefined;

/**
 * The GH_CONFIG_DIR for a backend that was given none (the SDK used directly,
 * the benchmark runner): one empty directory per process, so a worker never
 * inherits the machine's gh login whoever constructed its backend.
 */
export function defaultWorkerGhConfigDir(): string {
  sharedDefaultDir ??= createEmptyGhConfigDir();
  return sharedDefaultDir;
}
