import { describe, it, expect } from "vitest";
import { normalizeVersion } from "../src/cli/upgrade.js";

// `normalizeVersion` is the comparator backing the early-bail in
// `runUpgrade`: if the bundled VERSION constant equals the result of
// normalizing the latest release tag, the command exits before any
// download/sudo/codesign work. The shapes we feed it come from two
// sources that format versions differently — `gh api … --jq .tag_name`
// returns things like `"v0.35.0\n"`, while `npm view … version` returns
// `"0.35.0"`. Both must normalize to the same string.
describe("normalizeVersion", () => {
  it("strips a leading v", () => {
    expect(normalizeVersion("v0.35.0")).toBe("0.35.0");
  });

  it("preserves a string with no leading v", () => {
    expect(normalizeVersion("0.35.0")).toBe("0.35.0");
  });

  it("trims surrounding whitespace from gh's tag output", () => {
    expect(normalizeVersion("v0.35.0\n")).toBe("0.35.0");
    expect(normalizeVersion("  0.35.0  ")).toBe("0.35.0");
  });

  it("strips only a single leading v, not embedded ones", () => {
    expect(normalizeVersion("v1.2.3-vbeta")).toBe("1.2.3-vbeta");
  });

  it("returns gh-style and npm-style equivalents identically", () => {
    expect(normalizeVersion("v0.35.0\n")).toBe(normalizeVersion("0.35.0"));
  });

  it("normalizes pre-release tags without dropping the suffix", () => {
    expect(normalizeVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });
});
