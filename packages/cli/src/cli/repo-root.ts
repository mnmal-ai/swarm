import { execFileSync } from "node:child_process";

/**
 * Resolve the work repo swarm operates on, decoupled from process.cwd().
 *
 * Precedence: `--repo-path` flag > config `repo_root` > config `project_root` > cwd.
 * Defaulting to cwd preserves the original single-repo behavior (operate on the
 * directory you ran `swarm run` from). Setting any of the higher-precedence
 * sources lets a swarm config live in one repo and drive a different work repo.
 */
export function resolveRepoRoot(
  args: Record<string, string>,
  config: { repo_root?: string; project_root?: string },
  cwd: string = process.cwd(),
): string {
  return args["repo-path"] ?? config.repo_root ?? config.project_root ?? cwd;
}

/**
 * Throw with an actionable message if `path` is not inside a git work tree.
 * Guards against a mistyped `--repo-path` / `repo_root` surfacing as a cryptic
 * git failure deep into a run.
 */
export function assertGitRepo(path: string): void {
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--git-dir"], {
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `Work repo is not a git repository: ${path}. ` +
        `Pass --repo-path <path> or set repo_root in config.json to a valid git repo.`,
    );
  }
}
