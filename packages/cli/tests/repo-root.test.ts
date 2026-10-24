import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { resolveRepoRoot, assertGitRepo } from "../src/cli/repo-root.js";

describe("resolveRepoRoot", () => {
  it("prefers the --repo-path flag over config and cwd", () => {
    expect(
      resolveRepoRoot(
        { "repo-path": "/work/swarm" },
        { repo_root: "/cfg/repo", project_root: "/cfg/proj" },
        "/cwd/sample-app",
      ),
    ).toBe("/work/swarm");
  });

  it("falls back to config.repo_root when no flag is given", () => {
    expect(
      resolveRepoRoot(
        {},
        { repo_root: "/cfg/repo", project_root: "/cfg/proj" },
        "/cwd/sample-app",
      ),
    ).toBe("/cfg/repo");
  });

  it("falls back to config.project_root when neither flag nor repo_root is set", () => {
    expect(
      resolveRepoRoot({}, { project_root: "/cfg/proj" }, "/cwd/sample-app"),
    ).toBe("/cfg/proj");
  });

  it("defaults to cwd when nothing is configured (preserves current single-repo behavior)", () => {
    expect(resolveRepoRoot({}, {}, "/cwd/sample-app")).toBe(
      "/cwd/sample-app",
    );
  });
});

describe("assertGitRepo", () => {
  it("does not throw for a path inside a git work tree", () => {
    expect(() => assertGitRepo(process.cwd())).not.toThrow();
  });

  it("throws an actionable error for a non-git path", () => {
    expect(() => assertGitRepo(tmpdir())).toThrow(/not a git repository/i);
  });
});
