/**
 * A token count for people to read: 950, 12.3k, 1.14M. Up to two decimals
 * for millions, one for thousands, trailing zeros dropped. A missing,
 * non-finite or negative count shows as 0. Matches swarm's formatTokens.
 */
export function formatTokens(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1000) return String(Math.round(v));
  const trim = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  const k = v / 1000;
  if (k < 999.95) return `${trim(k.toFixed(1))}k`;
  return `${trim((v / 1_000_000).toFixed(2))}M`;
}
