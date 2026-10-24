/**
 * Which namespaces a swarm plugin instance owns, by scope:
 *   - `cold`     → `<ns>` (the fourteen swarm types plus `Observation`) and `<ns>-docs`
 *   - `meta`     → `<ns>_meta`
 *   - `combined` → all three
 *
 * `cold` and `meta` match the per-sidecar topology (one Substrate process per
 * store); `combined` serves everything from one process.
 */
import { docsNamespaceFor, metaNamespaceFor } from "@mnmal-ai/swarm-substrate-shared";
import { defineNamespace, type NamespaceDefinition } from "@mnmal-ai/substrate/sdk";
import type { SwarmScope } from "./plugin.js";
import { swarmTypes } from "./types/swarm-types.js";
import { swarmDocsTypes } from "./types/docs-types.js";
import { swarmMetaTypes } from "./types/meta-types.js";
import { Observation } from "./types/observation.js";

// Re-exported so the plugin's public surface keeps it; it lives in the shared package.
export { metaNamespaceFor };

export function buildNamespaces(config: {
  scope: SwarmScope;
  namespace: string;
}): NamespaceDefinition[] {
  const ns = config.namespace;
  const cold = (): NamespaceDefinition[] => {
    const docsNs = docsNamespaceFor(ns);
    return [
      defineNamespace(ns, { ...swarmTypes, Observation }),
      defineNamespace(docsNs, swarmDocsTypes(docsNs)),
    ];
  };
  const meta = (): NamespaceDefinition[] => [defineNamespace(metaNamespaceFor(ns), swarmMetaTypes)];
  switch (config.scope) {
    case "cold":
      return cold();
    case "meta":
      return meta();
    case "combined":
      return [...cold(), ...meta()];
  }
}
