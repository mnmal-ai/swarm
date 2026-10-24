/**
 * Swarm.run with `contextPull` (stage 2 of the context-sections spec): it asks
 * prepareTask for an index of stored documents, appends the rendered index to
 * the worker's swarm context, hands the backend a guard with each document's
 * absolute path, and records the index and the backend's document reads in the
 * session's telemetry and its session:end event. Without `contextPull` the
 * context and the backend's input are exactly as before.
 */
import { describe, expect, it, vi } from "vitest";
import type { SwarmConfig, DocumentReads, IWorkerBackend, OversightRunner, TelemetryAdapter, WorkerTaskInput } from "@mnmal-ai/swarm-types";
import type { IndexedDocument } from "@mnmal-ai/swarm-substrate";
import { Swarm } from "../src/index.js";
import { renderDocumentIndex } from "../src/document-index.js";

// The API path's single-shot provider, so a run on a backend without direct
// execution can be checked without a real API call.
const apiContexts: string[] = [];
vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      execute: async (input: { systemContext: string }) => {
        apiContexts.push(input.systemContext);
        return { output: "api result", tokens: { input: 1, output: 1 }, latencyMs: 1 };
      },
    }),
  };
});

const SWARM_PATH = "/srv/swarm";
const WORKDIR = "/work/acme";

const DOCUMENTS: IndexedDocument[] = [
  {
    path: "domain/acme/architecture.md",
    source: "swarm",
    title: "Architecture",
    tokens: 300,
    contentHash: "hash-arch",
    sections: [
      { ordinal: 0, headingPath: [], synopsis: "The parts.", tokens: 100, startLine: 1, endLine: 10, loaded: true },
      { ordinal: 1, headingPath: ["Deploy"], synopsis: "How it ships.", tokens: 200, startLine: 11, endLine: 30, loaded: false },
    ],
  },
  {
    path: "docs/api.md",
    source: "project",
    title: "API reference",
    tokens: 1200,
    contentHash: "hash-api",
    sections: [
      { ordinal: 0, headingPath: [], synopsis: "What the API is for.", tokens: 300, startLine: 1, endLine: 40, loaded: false },
      { ordinal: 1, headingPath: ["Errors"], synopsis: "How errors look.", tokens: 900, startLine: 41, endLine: 120, loaded: false },
    ],
  },
];

const PREPARED = {
  intent: "implementation",
  confidence: "exact" as const,
  matchedKeywords: [],
  content: "--- swarm: core/rules.md (core) ---\nRULES",
  filesIncluded: [{ path: "core/rules.md", tier: "core", tokens: 5 }],
  tokensUsed: 5,
  budgetTokens: 15000,
  routeMatched: { intent: "implementation", description: "Write code." },
  truncated: [],
  complexity: 0.5,
};

const READS: DocumentReads = {
  bounded: 2,
  refused: 1,
  whole: 0,
  ranges: [
    { path: "docs/api.md", startLine: 41, endLine: 120 },
    { path: "docs/api.md", startLine: 41, endLine: 120 },
    { path: "docs/api.md", startLine: 1, endLine: 40 },
  ],
};

function setup(opts: { pull: boolean; documents?: IndexedDocument[]; oversight?: OversightRunner; direct?: boolean; ranking?: { maxSections: number } }) {
  const inputs: WorkerTaskInput[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const backend = {
    type: opts.direct === false ? "api" : "claude-code",
    supportsDirectExecution: opts.direct !== false,
    isAvailable: async () => true,
    execute: async (input: WorkerTaskInput) => {
      inputs.push(input);
      return { output: "done", tokensUsed: { input: 10, output: 5 }, latencyMs: 5, filesChanged: [], backendUsed: "claude-code", ...(input.documents ? { documentReads: READS } : {}) };
    },
  } as unknown as IWorkerBackend;
  const prepareTask = vi.fn(async (_args: Record<string, unknown>) => ({
    ...PREPARED,
    ...(opts.documents ? { documents: opts.documents } : {}),
    ...(opts.ranking ? { ranking: { status: "ranked" as const, candidates: 12, loaded: 3, tokens: 1400, model: "bge-m3:1024" } } : {}),
  }));
  const telemetry = {
    name: "fake",
    kind: "telemetry",
    healthCheck: async () => ({ healthy: true }),
    flush: async () => {},
    emit: vi.fn(async () => {}),
    emitOversightEvent: vi.fn(async () => {}),
    buildEvent: vi.fn((p: { sessionId: string; role: string }) => ({ id: "evt", session_id: p.sessionId, role: p.role })),
  } as unknown as TelemetryAdapter;
  const config = {
    swarmPath: SWARM_PATH,
    provider: "anthropic",
    model: "test-model",
    apiKey: "test-key-not-used",
    workerBackend: backend,
    contextSections: true,
    ...(opts.pull ? { contextPull: { maxReadTokens: 4000 } } : {}),
    ...(opts.ranking ? { contextRanking: opts.ranking } : {}),
    ...(opts.oversight ? { oversight: { enabled: true, reviewerModel: "test" } } : {}),
  } as SwarmConfig;
  const swarm = new Swarm(config, {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    queryClient: { prepareTask, query: vi.fn(async () => []) } as any,
    telemetry,
    oversight: opts.oversight,
    // biome-ignore lint/suspicious/noExplicitAny: test double
    eventBus: { emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }), on: () => () => {} } as any,
  });
  // The reviewer's context comes from the per-step Router/Loader path.
  // biome-ignore lint/suspicious/noExplicitAny: test double
  const swarmAny = swarm as any;
  const route = { intent: "implementation", description: "", load: { core: [], mode: [] }, keywords: [] };
  swarmAny.router = {
    classify: vi.fn().mockResolvedValue({ intent: "implementation", route, confidence: "exact", matchedKeywords: [] }),
    getBudget: vi.fn().mockResolvedValue(15000),
    getLoadingPriority: vi.fn().mockResolvedValue([]),
  };
  swarmAny.loader = {
    load: vi.fn().mockResolvedValue({ files: [], totalTokens: 0, budgetMax: 15000, budgetUsedPercent: 0, truncated: [] }),
    assembleContext: vi.fn().mockReturnValue(""),
    loadByPaths: vi.fn().mockResolvedValue([]),
  };
  swarmAny.skillFetcher = { prefetch: vi.fn().mockResolvedValue(route) };
  return { swarm, inputs, events, prepareTask, telemetry };
}

function fakeOversight(): OversightRunner {
  return {
    runFullChain: vi.fn(async () => ({
      verdict: "approved" as const,
      retryCount: 0,
      arbiterInvolved: false,
      humanEscalation: false,
      rejectionReasons: [],
      totalResolutionTimeMs: 1,
    })),
  };
}

const run = (swarm: Swarm) => swarm.run("Fix the error format in docs/api.md", { input: "", workingDirectory: WORKDIR, project: "acme" });

describe("Swarm.run with contextPull", () => {
  it("asks for an index, appends it to the worker's context, and guards the documents by absolute path", async () => {
    const { swarm, inputs, prepareTask } = setup({ pull: true, documents: DOCUMENTS });
    await run(swarm);

    expect(prepareTask).toHaveBeenCalledWith(expect.objectContaining({ sections: true, index: true }));
    const index = renderDocumentIndex({
      documents: DOCUMENTS,
      budgetTokens: 15000,
      taskText: "Fix the error format in docs/api.md",
      roots: { swarm: SWARM_PATH, project: WORKDIR },
      maxReadTokens: 4000,
    });
    expect(index.text).not.toBe("");
    expect(inputs[0].swarmContext).toBe(`${PREPARED.content}\n\n${index.text}`);
    expect(inputs[0].documents).toEqual({
      maxReadTokens: 4000,
      documents: [
        {
          absolutePath: `${SWARM_PATH}/domain/acme/architecture.md`,
          displayPath: `${SWARM_PATH}/domain/acme/architecture.md`,
          contentHash: "hash-arch",
          sections: [
            { startLine: 1, endLine: 10, headingPath: [], synopsis: "The parts.", tokens: 100 },
            { startLine: 11, endLine: 30, headingPath: ["Deploy"], synopsis: "How it ships.", tokens: 200 },
          ],
        },
        {
          absolutePath: `${WORKDIR}/docs/api.md`,
          displayPath: "docs/api.md",
          contentHash: "hash-api",
          sections: [
            { startLine: 1, endLine: 40, headingPath: [], synopsis: "What the API is for.", tokens: 300 },
            { startLine: 41, endLine: 120, headingPath: ["Errors"], synopsis: "How errors look.", tokens: 900 },
          ],
        },
      ],
    });
  });

  it("records the index and the session's reads in telemetry and session:end, and returns them", async () => {
    const { swarm, events, telemetry } = setup({ pull: true, documents: DOCUMENTS });
    const result = await run(swarm);

    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    const context = (telemetry.buildEvent as any).mock.calls[0][0].context;
    expect(context.index).toEqual({ documents: 2, expanded: 2, folded: 0, dropped: 0, tokens: expect.any(Number) });
    expect(context.reads).toEqual(READS);
    expect(events.find((e) => e.type === "session:end")?.payload.docs).toEqual(READS);
    expect(result.documents?.reads).toEqual(READS);
    expect(result.documents?.index).toContain("## Documents");
    expect(result.documents?.guard.documents).toHaveLength(2);
  });

  it("leaves the request, the context and the backend's input as before without contextPull", async () => {
    const { swarm, inputs, events, prepareTask, telemetry } = setup({ pull: false, documents: DOCUMENTS });
    const result = await run(swarm);

    expect(prepareTask.mock.calls[0][0]).not.toHaveProperty("index");
    expect(prepareTask.mock.calls[0][0]).toHaveProperty("sections", true);
    expect(inputs[0]).toEqual({ task: "Fix the error format in docs/api.md", workingDirectory: WORKDIR, swarmContext: PREPARED.content, maxTurns: 50 });
    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    const context = (telemetry.buildEvent as any).mock.calls[0][0].context;
    expect(context).not.toHaveProperty("index");
    expect(context).not.toHaveProperty("reads");
    expect(events.find((e) => e.type === "session:end")?.payload).not.toHaveProperty("docs");
    expect(result).not.toHaveProperty("documents");
  });

  it("adds no index and no guard when prepareTask returns no documents", async () => {
    for (const documents of [undefined, []]) {
      const { swarm, inputs } = setup({ pull: true, documents });
      const result = await run(swarm);
      expect(inputs[0].swarmContext).toBe(PREPARED.content);
      expect(inputs[0]).not.toHaveProperty("documents");
      expect(result).not.toHaveProperty("documents");
    }
  });

  it("adds no index on the API path, whose read_file has no line range and no guard", async () => {
    apiContexts.length = 0;
    const { swarm, inputs, telemetry } = setup({ pull: true, documents: DOCUMENTS, direct: false });
    const result = await run(swarm);

    expect(inputs).toHaveLength(0);
    expect(apiContexts).toEqual([PREPARED.content]);
    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    expect((telemetry.buildEvent as any).mock.calls[0][0].context).not.toHaveProperty("index");
    expect(result).not.toHaveProperty("documents");
  });
});

describe("Swarm.runWithOversight with contextPull", () => {
  it("gives the reviewer the worker's index, headed by the sections the worker read", async () => {
    const oversight = fakeOversight();
    const { swarm } = setup({ pull: true, documents: DOCUMENTS, oversight });
    const result = await swarm.runWithOversight("Fix the error format in docs/api.md", { input: "", workingDirectory: WORKDIR, project: "acme" });

    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    const params = (oversight.runFullChain as any).mock.calls[0][0];
    expect(params.documentGuard).toEqual(result.documents?.guard);
    expect(params.documentIndex()).toBe(
      ["## Sections the worker read", "- docs/api.md L41–120", "- docs/api.md L1–40", "", result.documents!.index].join("\n"),
    );
  });

  it("passes no index to the chain without contextPull", async () => {
    const oversight = fakeOversight();
    const { swarm } = setup({ pull: false, documents: DOCUMENTS, oversight });
    await swarm.runWithOversight("Fix the error format in docs/api.md", { input: "", workingDirectory: WORKDIR, project: "acme" });

    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    const params = (oversight.runFullChain as any).mock.calls[0][0];
    expect(params).not.toHaveProperty("documentIndex");
    expect(params).not.toHaveProperty("documentGuard");
  });
});

describe("Swarm.run with contextRanking (stage 3)", () => {
  it("asks prepareTask to rank with its section limit, and records what ranking did", async () => {
    const { swarm, prepareTask, telemetry } = setup({ pull: true, documents: DOCUMENTS, ranking: { maxSections: 7 } });
    await run(swarm);
    expect(prepareTask).toHaveBeenCalledWith(expect.objectContaining({ sections: true, index: true, rank: true, rankLimit: 7 }));
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const built = (telemetry.buildEvent as any).mock.calls.map((c: any[]) => c[0]).find((p: any) => p.context);
    expect(built.context.ranking).toEqual({ status: "ranked", candidates: 12, loaded: 3, tokens: 1400, model: "bge-m3:1024" });
  });

  it("doesn't ask to rank without the setting", async () => {
    const { swarm, prepareTask } = setup({ pull: true, documents: DOCUMENTS });
    await run(swarm);
    expect(prepareTask.mock.calls[0][0]).not.toHaveProperty("rank");
    expect(prepareTask.mock.calls[0][0]).not.toHaveProperty("rankLimit");
  });
});
