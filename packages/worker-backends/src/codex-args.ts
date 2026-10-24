/**
 * The `codex exec` command line for one swarm session: isolation from the
 * operator's own Codex setup (config, sessions, memories, plugins, apps,
 * skills, web search, sub-agents), swarm's hooks, swarm's context as
 * developer instructions, the model, and MCP servers. Settings are `-c`
 * TOML values, so strings go through tomlString.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServerEntry } from "@mnmal-ai/swarm-types";

export interface CodexArgsOptions {
  cwd: string;
  /** The repository's git directories the agent must write to commit (gitWritableDirs); empty outside a repository. */
  gitDirs?: string[];
  model?: string;
  developerInstructions: string;
  /** The /bin/sh commands Codex runs for each hook (codexHookCommands). */
  hookCommands: { sessionStart: string; preToolUse: string };
  skillFiles: string[];
  mcpServers?: Record<string, McpServerEntry>;
  lastMessageFile: string;
}

/** Codex features a swarm session never uses. */
export const DISABLED_FEATURES = ["memories", "plugins", "apps", "image_generation", "multi_agent"] as const;

/** Seconds Codex gives one hook call; the self-test and the hook are much quicker. */
const HOOK_TIMEOUT_SECONDS = 60;

const MCP_NAME = /^[A-Za-z0-9_-]+$/;

/** A TOML basic string. JSON's escapes are TOML's, except DEL and lone surrogates. */
export function tomlString(s: string): string {
  const wellFormed = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  return JSON.stringify(wellFormed).replace(/\u007f/g, "\\u007f");
}

export function buildCodexArgs(o: CodexArgsOptions): string[] {
  const hook = (command: string, matchAll: boolean) =>
    `[{${matchAll ? 'matcher="*",' : ""}hooks=[{type="command",command=${tomlString(command)},timeout=${HOOK_TIMEOUT_SECONDS}}]}]`;
  return [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--dangerously-bypass-hook-trust",
    "-C", o.cwd,
    "-s", "workspace-write",
    "-c", 'approval_policy="never"',
    // Tests talk to databases and servers on 127.0.0.1, which the sandbox blocks otherwise.
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", 'web_search="disabled"',
    // The sandbox keeps .git read-only; a commit writes to the repository's
    // shared .git and, in a worktree, to the worktree's own git directory.
    ...(o.gitDirs && o.gitDirs.length > 0 ? o.gitDirs.flatMap((d) => ["--add-dir", d]) : ["--skip-git-repo-check"]),
    ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    "-c", `skills.config=[${o.skillFiles.map((p) => `{path=${tomlString(p)},enabled=false}`).join(",")}]`,
    "-c", `hooks.SessionStart=${hook(o.hookCommands.sessionStart, false)}`,
    "-c", `hooks.PreToolUse=${hook(o.hookCommands.preToolUse, true)}`,
    "-c", `developer_instructions=${tomlString(o.developerInstructions)}`,
    ...(o.model ? ["-m", o.model] : []),
    ...mcpArgs(o.mcpServers),
    "-o", o.lastMessageFile,
    "-",
  ];
}

function mcpArgs(servers: Record<string, McpServerEntry> | undefined): string[] {
  const out: string[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!MCP_NAME.test(name)) throw new Error(`MCP server name "${name}" must match [A-Za-z0-9_-]`);
    out.push("-c", `mcp_servers.${name}.command=${tomlString(server.command)}`);
    if (server.args && server.args.length > 0) out.push("-c", `mcp_servers.${name}.args=[${server.args.map(tomlString).join(",")}]`);
    if (server.env && Object.keys(server.env).length > 0) {
      out.push("-c", `mcp_servers.${name}.env={${Object.entries(server.env).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(",")}}`);
    }
  }
  return out;
}

/** Where Codex finds skills: the operator's, Codex's own, and the project's. */
export function skillRoots(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const home = env.HOME ?? "";
  const codexHome = env.CODEX_HOME || (home ? join(home, ".codex") : "");
  return [
    home ? join(home, ".agents", "skills") : "",
    codexHome ? join(codexHome, "skills") : "",
    codexHome ? join(codexHome, "skills", ".system") : "",
    join(cwd, ".agents", "skills"),
    join(cwd, ".codex", "skills"),
  ].filter((r) => r !== "");
}

/** Every `<root>/<name>/SKILL.md`, in a stable order. */
export function discoverSkillFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(root, name, "SKILL.md");
      if (existsSync(file)) files.push(file);
    }
  }
  return [...new Set(files)];
}

/** The repository's shared .git directory and this checkout's own git directory, or null outside a repository. */
export function gitDirectories(cwd: string): { common: string; gitDir: string } | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [common, gitDir] = out.split("\n").map((l) => l.trim());
    return common && gitDir ? { common, gitDir } : null;
  } catch {
    return null;
  }
}

/**
 * The git directories a session may write so its own commits work, and no
 * more: the shared objects, refs and logs, and in a worktree the worktree's
 * own directory under .git/worktrees (which holds no hooks or config).
 * `.git/hooks` and `.git/config` stay read-only: swarm's own git commands run
 * outside the sandbox, and would run a hook the agent planted. In a plain
 * checkout the index and HEAD sit beside them, so the agent cannot commit
 * there and swarm commits its changes afterwards. Empty outside a repository.
 */
export function gitWritableDirs(cwd: string): string[] {
  const dirs = gitDirectories(cwd);
  if (!dirs) return [];
  const shared = ["objects", "refs", "logs"].map((d) => join(dirs.common, d)).filter((d) => existsSync(d));
  return dirs.gitDir !== dirs.common ? [...shared, dirs.gitDir] : shared;
}
