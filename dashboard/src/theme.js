import { useEffect, useState } from "react";

/**
 * Axon design tokens, by name. The values live in src/axon/tokens.css (vendored),
 * loaded by src/axon.css (dark by default, light under
 * prefers-color-scheme: light). Components reference tokens only, never a
 * literal colour, shadow, duration or easing, so a theme switch or a token
 * change reaches every surface without a re-render.
 */
export const COLORS = {
  bg: "var(--bg)",
  surface: "var(--surface)",
  surfaceHover: "var(--surface-hover)",
  border: "var(--border)",
  borderLight: "var(--border-light)",
  text: "var(--text)",
  textMuted: "var(--text-muted)",
  textDim: "var(--text-dim)",
  accent: "var(--accent)",
  accentDim: "var(--accent-dim)",
  green: "var(--green)",
  greenDim: "var(--green-dim)",
  amber: "var(--amber)",
  amberDim: "var(--amber-dim)",
  red: "var(--red)",
  redDim: "var(--red-dim)",
  purple: "var(--purple)",
  purpleDim: "var(--purple-dim)",
  cyan: "var(--cyan)",
};

/** DM Sans for all text; DM Mono for every number, timestamp, identifier and token count. */
export const SANS = "var(--sans)";
export const MONO = "var(--mono)";

/** Neumorphic shadows: surfaces rise from the page material rather than sit on it. */
export const SHADOWS = {
  card: "var(--neu-shadow-card)",
  panel: "var(--neu-shadow-panel)",
  hover: "var(--neu-shadow-hover)",
  btn: "var(--neu-shadow-btn)",
  subtask: "var(--neu-shadow-subtask)",
};

export const MOTION = {
  fast: "var(--duration-fast)",
  slow: "var(--duration-slow)",
  standard: "var(--easing-standard)",
};

/**
 * Axon status semantics. Each colour carries one meaning and is never
 * decorative: cyan = active or pending, amber = in progress or usage
 * (tokens), green = success, magenta (--purple) = failure. Red is reserved
 * for destructive actions. Anything that is not a state is neutral.
 */
export const TONES = {
  active: { color: COLORS.cyan, dim: COLORS.accentDim },
  progress: { color: COLORS.amber, dim: COLORS.amberDim },
  success: { color: COLORS.green, dim: COLORS.greenDim },
  failure: { color: COLORS.purple, dim: COLORS.purpleDim },
  neutral: { color: COLORS.textMuted, dim: COLORS.border },
};

/** A task's status as an Axon tone. Blocked waits on something: amber, as the live dashboard shows it. */
export function taskTone(status) {
  switch (status) {
    case "pending":
      return TONES.active;
    case "in_progress":
    case "blocked":
      return TONES.progress;
    case "completed":
      return TONES.success;
    case "failed":
      return TONES.failure;
    default:
      return TONES.neutral;
  }
}

/** True while the viewer asks for reduced motion; charts use it to skip their JS animations. */
export function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return undefined;
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// Cards past this position rise with the last one, so a long list does not
// take seconds to finish cascading in.
const MAX_STAGGER_STEPS = 12;

/** Entry motion for the i-th card of a group: rises from the surface, staggered by --stagger-card. */
export function riseStyle(index = 0) {
  return { "--rise-index": Math.min(index, MAX_STAGGER_STEPS) };
}
