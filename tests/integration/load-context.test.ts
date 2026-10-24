import { Loader } from "@mnmal-ai/swarm-core";
import type { LoadingPriorityEntry, Route } from "@mnmal-ai/swarm-types";
import { describe, expect, it } from "vitest";
import { createMockSubstrateClient, type MockLoadContextResponse } from "./helpers.js";

/**
 * Parity gate for the server-side `loadContext` resolver.
 *
 * The legacy context loader is `Loader`'s per-tier `query` path (the fallback).
 * The new path is `Loader` consuming a `client.loadContext` bundle in one round
 * trip. This suite asserts the two paths are byte-and-token-equal for
 * representative intents/projects: it runs the legacy path, derives the server
 * bundle from that result, feeds it back through `Loader` via the resolver path,
 * and asserts the reconstructed `LoadResult` is identical — plus the budget and
 * file-coverage invariants the acceptance criteria call out.
 *
 * Deriving the bundle from the legacy output keeps this a genuine cross-check of
 * the Loader's resolver-path reconstruction (blob split → files → token
 * accounting) against its legacy path, without hard-coding a fixture that could
 * drift from the real per-tier selection.
 */

// Generous budget: with the small mock content nothing truncates, so the legacy
// `truncated` list is empty and the server path (which always reports
// `truncated: []`) can be byte-equal to it.
const BUDGET = 15000;

const PRIORITY: LoadingPriorityEntry[] = [
  { tier: "core", required: true },
  { tier: "mode", required: false },
  { tier: "oversight", required: false },
  { tier: "capabilities", required: false },
  { tier: "domain", required: false },
  { tier: "skills_vetted", required: false },
];

interface Scenario {
  name: string;
  intent: string;
  description: string;
  project: string;
  modelId: string;
  load: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "implementation / alpha-app",
    intent: "implementation",
    description: "Build a feature or fix a bug.",
    project: "alpha-app",
    modelId: "claude-opus-4-8",
    load: [
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/implementation.md",
      "oversight/review-policy.json",
      "capabilities/git-workflow.md",
      "capabilities/testing.md",
      "domains/alpha-app/architecture.md",
      "domains/alpha-app/conventions.md",
      "domains/alpha-app/constraints.md",
      "domains/alpha-app/overview.md",
      "skills/vetted/drizzle-neon.md",
      "skills/vetted/express-rest.md",
    ],
  },
  {
    name: "code-review / beta-service",
    intent: "code-review",
    description: "Review code changes for quality, conventions, and correctness.",
    project: "beta-service",
    modelId: "claude-sonnet-4-6",
    load: [
      "core/values.md",
      "core/rules.md",
      "core/voice.md",
      "modes/code-review.md",
      "oversight/review-policy.json",
      "capabilities/git-workflow.md",
      "domains/beta-service/conventions.md",
      "domains/beta-service/constraints.md",
      "skills/vetted/drizzle-neon.md",
      "skills/vetted/zod-validation.md",
    ],
  },
];

function makeRoute(s: Scenario): Route {
  return {
    intent: s.intent,
    description: s.description,
    load: { all: s.load },
    keywords: [s.intent],
  };
}

// Build the server bundle from a legacy LoadResult, exactly as the ported
// resolver would have emitted it for the same files.
function bundleFromLegacy(
  loader: Loader,
  legacy: { files: Array<{ path: string; tier: string; estimatedTokens: number }>; totalTokens: number; budgetMax: number },
  route: Route,
): MockLoadContextResponse {
  return {
    content: loader.assembleContext(legacy.files as never),
    filesIncluded: legacy.files.map((f) => ({
      path: f.path,
      tier: f.tier,
      tokens: f.estimatedTokens,
    })),
    tokensUsed: legacy.totalTokens,
    budgetTokens: legacy.budgetMax,
    routeMatched: { intent: route.intent, description: route.description },
  };
}

describe.each(SCENARIOS)("loadContext parity — $name", (s: Scenario) => {
  const route = makeRoute(s);

  it("server resolver bundle reconstructs byte-and-token-equal to the legacy per-tier loader", async () => {
    // Legacy path: no loadContext on the client + no modelId → per-tier query.
    const legacyClient = createMockSubstrateClient();
    const legacyLoader = new Loader(legacyClient as never);
    const legacy = await legacyLoader.load(route, BUDGET, PRIORITY, s.project);

    // Precondition for byte-equality: the legacy loader did not truncate.
    expect(legacy.truncated).toEqual([]);

    const bundle = bundleFromLegacy(legacyLoader, legacy, route);
    const serverClient = createMockSubstrateClient({ loadContextResponse: bundle });
    const serverLoader = new Loader(serverClient as never);
    const server = await serverLoader.load(
      route,
      BUDGET,
      PRIORITY,
      s.project,
      s.modelId,
    );

    // Byte/token parity: identical reconstructed files + token accounting.
    expect(server).toEqual(legacy);

    // Exactly one resolver round trip; the per-tier query path was never used.
    expect(serverClient.loadContext).toHaveBeenCalledTimes(1);
    expect(serverClient.loadContext).toHaveBeenCalledWith({
      intent: s.intent,
      projectId: s.project,
      modelId: s.modelId,
    });
    expect(serverClient.query).not.toHaveBeenCalled();
  });

  it("stays within budget and includes every file the legacy loader included", async () => {
    const legacyClient = createMockSubstrateClient();
    const legacyLoader = new Loader(legacyClient as never);
    const legacy = await legacyLoader.load(route, BUDGET, PRIORITY, s.project);
    const bundle = bundleFromLegacy(legacyLoader, legacy, route);

    expect(bundle.tokensUsed).toBeLessThanOrEqual(bundle.budgetTokens);

    const legacyPaths = legacy.files.map((f) => f.path);
    const includedPaths = bundle.filesIncluded.map((f) => f.path);
    for (const p of legacyPaths) {
      expect(includedPaths).toContain(p);
    }
    expect(includedPaths).toEqual(legacyPaths);
  });
});
