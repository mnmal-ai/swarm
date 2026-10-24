import { describe, it, expect } from "vitest";
import { Oversight } from "../src/index.js";

// extractJson is a method on the Oversight class — create a minimal instance to test it
function createOversight(): Oversight {
  const noopProvider = { execute: async () => ({ output: "", tokensUsed: { input: 0, output: 0 } }) };
  return new Oversight({
    reviewerProvider: noopProvider as never,
    reviewerModel: "test",
    arbiterProvider: noopProvider as never,
    arbiterModel: "test",
  });
}

describe("extractJson", () => {
  const oversight = createOversight();

  it("extracts JSON from clean input", () => {
    const result = oversight.extractJson('{"verdict": "approved", "reasons": []}');
    expect(result).toEqual({ verdict: "approved", reasons: [] });
  });

  it("extracts JSON wrapped in code fences", () => {
    const result = oversight.extractJson('```json\n{"verdict": "rejected", "reasons": ["bad"]}\n```');
    expect(result).toEqual({ verdict: "rejected", reasons: ["bad"] });
  });

  it("extracts JSON from prose with surrounding text", () => {
    const input = 'Here is my review:\n\n{"verdict": "approved", "reasons": ["looks good"]}\n\nThat is all.';
    const result = oversight.extractJson(input);
    expect(result).toEqual({ verdict: "approved", reasons: ["looks good"] });
  });

  it("handles braces inside string values", () => {
    const input = '{"verdict": "approved", "reasons": ["found {curly} braces in code"]}';
    const result = oversight.extractJson(input);
    expect(result).toEqual({ verdict: "approved", reasons: ["found {curly} braces in code"] });
  });

  it("handles escaped quotes inside strings", () => {
    const input = '{"verdict": "approved", "reasons": ["said \\"hello\\""]}';
    const result = oversight.extractJson(input);
    expect(result).toEqual({ verdict: "approved", reasons: ['said "hello"'] });
  });

  it("returns null for input without JSON", () => {
    expect(oversight.extractJson("No JSON here")).toBeNull();
    expect(oversight.extractJson("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(oversight.extractJson('{"verdict": "approved"')).toBeNull();
  });

  it("extracts first JSON object when multiple exist", () => {
    const input = 'First: {"verdict": "approved"} Second: {"b": 2}';
    const result = oversight.extractJson(input);
    expect(result).toEqual({ verdict: "approved" });
  });
});

// --- Tests derived from an early cold test's data (2026-04-03) ---
//
// Root cause: reviewer responses contain code snippets with braces BEFORE
// the JSON verdict. The old parser grabbed the first `{` which was a code
// brace, tried to parse it as JSON, failed, and returned null.
//
// The fix: scan for `{"` (JSON object start) instead of bare `{` (code).
// These tests are language-agnostic — the pattern applies to any language
// where the reviewer quotes code containing braces.

describe("extractJson — code braces before verdict JSON", () => {
  const oversight = createOversight();

  it("skips bare code braces and finds the verdict", () => {
    const raw = `The helper uses { cleanup() } for teardown. All tests pass.

{"verdict": "approved", "reasons": ["All tests pass"], "suggestions": []}`;

    const result = oversight.extractJson(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("approved");
  });

  it("skips lambda/closure braces from any language", () => {
    const raw = `Verified the filter uses { !$0.isCompleted } and the callback is { (err) => handleError(err) }.

{"verdict": "approved", "reasons": ["Logic correct"], "suggestions": []}`;

    const result = oversight.extractJson(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("approved");
  });

  it("skips multiple code braces across different patterns", () => {
    const raw = `Checked:
- Closure: { cleanup(name:) }
- Filter: { $0.isActive }
- Block: { [weak self] in self?.refresh() }
- Go struct: { Name: "test", Value: 42 }

{"verdict": "rejected", "reasons": ["Missing edge case"], "suggestions": ["Add nil test"]}`;

    const result = oversight.extractJson(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("rejected");
    expect(result!.reasons).toEqual(["Missing edge case"]);
  });

  it("handles inline code blocks with braces in markdown", () => {
    const raw = "The function returns `{ error: true }` on failure.\n\n" +
      '{"verdict": "approved", "reasons": ["Error handling correct"], "suggestions": []}';

    const result = oversight.extractJson(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("approved");
  });

  it("handles JSON-like code that isn't a verdict", () => {
    const raw = `The config uses {"port": 3000, "host": "localhost"} as defaults.

{"verdict": "approved", "reasons": ["Config correct"], "suggestions": []}`;

    const result = oversight.extractJson(raw);
    expect(result).not.toBeNull();
    // Should find the verdict, not the config object
    expect(result!.verdict).toBe("approved");
  });

  it("still works when JSON is the first thing in the response", () => {
    const raw = '{"verdict": "approved", "reasons": ["Clean"], "suggestions": []}';
    const result = oversight.extractJson(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("approved");
  });

  it("returns null when no verdict JSON exists at all", () => {
    const raw = "The code uses { cleanup() } and { filter() } but no JSON verdict.";
    const result = oversight.extractJson(raw);
    expect(result).toBeNull();
  });
});
