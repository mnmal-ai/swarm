/**
 * The `codex exec` command line for a swarm session: isolation flags,
 * swarm's hooks and context, the model, MCP servers, and the skills it
 * switches off.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs, discoverSkillFiles, gitWritableDirs, skillRoots, tomlString } from "../src/codex-args.js";

const BASE = {
  cwd: "/work",
  developerInstructions: "ctx",
  hookCommands: { sessionStart: "swarm codex-hook session-start", preToolUse: "swarm codex-hook pre-tool-use || printf x" },
  skillFiles: [],
  lastMessageFile: "/s/last.txt",
};
const settings = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

describe("buildCodexArgs", () => {
  it("isolates the session from the operator's setup", () => {
    const args = buildCodexArgs({ ...BASE, gitDirs: ["/repo/.git", "/repo/.git/worktrees/t1"] });
    expect(args.slice(0, 5)).toEqual(["exec", "--json", "--ephemeral", "--ignore-user-config", "--dangerously-bypass-hook-trust"]);
    expect(args).toEqual(expect.arrayContaining(["-C", "/work", "-s", "workspace-write", "-o", "/s/last.txt"]));
    expect(args.join(" ")).toContain("--add-dir /repo/.git --add-dir /repo/.git/worktrees/t1");
    for (const f of ["memories", "plugins", "apps", "image_generation", "multi_agent"]) expect(args.join(" ")).toContain(`--disable ${f}`);
    expect(settings(args)).toEqual(
      expect.arrayContaining([
        'approval_policy="never"',
        "sandbox_workspace_write.network_access=true",
        'web_search="disabled"',
        'hooks.SessionStart=[{hooks=[{type="command",command="swarm codex-hook session-start",timeout=60}]}]',
        'hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="swarm codex-hook pre-tool-use || printf x",timeout=60}]}]',
        'developer_instructions="ctx"',
        "skills.config=[]",
      ]),
    );
    expect(args.join(" ")).not.toContain("PostToolUse");
    expect(args.at(-1)).toBe("-");
  });

  it("skips the git check outside a repository, and names the model only when set", () => {
    const args = buildCodexArgs(BASE);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("-m");
    expect(buildCodexArgs({ ...BASE, model: "some-model" })).toEqual(expect.arrayContaining(["-m", "some-model"]));
  });

  it("switches off every skill it is given", () => {
    expect(settings(buildCodexArgs({ ...BASE, skillFiles: ["/h/.agents/skills/a/SKILL.md", "/h/.agents/skills/b/SKILL.md"] }))).toContain(
      'skills.config=[{path="/h/.agents/skills/a/SKILL.md",enabled=false},{path="/h/.agents/skills/b/SKILL.md",enabled=false}]',
    );
  });

  it("passes MCP servers, and refuses an unsafe name", () => {
    const s = settings(buildCodexArgs({ ...BASE, mcpServers: { docs: { type: "stdio", command: "docs-mcp", args: ["--x"], env: { K: "v" } } } }));
    expect(s).toEqual(expect.arrayContaining(['mcp_servers.docs.command="docs-mcp"', 'mcp_servers.docs.args=["--x"]', 'mcp_servers.docs.env={"K"="v"}']));
    expect(() => buildCodexArgs({ ...BASE, mcpServers: { "a.b": { type: "stdio", command: "x" } } })).toThrow(/a\.b/);
  });
});

describe("tomlString", () => {
  it("escapes what TOML needs escaped", () => {
    expect(tomlString('a "q" \\ b\nc\td')).toBe('"a \\"q\\" \\\\ b\\nc\\td"');
    expect(tomlString("bell\u0007")).toBe('"bell\\u0007"');
    expect(tomlString("del\u007f")).toBe('"del\\u007f"');
    expect(tomlString("lone\ud800x")).toBe('"lone�x"');
    expect(tomlString("emoji \u{1F600}")).toBe('"emoji \u{1F600}"');
  });
});

describe("skills", () => {
  it("finds SKILL.md files under each root", () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-skills-"));
    mkdirSync(join(home, ".agents/skills/one"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/one/SKILL.md"), "x");
    mkdirSync(join(home, ".codex/skills/.system/two"), { recursive: true });
    writeFileSync(join(home, ".codex/skills/.system/two/SKILL.md"), "x");
    mkdirSync(join(home, ".agents/skills/not-a-skill"), { recursive: true });
    const files = discoverSkillFiles(skillRoots({ HOME: home }, "/nowhere"));
    expect(files).toEqual([join(home, ".agents/skills/one/SKILL.md"), join(home, ".codex/skills/.system/two/SKILL.md")]);
    expect(skillRoots({ HOME: home, CODEX_HOME: "/ch" }, "/w")).toEqual(expect.arrayContaining(["/ch/skills", "/ch/skills/.system", "/w/.agents/skills"]));
  });
});

describe("gitWritableDirs", () => {
  it("is what a commit writes, never .git itself, its hooks or its config", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "swarm-gcd-")));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x");
    git("worktree", "add", "-q", join(repo, "wt"));
    const shared = ["objects", "refs", "logs"].map((d) => join(repo, ".git", d));
    expect(gitWritableDirs(join(repo, "wt"))).toEqual([...shared, join(repo, ".git", "worktrees", "wt")]);
    expect(gitWritableDirs(repo)).toEqual(shared);
    for (const dirs of [gitWritableDirs(repo), gitWritableDirs(join(repo, "wt"))]) {
      expect(dirs).not.toContain(join(repo, ".git"));
      expect(dirs.some((d) => d.endsWith("/hooks") || d.endsWith("/config"))).toBe(false);
    }
    expect(gitWritableDirs(realpathSync(mkdtempSync(join(tmpdir(), "swarm-norepo-"))))).toEqual([]);
  });
});
