/**
 * Tests that the dashboard's matchesFilter function correctly classifies
 * events for each filter tab, including backend:progress sub-types.
 *
 * The matchesFilter function is extracted from the real dashboard.html
 * at test time using vm.runInContext, so these tests always exercise
 * the production code — no manual mirroring needed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createContext, runInContext } from "vm";

/**
 * Extract the real matchesFilter from src/server/dashboard.html so
 * tests break if the production code changes without updating tests.
 */
const htmlPath = join(process.cwd(), "src", "server", "dashboard.html");
const htmlSource = readFileSync(htmlPath, "utf8");

const fnMatch = htmlSource.match(
  /\/\* matchesFilter:start \*\/([\s\S]*?)\/\* matchesFilter:end \*\//,
);
if (!fnMatch) {
  throw new Error(
    "Could not find matchesFilter sentinel comments in src/server/dashboard.html",
  );
}

const sandbox: { module: { exports: unknown } } = {
  module: { exports: undefined },
};
createContext(sandbox);
runInContext(`${fnMatch[1]}\nmodule.exports = matchesFilter;`, sandbox);

const matchesFilter = sandbox.module.exports as (
  type: string,
  f: string,
  p?: { type?: string },
) => boolean;

describe("dashboard matchesFilter (extracted from dashboard.html)", () => {
  describe("'all' filter", () => {
    it("matches every event type", () => {
      expect(matchesFilter("tool:start", "all")).toBe(true);
      expect(matchesFilter("backend:progress", "all", { type: "tool_call" })).toBe(true);
      expect(matchesFilter("turn:start", "all")).toBe(true);
      expect(matchesFilter("oversight:verdict", "all")).toBe(true);
    });
  });

  describe("'tools' filter", () => {
    it("matches SDK tool:start and tool:end events", () => {
      expect(matchesFilter("tool:start", "tools")).toBe(true);
      expect(matchesFilter("tool:end", "tools")).toBe(true);
    });

    it("matches backend:progress tool_call events", () => {
      expect(matchesFilter("backend:progress", "tools", { type: "tool_call" })).toBe(true);
    });

    it("matches backend:progress tool_summary events", () => {
      expect(matchesFilter("backend:progress", "tools", { type: "tool_summary" })).toBe(true);
    });

    it("matches backend:progress tool_progress events", () => {
      expect(matchesFilter("backend:progress", "tools", { type: "tool_progress" })).toBe(true);
    });

    it("does not match backend:progress model_response events", () => {
      expect(matchesFilter("backend:progress", "tools", { type: "model_response" })).toBe(false);
    });

    it("does not match turn or oversight events", () => {
      expect(matchesFilter("turn:start", "tools")).toBe(false);
      expect(matchesFilter("oversight:verdict", "tools")).toBe(false);
    });
  });

  describe("'turns' filter", () => {
    it("matches SDK turn:start and turn:end events", () => {
      expect(matchesFilter("turn:start", "turns")).toBe(true);
      expect(matchesFilter("turn:end", "turns")).toBe(true);
    });

    it("matches backend:progress model_response events", () => {
      expect(matchesFilter("backend:progress", "turns", { type: "model_response" })).toBe(true);
    });

    it("does not match tool events", () => {
      expect(matchesFilter("tool:start", "turns")).toBe(false);
      expect(matchesFilter("backend:progress", "turns", { type: "tool_call" })).toBe(false);
    });
  });

  describe("'oversight' filter", () => {
    it("matches oversight events", () => {
      expect(matchesFilter("oversight:start", "oversight")).toBe(true);
      expect(matchesFilter("oversight:verdict", "oversight")).toBe(true);
    });

    it("matches task:verdict events", () => {
      expect(matchesFilter("task:verdict", "oversight")).toBe(true);
    });

    it("does not match tool or turn events", () => {
      expect(matchesFilter("tool:start", "oversight")).toBe(false);
      expect(matchesFilter("turn:start", "oversight")).toBe(false);
    });
  });

  describe("'tokens' filter", () => {
    it("matches tokens:update events", () => {
      expect(matchesFilter("tokens:update", "tokens")).toBe(true);
    });

    it("matches turn:end events (which show each turn's tokens)", () => {
      expect(matchesFilter("turn:end", "tokens")).toBe(true);
    });

    it("matches task:verdict events (which show the task's tokens)", () => {
      expect(matchesFilter("task:verdict", "tokens")).toBe(true);
    });

    it("does not match unrelated events", () => {
      expect(matchesFilter("tool:start", "tokens")).toBe(false);
      expect(matchesFilter("oversight:start", "tokens")).toBe(false);
    });
  });

  describe("'progress' filter", () => {
    it("matches all backend:progress events", () => {
      expect(matchesFilter("backend:progress", "progress")).toBe(true);
      expect(matchesFilter("backend:progress", "progress", { type: "status_change" })).toBe(true);
      expect(matchesFilter("backend:progress", "progress", { type: "session_init" })).toBe(true);
      expect(matchesFilter("backend:progress", "progress", { type: "tool_call" })).toBe(true);
    });

    it("does not match tool or turn events", () => {
      expect(matchesFilter("tool:start", "progress")).toBe(false);
      expect(matchesFilter("turn:start", "progress")).toBe(false);
    });
  });
});
