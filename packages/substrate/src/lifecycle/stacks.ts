/**
 * Stack directories: one `SUBSTRATE_PLUGIN_DIR` per sidecar, under
 * ~/.swarm/substrate/stacks/. The shared stack's are `<label>/` (`cold`,
 * `meta`); a project's dedicated stack's are `<compose_project>-<label>/`.
 *
 * Each holds what Substrate's plugin loader reads:
 *   - `package.json` — the plugins this sidecar runs (`dependencies`):
 *     `@mnmal-ai/substrate` (recall and proposals), the swarm plugin, and, for
 *     the cold stack, `@mnmal-ai/cortext`, the context store the drainstop
 *     promotes into;
 *   - `swarm.config.json` — the swarm plugin's config (its `configBasename`
 *     is `swarm`): `{ scope, namespace, contextNamespace }`;
 *   - `substrate-recall.config.json` — the embedder, absent when there is none;
 *   - `cortext.config.json` — only when the context namespace is not cortext's
 *     own default (`cortext`);
 *   - `node_modules` — a symlink to the runtime's, so every stack runs the one
 *     installed copy of each package.
 *
 * The sidecar's `server.log` and `server.pid` live here too (`sidecar.ts`).
 */
import { SWARM_NAMESPACE } from "@mnmal-ai/swarm-substrate-shared";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbedderSettings } from "../embedder-settings.js";
import { PLUGIN_PACKAGE_NAME, substrateHome } from "./runtime.js";
import type { SidecarSpec } from "./specs.js";

/** cortext's own default namespace (its `default-config.json`). */
const CORTEXT_DEFAULT_NAMESPACE = "cortext";

/** A write's embed may wait this long for the embedder before the row is stored without a vector. */
export const WRITE_EMBED_TIMEOUT_MS = 120_000;

/** ~/.swarm/substrate/stacks */
export function stacksRoot(): string {
  return join(substrateHome(), "stacks");
}

/** What a dedicated stack's name (its compose project) may contain, as one path segment. */
const STACK_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The stack directory for `spec`: `<stacks>/<label>` or `<stacks>/<stack>-<label>`.
 * Throws when `spec.stack` is not a plain name (`[A-Za-z0-9._-]+`), so a
 * project's compose project can never name a path outside the stacks root.
 */
export function stackDirFor(spec: Pick<SidecarSpec, "label" | "stack">): string {
  if (spec.stack === undefined) return join(stacksRoot(), spec.label);
  if (!STACK_NAME.test(spec.stack)) {
    throw new Error(
      `Invalid Substrate stack name ${JSON.stringify(spec.stack)}: a dedicated stack is named by its compose project, ` +
        "which may contain only letters, digits, '.', '_' and '-'.",
    );
  }
  return join(stacksRoot(), `${spec.stack}-${spec.label}`);
}

export interface EnsureStackDirOptions {
  /** The runtime whose `node_modules` the stack links to. */
  runtimeDir: string;
  embedder: EmbedderSettings;
  /** The context-store namespace the drainstop promotes into (cortext's namespace). */
  contextNamespace: string;
}

/** The base swarm namespace a spec's plugin config names (`swarm_meta` → `swarm`). */
function baseNamespace(spec: SidecarSpec): string {
  if (spec.scope === "meta") {
    return spec.namespace.endsWith("_meta") ? spec.namespace.slice(0, -"_meta".length) : SWARM_NAMESPACE;
  }
  return spec.namespace;
}

/** Write `value` as JSON to `path` unless the file already holds exactly that. */
function writeJson(path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {
    /* absent */
  }
  writeFileSync(path, text, { mode: 0o600 });
}

/** Point `<dir>/node_modules` at `target`, replacing a symlink that names anything else. */
function linkNodeModules(dir: string, target: string): void {
  const link = join(dir, "node_modules");
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(link);
  } catch {
    stat = undefined;
  }
  if (stat?.isSymbolicLink()) {
    if (readlinkSync(link) === target) return;
    unlinkSync(link);
  } else if (stat !== undefined) {
    // A real directory: a per-stack install someone made on purpose. Leave it;
    // ensureSidecar refuses to start from it and says how to clear it
    // (runtimeLinkProblem).
    return;
  }
  symlinkSync(target, link, "dir");
}

/**
 * Create or refresh `spec`'s stack directory (see the module doc) and return
 * its path. Idempotent: unchanged files are not rewritten, and files this
 * module does not own (`server.log`, `server.pid`) are left alone.
 */
export function ensureStackDir(spec: SidecarSpec, opts: EnsureStackDirOptions): string {
  const dir = stackDirFor(spec);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const isCold = spec.scope === "cold";
  writeJson(join(dir, "package.json"), {
    private: true,
    dependencies: {
      "@mnmal-ai/substrate": "*",
      [PLUGIN_PACKAGE_NAME]: "*",
      ...(isCold ? { "@mnmal-ai/cortext": "*" } : {}),
    },
  });
  writeJson(join(dir, "swarm.config.json"), {
    scope: spec.scope,
    namespace: baseNamespace(spec),
    contextNamespace: opts.contextNamespace,
  });

  const recallConfig = join(dir, "substrate-recall.config.json");
  if (opts.embedder.kind === "none") {
    rmSync(recallConfig, { force: true });
  } else {
    writeJson(recallConfig, {
      embedder: {
        kind: "ollama",
        baseUrl: opts.embedder.baseUrl,
        model: opts.embedder.model,
        dimension: opts.embedder.dimension,
      },
      writeEmbedTimeoutMs: WRITE_EMBED_TIMEOUT_MS,
      queryEmbedTimeoutMs: opts.embedder.timeoutMs,
    });
  }

  const cortextConfig = join(dir, "cortext.config.json");
  if (isCold && opts.contextNamespace !== CORTEXT_DEFAULT_NAMESPACE) {
    writeJson(cortextConfig, { namespace: opts.contextNamespace });
  } else if (existsSync(cortextConfig)) {
    rmSync(cortextConfig, { force: true });
  }

  linkNodeModules(dir, join(opts.runtimeDir, "node_modules"));
  return dir;
}
