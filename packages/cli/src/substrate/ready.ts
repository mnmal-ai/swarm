/**
 * The CLI's one way into the Substrate lifecycle. Every bring-up (the command
 * preamble, `swarm init`, `swarm sync --force`, `swarm substrate start`) calls
 * `ensureProjectSubstrate`, which adds what only the CLI knows to the
 * caller's options:
 *
 *   - `pluginTarball`: the swarm plugin the CLI carries, so a missing or
 *     outdated runtime is installed from it;
 *   - `embedder`: the SWARM_EMBEDDER_* settings, after the project's
 *     `context.ranking` was applied to the environment;
 *   - `beforeReinstall`: stop every stack on this machine, not only the ones
 *     being ensured, before a reinstall replaces the runtime's node_modules —
 *     another project's dedicated stack runs from the same runtime.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ensureSubstrateReady,
  processInfo,
  type EnsureSubstrateReadyOptions,
  resolveEmbedderSettings,
  SIDECAR_SPECS,
  type SidecarSpec,
  stacksRoot,
  stopSidecar,
  type StopSidecarOptions,
  type StopSidecarResult,
  type SubstrateClient,
} from "@mnmal-ai/swarm-substrate";
import { type PluginTarball, resolvePluginTarball } from "./plugin-asset.js";

export interface StopAllStacksOptions {
  /** Default ~/.swarm/substrate/stacks. */
  root?: string;
  /** Default `stopSidecar`, which signals only a pid it verifies is that stack's sidecar. */
  stop?: (spec: SidecarSpec, opts: StopSidecarOptions) => Promise<StopSidecarResult>;
  /** Whether a pid is a live process. Default `processInfo(pid).alive`. */
  isAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

/** A stop result that only says nothing was running (no pid file, an empty one, or a pid that had exited). */
export function nothingRunning(result: StopSidecarResult): boolean {
  return !result.stopped && (result.reason === "no server.pid" || result.reason === "not running" || result.reason === "server.pid holds no pid");
}

/**
 * A runtime reinstall would replace `node_modules` under sidecars that are
 * still running, or under stacks whose state could not be read. Thrown by
 * {@link stopAllStacks} from the reinstall hook, so the install stops before
 * anything is removed.
 */
export class RuntimeReinstallBlockedError extends Error {
  override readonly name = "RuntimeReinstallBlockedError";
  constructor(readonly blocked: ReadonlyArray<{ stack: string; reason: string }>) {
    super(
      "The Substrate runtime was not updated: it would replace node_modules under sidecars that could not be stopped:\n" +
        blocked.map((b) => `  - ${b.stack}: ${b.reason}`).join("\n") +
        "\nStop those processes (or fix what is named above) and run the command again.",
    );
  }
}

/** The label a stack directory's name carries: `cold`, `meta`, `<stack>-cold`, `<stack>-meta`. */
function labelOf(name: string): SidecarSpec["label"] {
  return name === "meta" || name.endsWith("-meta") ? "meta" : "cold";
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stop the sidecar of every stack directory under the stacks root that has a
 * `server.pid` (the shared pair and every project's dedicated pair), before the
 * shared runtime is reinstalled. Fails closed: a stack whose sidecar is still
 * alive after the stop, whose stop threw, or whose directory or pid file could
 * not be read is collected, every reason is logged, and
 * {@link RuntimeReinstallBlockedError} is thrown naming them all. Only a
 * missing stacks root (no stacks yet) and stacks with no pid file pass silently.
 */
export async function stopAllStacks(opts: StopAllStacksOptions = {}): Promise<StopSidecarResult[]> {
  const root = opts.root ?? stacksRoot();
  const stop = opts.stop ?? stopSidecar;
  const isAlive = opts.isAlive ?? ((pid: number) => processInfo(pid).alive);
  const log = opts.log ?? ((line: string) => console.log(line));
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return [];
    throw new RuntimeReinstallBlockedError([{ stack: root, reason: `the stacks directory could not be read (${messageOf(err)})` }]);
  }
  const results: StopSidecarResult[] = [];
  const blocked: Array<{ stack: string; reason: string }> = [];
  for (const name of names) {
    const stackDir = join(root, name);
    try {
      statSync(join(stackDir, "server.pid"));
    } catch (err) {
      if (errnoOf(err) === "ENOENT") continue; // never started, or stopped cleanly
      blocked.push({ stack: name, reason: `its server.pid could not be read (${messageOf(err)})` });
      continue;
    }
    // stopSidecar reads only the stack directory and the pid in it; the spec
    // supplies the label, and the directory is given explicitly.
    const base = SIDECAR_SPECS.find((s) => s.label === labelOf(name)) as SidecarSpec;
    let result: StopSidecarResult;
    try {
      result = await stop({ ...base }, { stackDir });
    } catch (err) {
      blocked.push({ stack: name, reason: `stopping it failed (${messageOf(err)})` });
      continue;
    }
    results.push(result);
    if (result.stopped) {
      log(`[swarm] Stopped the ${name} sidecar (pid ${result.pid}) to update the Substrate runtime.`);
    } else if (nothingRunning(result)) {
      continue;
    } else if (result.pid !== null && isAlive(result.pid)) {
      blocked.push({ stack: name, reason: `pid ${result.pid} is still running: ${result.reason ?? "it was not stopped"}` });
    } else {
      log(`[swarm] The ${name} sidecar was not running (${result.reason ?? "no reason given"}).`);
    }
  }
  if (blocked.length > 0) {
    for (const b of blocked) log(`[swarm] Could not stop the ${b.stack} sidecar before updating the Substrate runtime: ${b.reason}`);
    throw new RuntimeReinstallBlockedError(blocked);
  }
  return results;
}

/** What `substrateReadyOptions` needs from the machine; injected by tests. */
export interface ReadyOptionDeps {
  resolvePluginTarball: () => Promise<PluginTarball>;
  env: NodeJS.ProcessEnv;
  stopAllStacks: (opts: StopAllStacksOptions) => Promise<StopSidecarResult[]>;
}

const machineDeps = (): ReadyOptionDeps => ({ resolvePluginTarball, env: process.env, stopAllStacks });

/**
 * `base` plus the plugin tarball, the embedder and the all-stacks reinstall
 * guard (see the module doc). A tarball the CLI cannot find is reported and
 * left out: an installed runtime still serves, and the lifecycle says what to
 * do when there is none. A malformed SWARM_EMBEDDER_* setting throws.
 */
export async function substrateReadyOptions(
  base: EnsureSubstrateReadyOptions,
  deps: ReadyOptionDeps = machineDeps(),
): Promise<EnsureSubstrateReadyOptions> {
  const embedder = resolveEmbedderSettings(deps.env);
  let pluginTarball: string | undefined;
  try {
    pluginTarball = (await deps.resolvePluginTarball()).path;
  } catch (err) {
    if (!base.quiet) {
      console.warn(
        `[swarm] The Substrate plugin this CLI carries could not be found (${err instanceof Error ? err.message : String(err)}); ` +
          "an installed Substrate runtime is used as it is.",
      );
    }
  }
  return {
    ...base,
    ...(pluginTarball !== undefined ? { pluginTarball } : {}),
    embedder,
    beforeReinstall: async () => {
      await deps.stopAllStacks({ log: (line) => (base.quiet ? undefined : console.log(line)) });
    },
  };
}

/** `ensureSubstrateReady` with the CLI's options (see the module doc). */
export async function ensureProjectSubstrate(base: EnsureSubstrateReadyOptions): Promise<SubstrateClient | null> {
  return ensureSubstrateReady(await substrateReadyOptions(base));
}
