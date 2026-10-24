/**
 * `swarm codex-hook`: the command Codex runs before each tool a codex
 * session uses (worker-backends' codex.ts). A thin shell around
 * runCodexHook: read stdin, answer on stdout, exit. main.ts runs it before
 * anything else starts, so a call costs little more than process start-up.
 */

import { HOOK_FAILURE_DENY, parseCodexHookArgs, runCodexHook } from "@mnmal-ai/swarm-worker-backends";

/** A PreToolUse answer swarm gives itself before Codex's own hook timeout could pass. */
const WATCHDOG_MS = 20_000;

export async function codexHookMain(argv: string[] = process.argv.slice(3)): Promise<void> {
  const args = parseCodexHookArgs(argv);
  // Codex runs a call whose hook never answers; answer deny first.
  const watchdog =
    args.event === "PreToolUse"
      ? setTimeout(() => process.stdout.write(HOOK_FAILURE_DENY, () => process.exit(0)), WATCHDOG_MS)
      : undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  const reply = await runCodexHook(Buffer.concat(chunks).toString("utf8"), args);
  clearTimeout(watchdog);
  if (reply.stdout) await new Promise<void>((done) => process.stdout.write(reply.stdout, () => done()));
  process.exit(reply.exitCode);
}

/** How to run this swarm again: a compiled binary by itself, an npm install
 *  through node and its entry script, a source checkout through tsx. */
export function swarmSelfCommand(
  execPath: string = process.execPath,
  entry: string = process.argv[1] ?? "",
  isBun: boolean = !!process.versions.bun,
): string[] {
  if (isBun && (entry === "" || entry.startsWith("/$bunfs/"))) return [execPath];
  if (entry.endsWith(".ts")) return ["npx", "tsx", entry];
  return [execPath, entry];
}

const SAFE_WORD = /^[A-Za-z0-9_/.,:=@%+-]+$/;
const shellQuote = (s: string) => (SAFE_WORD.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The hook command line for /bin/sh: swarm's own command plus `codex-hook`. */
export function codexHookCommand(self: string[] = swarmSelfCommand()): string {
  return [...self, "codex-hook"].map(shellQuote).join(" ");
}
