/**
 * The external-dependency manifest: what swarm relies on in tools it does not
 * ship (starting with gh), the major version it is tested with, and the
 * startup warning when the installed major differs. The command runner is
 * injected; gh never runs.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EXTERNAL_DEPENDENCIES,
  checkDependencyVersion,
  type CommandRunner,
  type ExternalDependency,
} from "../src/external-deps.js";

function runnerPrinting(stdout: string): CommandRunner {
  return vi.fn(async () => stdout);
}

function runnerFailing(error: Error & { code?: string; stderr?: string }): CommandRunner {
  return vi.fn(async () => { throw error; });
}

const GH_VERSION_OUTPUT = (v: string) => `gh version ${v} (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v${v}\n`;

describe("EXTERNAL_DEPENDENCIES", () => {
  it("declares gh, tested at major 2, with every behaviour swarm relies on", () => {
    const gh = EXTERNAL_DEPENDENCIES.gh;
    expect(gh.command).toBe("gh");
    expect(gh.versionArgs).toEqual(["--version"]);
    expect(gh.testedMajor).toBe(2);
    const relied = gh.reliesOn.join("\n");
    for (const behaviour of [
      "gh auth token --user <login>",
      "GH_TOKEN",
      "GH_CONFIG_DIR",
      "gh api",
      "gh pr create --title --body --base --head",
      "gh auth git-credential",
    ]) {
      expect(relied, behaviour).toContain(behaviour);
    }
  });

  it("declares fnl, tested at major 0, with the rewrite flags the worker hook relies on", async () => {
    const fnl = EXTERNAL_DEPENDENCIES.fnl;
    expect(fnl.command).toBe("fnl");
    expect(fnl.versionArgs).toEqual(["--version"]);
    expect(fnl.testedMajor).toBe(0);
    const relied = fnl.reliesOn.join("\n");
    for (const behaviour of ["fnl rewrite", "--deny", "--wrap", "--check-invokes-fnl", "fnl run"]) {
      expect(relied, behaviour).toContain(behaviour);
    }
    // `fnl --version` prints the bare version.
    expect((await checkDependencyVersion(fnl, runnerPrinting("0.2.0\n"))).installed).toBe("0.2.0");
    expect((await checkDependencyVersion(fnl, runnerPrinting("1.0.0\n"))).warning).toMatch(/fnl 1\.0\.0 is installed, but swarm is tested with fnl 0\.x/);
  });

  it("is data: every entry has the same shape, so adding a tool is one object", () => {
    for (const [key, dep] of Object.entries(EXTERNAL_DEPENDENCIES) as Array<[string, ExternalDependency]>) {
      expect(dep.name, key).toBeTruthy();
      expect(dep.command, key).toBeTruthy();
      expect(Array.isArray(dep.versionArgs), key).toBe(true);
      expect(dep.versionPattern, key).toBeInstanceOf(RegExp);
      expect(Number.isInteger(dep.testedMajor), key).toBe(true);
      expect(dep.reliesOn.length, key).toBeGreaterThan(0);
    }
  });
});

describe("checkDependencyVersion", () => {
  it("runs `gh --version` and is quiet when the installed major is the tested one", async () => {
    const run = runnerPrinting(GH_VERSION_OUTPUT("2.63.0"));
    const result = await checkDependencyVersion(EXTERNAL_DEPENDENCIES.gh, run);

    expect(run).toHaveBeenCalledWith("gh", ["--version"]);
    expect(result).toEqual({ name: "gh", installed: "2.63.0", testedMajor: 2 });
    expect(result.warning).toBeUndefined();
  });

  it("warns, naming both versions, when the installed major differs", async () => {
    const result = await checkDependencyVersion(EXTERNAL_DEPENDENCIES.gh, runnerPrinting(GH_VERSION_OUTPUT("3.1.0")));

    expect(result.installed).toBe("3.1.0");
    expect(result.warning).toMatch(/gh 3\.1\.0 is installed, but swarm is tested with gh 2\.x/);
    expect(result.warning).toMatch(/may be unpredictable/);
    // Names what to check.
    expect(result.warning).toContain("gh auth token --user <login>");
  });

  it("warns when an older major is installed too", async () => {
    const result = await checkDependencyVersion(EXTERNAL_DEPENDENCIES.gh, runnerPrinting(GH_VERSION_OUTPUT("1.14.0")));
    expect(result.warning).toMatch(/gh 1\.14\.0 is installed, but swarm is tested with gh 2\.x/);
  });

  it("warns when the tool is not installed", async () => {
    const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    const result = await checkDependencyVersion(EXTERNAL_DEPENDENCIES.gh, runnerFailing(missing));

    expect(result.installed).toBeNull();
    expect(result.warning).toMatch(/gh is not installed/);
  });

  it("warns when the version cannot be read", async () => {
    const result = await checkDependencyVersion(EXTERNAL_DEPENDENCIES.gh, runnerPrinting("something unexpected\n"));

    expect(result.installed).toBeNull();
    expect(result.warning).toMatch(/could not read gh's version from `gh --version`/);
    expect(result.warning).toMatch(/tested with gh 2\.x/);
  });

  it("works for any entry, e.g. a later one for git", async () => {
    const git: ExternalDependency = {
      name: "git",
      command: "git",
      versionArgs: ["--version"],
      versionPattern: /git version (\d+\.\d+(?:\.\d+)?)/,
      testedMajor: 2,
      reliesOn: ["git worktree add"],
    };
    const ok = await checkDependencyVersion(git, runnerPrinting("git version 2.47.1\n"));
    expect(ok.warning).toBeUndefined();
    const off = await checkDependencyVersion(git, runnerPrinting("git version 3.0.0\n"));
    expect(off.warning).toMatch(/git 3\.0\.0 is installed, but swarm is tested with git 2\.x/);
  });
});
