/**
 * swarm skill — Substrate-backed skill management commands.
 *
 * These commands store skills as SwarmContent entities in Substrate,
 * replacing the filesystem-only approach with a queryable store.
 *
 * Usage:
 *   swarm skill list                   List skills stored in Substrate
 *   swarm skill show <name>            Show a skill's content
 *   swarm skill update                 Re-fetch remote skills
 *   swarm skill remove <name>          Remove a skill from Substrate
 */

import { resolve, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ANSI helpers
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Substrate SwarmContent shape for skill entities
// ---------------------------------------------------------------------------

interface SkillEntity {
  id?: number;
  path: string;
  tier: string;
  intent: string;
  content: string;
  tokenEstimate: number;
  lastReviewed: string;
  projectId: string;
  sourceUrl: string;
  fetchedAt: string;
  skillName: string;
}

// ---------------------------------------------------------------------------
// Token estimation (1 token ~ 4 characters)
// ---------------------------------------------------------------------------

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// Derive a skill name from a source string
// ---------------------------------------------------------------------------

function deriveSkillName(source: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    // Extract filename from URL path
    const urlPath = new URL(source).pathname;
    const filename = urlPath.split("/").pop() ?? source;
    return filename.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }
  // Local file — use basename without extension
  return basename(source).replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// ---------------------------------------------------------------------------
// swarm skill add (called from add.ts as Substrate extension)
// ---------------------------------------------------------------------------

/**
 * Add a skill to Substrate as SwarmContent entities.
 * Ingests the main SKILL.md AND all companion files (references/, agents/, etc.).
 *
 * For local skills: walks the skill directory for all .md files.
 * For remote URLs: fetches the main file, then attempts to discover and fetch
 * a references/ directory if the URL points to a GitHub raw content path.
 *
 * @param client  SubstrateClient instance
 * @param source  URL or local file path (to SKILL.md or a directory)
 * @param tier    "skills_vetted" | "skills_community" | "skills_core"
 * @param projectId  Project identifier
 */
export async function addSkillToSubstrate(
  client: SubstrateClient,
  source: string,
  tier: string,
  projectId: string,
): Promise<void> {
  const skillName = deriveSkillName(source);
  const now = new Date().toISOString();
  const isRemote = source.startsWith("http://") || source.startsWith("https://");
  const tierDir = tier.replace("skills_", "");

  let filesIngested = 0;
  let totalTokens = 0;

  async function storeFile(
    filePath: string,
    content: string,
    sourceUrl: string,
    isReference: boolean,
  ): Promise<void> {
    const tokens = estimateTokens(content);
    try {
      await client.mutate(
        "createSwarmContent",
        {
          path: filePath,
          tier,
          intent: "",
          content,
          tokenEstimate: tokens,
          lastReviewed: now,
          projectId,
          sourceUrl,
          fetchedAt: now,
          skillName: isReference ? `${skillName}/ref` : skillName,
        },
        { id: true },
      );
      filesIngested++;
      totalTokens += tokens;
      const label = isReference ? DIM : "";
      console.log(`    ${label}${filePath} (~${tokens} tokens)${isReference ? RESET : ""}`);
    } catch (err) {
      console.error(`    ${RED}failed: ${filePath} — ${(err as Error).message}${RESET}`);
    }
  }

  if (isRemote) {
    // Fetch main skill file
    const response = await fetch(source);
    if (!response.ok) {
      console.error(`${RED}Failed to fetch ${source}: ${response.status}${RESET}`);
      return;
    }
    const content = await response.text();
    const mainPath = `skills/${tierDir}/${skillName}.md`;
    await storeFile(mainPath, content, source, false);

    // Attempt to discover references from GitHub raw URLs
    // Pattern: https://raw.githubusercontent.com/org/repo/sha/path/SKILL.md
    // References: https://raw.githubusercontent.com/org/repo/sha/path/references/*.md
    if (source.includes("raw.githubusercontent.com")) {
      const baseUrl = source.replace(/\/[^/]+$/, ""); // remove SKILL.md
      const indexUrl = `${baseUrl}/references/_index.md`;

      try {
        const indexResp = await fetch(indexUrl);
        if (indexResp.ok) {
          const indexContent = await indexResp.text();
          // Parse _index.md for referenced filenames
          const refFiles = indexContent.match(/\[.*?\]\((.*?\.md)\)/g)
            ?.map(m => m.match(/\((.*?\.md)\)/)?.[1])
            .filter((f): f is string => !!f) ?? [];

          // Also store _index.md itself
          await storeFile(`skills/${tierDir}/${skillName}/references/_index.md`, indexContent, indexUrl, true);

          // Fetch each reference file
          for (const refFile of refFiles) {
            const refUrl = `${baseUrl}/references/${refFile}`;
            try {
              const refResp = await fetch(refUrl);
              if (refResp.ok) {
                const refContent = await refResp.text();
                await storeFile(`skills/${tierDir}/${skillName}/references/${refFile}`, refContent, refUrl, true);
              }
            } catch {
              // Skip failed reference fetches
            }
          }
        }
      } catch {
        // No references directory — that's fine
      }
    }
  } else {
    // Local source — could be a file or a directory
    let resolved = resolve(source);

    // If pointing at SKILL.md, use parent directory as skill root
    if (resolved.endsWith(".md") && existsSync(resolved)) {
      const skillDir = resolve(resolved, "..");
      const content = readFileSync(resolved, "utf-8");
      const mainPath = `skills/${tierDir}/${skillName}.md`;
      await storeFile(mainPath, content, "", false);

      // Walk sibling references/ directory if it exists
      const refsDir = resolve(skillDir, "references");
      if (existsSync(refsDir)) {
        await walkAndIngest(refsDir, `skills/${tierDir}/${skillName}/references`, client, storeFile);
      }
    } else if (existsSync(resolved)) {
      // It's a directory — look for SKILL.md inside
      const skillMd = resolve(resolved, "SKILL.md");
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        await storeFile(`skills/${tierDir}/${skillName}.md`, content, "", false);

        const refsDir = resolve(resolved, "references");
        if (existsSync(refsDir)) {
          await walkAndIngest(refsDir, `skills/${tierDir}/${skillName}/references`, client, storeFile);
        }
      } else {
        console.error(`${RED}No SKILL.md found in ${resolved}${RESET}`);
        return;
      }
    } else {
      console.error(`${RED}Not found: ${resolved}${RESET}`);
      return;
    }
  }

  console.log(`\n  ${GREEN}${filesIngested} files ingested (~${totalTokens} tokens total)${RESET}`);
}

/** Walk a directory and ingest all .md files */
async function walkAndIngest(
  dir: string,
  storePath: string,
  _client: SubstrateClient,
  storeFile: (path: string, content: string, sourceUrl: string, isRef: boolean) => Promise<void>,
): Promise<void> {
  const { readdirSync, statSync } = await import("node:fs");
  const entries = readdirSync(dir);
  for (const entry of entries.sort()) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      await walkAndIngest(full, `${storePath}/${entry}`, _client, storeFile);
    } else if (entry.endsWith(".md")) {
      const content = readFileSync(full, "utf-8");
      await storeFile(`${storePath}/${entry}`, content, "", true);
    }
  }
}

// ---------------------------------------------------------------------------
// swarm skill list
// ---------------------------------------------------------------------------

export async function listSkills(client: SubstrateClient): Promise<void> {
  const skillTiers = ["skills_core", "skills_vetted", "skills_community"];

  console.log("");
  console.log(`${BOLD}Skills in Substrate${RESET}`);
  console.log("");

  let totalCount = 0;

  for (const tier of skillTiers) {
    const tierLabel = tier === "skills_core"
      ? `${GREEN}core${RESET} ${DIM}(team-authored, always loaded if route specifies)${RESET}`
      : tier === "skills_vetted"
        ? `${CYAN}vetted${RESET} ${DIM}(reviewed third-party, loaded by default)${RESET}`
        : `${DIM}community${RESET} ${DIM}(reference only, not auto-loaded)${RESET}`;

    console.log(`  ${tierLabel}`);

    try {
      const entities = await client.query<SkillEntity>(
        "SwarmContent",
        // Operator-keyed: Substrate refuses a bare `{ tier }` param (unknown_param).
        { where: { tier: { eq: tier } } },
        {
          path: true,
          tier: true,
          skillName: true,
          sourceUrl: true,
          tokenEstimate: true,
          fetchedAt: true,
        },
      );

      // Filtered server-side; checked again so a server that ignores the where cannot widen it.
      const skills = entities.filter((e) => e.tier === tier);

      if (skills.length === 0) {
        console.log(`    ${DIM}(empty)${RESET}`);
      } else {
        for (const skill of skills) {
          const source = skill.sourceUrl ? `${DIM}remote${RESET}` : `${DIM}local${RESET}`;
          const tokens = skill.tokenEstimate ? ` ${DIM}(${skill.tokenEstimate} tokens)${RESET}` : "";
          const fetched = skill.fetchedAt ? ` ${DIM}fetched ${skill.fetchedAt}${RESET}` : "";
          const name = skill.skillName || basename(skill.path).replace(/\.md$/, "");
          console.log(`    ${GREEN}${name}${RESET}  ${source}  ${skill.path}${tokens}${fetched}`);
          totalCount++;
        }
      }
    } catch {
      console.log(`    ${DIM}(query failed)${RESET}`);
    }

    console.log("");
  }

  if (totalCount === 0) {
    console.log(`  ${DIM}No skills stored in Substrate. Add one with:${RESET}`);
    console.log(`  ${CYAN}swarm add skill <source>${RESET}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// swarm skill show <name>
// ---------------------------------------------------------------------------

export async function showSkill(client: SubstrateClient, skillName: string): Promise<void> {
  const entities = await client.query<SkillEntity>(
    "SwarmContent",
    {},
    {
      path: true,
      tier: true,
      skillName: true,
      sourceUrl: true,
      content: true,
      tokenEstimate: true,
      fetchedAt: true,
    },
  );

  const match = entities.find(
    (e) => e.skillName === skillName || e.path.includes(skillName),
  );

  if (!match) {
    console.error(`${RED}Skill not found: ${skillName}${RESET}`);
    console.error(`${DIM}Use 'swarm skill list' to see available skills.${RESET}`);
    process.exit(1);
  }

  console.log("");
  console.log(`${BOLD}${match.skillName || basename(match.path)}${RESET}`);
  console.log(`${DIM}Path:${RESET}   ${match.path}`);
  console.log(`${DIM}Tier:${RESET}   ${match.tier}`);
  console.log(`${DIM}Source:${RESET} ${match.sourceUrl || "local"}`);
  console.log(`${DIM}Tokens:${RESET} ${match.tokenEstimate}`);
  if (match.fetchedAt) {
    console.log(`${DIM}Fetched:${RESET} ${match.fetchedAt}`);
  }
  console.log("");
  console.log(match.content);
}

// ---------------------------------------------------------------------------
// swarm skill update
// ---------------------------------------------------------------------------

export async function updateSkills(client: SubstrateClient): Promise<void> {
  const entities = await client.query<SkillEntity>(
    "SwarmContent",
    {},
    {
      id: true,
      path: true,
      skillName: true,
      sourceUrl: true,
      content: true,
      tokenEstimate: true,
    },
  );

  const remoteSkills = entities.filter((e) => e.sourceUrl && e.sourceUrl.trim() !== "");

  if (remoteSkills.length === 0) {
    console.log(`${DIM}No remote skills to update.${RESET}`);
    return;
  }

  console.log(`${BOLD}Updating ${remoteSkills.length} remote skill(s)...${RESET}`);
  console.log("");

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const skill of remoteSkills) {
    const name = skill.skillName || basename(skill.path);
    try {
      const response = await fetch(skill.sourceUrl);
      if (!response.ok) {
        console.log(`  ${RED}FAIL${RESET} ${name} — HTTP ${response.status}`);
        failed++;
        continue;
      }

      const newContent = await response.text();

      if (newContent === skill.content) {
        console.log(`  ${DIM}unchanged${RESET} ${name}`);
        unchanged++;
        continue;
      }

      const now = new Date().toISOString();
      const tokens = estimateTokens(newContent);

      await client.mutate(
        "updateSwarmContent",
        {
          id: skill.id,
          content: newContent,
          tokenEstimate: tokens,
          fetchedAt: now,
        },
        { id: true },
      );

      console.log(`  ${GREEN}updated${RESET} ${name} ${DIM}(${tokens} tokens)${RESET}`);
      updated++;
    } catch (err) {
      console.log(`  ${RED}FAIL${RESET} ${name} — ${(err as Error).message}`);
      failed++;
    }
  }

  console.log("");
  console.log(`${BOLD}Summary:${RESET} ${updated} updated, ${unchanged} unchanged, ${failed} failed`);
}

// ---------------------------------------------------------------------------
// swarm skill remove <name>
// ---------------------------------------------------------------------------

export async function removeSkill(client: SubstrateClient, skillName: string): Promise<void> {
  const entities = await client.query<SkillEntity>(
    "SwarmContent",
    {},
    {
      id: true,
      path: true,
      skillName: true,
    },
  );

  const match = entities.find(
    (e) => e.skillName === skillName || e.path.includes(skillName),
  );

  if (!match) {
    console.error(`${RED}Skill not found: ${skillName}${RESET}`);
    console.error(`${DIM}Use 'swarm skill list' to see available skills.${RESET}`);
    process.exit(1);
  }

  try {
    await client.mutate(
      "deleteSwarmContent",
      { id: match.id },
      { id: true },
    );
    console.log(`${GREEN}Removed:${RESET} ${match.skillName || match.path}`);
  } catch (err) {
    console.error(`${RED}Failed to remove skill: ${(err as Error).message}${RESET}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tier labels and mapping
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<string, string> = {
  "1": "skills_core",
  "2": "skills_vetted",
  "3": "skills_community",
  core: "skills_core",
  vetted: "skills_vetted",
  community: "skills_community",
};

const TIER_DISPLAY: Record<string, string> = {
  skills_core: `${GREEN}core${RESET} — team-authored, fully trusted, always loaded`,
  skills_vetted: `${CYAN}vetted${RESET} — third-party, reviewed and adopted, loaded by default`,
  skills_community: `${DIM}community${RESET} — reference only, not auto-loaded`,
};

/**
 * Resolve tier from --tier flag or interactive prompt.
 * Accepts: "core", "vetted", "community", or "1"/"2"/"3".
 */
async function resolveTier(flagValue?: string): Promise<string> {
  // If provided as a flag, resolve directly
  if (flagValue) {
    const tier = TIER_LABELS[flagValue.toLowerCase()];
    if (!tier) {
      console.error(`${RED}Invalid tier: "${flagValue}". Use: core, vetted, or community${RESET}`);
      process.exit(1);
    }
    return tier;
  }

  // Interactive prompt
  console.log("");
  console.log(`${BOLD}Select skill tier:${RESET}`);
  console.log(`  ${GREEN}[1]${RESET} core      — team-authored, fully trusted, always loaded`);
  console.log(`  ${CYAN}[2]${RESET} vetted    — third-party, reviewed and adopted, loaded by default`);
  console.log(`  ${DIM}[3]${RESET} community — reference only, not auto-loaded`);
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Tier [1/2/3]: `);
  rl.close();

  const tier = TIER_LABELS[answer.trim()];
  if (!tier) {
    console.error(`${RED}Invalid selection. Use 1, 2, or 3.${RESET}`);
    process.exit(1);
  }
  return tier;
}

// ---------------------------------------------------------------------------
// swarm skill add <source> [--tier core|vetted|community]
// ---------------------------------------------------------------------------

async function addSkillInteractive(
  client: SubstrateClient,
  source: string,
  flags: Record<string, string>,
): Promise<void> {
  if (!source) {
    console.error("Usage: swarm skill add <url-or-path> [--tier core|vetted|community]");
    process.exit(1);
  }

  const tier = await resolveTier(flags.tier);
  const tierLabel = tier.replace("skills_", "");

  console.log(`\n  Adding skill from ${source.startsWith("http") ? "URL" : "file"}: ${CYAN}${source}${RESET}`);
  console.log(`  Tier: ${TIER_DISPLAY[tier]}`);

  await addSkillToSubstrate(client, source, tier, "global");

  const skillName = deriveSkillName(source);
  console.log(`\n  ${GREEN}Skill "${skillName}" added to ${tierLabel}${RESET}`);
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export async function runSkill(
  positional: string[],
  flags: Record<string, string>,
  client?: SubstrateClient,
): Promise<void> {
  if (!client) {
    console.error("No Substrate store is available. Run `swarm substrate start` (or `swarm db setup` first).");
    process.exit(1);
  }

  const subcommand = positional[0];
  const rest = positional.slice(1);

  switch (subcommand) {
    case "add":
      await addSkillInteractive(client, rest[0], flags);
      break;
    case "list":
    case "ls":
      await listSkills(client);
      break;
    case "show":
      if (!rest[0]) {
        console.error("Usage: swarm skill show <name>");
        process.exit(1);
      }
      await showSkill(client, rest[0]);
      break;
    case "update":
      await updateSkills(client);
      break;
    case "remove":
    case "rm":
      if (!rest[0]) {
        console.error("Usage: swarm skill remove <name>");
        process.exit(1);
      }
      await removeSkill(client, rest[0]);
      break;
    default:
      console.log("Usage: swarm skill <command>");
      console.log("");
      console.log("Commands:");
      console.log("  add <source>      Add a skill from URL or file path");
      console.log("                    --tier core|vetted|community (or prompts)");
      console.log("  list              List skills stored in Substrate");
      console.log("  show <name>       Show a skill's content");
      console.log("  update            Re-fetch remote skills and update if changed");
      console.log("  remove <name>     Remove a skill from Substrate");
      process.exit(subcommand ? 1 : 0);
  }

  // Close the client before the process exits
  client.close();
}
