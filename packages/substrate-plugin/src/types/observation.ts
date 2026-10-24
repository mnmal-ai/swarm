/**
 * `Observation`: a cheap, fire-and-forget note an agent writes while it works
 * (an architectural observation, a concern, a rationale), later promoted into
 * the context store or expired. Under the previous engine this type lived in the separate
 * `plane` namespace; on Substrate it is part of the swarm namespace.
 */
import { field, type TypeInput } from "@mnmal-ai/substrate/sdk";

export const Observation = {
  fields: {
    ts: field.date(),
    kind: field.string(),
    body: field.string({ indexed: false }),
    context: field.string({ indexed: false, nullable: true }),
    confidence: field.number({ nullable: true }),
    tags: field.string(),
    ttlHours: field.number({ nullable: true }),
    isAnchor: field.boolean({ nullable: true }),
  },
} satisfies TypeInput;
