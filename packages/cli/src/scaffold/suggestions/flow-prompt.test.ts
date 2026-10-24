import { describe, it, expect } from "vitest";
// Import through the package barrel (not the module directly) to prove the
// public export wiring works — a broken export path fails here.
import { buildSuggestionFlowBody } from "../../index.js";
import { SUGGESTION_AXES } from "./types.js";

describe("buildSuggestionFlowBody", () => {
  const body = buildSuggestionFlowBody();

  it("returns a non-trivial editor-neutral prose body", () => {
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(500);
    // Body only: no YAML frontmatter and no editor-specific swarm markers — the
    // variant wrappers add those, not this builder.
    expect(body.startsWith("---")).toBe(false);
    expect(body).not.toContain("swarm:begin");
  });

  it("teaches all three axes in canonical order", () => {
    for (const axis of SUGGESTION_AXES) {
      expect(body).toContain(axis);
    }
    // Order: deployment-completion before skill before mcp. Match the
    // backtick-quoted axis tokens — the bare words "skill"/"mcp" also appear as
    // plain prose, so only the code-span form unambiguously marks the axis.
    const [deployment, skill, mcp] = SUGGESTION_AXES;
    expect(body.indexOf(`\`${deployment}\``)).toBeLessThan(
      body.indexOf(`\`${skill}\``),
    );
    expect(body.indexOf(`\`${skill}\``)).toBeLessThan(body.indexOf(`\`${mcp}\``));
  });

  it("instructs the DETECT phase to report findings and degrade gracefully", () => {
    expect(body).toContain("DETECT");
    // Graceful degradation to a verbal interview on no fs access. The
    // specific illustrative prose ("Vercel + Hono + Drizzle") used to be
    // asserted here verbatim; that's brittle against any rewording of the
    // example. Keep the structural invariants (verbal-interview fallback
    // and the `available: false` token consumers gate on) and let the
    // example prose evolve freely.
    expect(body.toLowerCase()).toContain("verbal interview");
    expect(body).toContain("available: false");
  });

  it("teaches one-at-a-time iteration with a per-axis cap", () => {
    // The "One suggestion at a time" headline was the previous brittle
    // assertion; the contract is the cap (≤5 / 4-5), not the exact phrase.
    expect(body).toMatch(/4-5|≤5/);
  });

  it("teaches the yes / customize / no choice with customize and decline handling", () => {
    expect(body).toContain("yes");
    expect(body).toContain("customize");
    expect(body).toContain("no");
    // customize walks inline editing; no records the decline reason.
    expect(body.toLowerCase()).toContain("inline editing");
    expect(body).toContain("reason");
  });

  it("makes only accepted artifacts opt-in by copying template files", () => {
    expect(body.toLowerCase()).toContain("opt-in");
    expect(body).toContain("templateFiles");
    expect(body).toContain("artifactPaths");
  });

  it("always mandates writing the suggestions-log transcript", () => {
    expect(body).toContain(".swarm/.suggestions-log.json");
    expect(body).toContain("SuggestionsLog");
    expect(body).toContain('"schemaVersion": "1"');
  });

  it("references the canonical engine paths so skill and engine agree", () => {
    expect(body).toContain("src/scaffold/suggestions/catalog.json");
    expect(body).toContain("src/scaffold/suggestions/matcher.ts");
    expect(body).toContain("src/scaffold/templates/suggestions-log-schema.ts");
    expect(body).toContain("src/scaffold/suggestions/templates/<id>/");
    // The matcher's three exported entry points (the flow contract).
    expect(body).toContain("loadCatalog");
    expect(body).toContain("detectEnvironment");
    expect(body).toContain("matchSuggestions");
  });
});
