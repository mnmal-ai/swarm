/**
 * Login expiry — a cross-cutting concern like the rate limit: worker-backends
 * throws it, core and oversight let it through untouched, and `swarm run`
 * stops the whole run on it. Lives in @mnmal-ai/swarm-types so none of them
 * depends on another.
 */

/** What swarm tells the operator when the agent runtime's login has expired. */
export const LOGIN_EXPIRED_MESSAGE = "Claude login expired: run `claude` and `/login`, then re-run to resume";

/** Whose login an expiry belongs to. */
export type AgentRuntime = "claude" | "codex";

/** What swarm tells the operator when a Codex session's login is missing or expired. */
export const CODEX_LOGIN_EXPIRED_MESSAGE = "Codex login expired or missing: run `codex login`, then re-run to resume";

/** The operator message for a runtime's expired login; Claude's unless told otherwise. */
export function loginExpiredMessage(runtime: AgentRuntime = "claude"): string {
  return runtime === "codex" ? CODEX_LOGIN_EXPIRED_MESSAGE : LOGIN_EXPIRED_MESSAGE;
}

/**
 * Error thrown when an agent session fails because its login is no longer
 * valid. Every later session would fail the same way, so this is a stop for
 * the whole run, never a task failure: it is not retried, and swarm never
 * falls back to another backend or an API key because of it.
 */
export class LoginExpiredError extends Error {
  /** The runtime's own error text, secrets redacted. */
  readonly detail: string;
  /** Whose login it is: "claude" unless a codex session threw it. */
  readonly runtime: AgentRuntime;

  constructor(detail: string, runtime: AgentRuntime = "claude") {
    super(`${loginExpiredMessage(runtime)} (${detail})`);
    this.name = "LoginExpiredError";
    this.detail = detail;
    this.runtime = runtime;
  }
}

/**
 * The ways an agent runtime says its login is gone: an OAuth session that
 * expired or could not be refreshed, an HTTP 401, "please run /login", a
 * rejected key. Matched against an error's text only, never against a
 * session's output, where a worker may well be writing about 401s.
 */
const LOGIN_FAILURE_PATTERNS: readonly RegExp[] = [
  /failed to authenticate/i,
  /\boauth\b[^\n]{0,40}\b(expired|revoked|could not be refreshed)/i,
  /\b(session|token|login|credentials?)\b[^\n]{0,20}\b(has |have )?expired\b/i,
  /\bplease run \/login\b/i,
  /\brun \/login\b/i,
  /\bnot logged in\b/i,
  /\binvalid api key\b/i,
  /\bauthentication_error\b/,
  /\bapi error:?\s*401\b/i,
  /\bstatus(?: code)?:?\s*401\b/i,
  /\b401\b[^\n]{0,20}\b(unauthori[sz]ed|authentication)/i,
];

/** Whether an error's text says the agent runtime's login is no longer valid. */
export function isLoginFailure(text: string): boolean {
  return LOGIN_FAILURE_PATTERNS.some((p) => p.test(text));
}

/**
 * Whether `err` is a login expiry: a {@link LoginExpiredError} (matched by
 * name too, since a bundled binary can hold two copies of this module), or
 * any error whose message reads as one.
 */
export function isLoginExpired(err: unknown): boolean {
  if (err instanceof LoginExpiredError) return true;
  if (err instanceof Error) return err.name === "LoginExpiredError" || isLoginFailure(err.message);
  return typeof err === "string" && isLoginFailure(err);
}
