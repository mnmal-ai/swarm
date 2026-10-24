/**
 * Rate limit error — a cross-cutting concern used by both worker-backends
 * (which throws it) and core (which catches and handles it).
 * Lives in @mnmal-ai/swarm-types to avoid a downward dependency from core → worker-backends.
 */

/**
 * Error thrown when a worker backend detects a rate limit.
 * Contains the parsed reset time so callers can sleep and retry.
 */
export class RateLimitError extends Error {
  /** Milliseconds until the rate limit resets. */
  readonly waitMs: number;
  /** Absolute time when the rate limit resets. */
  readonly resetAt: Date;

  constructor(message: string, resetAt: Date, waitMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
    this.waitMs = waitMs ?? Math.max(0, resetAt.getTime() - Date.now());
  }
}
