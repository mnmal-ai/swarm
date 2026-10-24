/**
 * The check that a codex session left the repository's git hooks and config
 * alone: anything changed, added or removed is reported and put back.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardGitConfig } from "../src/codex-git-guard.js";

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "swarm-git-guard-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x");
  git("worktree", "add", "-q", join(dir, "wt"));
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  return dir;
}

describe("guardGitConfig", () => {
  it("reports nothing when nothing changed", () => {
    const dir = repo();
    expect(guardGitConfig(join(dir, "wt"))!.restore()).toEqual([]);
  });

  it("removes a planted hook, puts back a changed one and the config, and restores a deleted one", () => {
    const dir = repo();
    const hooks = join(dir, ".git", "hooks");
    const config = readFileSync(join(dir, ".git", "config"));
    const guard = guardGitConfig(join(dir, "wt"))!;
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\ncurl evil\n");
    writeFileSync(join(dir, ".git", "config"), "[core]\n\thooksPath = /tmp/elsewhere\n");
    rmSync(join(hooks, "pre-commit"));
    const changed = guard.restore();
    expect(changed).toEqual(expect.arrayContaining([join(hooks, "pre-push"), join(dir, ".git", "config"), join(hooks, "pre-commit")]));
    expect(existsSync(join(hooks, "pre-push"))).toBe(false);
    expect(readFileSync(join(dir, ".git", "config")).equals(config)).toBe(true);
    expect(readFileSync(join(hooks, "pre-commit"), "utf8")).toContain("exit 0");
  });

  it("puts back a hook's permissions, and notices a change of permissions alone", () => {
    const dir = repo();
    const hook = join(dir, ".git", "hooks", "pre-commit");
    chmodSync(hook, 0o755);
    let guard = guardGitConfig(join(dir, "wt"))!;
    rmSync(hook);
    expect(guard.restore()).toEqual([hook]);
    expect(statSync(hook).mode & 0o777).toBe(0o755);
    guard = guardGitConfig(join(dir, "wt"))!;
    chmodSync(hook, 0o644);
    expect(guard.restore()).toEqual([hook]);
    expect(statSync(hook).mode & 0o777).toBe(0o755);
  });

  it("watches a worktree's own config too", () => {
    const dir = repo();
    const guard = guardGitConfig(join(dir, "wt"))!;
    const own = join(dir, ".git", "worktrees", "wt", "config.worktree");
    writeFileSync(own, "[core]\n\thooksPath = /tmp/x\n");
    expect(guard.restore()).toEqual([own]);
    expect(existsSync(own)).toBe(false);
  });

  it("watches attributes and submodules' config and hooks", () => {
    const dir = repo();
    mkdirSync(join(dir, ".git", "modules", "sub", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "modules", "sub", "config"), "[core]\n");
    const guard = guardGitConfig(join(dir, "wt"))!;
    writeFileSync(join(dir, ".git", "info", "attributes"), "* filter=evil\n");
    writeFileSync(join(dir, ".git", "modules", "sub", "hooks", "post-checkout"), "#!/bin/sh\n");
    writeFileSync(join(dir, ".git", "modules", "sub", "config"), "[core]\n\thooksPath = /tmp/x\n");
    expect(guard.restore().map((f) => f.split("/.git/")[1]).sort()).toEqual(["info/attributes", "modules/sub/config", "modules/sub/hooks/post-checkout"]);
  });

  it("is null outside a repository", () => {
    expect(guardGitConfig(realpathSync(mkdtempSync(join(tmpdir(), "swarm-no-repo-"))))).toBeNull();
  });
});
