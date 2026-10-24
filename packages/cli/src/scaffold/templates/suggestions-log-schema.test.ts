import { describe, it, expect } from "vitest";
// Import through the package barrel (not the schema file directly) to prove the
// public export wiring works. SUGGESTION_AXES is pulled in as a runtime value so
// the barrel is genuinely resolved at runtime — a broken export path fails here.
import { SUGGESTION_AXES } from "../../index.js";
import type {
  SuggestionsLog,
  SuggestionLogEntry,
  SuggestionAxis,
} from "../../index.js";

describe("SuggestionsLog schema", () => {
  it("is importable from the barrel and structurally usable", () => {
    // A real axis value sourced from the catalog primitive, proving the log's
    // `axis` field is assignable from a genuine SuggestionAxis.
    const axis: SuggestionAxis = SUGGESTION_AXES[0];

    // One entry per response variant: a register-only-ish `yes` with
    // artifactPaths, a `customize` with artifactPaths + customizationNote, and a
    // `no` with a reason.
    const log: SuggestionsLog = {
      schemaVersion: "1",
      generatedAt: "2026-05-31T00:00:00.000Z",
      detection: { stacks: ["typescript"], frameworks: ["express"], signals: {} },
      entries: [
        {
          catalogEntryId: "vercel-deploy",
          axis,
          offeredAt: "2026-05-31T00:00:01.000Z",
          response: "yes",
          artifactPaths: [".swarm/deploy/vercel.md"],
        },
        {
          catalogEntryId: "github-mcp",
          axis: "mcp",
          offeredAt: "2026-05-31T00:00:02.000Z",
          response: "customize",
          artifactPaths: [".mcp.json"],
          customizationNote: "scoped token to read-only",
        },
        {
          catalogEntryId: "security-review",
          axis: "skill",
          offeredAt: "2026-05-31T00:00:03.000Z",
          response: "no",
          reason: "not relevant to this repo",
        },
      ],
    };

    expect(log.entries).toHaveLength(3);
    expect(log.entries.map((e: SuggestionLogEntry) => e.response)).toEqual([
      "yes",
      "customize",
      "no",
    ]);

    const [yes, customize, no] = log.entries;
    expect(yes.artifactPaths).toEqual([".swarm/deploy/vercel.md"]);
    expect(customize.artifactPaths).toBeDefined();
    expect(customize.customizationNote).toBe("scoped token to read-only");
    expect(no.reason).toBe("not relevant to this repo");

    // `axis` is assignable from a real SuggestionAxis value.
    expect(SUGGESTION_AXES).toContain(yes.axis);
  });
});
