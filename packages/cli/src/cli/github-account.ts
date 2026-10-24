/**
 * The GitHub account `swarm run` acts as.
 *
 * With `source_control.github_account` set, the run starts by resolving that
 * account's token from gh (`gh auth token --user <login>`, once), checking the
 * token really belongs to the account (`gh api user`) and that the account can
 * see the repository the work repo's remote names (`gh api repos/<owner>/<repo>`),
 * and warning when the commit identity's GitHub noreply address is another
 * account's. Any failed check stops the run before work starts, with a message
 * that never contains the token. The token is returned in a GitHubCredential
 * and passed only to swarm's own gh and git calls.
 *
 * Without the setting nothing is resolved — gh's active account is used as
 * before — and the preflight banner names that account so it is never a
 * surprise.
 *
 * Every command goes through an injected CommandRunner (tests never run gh).
 */

import { GitHubCredential, parseGitRemote, type ProjectConfig } from "@mnmal-ai/swarm-types";
import {
  EXTERNAL_DEPENDENCIES,
  checkDependencyVersion,
  defaultCommandRunner,
  type CommandRunner,
} from "../external-deps.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A remote URL with any userinfo (`user:token@`) removed, safe to print. */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

function isNotInstalled(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

/** The first line of what a failed command printed, token masked. */
function failureDetail(err: unknown, credential?: GitHubCredential): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() !== ""
    ? stderr
    : err instanceof Error ? err.message : String(err);
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("Command failed")) ?? "no output";
  return credential ? credential.redact(line) : line;
}

/** `{ login, id }` from `gh api user` output, or null. */
function parseUser(stdout: string): { login: string; id?: number } | null {
  try {
    const user = JSON.parse(stdout) as { login?: unknown; id?: unknown };
    if (typeof user.login !== "string" || user.login === "") return null;
    return { login: user.login, id: typeof user.id === "number" ? user.id : undefined };
  } catch {
    return null;
  }
}

const NOREPLY = /^(?:(\d+)\+)?([^@+\s]+)@users\.noreply\.github\.com$/i;

// ---------------------------------------------------------------------------
// The startup check
// ---------------------------------------------------------------------------

export interface GitHubAccountCheckInput {
  /** source_control.github_account */
  login: string;
  /** The work repo. */
  repoRoot: string;
  /** The remote swarm pushes to (source_control.remote, default origin). */
  remote: string;
  /** source_control.git_identity.email, when set. */
  gitIdentityEmail?: string;
}

export type GitHubAccountCheck =
  | { ok: true; credential: GitHubCredential; repo: string; warnings: string[] }
  | { ok: false; error: string };

/**
 * Resolve the account's token and check it can do swarm's GitHub work.
 * Fails with a message naming what is wrong and how to fix it; warns (does
 * not fail) when the commit identity's noreply address is not the account's.
 */
export async function checkGitHubAccount(
  input: GitHubAccountCheckInput,
  run: CommandRunner = defaultCommandRunner,
): Promise<GitHubAccountCheck> {
  const { login, repoRoot, remote } = input;
  const setting = `source_control.github_account is "${login}"`;

  // 1. The account is logged in to gh: take its token (once, into memory).
  let token: string;
  try {
    token = (await run("gh", ["auth", "token", "--user", login])).trim();
  } catch (err) {
    if (isNotInstalled(err)) {
      return { ok: false, error: `${setting}, but gh is not installed. Install gh (https://cli.github.com) and log the account in with \`gh auth login\`.` };
    }
    token = "";
  }
  if (!token) {
    return { ok: false, error: `${setting}, but gh has no login for it. Log it in with \`gh auth login\` (\`gh auth status\` lists the accounts gh has).` };
  }
  const credential = new GitHubCredential(login, token);

  // 2. The token really belongs to the account.
  let user: { login: string; id?: number } | null;
  try {
    user = parseUser(await run("gh", ["api", "user"], { env: credential.env() }));
  } catch (err) {
    return {
      ok: false,
      error: `GitHub did not accept the token gh holds for "${login}": ${failureDetail(err, credential)}. Log the account in again with \`gh auth login\`.`,
    };
  }
  if (!user) {
    return { ok: false, error: `could not read which account the token gh holds for "${login}" belongs to (\`gh api user\` printed no login).` };
  }
  if (user.login.toLowerCase() !== login.toLowerCase()) {
    return { ok: false, error: `the token gh holds for "${login}" belongs to "${user.login}". Log ${login} in again with \`gh auth login\`.` };
  }

  // 3. The account can see the repo the work repo's remote names.
  let remoteUrl: string;
  try {
    remoteUrl = (await run("git", ["remote", "get-url", remote], { cwd: repoRoot })).trim();
  } catch {
    return {
      ok: false,
      error: `source_control.github_account is set, but the work repo (${repoRoot}) has no "${remote}" remote, so swarm cannot check that "${login}" can see it. Add the remote, or name another with source_control.remote.`,
    };
  }
  const ref = parseGitRemote(remoteUrl);
  if (!ref) {
    return {
      ok: false,
      error: `the "${remote}" remote (${redactRemoteUrl(remoteUrl)}) does not name a GitHub repository (owner/repo), so swarm cannot check that "${login}" can see it.`,
    };
  }
  const repo = `${ref.owner}/${ref.repo}`;
  try {
    await run("gh", ["api", `repos/${repo}`], { env: credential.env() });
  } catch (err) {
    return {
      ok: false,
      error: `"${login}" cannot see ${repo} (the work repo's "${remote}" remote): ${failureDetail(err, credential)}. Give the account access to the repository, or set source_control.github_account to one that has it.`,
    };
  }

  // 4. A noreply commit email should be this account's (warning only).
  const warnings: string[] = [];
  const noreply = input.gitIdentityEmail ? NOREPLY.exec(input.gitIdentityEmail) : null;
  if (noreply) {
    const [, id, emailLogin] = noreply;
    const email = input.gitIdentityEmail;
    if (emailLogin.toLowerCase() !== login.toLowerCase()) {
      warnings.push(
        `source_control.git_identity.email (${email}) is the GitHub noreply address of "${emailLogin}", not of "${login}": GitHub will attribute swarm's commits to "${emailLogin}".`,
      );
    } else if (id !== undefined && user.id !== undefined && Number(id) !== user.id) {
      warnings.push(
        `source_control.git_identity.email (${email}) carries user id ${id}, but "${login}" is ${user.id}: GitHub will not attribute swarm's commits to it.`,
      );
    }
  }

  return { ok: true, credential, repo, warnings };
}

// ---------------------------------------------------------------------------
// Without the setting: who is gh's active account?
// ---------------------------------------------------------------------------

export type GitHubBannerStatus =
  | { kind: "configured"; login: string; repo: string }
  | { kind: "active"; login: string }
  | { kind: "not-logged-in" }
  | { kind: "not-installed" };

/** gh's active account (`gh api user` with the inherited environment). */
export async function describeActiveGitHubAccount(run: CommandRunner = defaultCommandRunner): Promise<GitHubBannerStatus> {
  try {
    const user = parseUser(await run("gh", ["api", "user"]));
    return user ? { kind: "active", login: user.login } : { kind: "not-logged-in" };
  } catch (err) {
    return isNotInstalled(err) ? { kind: "not-installed" } : { kind: "not-logged-in" };
  }
}

// ---------------------------------------------------------------------------
// The preflight banner line
// ---------------------------------------------------------------------------

export interface BannerPainter {
  ok(text: string): string;
  dim(text: string): string;
  warn(text: string): string;
}

const PLAIN: BannerPainter = { ok: (s) => s, dim: (s) => s, warn: (s) => s };

/** The banner's GitHub line, e.g. `GitHub      example-bot ✓ example-org/sample-app`. */
export function formatGitHubBannerLine(status: GitHubBannerStatus, paint: BannerPainter = PLAIN): string {
  const label = "GitHub      ";
  switch (status.kind) {
    case "configured":
      return `${label}${status.login} ${paint.ok("✓")} ${paint.dim(status.repo)}`;
    case "active":
      return `${label}${status.login} ${paint.dim("(gh's active account)")}`;
    case "not-logged-in":
      return `${label}${paint.warn("not logged in")}`;
    case "not-installed":
      return `${label}${paint.warn("gh not installed")}`;
  }
}

// ---------------------------------------------------------------------------
// Putting it together for `swarm run`
// ---------------------------------------------------------------------------

type GhConfig = Pick<ProjectConfig, "source_control" | "task_backend" | "taskBackendConfig">;

/** Whether this run will call gh: an account is named, goals come from GitHub
 *  Issues, or completed work is pushed and PR'd (remote_pr). */
export function swarmWillUseGh(config: GhConfig): boolean {
  const sc = config.source_control;
  if (sc?.github_account) return true;
  if ((config.taskBackendConfig?.type ?? config.task_backend) === "github") return true;
  return sc?.strategy === "remote_pr";
}

export type GitHubAccess =
  | { ok: true; credential?: GitHubCredential; banner: GitHubBannerStatus; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/**
 * Everything `swarm run` needs to know about GitHub before any work: the
 * gh version warning (when the run will use gh), then either the checked
 * account and its credential (setting present) or gh's active account for
 * the banner (setting absent).
 */
export async function prepareGitHubAccess(
  config: GhConfig,
  repoRoot: string,
  run: CommandRunner = defaultCommandRunner,
): Promise<GitHubAccess> {
  const warnings: string[] = [];
  if (swarmWillUseGh(config)) {
    const version = await checkDependencyVersion(EXTERNAL_DEPENDENCIES.gh, run);
    if (version.warning) warnings.push(version.warning);
  }

  const sc = config.source_control;
  if (sc?.github_account) {
    const check = await checkGitHubAccount(
      {
        login: sc.github_account,
        repoRoot,
        remote: sc.remote ?? "origin",
        gitIdentityEmail: sc.git_identity?.email,
      },
      run,
    );
    if (!check.ok) return { ok: false, error: check.error, warnings };
    return {
      ok: true,
      credential: check.credential,
      banner: { kind: "configured", login: check.credential.login, repo: check.repo },
      warnings: [...warnings, ...check.warnings],
    };
  }

  return { ok: true, banner: await describeActiveGitHubAccount(run), warnings };
}
