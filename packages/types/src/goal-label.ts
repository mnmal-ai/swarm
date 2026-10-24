/**
 * A goal's label: the short name its badges show on the live dashboard.
 *
 * By default it is the ticket's id as it appears in the ticket's URL (see
 * labelFromUrl); a goal without a recognisable URL keeps showing its goal id.
 * A project that names a model (`labels.model` on its task source) gets a
 * short label the model picks from each ticket's title instead, with the URL
 * id as the fallback; see sanitizeModelLabel and the CLI's goal-labels.
 */

/** Longest label a goals.json entry may set. */
export const GOAL_LABEL_MAX = 32;
/** Longest label a model may pick. */
export const MODEL_LABEL_MAX = 16;

/** A task source's `labels` block in config.json. */
export interface LabelsConfig {
  /** A model to pick each goal's label from its title, e.g. "claude-haiku-4-5-20251001". Absent: the ticket's URL id. */
  model?: string;
}

/**
 * The ticket's id as its URL shows it: a Trello card's short link
 * (`trello.com/c/<shortLink>/…`), `#<number>` for a GitHub issue or pull
 * request (`/<owner>/<repo>/issues/<number>`), or a Jira key
 * (`/browse/<KEY-123>`). Undefined for anything else.
 */
export function labelFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const parts = parsed.pathname.split("/").filter((p) => p !== "");
  const host = parsed.hostname.toLowerCase();
  if (host === "trello.com" || host.endsWith(".trello.com")) {
    return parts[0] === "c" && /^[A-Za-z0-9]{1,24}$/.test(parts[1] ?? "") ? parts[1] : undefined;
  }
  if (parts.length >= 4 && (parts[2] === "issues" || parts[2] === "pull") && /^\d{1,9}$/.test(parts[3]!)) {
    return `#${parts[3]}`;
  }
  const browse = parts.indexOf("browse");
  const key = browse >= 0 ? parts[browse + 1] : undefined;
  if (key && /^[A-Za-z][A-Za-z0-9_]{0,19}-\d{1,9}$/.test(key)) return key.toUpperCase();
  return undefined;
}

/** A label someone wrote (goals.json), trimmed; undefined unless it is one short line. */
export function normalizeGoalLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  // eslint-disable-next-line no-control-regex
  if (label === "" || label.length > GOAL_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) return undefined;
  return label;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;

/** Problems with a task source's `labels` block, one message each; empty when valid or absent. */
export function validateLabelsConfig(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`labels must be an object like { "model": "claude-haiku-4-5-20251001" } (got ${JSON.stringify(value)})`];
  }
  const labels = value as Record<string, unknown>;
  const problems = Object.keys(labels)
    .filter((key) => key !== "model")
    .map((key) => `labels.${key} is not a setting (the one setting is labels.model)`);
  if (labels.model !== undefined && (typeof labels.model !== "string" || !MODEL_ID.test(labels.model))) {
    problems.push(`labels.model must be a model id such as "claude-haiku-4-5-20251001" (got ${JSON.stringify(labels.model)})`);
  }
  return problems;
}

/**
 * A model's reply cut down to a label: its first non-empty line, without
 * quotes, markdown, a "Label:" prefix or a closing full stop, at most
 * MODEL_LABEL_MAX characters. Undefined when nothing usable is left.
 */
export function sanitizeModelLabel(raw: string): string | undefined {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^```\w*$/, "").trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
  const label = line
    .replace(/^(?:label|name)\s*:\s*/i, "")
    .replace(/^[\s"'`“”‘’*_>#-]+|[\s"'`“”‘’*_.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // eslint-disable-next-line no-control-regex
  if (label === "" || label.length > MODEL_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) return undefined;
  return label;
}
