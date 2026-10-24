/**
 * The `swarm` namespace's types, ported from the previous engine plugin
 * to Substrate's field DSL. Field names,
 * nullability and `indexed: false` flags are unchanged, as is
 * `SwarmContent.embed.source`.
 *
 * Declared as a standalone object (not inline in `defineNamespace`) so custom
 * resolvers can validate against the same field maps autoCRUD uses, and so the
 * schema test can check the type set against `SWARM_TYPE_NAMES`. `Observation`
 * lives in `./observation.ts`.
 */
import { field, type Row, type TypeInput } from "@mnmal-ai/substrate/sdk";

export const swarmTypes = {
  SwarmConfig: {
    fields: {
      key: field.string(),
      value: field.string(),
      category: field.string(),
    },
  },
  SwarmContent: {
    fields: {
      path: field.string(),
      tier: field.string(),
      intent: field.string(),
      content: field.string({ indexed: false }),
      tokenEstimate: field.number(),
      lastReviewed: field.string(),
      projectId: field.string(),
      sourceUrl: field.string({ nullable: true }),
      fetchedAt: field.string({ nullable: true }),
      skillName: field.string({ nullable: true }),
    },
    // Make the corpus vector-searchable. Substrate's recall kernel plugin
    // inspects this `embed.source` at compose time and chains a postWrite hook
    // that embeds each SwarmContent row's `content` on create/update. Recall
    // owns the embedder and store; a deployment with no embedder still
    // installs the type, the hook simply has nothing to embed.
    embed: {
      source: (row: Row) => (typeof row.content === "string" ? row.content : ""),
    },
  },
  SwarmRoute: {
    fields: {
      intent: field.string(),
      description: field.string(),
      keywords: field.string(),
      contentPaths: field.string(),
      // The project whose swarm.json declared the route, so projects sharing a
      // store each keep their own route per intent. Nullable: rows
      // synced before it existed have none and are read as the legacy scope
      // (see project-scope.ts in @mnmal-ai/swarm-substrate-shared).
      projectId: field.string({ nullable: true }),
    },
  },
  WorkerResult: {
    fields: {
      sessionId: field.string(),
      intent: field.string(),
      output: field.string({ indexed: false }),
      diff: field.string({ indexed: false }),
      filesModified: field.string(),
      // tokenUsage is the legacy aggregate, kept for back-compat. provider/
      // modelId/inputTokens/outputTokens split it. Nullable: rows written
      // before these columns existed don't populate them.
      provider: field.string({ nullable: true }),
      modelId: field.string({ nullable: true }),
      inputTokens: field.number({ nullable: true }),
      outputTokens: field.number({ nullable: true }),
      tokenUsage: field.number(),
      // Legacy dollar column. Swarm no longer writes it (budgets are in
      // tokens); it stays, nullable, so rows that carry it remain readable.
      costUsd: field.number({ nullable: true }),
      // Resolved once at session start (env USER > git user.email > anonymous)
      // and threaded through every telemetry write. Nullable so rows persisted
      // before this change stay valid; indexed (scalar default) so future
      // per-engineer queries push down to the substrate. Taxonomy now,
      // enforcement deferred — persist logic untouched here.
      authorId: field.string({ nullable: true }),
      timestamp: field.string(),
    },
  },
  ReviewVerdict: {
    fields: {
      sessionId: field.string(),
      workerResultId: field.string(),
      verdict: field.string(),
      reasons: field.string({ indexed: false }),
      suggestions: field.string({ indexed: false }),
      attempt: field.number(),
      // See WorkerResult.authorId. ReviewVerdict carries it for the same
      // reason — toReviewVerdictFields writes it for every oversight row, so
      // a missing schema column would either throw or silently drop on
      // Postgres-backed deployments. Nullable for back-compat with rows
      // persisted before this change.
      authorId: field.string({ nullable: true }),
      timestamp: field.string(),
    },
  },
  ArbiterDecision: {
    fields: {
      sessionId: field.string(),
      workerResultId: field.string(),
      reviewVerdictId: field.string(),
      verdict: field.string(),
      reasoning: field.string({ indexed: false }),
      timestamp: field.string(),
    },
  },
  SessionEvent: {
    fields: {
      eventId: field.string(),
      sessionId: field.string(),
      role: field.string(),
      provider: field.string(),
      modelId: field.string(),
      intent: field.string(),
      swarmFilesLoaded: field.string({ indexed: false }),
      contextTokensUsed: field.number(),
      inputTokens: field.number(),
      outputTokens: field.number(),
      latencyMs: field.number(),
      // Legacy dollar column. Swarm no longer writes it (budgets are in
      // tokens); it stays, nullable, so rows that carry it remain readable.
      costUsd: field.number({ nullable: true }),
      // See WorkerResult.authorId. Nullable for back-compat, indexed for
      // future per-engineer queries.
      authorId: field.string({ nullable: true }),
      // The session's swarm context as JSON: {budgetTokens, loaded, omitted},
      // each file with tier and tokens. Nullable: only sessions that loaded
      // swarm context carry it, and older rows don't.
      contextDetail: field.string({ indexed: false, nullable: true }),
      // How the session's Bash commands fared with fnl, as JSON (FnlCoverage).
      // Nullable: only sessions whose fnl explains its decisions carry it.
      fnlCoverage: field.string({ indexed: false, nullable: true }),
      timestamp: field.string(),
    },
  },
  OversightChain: {
    fields: {
      sessionId: field.string(),
      workerEventId: field.string(),
      reviewerVerdict: field.string(),
      rejectionReasons: field.string(),
      retryCount: field.number(),
      arbiterInvolved: field.boolean(),
      arbiterVerdict: field.string({ nullable: true }),
      humanEscalation: field.boolean(),
      totalResolutionTimeMs: field.number(),
      // See WorkerResult.authorId. Nullable for back-compat, indexed for
      // future per-engineer queries.
      authorId: field.string({ nullable: true }),
      timestamp: field.string(),
    },
  },
  TranscriptEntry: {
    fields: {
      sessionId: field.string(),
      role: field.string(),
      prompt: field.string({ indexed: false }),
      response: field.string({ indexed: false }),
      inputTokens: field.number(),
      outputTokens: field.number(),
      // Legacy dollar column. Swarm no longer writes it (budgets are in
      // tokens); nullable now so new rows need not carry it and rows that
      // do remain readable.
      costUsd: field.number({ nullable: true }),
      backend: field.string(),
      // See WorkerResult.authorId. Nullable for back-compat, indexed for
      // future per-engineer queries.
      authorId: field.string({ nullable: true }),
      timestamp: field.string(),
    },
  },
  Goal: {
    fields: {
      goalId: field.string(),
      projectId: field.string(),
      description: field.string(),
      priority: field.string(),
      status: field.string(),
      acceptanceCriteria: field.string({ indexed: false }),
      constraints: field.string({ indexed: false }),
      dependsOn: field.string(),
      timestamp: field.string(),
    },
  },
  TaskExecution: {
    fields: {
      goalId: field.string(),
      sessionId: field.string(),
      workerResultId: field.string(),
      status: field.string(),
      retries: field.number(),
      startedAt: field.string(),
      completedAt: field.string({ nullable: true }),
    },
  },
  LearningEntry: {
    fields: {
      projectId: field.string(),
      goalId: field.string(),
      category: field.string(),
      content: field.string({ indexed: false }),
      timestamp: field.string(),
    },
  },
  McpServer: {
    fields: {
      name: field.string(),
      command: field.string(),
      args: field.string(),
      type: field.string(),
      toolCount: field.number(),
      tools: field.string({ indexed: false }),
      projectId: field.string(),
      lastIntrospected: field.string(),
    },
  },
  // Structured artifact written on task failure (tool wedge, oversight
  // rejection, arbiter escalation). The Stage 2 diagnosis routine reads
  // these entities to decide retry / decompose / escalate-to-arbiter /
  // escalate-to-human / terminate-goal. JSON-serialized fields hold the
  // composite payloads (failure event, captured tool calls + transcript
  // turns, verdict, active tools at wedge, decomposition lineage). They stay
  // strings, as they were under the previous engine, and are parsed by consumers.
  FailurePostmortem: {
    fields: {
      runId: field.string(),
      taskId: field.string(),
      goalId: field.string({ nullable: true }),
      failureCategory: field.string(),
      schemaVersion: field.number(),
      writtenAt: field.string(),
      failureEvent: field.string({ indexed: false }),
      recentToolCalls: field.string({ indexed: false }),
      recentTranscriptTurns: field.string({ indexed: false }),
      taskVerdict: field.string({ nullable: true, indexed: false }),
      activeToolsAtFailure: field.string({ indexed: false }),
      lineage: field.string({ indexed: false }),
    },
  },
} satisfies Record<string, TypeInput>;
