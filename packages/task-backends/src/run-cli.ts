import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long one tracker CLI call may run before it is killed. */
export const CLI_TIMEOUT_MS = 30_000;

export interface RunCliOptions {
  /** Directory the CLI runs in. Default: this process's. */
  cwd?: string;
  /** Written to the CLI's stdin, for commands that read it (`--input -`). */
  input?: string;
  /** The CLI's whole environment, for this call only (e.g. a GitHubCredential's
   *  env for gh). Default: inherit this process's. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a tracker CLI (gh, the project's Trello CLI) without blocking the event
 * loop, and without a shell: `args` reach the process as argv, verbatim, so
 * nothing in them is ever interpreted.
 *
 * stdin gets `input` if there is any, then EOF — never an open pipe the CLI
 * could sit waiting on — which is how the synchronous calls this replaces
 * behaved.
 *
 * Resolves with stdout. Rejects with execFile's error, whose message names
 * the command and whose `stderr` holds what the CLI printed.
 */
export async function runCli(file: string, args: readonly string[], options: RunCliOptions = {}): Promise<string> {
  const call = execFileAsync(file, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: CLI_TIMEOUT_MS,
    ...(options.env ? { env: options.env } : {}),
  });
  // A CLI that exits before reading its input raises EPIPE on stdin. Its exit
  // status and stderr already report the failure; unhandled, the EPIPE would
  // crash the process.
  call.child.stdin?.on("error", () => {});
  call.child.stdin?.end(options.input);
  const { stdout } = await call;
  return stdout;
}
