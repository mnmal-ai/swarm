import { describe, it, expect } from "vitest";
import { getSkillTemplate, type SkillTool } from "./index.js";
import { SUGGESTION_AXES } from "../suggestions/types.js";

// The four editor variants the onboarding skill ships for. Each wraps the same
// composed body (suggestion menu, then file-by-file domain population), so every
// content assertion below runs against all four to prove the integration is
// uniform and no variant drifts.
const TOOLS: SkillTool[] = ["claude-code", "cursor", "copilot", "universal"];

// The first line of buildSuggestionFlowBody — used as the boundary marker that
// separates the wrapper's own framing (frontmatter/description/intro) from the
// embedded suggestion-flow body.
const FLOW_BODY_START = "You are running swarm's onboarding suggestion flow.";

// The first line of buildSkillContent (Stage 2) — the start of the original
// file-by-file domain-context population. Used to assert ordering and presence.
const STAGE_TWO_START =
  "You are helping the user populate their swarm";

describe("getSkillTemplate — menu-driven onboarding output", () => {
  // Each variant returns a distinct destination path; assert the wiring still
  // routes every tool to its expected file so a swapped case is caught.
  const expectedPaths: Record<SkillTool, string> = {
    "claude-code": ".claude/commands/prepare-for-swarm.md",
    cursor: ".cursor/rules/prepare-for-swarm.mdc",
    copilot: ".github/copilot-instructions.md",
    universal: "SWARM-PROMPT.md",
  };

  for (const tool of TOOLS) {
    describe(`variant: ${tool}`, () => {
      const { path, content } = getSkillTemplate(tool, "demo-project");

      it("targets the expected destination path", () => {
        expect(path).toBe(expectedPaths[tool]);
      });

      it("embeds the suggestion-flow body before the Stage 2 file-by-file content", () => {
        const flowIdx = content.indexOf(FLOW_BODY_START);
        const stageTwoIdx = content.indexOf(STAGE_TWO_START);
        expect(flowIdx).toBeGreaterThan(-1);
        expect(stageTwoIdx).toBeGreaterThan(-1);
        // Suggestion menu runs FIRST (Stage 1), then domain population (Stage 2).
        expect(flowIdx).toBeLessThan(stageTwoIdx);
        // The explicit transition header marks the boundary between the stages.
        expect(content).toContain(
          "# Stage 2 — Populate domain context, file by file",
        );
      });

      it("teaches the DETECT phase as prose with a verbal-interview fallback", () => {
        expect(content).toContain("DETECT");
        // The illustrative prose report the agent is told to emit.
        expect(content).toContain("Vercel + Hono + Drizzle");
        // Graceful degradation when the backend cannot read files.
        expect(content.toLowerCase()).toContain("verbal interview");
        expect(content).toContain("available: false");
      });

      it("iterates all three axes in canonical order, capped per axis", () => {
        const [deployment, skill, mcp] = SUGGESTION_AXES;
        for (const axis of SUGGESTION_AXES) {
          expect(content).toContain(axis);
        }
        // Order is load-bearing: deployment-completion → skill → mcp. Match the
        // backtick-quoted tokens so plain-prose mentions don't confuse ordering.
        expect(content.indexOf(`\`${deployment}\``)).toBeLessThan(
          content.indexOf(`\`${skill}\``),
        );
        expect(content.indexOf(`\`${skill}\``)).toBeLessThan(
          content.indexOf(`\`${mcp}\``),
        );
        // One suggestion at a time, fatigue-capped at 4-5 (rendered as "4-5"/"≤5").
        expect(content).toContain("One suggestion at a time");
        expect(content).toMatch(/4-5|≤5/);
      });

      it("offers a per-suggestion yes / customize / no branch", () => {
        expect(content).toContain("yes");
        expect(content).toContain("customize");
        expect(content).toContain("no");
        // customize walks inline editing; no records the decline reason.
        expect(content.toLowerCase()).toContain("inline editing");
        expect(content).toContain("reason");
        expect(content).toContain("customizationNote");
      });

      it("makes artifact copying opt-in, gated on acceptance", () => {
        expect(content.toLowerCase()).toContain("opt-in");
        expect(content).toContain("templateFiles");
        expect(content).toContain("artifactPaths");
      });

      it("mandates the .swarm/.suggestions-log.json transcript write", () => {
        expect(content).toContain(".swarm/.suggestions-log.json");
        expect(content).toContain("SuggestionsLog");
        expect(content).toContain('"schemaVersion": "1"');
        // The transition prose also reminds the agent the log is mandatory.
        expect(content).toContain(
          "including the mandatory `.swarm/.suggestions-log.json` transcript write",
        );
      });

      it("emits catalog-location and matcher-contract references for engine alignment", () => {
        // Catalog + template + log-schema locations.
        expect(content).toContain("src/scaffold/suggestions/catalog.json");
        expect(content).toContain("src/scaffold/suggestions/templates/<id>/");
        expect(content).toContain(
          "src/scaffold/templates/suggestions-log-schema.ts",
        );
        // Matcher path + its three exported entry points (the flow contract).
        expect(content).toContain("src/scaffold/suggestions/matcher.ts");
        expect(content).toContain("loadCatalog");
        expect(content).toContain("detectEnvironment");
        expect(content).toContain("matchSuggestions");
      });

      it("retains the Stage 2 file-by-file domain-context population (regression guard)", () => {
        expect(content).toContain("File-by-File Workflow");
        expect(content).toContain("### File 1:");
        expect(content).toContain("### File 8:");
        // projectName is sanitized and interpolated into the domain paths.
        expect(content).toContain("domains/demo-project/overview.md");
        expect(content).toContain("domains/demo-project/goals.json");
      });

      it("mentions the suggestion menu in the wrapper description, not just the body", () => {
        const descIdx = content.indexOf("suggestion menu");
        expect(descIdx).toBeGreaterThan(-1);
        // The wrapper framing precedes the embedded flow body, proving the
        // mention is in the variant's own description/frontmatter/intro.
        expect(descIdx).toBeLessThan(content.indexOf(FLOW_BODY_START));
      });
    });
  }

  it("sanitizes the project name into the interpolated domain paths", () => {
    const { content } = getSkillTemplate("claude-code", "My Cool App!");
    expect(content).toContain("domains/my-cool-app-/overview.md");
  });

  describe("domain-only mode", () => {
    const { content } = getSkillTemplate("claude-code", "demo-project", true);

    it("keeps the file-by-file domain population", () => {
      expect(content).toContain("File-by-File Workflow");
      expect(content).toContain("domains/demo-project/overview.md");
    });

    it("omits the suggestion menu (it is reserved for full onboarding)", () => {
      expect(content).not.toContain(FLOW_BODY_START);
      expect(content).not.toContain(".swarm/.suggestions-log.json");
      expect(content).not.toContain(
        "# Stage 2 — Populate domain context, file by file",
      );
    });
  });
});
