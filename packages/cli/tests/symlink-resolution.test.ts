import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillSlug } from "../src/cli/add.js";

// ---------------------------------------------------------------------------
// Symlink resolution tests
// ---------------------------------------------------------------------------

describe("symlink resolution", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "swarm-symlink-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
    tempDirs.length = 0;
  });

  it("realpathSync resolves a symlink to the real swarm directory", () => {
    const rawSwarm = makeTempDir();
    // Resolve the temp dir itself (macOS /var → /private/var)
    const realSwarm = realpathSync(rawSwarm);
    mkdirSync(join(realSwarm, "skills", "vetted"), { recursive: true });

    const container = makeTempDir();
    const symlinkPath = join(container, ".swarm");
    symlinkSync(realSwarm, symlinkPath);

    const resolved = realpathSync(symlinkPath);
    expect(resolved).toBe(realSwarm);
  });

  it("realpathSync throws for a broken symlink", () => {
    const container = makeTempDir();
    const symlinkPath = join(container, ".swarm");
    symlinkSync("/nonexistent/path/that/does/not/exist", symlinkPath);

    expect(() => realpathSync(symlinkPath)).toThrow();
  });

  it("resolveSkillSlug returns fallback when no lock file exists", () => {
    const dir = makeTempDir();
    const slug = resolveSkillSlug("owner/my-skill", dir);
    expect(slug).toBe("my-skill");
  });
});
