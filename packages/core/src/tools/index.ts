/**
 * Built-in tools for the agentic execution loop.
 *
 * Provides file system operations and shell command execution so the model
 * can read, write, list, and run commands within a working directory.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { once } from "node:events";
import {
  spawnInGroup, killGroup, gitIdentityEnvVars, withoutGitHubAccess, defaultWorkerGhConfigDir,
  type ToolDefinition, type GitIdentity,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to return from read_file. */
const READ_FILE_MAX_BYTES = 100 * 1024; // 100 KB

/** Maximum bytes to return from run_command output. */
const RUN_COMMAND_MAX_BYTES = 50 * 1024; // 50 KB

/** Timeout for run_command in milliseconds. */
const RUN_COMMAND_TIMEOUT_MS = 120_000; // 120 seconds

/** After a command exits, how long run_command waits for the rest of its
 *  output: the pipes are read separately from the exit. */
const RUN_COMMAND_DRAIN_MS = 2_000;

/** Environment variables allowed through to child processes. */
const ALLOWED_ENV_VARS = new Set([
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "NODE_PATH", "NPM_CONFIG_PREFIX",
  "TMPDIR", "TMP", "TEMP", "SHELL", "TERM",
  "DEVELOPER_DIR", "SDKROOT", "XCODE_SELECT",
  "SWIFT_VERSION", "TOOLCHAINS",
]);

// ---------------------------------------------------------------------------
// Sandbox helper — prevents path traversal outside the working directory
// ---------------------------------------------------------------------------

async function enforceSandbox(workingDirectory: string, requestedPath: string): Promise<{ resolved: string; error?: string }> {
  const base = path.resolve(workingDirectory);
  const resolved = path.resolve(base, requestedPath);

  // Lexical check first (fast, catches obvious traversal)
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { resolved, error: `Access denied: path "${requestedPath}" escapes the working directory.` };
  }

  // Follow symlinks to get the real path and re-check
  try {
    const real = await fs.realpath(resolved);
    const realRelative = path.relative(base, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return { resolved, error: `Access denied: path "${requestedPath}" resolves outside the working directory via symlink.` };
    }
  } catch {
    // ENOENT is acceptable for write targets that don't exist yet.
    // NOTE: This creates a narrow TOCTOU window for writes — if a symlink is placed
    // at the resolved path between this check and the eventual fs.writeFile, the write
    // will follow the symlink outside the sandbox. Exploiting this requires the model
    // to have already executed a run_command to create the symlink, so it's a limited
    // escalation. A future hardening pass could use O_NOFOLLOW or atomic rename.
  }

  return { resolved };
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic format)
// ---------------------------------------------------------------------------

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the text content. " +
      "Path is resolved relative to the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read (relative or absolute).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if needed. " +
      "Path is resolved relative to the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write (relative or absolute).",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description:
      "List the contents of a directory. Returns file and directory names, " +
      "with a trailing / for directories. Path is resolved relative to the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the directory to list (relative or absolute).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command. Returns stdout and stderr. " +
      "Times out after 120 seconds. Output is truncated at 50KB.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        working_directory: {
          type: "string",
          description:
            "Optional working directory override for this command. " +
            "If not provided, uses the session working directory.",
        },
      },
      required: ["command"],
    },
  },
];

export function getBuiltinTools(): ToolDefinition[] {
  return BUILTIN_TOOLS;
}

// ---------------------------------------------------------------------------
// Tool execution dispatcher
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  workingDirectory: string,
  options?: {
    /** Author and committer for commits made through run_command. */
    gitIdentity?: GitIdentity;
    /** Empty GH_CONFIG_DIR for run_command's shell (no GitHub access).
     *  Default: a per-process empty directory. */
    ghConfigDir?: string;
  },
): Promise<{ content: string; is_error: boolean }> {
  try {
    switch (name) {
      case "read_file":
        return await handleReadFile(
          input.path as string,
          workingDirectory,
        );
      case "write_file": {
        const content = input.content;
        if (content === undefined || content === null || typeof content !== "string") {
          return {
            content: `Error writing file: 'content' parameter is missing or not a string. Received type: ${typeof content}`,
            is_error: true,
          };
        }
        return await handleWriteFile(
          input.path as string,
          content,
          workingDirectory,
        );
      }
      case "list_directory":
        return await handleListDirectory(
          input.path as string,
          workingDirectory,
        );
      case "run_command": {
        // Validate working_directory override against sandbox
        let cwd = workingDirectory;
        const overrideDir = input.working_directory as string | undefined;
        if (overrideDir) {
          const check = await enforceSandbox(workingDirectory, overrideDir);
          if (check.error) {
            return { content: check.error, is_error: true };
          }
          cwd = check.resolved;
        }
        return await handleRunCommand(
          input.command as string,
          cwd,
          options?.gitIdentity,
          options?.ghConfigDir,
        );
      }
      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Tool error: ${message}`, is_error: true };
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleReadFile(
  filePath: string,
  workingDirectory: string,
): Promise<{ content: string; is_error: boolean }> {
  const check = await enforceSandbox(workingDirectory, filePath);
  if (check.error) {
    return { content: check.error, is_error: true };
  }
  const resolved = check.resolved;

  try {
    // Check if file exists and get stats
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) {
      return {
        content: `Error: ${filePath} is a directory, not a file. Use list_directory instead.`,
        is_error: true,
      };
    }

    // Read first chunk to check for binary content
    const handle = await fs.open(resolved, "r");
    try {
      const checkBuffer = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(checkBuffer, 0, 1024, 0);

      // Check for null bytes (binary indicator)
      for (let i = 0; i < bytesRead; i++) {
        if (checkBuffer[i] === 0) {
          return {
            content: "Binary file, cannot display",
            is_error: false,
          };
        }
      }
    } finally {
      await handle.close();
    }

    // Read the full file as text
    const content = await fs.readFile(resolved, "utf-8");

    // Truncate if too large
    if (Buffer.byteLength(content, "utf-8") > READ_FILE_MAX_BYTES) {
      const truncated = Buffer.from(content, "utf-8")
        .subarray(0, READ_FILE_MAX_BYTES)
        .toString("utf-8");
      return {
        content: truncated + "\n\n[Truncated at 100KB]",
        is_error: false,
      };
    }

    return { content, is_error: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: `File not found: ${filePath}`, is_error: true };
    }
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      return { content: `Permission denied: ${filePath}`, is_error: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error reading file: ${message}`, is_error: true };
  }
}

async function handleWriteFile(
  filePath: string,
  content: string,
  workingDirectory: string,
): Promise<{ content: string; is_error: boolean }> {
  const check = await enforceSandbox(workingDirectory, filePath);
  if (check.error) {
    return { content: check.error, is_error: true };
  }
  const resolved = check.resolved;

  try {
    // Create parent directories if they don't exist
    await fs.mkdir(path.dirname(resolved), { recursive: true });

    // Write the file
    await fs.writeFile(resolved, content, "utf-8");

    return {
      content: `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${filePath}`,
      is_error: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error writing file: ${message}`, is_error: true };
  }
}

async function handleListDirectory(
  dirPath: string,
  workingDirectory: string,
): Promise<{ content: string; is_error: boolean }> {
  const check = await enforceSandbox(workingDirectory, dirPath);
  if (check.error) {
    return { content: check.error, is_error: true };
  }
  const resolved = check.resolved;

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    const lines = entries
      .sort((a, b) => {
        // Directories first, then files, alphabetical within each group
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

    if (lines.length === 0) {
      return { content: "(empty directory)", is_error: false };
    }

    return { content: lines.join("\n"), is_error: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: `Directory not found: ${dirPath}`, is_error: true };
    }
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { content: `Not a directory: ${dirPath}`, is_error: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error listing directory: ${message}`, is_error: true };
  }
}

/**
 * WARNING: This tool grants full shell access scoped to the host user.
 * The model-controlled command string is passed directly to exec() in shell mode.
 * Safety depends on the model following swarm context instructions (core/rules.md),
 * NOT on SDK-level command sanitization. The environment is restricted to
 * ALLOWED_ENV_VARS, but the shell itself has full access to the filesystem, network,
 * and any process the host user can reach. It gets no GitHub access: no token
 * variable, and GH_CONFIG_DIR set to an empty directory so gh finds no login.
 *
 * Future hardening: execFile with structured command representation would eliminate
 * shell injection if a command allowlist is ever added.
 */
async function handleRunCommand(
  command: string,
  workingDirectory: string,
  gitIdentity?: GitIdentity,
  ghConfigDir?: string,
): Promise<{ content: string; is_error: boolean }> {
  const env = withoutGitHubAccess(
    {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => ALLOWED_ENV_VARS.has(key)),
      ),
      // Exactly the four GIT_AUTHOR_*/GIT_COMMITTER_* vars when an identity is
      // configured, so a commit the model makes is authored and committed as it.
      ...gitIdentityEnvVars(gitIdentity),
    },
    ghConfigDir ?? defaultWorkerGhConfigDir(),
  );

  // POSIX process group at spawn time + group sweep on every exit path. The
  // built-in run_command tool gives the model a raw shell, so anything it
  // invokes can spawn descendants (test runners, dev servers, watchers).
  // Without group-level cleanup, those descendants outlive the tool call and
  // the next call inherits a polluted environment.
  const child = spawnInGroup("sh", ["-c", command], {
    cwd: workingDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid === undefined) {
    return { content: "Failed to start command: no pid", is_error: true };
  }
  const pid = child.pid;
  // Both pipes closed and the process gone: only then is the output complete.
  const closed = once(child, "close").catch(() => undefined);

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const cap = RUN_COMMAND_MAX_BYTES;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutBytes >= cap) return;
    const slice = stdoutBytes + chunk.length > cap ? chunk.subarray(0, cap - stdoutBytes) : chunk;
    stdout += slice.toString("utf-8");
    stdoutBytes += slice.length;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes >= cap) return;
    const slice = stderrBytes + chunk.length > cap ? chunk.subarray(0, cap - stderrBytes) : chunk;
    stderr += slice.toString("utf-8");
    stderrBytes += slice.length;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killGroup(pid).catch(() => {});
  }, RUN_COMMAND_TIMEOUT_MS);

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  try {
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    exitCode = code;
    exitSignal = signal;
  } finally {
    clearTimeout(timer);
    await killGroup(pid).catch(() => {});
  }
  // `exit` can arrive before the last of the output, which is read from the
  // pipes on its own. Wait for them to close (the group is killed, so they
  // do), but never long: a descendant that left the group can hold one open.
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise((resolve) => { drainTimer = setTimeout(resolve, RUN_COMMAND_DRAIN_MS); })]);
  clearTimeout(drainTimer);

  if (spawnError) {
    return { content: `Failed to start command: ${(spawnError as Error).message}`, is_error: true };
  }

  let output = stdout;
  if (stderr) {
    if (output) output += "\n";
    output += `[stderr]\n${stderr}`;
  }
  // Truncate if the combined output exceeds the cap (each stream is already
  // capped individually, but the combined `[stderr]\n` framing can push us
  // slightly over).
  if (Buffer.byteLength(output, "utf-8") > RUN_COMMAND_MAX_BYTES) {
    output =
      Buffer.from(output, "utf-8")
        .subarray(0, RUN_COMMAND_MAX_BYTES)
        .toString("utf-8") + "\n\n[Truncated at 50KB]";
  }

  if (timedOut) {
    return {
      content: output
        ? `${output}\n\n[Command timed out after 120s]`
        : "[Command timed out after 120s]",
      is_error: true,
    };
  }
  if (exitSignal) {
    return {
      content: output
        ? `${output}\n\n[Command killed by ${exitSignal}]`
        : `[Command killed by ${exitSignal}]`,
      is_error: true,
    };
  }
  if (exitCode !== 0) {
    return { content: output || `Command failed with exit code ${exitCode}`, is_error: true };
  }
  return { content: output || "(no output)", is_error: false };
}
