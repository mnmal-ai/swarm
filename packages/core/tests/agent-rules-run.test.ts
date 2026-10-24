/**
 * Swarm with `contextRules` (docs/superpowers/specs/2026-10-03-agent-rules-design.md):
 * once a project's rules exceed the budget, a worker on a direct-execution
 * backend gets the rules block in place of the rule files in its context, and
 * the reviewer and the arbiter get the same block alongside the rules in full
 * (for a role on the API path). While the rules fit, or with the setting off,
 * nothing changes.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SwarmConfig, IWorkerBackend, OversightRunner, TelemetryAdapter, WorkerTaskInput } from "@mnmal-ai/swarm-types";
import { Swarm } from "../src/index.js";

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

const WORKDIR = "/work/acme";

const RULES = [
  "# Rules",
  "",
  "<!-- rules: should -->",
  "",
  "## Never Do",
  "<!-- rule: must -->",
  "",
  "- Never force push to a shared branch.",
  "",
  "## Releases",
  "",
  "Release notes are written for users. Every release names its version and links its changelog entry.",
  "",
  "## Frontend",
  "",
  "Components live next to their tests. Styles use the design tokens, never raw colours or pixel values.",
  "",
].join("\n");
const CONSTRAINTS = ["# acme — Constraints", "", "<!-- rules: should -->", "", "## Database", "", "Queries on large tables use an index; full scans are rejected in review.", ""].join("\n");

function swarmDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarm-rules-run-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  mkdirSync(join(dir, "domains", "acme"), { recursive: true });
  writeFileSync(join(dir, "core", "rules.md"), RULES);
  writeFileSync(join(dir, "domains", "acme", "constraints.md"), CONSTRAINTS);
  return dir;
}

const FILES = [
  { path: "core/values.md", tier: "core", content: "VALUES" },
  { path: "core/rules.md", tier: "core", content: RULES },
  { path: "domains/acme/constraints.md", tier: "domain", content: CONSTRAINTS },
  { path: "domains/acme/overview.md", tier: "domain", content: "OVERVIEW" },
];
const assemble = (files: typeof FILES) => files.map((f) => `--- swarm: ${f.path} (${f.tier}) ---\n${f.content}`).join("\n\n");
const CONTENT = assemble(FILES);

function setup(opts: { rules?: { maxTokens: number; relevant: number; paths?: string[] }; direct?: boolean; oversight?: OversightRunner; pull?: boolean }) {
  const dir = swarmDir();
  const inputs: WorkerTaskInput[] = [];
  const backend = {
    type: opts.direct === false ? "api" : "claude-code",
    supportsDirectExecution: opts.direct !== false,
    isAvailable: async () => true,
    execute: async (input: WorkerTaskInput) => {
      inputs.push(input);
      return { output: "worker completed the implementation as described", tokensUsed: { input: 10, output: 5 }, latencyMs: 5, filesChanged: [], backendUsed: "claude-code" };
    },
  } as unknown as IWorkerBackend;
  const prepareTask = vi.fn(async () => ({
    intent: "implementation",
    confidence: "exact" as const,
    matchedKeywords: [],
    content: CONTENT,
    filesIncluded: FILES.map((f) => ({ path: f.path, tier: f.tier, tokens: Math.ceil(f.content.length / 4) })),
    tokensUsed: 100,
    budgetTokens: 15000,
    routeMatched: { intent: "implementation", description: "Write code." },
    truncated: [],
    complexity: 0.5,
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
    swarmPath: dir,
    provider: "anthropic",
    model: "test-model",
    apiKey: "test-key-not-used",
    workerBackend: backend,
    ...(opts.direct === false ? {} : { reviewerBackend: backend }),
    ...(opts.rules ? { contextRules: { paths: [], ...opts.rules } } : {}),
    ...(opts.pull ? { contextSections: true, contextPull: { maxReadTokens: 4000 } } : {}),
    ...(opts.oversight ? { oversight: { enabled: true, reviewerModel: "test" } } : {}),
  } as SwarmConfig;
  const swarm = new Swarm(config, {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    queryClient: { prepareTask, query: vi.fn(async () => []) } as any,
    telemetry,
    oversight: opts.oversight,
  });
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
    loadByPaths: vi.fn(async (paths: string[]) =>
      paths.flatMap((p) => FILES.filter((f) => f.path === p).map((f) => ({ ...f, estimatedTokens: Math.ceil(f.content.length / 4) }))),
    ),
  };
  swarmAny.skillFetcher = { prefetch: vi.fn().mockResolvedValue(route) };
  return { swarm, inputs, telemetry, dir };
}

function fakeOversight(): OversightRunner {
  return {
    runFullChain: vi.fn(async () => ({ verdict: "approved" as const, retryCount: 0, arbiterInvolved: false, humanEscalation: false, rejectionReasons: [], totalResolutionTimeMs: 1 })),
  };
}

const TASK = "Write the release notes for the new version";
const run = (swarm: Swarm) => swarm.run(TASK, { input: "", workingDirectory: WORKDIR, project: "acme" });

describe("Swarm.run with contextRules", () => {
  it("over budget: puts the rules block first and takes the rule files out of the worker's context", async () => {
    const { swarm, inputs, dir } = setup({ rules: { maxTokens: 60, relevant: 1 } });
    await run(swarm);
    const ctx = inputs[0].swarmContext;
    expect(ctx.startsWith("## Project Rules")).toBe(true);
    expect(ctx).toContain("- Never force push to a shared branch."); // must, in full
    expect(ctx).toContain("Release notes are written for users."); // the relevant should rule, in full
    expect(ctx).toMatch(new RegExp(`### ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/core/rules\\.md`));
    expect(ctx).toMatch(/- L\d+–\d+ Frontend \(\d+ tok\) — Components live next to their tests\./); // indexed
    expect(ctx).toMatch(/- L\d+–\d+ Database \(\d+ tok\)/);
    expect(ctx).not.toContain("--- swarm: core/rules.md (core) ---");
    expect(ctx).not.toContain("--- swarm: domains/acme/constraints.md (domain) ---");
    expect(ctx).toContain("--- swarm: core/values.md (core) ---\nVALUES\n\n--- swarm: domains/acme/overview.md (domain) ---\nOVERVIEW");
  });

  it("records the rules it delivered and what they would have cost in full", async () => {
    const { swarm, telemetry } = setup({ rules: { maxTokens: 60, relevant: 1 } });
    await run(swarm);
    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    const context = (telemetry.buildEvent as any).mock.calls[0][0].context;
    expect(context.rules).toEqual({ sections: 4, full: 2, indexed: 2, tokens: expect.any(Number), tokensIfFull: expect.any(Number) });
  });

  it("changes nothing while the rules fit, with the setting off, or on the API path", async () => {
    for (const opts of [{ rules: { maxTokens: 100_000, relevant: 3 } }, {}]) {
      const { swarm, inputs, telemetry } = setup(opts);
      await run(swarm);
      expect(inputs[0].swarmContext).toBe(CONTENT);
      // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
      expect((telemetry.buildEvent as any).mock.calls[0][0].context).not.toHaveProperty("rules");
    }
    apiContexts.length = 0;
    const { swarm } = setup({ rules: { maxTokens: 60, relevant: 1 }, direct: false });
    await run(swarm);
    expect(apiContexts).toEqual([CONTENT]);
  });

  it("takes rules from the store, and points at the file on disk only while it matches the stored copy", async () => {
    const { swarm, inputs, dir } = setup({ rules: { maxTokens: 60, relevant: 0 } });
    // The checkout's copy has drifted from what the store holds: its line ranges can't be trusted.
    writeFileSync(join(dir, "core", "rules.md"), `${RULES}\n## Added locally\n\nNot in the store.\n`);
    await run(swarm);
    const ctx = inputs[0].swarmContext;
    expect(ctx).not.toContain("Not in the store.");
    expect(ctx).toContain("Components live next to their tests."); // in full: no range to read
    expect(ctx).not.toMatch(/- L\d+–\d+ Frontend/);
    expect(ctx).toMatch(/- L\d+–\d+ Database/); // constraints.md still matches, so it is still indexed
  });

  it("with pull on, guards reads of a rule file that has index lines", async () => {
    const { swarm, inputs, dir } = setup({ rules: { maxTokens: 60, relevant: 1 }, pull: true });
    await run(swarm);
    const guarded = inputs[0].documents?.documents.find((d) => d.absolutePath === join(dir, "core", "rules.md"));
    expect(guarded?.sections.map((s) => s.headingPath.join(" › "))).toEqual(expect.arrayContaining(["Never Do", "Releases", "Frontend"]));
  });
});

describe("Swarm.runWithOversight with contextRules", () => {
  it("gives the chain the rules block for backend roles and the rules in full for the rest", async () => {
    const oversight = fakeOversight();
    const { swarm } = setup({ rules: { maxTokens: 60, relevant: 1 }, oversight });
    await swarm.runWithOversight(TASK, { input: "", workingDirectory: WORKDIR, project: "acme" });
    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    const params = (oversight.runFullChain as any).mock.calls[0][0];
    expect(params.bindingRules).toContain("Components live next to their tests.");
    expect(params.bindingRulesIndexed.startsWith("## Project Rules")).toBe(true);
    expect(params.bindingRulesIndexed).toMatch(/- L\d+–\d+ Frontend/);
  });

  it("passes no indexed rules while they fit", async () => {
    const oversight = fakeOversight();
    const { swarm } = setup({ rules: { maxTokens: 100_000, relevant: 3 }, oversight });
    await swarm.runWithOversight(TASK, { input: "", workingDirectory: WORKDIR, project: "acme" });
    // biome-ignore lint/suspicious/noExplicitAny: mock call inspection
    expect((oversight.runFullChain as any).mock.calls[0][0]).not.toHaveProperty("bindingRulesIndexed");
  });
});
