import { describe, it, expect } from "vitest";
import { parseSecretsExclusions, scrubContent, shouldExcludeFile } from "../src/telemetry/scrub.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES = join(__dirname, "fixtures", "scrub-test-payload");

describe("parseSecretsExclusions", () => {
  it("parses glob patterns from secrets.md Sensitive Files section", async () => {
    const content = await readFile(join(FIXTURES, "secrets.md"), "utf-8");
    const exclusions = parseSecretsExclusions(content);
    expect(exclusions.sensitiveFiles).toContain("secret-config.yaml");
    expect(exclusions.sensitiveFiles).toContain("**/*.pem");
    expect(exclusions.sensitiveSwarmFiles).toContain("domains/test/environment.md");
  });

  it("returns empty arrays for secrets.md without sections", () => {
    const exclusions = parseSecretsExclusions("# No sections here");
    expect(exclusions.sensitiveFiles).toHaveLength(0);
    expect(exclusions.sensitiveSwarmFiles).toHaveLength(0);
  });
});

describe("shouldExcludeFile", () => {
  it("excludes files matching sensitive file globs", () => {
    const exclusions = {
      sensitiveFiles: ["secret-config.yaml", "**/*.pem"],
      sensitiveSwarmFiles: ["domains/test/environment.md"],
    };
    expect(shouldExcludeFile("secret-config.yaml", exclusions)).toBe(true);
    expect(shouldExcludeFile("certs/server.pem", exclusions)).toBe(true);
    expect(shouldExcludeFile("domains/test/environment.md", exclusions)).toBe(true);
    expect(shouldExcludeFile("clean-file.md", exclusions)).toBe(false);
  });

  it("always excludes secrets.md itself", () => {
    const exclusions = { sensitiveFiles: [], sensitiveSwarmFiles: [] };
    expect(shouldExcludeFile("domains/test/secrets.md", exclusions)).toBe(true);
    expect(shouldExcludeFile("secrets.md", exclusions)).toBe(true);
  });

  it("does not exclude files with 'secrets' in the name that aren't secrets.md", () => {
    const exclusions = { sensitiveFiles: [], sensitiveSwarmFiles: [] };
    expect(shouldExcludeFile("no-secrets.md", exclusions)).toBe(false);
    expect(shouldExcludeFile("domains/test/my-secrets.md", exclusions)).toBe(false);
    expect(shouldExcludeFile("company-secrets.md", exclusions)).toBe(false);
  });
});

describe("scrubContent", () => {
  it("redacts Anthropic API keys", () => {
    const result = scrubContent("key: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234");
    expect(result).not.toContain("sk-ant-api03");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Google API keys", () => {
    const result = scrubContent("key: AIzaSyAbYRQqCaOCerLZ_K2_J5caoZTzUP064HE");
    expect(result).not.toContain("AIza");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts AWS access keys", () => {
    const result = scrubContent("aws: AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("AKIA");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const result = scrubContent("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh");
    expect(result).not.toContain("ghp_");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const result = scrubContent("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.long.token");
    expect(result).not.toContain("eyJhbG");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts PEM private key markers", () => {
    const result = scrubContent("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----");
    expect(result).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result).toContain("[REDACTED]");
  });

  it("replaces absolute home paths", () => {
    const result = scrubContent("path: /home/user/Developer/project");
    expect(result).not.toContain("/home/user");
    expect(result).toContain("~/");
  });

  it("leaves clean content untouched", () => {
    const clean = "This is a normal description with no secrets.";
    expect(scrubContent(clean)).toBe(clean);
  });
});
