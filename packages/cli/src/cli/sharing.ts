/**
 * swarm sharing — View and update telemetry sharing settings.
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let p: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pc: any;

export async function runSharing(args: Record<string, string>): Promise<void> {
  p = await import("@clack/prompts");
  pc = (await import("picocolors")).default;

  const swarmDir = resolve(process.cwd(), args["dir"] ?? ".swarm");

  // Find config.json
  if (!existsSync(swarmDir)) {
    console.error("No .swarm/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  const domainsDir = join(swarmDir, "domains");
  if (!existsSync(domainsDir)) {
    console.error("No domains/ directory found. Run 'swarm init' first.");
    process.exit(1);
  }

  const projects = readdirSync(domainsDir).filter((d) => {
    return existsSync(join(domainsDir, d, "config.json"));
  });

  if (projects.length === 0) {
    console.error("No project config found. Run 'swarm init' first.");
    process.exit(1);
  }

  const project = projects.length === 1
    ? projects[0]
    : await (async () => {
        const choice = await p.select({
          message: "Which project?",
          options: projects.map((pr: string) => ({ value: pr, label: pr })),
        });
        if (p.isCancel(choice)) { p.cancel("Aborted."); process.exit(0); }
        return choice as string;
      })();

  const configPath = join(domainsDir, project, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const sharing = config.telemetry_sharing;

  p.intro(pc.magenta("swarm sharing"));

  // Show current settings
  if (sharing?.enabled) {
    const identity = sharing.identity?.type === "github"
      ? `GitHub (${sharing.identity.github_username})`
      : `Anonymous (${sharing.identity?.telemetry_id?.slice(0, 8)}...)`;

    p.note([
      `${pc.bold("Sharing:")} ${pc.green("enabled")}`,
      `${pc.bold("Identity:")} ${identity}`,
      `${pc.bold("Logs:")} ${sharing.share_logs ? pc.green("yes") : pc.dim("no")}`,
      `${pc.bold("Trees:")} ${sharing.share_trees ? pc.green("yes") : pc.dim("no")}`,
      `${pc.bold("Context:")} ${sharing.share_context ? pc.green("yes") : pc.dim("no")}`,
    ].join("\n"), "Current sharing settings");
  } else {
    p.note(`${pc.bold("Sharing:")} ${pc.dim("disabled")}`, "Current sharing settings");
  }

  // Ask if they want to change
  const action = await p.select({
    message: "What would you like to do?",
    options: [
      { value: "keep", label: "Keep current settings" },
      { value: "update", label: "Update sharing preferences" },
      { value: "disable", label: "Disable sharing entirely" },
    ],
  });

  if (p.isCancel(action) || action === "keep") {
    p.outro("No changes made.");
    return;
  }

  if (action === "disable") {
    config.telemetry_sharing = { enabled: false };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    p.log.success("Sharing disabled.");
    p.outro("Done.");
    return;
  }

  // Update flow — same questions as init
  const tiers = await p.multiselect({
    message: "What would you like to share?",
    options: [
      { value: "logs", label: "Logs", hint: "telemetry events, checkpoint, grade report" },
      { value: "trees", label: "Tree snapshots", hint: "directory structure before/after" },
      { value: "context", label: "Swarm context", hint: "goals, domain docs — secrets.md excluded" },
    ],
    required: false,
  });

  if (p.isCancel(tiers)) {
    p.outro("No changes made.");
    return;
  }

  const selected = tiers as string[];

  const linkGithub = await p.confirm({
    message: "Link your GitHub account?",
    initialValue: sharing?.identity?.type === "github",
  });

  let identityConfig;
  if (!p.isCancel(linkGithub) && linkGithub) {
    try {
      const { execFileSync } = await import("node:child_process");
      const username = execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (username) {
        identityConfig = { type: "github", github_username: username };
        p.log.success(`Linked as ${pc.cyan(username)}`);
      } else {
        throw new Error("Empty username");
      }
    } catch {
      const { randomUUID } = await import("node:crypto");
      identityConfig = { type: "anonymous", telemetry_id: sharing?.identity?.telemetry_id ?? randomUUID() };
      p.log.warn("Could not read GitHub identity. Using anonymous ID.");
    }
  } else {
    const { randomUUID } = await import("node:crypto");
    identityConfig = { type: "anonymous", telemetry_id: sharing?.identity?.telemetry_id ?? randomUUID() };
  }

  config.telemetry_sharing = {
    enabled: true,
    share_logs: selected.includes("logs"),
    share_trees: selected.includes("trees"),
    share_context: selected.includes("context"),
    identity: identityConfig,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  p.log.success("Sharing settings updated.");
  p.outro("Done.");
}
