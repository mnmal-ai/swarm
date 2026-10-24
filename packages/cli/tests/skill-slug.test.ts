import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveSkillSlug } from "../src/cli/add.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveSkillSlug", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "swarm-slug-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves slug from lock file when repo name differs from skill name", async () => {
    const lockContent = {
      version: 1,
      skills: {
        "swiftui-pro": {
          source: "twostraws/SwiftUI-Agent-Skill",
          sourceType: "github",
          computedHash: "ce653d19fd00a4874489003025e9235be542e7134ff3c543e20afeb53fc3bc9a",
        },
      },
    };
    const dir = join(tempDir, "case-mismatch");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skills-lock.json"), JSON.stringify(lockContent));

    const slug = resolveSkillSlug("twostraws/SwiftUI-Agent-Skill", dir);
    expect(slug).toBe("swiftui-pro");
  });

  it("resolves slug from lock file with multiple skills", async () => {
    const lockContent = {
      version: 1,
      skills: {
        "swift-concurrency": {
          source: "AvdLee/Swift-Concurrency-Agent-Skill",
          sourceType: "github",
          computedHash: "05ef28a2",
        },
        "swift-testing": {
          source: "bocato/swift-testing-agent-skill",
          sourceType: "github",
          computedHash: "7527cbdc",
        },
        "swiftui-pro": {
          source: "twostraws/SwiftUI-Agent-Skill",
          sourceType: "github",
          computedHash: "ce653d19",
        },
      },
    };
    const dir = join(tempDir, "multi-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skills-lock.json"), JSON.stringify(lockContent));

    expect(resolveSkillSlug("twostraws/SwiftUI-Agent-Skill", dir)).toBe("swiftui-pro");
    expect(resolveSkillSlug("AvdLee/Swift-Concurrency-Agent-Skill", dir)).toBe("swift-concurrency");
    expect(resolveSkillSlug("bocato/swift-testing-agent-skill", dir)).toBe("swift-testing");
  });

  it("resolves slug for multi-skill repo with @skill-name syntax", async () => {
    const lockContent = {
      version: 1,
      skills: {
        "vercel-react-best-practices": {
          source: "vercel-labs/agent-skills",
          sourceType: "github",
          computedHash: "c858d2d9",
        },
      },
    };
    const dir = join(tempDir, "multi-skill-repo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skills-lock.json"), JSON.stringify(lockContent));

    const slug = resolveSkillSlug("vercel-labs/agent-skills@vercel-react-best-practices", dir);
    expect(slug).toBe("vercel-react-best-practices");
  });

  it("falls back to URL repo name when lock file is missing", async () => {
    const dir = join(tempDir, "no-lock");
    await mkdir(dir, { recursive: true });

    const slug = resolveSkillSlug("twostraws/SwiftUI-Agent-Skill", dir);
    expect(slug).toBe("SwiftUI-Agent-Skill");
  });

  it("falls back to URL repo name when skill not found in lock file", async () => {
    const lockContent = {
      version: 1,
      skills: {
        "some-other-skill": {
          source: "someone/other-repo",
          sourceType: "github",
          computedHash: "abc123",
        },
      },
    };
    const dir = join(tempDir, "not-in-lock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skills-lock.json"), JSON.stringify(lockContent));

    const slug = resolveSkillSlug("twostraws/SwiftUI-Agent-Skill", dir);
    expect(slug).toBe("SwiftUI-Agent-Skill");
  });

  it("falls back to URL repo name when lock file is malformed", async () => {
    const dir = join(tempDir, "bad-lock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skills-lock.json"), "not valid json{{{");

    const slug = resolveSkillSlug("twostraws/SwiftUI-Agent-Skill", dir);
    expect(slug).toBe("SwiftUI-Agent-Skill");
  });

  it("falls back to URL repo name when lock file has no skills field", async () => {
    const dir = join(tempDir, "empty-lock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skills-lock.json"), JSON.stringify({ version: 1 }));

    const slug = resolveSkillSlug("twostraws/SwiftUI-Agent-Skill", dir);
    expect(slug).toBe("SwiftUI-Agent-Skill");
  });
});
