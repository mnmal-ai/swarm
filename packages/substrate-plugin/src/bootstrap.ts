/**
 * The plugin's bootstrap entry: the module the package manifest's
 * `substrate.entry` names. Substrate's loader merges `default-config.json` with
 * the operator's `<plugin dir>/swarm.config.json` and calls the default export
 * with the result. The zod schema here is the validator; `config.schema.json`
 * is its JSON Schema mirror, informational only.
 *
 * `scope` has no default: an instance must say which namespaces it owns, so a
 * config without it is refused at boot rather than silently serving all three.
 */
import { SWARM_NAMESPACE } from "@mnmal-ai/swarm-substrate-shared";
import { defineBootstrap } from "@mnmal-ai/substrate/sdk";
import { z } from "zod";
import {
  createSwarmSubstratePlugin,
  DEFAULT_CONTEXT_NAMESPACE,
  DEFAULT_DRAINSTOP_INTERVAL_MS,
} from "./plugin.js";

/** Substrate's namespace-name rule: no `/` (frame keys) and no `:` (grants). */
const NamespaceName = z.string().regex(/^[A-Za-z0-9_-]+$/, "must match [A-Za-z0-9_-]+");

/** Substrate's scheduled-task floor. */
export const MIN_DRAINSTOP_INTERVAL_MS = 100;

export const SwarmBootstrapConfigSchema = z
  .object({
    scope: z.enum(["cold", "meta", "combined"]),
    namespace: NamespaceName.default(SWARM_NAMESPACE),
    contextNamespace: NamespaceName.default(DEFAULT_CONTEXT_NAMESPACE),
    drainstopIntervalMs: z
      .number()
      .int()
      .min(MIN_DRAINSTOP_INTERVAL_MS)
      .default(DEFAULT_DRAINSTOP_INTERVAL_MS),
  })
  .strict();

export const bootstrap = defineBootstrap.coordinator({
  schema: SwarmBootstrapConfigSchema,
  build: (config) => createSwarmSubstratePlugin(config),
});

export default bootstrap;
