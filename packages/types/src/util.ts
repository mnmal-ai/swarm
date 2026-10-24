/**
 * Pure utility functions with zero dependencies.
 * Moved from swarm/src/utils/glob.ts.
 */

import type { TokenBreakdown } from "./config.js";

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

const REGEX_SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
function isRegexSpecial(ch: string): boolean {
  return REGEX_SPECIAL.has(ch);
}

/**
 * Minimal glob matcher supporting * (single segment) and ** (cross-segment).
 * Sufficient for file-path pattern matching in serialization constraints
 * and telemetry scrubbing.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  // Convert glob pattern to RegExp
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any characters including path separators
        regexStr += ".*";
        i += 2;
        // Skip optional trailing slash after **
        if (pattern[i] === "/") i++;
      } else {
        // * matches any characters except path separator
        regexStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (isRegexSpecial(ch)) {
      regexStr += "\\" + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`).test(filePath);
}

// ---------------------------------------------------------------------------
// Token breakdown
// ---------------------------------------------------------------------------

/**
 * Split a result's token usage into fresh input, cache reads, cache writes and
 * output. `tokensUsed.input` counts all input, cache included, so fresh input
 * is what is left once the cache reads and writes are taken out. A backend
 * that reports no split has all of its input counted as fresh.
 */
export function tokenBreakdown(tokensUsed: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}): TokenBreakdown {
  const cacheRead = tokensUsed.cacheRead ?? 0;
  const cacheWrite = tokensUsed.cacheWrite ?? 0;
  return {
    freshInput: Math.max(0, tokensUsed.input - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: tokensUsed.output,
  };
}

/** A breakdown with every part zero — the start of a running total. */
export function emptyTokenBreakdown(): TokenBreakdown {
  return { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Sum two breakdowns part by part, returning a new one. */
export function addTokenBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    freshInput: a.freshInput + b.freshInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** All tokens in a breakdown: input (cache included) plus output — the count
 *  the session token budget (`max_tokens_per_session`) is checked against. */
export function tokenBreakdownTotal(b: TokenBreakdown): number {
  return b.freshInput + b.cacheRead + b.cacheWrite + b.output;
}

// ---------------------------------------------------------------------------
// Git identity
// ---------------------------------------------------------------------------

/**
 * The environment that makes git author AND commit as `identity`: exactly
 * GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL,
 * which outrank every git config source. Empty when no identity is set.
 */
export function gitIdentityEnvVars(identity: { name: string; email: string } | undefined): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * A token count for people to read: 950, 12.3k, 1.14M. Up to two decimals
 * for millions, one for thousands, trailing zeros dropped. A missing,
 * non-finite or negative count shows as 0.
 */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1000) return String(Math.round(v));
  const trim = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  const k = v / 1000;
  if (k < 999.95) return `${trim(k.toFixed(1))}k`;
  return `${trim((v / 1_000_000).toFixed(2))}M`;
}
