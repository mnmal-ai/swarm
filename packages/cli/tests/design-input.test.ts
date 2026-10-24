import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { scaffold, type ScaffoldConfig } from "../src/scaffold/index.js";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Goal } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Scaffold: designs directory and README
// ---------------------------------------------------------------------------

describe("design input — scaffold", () => {
  let tempDir: string;

  async function createTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "swarm-design-test-"));
  }

  it("scaffold creates designs/ directory with README.md", async () => {
    tempDir = await createTempDir();

    const config: ScaffoldConfig = {
      projectName: "design-test",
      outputDir: tempDir,
      fillLevel: "quick",
      backend: "claude-code",
      answers: {},
    };

    const result = await scaffold(config);

    // designs/ directory should exist
    const designsDir = join(tempDir, "designs");
    const dirStat = await stat(designsDir);
    expect(dirStat.isDirectory()).toBe(true);

    // README.md should be created inside designs/
    expect(result.filesCreated).toContain("designs/README.md");

    const readmeContent = await readFile(join(designsDir, "README.md"), "utf-8");
    expect(readmeContent).toContain("# Designs");
    expect(readmeContent).toContain("Supported Formats");
    expect(readmeContent).toContain(".figma.url");

    await rm(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Goal type: designs field
// ---------------------------------------------------------------------------

describe("design input — Goal type", () => {
  it("Goal interface accepts designs field", () => {
    const goal: Goal = {
      id: "goal-1",
      description: "Build main list view",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: ["List renders items"],
      designs: ["designs/list-view.png", "designs/nav-flow.md"],
    };

    expect(goal.designs).toHaveLength(2);
    expect(goal.designs![0]).toBe("designs/list-view.png");
  });

  it("Goal interface works without designs field", () => {
    const goal: Goal = {
      id: "goal-2",
      description: "Fix login bug",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: ["Login works"],
    };

    expect(goal.designs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Design context loading
// ---------------------------------------------------------------------------

describe("design input — context loading", () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = join(tmpdir(), "swarm-design-context-test-" + Date.now());
    mkdirSync(join(fixtureDir, "designs"), { recursive: true });

    // Create a markdown design file
    writeFileSync(
      join(fixtureDir, "designs", "nav-flow.md"),
      "# Navigation Flow\n\n```mermaid\ngraph TD\n  A-->B\n```\n",
    );

    // Create a Figma URL file
    writeFileSync(
      join(fixtureDir, "designs", "mockup.figma.url"),
      "https://www.figma.com/file/abc123/MyDesign\n",
    );

    // Create an image file (just a stub — we only check the placeholder)
    writeFileSync(join(fixtureDir, "designs", "list-view.png"), "fake-png-data");
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  /**
   * Replicates the design context loading logic from run.ts decomposeGoal
   * so we can test it in isolation without needing the full Swarm class.
   */
  function loadDesignContext(goal: Goal, swarmPath: string): string {
    let designContext = "";
    if (goal.designs && goal.designs.length > 0) {
      const designFiles: string[] = [];
      for (const designPath of goal.designs) {
        const fullPath = resolve(join(swarmPath, designPath));
        // Path traversal guard — must stay within swarmPath
        if (!fullPath.startsWith(resolve(swarmPath) + "/")) continue;
        if (existsSync(fullPath)) {
          const ext = designPath.split(".").pop()?.toLowerCase();
          if (ext === "md") {
            designFiles.push(`--- ${designPath} ---\n${readFileSync(fullPath, "utf-8")}`);
          } else if (ext === "url") {
            designFiles.push(`--- ${designPath} ---\nFigma URL: ${readFileSync(fullPath, "utf-8").trim()}`);
          } else {
            designFiles.push(`--- ${designPath} ---\n[Design image: ${designPath}]\nIMPORTANT: View this image file before starting work. Study what it shows and incorporate it into your implementation.`);
          }
        }
      }
      if (designFiles.length > 0) {
        designContext = "\n\n## Design References\n\n" + designFiles.join("\n\n");
      }
    }
    return designContext;
  }

  it("reads .md files inline", () => {
    const goal: Goal = {
      id: "g1",
      description: "Build nav",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: [],
      designs: ["designs/nav-flow.md"],
    };

    const context = loadDesignContext(goal, fixtureDir);
    expect(context).toContain("## Design References");
    expect(context).toContain("--- designs/nav-flow.md ---");
    expect(context).toContain("# Navigation Flow");
    expect(context).toContain("```mermaid");
  });

  it("reads .url files as Figma URLs", () => {
    const goal: Goal = {
      id: "g2",
      description: "Build mockup",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: [],
      designs: ["designs/mockup.figma.url"],
    };

    const context = loadDesignContext(goal, fixtureDir);
    expect(context).toContain("## Design References");
    expect(context).toContain("--- designs/mockup.figma.url ---");
    expect(context).toContain("Figma URL: https://www.figma.com/file/abc123/MyDesign");
  });

  it("notes image files with placeholder", () => {
    const goal: Goal = {
      id: "g3",
      description: "Build list view",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: [],
      designs: ["designs/list-view.png"],
    };

    const context = loadDesignContext(goal, fixtureDir);
    expect(context).toContain("## Design References");
    expect(context).toContain("[Design image: designs/list-view.png]");
    expect(context).toContain("View this image file before starting work");
  });

  it("silently skips missing design files", () => {
    const goal: Goal = {
      id: "g4",
      description: "Build something",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: [],
      designs: ["designs/does-not-exist.png", "designs/nav-flow.md"],
    };

    const context = loadDesignContext(goal, fixtureDir);
    // Should still contain the valid file
    expect(context).toContain("--- designs/nav-flow.md ---");
    // Should NOT contain the missing file
    expect(context).not.toContain("does-not-exist.png");
  });

  it("returns empty string when no designs are defined", () => {
    const goal: Goal = {
      id: "g5",
      description: "No designs",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: [],
    };

    const context = loadDesignContext(goal, fixtureDir);
    expect(context).toBe("");
  });

  it("returns empty string when designs array is empty", () => {
    const goal: Goal = {
      id: "g6",
      description: "Empty designs",
      priority: 1,
      status: "pending",
      constraints: [],
      acceptance_criteria: [],
      designs: [],
    };

    const context = loadDesignContext(goal, fixtureDir);
    expect(context).toBe("");
  });
});
