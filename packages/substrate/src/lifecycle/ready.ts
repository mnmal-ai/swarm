/**
 * Bringing the swarm's Substrate stack up and checking it serves what swarm
 * needs.
 *
 * `ensureSubstrateReady` is the one entry point the CLI calls before a
 * command: it resolves the cold endpoint, and
 *   - when the endpoint is not one of swarm's own sidecars (another host, or a
 *     loopback port other than the cold spec's), it only checks it — swarm never
 *     spawns a sidecar for a server someone else runs;
 *   - otherwise it leaves healthy sidecars alone and brings up what is missing:
 *     the Postgres pair (machine-wide compose files, or a project's dedicated
 *     compose file), the Node runtime, each stack directory, each sidecar.
 * Either way it verifies the schema (`ensureTypesRegistered`) and returns a
 * client for the cold store, or null when no database is available.
 *
 * Every step is bounded on its own (a 2 s Postgres probe, compose's own
 * timeouts, 15 s per sidecar boot, npm's install timeout), so there is no
 * overall race timer to leak.
 */
import {
  SWARM_META_TYPE_NAMES,
  SWARM_TYPE_NAMES,
  docsNamespaceFor,
} from "@mnmal-ai/swarm-substrate-shared";
import { SubstrateClient, type SubstrateSchema } from "../client.js";
import { type EmbedderSettings, resolveEmbedderSettings } from "../embedder-settings.js";
import { isLocalOnlyEnv, isLoopbackHost } from "../local-only.js";
import { assertLocalOnly, resolveMetaEndpoint, resolveSubstrateEndpointWithSource } from "./endpoint.js";
import {
  type DedicatedPostgres,
  ensureDedicatedPostgres,
  ensurePostgres,
  isMemoryStore,
  probePostgresReachable,
  resolveComposeDir,
} from "./postgres.js";
import {
  CORTEXT_VERSION,
  defaultRuntimeDir,
  ensureRuntimeInstalled,
  findInstalledRuntime,
  type RuntimeInfo,
  resolveNode,
  SUBSTRATE_VERSION,
} from "./runtime.js";
import { ensureSidecar, readSidecarPid, type SidecarStatus, sidecarHealthy, stopSidecar } from "./sidecar.js";
import { resolveSidecarSpecs, type SidecarSpec, sidecarUrl, specFor } from "./specs.js";
import { ensureStackDir, stackDirFor } from "./stacks.js";

/** The custom query ops the swarm plugin registers on the swarm namespace. */
export const SWARM_QUERY_OPS = ["loadContext", "classifyIntent", "prepareTask"] as const;
/** The custom mutation the swarm plugin registers on the swarm namespace. */
export const SWARM_MUTATION_OPS = ["persistTaskTelemetry"] as const;
/** The documents namespace's types. */
export const SWARM_DOCS_TYPE_NAMES = ["Document", "Section"] as const;
/** The context-store namespace cortext serves and the drainstop promotes into. */
export const DEFAULT_CONTEXT_NAMESPACE = "cortext";

function log(quiet: boolean, message: string): void {
  if (!quiet) console.log(message);
}

// --- Schema checks ---

interface ExpectedNamespace {
  ns: string;
  types: readonly string[];
  queries: readonly string[];
  mutations: readonly string[];
}

/** What a sidecar for `spec` must publish. */
function expectedNamespaces(spec: SidecarSpec): ExpectedNamespace[] {
  if (spec.scope === "meta") {
    return [{ ns: spec.namespace, types: SWARM_META_TYPE_NAMES, queries: [], mutations: [] }];
  }
  return [
    { ns: spec.namespace, types: SWARM_TYPE_NAMES, queries: SWARM_QUERY_OPS, mutations: SWARM_MUTATION_OPS },
    { ns: docsNamespaceFor(spec.namespace), types: SWARM_DOCS_TYPE_NAMES, queries: [], mutations: [] },
  ];
}

function describeSpecs(specs: readonly SidecarSpec[]): string {
  return specs.map((s) => `${s.label}, port ${s.port}`).join("; ");
}

/**
 * Check that `client`'s sidecar publishes everything `specs` need, read from
 * `GET /substrate/v1/schema/<ns>`: for a cold spec the swarm namespace's types
 * plus the four custom ops (the three query ops under `types` or `queries`,
 * `persistTaskTelemetry` under `mutations`) and the docs namespace's types; for
 * a meta spec the meta types. Throws naming every missing namespace, type and
 * op, and the sidecar.
 */
export async function ensureTypesRegistered(
  client: Pick<SubstrateClient, "getSchema" | "invalidateSchema">,
  specs: readonly SidecarSpec[],
  quiet = true,
): Promise<void> {
  const where = `Substrate sidecar (${describeSpecs(specs)})`;
  log(quiet, `[swarm] Checking swarm types on ${where}...`);
  client.invalidateSchema();
  let schema: SubstrateSchema;
  try {
    schema = await client.getSchema();
  } catch (err) {
    throw new Error(
      `${where} does not serve the namespaces swarm needs: ${err instanceof Error ? err.message : String(err)}. ` +
        "Restart it (swarm substrate stop, then swarm substrate start) and check its server.log.",
    );
  }

  const problems: string[] = [];
  let typeCount = 0;
  let opCount = 0;
  for (const spec of specs) {
    for (const expected of expectedNamespaces(spec)) {
      const got = schema.namespaces[expected.ns];
      if (got === undefined) {
        problems.push(`namespace '${expected.ns}'`);
        continue;
      }
      const missingTypes = expected.types.filter((t) => !(t in got.types));
      if (missingTypes.length > 0) problems.push(`types ${missingTypes.map((t) => `${expected.ns}/${t}`).join(", ")}`);
      const missingOps = [
        ...expected.queries.filter((q) => !(q in got.types) && !(q in got.queries)).map((q) => `${q} (query)`),
        ...expected.mutations.filter((m) => !(m in got.mutations)).map((m) => `${m} (mutation)`),
      ];
      if (missingOps.length > 0) problems.push(`custom ops ${missingOps.map((o) => `${expected.ns}/${o}`).join(", ")}`);
      typeCount += expected.types.length;
      opCount += expected.queries.length + expected.mutations.length;
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${where} is missing ${problems.join("; ")}. The swarm plugin registers these when the sidecar boots: ` +
        `restart it (swarm substrate stop, then swarm substrate start) and check server.log in ${specs.map((s) => stackDirFor(s)).join(", ")}.`,
    );
  }
  log(quiet, `[swarm] Checking swarm types... ${typeCount} types and ${opCount} custom ops registered`);
}

/** Whether `GET <url>/substrate/v1/schema/<namespace>` answers 200 (2 s timeout, false on any failure). */
export async function probeNamespaceSchema(url: string, namespace: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/substrate/v1/schema/${encodeURIComponent(namespace)}`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Sidecars ---

export interface EnsureAllSidecarsOptions {
  /** Default: `resolveSidecarSpecs()` (the machine-wide pair with the environment applied). */
  specs?: readonly SidecarSpec[];
  /**
   * The swarm plugin tarball. When given, the runtime is installed (or found
   * already installed) for it; when omitted, an installed runtime must exist.
   */
  pluginTarball?: string;
  /** Default ~/.swarm/substrate/runtime. */
  runtimeDir?: string;
  /** Default: `resolveEmbedderSettings(process.env)`. */
  embedder?: EmbedderSettings;
  /** Default `cortext`. */
  contextNamespace?: string;
  bootTimeoutMs?: number;
  /**
   * Runs before an install replaces an existing runtime's `node_modules`.
   * Default: stop the sidecars of `specs`. A caller whose machine may run
   * other stacks from the same runtime (another project's dedicated stack)
   * passes a hook that stops those too.
   */
  beforeReinstall?: () => Promise<void> | void;
}

/** No runtime installed and no tarball to install one from. */
export class SubstrateRuntimeMissingError extends Error {
  override readonly name = "SubstrateRuntimeMissingError";
  constructor(readonly runtimeDir: string) {
    super(
      `The Substrate runtime is not installed in ${runtimeDir}. Run \`swarm substrate start\`, which installs it.`,
    );
  }
}

async function prepareRuntime(
  opts: Pick<EnsureAllSidecarsOptions, "pluginTarball" | "runtimeDir" | "beforeReinstall">,
  nodePath: string,
  quiet: boolean,
  specs: readonly SidecarSpec[],
): Promise<RuntimeInfo> {
  const runtimeDir = opts.runtimeDir ?? defaultRuntimeDir();
  if (opts.pluginTarball !== undefined) {
    return ensureRuntimeInstalled({
      runtimeDir,
      pluginTarball: opts.pluginTarball,
      substrateVersion: SUBSTRATE_VERSION,
      cortextVersion: CORTEXT_VERSION,
      quiet,
      nodePath,
      // A reinstall removes node_modules: never under a live sidecar of these
      // stacks (or, with the caller's hook, of any stack it knows about).
      beforeReinstall:
        opts.beforeReinstall ??
        (async () => {
          for (const spec of specs) {
            const result = await stopSidecar(spec);
            if (result.stopped) log(quiet, `[swarm] Stopped the ${spec.label} sidecar (pid ${result.pid}) to update the Substrate runtime.`);
          }
        }),
    });
  }
  const installed = findInstalledRuntime(runtimeDir);
  if (installed === null) throw new SubstrateRuntimeMissingError(runtimeDir);
  return installed;
}

/**
 * Bring every sidecar in `specs` up, in order: a healthy one is left alone, a
 * missing one gets its stack directory written and is spawned. Node and the
 * runtime are resolved only when some sidecar is down.
 */
export async function ensureAllSidecars(quiet: boolean, opts: EnsureAllSidecarsOptions = {}): Promise<SidecarStatus[]> {
  const specs = opts.specs ?? resolveSidecarSpecs();
  const healthy = await Promise.all(specs.map((spec) => sidecarHealthy(sidecarUrl(spec))));
  if (healthy.every(Boolean)) {
    for (const spec of specs) log(quiet, `[swarm] Substrate sidecar (${spec.label}, port ${spec.port})... running`);
    return specs.map((spec) => ({ label: spec.label, endpoint: sidecarUrl(spec), pid: readSidecarPid(spec), started: false }));
  }

  const node = await resolveNode();
  const runtime = await prepareRuntime(opts, node.path, quiet, specs);
  const embedder = opts.embedder ?? resolveEmbedderSettings(process.env);
  const contextNamespace = opts.contextNamespace ?? DEFAULT_CONTEXT_NAMESPACE;
  const statuses: SidecarStatus[] = [];
  for (const spec of specs) {
    const stackDir = ensureStackDir(spec, { runtimeDir: runtime.runtimeDir, embedder, contextNamespace });
    statuses.push(
      await ensureSidecar(spec, {
        node: node.path,
        runtime,
        stackDir,
        quiet,
        ...(opts.bootTimeoutMs !== undefined ? { bootTimeoutMs: opts.bootTimeoutMs } : {}),
      }),
    );
  }
  return statuses;
}

// --- Readiness ---

export interface EnsureSubstrateReadyOptions {
  /** Cold sidecar endpoint. Default: the resolution chain (see `endpoint.ts`). */
  endpoint?: string;
  /** Path to the swarm content repo, for seeding. Optional. */
  swarmPath?: string;
  /** Project ID for seeding. Optional. */
  projectId?: string;
  /** Suppress status logs. Default: false */
  quiet?: boolean;
  /** If true, return null immediately without attempting to start infrastructure. */
  skipIfNoDb?: boolean;
  /**
   * Directory holding the machine-wide docker-compose.yml (and
   * docker-compose.meta.yml). When omitted, ~/.swarm/infrastructure, then the
   * repo root, whichever has a Substrate-era compose file.
   */
  dockerComposeDir?: string;
  /**
   * A dedicated per-project stack: the project's config chose its own ports and
   * Postgres (the CLI has already put them in SWARM_SUBSTRATE_* / SWARM_META_*).
   * Its stack directories are `<composeProject>-cold` / `-meta`, the
   * machine-wide compose files are never brought up, and when its Postgres is
   * down and `composeFile` is set, `docker compose -p <composeProject> -f
   * <composeFile> up -d --wait` runs with `composeEnv`; otherwise the fix is
   * reported and null returned.
   */
  isolated?: {
    composeFile?: string;
    composeProject?: string;
    composeEnv?: Record<string, string>;
  };
  /** The swarm plugin tarball, to install the runtime from when needed (see {@link EnsureAllSidecarsOptions.pluginTarball}). */
  pluginTarball?: string;
  /** Default ~/.swarm/substrate/runtime. */
  runtimeDir?: string;
  /** Default `cortext`. */
  contextNamespace?: string;
  /** Default: `resolveEmbedderSettings(process.env)`. */
  embedder?: EmbedderSettings;
  /** See {@link EnsureAllSidecarsOptions.beforeReinstall}. */
  beforeReinstall?: () => Promise<void> | void;
}

/** Whether `endpoint` is the cold spec's own loopback sidecar (and so swarm's to start). */
export function isManagedEndpoint(endpoint: string, cold: Pick<SidecarSpec, "port">): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return isLoopbackHost(url.hostname) && port === cold.port;
}

/** Verify the meta sidecar when it answers; warn (never fail) when it does not. */
async function checkMeta(metaClient: SubstrateClient, meta: SidecarSpec, quiet: boolean): Promise<void> {
  if (!(await metaClient.isHealthy())) {
    log(quiet, `[swarm] The meta sidecar at ${metaClient.endpoint} is not answering; institutional memory is unavailable this run.`);
    return;
  }
  await ensureTypesRegistered(metaClient, [meta], quiet);
}

/**
 * Bring the machine-wide Postgres pair up when either is unreachable. Resolves
 * to false, having said why, when there is no way to.
 */
async function ensureSharedStores(specs: readonly SidecarSpec[], composeDir: string | undefined, quiet: boolean): Promise<boolean> {
  const unreachable: Array<{ spec: SidecarSpec; host: string; port: number }> = [];
  for (const spec of specs) {
    if (isMemoryStore(spec.postgresUrl)) continue;
    const probe = await probePostgresReachable(spec.postgresUrl);
    if (!probe.reachable) unreachable.push({ spec, host: probe.host, port: probe.port });
  }
  if (unreachable.length === 0) return true;

  const dir = resolveComposeDir(composeDir);
  if (dir === null) {
    // A Postgres the user configured (the environment, or `swarm db setup`'s
    // postgres_url) is named with its source; swarm never starts it.
    if (specs.some((s) => (s.postgresUrlSource ?? "default") !== "default")) {
      for (const { spec, host, port } of unreachable) {
        log(
          quiet,
          `[swarm] The ${spec.label} store's Postgres (${spec.postgresUrlSource ?? "default"}) is ${host}:${port}, ` +
            "but nothing is accepting connections there.",
        );
      }
      log(quiet, "[swarm] Start that Postgres and retry, or remove the setting to use swarm's managed Postgres via `swarm db setup`.");
      return false;
    }
    log(quiet, "[swarm] No database configuration found. Running in file-only mode.");
    log(quiet, "[swarm] Next step: run `swarm db setup` to provision Postgres, or set SWARM_SUBSTRATE_POSTGRES_URL to point at an existing one.");
    return false;
  }
  try {
    await ensurePostgres(dir, quiet);
    return true;
  } catch (err) {
    log(quiet, `[swarm] Could not start database: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Ensure the Substrate stack this invocation uses is up and serves swarm's
 * namespaces (see the module doc). Returns a client for the cold store, or
 * null when no database is available (or `skipIfNoDb`).
 */
export async function ensureSubstrateReady(options: EnsureSubstrateReadyOptions = {}): Promise<SubstrateClient | null> {
  // A local_only project's sidecars may only ever be reached on loopback.
  if (isLocalOnlyEnv()) assertLocalOnly(options.endpoint);
  if (options.skipIfNoDb) return null;
  const quiet = options.quiet ?? false;
  const isolated = options.isolated;

  const { url: endpoint, source } = resolveSubstrateEndpointWithSource(options.endpoint);
  const specs = resolveSidecarSpecs(isolated !== undefined ? { stack: isolated.composeProject ?? "swarm-dedicated" } : {});
  const cold = specFor(specs, "cold");
  const meta = specFor(specs, "meta");
  const client = new SubstrateClient(endpoint);
  const metaClient = new SubstrateClient(resolveMetaEndpoint(), { namespace: meta.namespace });

  const finish = async (): Promise<SubstrateClient> => {
    await ensureTypesRegistered(client, [cold], quiet);
    await checkMeta(metaClient, meta, quiet);
    log(quiet, "[swarm] Ready.");
    return client;
  };

  if (!isManagedEndpoint(endpoint, cold)) {
    // A Substrate someone else runs: check it, never spawn one for it.
    if (!(await client.isHealthy())) {
      log(quiet, `[swarm] Substrate at ${endpoint} (from ${source}) is not answering /health.`);
      return null;
    }
    return finish();
  }

  if ((await client.isHealthy()) && (await metaClient.isHealthy())) {
    log(quiet, "[swarm] Substrate sidecars already running.");
    return finish();
  }
  const coldHealthy = await client.isHealthy();

  const storesUp =
    isolated !== undefined
      ? await ensureDedicatedPostgres(isolated as DedicatedPostgres, { postgresUrl: cold.postgresUrl, metaPostgresUrl: meta.postgresUrl }, quiet)
      : await ensureSharedStores(specs, options.dockerComposeDir, quiet);
  if (!storesUp) {
    if (isolated !== undefined) {
      log(
        quiet,
        `[swarm] This project uses a dedicated Substrate, but its Postgres is not reachable ` +
          `(${cold.postgresUrl} / ${meta.postgresUrl}). Start it and retry.`,
      );
    }
    // A healthy cold store is never dropped because meta's Postgres is down.
    if (coldHealthy) {
      log(quiet, "[swarm] Continuing with the cold sidecar only.");
      return finish();
    }
    return null;
  }

  await ensureAllSidecars(quiet, {
    specs,
    ...(options.pluginTarball !== undefined ? { pluginTarball: options.pluginTarball } : {}),
    ...(options.runtimeDir !== undefined ? { runtimeDir: options.runtimeDir } : {}),
    ...(options.contextNamespace !== undefined ? { contextNamespace: options.contextNamespace } : {}),
    ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
    ...(options.beforeReinstall !== undefined ? { beforeReinstall: options.beforeReinstall } : {}),
  });
  return finish();
}
