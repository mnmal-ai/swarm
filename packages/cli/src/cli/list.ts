/**
 * swarm list — List installed skills and MCP servers.
 *
 * Usage:
 *   swarm list skills    Show installed skills by tier
 *   swarm list mcp       Show configured MCP servers
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// swarm list skills
// ---------------------------------------------------------------------------

function listSkills(swarmDir: string): void {
  const skillsDir = join(swarmDir, "skills");

  if (!existsSync(skillsDir)) {
    console.log(`${DIM}No skills directory found.${RESET}`);
    return;
  }

  const tiers = ["core", "vetted", "community"] as const;
  let totalCount = 0;

  console.log("");
  console.log(`${BOLD}Installed Skills${RESET}`);
  console.log("");

  for (const tier of tiers) {
    const tierDir = join(skillsDir, tier);
    const tierLabel = tier === "core"
      ? `${GREEN}core${RESET} ${DIM}(team-authored, always loaded if route specifies)${RESET}`
      : tier === "vetted"
        ? `${CYAN}vetted${RESET} ${DIM}(reviewed third-party, loaded by default)${RESET}`
        : `${DIM}community${RESET} ${DIM}(reference only, not auto-loaded)${RESET}`;

    console.log(`  ${tierLabel}`);

    if (!existsSync(tierDir)) {
      console.log(`    ${DIM}(empty)${RESET}`);
      console.log("");
      continue;
    }

    const files = readdirSync(tierDir).filter(
      (f) => f.endsWith(".md") || f.endsWith(".mdc"),
    );

    if (files.length === 0) {
      console.log(`    ${DIM}(empty)${RESET}`);
    } else {
      for (const file of files) {
        // Try to read first line for a description
        const content = readFileSync(join(tierDir, file), "utf-8");
        const firstHeading = content.match(/^#\s+(.+)/m);
        const description = firstHeading?.[1] ?? "";
        console.log(`    ${file}${description ? `  ${DIM}— ${description}${RESET}` : ""}`);
        totalCount++;
      }
    }
    console.log("");
  }

  if (totalCount === 0) {
    console.log(`  ${DIM}No skills installed. Add one with:${RESET}`);
    console.log(`  ${CYAN}swarm add skill${RESET}`);
    console.log("");
  }

  console.log(`  ${DIM}Browse more: npx skills find${RESET}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// swarm list mcp
// ---------------------------------------------------------------------------

function listMcp(swarmDir: string): void {
  const domainsDir = join(swarmDir, "domains");

  if (!existsSync(domainsDir)) {
    console.log(`${DIM}No domains directory found.${RESET}`);
    return;
  }

  const projects = readdirSync(domainsDir).filter((d) =>
    existsSync(join(domainsDir, d, "config.json")),
  );

  console.log("");
  console.log(`${BOLD}MCP Servers${RESET}`);
  console.log("");

  if (projects.length === 0) {
    console.log(`  ${DIM}No project configs found.${RESET}`);
    console.log("");
    return;
  }

  for (const project of projects) {
    const configPath = join(domainsDir, project, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    const mcpServers = config?.backends?.worker?.mcpServers;

    console.log(`  ${BOLD}${project}${RESET}`);

    if (!mcpServers || Object.keys(mcpServers).length === 0) {
      console.log(`    ${DIM}No MCP servers configured.${RESET}`);
    } else {
      for (const [name, entry] of Object.entries(mcpServers)) {
        const server = entry as { type: string; command: string; args?: string[]; env?: Record<string, string> };
        const cmd = [server.command, ...(server.args ?? [])].join(" ");
        const envKeys = server.env ? Object.keys(server.env).join(", ") : "";
        console.log(`    ${GREEN}${name}${RESET}  ${DIM}${cmd}${RESET}`);
        if (envKeys) {
          console.log(`      ${DIM}env: ${envKeys}${RESET}`);
        }
      }
    }
    console.log("");
  }

  console.log(`  ${DIM}Add one with: ${CYAN}swarm add mcp <name> <command>${RESET}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runList(positional: string[], args: Record<string, string>): Promise<void> {
  const swarmDir = resolve(process.cwd(), args["dir"] ?? ".swarm");

  if (!existsSync(swarmDir)) {
    console.error("No .swarm/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  const subcommand = positional[0];

  if (!subcommand) {
    // Show both
    listSkills(swarmDir);
    listMcp(swarmDir);
    return;
  }

  switch (subcommand) {
    case "skills":
    case "skill":
      listSkills(swarmDir);
      break;
    case "mcp":
    case "mcps":
      listMcp(swarmDir);
      break;
    default:
      console.error(`Unknown: swarm list ${subcommand}. Use 'swarm list skills' or 'swarm list mcp'.`);
      process.exit(1);
  }
}
