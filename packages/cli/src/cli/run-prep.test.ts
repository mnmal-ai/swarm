import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunPrepError, acquireRunLock, runLockPath, runSetupCommand, syncBaseBranch, validateRunPrepConfig } from "./run-prep.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "swarm-run-prep-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

/** A clone on `main` with one commit, and a bare origin it tracks. */
function repoWithOrigin(): { clone: string; origin: string; seed: string } {
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  git(dir, "init", "--bare", "-b", "main", origin);
  git(dir, "init", "-b", "main", seed);
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", "a.txt");
  git(seed, "commit", "-q", "-m", "one");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", origin, clone);
  return { clone, origin, seed };
}

describe("acquireRunLock", () => {
  it("writes the lock and releases it", () => {
    const release = acquireRunLock(dir, "run-x", 4242);
    const lock = JSON.parse(readFileSync(runLockPath(dir), "utf-8"));
    expect(lock).toMatchObject({ pid: 4242, run_id: "run-x" });
    release();
    expect(existsSync(runLockPath(dir))).toBe(false);
  });

  it("refuses while a live process holds it", () => {
    acquireRunLock(dir, "run-live", process.pid);
    expect(() => acquireRunLock(dir, "run-two", process.pid + 100000)).toThrow(RunPrepError);
    expect(() => acquireRunLock(dir, "run-two", process.pid + 100000)).toThrow(/already going.*run-live/s);
  });

  it("replaces a lock left by a dead process", () => {
    writeFileSync(runLockPath(dir), JSON.stringify({ pid: 2147483000, run_id: "run-dead", started_at: "x" }));
    const release = acquireRunLock(dir, "run-new", 4242);
    expect(JSON.parse(readFileSync(runLockPath(dir), "utf-8")).run_id).toBe("run-new");
    release();
  });

  it("does not remove a lock another process has since taken", () => {
    const release = acquireRunLock(dir, "run-a", 4242);
    writeFileSync(runLockPath(dir), JSON.stringify({ pid: 4343, run_id: "run-b", started_at: "x" }));
    release();
    expect(existsSync(runLockPath(dir))).toBe(true);
  });
});

describe("syncBaseBranch", () => {
  it("fast-forwards main to origin/main and counts the commits", () => {
    const { clone, seed } = repoWithOrigin();
    writeFileSync(join(seed, "b.txt"), "b\n");
    git(seed, "add", "b.txt");
    git(seed, "commit", "-q", "-m", "two");
    git(seed, "push", "-q", "origin", "main");
    const result = syncBaseBranch(clone, "origin", "main");
    expect(result.commits).toBe(1);
    expect(result.after).toBe(git(seed, "rev-parse", "HEAD"));
    expect(existsSync(join(clone, "b.txt"))).toBe(true);
  });

  it("is a no-op when already current", () => {
    const { clone } = repoWithOrigin();
    const result = syncBaseBranch(clone, "origin", "main");
    expect(result.commits).toBe(0);
    expect(result.before).toBe(result.after);
  });

  it("refuses on another branch", () => {
    const { clone } = repoWithOrigin();
    git(clone, "checkout", "-q", "-b", "feature");
    expect(() => syncBaseBranch(clone, "origin", "main")).toThrow(/has "feature" checked out, not main/);
  });

  it("does not count swarm's own directory inside the repo as dirt", () => {
    const { clone } = repoWithOrigin();
    const swarmDir = join(clone, ".swarm");
    const lock = acquireRunLock(swarmDir, "run-x", process.pid);
    writeFileSync(join(swarmDir, "goals.json"), "{}\n");
    expect(() => syncBaseBranch(clone, "origin", "main")).toThrow(/uncommitted changes/);
    expect(syncBaseBranch(clone, "origin", "main", [swarmDir]).commits).toBe(0);
    // A swarm directory outside the repo ignores nothing inside it.
    writeFileSync(join(clone, "stray.txt"), "x\n");
    expect(() => syncBaseBranch(clone, "origin", "main", [join(dir, "elsewhere", ".swarm")])).toThrow(/stray\.txt/);
    lock();
  });

  it("refuses with uncommitted changes", () => {
    const { clone } = repoWithOrigin();
    writeFileSync(join(clone, "a.txt"), "changed\n");
    expect(() => syncBaseBranch(clone, "origin", "main")).toThrow(/uncommitted changes/);
  });

  it("refuses when the base has diverged from the remote", () => {
    const { clone, seed } = repoWithOrigin();
    writeFileSync(join(clone, "local.txt"), "l\n");
    git(clone, "add", "local.txt");
    git(clone, "commit", "-q", "-m", "local only");
    writeFileSync(join(seed, "remote.txt"), "r\n");
    git(seed, "add", "remote.txt");
    git(seed, "commit", "-q", "-m", "remote only");
    git(seed, "push", "-q", "origin", "main");
    expect(() => syncBaseBranch(clone, "origin", "main")).toThrow(/cannot be fast-forwarded/);
  });

  it("refuses without the named remote", () => {
    const { clone } = repoWithOrigin();
    expect(() => syncBaseBranch(clone, "upstream", "main")).toThrow(/no remote named "upstream"/);
  });
});

describe("runSetupCommand", () => {
  it("runs in the work repo and resolves on exit 0", async () => {
    await runSetupCommand(dir, "pwd > marker.txt && echo ok >> marker.txt");
    expect(readFileSync(join(dir, "marker.txt"), "utf-8")).toContain("ok");
  });

  it("rejects on a non-zero exit with the command in the message", async () => {
    await expect(runSetupCommand(dir, "exit 3")).rejects.toThrow(/setup_command failed \(exit 3\).*exit 3/s);
  });
});

describe("validateRunPrepConfig", () => {
  it("accepts the documented shapes", () => {
    expect(validateRunPrepConfig({
      source_control: { strategy: "remote_pr", sync_base_branch: true },
      setup_command: "pnpm install --frozen-lockfile",
      dashboard: { port: 3141, lan: true },
      backends: { worker: { type: "claude-code", auth: "subscription" }, reviewer: { type: "claude-code" } },
    })).toEqual([]);
    expect(validateRunPrepConfig({})).toEqual([]);
  });

  it("names every bad key", () => {
    const errors = validateRunPrepConfig({
      source_control: { strategy: "remote_pr", sync_base_branch: "yes" },
      setup_command: "",
      dashboard: { port: 70000, lan: "on" },
      backends: { worker: { type: "claude-code", auth: "max" } },
    });
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).toMatch(/sync_base_branch/);
    expect(errors.join("\n")).toMatch(/setup_command/);
    expect(errors.join("\n")).toMatch(/dashboard\.port/);
    expect(errors.join("\n")).toMatch(/dashboard\.lan/);
    expect(errors.join("\n")).toMatch(/backends\.worker\.auth/);
  });

  it("rejects a dashboard that is not an object", () => {
    expect(validateRunPrepConfig({ dashboard: 3141 })).toEqual([`dashboard must be an object: { "port": 3141, "lan": false }`]);
  });
});
