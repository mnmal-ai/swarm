/**
 * Registers the swarm's custom resolvers on the swarm namespace's registry,
 * after `defineNamespace`'s install has put the autoCRUD surface there
 * (Substrate's plugin author guide, "Custom mutation resolvers").
 *
 * `loadContext`, `classifyIntent` and `prepareTask` are queries, which in
 * Substrate are `kind: "type"` entries: they are reached as
 * `<ns>/prepareTask` on `POST /substrate/v1/query` and published under the
 * namespace schema's `types`, with `fields` as their response shape.
 *
 * `persistTaskTelemetry` is a `kind: "mutation"`, reached as
 * `<ns>/persistTaskTelemetry` on `POST /substrate/v1/mutate` and published
 * under the schema's `mutations` with its `params` and `returns`. The engine
 * runs it inside the mutate transaction.
 *
 * Policy: the plugin-global policy the loader composed into
 * `ctx.pluginPolicy`, so plugin-level invariants apply to these resolvers as
 * `defineNamespace` applies them to the autoCRUD surface, falling back to
 * `allowAll` — the registry default the autoCRUD types get when the plugin
 * declares no `policies`.
 */
import {
  allowAll,
  field,
  type FieldDef,
  type NamespaceDefinition,
  type NamespaceInstallContext,
  type RegistryEntryResolver,
  type TypedResolver,
} from "@mnmal-ai/substrate/sdk";
import { makeClassifyIntent } from "./classify-intent.js";
import { type DocsSource, makeLoadContext } from "./load-context.js";
import { persistTaskTelemetry } from "./persist-task-telemetry.js";
import { makePrepareTask } from "./prepare-task.js";
import type { SwarmRecallDeps } from "./recall.js";

export interface SwarmResolverDeps {
  /** Semantic recall; the plugin passes the engine-backed one. */
  recall: SwarmRecallDeps;
  /** The docs namespace reader for a request. */
  docs: DocsSource;
}

const CONFIDENCES = ["exact", "keyword", "semantic", "fallback"] as const;

const CLASSIFY_FIELDS: Record<string, FieldDef> = {
  intent: field.string(),
  confidence: field.enum(CONFIDENCES),
  matchedKeywords: field.json(),
};

const LOAD_FIELDS: Record<string, FieldDef> = {
  content: field.string(),
  filesIncluded: field.json(),
  tokensUsed: field.number(),
  budgetTokens: field.number(),
  routeMatched: field.json({ nullable: true }),
  truncated: field.json(),
  omitted: field.json({ nullable: true }),
  documents: field.json({ nullable: true }),
  ranking: field.json({ nullable: true }),
};

/** The loadContext request knobs prepareTask forwards. */
const LOAD_OPTION_PARAMS: Record<string, FieldDef> = {
  sections: field.boolean({ nullable: true }),
  index: field.boolean({ nullable: true }),
  rank: field.boolean({ nullable: true }),
  rankLimit: field.number({ nullable: true }),
};

const CLASSIFY_PARAMS: Record<string, FieldDef> = {
  prompt: field.string(),
  projectId: field.string(),
  intentOverride: field.string({ nullable: true }),
};

const LOAD_PARAMS: Record<string, FieldDef> = {
  intent: field.string(),
  projectId: field.string(),
  modelId: field.string(),
  prompt: field.string({ nullable: true }),
  ...LOAD_OPTION_PARAMS,
};

const PREPARE_PARAMS: Record<string, FieldDef> = {
  prompt: field.string(),
  projectId: field.string(),
  modelId: field.string(),
  intentOverride: field.string({ nullable: true }),
  ...LOAD_OPTION_PARAMS,
};

/** `PersistTaskTelemetryResponse`; the result also carries `id: "ack"`. */
const PERSIST_FIELDS: Record<string, FieldDef> = {
  ids: field.json(),
};

/**
 * `PersistTaskTelemetryRequest`: the four input sub-objects, each a JSON
 * object the resolver maps onto its type's declared fields.
 */
const PERSIST_PARAMS: Record<string, FieldDef> = {
  sessionEvent: field.json(),
  transcript: field.json(),
  workerResult: field.json(),
  reviewVerdict: field.json({ nullable: true }),
};

/**
 * Typed resolvers are erased to the engine-facing `RegistryEntryResolver` at
 * registration: their concrete `Promise<T>` return is opaque to the engine,
 * which discriminates on the runtime value shape.
 */
const erase = (r: TypedResolver<unknown>): RegistryEntryResolver => r as unknown as RegistryEntryResolver;

export function registerSwarmResolvers(ctx: NamespaceInstallContext, deps: SwarmResolverDeps): void {
  const policy = ctx.pluginPolicy ?? allowAll();
  ctx.registry.register("loadContext", {
    kind: "type",
    policy,
    resolver: erase(makeLoadContext(deps.recall, deps.docs)),
    fields: LOAD_FIELDS,
    params: LOAD_PARAMS,
  });
  ctx.registry.register("classifyIntent", {
    kind: "type",
    policy,
    resolver: erase(makeClassifyIntent(deps.recall)),
    fields: CLASSIFY_FIELDS,
    params: CLASSIFY_PARAMS,
  });
  // prepareTask is a read (classify + load + score), so a query like the two above.
  ctx.registry.register("prepareTask", {
    kind: "type",
    policy,
    resolver: erase(makePrepareTask(deps.recall, deps.docs)),
    fields: { ...CLASSIFY_FIELDS, ...LOAD_FIELDS, complexity: field.number() },
    params: PREPARE_PARAMS,
  });
  ctx.registry.register("persistTaskTelemetry", {
    kind: "mutation",
    policy,
    resolver: erase(persistTaskTelemetry),
    fields: PERSIST_FIELDS,
    params: PERSIST_PARAMS,
    returns: field.struct(PERSIST_FIELDS),
  });
}

/**
 * `base` with the swarm resolvers registered after its own install. Keeps
 * `base.types`, which the recall plugin reads for `embed.source`.
 */
export function withSwarmResolvers(base: NamespaceDefinition, deps: SwarmResolverDeps): NamespaceDefinition {
  return {
    ...base,
    async install(ctx: NamespaceInstallContext): Promise<void> {
      await base.install(ctx);
      registerSwarmResolvers(ctx, deps);
    },
  };
}
