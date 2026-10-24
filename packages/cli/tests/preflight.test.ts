import { describe, it, expect } from "vitest";
import { getProviderCredentialKeys, PROVIDER_CREDENTIALS } from "../src/cli/run.js";

describe("getProviderCredentialKeys", () => {
  it("returns ANTHROPIC_API_KEY for anthropic provider", () => {
    expect(getProviderCredentialKeys("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("returns OPENAI_API_KEY for openai provider", () => {
    expect(getProviderCredentialKeys("openai")).toEqual(["OPENAI_API_KEY"]);
  });

  it("returns empty array for unknown provider", () => {
    expect(getProviderCredentialKeys("mistral")).toEqual([]);
    expect(getProviderCredentialKeys("")).toEqual([]);
  });
});

describe("PROVIDER_CREDENTIALS", () => {
  it("has entries for all supported providers", () => {
    expect(Object.keys(PROVIDER_CREDENTIALS)).toContain("anthropic");
    expect(Object.keys(PROVIDER_CREDENTIALS)).toContain("openai");
  });

  it("each provider maps to at least one key", () => {
    for (const [provider, keys] of Object.entries(PROVIDER_CREDENTIALS)) {
      expect(keys.length, `${provider} should have at least one credential key`).toBeGreaterThan(0);
    }
  });
});
