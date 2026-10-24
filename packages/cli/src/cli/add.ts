/**
 * swarm add — Add skills or MCP servers to your swarm.
 *
 * Usage:
 *   swarm add skill <name-or-path>     Add a skill file to .swarm/skills/
 *   swarm add mcp <name> <command>     Add an MCP server to config.json
 *
 * See question-tree.md for flow documentation.
 */

import { resolve, join, basename, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let p: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pc: any;

/** Lazy-init p and pc for code paths that may be called without runAdd(). */
async function ensurePrompts(): Promise<void> {
  if (!p) p = await import("@clack/prompts");
  if (!pc) pc = (await import("picocolors")).default;
}

/**
 * Write an MCP server entry into ALL three backend roles (worker, reviewer, arbiter)
 * in the project's config.json. Creates missing backend entries with type: "claude-code".
 *
 * Exported so tests can verify the three-role write behavior directly without
 * going through the interactive `addMcp` flow.
 */
export function writeMcpToAllBackends(
  configPath: string,
  mcpName: string,
  mcpCommand: string,
  mcpArgs: string[],
  env: Record<string, string> | undefined,
): void {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  if (!config.backends) config.backends = {};

  const mcpEntry: Record<string, unknown> = {
    type: "stdio",
    command: mcpCommand,
  };
  if (mcpArgs.length > 0) mcpEntry.args = mcpArgs;
  if (env && Object.keys(env).length > 0) mcpEntry.env = env;

  for (const role of ["worker", "reviewer", "arbiter"] as const) {
    if (!config.backends[role]) config.backends[role] = { type: "claude-code" };
    if (!config.backends[role].mcpServers) config.backends[role].mcpServers = {};
    config.backends[role].mcpServers[mcpName] = mcpEntry;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Skill slug resolution (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Resolve the installed directory name for a skill package.
 *
 * `npx skills add` names the directory after the skill's `name` field in
 * SKILL.md, which may differ from the GitHub repo name in the URL.
 * For example, `twostraws/SwiftUI-Agent-Skill` installs to `swiftui-pro/`.
 *
 * Multi-skill repos use `@skill-name` syntax (e.g., `owner/repo@skill`).
 * The lock file stores `source: "owner/repo"` without the `@skill-name`
 * suffix, so we match both exact and base-repo forms.
 *
 * This function reads `skills-lock.json` to find the actual directory name,
 * falling back to the repo name from the URL if the lock file is missing.
 */
export function resolveSkillSlug(pkg: string, cwd: string): string {
  const fallback = pkg.split("/").pop() ?? pkg;
  const lockPath = join(cwd, "skills-lock.json");
  if (!existsSync(lockPath)) return fallback;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    // Extract the base repo (before @) and the skill name (after @)
    const atIdx = pkg.indexOf("@", pkg.indexOf("/") + 1);
    const baseRepo = atIdx > 0 ? pkg.slice(0, atIdx) : pkg;
    const skillSuffix = atIdx > 0 ? pkg.slice(atIdx + 1) : null;

    const entry = Object.entries(lock.skills ?? {}).find(
      ([key, v]) => {
        const source = (v as Record<string, unknown>).source as string;
        // Exact match: source === full pkg string
        if (source === pkg) return true;
        // Multi-skill repo: source matches base repo AND key matches skill suffix
        if (skillSuffix && source === baseRepo && key === skillSuffix) return true;
        return false;
      },
    );
    return entry ? entry[0] : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Reference file fetching
// ---------------------------------------------------------------------------

/**
 * Scan a SKILL.md's content for references to `references/*.md` files and
 * fetch each one from the same GitHub repo, writing them alongside the skill.
 */
/**
 * Resolve the default branch for a GitHub repo via the API.
 * Returns "main" on failure — GitHub raw URLs with a nonexistent branch
 * will just 404 and the reference fetch will skip silently.
 */
async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (resp.ok) {
      const data = await resp.json() as { default_branch?: string };
      if (typeof data.default_branch === "string" && data.default_branch.length > 0) {
        return data.default_branch;
      }
    }
  } catch {
    // Non-fatal — fall through to default
  }
  return "main";
}

/**
 * Find where SKILL.md lives inside the upstream repo by walking its git tree.
 * `npx skills add` flattens the install (copies skill contents to
 * `.agents/skills/<slug>/SKILL.md` regardless of where it was in the source),
 * so the local layout doesn't tell us the baseDir for references/*.md fetches.
 *
 * Returns the best guess at the SKILL.md path in the repo (e.g.
 * "swift-testing-expert/SKILL.md"). When the repo has multiple SKILL.md files
 * and `preferredSubdir` matches one of them, that's chosen; otherwise the first
 * match wins. Falls back to "SKILL.md" if the API call fails.
 */
/**
 * Fetch every SKILL.md path in an upstream repo's git tree. Separated from
 * the path-picking logic so callers with multiple candidates (multi-skill
 * repos) can fetch once and pick many times instead of hitting the API per
 * candidate.
 *
 * Returns null on API failure so the caller can fall back gracefully.
 */
export async function fetchRepoSkillPaths(
  owner: string,
  repo: string,
  branch: string,
): Promise<string[] | null> {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      if ((resp.status === 403 || resp.status === 429) && !token) {
        await ensurePrompts();
        p.log.warn(
          `GitHub API rate-limited while locating SKILL.md in ${owner}/${repo}. ` +
          `Set GITHUB_TOKEN to avoid this. References may be incomplete.`,
        );
      }
      return null;
    }
    const data = await resp.json() as { tree?: Array<{ path?: string; type?: string }> };
    return (data.tree ?? [])
      .filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.endsWith("SKILL.md"))
      .map((e) => e.path as string);
  } catch {
    return null;
  }
}

/**
 * Pure function: pick the best SKILL.md path for a given preferred subdirectory.
 * Extracted so multi-skill repos can reuse a single fetchRepoSkillPaths result.
 */
export function pickSkillPath(skillPaths: string[] | null, preferredSubdir?: string): string {
  if (!skillPaths || skillPaths.length === 0) return "SKILL.md";
  if (preferredSubdir) {
    const preferred = skillPaths.find((sp) => sp.startsWith(`${preferredSubdir}/`));
    if (preferred) return preferred;
  }
  // Prefer the shallowest path (root SKILL.md > nested)
  const sorted = [...skillPaths].sort((a, b) => a.split("/").length - b.split("/").length);
  return sorted[0];
}

/**
 * Convenience wrapper — fetch and pick in one call. Suitable for
 * single-skill installs. Multi-skill installs should call
 * fetchRepoSkillPaths once and pickSkillPath per candidate.
 */
export async function findSkillPathInRepo(
  owner: string,
  repo: string,
  branch: string,
  preferredSubdir?: string,
): Promise<string> {
  const paths = await fetchRepoSkillPaths(owner, repo, branch);
  return pickSkillPath(paths, preferredSubdir);
}

export async function fetchReferencesFromSkill(
  skillContent: string,
  skillDestDir: string,
  owner: string,
  repo: string,
  branch: string,
  skillPathInRepo: string,
): Promise<void> {
  await ensurePrompts();
  // Match patterns like `references/something.md` (with or without backticks)
  const refPattern = /references\/[a-zA-Z0-9_-]+\.md/g;
  const matches = [...new Set(skillContent.match(refPattern) ?? [])];

  if (matches.length === 0) return;

  const refsDir = join(skillDestDir, "references");
  mkdirSync(refsDir, { recursive: true });

  // Compute the base directory of the SKILL.md in the repo
  const skillDirInRepo = skillPathInRepo ? dirname(skillPathInRepo) : "";
  const baseDir = skillDirInRepo && skillDirInRepo !== "." ? `${skillDirInRepo}/` : "";

  // Try the given branch first, then fall back to the repo's default branch
  // if different, so skills on master/develop/etc. still work.
  const branchesToTry = [branch];
  const defaultBranch = await resolveDefaultBranch(owner, repo);
  if (defaultBranch !== branch) branchesToTry.push(defaultBranch);

  for (const ref of matches) {
    let fetched = false;
    for (const br of branchesToTry) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${br}/${baseDir}${ref}`;
      try {
        const resp = await fetch(rawUrl);
        if (resp.ok) {
          const refContent = await resp.text();
          const refDest = join(refsDir, basename(ref));
          writeFileSync(refDest, refContent);
          p.log.success(`  Reference fetched: ${pc.dim(ref)}`);
          fetched = true;
          break;
        }
      } catch {
        // Non-fatal — try next branch
      }
    }
    if (!fetched) {
      p.log.warn(`  Reference not found: ${pc.dim(ref)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Substrate ingest helper
// ---------------------------------------------------------------------------

/**
 * Ingest a skill file into Substrate as a SwarmContent entity.
 * Non-fatal — logs a warning if Substrate is unavailable.
 */
export async function ingestSkillToSubstrate(
  substrateClient: SubstrateClient | undefined,
  relativePath: string,
  skillContent: string,
): Promise<void> {
  if (!substrateClient) return;
  try {
    await substrateClient.ingest("SwarmContent", [{
      path: relativePath,
      tier: "skills_vetted",
      intent: "all",
      content: skillContent,
      tokenEstimate: Math.ceil(skillContent.length / 4),
      lastReviewed: new Date().toISOString(),
      projectId: "global",
    }], "extend");
  } catch {
    // Non-fatal — Substrate may not be running
  }
}

// ---------------------------------------------------------------------------
// swarm add skill
// ---------------------------------------------------------------------------

async function addSkill(args: Record<string, string>, positional: string[], substrateClient?: SubstrateClient): Promise<void> {
  // Resolve symlinks so skills are written to the real swarm, not the symlink path
  let swarmDir = resolve(process.cwd(), args["dir"] ?? ".swarm");
  try { swarmDir = realpathSync(swarmDir); } catch { /* not a symlink or doesn't exist yet */ }

  if (!existsSync(swarmDir)) {
    console.error("No .swarm/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  const source = positional[0];

  if (!source) {
    // Interactive mode — ask what to do
    const action = await p.select({
      message: "How would you like to add a skill?",
      options: [
        { value: "browse", label: "Browse available skills", hint: "search skills.sh or npx skills find" },
        { value: "github", label: "From a GitHub repo", hint: "e.g., author/repo-name" },
        { value: "file", label: "From a local file", hint: "copy a .md skill file into .swarm/skills/" },
        { value: "create", label: "Create a new skill from scratch" },
      ],
    });

    if (p.isCancel(action)) { p.cancel("Aborted."); process.exit(0); }

    if (action === "browse") {
      p.log.message(`${pc.bold("Find skills at:")}

  ${pc.cyan("https://skills.sh")}          Browse and search the skills directory
  ${pc.cyan("npx skills find")}            Interactive search from your terminal
  ${pc.cyan("npx skills find react")}      Search for a specific topic

${pc.dim("Once you find a skill, install it with:")}
  ${pc.cyan("swarm add skill author/repo-name")}
  ${pc.dim("or")}
  ${pc.cyan("npx skills add author/repo-name")}`);

      const pkg = await p.text({
        message: "Paste a skill package name to install (or press Enter to skip):",
        placeholder: "e.g., vercel-labs/agent-skills",
      });
      if (!p.isCancel(pkg) && (pkg as string).trim()) {
        await installSkillFromRegistry(swarmDir, (pkg as string).trim(), substrateClient);
      }
    } else if (action === "github") {
      p.log.message(`${pc.dim("Skills are Git repos containing SKILL.md files. Examples:")}
  ${pc.cyan("vercel-labs/agent-skills")}     Vercel's official skills collection
  ${pc.cyan("AvdLee/SwiftUI-Agent-Skill")}   SwiftUI patterns by Antoine van der Lee

${pc.dim("Use the GitHub short form (author/repo) or a full URL.")}`);

      const pkg = await p.text({
        message: "GitHub repo (author/name):",
        placeholder: "e.g., vercel-labs/agent-skills",
      });
      if (p.isCancel(pkg)) { p.cancel("Aborted."); process.exit(0); }
      await installSkillFromRegistry(swarmDir, (pkg as string).trim(), substrateClient);
    } else if (action === "file") {
      const filePath = await p.text({
        message: "Path to the skill file:",
        placeholder: "e.g., ~/my-skills/express-patterns.md",
      });
      if (p.isCancel(filePath)) { p.cancel("Aborted."); process.exit(0); }
      await copySkillFile(swarmDir, (filePath as string).trim());
    } else {
      await createNewSkill(swarmDir);
    }
    return;
  }

  // Non-interactive: source is a file path or package name
  if (existsSync(resolve(source))) {
    await copySkillFile(swarmDir, source);
  } else if (source.includes("/")) {
    await installSkillFromRegistry(swarmDir, source, substrateClient);
  } else {
    console.error(`Cannot find "${source}". Provide a file path or a package name (author/name).`);
    process.exit(1);
  }
}

async function copySkillFile(swarmDir: string, filePath: string): Promise<void> {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const tier = await p.select({
    message: "Which tier should this skill be in?",
    options: [
      { value: "core", label: "Core", hint: "team-authored, always loaded if route specifies" },
      { value: "vetted", label: "Vetted", hint: "reviewed third-party, loaded by default" },
      { value: "community", label: "Community", hint: "reference only, not auto-loaded" },
    ],
  });

  if (p.isCancel(tier)) { p.cancel("Aborted."); process.exit(0); }

  const destDir = join(swarmDir, "skills", tier as string);
  mkdirSync(destDir, { recursive: true });

  const destFile = join(destDir, basename(resolved));
  copyFileSync(resolved, destFile);
  p.log.success(`Skill added: ${pc.cyan(`skills/${tier}/${basename(resolved)}`)}`);
}

async function installSkillFromRegistry(swarmDir: string, pkg: string, substrateClient?: SubstrateClient): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");

  // Validate package name to prevent injection (allow alphanumeric, @, /, ., -, _)
  if (!/^[a-zA-Z0-9@._\/-]+$/.test(pkg)) {
    p.log.error(`Invalid package name: ${pkg}`);
    return;
  }

  const vetDir = join(swarmDir, "skills", "vetted");
  mkdirSync(vetDir, { recursive: true });

  p.log.info(`Installing ${pc.cyan(pkg)} via npx skills add...`);

  try {
    execFileSync("npx", ["skills", "add", pkg, "--copy", "-y"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
  } catch {
    p.log.warn(`npx skills add failed. Make sure the 'skills' package is available.`);
    p.log.info(`You can install it manually: ${pc.cyan(`npx skills add ${pkg}`)}`);
    return;
  }

  // npx skills add installs to .agents/skills/<slug>/ (Vercel convention).
  // Swarm expects skills in .swarm/skills/vetted/. Move them there.
  const slug = resolveSkillSlug(pkg, process.cwd());
  const agentsSkillDir = join(process.cwd(), ".agents", "skills", slug);

  if (!existsSync(agentsSkillDir)) {
    p.log.success(`Skill installed from ${pc.cyan(pkg)}`);
    p.log.info(`Could not locate .agents/skills/${slug}/ — if files were installed, copy SKILL.md to ${pc.cyan(vetDir)}`);
    return;
  }

  // Find all SKILL.md files under the installed directory (root + one level deep).
  // pathInRepo tracks where this SKILL.md lives in the source GitHub repo,
  // which is needed to resolve references/*.md paths relative to it.
  const candidates: { src: string; destName: string; pathInRepo: string }[] = [];

  const rootSkill = join(agentsSkillDir, "SKILL.md");
  if (existsSync(rootSkill)) {
    candidates.push({ src: rootSkill, destName: slug, pathInRepo: "SKILL.md" });
  }

  // Check subdirectories for additional SKILL.md files (multi-skill repos).
  // `npx skills add` preserves the source layout, so entry.name matches
  // the subdirectory name in the upstream repo.
  try {
    for (const entry of readdirSync(agentsSkillDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sub = join(agentsSkillDir, entry.name, "SKILL.md");
        if (existsSync(sub)) {
          candidates.push({ src: sub, destName: entry.name, pathInRepo: `${entry.name}/SKILL.md` });
        }
      }
    }
  } catch {
    // ignore read errors
  }

  if (candidates.length === 0) {
    p.log.success(`Skill installed from ${pc.cyan(pkg)}`);
    p.log.info(`No SKILL.md found in .agents/skills/${slug}/ — copy files manually to ${pc.cyan(vetDir)}`);
    return;
  }

  // Hoist repo-wide lookups out of the candidate loop — owner, repo, branch,
  // and the tree of SKILL.md paths are all the same across candidates from
  // the same package. For a multi-skill repo this avoids N×2 API calls.
  const parts = pkg.replace(/@.*$/, "").split("/");
  const hasGitHubRepo = parts.length >= 2;
  const owner = hasGitHubRepo ? parts[0] : "";
  const repo = hasGitHubRepo ? parts[1] : "";
  const branch = hasGitHubRepo ? await resolveDefaultBranch(owner, repo) : "main";
  // Use the repo's default branch — hardcoded "main" breaks skills hosted
  // on master/develop/etc. fetchRepoSkillPaths is called once; each
  // candidate's path is picked from the cached result.
  const repoSkillPaths = hasGitHubRepo
    ? await fetchRepoSkillPaths(owner, repo, branch)
    : null;

  for (const { src, destName, pathInRepo } of candidates) {
    const safeName = destName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const dest = join(vetDir, `${safeName}.md`);
    copyFileSync(src, dest);
    p.log.success(`Skill added to swarm: ${pc.cyan(`skills/vetted/${safeName}.md`)}`);

    const skillContent = readFileSync(dest, "utf-8");
    if (hasGitHubRepo) {
      // pathInRepo from candidate detection is our hint (the subdirectory
      // name that was flattened in .agents/skills/<slug>/). If the repo
      // contains a SKILL.md at that subdirectory, use it.
      const preferredSubdir = pathInRepo.includes("/") ? pathInRepo.split("/")[0] : destName;
      const resolvedPath = pickSkillPath(repoSkillPaths, preferredSubdir);
      await fetchReferencesFromSkill(skillContent, vetDir, owner, repo, branch, resolvedPath);
    }

    // Ingest into Substrate
    const relativePath = `skills/vetted/${safeName}.md`;
    await ingestSkillToSubstrate(substrateClient, relativePath, skillContent);
  }
}

async function createNewSkill(swarmDir: string): Promise<void> {
  const name = await p.text({
    message: "Skill name:",
    placeholder: "e.g., express-patterns, react-conventions",
  });
  if (p.isCancel(name)) { p.cancel("Aborted."); process.exit(0); }

  const description = await p.text({
    message: "One-line description:",
    placeholder: "e.g., Express route and middleware patterns for this project",
  });
  if (p.isCancel(description)) { p.cancel("Aborted."); process.exit(0); }

  const skillName = (name as string).trim().toLowerCase().replace(/\s+/g, "-");
  const skillDesc = (description as string).trim();

  const content = `# ${skillName}

<!-- ${skillDesc} -->
<!-- Add your skill content below. This file will be loaded by swarm's router
     when the route specifies it. Keep it concise and actionable. -->

## Patterns

<!-- Add copy-paste code templates, conventions, or domain knowledge here. -->

## Rules

<!-- Add hard constraints specific to this skill. -->
`;

  const destDir = join(swarmDir, "skills", "core");
  mkdirSync(destDir, { recursive: true });

  const destFile = join(destDir, `${skillName}.md`);
  writeFileSync(destFile, content);
  p.log.success(`Skill created: ${pc.cyan(`skills/core/${skillName}.md`)}`);
  p.log.info(`Edit the file to add your skill content.`);
}

// ---------------------------------------------------------------------------
// swarm add mcp
// ---------------------------------------------------------------------------

async function addMcp(args: Record<string, string>, positional: string[], substrateClient?: SubstrateClient): Promise<void> {
  let swarmDir = resolve(process.cwd(), args["dir"] ?? ".swarm");
  try { swarmDir = realpathSync(swarmDir); } catch { /* not a symlink or doesn't exist yet */ }

  if (!existsSync(swarmDir)) {
    console.error("No .swarm/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  // Find config.json — look in domains/*/config.json
  const domainsDir = join(swarmDir, "domains");
  let configPath: string | null = null;

  if (existsSync(domainsDir)) {
    const { readdirSync } = await import("node:fs");
    const projects = readdirSync(domainsDir).filter((d) => {
      const fullPath = join(domainsDir, d, "config.json");
      return existsSync(fullPath);
    });

    if (projects.length === 1) {
      configPath = join(domainsDir, projects[0], "config.json");
    } else if (projects.length > 1) {
      const choice = await p.select({
        message: "Multiple projects found. Which one?",
        options: projects.map((proj) => ({ value: proj, label: proj })),
      });
      if (p.isCancel(choice)) { p.cancel("Aborted."); process.exit(0); }
      configPath = join(domainsDir, choice as string, "config.json");
    }
  }

  if (!configPath) {
    console.error("No config.json found in .swarm/domains/. Run 'swarm init' first.");
    process.exit(1);
  }

  // Popular MCP servers — name, command, description, env vars needed
  interface PopularMcp {
    name: string;
    command: string;
    args: string[];
    hint: string;
    repo: string;
    env: Record<string, string>;
  }

  const POPULAR_MCPS: PopularMcp[] = [
    { name: "postgres", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], hint: "Query and manage PostgreSQL databases", repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres", env: { POSTGRES_URL: "$DATABASE_URL" } },
    { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], hint: "Read/write access to local files", repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem", env: {} },
    { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], hint: "GitHub repos, issues, PRs", repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN" } },
    { name: "slack", command: "npx", args: ["-y", "@anthropic/mcp-server-slack"], hint: "Read/search Slack channels and messages", repo: "https://github.com/anthropics/anthropic-mcp-servers", env: { SLACK_BOT_TOKEN: "$SLACK_BOT_TOKEN" } },
    { name: "memory", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], hint: "Persistent memory via knowledge graph", repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory", env: {} },
    { name: "puppeteer", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"], hint: "Browser automation and web scraping", repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer", env: {} },
    { name: "xcodebuild", command: "npx", args: ["-y", "xcodebuildmcp@latest", "mcp"], hint: "Build, test, and manage Xcode projects", repo: "https://github.com/getsentry/XcodeBuildMCP", env: {} },
  ];

  // Get MCP server details
  let mcpName = positional[0];
  let mcpCommand = positional[1];
  let mcpArgs: string[] = [];
  let env: Record<string, string> | undefined;

  if (!mcpName) {
    // Show popular MCPs + custom option
    const choice = await p.select({
      message: "Which MCP server do you want to add?",
      options: [
        ...POPULAR_MCPS.map((m) => ({
          value: m.name,
          label: m.name,
          hint: m.hint,
        })),
        { value: "__browse", label: "Browse the MCP directory", hint: "opens github.com/modelcontextprotocol/servers" },
        { value: "__custom", label: "Custom MCP server", hint: "enter name and command manually" },
      ],
    });

    if (p.isCancel(choice)) { p.cancel("Aborted."); process.exit(0); }

    if (choice === "__browse") {
      p.log.message(`${pc.bold("MCP Server Directory:")}

  ${pc.cyan("https://github.com/modelcontextprotocol/servers")}

  ${pc.dim("This repo lists official and community MCP servers with install instructions.")}
  ${pc.dim("Find the one you need, then run:")}
  ${pc.cyan("swarm add mcp <name> <command>")}

  ${pc.dim("Example:")}
  ${pc.cyan("swarm add mcp postgres 'npx -y @modelcontextprotocol/server-postgres'")}
`);

      const customName = await p.text({
        message: "MCP server name (or press Enter to cancel):",
        placeholder: "e.g., postgres, github, custom-server",
      });
      if (p.isCancel(customName) || !(customName as string).trim()) {
        p.outro(pc.dim("No MCP added."));
        return;
      }
      mcpName = (customName as string).trim();

      const customCmd = await p.text({
        message: "Command to start the MCP server:",
        placeholder: "e.g., npx -y @modelcontextprotocol/server-postgres",
      });
      if (p.isCancel(customCmd)) { p.cancel("Aborted."); process.exit(0); }
      const parts = (customCmd as string).trim().split(/\s+/);
      mcpCommand = parts[0];
      mcpArgs = parts.slice(1);
    } else if (choice === "__custom") {
      const customName = await p.text({
        message: "MCP server name:",
        placeholder: "e.g., my-custom-mcp",
      });
      if (p.isCancel(customName)) { p.cancel("Aborted."); process.exit(0); }
      mcpName = (customName as string).trim();

      const customCmd = await p.text({
        message: "Command to start it:",
        placeholder: "e.g., npx -y @my-org/mcp-server, or /usr/local/bin/my-mcp",
      });
      if (p.isCancel(customCmd)) { p.cancel("Aborted."); process.exit(0); }
      const parts = (customCmd as string).trim().split(/\s+/);
      mcpCommand = parts[0];
      mcpArgs = parts.slice(1);
    } else {
      // Selected a popular MCP
      const selected = POPULAR_MCPS.find((m) => m.name === choice)!;
      mcpName = selected.name;
      mcpCommand = selected.command;
      mcpArgs = [...selected.args];
      p.log.info(`${pc.dim("Repo:")} ${pc.cyan(selected.repo)}`);
      if (Object.keys(selected.env).length > 0) {
        const envCopy: Record<string, string> = { ...selected.env };
        env = envCopy;
        p.log.info(`This MCP needs environment variables: ${pc.cyan(Object.entries(envCopy).map(([k, v]) => `${k}=${v}`).join(", "))}`);

        const confirmEnv = await p.confirm({
          message: "Update the env var values?",
          initialValue: false,
        });

        if (!p.isCancel(confirmEnv) && confirmEnv) {
          for (const key of Object.keys(envCopy)) {
            const val = await p.text({
              message: `Value for ${key}:`,
              placeholder: envCopy[key],
            });
            if (!p.isCancel(val) && (val as string).trim()) {
              envCopy[key] = (val as string).trim();
            }
          }
        }
      }
    }
  }

  if (!mcpCommand) {
    // Non-interactive with just a name — check if it's a known MCP
    const known = POPULAR_MCPS.find((m) => m.name === mcpName);
    if (known) {
      mcpCommand = known.command;
      mcpArgs = [...known.args];
      if (Object.keys(known.env).length > 0) {
        env = { ...known.env };
      }
    } else {
      const cmdInput = await p.text({
        message: "Command to start the MCP server:",
        placeholder: "e.g., npx -y @modelcontextprotocol/server-postgres",
      });
      if (p.isCancel(cmdInput)) { p.cancel("Aborted."); process.exit(0); }
      const parts = (cmdInput as string).trim().split(/\s+/);
      mcpCommand = parts[0];
      mcpArgs = parts.slice(1);
    }
  } else if (mcpArgs.length === 0) {
    // Parse remaining positional args
    const remaining = positional.slice(2);
    if (remaining.length > 0) {
      mcpArgs = remaining;
    }
  }

  // If env wasn't set by the popular MCP flow, ask for it — unless non-interactive.
  if (!env && args["yes"] !== "true" && args["y"] !== "true") {
    const envInput = await p.text({
      message: "Environment variables? (KEY=VALUE, comma-separated, or leave empty)",
      placeholder: "e.g., DATABASE_URL=$DATABASE_URL, PORT=5432",
    });

    if (!p.isCancel(envInput) && (envInput as string).trim()) {
      env = {};
      for (const pair of (envInput as string).split(",")) {
        const [key, ...valueParts] = pair.trim().split("=");
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join("=").trim();
        }
      }
    }
  }

  // Confirm before writing
  const fullCmd = `${mcpCommand} ${mcpArgs.join(" ")}`.trim();
  const envSummary = env && Object.keys(env).length > 0
    ? `\n  ${pc.dim("Env:")} ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "";

  p.log.message(`${pc.bold("Will add to config.json:")}
  ${pc.dim("Name:")} ${pc.cyan(mcpName)}
  ${pc.dim("Command:")} ${fullCmd}${envSummary}`);

  const autoYes = args["yes"] === "true" || args["y"] === "true";
  if (!autoYes) {
    const confirm = await p.confirm({
      message: "Add this MCP server?",
      initialValue: true,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.cancel("Aborted.");
      process.exit(0);
    }
  }

  // Write the MCP entry into all three backend roles
  writeMcpToAllBackends(configPath, mcpName, mcpCommand, mcpArgs, env);

  p.log.success(`MCP server added: ${pc.cyan(mcpName)}`);
  p.log.info(`Command: ${pc.dim(`${mcpCommand} ${mcpArgs.join(" ")}`.trim())}`);
  if (env) {
    p.log.info(`Env: ${pc.dim(Object.entries(env).map(([k, v]) => `${k}=${v}`).join(", "))}`);
  }
  p.log.info(`Written to: ${pc.dim(configPath)}`);

  // Also register as an McpServer entity in Substrate so `swarm mcp list/introspect/show`
  // can see it without a separate sync step. Route the project-id through the
  // same resolver the rest of the CLI uses so edge cases (config at
  // .swarm/config.json rather than .swarm/domains/<project>/config.json) yield
  // a sensible projectId instead of the literal ".swarm".
  if (substrateClient) {
    const { resolveProjectName } = await import("./swarm-meta.js");
    const { addMcpToSubstrate } = await import("./mcp-manage.js");
    const projectId = resolveProjectName(swarmDir);
    await addMcpToSubstrate(substrateClient, mcpName, mcpCommand, mcpArgs, projectId);
    p.log.info(`Registered in Substrate for project: ${pc.cyan(projectId)}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runAdd(args: Record<string, string>, positional: string[], substrateClient?: SubstrateClient): Promise<void> {
  p = await import("@clack/prompts");
  pc = (await import("picocolors")).default;

  const subcommand = positional[0];
  const rest = positional.slice(1);

  if (!subcommand) {
    const choice = await p.select({
      message: "What would you like to add?",
      options: [
        { value: "skill", label: "A skill", hint: "knowledge file for agents" },
        { value: "mcp", label: "An MCP server", hint: "tool server for agents" },
      ],
    });
    if (p.isCancel(choice)) { p.cancel("Aborted."); process.exit(0); }

    if (choice === "skill") {
      await addSkill(args, [], substrateClient);
    } else {
      await addMcp(args, [], substrateClient);
    }
    return;
  }

  switch (subcommand) {
    case "skill":
      await addSkill(args, rest, substrateClient);
      break;
    case "mcp":
      await addMcp(args, rest, substrateClient);
      break;
    default:
      console.error(`Unknown: swarm add ${subcommand}. Use 'swarm add skill' or 'swarm add mcp'.`);
      process.exit(1);
  }
}
