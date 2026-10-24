/**
 * CLI wiring for source_control.git_identity / source_control.commit_style:
 * startup validation, the decomposition prompt's title guidance, and the
 * initial commit swarm makes in a repo with no commits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "@mnmal-ai/swarm-types";
import {
  assertValidSourceControlConfig,
  decompositionTitleGuidance,
  ensureGitReady,
} from "../src/cli/run.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

describe("assertValidSourceControlConfig", () => {
  const configPath = "/swarm/domains/project-a/config.json";

  it("passes a config with no source_control, and a valid one", () => {
    expect(() => assertValidSourceControlConfig({} as ProjectConfig, configPath)).not.toThrow();
    expect(() =>
      assertValidSourceControlConfig(
        {
          source_control: {
            strategy: "remote_pr",
            git_identity: { name: "example-user", email: "example-user@example.invalid" },
            commit_style: "conventional",
          },
        } as ProjectConfig,
        configPath,
      ),
    ).not.toThrow();
  });

  it("throws one clear error naming the file and every bad key", () => {
    const bad = {
      source_control: {
        strategy: "remote_pr",
        git_identity: { name: "example-user", email: "example-user" },
        commit_style: "semantic",
      },
    } as unknown as ProjectConfig;

    expect(() => assertValidSourceControlConfig(bad, configPath)).toThrow(configPath);
    expect(() => assertValidSourceControlConfig(bad, configPath)).toThrow(/source_control\.git_identity\.email/);
    expect(() => assertValidSourceControlConfig(bad, configPath)).toThrow(/source_control\.commit_style/);
  });

  it("refuses at startup a config that expects workers to open stacked PRs", () => {
    for (const source_control of [{ strategy: "local_branch", stack_prs: true }, { stack_prs: true }]) {
      const config = { source_control } as unknown as ProjectConfig;
      expect(() => assertValidSourceControlConfig(config, configPath)).toThrow(configPath);
      expect(() => assertValidSourceControlConfig(config, configPath)).toThrow(
        /workers no longer have GitHub access, so they cannot open pull requests\. Set source_control\.strategy to "remote_pr"/,
      );
    }
    expect(() =>
      assertValidSourceControlConfig({ source_control: { strategy: "remote_pr", stack_prs: true } } as ProjectConfig, configPath),
    ).not.toThrow();
  });
});

describe("decompositionTitleGuidance", () => {
  it("swarm style keeps today's instruction and examples", () => {
    const g = decompositionTitleGuidance("swarm");
    expect(g.instruction).toBe(
      `For each task, provide a short "title" (under 60 chars, like a commit subject) and a longer "description" that explains what to do.`,
    );
    expect(g.exampleTitles).toEqual(["Short task title", "Another task title"]);
    expect(decompositionTitleGuidance(undefined)).toEqual(g);
  });

  it("conventional style asks for Conventional Commit subjects", () => {
    const g = decompositionTitleGuidance("conventional");
    expect(g.instruction).toMatch(/Conventional Commit subject/);
    expect(g.instruction).toContain("type(scope): summary");
    expect(g.instruction).toMatch(/under 60 chars/);
    for (const t of g.exampleTitles) expect(t).toMatch(/^[a-z]+(\([^)]+\))?!?: \S/);
  });
});

describe("ensureGitReady — initial commit in an empty repo", () => {
  let dir: string;
  const IDENTITY = { name: "Example Bot", email: "bot@example.com" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-initial-commit-"));
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "Repo User"]);
    await git(dir, ["config", "user.email", "repo@example.com"]);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("is made as the configured identity, in the configured style", async () => {
    await ensureGitReady(dir, "main", false, { identity: IDENTITY, style: "conventional" });

    expect(await git(dir, ["log", "-1", "--format=%an|%ae|%cn|%ce"])).toBe(
      `${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`,
    );
    expect(await git(dir, ["log", "-1", "--format=%s"])).toBe("chore(swarm): initial commit");
  });

  it("is unchanged without commit settings", async () => {
    await ensureGitReady(dir, "main", false);

    expect(await git(dir, ["log", "-1", "--format=%an|%s"])).toBe("Repo User|initial commit (created by swarm)");
  });
});
