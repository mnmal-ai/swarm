/**
 * swarm mcp — Substrate-backed MCP server management commands.
 *
 * Stores MCP server configurations as McpServer entities in Substrate,
 * alongside the existing config.json storage.
 *
 * Usage:
 *   swarm mcp list                          List MCP servers in Substrate
 *   swarm mcp show <name>                   Show MCP server details
 *   swarm mcp introspect <name>             Discover tools from a running MCP server
 *   swarm mcp remove <name>                 Remove MCP server from Substrate and config.json
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnInGroup, killGroup } from "@mnmal-ai/swarm-types";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";

// ANSI helpers
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// McpServer entity shape
// ---------------------------------------------------------------------------

interface McpServerEntity {
  id?: number;
  name: string;
  command: string;
  args: string;        // JSON array
  type: string;        // "stdio"
  toolCount: number;
  tools: string;       // JSON array of tool names
  projectId: string;
  lastIntrospected: string;
}

// ---------------------------------------------------------------------------
// Config.json helpers
// ---------------------------------------------------------------------------

function findConfigPath(swarmDir: string): string | null {
  const domainsDir = join(swarmDir, "domains");
  if (!existsSync(domainsDir)) return null;

  const projects = readdirSync(domainsDir).filter((d) =>
    existsSync(join(domainsDir, d, "config.json")),
  );

  if (projects.length >= 1) {
    return join(domainsDir, projects[0], "config.json");
  }
  return null;
}

// ---------------------------------------------------------------------------
// swarm mcp add (Substrate extension of add.ts)
// ---------------------------------------------------------------------------

/**
 * Store an MCP server in Substrate as a McpServer entity.
 * Called after the existing config.json write in add.ts.
 */
export async function addMcpToSubstrate(
  client: SubstrateClient,
  name: string,
  command: string,
  args: string[],
  projectId: string,
): Promise<void> {
  try {
    await client.mutate(
      "createMcpServer",
      {
        name,
        command,
        args: JSON.stringify(args),
        type: "stdio",
        toolCount: 0,
        tools: "[]",
        projectId,
        lastIntrospected: "",
      },
      { id: true },
    );
  } catch (err) {
    // Fire-and-forget — log but don't block
    console.error(`${DIM}[swarm] Failed to store MCP server in Substrate: ${(err as Error).message}${RESET}`);
  }
}

/**
 * Ensure every MCP listed in the project's config.json exists as an McpServer
 * entity in Substrate for `projectId`. Idempotent — skips any (name, projectId)
 * pair already present. Returns the list of names that were created.
 *
 * Called from `swarm init` (after first-time seed) and `swarm run` (before
 * orchestration) so config.json and Substrate stay in lockstep without a manual
 * `swarm add mcp` for entries authored by templates or `prepare-for-swarm`.
 */
export async function reconcileMcpServers(
  client: SubstrateClient,
  swarmDir: string,
  projectId: string,
): Promise<string[]> {
  const configPath = findConfigPath(swarmDir);
  if (!configPath) return [];

  let config: { backends?: Record<string, { mcpServers?: Record<string, { command?: string; args?: string[] }> }> };
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return [];
  }

  // Collect unique MCP entries across all backend roles (worker/reviewer/arbiter).
  // Same server can appear under multiple roles with identical config — dedup by name.
  const desired = new Map<string, { command: string; args: string[] }>();
  for (const backend of Object.values(config.backends ?? {})) {
    for (const [name, entry] of Object.entries(backend.mcpServers ?? {})) {
      if (!entry.command) continue;
      if (!desired.has(name)) {
        desired.set(name, { command: entry.command, args: entry.args ?? [] });
      }
    }
  }
  if (desired.size === 0) return [];

  // Figure out which of those are already in Substrate for this project.
  let existing: McpServerEntity[] = [];
  try {
    existing = await client.query<McpServerEntity>(
      "McpServer",
      {},
      { name: true, projectId: true },
    );
  } catch {
    // If the type isn't registered yet, nothing to reconcile against.
    return [];
  }
  const existingNames = new Set(
    existing.filter((e) => e.projectId === projectId).map((e) => e.name),
  );

  const created: string[] = [];
  for (const [name, { command, args }] of desired) {
    if (existingNames.has(name)) continue;
    await addMcpToSubstrate(client, name, command, args, projectId);
    created.push(name);
  }
  return created;
}

// ---------------------------------------------------------------------------
// swarm mcp list
// ---------------------------------------------------------------------------

export async function listMcp(client: SubstrateClient): Promise<void> {
  console.log("");
  console.log(`${BOLD}MCP Servers in Substrate${RESET}`);
  console.log("");

  try {
    const entities = await client.query<McpServerEntity>(
      "McpServer",
      {},
      {
        name: true,
        command: true,
        args: true,
        type: true,
        toolCount: true,
        projectId: true,
        lastIntrospected: true,
      },
    );

    if (entities.length === 0) {
      console.log(`  ${DIM}No MCP servers registered.${RESET}`);
      console.log(`  ${DIM}Add one with: ${CYAN}swarm add mcp <name> <command>${RESET}`);
      console.log("");
      return;
    }

    for (const server of entities) {
      let parsedArgs: string[] = [];
      try {
        parsedArgs = JSON.parse(server.args);
      } catch { /* empty */ }

      const cmd = [server.command, ...parsedArgs].join(" ");
      const toolCount = Number(server.toolCount ?? 0);
      const tools = toolCount > 0 ? ` ${DIM}(${toolCount} tools)${RESET}` : "";
      const project = server.projectId ? ` ${DIM}[${server.projectId}]${RESET}` : "";

      console.log(`  ${GREEN}${server.name}${RESET}  ${DIM}${cmd}${RESET}${tools}${project}`);
    }

    console.log("");
  } catch (err) {
    console.error(`${RED}Failed to query MCP servers: ${(err as Error).message}${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// swarm mcp show <name>
// ---------------------------------------------------------------------------

export async function showMcp(client: SubstrateClient, name: string): Promise<void> {
  const entities = await client.query<McpServerEntity>(
    "McpServer",
    {},
    {
      name: true,
      command: true,
      args: true,
      type: true,
      toolCount: true,
      tools: true,
      projectId: true,
      lastIntrospected: true,
    },
  );

  const match = entities.find((e) => e.name === name);

  if (!match) {
    console.error(`${RED}MCP server not found: ${name}${RESET}`);
    console.error(`${DIM}Use 'swarm mcp list' to see registered servers.${RESET}`);
    process.exit(1);
  }

  let parsedArgs: string[] = [];
  try { parsedArgs = JSON.parse(match.args); } catch { /* empty */ }

  let parsedTools: string[] = [];
  try { parsedTools = JSON.parse(match.tools); } catch { /* empty */ }

  console.log("");
  console.log(`${BOLD}${match.name}${RESET}`);
  console.log(`${DIM}Type:${RESET}       ${match.type}`);
  console.log(`${DIM}Command:${RESET}    ${match.command} ${parsedArgs.join(" ")}`);
  console.log(`${DIM}Project:${RESET}    ${match.projectId || "default"}`);
  console.log(`${DIM}Tool count:${RESET} ${Number(match.toolCount ?? 0)}`);

  if (match.lastIntrospected) {
    console.log(`${DIM}Introspected:${RESET} ${match.lastIntrospected}`);
  }

  if (parsedTools.length > 0) {
    console.log("");
    console.log(`${BOLD}Tools:${RESET}`);
    for (const tool of parsedTools) {
      console.log(`  - ${tool}`);
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// swarm mcp introspect <name>
// ---------------------------------------------------------------------------

/**
 * Start the MCP server, send a tools/list request, and store discovered tools.
 *
 * The MCP protocol uses JSON-RPC over stdio. We spawn the server process,
 * send an initialize request followed by tools/list, parse the response,
 * and update the McpServer entity.
 */
export async function introspectMcp(client: SubstrateClient, name: string): Promise<void> {
  const entities = await client.query<McpServerEntity>(
    "McpServer",
    {},
    {
      id: true,
      name: true,
      command: true,
      args: true,
      projectId: true,
    },
  );

  const match = entities.find((e) => e.name === name);

  if (!match) {
    console.error(`${RED}MCP server not found: ${name}${RESET}`);
    console.error(`${DIM}Use 'swarm mcp list' to see registered servers.${RESET}`);
    process.exit(1);
  }

  let parsedArgs: string[] = [];
  try { parsedArgs = JSON.parse(match.args); } catch { /* empty */ }

  console.log(`${DIM}Starting ${match.name} (${match.command} ${parsedArgs.join(" ")})...${RESET}`);

  try {
    const tools = await discoverTools(match.command, parsedArgs);
    const now = new Date().toISOString();

    await client.mutate(
      "updateMcpServer",
      {
        id: match.id,
        toolCount: tools.length,
        tools: JSON.stringify(tools),
        lastIntrospected: now,
      },
      { id: true },
    );

    console.log(`${GREEN}Discovered ${tools.length} tool(s):${RESET}`);
    for (const tool of tools) {
      console.log(`  - ${tool}`);
    }
  } catch (err) {
    console.error(`${YELLOW}Introspection failed: ${(err as Error).message}${RESET}`);
    console.error(`${DIM}The MCP server may not support the tools/list method, or the command may be incorrect.${RESET}`);

    // Store with toolCount=0 as a fallback
    try {
      await client.mutate(
        "updateMcpServer",
        {
          id: match.id,
          toolCount: 0,
          tools: "[]",
          lastIntrospected: new Date().toISOString(),
        },
        { id: true },
      );
    } catch {
      // Fire-and-forget
    }
  }
}

/**
 * Spawn an MCP server process and perform JSON-RPC handshake to discover tools.
 * Returns an array of tool names.
 */
async function discoverTools(command: string, args: string[]): Promise<string[]> {
  // MCP servers are user-supplied commands. We don't know what they spawn
  // internally, so we run them in their own process group and sweep the group
  // on every exit path. Without that, a misbehaving MCP server can leave
  // descendants behind that hold ports or stdio handles.
  const child = spawnInGroup(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childPid = child.pid;

  return new Promise<string[]>((resolvePromise, rejectPromise) => {
    let buffer = "";
    let initDone = false;
    let settled = false;

    const cleanup = () => {
      if (childPid !== undefined) {
        void killGroup(childPid).catch(() => {});
      }
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      action();
    };

    const timeout = setTimeout(() => {
      settle(() =>
        rejectPromise(new Error("Introspection timed out after 15 seconds")),
      );
    }, 15_000);

    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();

      // MCP uses newline-delimited JSON-RPC
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed);

          if (!initDone && msg.id === 1) {
            // Initialize response received, now request tools
            initDone = true;
            const toolsReq = JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {},
            }) + "\n";
            child.stdin!.write(toolsReq);
          } else if (msg.id === 2) {
            // tools/list response
            const tools: string[] = [];
            if (msg.result?.tools && Array.isArray(msg.result.tools)) {
              for (const tool of msg.result.tools) {
                if (typeof tool === "string") {
                  tools.push(tool);
                } else if (tool.name) {
                  tools.push(tool.name);
                }
              }
            }
            settle(() => resolvePromise(tools));
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    });

    child.stderr!.on("data", () => {
      // Ignore stderr output from server
    });

    child.on("error", (err) => {
      settle(() =>
        rejectPromise(new Error(`Failed to start MCP server: ${err.message}`)),
      );
    });

    child.on("close", (code) => {
      if (!initDone) {
        settle(() =>
          rejectPromise(new Error(`MCP server exited with code ${code} before responding`)),
        );
      } else {
        // Already settled in the id===2 branch; nothing to do here, but the
        // group sweep is idempotent so a second call is harmless.
      }
    });

    // Send initialize request
    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "swarm", version: "0.1.0" },
      },
    }) + "\n";
    child.stdin!.write(initReq);
  });
}

// ---------------------------------------------------------------------------
// swarm mcp remove <name>
// ---------------------------------------------------------------------------

export async function removeMcp(
  client: SubstrateClient,
  name: string,
  swarmDir?: string,
): Promise<void> {
  // Remove from Substrate
  const entities = await client.query<McpServerEntity>(
    "McpServer",
    {},
    {
      id: true,
      name: true,
    },
  );

  const match = entities.find((e) => e.name === name);

  if (!match) {
    console.error(`${RED}MCP server not found in Substrate: ${name}${RESET}`);
    console.error(`${DIM}Use 'swarm mcp list' to see registered servers.${RESET}`);
    process.exit(1);
  }

  try {
    await client.mutate(
      "deleteMcpServer",
      { id: match.id },
      { id: true },
    );
    console.log(`${GREEN}Removed from Substrate:${RESET} ${name}`);
  } catch (err) {
    console.error(`${RED}Failed to remove from Substrate: ${(err as Error).message}${RESET}`);
  }

  // Also remove from config.json if swarmDir is available
  const dir = swarmDir ?? resolve(process.cwd(), ".swarm");
  const configPath = findConfigPath(dir);

  if (configPath && existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config?.backends?.worker?.mcpServers?.[name]) {
        delete config.backends.worker.mcpServers[name];
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log(`${GREEN}Removed from config.json:${RESET} ${name}`);
      }
    } catch {
      // Config removal is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export async function runMcpManage(
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
    case "list":
    case "ls":
      await listMcp(client);
      break;
    case "show":
      if (!rest[0]) {
        console.error("Usage: swarm mcp show <name>");
        process.exit(1);
      }
      await showMcp(client, rest[0]);
      break;
    case "introspect":
      if (!rest[0]) {
        console.error("Usage: swarm mcp introspect <name>");
        process.exit(1);
      }
      await introspectMcp(client, rest[0]);
      break;
    case "remove":
    case "rm":
      if (!rest[0]) {
        console.error("Usage: swarm mcp remove <name>");
        process.exit(1);
      }
      await removeMcp(client, rest[0], flags["dir"]);
      break;
    default:
      console.log("Usage: swarm mcp <command>");
      console.log("");
      console.log("Commands:");
      console.log("  list                  List MCP servers stored in Substrate");
      console.log("  show <name>           Show MCP server details and tools");
      console.log("  introspect <name>     Discover tools from a running MCP server");
      console.log("  remove <name>         Remove MCP server from Substrate and config.json");
      process.exit(subcommand ? 1 : 0);
  }

  // Close the client before the process exits
  client.close();
}
