/**
 * A goal's label is the short name its badges show on the live dashboard: the
 * ticket's id as its URL shows it, unless the project names a model to pick
 * labels (sanitizeModelLabel cleans what the model says).
 */

import { describe, expect, it } from "vitest";
import {
  GOAL_LABEL_MAX,
  MODEL_LABEL_MAX,
  labelFromUrl,
  normalizeGoalLabel,
  sanitizeModelLabel,
  validateLabelsConfig,
} from "../src/goal-label.js";

describe("labelFromUrl", () => {
  it("takes a Trello card's short link", () => {
    expect(labelFromUrl("https://trello.com/c/aB3dE5fG/12-add-export")).toBe("aB3dE5fG");
    expect(labelFromUrl("https://trello.com/c/aB3dE5fG")).toBe("aB3dE5fG");
  });

  it("takes a GitHub issue or pull request number", () => {
    expect(labelFromUrl("https://github.com/acme/app/issues/42")).toBe("#42");
    expect(labelFromUrl("https://github.com/acme/app/pull/7")).toBe("#7");
    expect(labelFromUrl("https://git.example.com/acme/app/issues/42#issuecomment-1")).toBe("#42");
  });

  it("takes a Jira key", () => {
    expect(labelFromUrl("https://example.atlassian.net/browse/APP-123")).toBe("APP-123");
    expect(labelFromUrl("https://jira.example.com/jira/browse/app-9")).toBe("APP-9");
  });

  it("gives nothing for anything else", () => {
    for (const url of [
      undefined,
      "",
      "not a url",
      "https://trello.com/b/aB3dE5fG/board",
      "https://trello.com/c/",
      "https://github.com/acme/app",
      "https://github.com/acme/app/issues/new",
      "https://example.atlassian.net/browse/",
      "https://example.atlassian.net/browse/APP",
      "https://example.com/tickets/12",
      "javascript:alert(1)",
    ]) {
      expect(labelFromUrl(url), String(url)).toBeUndefined();
    }
  });
});

describe("validateLabelsConfig", () => {
  it("accepts nothing, an empty block or a model id", () => {
    expect(validateLabelsConfig(undefined)).toEqual([]);
    expect(validateLabelsConfig({})).toEqual([]);
    expect(validateLabelsConfig({ model: "claude-haiku-4-5-20251001" })).toEqual([]);
  });

  it("names every problem", () => {
    expect(validateLabelsConfig("claude-haiku-4-5-20251001")).toEqual([expect.stringMatching(/labels must be an object/)]);
    expect(validateLabelsConfig(null)).toEqual([expect.stringMatching(/labels must be an object/)]);
    expect(validateLabelsConfig([])).toEqual([expect.stringMatching(/labels must be an object/)]);
    expect(validateLabelsConfig({ model: "" })).toEqual([expect.stringMatching(/labels.model must be a model id/)]);
    expect(validateLabelsConfig({ model: "two words" })).toEqual([expect.stringMatching(/labels.model must be a model id/)]);
    expect(validateLabelsConfig({ model: 4 })).toEqual([expect.stringMatching(/labels.model must be a model id/)]);
    expect(validateLabelsConfig({ mode: "model", pattern: "x" })).toEqual([
      expect.stringMatching(/labels.mode is not a setting/),
      expect.stringMatching(/labels.pattern is not a setting/),
    ]);
  });
});

describe("normalizeGoalLabel", () => {
  it("keeps a short single-line label, trimmed", () => {
    expect(normalizeGoalLabel("  APP-12 ")).toBe("APP-12");
    expect(normalizeGoalLabel("Export")).toBe("Export");
  });

  it("refuses anything else", () => {
    for (const bad of [undefined, null, 12, "", "   ", "two\nlines", "tab\there", "x".repeat(GOAL_LABEL_MAX + 1), { label: "x" }]) {
      expect(normalizeGoalLabel(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(normalizeGoalLabel("x".repeat(GOAL_LABEL_MAX))).toBe("x".repeat(GOAL_LABEL_MAX));
  });
});

describe("sanitizeModelLabel", () => {
  it("keeps a short plain reply", () => {
    expect(sanitizeModelLabel("Export button")).toBe("Export button");
    expect(sanitizeModelLabel("  Saved searches \n")).toBe("Saved searches");
  });

  it("strips quotes, markdown, a label prefix and a closing full stop", () => {
    expect(sanitizeModelLabel('"Export button"')).toBe("Export button");
    expect(sanitizeModelLabel("“Export button”")).toBe("Export button");
    expect(sanitizeModelLabel("**Export button**")).toBe("Export button");
    expect(sanitizeModelLabel("`Export`")).toBe("Export");
    expect(sanitizeModelLabel("# Export button")).toBe("Export button");
    expect(sanitizeModelLabel("- Export button")).toBe("Export button");
    expect(sanitizeModelLabel("Label: Export button.")).toBe("Export button");
    expect(sanitizeModelLabel("```\nExport button\n```")).toBe("Export button");
  });

  it("takes the first line of a longer reply, with inner whitespace collapsed", () => {
    expect(sanitizeModelLabel("Export button\nThis names the ticket about exports.")).toBe("Export button");
    expect(sanitizeModelLabel("Export \t  button")).toBe("Export button");
  });

  it("refuses an empty or overlong reply", () => {
    expect(sanitizeModelLabel("")).toBeUndefined();
    expect(sanitizeModelLabel(" \n \n")).toBeUndefined();
    expect(sanitizeModelLabel('""')).toBeUndefined();
    expect(sanitizeModelLabel("x".repeat(MODEL_LABEL_MAX + 1))).toBeUndefined();
    expect(sanitizeModelLabel("x".repeat(MODEL_LABEL_MAX))).toBe("x".repeat(MODEL_LABEL_MAX));
  });
});
