/**
 * Agent rules delivered like the document index
 * (docs/superpowers/specs/2026-10-03-agent-rules-design.md): `must` rules in
 * full, `should` rules in full when pinned or relevant, the rest one line each
 * read by line range, and nothing changed while every rule fits the budget.
 */
import { describe, expect, it } from "vitest";
import { dropContextFiles, lexicalRuleRanker, parseRuleFile, planRules, renderRulesBlock, type RuleFile } from "../src/agent-rules.js";

const RULES = [
  "# Rules",
  "",
  "<!-- rules: should -->",
  "",
  "## Never Do",
  "<!-- rule: must -->",
  "",
  "- Never force push to a shared branch.",
  "- Never commit credentials.",
  "",
  "## Database",
  "",
  "### Migrations",
  "<!-- rule: should, pinned -->",
  "",
  "Never edit a migration that has shipped; add a new one.",
  "",
  "### Query budgets",
  "",
  "Queries on large tables must use an index. Full scans over 10,000 rows are rejected in review.",
  "",
  "## Frontend",
  "",
  "Components live next to their tests. Styles use the design tokens, never raw colours.",
  "",
  "## Releases",
  "",
  "Release notes are written for users, not engineers. Every release names its version.",
].join("\n");

const file = (path: string, content: string, absolutePath: string | null = `/home/dev/.swarm/${path}`): RuleFile => ({
  path,
  content,
  absolutePath,
});

describe("parseRuleFile", () => {
  it("splits at every heading from level 2 to 4 and gives each section its 1-based line range", () => {
    const sections = parseRuleFile(file("core/rules.md", RULES));
    expect(sections.map((s) => s.headingPath.join(" › "))).toEqual([
      "",
      "Never Do",
      "Database",
      "Database › Migrations",
      "Database › Query budgets",
      "Frontend",
      "Releases",
    ]);
    const neverDo = sections[1];
    expect(neverDo.startLine).toBe(5);
    expect(neverDo.endLine).toBe(10);
    expect(RULES.split("\n").slice(neverDo.startLine - 1, neverDo.endLine).join("\n")).toBe(neverDo.body);
  });

  it("reads a section's marker from the line after its heading, the file default otherwise, and must with neither", () => {
    const sections = parseRuleFile(file("core/rules.md", RULES));
    const by = (path: string) => sections.find((s) => s.headingPath.join(" › ") === path)!;
    expect(by("Never Do")).toMatchObject({ severity: "must", pinned: false });
    expect(by("Database › Migrations")).toMatchObject({ severity: "should", pinned: true });
    expect(by("Frontend")).toMatchObject({ severity: "should", pinned: false });

    const unmarked = parseRuleFile(file("core/rules.md", "# Rules\n\n## A\n\nAlways test.\n\n## B\n\nAlways lint.\n"));
    expect(unmarked.every((s) => s.severity === "must" && !s.pinned)).toBe(true);
  });

  it("lets a subsection inherit its parent's marker", () => {
    const content = ["## Database", "<!-- rule: should, pinned -->", "", "### Migrations", "", "Add a new one."].join("\n");
    const sections = parseRuleFile(file("x.md", content));
    expect(sections.find((s) => s.headingPath.length === 2)).toMatchObject({ severity: "should", pinned: true });
  });

  it("treats an unknown marker as must and reports it", () => {
    const sections = parseRuleFile(file("x.md", "## A\n<!-- rule: maybe -->\n\nText here.\n"));
    expect(sections.find((s) => s.headingPath[0] === "A")).toMatchObject({ severity: "must", markerError: "maybe" });
  });

  it("ignores headings inside code fences", () => {
    const content = ["## Examples", "", "```md", "## not a heading", "```", "", "Use fences."].join("\n");
    expect(parseRuleFile(file("x.md", content)).map((s) => s.headingPath.join(" › "))).toEqual(["Examples"]);
  });

  it("closes a code fence only with a fence as long as the one that opened it", () => {
    const content = ["## Examples", "", "````md", "```", "## still inside", "```", "````", "", "## After", "", "Text."].join("\n");
    expect(parseRuleFile(file("x.md", content)).map((s) => s.headingPath.join(" › "))).toEqual(["Examples", "After"]);
  });

  it("drops sections that hold no rule text, only a heading and markers", () => {
    const sections = parseRuleFile(file("core/rules.md", RULES));
    const database = sections.find((s) => s.headingPath.join(" › ") === "Database")!;
    expect(database.empty).toBe(true);
    expect(sections[0].empty).toBe(true); // title and the file default only
  });
});

describe("planRules", () => {
  const sections = parseRuleFile(file("core/rules.md", RULES));
  const total = sections.filter((s) => !s.empty).reduce((n, s) => n + s.tokens, 0);

  it("changes nothing while every rule fits the budget", () => {
    const plan = planRules(sections, { task: "fix the login form", maxTokens: total, relevant: 3 });
    expect(plan.overBudget).toBe(false);
    expect(plan.tokensIfFull).toBe(total);
  });

  it("over budget: must and pinned rules in full, the most relevant should rules next, the rest indexed", () => {
    const plan = planRules(sections, { task: "add a release note for the new version", maxTokens: 40, relevant: 1 });
    expect(plan.overBudget).toBe(true);
    const full = plan.full.map((s) => s.headingPath.join(" › "));
    expect(full).toContain("Never Do");
    expect(full).toContain("Database › Migrations");
    expect(plan.indexed.map((s) => s.headingPath.join(" › "))).toEqual(
      expect.arrayContaining(["Database › Query budgets", "Frontend"]),
    );
    // must never indexed, pinned never indexed
    expect(plan.indexed.some((s) => s.severity === "must" || s.pinned)).toBe(false);
  });

  it("keeps must rules in full even when they alone exceed the budget", () => {
    const plan = planRules(sections, { task: "anything", maxTokens: 1, relevant: 3 });
    expect(plan.full.filter((s) => s.severity === "must").length).toBe(sections.filter((s) => !s.empty && s.severity === "must").length);
  });

  it("adds a relevant should rule in full only while the block stays within the budget", () => {
    const plan = planRules(sections, { task: "release version notes", maxTokens: 10_000_000, relevant: 0 });
    expect(plan.overBudget).toBe(false);
    const tight = planRules(sections, { task: "release version notes", maxTokens: 45, relevant: 3 });
    const fullShould = tight.full.filter((s) => s.severity === "should" && !s.pinned);
    const fullTokens = tight.full.reduce((n, s) => n + s.tokens, 0);
    const mustAndPinned = tight.full.filter((s) => s.severity === "must" || s.pinned).reduce((n, s) => n + s.tokens, 0);
    if (fullShould.length > 0) expect(fullTokens).toBeLessThanOrEqual(Math.max(45, mustAndPinned));
  });

  it("puts sections from a file it can't point at in full: there is no line range to read", () => {
    const stored = parseRuleFile(file("domains/acme/constraints.md", RULES, null));
    const plan = planRules(stored, { task: "anything", maxTokens: 1, relevant: 0 });
    expect(plan.indexed).toEqual([]);
  });

  it("uses the ranker it is given", () => {
    const frontendFirst = (_task: string, s: Array<{ headingPath: string[] }>) => s.map((x) => (x.headingPath[0] === "Frontend" ? 10 : 0));
    // One token short of everything: over budget, with room for one more rule.
    const plan = planRules(sections, { task: "release", maxTokens: total - 1, relevant: 1, ranker: frontendFirst });
    expect(plan.overBudget).toBe(true);
    expect(plan.full.map((s) => s.headingPath.join(" › "))).toContain("Frontend");
    expect(plan.full.map((s) => s.headingPath.join(" › "))).not.toContain("Releases");
  });
});

describe("lexicalRuleRanker", () => {
  it("scores task words in a heading above the same words in a body, and ignores short and stop words", () => {
    const sections = parseRuleFile(file("core/rules.md", RULES)).filter((s) => !s.empty);
    const scores = lexicalRuleRanker("the release version for the users", sections);
    const releases = sections.findIndex((s) => s.headingPath[0] === "Releases");
    expect(scores[releases]).toBe(Math.max(...scores));
    expect(scores[sections.findIndex((s) => s.headingPath[0] === "Frontend")]).toBe(0);
  });
});

describe("renderRulesBlock", () => {
  it("puts full sections first under their file, with parent headings, then one index line per remaining rule", () => {
    const files = [file("core/rules.md", RULES)];
    const sections = files.flatMap(parseRuleFile);
    const plan = planRules(sections, { task: "release notes", maxTokens: 40, relevant: 1 });
    const text = renderRulesBlock(plan, files);
    expect(text.startsWith("## Project Rules")).toBe(true);
    expect(text).toContain("### /home/dev/.swarm/core/rules.md");
    expect(text).toContain("- Never force push to a shared branch.");
    // The parent heading of a full subsection comes with it.
    expect(text.indexOf("## Database")).toBeLessThan(text.indexOf("### Migrations"));
    // An indexed rule is one line with its range, size and synopsis.
    const queryBudgets = sections.find((s) => s.headingPath.join(" › ") === "Database › Query budgets")!;
    expect(text).toContain(`- L${queryBudgets.startLine}–${queryBudgets.endLine} Database › Query budgets (${queryBudgets.tokens} tok) — Queries on large tables must use an index.`);
    // Markers are for swarm, not for the model.
    expect(text).not.toContain("<!-- rule");
  });

  it("gives a parent heading its own level when the file skips one", () => {
    const content = ["<!-- rules: should -->", "## Storage", "", "#### Backups", "<!-- rule: must -->", "", "Back up nightly.", "", "## Other", "", "Something unrelated to the task at all, at some length so it costs more."].join("\n");
    const files = [file("x.md", content)];
    const plan = planRules(files.flatMap(parseRuleFile), { task: "zzz", maxTokens: 1, relevant: 0 });
    const text = renderRulesBlock(plan, files);
    expect(text).toMatch(/^## Storage\n\n#### Backups$/m);
  });

  it("is empty when the plan isn't over budget", () => {
    const files = [file("core/rules.md", RULES)];
    const plan = planRules(files.flatMap(parseRuleFile), { task: "x", maxTokens: 1_000_000, relevant: 3 });
    expect(renderRulesBlock(plan, files)).toBe("");
  });
});

describe("dropContextFiles", () => {
  const files = [
    { path: "core/values.md", tier: "core" },
    { path: "core/rules.md", tier: "core" },
    { path: "domains/acme/constraints.md", tier: "domain" },
    { path: "domains/acme/overview.md", tier: "domain" },
  ];
  const blob = [
    "--- swarm: core/values.md (core) ---\nVALUES",
    "--- swarm: core/rules.md (core) ---\nRULES\n\nMORE RULES",
    "--- swarm: domains/acme/constraints.md (domain) ---\nCONSTRAINTS",
    "--- swarm: domains/acme/overview.md (domain) ---\nOVERVIEW",
  ].join("\n\n");

  it("takes the named files out of an assembled context and keeps the rest byte for byte", () => {
    expect(dropContextFiles(blob, files, ["core/rules.md", "domains/acme/constraints.md"])).toBe(
      "--- swarm: core/values.md (core) ---\nVALUES\n\n--- swarm: domains/acme/overview.md (domain) ---\nOVERVIEW",
    );
    expect(dropContextFiles(blob, files, [])).toBe(blob);
    expect(dropContextFiles(blob, files, files.map((f) => f.path))).toBe("");
  });

  it("returns null when the context doesn't split by its manifest, so nothing is changed blind", () => {
    expect(dropContextFiles("something else", files, ["core/rules.md"])).toBeNull();
  });
});
