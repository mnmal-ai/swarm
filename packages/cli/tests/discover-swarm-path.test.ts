/**
 * discoverSwarmPath: the content directory `swarm run`, `swarm merge` and
 * `swarm grade-data` use when `--swarm-path` is not given. It is the project's
 * own `.swarm/` and never a sibling directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSwarmPath } from "../src/cli/run.js";

describe("discoverSwarmPath", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "discover-swarm-path-")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const content = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "swarm.json"), "{}");
    return dir;
  };
  const cwd = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  };

  it("returns the project's .swarm/ when it holds a swarm.json", () => {
    const project = join(root, "project");
    content(join(project, ".swarm"));
    cwd(project);
    expect(discoverSwarmPath()).toBe(join(project, ".swarm"));
  });

  it("resolves a symlinked .swarm/ to its real path", () => {
    const real = content(join(root, "shared-content"));
    const project = join(root, "project");
    mkdirSync(project);
    symlinkSync(real, join(project, ".swarm"));
    cwd(project);
    expect(discoverSwarmPath()).toBe(real);
  });

  it("never falls back to a sibling swarm/ directory: returns the missing .swarm/ path", () => {
    content(join(root, "swarm"));
    const project = join(root, "project");
    cwd(project);
    expect(discoverSwarmPath()).toBe(join(project, ".swarm"));
  });
});
