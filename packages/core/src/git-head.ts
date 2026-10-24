import { execFileSync } from "node:child_process";

/**
 * HEAD's commit sha in `cwd`, or "unknown" when it can't be read (not a git
 * repo, no commits, git missing). git's stderr is discarded so a caught
 * failure never prints "fatal: not a git repository" to the console.
 */
export function readGitHeadSha(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
