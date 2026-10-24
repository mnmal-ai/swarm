import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Script-level tests for scripts/generate-version.mjs
//
// Guards the three-tier version-resolution contract used by the release
// pipeline: SWARM_VERSION_OVERRIDE wins first (set by
// scripts/compile-release-binaries.sh during @semantic-release/exec prepare),
// then `git describe --tags --abbrev=0`, then package.json.
//
// Each test sets up a throwaway directory mimicking the "packages/cli"
// layout, runs the script with various env/git/package.json states, and
// asserts the generated VERSION string.
// ---------------------------------------------------------------------------

const SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "generate-version.mjs");

function runScript(cwd: string, env: Record<string, string | undefined> = {}) {
  // Strip SWARM_VERSION_OVERRIDE from the inherited shell env by default so
  // fallback tests aren't fooled by a dev who sourced compile-release-binaries.sh
  // in their shell and didn't unset afterward. Explicit entries in `env` still
  // win — set `SWARM_VERSION_OVERRIDE: "9.9.9"` to exercise the override tier,
  // pass `undefined` (or omit) to exercise the fallback tiers. CI is likewise
  // scrubbed so the script doesn't take CI-only code paths during tests.
  execFileSync(process.execPath, [SCRIPT], {
    cwd,
    env: {
      ...process.env,
      SWARM_VERSION_OVERRIDE: undefined,
      CI: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return readFileSync(join(cwd, "src", "version.ts"), "utf-8");
}

function scaffold(pkgVersion: string) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-gen-ver-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "probe", version: pkgVersion }, null, 2),
  );
  return dir;
}

describe("scripts/generate-version.mjs", () => {
  let dir: string;

  beforeEach(() => { dir = scaffold("0.8.0"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("uses SWARM_VERSION_OVERRIDE when set — even if git describe would resolve", () => {
    const out = runScript(dir, { SWARM_VERSION_OVERRIDE: "9.9.9-test" });
    expect(out).toContain('VERSION = "9.9.9-test"');
  });

  it("falls back to git describe when no override is set", () => {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "package.json"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["tag", "v7.7.7"], { cwd: dir, stdio: "ignore" });

    const out = runScript(dir, {});
    expect(out).toContain('VERSION = "7.7.7"');
  });

  it("falls back to package.json when override is unset and git describe fails", () => {
    const out = runScript(dir, {});
    expect(out).toContain('VERSION = "0.8.0"');
  });

  it("treats an empty-string override as absent (falls through to next tier)", () => {
    const out = runScript(dir, { SWARM_VERSION_OVERRIDE: "" });
    expect(out).toContain('VERSION = "0.8.0"');
  });
});
