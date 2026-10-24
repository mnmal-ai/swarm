import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectName } from "../src/cli/swarm-meta.js";

describe("resolveProjectName", () => {
  let swarmDir: string;

  beforeEach(() => { swarmDir = mkdtempSync(join(tmpdir(), "swarm-meta-")); });
  afterEach(() => { rmSync(swarmDir, { recursive: true, force: true }); });

  it("prefers an explicit override over everything else", () => {
    writeFileSync(join(swarmDir, ".swarm-meta.json"), JSON.stringify({ project_name: "from-meta" }));
    expect(resolveProjectName(swarmDir, "override")).toBe("override");
  });

  it("reads project_name from .swarm-meta.json", () => {
    writeFileSync(join(swarmDir, ".swarm-meta.json"), JSON.stringify({ project_name: "cold-test-1776347468" }));
    expect(resolveProjectName(swarmDir)).toBe("cold-test-1776347468");
  });

  it("infers the project name from the single domains/<name>/ folder", () => {
    const domainDir = join(swarmDir, "domains", "only-child");
    mkdirSync(domainDir, { recursive: true });
    expect(resolveProjectName(swarmDir)).toBe("only-child");
  });

  it("prefers .swarm-meta.json over the domains folder when both exist", () => {
    writeFileSync(join(swarmDir, ".swarm-meta.json"), JSON.stringify({ project_name: "from-meta" }));
    mkdirSync(join(swarmDir, "domains", "from-domain"), { recursive: true });
    expect(resolveProjectName(swarmDir)).toBe("from-meta");
  });

  it("falls back to global when no meta file and multiple domains exist", () => {
    mkdirSync(join(swarmDir, "domains", "a"), { recursive: true });
    mkdirSync(join(swarmDir, "domains", "b"), { recursive: true });
    expect(resolveProjectName(swarmDir)).toBe("global");
  });

  it("falls back to global for an empty swarm dir", () => {
    expect(resolveProjectName(swarmDir)).toBe("global");
  });

  it("ignores malformed .swarm-meta.json and falls through", () => {
    writeFileSync(join(swarmDir, ".swarm-meta.json"), "{ not json ");
    mkdirSync(join(swarmDir, "domains", "inferred"), { recursive: true });
    expect(resolveProjectName(swarmDir)).toBe("inferred");
  });
});
