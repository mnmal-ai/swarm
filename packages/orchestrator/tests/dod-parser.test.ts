import { describe, it, expect } from "vitest";
import { parseFunctionalChecks } from "../src/orchestrator/dod-parser.js";

describe("parseFunctionalChecks", () => {
  it("extracts functional_checks from fenced code block", () => {
    const markdown = `# Definition of Done

## Build
\`\`\`bash
pnpm run build
\`\`\`

## Functional Checks
\`\`\`json:functional_checks
[
  {
    "description": "Dev server starts",
    "command": "timeout 10 bash -c 'pnpm dev & sleep 3 && curl -sf http://localhost:5173 && kill %1'",
    "timeout_seconds": 15
  },
  {
    "description": "App has routing",
    "command": "grep -r 'Route' src/App.tsx"
  }
]
\`\`\`
`;
    const checks = parseFunctionalChecks(markdown);
    expect(checks).toHaveLength(2);
    expect(checks[0].description).toBe("Dev server starts");
    expect(checks[0].timeout_seconds).toBe(15);
    expect(checks[1].timeout_seconds).toBeUndefined();
  });

  it("returns empty array when no functional_checks block", () => {
    expect(parseFunctionalChecks("# Just a heading\n\nSome text.")).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(
      parseFunctionalChecks("```json:functional_checks\nnot valid json\n```"),
    ).toEqual([]);
  });

  it("filters out entries missing required fields", () => {
    const markdown = `\`\`\`json:functional_checks
[
  { "description": "valid", "command": "echo ok" },
  { "description": "missing command" },
  { "command": "missing description" }
]
\`\`\``;
    const checks = parseFunctionalChecks(markdown);
    expect(checks).toHaveLength(1);
    expect(checks[0].description).toBe("valid");
  });
});
