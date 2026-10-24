/**
 * The swarm's Substrate coordinator plugin. It owns the swarm namespaces for
 * its scope (see `./namespaces.ts`); autoCRUD gives every type
 * create/update/delete/get and a list query. The swarm namespace also carries
 * the `loadContext`, `classifyIntent` and `prepareTask` queries
 * (`./resolvers/register.ts`), which recall and read the docs namespace
 * through the engine handle captured in `onStart`.
 *
 * Where the swarm namespace is served (`cold`, `combined`), the plugin also
 * carries the observation drainstop: a `schedule` entry that expires
 * observations past their TTL every `drainstopIntervalMs`, and the
 * `trigger-drainstop` / `reject-promotion` routes (`./routes.ts`), which
 * promote into `contextNamespace`. Promotion runs only when triggered. Every
 * scope serves the `onboard` route and `onboardInstructions` (`./onboard.ts`).
 */
import { SWARM_NAMESPACE, SWARM_PLUGIN_NAME, docsNamespaceFor } from "@mnmal-ai/swarm-substrate-shared";
import type { CoordinatorPlugin, EngineHandle, ScheduledTask } from "@mnmal-ai/substrate/sdk";
import { expireObservations } from "./drainstop/expiry.js";
import { systemContext } from "./drainstop/frames.js";
import { buildNamespaces } from "./namespaces.js";
import { buildOnboardInstructions } from "./onboard.js";
import { makeEngineDocsReader, makeEngineRecall } from "./resolvers/engine-recall.js";
import { type SwarmResolverDeps, withSwarmResolvers } from "./resolvers/register.js";
import { createSerialRunner, registerSwarmRoutes } from "./routes.js";
import { swarmDocsTypes } from "./types/docs-types.js";

/** The Substrate versions this plugin is written against. */
export const CONTRACT_VERSION = ">=1.0.0-alpha.0 <2.0.0";

/** The context-store namespace the drainstop promotes observations into. */
export const DEFAULT_CONTEXT_NAMESPACE = "cortext";

/** How often the drainstop runs: hourly. */
export const DEFAULT_DRAINSTOP_INTERVAL_MS = 3_600_000;

export type SwarmScope = "cold" | "meta" | "combined";

export interface SwarmPluginConfig {
  /** Which namespaces this instance owns. */
  scope: SwarmScope;
  /** The swarm namespace; the docs and meta namespaces derive from it. Default `"swarm"`. */
  namespace?: string;
  /** The context-store namespace observations are promoted into. Default `"cortext"`. */
  contextNamespace?: string;
  /** Drainstop interval in ms. Default one hour. */
  drainstopIntervalMs?: number;
}

export type ResolvedSwarmPluginConfig = Required<SwarmPluginConfig>;

/** `config` with every default filled in. */
export function resolveSwarmPluginConfig(config: SwarmPluginConfig): ResolvedSwarmPluginConfig {
  return {
    scope: config.scope,
    namespace: config.namespace ?? SWARM_NAMESPACE,
    contextNamespace: config.contextNamespace ?? DEFAULT_CONTEXT_NAMESPACE,
    drainstopIntervalMs: config.drainstopIntervalMs ?? DEFAULT_DRAINSTOP_INTERVAL_MS,
  };
}

export function createSwarmSubstratePlugin(config: SwarmPluginConfig): CoordinatorPlugin {
  const resolved = resolveSwarmPluginConfig(config);
  // Late-binding seam: the engine does not exist while namespaces install, so
  // resolvers that call sibling frames read it from here at call time.
  const holder: { engine?: EngineHandle } = {};
  const getEngine = () => holder.engine;
  const docsNs = docsNamespaceFor(resolved.namespace);
  const docsTypes = swarmDocsTypes(docsNs);
  const docsFields = {
    Document: Object.keys(docsTypes.Document.fields),
    Section: Object.keys(docsTypes.Section.fields),
  };
  const resolvers: SwarmResolverDeps = {
    recall: { ...makeEngineRecall(getEngine), namespace: resolved.namespace },
    docs: async (ctx) => makeEngineDocsReader(getEngine, docsNs, docsFields, ctx),
  };
  // Only the swarm namespace carries the resolvers: they read swarm types off
  // its dataset. Docs and meta keep their plain autoCRUD install.
  const namespaces = buildNamespaces(resolved).map((def) =>
    def.namespace === resolved.namespace ? withSwarmResolvers(def, resolvers) : def,
  );
  const servesSwarm = resolved.scope !== "meta";
  const drainstop = servesSwarm
    ? { planeNamespace: resolved.namespace, contextNamespace: resolved.contextNamespace }
    : undefined;
  const serial = createSerialRunner();
  const onboardInstructions = buildOnboardInstructions(resolved);
  const schedule: ScheduledTask[] =
    drainstop === undefined
      ? []
      : [
          {
            name: `${resolved.namespace}-observation-expiry`,
            intervalMs: resolved.drainstopIntervalMs,
            runOnStart: true,
            // Expiry only. No caller asked, so the sweep names itself (DRAINSTOP_IDENTITY).
            handler: async (taskCtx) => {
              const expired = await serial(() =>
                expireObservations(taskCtx.engine, {
                  planeNamespace: drainstop.planeNamespace,
                  ctx: systemContext(drainstop.planeNamespace, "mutate"),
                  metric: taskCtx.metric,
                }),
              );
              taskCtx.metric("swarm_observation_expiry", { namespace: drainstop.planeNamespace, expired });
            },
          },
        ];
  return {
    name: SWARM_PLUGIN_NAME,
    contractVersion: CONTRACT_VERSION,
    namespaces,
    onboardInstructions,
    schedule,
    routes: (router, routeCtx) => {
      registerSwarmRoutes(router, routeCtx, { onboard: onboardInstructions, drainstop, serial });
    },
    async onStart(ctx) {
      holder.engine = ctx.engine;
    },
  };
}
