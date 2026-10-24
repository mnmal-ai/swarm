import { describe, it, expect } from "vitest";
import { parseRateLimitError, RateLimitError } from "../src/claude-code.js";

describe("RateLimitError", () => {
  it("has correct properties", () => {
    const resetAt = new Date(Date.now() + 3600_000);
    const err = new RateLimitError("test message", resetAt);

    expect(err.name).toBe("RateLimitError");
    expect(err.message).toBe("test message");
    expect(err.resetAt).toBe(resetAt);
    expect(err.waitMs).toBeGreaterThan(0);
    expect(err.waitMs).toBeLessThanOrEqual(3600_000);
    expect(err).toBeInstanceOf(Error);
  });

  it("clamps waitMs to 0 when resetAt is in the past", () => {
    const resetAt = new Date(Date.now() - 60_000);
    const err = new RateLimitError("past reset", resetAt);

    expect(err.waitMs).toBe(0);
  });

  it("uses provided waitMs when given", () => {
    const resetAt = new Date(Date.now() + 3600_000);
    const err = new RateLimitError("test", resetAt, 1234);

    expect(err.waitMs).toBe(1234);
  });
});

describe("parseRateLimitError", () => {
  // All tests use a fixed `now` so results are deterministic.

  it("returns null for non-rate-limit errors", () => {
    const now = new Date("2026-03-29T20:00:00Z");
    expect(parseRateLimitError("Connection refused", now)).toBeNull();
    expect(parseRateLimitError("Agent SDK query timed out after 600 seconds.", now)).toBeNull();
    expect(parseRateLimitError("", now)).toBeNull();
    expect(parseRateLimitError("Some other error message", now)).toBeNull();
  });

  it("parses standard rate limit message with pm time", () => {
    // 3pm CDT = 8pm UTC. Reset at 6pm CDT = 11pm UTC. Wait ~3h.
    const now = new Date("2026-03-29T20:00:00Z");
    const result = parseRateLimitError(
      "Error: Claude Code returned an error result: You've hit your limit · resets 6pm (America/Chicago)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result!.message).toContain("rate limit");
    expect(result!.resetAt).toBeInstanceOf(Date);
    expect(result!.waitMs).toBeGreaterThan(2 * 60 * 60 * 1000);
    expect(result!.waitMs).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
  });

  it("parses 12am (midnight) reset time", () => {
    // 10pm CDT = 3am UTC next day. Reset at 12am CDT = 5am UTC. Wait ~2h.
    const now = new Date("2026-03-30T03:00:00Z");
    const result = parseRateLimitError(
      "You've hit your limit · resets 12am (America/Chicago)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result!.waitMs).toBeGreaterThan(1 * 60 * 60 * 1000);
    expect(result!.waitMs).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
  });

  it("parses time with minutes (6:30pm)", () => {
    // 3pm CDT = 8pm UTC. Reset at 6:30pm CDT = 11:30pm UTC.
    const now = new Date("2026-03-29T20:00:00Z");
    const result = parseRateLimitError(
      "You've hit your limit · resets 6:30pm (America/Chicago)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result!.waitMs).toBeGreaterThan(3 * 60 * 60 * 1000);
  });

  it("parses different timezone (America/New_York)", () => {
    // 4pm EDT = 8pm UTC. Reset at 5pm EDT = 9pm UTC. Wait ~1h.
    const now = new Date("2026-03-29T20:00:00Z");
    const result = parseRateLimitError(
      "You've hit your limit · resets 5pm (America/New_York)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result!.waitMs).toBeGreaterThan(0);
    expect(result!.waitMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it("matches case-insensitively", () => {
    const now = new Date("2026-03-29T20:00:00Z");
    const result = parseRateLimitError(
      "YOU'VE HIT YOUR LIMIT · resets 6PM (America/Chicago)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
  });

  it("returns null for unparseable timezone", () => {
    const now = new Date("2026-03-29T20:00:00Z");
    const result = parseRateLimitError(
      "You've hit your limit · resets 6pm (Invalid/Timezone)",
      now,
    );
    expect(result).toBeNull();
  });

  it("handles non-aligned minutes correctly", () => {
    // now is 5:47pm CDT. Reset at 6pm CDT. Should still find it.
    const now = new Date("2026-03-29T22:47:00Z");
    const result = parseRateLimitError(
      "You've hit your limit · resets 6pm (America/Chicago)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result!.waitMs).toBeGreaterThan(10 * 60 * 1000); // > 10 min
    expect(result!.waitMs).toBeLessThanOrEqual(15 * 60 * 1000); // <= 15 min
  });

  it("wraps to next day when reset time has passed today", () => {
    // 7pm CDT = midnight UTC. Reset at 6pm CDT — already past today.
    // Should return 6pm CDT tomorrow (23 hours away).
    const now = new Date("2026-03-30T00:00:00Z");
    const result = parseRateLimitError(
      "You've hit your limit · resets 6pm (America/Chicago)",
      now,
    );

    expect(result).toBeInstanceOf(RateLimitError);
    // ~23 hours
    expect(result!.waitMs).toBeGreaterThan(22 * 60 * 60 * 1000);
    expect(result!.waitMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
