import { describe, it, expect, vi } from "vitest";
import { Swarm, bindingRulePaths, formatBindingRules, selectReviewerFiles } from "../src/index.js";
import type { SwarmConfig, IWorkerBackend, OversightRunner, RunOptions, WorkerTaskInput } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Workers always load the project's binding rules (core/rules.md, a required
// tier), but the reviewer and the arbiter used to judge work without them.
// runWithOversight now fetches the binding rules by path — core/rules.md and
// the project's domains/<project>/constraints.md — whatever the route or the
// budget, and hands them to the oversight chain as `bindingRules`.
// ---------------------------------------------------------------------------

const RULES = "# Rules\n\n- Never force push to main.\n- Never commit secrets.";
const CONSTRAINTS = "# acme — Constraints\n\n- Never edit an existing migration.";

function row(path: string, tier: string, content: string, projectId = "acme") {
  return { path, tier, intent: "", content, tokenEstimate: Math.ceil(content.length / 4), lastReviewed: "", projectId };
}

const ROWS = [
  row("core/rules.md", "core", RULES),
  row("domains/acme/constraints.md", "domain", CONSTRAINTS),
  row("domains/acme/architecture.md", "domain", "# Architecture\n\nA monolith."),
  row("domains/other/constraints.md", "domain", "# other — Constraints\n\n- Not this project's rule.", "other"),
];

function makeOversight(): OversightRunner {
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

function makeBackend(): IWorkerBackend {
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: vi.fn(async () => ({
      output: "worker completed the implementation as described",
      tokensUsed: { input: 10, output: 20 },
      latencyMs: 5,
    })),
  } as unknown as IWorkerBackend;
}

const EMPTY_ROUTE = { intent: "implementation", description: "", load: { core: [], mode: [] }, keywords: [] };

function makeSwarm(
  backend: IWorkerBackend,
  oversight: OversightRunner,
  budget: number,
  route: object = EMPTY_ROUTE,
  priority: object[] = [],
): Swarm {
  const config = {
    swarmPath: "/tmp/swarm-reviewer-rules-test",
    provider: "anthropic",
    model: "test-model",
    oversight: { enabled: true, reviewerModel: "test" },
    workerBackend: backend,
  } as SwarmConfig;
  const query = vi.fn(async (type: string) => (type === "SwarmContent" ? ROWS : []));
  const swarm = new Swarm(config, { queryClient: { query } as any, oversight });
  // By default a route that loads nothing (with a tiny budget in the test
  // below): the rules must still arrive.
  const swarmAny = swarm as any;
  swarmAny.router = {
    classify: vi.fn().mockResolvedValue({ intent: "implementation", route, confidence: "exact", matchedKeywords: [] }),
    getBudget: vi.fn().mockResolvedValue(budget),
    getLoadingPriority: vi.fn().mockResolvedValue(priority),
  };
  swarmAny.skillFetcher = { prefetch: vi.fn().mockResolvedValue(route) };
  return swarm;
}

describe("binding rules for reviewers and arbiters", () => {
  it("names core/rules.md and the project's constraints file", () => {
    expect(bindingRulePaths("acme")).toEqual(["core/rules.md", "domains/acme/constraints.md"]);
    expect(bindingRulePaths(undefined)).toEqual(["core/rules.md"]);
  });

  it("formats each rule file under its path, and nothing when there are none", () => {
    const text = formatBindingRules([
      { path: "core/rules.md", tier: "core", content: RULES, estimatedTokens: 10 },
      { path: "domains/acme/constraints.md", tier: "domain", content: CONSTRAINTS, estimatedTokens: 10 },
    ]);
    expect(text).toContain("--- core/rules.md ---\n# Rules");
    expect(text).toContain("--- domains/acme/constraints.md ---\n# acme — Constraints");
    expect(text.indexOf("core/rules.md")).toBeLessThan(text.indexOf("constraints.md"));
    expect(formatBindingRules([])).toBe("");
  });

  it("leaves the project's constraints file out of the reviewer's domain context, which now carries it as a binding rule", () => {
    const files = [
      { path: "domains/acme/constraints.md", tier: "domain", content: CONSTRAINTS },
      { path: "domains/acme/architecture.md", tier: "domain", content: "# Architecture" },
      { path: "modes/implementation.md", tier: "mode", content: "# Implementation" },
    ];
    const context = selectReviewerFiles(files, ["domains/acme/constraints.md"]);
    expect(context).not.toContain("Never edit an existing migration");
    expect(context).toContain("# Architecture");
    expect(context).toContain("# Implementation");
    // When it didn't arrive as a binding rule (no project, or the rules
    // couldn't be read), the file stays in the domain context.
    expect(selectReviewerFiles(files)).toContain("Never edit an existing migration");
  });

  it("keeps the route's context, constraints included, and says so, when the rules can't be read", async () => {
    const oversight = makeOversight();
    const route = { intent: "implementation", description: "", load: { domain: ["domains/acme/constraints.md"] }, keywords: [] };
    const swarm = makeSwarm(makeBackend(), oversight, 15000, route, [{ tier: "domain", required: false }]);
    const swarmAny = swarm as any;
    swarmAny.loader.loadByPaths = vi.fn().mockRejectedValue(new Error("store unreachable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await swarm.runWithOversight("implement it", { input: "go", project: "acme" } as RunOptions);
      const params = (oversight.runFullChain as ReturnType<typeof vi.fn>).mock.calls[0][0] as { bindingRules?: string; modeContext: string };
      expect(params.bindingRules).toBe("");
      expect(params.modeContext).toContain("Never edit an existing migration");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("binding rules"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("hands the oversight chain the project's binding rules, in full, whatever the route or the budget", async () => {
    const oversight = makeOversight();
    const swarm = makeSwarm(makeBackend(), oversight, 1);

    await swarm.runWithOversight("implement it", { input: "go", project: "acme" } as RunOptions);

    const params = (oversight.runFullChain as ReturnType<typeof vi.fn>).mock.calls[0][0] as { bindingRules?: string };
    expect(params.bindingRules).toContain("- Never force push to main.");
    expect(params.bindingRules).toContain("- Never edit an existing migration.");
    expect(params.bindingRules).not.toContain("Not this project's rule");
  });

  it("leaves the worker's own context unchanged", async () => {
    const backend = makeBackend();
    const swarm = makeSwarm(backend, makeOversight(), 15000);

    await swarm.runWithOversight("implement it", { input: "go", project: "acme" } as RunOptions);

    const input = (backend.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerTaskInput;
    expect(input.swarmContext ?? "").not.toContain("Project Rules");
    expect(input.swarmContext ?? "").not.toContain("Never edit an existing migration");
  });
});
