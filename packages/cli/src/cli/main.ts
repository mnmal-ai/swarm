#!/usr/bin/env node

import { VERSION, COMMIT_HASH } from "../version.js";
import type { SwarmQueryClient, EnsureSubstrateReadyOptions, SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { FileQueryAdapter } from "@mnmal-ai/swarm-core";
import { resolveDbConfig } from "../config.js";
import type { ProjectSubstrateConfig } from "../project-substrate.js";
import { ensureProjectSubstrate } from "../substrate/ready.js";

const command = process.argv[2];
const args = process.argv.slice(3);

// Boolean flags that don't take a value argument
const BOOLEAN_FLAGS = new Set([
  "dashboard", "no-dashboard", "no-worktrees",
  "guided", "quick", "empty", "no-skill", "no-animation",
  "yes", "y", "tree", "no-tree", "dashboard-lan", "lan-dashboard",
  "global", "all", "quiet", "force", "resume", "fresh",
  "help", "h", "apply", "preflight",
]);

// Canonical name → any accepted aliases. Parser normalizes aliases to the
// canonical key so downstream code only checks one spelling.
const FLAG_ALIASES: Record<string, string> = {
  "lan-dashboard": "dashboard-lan",
};

function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const rawKey = args[i].slice(2);
      const key = FLAG_ALIASES[rawKey] ?? rawKey;
      if (BOOLEAN_FLAGS.has(rawKey) || BOOLEAN_FLAGS.has(key)) {
        flags[key] = "true";
      } else {
        flags[key] = args[i + 1] ?? "true";
        i++; // skip the value — don't treat it as positional
      }
    } else if (args[i] === "-y") {
      flags["yes"] = "true";
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function printHelp(): void {
  console.log(`swarm v${VERSION} (${COMMIT_HASH})`);
  console.log("");
  console.log("Commands:");
  console.log("  init              Scaffold a swarm for your project");
  console.log("  add skill <src>   Add a skill (file, registry, or create new)");
  console.log("  add mcp <name>    Add an MCP server to config.json");
  console.log("  list [skills|mcp] Show installed skills and MCP servers");
  console.log("  skill <cmd>       Manage skills in the Substrate store (list|show|update|remove)");
  console.log("  mcp <cmd>         Manage MCP servers in the Substrate store (list|show|introspect|remove)");
  console.log("  run               Execute project goals with the Orchestrator");
  console.log("  merge             Retry merging pull requests earlier runs left open");
  console.log("  grade-data        Aggregate telemetry into a run report");
  console.log("  sharing           View and update telemetry sharing settings");
  console.log("  logs              List, fetch, and inspect remote telemetry runs");
  console.log("  sync              Sync .swarm/ files to the Substrate store");
  console.log("  db <cmd>          Manage database (setup|status|start|stop|reset)");
  console.log("  substrate <cmd>   Manage the Substrate sidecars (start|stop|status)");
  console.log("  doctor            Diagnose the Substrate stack (no sidecar required)");
  console.log("  drainstop         Run the drainstop pass (promote observations) now");
  console.log("  dashboard <cmd>   Dashboard preview tooling (preview)");
  console.log("  uninstall         Remove swarm from current project (--global for CLI)");
  console.log("  upgrade           Upgrade swarm CLI to latest (or --version <tag>)");
  console.log("");
  console.log("Init options:");
  console.log("  --guided            Walk through guided questions");
  console.log("  --quick             Starter templates with example content");
  console.log("  --empty             Just the skeleton");
  console.log("  --project <name>    Override detected project name");
  console.log("  --dir <path>        Scaffold swarm at a specific path (default: .swarm/)");
  console.log("  --from <path>       Add a new domain to an existing swarm");
  console.log("  --no-skill          Skip skill file generation");
  console.log("  --no-animation      Disable the loading animation");
  console.log("");
  console.log("Run options:");
  console.log("  --swarm-path <path>   Path to the swarm repo");
  console.log("  --repo-path <path>    Work repo to operate on (default: cwd; or repo_root in config.json)");
  console.log("  --project <name>      Project name");
  console.log("  --dashboard           Start live dashboard (default: true)");
  console.log("  --no-dashboard        Disable live dashboard");
  console.log("  --dashboard-port <n>  Dashboard port (default: 3141)");
  console.log("  --no-worktrees        Disable git worktree isolation");
  console.log("  --no-tree             Hide swarm file tree");
  console.log("  --yes, -y             Skip preflight confirmation");
  console.log("  --dashboard-lan       Expose dashboard on local network (0.0.0.0) — no login: anyone on the");
  console.log("                        network can see the run, and read and change this project's Substrate store");
  console.log("  --preflight           Do everything up to the preflight screen (Substrate, sync, base branch,");
  console.log("                        setup_command, goals) and stop before any goal is started");
  console.log("  --resume              Resume from checkpoint without prompting");
  console.log("  --fresh               Discard checkpoint and start fresh");
  console.log("");
  console.log("Grade options:");
  console.log("  --run <runId>          Filter by run ID");
  console.log("  --date <YYYY-MM-DD>    Filter by date");
  console.log("  --from <date>          Start of date range");
  console.log("  --to <date>            End of date range");
  console.log("");
  console.log("Upgrade options:");
  console.log("  --version <tag>     Install a specific version (e.g. v0.18.0)");
  console.log("");
  console.log("Uninstall options:");
  console.log("  --global            Stop the sidecars and remove the installed swarm binary");
  console.log("  --all               Remove from project AND globally");
  console.log("  --yes, -y           Skip confirmation prompt");
  console.log("");
  console.log("Substrate commands:");
  console.log("  substrate start        Start Postgres, install the runtime if needed, start both sidecars");
  console.log("  substrate stop         Stop this project's Substrate sidecars (cold + meta)");
  console.log("  substrate status       One line per sidecar (health, namespaces) and per Postgres");
  console.log("");
  console.log("Logs commands:");
  console.log("  logs list              List runs (--user, --project, --from, --to, --limit)");
  console.log("  logs report <runId>    Fetch a run's grade report (JSON to stdout)");
  console.log("  logs fetch <runId>     Download full payload and extract locally");
  console.log("  logs status            Show current sharing config");
  console.log("");
  console.log("Global options:");
  console.log("  --quiet               Suppress Substrate startup messages");
  console.log("  --help, -h            Show this message");
  console.log("  --version, -v         Print version and exit");
}

async function main() {
  // Hidden command: Codex runs it before each tool a codex session uses
  // (worker-backends/src/codex-hook.ts). It answers on stdout and exits;
  // nothing else in swarm starts.
  if (command === "codex-hook") {
    const { codexHookMain } = await import("./codex-hook.js");
    await codexHookMain();
    return;
  }

  const { flags: parsed, positional } = parseArgs(args);

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`swarm v${VERSION} (${COMMIT_HASH})`);
    process.exit(0);
  }

  // Short-circuit `--help` / `-h` at the top, *before* any Substrate or
  // sidecar bootstrap. Without this the flag is a no-op boolean and the command
  // proceeds into interactive mode — e.g. `swarm add skill --help` would
  // spawn a sidecar and hang on the skill-type prompt. Every swarm subcommand
  // supports --help by printing the top-level help and exiting 0.
  if (
    command === "--help" || command === "-h" || command === "help" ||
    parsed["help"] === "true" || parsed["h"] === "true"
  ) {
    printHelp();
    process.exit(0);
  }

  // --- Project-level Substrate: dedicated stack + local_only guard ---
  // Applied before any command touches Substrate or Postgres (including `db`
  // and `doctor`), so a project with its own stack never reaches the shared one
  // and a local_only project never starts with an off-machine endpoint.
  let isolatedSubstrate: EnsureSubstrateReadyOptions["isolated"];
  let projectSubstrate: ProjectSubstrateConfig | undefined;
  if (command && !["init", "uninstall", "upgrade"].includes(command)) {
    const swarmDir = parsed["swarm-path"] ?? ".swarm";
    const { resolveProjectName } = await import("./swarm-meta.js");
    const { prepareProjectSubstrate, ProjectSubstrateConfigError } = await import("../project-substrate.js");
    const { LocalOnlyViolation } = await import("@mnmal-ai/swarm-substrate");
    try {
      const prepared = await prepareProjectSubstrate(swarmDir, resolveProjectName(swarmDir, parsed["project"]));
      isolatedSubstrate = prepared.isolated;
      projectSubstrate = prepared.config;
    } catch (err) {
      if (err instanceof ProjectSubstrateConfigError || err instanceof LocalOnlyViolation) {
        console.error(`[swarm] ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  // --- Commands that do NOT need any query client ---
  const SUBSTRATE_SKIP_COMMANDS = new Set([
    "init", "--version", "-v", "version", "uninstall", "upgrade", "db",
    "dashboard",
    // doctor must diagnose a fully-down stack — it never calls
    // ensureSubstrateReady, so it must not trigger the auto-start path here.
    "doctor",
    // drainstop only fires the running sidecar's trigger; when the sidecar is
    // down it says so and points at `swarm substrate start`, so no auto-start.
    "drainstop",
  ]);

  // --- Commands that REQUIRE the Substrate store (no file-only fallback) ---
  // These commands use the client's mutate() or other store-only APIs.
  const SUBSTRATE_REQUIRED_COMMANDS = new Set([
    "grade-data", "sharing", "logs", "skill", "mcp",
  ]);

  let queryClient: SwarmQueryClient | undefined;
  let substrateClient: SubstrateClient | undefined;
  let isFileOnlyMode = false;

  // `substrate stop` and `substrate status` must see the stack as it is, not
  // as the startup path would leave it (see skipsSubstrateStartup).
  const skipSubstrateStartup =
    command === "substrate" && (await import("./substrate.js")).skipsSubstrateStartup(positional[0]);

  if (command && !SUBSTRATE_SKIP_COMMANDS.has(command) && !skipSubstrateStartup) {
    const swarmDir = parsed["swarm-path"] ?? ".swarm";
    const dbConfig = await resolveDbConfig({ swarmDir });

    if (dbConfig) {
      // Pass the docker-compose directory when config resolver found it, so
      // the lifecycle doesn't need to rediscover it (critical for binary
      // installs where findRepoRoot() won't find ~/.swarm/infrastructure/).
      const dockerComposeDir = dbConfig.source === "docker"
        ? dbConfig.dockerComposeDir
        : undefined;

      // The plugin tarball, the embedder (after the project's context.ranking
      // was applied above) and the all-stacks reinstall guard come from
      // ensureProjectSubstrate.
      const result = await ensureProjectSubstrate({
        quiet: parsed["quiet"] === "true",
        ...(dockerComposeDir !== undefined ? { dockerComposeDir } : {}),
        ...(isolatedSubstrate !== undefined ? { isolated: isolatedSubstrate } : {}),
      });
      if (result) {
        substrateClient = result;
        queryClient = result;

        // Auto-sync: always seed .swarm/ files into Substrate before running.
        // Uses dedup-by-key — entities that already exist are skipped,
        // so this is a fast no-op when nothing has changed.
        try {
          const { seedSwarmContent } = await import("./seed.js");
          const { resolveProjectName } = await import("./swarm-meta.js");
          const swarmPath = parsed["swarm-path"] ?? ".swarm";
          const project = resolveProjectName(swarmPath, parsed["project"]);
          if (parsed["quiet"] !== "true") {
            console.log("[swarm] Syncing .swarm/ files to Substrate...");
          }
          const counts = await seedSwarmContent(result, swarmPath, project);
          const total = counts.content + counts.routes + counts.configs;
          if (total > 0 && parsed["quiet"] !== "true") {
            console.log(`[swarm] Synced ${counts.content} content, ${counts.routes} routes, ${counts.configs} configs.`);
          }

          // Reconcile MCP servers declared in config.json into Substrate so
          // `swarm run`/`swarm mcp list` see entries authored by templates,
          // `prepare-for-swarm`, or manual edits without a separate
          // `swarm add mcp` call.
          const { reconcileMcpServers } = await import("./mcp-manage.js");
          const reconciled = await reconcileMcpServers(result, swarmPath, project);
          if (reconciled.length > 0 && parsed["quiet"] !== "true") {
            console.log(`[swarm] Registered MCP server(s) in Substrate: ${reconciled.join(", ")}`);
          }
        } catch (syncErr) {
          console.warn(`[swarm] Auto-sync skipped: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
        }
      }
    }

    if (!queryClient) {
      if (SUBSTRATE_REQUIRED_COMMANDS.has(command)) {
        console.error(
          "This command requires a database. Run `swarm db setup` to configure one.",
        );
        process.exit(1);
      }
      const swarmPath = parsed["swarm-path"] ?? ".swarm";
      queryClient = new FileQueryAdapter(swarmPath);
      isFileOnlyMode = true;
      if (parsed["quiet"] !== "true") {
        console.log("[swarm] File-only mode. Run `swarm db setup` to unlock full features.");
      }
    }
  }

  // isFileOnlyMode is set when no database is available; consumed by sub-commands in future tasks
  void isFileOnlyMode;

  switch (command) {
    case "init": {
      const { runInit } = await import("./init.js");
      await runInit(parsed);
      break;
    }
    case "add": {
      const { runAdd } = await import("./add.js");
      await runAdd(parsed, positional, substrateClient);
      break;
    }
    case "list":
    case "ls": {
      const { runList } = await import("./list.js");
      await runList(positional, parsed);
      break;
    }
    case "run": {
      const { runOrchestrator } = await import("./run.js");
      await runOrchestrator(parsed, substrateClient, queryClient);
      break;
    }
    case "merge": {
      const { runMergeCommand } = await import("./merge-command.js");
      await runMergeCommand(parsed);
      break;
    }
    case "grade-data": {
      const { runGradeData } = await import("./grade-data.js");
      await runGradeData(parsed);
      break;
    }
    case "sharing": {
      const { runSharing } = await import("./sharing.js");
      await runSharing(parsed);
      break;
    }
    case "logs": {
      const { runLogs } = await import("./logs.js");
      await runLogs(parsed, positional);
      break;
    }
    case "skill": {
      const { runSkill } = await import("./skill.js");
      await runSkill(positional, parsed, substrateClient);
      break;
    }
    case "mcp": {
      const { runMcpManage } = await import("./mcp-manage.js");
      await runMcpManage(positional, parsed, substrateClient);
      break;
    }
    case "substrate": {
      const { runSubstrate } = await import("./substrate.js");
      await runSubstrate(positional, parsed, projectSubstrate);
      break;
    }
    case "db": {
      const { runDb } = await import("./db.js");
      await runDb(positional, parsed);
      break;
    }
    case "sync": {
      if (!substrateClient) {
        console.error("Cannot sync without a database. Run `swarm db setup` first.");
        process.exit(1);
      }
      const { seedSwarmContent } = await import("./seed.js");
      const { resolveProjectName } = await import("./swarm-meta.js");
      const swarmPath = parsed["swarm-path"] ?? ".swarm";
      // Same project the auto-sync above and `swarm run` use: rows are keyed by
      // project, so syncing under a different name would write a
      // second copy instead of updating this project's rows.
      const project = resolveProjectName(swarmPath, parsed["project"]);
      const force = parsed["force"] === "true";

      if (force) {
        // Force sync: reset the cold store and re-seed from disk.
        // Required when swarm files have been edited (dedup skips existing paths).
        // There is no upsert/delete-by-field, so the only way to refresh is wipe + re-ingest.
        console.log("[swarm] Force sync — resetting database and re-seeding from disk...");
        const { runDb } = await import("./db.js");
        await runDb(["reset"], parsed);

        // Stop the stale cold sidecar — its Postgres was just wiped under it.
        const { killSidecar, waitForPostgres: waitPg, DEFAULT_DOCKER_URL } = await import("./db.js");
        await killSidecar(projectSubstrate);
        console.log("[swarm] Waiting for Postgres to be ready...");
        await waitPg(DEFAULT_DOCKER_URL, 15_000);

        // Start a fresh cold sidecar on the empty store.
        const freshClient = await ensureProjectSubstrate({ quiet: true });
        if (!freshClient) {
          console.error("[swarm] Could not reconnect after reset.");
          process.exit(1);
        }
        const { seedSwarmContentForce } = await import("./seed.js");
        const counts = await seedSwarmContentForce(freshClient, swarmPath, project);
        console.log(`[swarm] Force-synced ${counts.content} content, ${counts.routes} routes, ${counts.configs} configs.`);
        break;
      }

      console.log("[swarm] Syncing .swarm/ files to Substrate (new files only)...");
      const counts = await seedSwarmContent(substrateClient, swarmPath, project);
      if (counts.content + counts.routes + counts.configs > 0) {
        console.log(`[swarm] Synced ${counts.content} content, ${counts.routes} routes, ${counts.configs} configs.`);
      } else {
        console.log("[swarm] Everything up to date — no new files to sync.");
        console.log("[swarm] To refresh modified files, run: swarm sync --force");
      }
      break;
    }
    case "uninstall": {
      const { runUninstall } = await import("./uninstall.js");
      await runUninstall(parsed);
      break;
    }
    case "upgrade": {
      const { runUpgrade } = await import("./upgrade.js");
      await runUpgrade(parsed);
      break;
    }
    case "dashboard": {
      const { runDashboard } = await import("./dashboard.js");
      await runDashboard(parsed, positional);
      break;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(parsed);
      break;
    }
    case "drainstop": {
      const { runDrainstop } = await import("./drainstop.js");
      await runDrainstop(positional, parsed, projectSubstrate);
      break;
    }
    default:
      printHelp();
      process.exit(command ? 1 : 0);
  }

  // Short commands (skill, mcp, list, etc.) must exit explicitly.
  // Long-running commands (run) manage their own exit.
  if (command && command !== "run") {
    if (substrateClient) substrateClient.close();
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
