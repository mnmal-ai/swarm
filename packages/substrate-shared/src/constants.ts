/**
 * Namespace and type-name constants shared by the swarm Substrate plugin and
 * its clients. Pure values, no imports: the plugin declares the types, and the
 * client and CLI check a server against these names without loading the
 * plugin.
 */

/** The namespace the swarm's primary types live under. */
export const SWARM_NAMESPACE = "swarm";

/** The documents namespace that goes with a swarm namespace. */
export function docsNamespaceFor(swarmNamespace: string): string {
  return `${swarmNamespace}-docs`;
}

/** The meta namespace that goes with a swarm namespace. */
export function metaNamespaceFor(swarmNamespace: string): string {
  return `${swarmNamespace}_meta`;
}

/** The namespace the swarm's meta types live under (`<swarm namespace>_meta`). */
export const SWARM_META_NAMESPACE = metaNamespaceFor(SWARM_NAMESPACE);

/** The documents namespace that goes with the default swarm namespace. */
export const SWARM_DOCS_NAMESPACE = docsNamespaceFor(SWARM_NAMESPACE);

/** Every type in the swarm namespace: the fourteen pre-Substrate types plus `Observation`. */
export const SWARM_TYPE_NAMES = [
  "SwarmConfig",
  "SwarmContent",
  "SwarmRoute",
  "WorkerResult",
  "ReviewVerdict",
  "ArbiterDecision",
  "SessionEvent",
  "OversightChain",
  "TranscriptEntry",
  "Goal",
  "TaskExecution",
  "LearningEntry",
  "McpServer",
  "FailurePostmortem",
  "Observation",
] as const;
export type SwarmTypeName = (typeof SWARM_TYPE_NAMES)[number];

/** Every type in the swarm meta namespace. */
export const SWARM_META_TYPE_NAMES = [
  "SessionLog",
  "Decision",
  "CodeLandmark",
  "ColdTestRun",
  "BugReport",
] as const;
export type SwarmMetaTypeName = (typeof SWARM_META_TYPE_NAMES)[number];

/** The swarm coordinator plugin's name, which is also its route prefix segment. */
export const SWARM_PLUGIN_NAME = "swarm";

/** Where Substrate mounts the swarm plugin's routes. */
export const SWARM_PLUGIN_ROUTE_PREFIX = `/substrate/v1/plugins/${SWARM_PLUGIN_NAME}`;

/** `POST`: run one drainstop pass (seed the anchor, promote, expire); answers the `DrainstopResult`. */
export const TRIGGER_DRAINSTOP_PATH = `${SWARM_PLUGIN_ROUTE_PREFIX}/trigger-drainstop`;

/** `POST { targetType, targetId }`: archive a promoted row and ratchet the calibration anchor. */
export const REJECT_PROMOTION_PATH = `${SWARM_PLUGIN_ROUTE_PREFIX}/reject-promotion`;

/** `GET`: the swarm plugin's onboard record. */
export const SWARM_ONBOARD_PATH = `${SWARM_PLUGIN_ROUTE_PREFIX}/onboard`;
