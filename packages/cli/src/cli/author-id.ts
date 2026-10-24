import { execSync } from "node:child_process";

/**
 * Upper bound on the resolved author-id length, applied uniformly to every
 * source (env USER, git user.email). A crafted `.git/config` or USER env var
 * could otherwise inject an arbitrarily long / structured string into every
 * persisted telemetry row for the session. 256 is comfortably above any real
 * email or username while keeping the column bounded.
 */
const MAX_AUTHOR_ID_LEN = 256;

/**
 * Resolve the author identity for telemetry attribution, once per session.
 *
 * Precedence: `process.env.USER` (non-empty) > `git config user.email` >
 * the literal `'anonymous'`. The git read is best-effort — a non-zero exit,
 * empty config, or missing git binary all fall through to the next level.
 * Every resolved value is bounded at MAX_AUTHOR_ID_LEN characters.
 *
 * Privacy constraint: this function never logs the resolved value or any
 * intermediate. Enforcement of the taxonomy is deferred; the value is only
 * threaded into telemetry writes by callers, never emitted from here.
 */
export function resolveAuthorId(): string {
  const envUser = process.env.USER;
  if (envUser) {
    return envUser.slice(0, MAX_AUTHOR_ID_LEN);
  }

  try {
    const email = execSync("git config user.email").toString().trim();
    if (email.length > 0) {
      return email.slice(0, MAX_AUTHOR_ID_LEN);
    }
  } catch {
    // git absent or non-zero exit — fall through to the literal fallback.
  }

  return "anonymous";
}
