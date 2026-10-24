import { describe, it, expect } from "vitest";
import { captureTree } from "../src/telemetry/tree-capture.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("captureTree", () => {
  it("captures a nested directory structure", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-test-"));
    try {
      await mkdir(join(root, "src", "utils"), { recursive: true });
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, "src", "index.ts"), "export {}");
      await writeFile(join(root, "src", "utils", "helpers.ts"), "export {}");

      const tree = await captureTree(root);

      expect(tree).toContain("src/");
      expect(tree).toContain("index.ts");
      expect(tree).toContain("utils/");
      expect(tree).toContain("helpers.ts");
      expect(tree).toContain("package.json");
      // First line is the root dir path
      expect(tree.startsWith(root)).toBe(true);
      // Ends with a trailing newline
      expect(tree.endsWith("\n")).toBe(true);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("respects maxDepth parameter", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-depth-"));
    try {
      // Create a 4-level deep structure: a/b/c/d/deep.txt
      await mkdir(join(root, "a", "b", "c", "d"), { recursive: true });
      await writeFile(join(root, "a", "b", "c", "d", "deep.txt"), "deep");
      await writeFile(join(root, "a", "b", "shallow.txt"), "shallow");

      // maxDepth=2 should show a/ and b/ but not recurse into c/ contents
      const shallowTree = await captureTree(root, 2);
      expect(shallowTree).toContain("a/");
      expect(shallowTree).toContain("b/");
      // c/ appears at depth 2 in the listing but its children (d/) should not
      expect(shallowTree).toContain("c/");
      expect(shallowTree).not.toContain("deep.txt");

      // Full depth should show everything
      const deepTree = await captureTree(root, 10);
      expect(deepTree).toContain("deep.txt");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("excludes node_modules and .git directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-exclude-"));
    try {
      await mkdir(join(root, "node_modules", "some-pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "some-pkg", "index.js"), "");
      await mkdir(join(root, ".git", "objects"), { recursive: true });
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main");
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "app.ts"), "export {}");

      const tree = await captureTree(root);

      expect(tree).not.toContain("node_modules");
      expect(tree).not.toContain(".git");
      expect(tree).not.toContain("some-pkg");
      expect(tree).not.toContain("HEAD");
      expect(tree).toContain("src/");
      expect(tree).toContain("app.ts");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("excludes other common build directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-excl-"));
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "bundle.js"), "");
      await mkdir(join(root, ".DS_Store"), { recursive: true });
      await mkdir(join(root, "build"), { recursive: true });
      await writeFile(join(root, "build", "output.js"), "");
      await mkdir(join(root, "Pods"), { recursive: true });
      await mkdir(join(root, "DerivedData"), { recursive: true });
      await mkdir(join(root, ".build"), { recursive: true });
      await writeFile(join(root, "README.md"), "hello");

      const tree = await captureTree(root);

      // Get only the tree lines (skip the first line which is the root path)
      const treeLines = tree.split("\n").slice(1).join("\n");

      expect(treeLines).not.toContain("dist");
      expect(treeLines).not.toContain(".DS_Store");
      expect(treeLines).not.toContain("build");
      expect(treeLines).not.toContain("Pods");
      expect(treeLines).not.toContain("DerivedData");
      expect(treeLines).not.toContain(".build");
      expect(treeLines).toContain("README.md");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("sorts directories before files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-sort-"));
    try {
      // Create files and dirs that would interleave alphabetically
      await writeFile(join(root, "aaa.txt"), "file");
      await mkdir(join(root, "bbb"), { recursive: true });
      await writeFile(join(root, "ccc.txt"), "file");
      await mkdir(join(root, "ddd"), { recursive: true });

      const tree = await captureTree(root);
      const lines = tree.split("\n").filter((l) => l.trim().length > 0);

      // Skip the first line (root path). Find positions of dirs and files.
      const bbbIndex = lines.findIndex((l) => l.includes("bbb/"));
      const dddIndex = lines.findIndex((l) => l.includes("ddd/"));
      const aaaIndex = lines.findIndex((l) => l.includes("aaa.txt"));
      const cccIndex = lines.findIndex((l) => l.includes("ccc.txt"));

      // Both directories should appear before both files
      expect(bbbIndex).toBeLessThan(aaaIndex);
      expect(bbbIndex).toBeLessThan(cccIndex);
      expect(dddIndex).toBeLessThan(aaaIndex);
      expect(dddIndex).toBeLessThan(cccIndex);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("handles an empty directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-empty-"));
    try {
      const tree = await captureTree(root);

      // Should contain just the root path and a trailing newline
      expect(tree).toBe(root + "\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("uses tree-drawing characters for connectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-chars-"));
    try {
      await writeFile(join(root, "first.txt"), "");
      await writeFile(join(root, "last.txt"), "");

      const tree = await captureTree(root);

      // The non-last entries get "├── " and the last entry gets "└── "
      expect(tree).toContain("├──");
      expect(tree).toContain("└──");
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
