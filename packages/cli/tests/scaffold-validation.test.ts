import { describe, it, expect } from "vitest";
import { scaffold, type ScaffoldConfig } from "../src/scaffold/index.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

function makeConfig(outputDir: string): ScaffoldConfig {
  return {
    projectName: "test-project",
    outputDir,
    fillLevel: "quick",
    backend: "undecided",
    answers: {},
  };
}

describe("scaffold template validation", () => {
  it("creates stubs when a route references a file without a template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-scaffold-"));
    try {
      // Scaffold normally, then inject a guaranteed-missing route
      await scaffold(makeConfig(dir));
      const swarmJsonPath = join(dir, "swarm.json");
      const swarmJson = JSON.parse(await readFile(swarmJsonPath, "utf-8"));
      swarmJson.routes.push({
        intent: "test-stub",
        description: "Test",
        load: { mode: ["modes/guaranteed-missing.md"] },
        keywords: ["test"],
      });
      await writeFile(swarmJsonPath, JSON.stringify(swarmJson, null, 2), "utf-8");

      // Re-scaffold with merge to trigger validation
      const result = await scaffold({
        ...makeConfig(dir),
        existingBehavior: "merge",
      });

      // Verify stub was created with correct content
      const stubContent = await readFile(
        join(dir, "modes/guaranteed-missing.md"),
        "utf-8",
      );
      expect(stubContent).toContain("STUB");
      expect(
        result.warnings.some((w) => w.includes("guaranteed-missing.md")),
      ).toBe(true);
      expect(result.warnings.some((w) => w.includes("stub file(s)"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates stub file when swarm.json references a non-existent template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-scaffold-"));
    try {
      // Scaffold normally first
      await scaffold(makeConfig(dir));

      // Tamper with swarm.json to add a route referencing a missing file
      const swarmJsonPath = join(dir, "swarm.json");
      const swarmJson = JSON.parse(await readFile(swarmJsonPath, "utf-8"));
      swarmJson.routes.push({
        intent: "fake",
        description: "Test route",
        load: { mode: ["modes/does-not-exist.md"] },
        keywords: ["fake"],
      });
      await writeFile(swarmJsonPath, JSON.stringify(swarmJson, null, 2), "utf-8");

      // Re-scaffold with merge to trigger validation on the new route
      const result = await scaffold({
        ...makeConfig(dir),
        existingBehavior: "merge",
      });

      // Verify the stub was created
      const stubContent = await readFile(
        join(dir, "modes/does-not-exist.md"),
        "utf-8",
      );
      expect(stubContent).toContain("STUB");
      expect(
        result.warnings.some((w) => w.includes("does-not-exist.md")),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves {project} placeholders in route paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-scaffold-"));
    try {
      await scaffold(makeConfig(dir));

      // Tamper to add a domain path with {project} that doesn't exist
      const swarmJsonPath = join(dir, "swarm.json");
      const swarmJson = JSON.parse(await readFile(swarmJsonPath, "utf-8"));
      swarmJson.routes[0].load.domain = [
        "domains/{project}/nonexistent.md",
      ];
      await writeFile(swarmJsonPath, JSON.stringify(swarmJson, null, 2), "utf-8");

      const result = await scaffold({
        ...makeConfig(dir),
        existingBehavior: "merge",
      });

      const stubPath = join(dir, "domains/test-project/nonexistent.md");
      const stubContent = await readFile(stubPath, "utf-8");
      expect(stubContent).toContain("STUB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
