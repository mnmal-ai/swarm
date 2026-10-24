/**
 * Shared helpers for integration tests.
 *
 * Router and Loader take a SwarmQueryClient (a SubstrateClient in database
 * mode) instead of a swarmPath string. These helpers create mock client
 * instances populated with canned SwarmRoute, SwarmConfig, and
 * SwarmContent entities that mirror the real swarm repo data.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { vi } from "vitest";
import config from "./route-coverage.config.json";
import { Router, Loader } from "@mnmal-ai/swarm-core";

// ---------------------------------------------------------------------------
// Swarm content path: SWARM_PATH when set, else the repo's minimal fixture
// (tests/fixtures/content, two routes and three core files)
// ---------------------------------------------------------------------------

export const FIXTURE_CONTENT_PATH = path.join(__dirname, "..", "fixtures", "content");

/** Throws when the directory has no swarm.json: a missing content set fails, never skips. */
export function resolveSwarmPath(): string {
  const dir = config.swarmPath || process.env.SWARM_PATH || FIXTURE_CONTENT_PATH;
  if (!existsSync(path.join(dir, "swarm.json"))) {
    throw new Error(`No swarm content at ${dir}: swarm.json is missing. Set SWARM_PATH to a content directory.`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Mock SwarmRoute entities (from swarm.json)
// ---------------------------------------------------------------------------

const MOCK_SWARM_ROUTES = [
  {
    intent: "code-review",
    description: "Review code changes for quality, conventions, and correctness.",
    keywords: JSON.stringify(["review", "PR", "pull request", "code review", "check this", "look at this diff"]),
    contentPaths: JSON.stringify([
      "core/values.md", "core/rules.md", "core/voice.md",
      "modes/code-review.md",
      "oversight/review-policy.json",
      "capabilities/git-workflow.md",
      "domains/{project}/conventions.md", "domains/{project}/constraints.md",
      "https://raw.githubusercontent.com/AvdLee/SwiftUI-Agent-Skill/8e18d4f905bf28ce3bd73594bf6ff9913fa6882d/swiftui-expert-skill/SKILL.md",
      "https://raw.githubusercontent.com/AvdLee/Swift-Concurrency-Agent-Skill/76165e3d72210ac2b1f79b49e567d2994176466e/swift-concurrency/SKILL.md",
      "skills/vetted/drizzle-neon.md",
      "skills/vetted/express-rest.md",
      "skills/vetted/zod-validation.md",
    ]),
  },
  {
    intent: "implementation",
    description: "Build a feature or fix a bug.",
    keywords: JSON.stringify(["build", "implement", "create", "fix", "feature", "bug", "add"]),
    contentPaths: JSON.stringify([
      "core/values.md", "core/rules.md", "core/voice.md",
      "modes/implementation.md",
      "oversight/review-policy.json",
      "capabilities/git-workflow.md", "capabilities/testing.md",
      "domains/{project}/architecture.md", "domains/{project}/conventions.md", "domains/{project}/constraints.md", "domains/{project}/overview.md",
      "https://raw.githubusercontent.com/AvdLee/SwiftUI-Agent-Skill/8e18d4f905bf28ce3bd73594bf6ff9913fa6882d/swiftui-expert-skill/SKILL.md",
      "https://raw.githubusercontent.com/AvdLee/Swift-Concurrency-Agent-Skill/76165e3d72210ac2b1f79b49e567d2994176466e/swift-concurrency/SKILL.md",
      "skills/vetted/xcodebuild-mcp.md",
      "skills/vetted/drizzle-neon.md",
      "skills/vetted/express-rest.md",
      "skills/vetted/zod-validation.md",
    ]),
  },
  {
    intent: "investigation",
    description: "Debug an issue or research a topic.",
    keywords: JSON.stringify(["debug", "investigate", "why", "broken", "error", "failing", "research", "understand"]),
    contentPaths: JSON.stringify([
      "core/values.md", "core/rules.md",
      "modes/investigation.md",
      "oversight/review-policy.json",
      "domains/{project}/architecture.md", "domains/{project}/constraints.md", "domains/{project}/overview.md",
    ]),
  },
  {
    intent: "onboarding",
    description: "Initialize the swarm for a new project.",
    keywords: JSON.stringify(["init", "onboard", "new project", "get started", "initialize", "adopt", "setup project"]),
    contentPaths: JSON.stringify([
      "core/values.md", "core/rules.md", "core/voice.md",
      "modes/onboarding.md",
      "oversight/review-policy.json",
    ]),
  },
  {
    intent: "orchestration",
    description: "Coordinate multi-task execution toward project goals.",
    keywords: JSON.stringify(["orchestrate", "dispatch", "coordinate", "run goals", "execute goals", "plan execution"]),
    contentPaths: JSON.stringify([
      "core/values.md", "core/rules.md", "core/voice.md",
      "modes/orchestration.md",
      "oversight/review-policy.json",
      "domains/{project}/overview.md",
      "domains/{project}/constraints.md",
      "domains/{project}/conventions.md",
      "domains/{project}/definition-of-done.md",
      "domains/{project}/goals.json",
    ]),
  },
];

// ---------------------------------------------------------------------------
// Mock SwarmConfig entities (context budget)
// ---------------------------------------------------------------------------

const MOCK_SWARM_CONFIGS = [
  { key: "default_max_tokens", value: "15000", category: "budget" },
  { key: "model_override:claude-opus-4-6", value: "20000", category: "budget" },
  { key: "model_override:claude-sonnet-4-6", value: "14000", category: "budget" },
];

// ---------------------------------------------------------------------------
// Mock SwarmContent entities
//
// Each entity represents a swarm file with realistic content and token counts.
// Token estimates are approximately content.length / 4.
// ---------------------------------------------------------------------------

function makeContent(p: string, tier: string, content: string, opts: { intent?: string; projectId?: string } = {}) {
  return {
    path: p,
    tier,
    intent: opts.intent ?? "",
    content,
    tokenEstimate: Math.ceil(content.length / 4),
    lastReviewed: "2026-03-01",
    projectId: opts.projectId ?? "",
  };
}

// Core files (always loaded)
const CORE_VALUES = makeContent("core/values.md", "core",
  "# Engineering Values\n\nQuality over speed. Correctness over cleverness. Simplicity over complexity.\nWe write code for the next person, not the compiler.\nEvery decision should be reversible unless proven otherwise.");
const CORE_RULES = makeContent("core/rules.md", "core",
  "# Hard Rules\n\n- Never force push to main\n- Never commit API keys or secrets\n- Never skip tests to ship faster\n- Never merge without approval\n- Always use conventional commits");
const CORE_VOICE = makeContent("core/voice.md", "core",
  "# Communication Standards\n\nBe direct and specific. Avoid hedging language.\nLead with the conclusion. Provide evidence.\nUse code examples over prose when possible.");

// Mode files (one per intent)
const MODE_CODE_REVIEW = makeContent("modes/code-review.md", "mode",
  "# Code Review Mode\n\nFocus on: correctness, conventions, performance, security.\nAlways check for: memory leaks, retain cycles, missing error handling.\nProvide specific suggestions with code examples.");
const MODE_IMPLEMENTATION = makeContent("modes/implementation.md", "mode",
  "# Implementation Mode\n\nPlan before coding. Break work into testable increments.\nWrite tests alongside implementation. Follow project conventions.\nCommit frequently with descriptive messages.");
const MODE_INVESTIGATION = makeContent("modes/investigation.md", "mode",
  "# Investigation Mode\n\nStart by reproducing the issue. Gather data before forming hypotheses.\nCheck logs, stack traces, and recent changes.\nDocument findings as you go.");
const MODE_ONBOARDING = makeContent("modes/onboarding.md", "mode",
  "# Onboarding Mode\n\nScan the project structure. Identify frameworks and conventions.\nGenerate domain context files. Set up swarm configuration.\nCreate initial goals based on project needs.");
const MODE_ORCHESTRATION = makeContent("modes/orchestration.md", "mode",
  "# Orchestration Mode\n\nLoad project goals. Decompose into tasks. Build execution DAG.\nRespect concurrency limits. Track tokens per task.\nEscalate when thresholds are exceeded.");

// Oversight
const OVERSIGHT_POLICY = makeContent("oversight/review-policy.json", "oversight",
  '{\n  "always_review": ["production config", "DB migrations", "security code", "CI/CD changes"],\n  "review_if_large": { "files_changed": 5, "lines_changed": 200 },\n  "skip_review": ["doc-only changes", "comments", "test-only changes"]\n}');

// Capabilities
const CAP_GIT = makeContent("capabilities/git-workflow.md", "capabilities",
  "# Git Workflow\n\nUse feature branches: feat/, fix/, test/ prefixes.\nConventional commits: feat:, fix:, chore:, docs:, test:.\nSquash merge to main. Delete branches after merge.");
const CAP_TESTING = makeContent("capabilities/testing.md", "capabilities",
  "# Testing Guide\n\nUnit tests for pure logic. Integration tests for cross-module flows.\nProperty-based tests for non-deterministic output.\nMaintain 4/5 pass threshold for behavioral tests.");

// Domain files for known projects
function makeDomainFiles(project: string) {
  return [
    makeContent(`domains/${project}/conventions.md`, "domain",
      `# ${project} Conventions\n\nFollow project-specific coding standards and patterns.\nUse established libraries and frameworks.`,
      { projectId: project }),
    makeContent(`domains/${project}/constraints.md`, "domain",
      `# ${project} Constraints\n\nMaintain all existing functionality.\nDo not break backward compatibility.`,
      { projectId: project }),
    makeContent(`domains/${project}/architecture.md`, "domain",
      `# ${project} Architecture\n\nProject structure and component relationships.\nKey modules and their responsibilities.`,
      { projectId: project }),
    makeContent(`domains/${project}/overview.md`, "domain",
      `# ${project} Overview\n\nHigh-level description of the project purpose and goals.`,
      { projectId: project }),
    makeContent(`domains/${project}/definition-of-done.md`, "domain",
      `# ${project} Definition of Done\n\nAll tests pass. Code reviewed. No regressions.`,
      { projectId: project }),
    makeContent(`domains/${project}/goals.json`, "domain",
      `[{"id": "goal-1", "description": "Sample goal for ${project}"}]`,
      { projectId: project }),
  ];
}

// Skills (vetted tier)
const SKILL_DRIZZLE = makeContent("skills/vetted/drizzle-neon.md", "skills_vetted",
  "# Drizzle + Neon Skill\n\nORM patterns for Neon Postgres with Drizzle.");
const SKILL_EXPRESS = makeContent("skills/vetted/express-rest.md", "skills_vetted",
  "# Express REST Skill\n\nREST API patterns with Express.js.");
const SKILL_ZOD = makeContent("skills/vetted/zod-validation.md", "skills_vetted",
  "# Zod Validation Skill\n\nSchema validation patterns with Zod.");
const SKILL_XCODE = makeContent("skills/vetted/xcodebuild-mcp.md", "skills_vetted",
  "# Xcodebuild MCP Skill\n\nXcode build and test automation patterns.");

// Combine all mock content entities
const MOCK_SWARM_CONTENT = [
  CORE_VALUES, CORE_RULES, CORE_VOICE,
  MODE_CODE_REVIEW, MODE_IMPLEMENTATION, MODE_INVESTIGATION, MODE_ONBOARDING, MODE_ORCHESTRATION,
  OVERSIGHT_POLICY,
  CAP_GIT, CAP_TESTING,
  ...makeDomainFiles("alpha-app"),
  ...makeDomainFiles("beta-service"),
  SKILL_DRIZZLE, SKILL_EXPRESS, SKILL_ZOD, SKILL_XCODE,
];

// ---------------------------------------------------------------------------
// Mock SubstrateClient factory
//
// The base client only exposes `query`/`mutate` — that is the per-row "fallback"
// transport the Router/Loader and telemetry path use when no server resolver is
// present. Pass options to additionally expose the v3 server resolvers
// (`loadContext`, `persistTaskTelemetry`) so a single mock can drive BOTH the
// fallback and the resolver code paths.
// ---------------------------------------------------------------------------

/** Manifest entry shape returned by the `loadContext` resolver bundle. */
export interface MockLoadContextResponse {
  content: string;
  filesIncluded: Array<{ path: string; tier: string; tokens: number }>;
  tokensUsed: number;
  budgetTokens: number;
  routeMatched: { intent: string; description: string } | null;
}

export interface MockTelemetryOptions {
  /**
   * Row whose write should throw mid-transaction. The atomic resolver stages
   * every row and commits only after all succeed, so a throw here must leave the
   * store completely empty (no partial rows).
   */
  failOn?: "sessionEvent" | "transcript" | "workerResult" | "reviewVerdict";
}

export interface MockSubstrateClientOptions {
  /**
   * When set, the client exposes a `loadContext` resolver returning this bundle
   * (the single-round-trip server path). Omit to exercise the per-tier
   * `query`-based fallback path.
   */
  loadContextResponse?: MockLoadContextResponse;
  /**
   * When set, the client exposes an atomic `persistTaskTelemetry` resolver. Omit
   * to exercise the per-row `mutate()` fallback.
   */
  telemetry?: MockTelemetryOptions;
}

/** Committed-row store exposed on a telemetry-enabled mock client. */
export interface MockTelemetryStore {
  SessionEvent: Record<string, unknown>[];
  TranscriptEntry: Record<string, unknown>[];
  WorkerResult: Record<string, unknown>[];
  ReviewVerdict: Record<string, unknown>[];
}

type MockFn = ReturnType<typeof vi.fn>;

export interface MockSubstrateClient {
  query: MockFn;
  mutate: MockFn;
  propose: MockFn;
  getSchema: MockFn;
  hasType: MockFn;
  invalidateSchema: MockFn;
  isHealthy: MockFn;
  /** Present only when `options.loadContextResponse` was supplied. */
  loadContext?: MockFn;
  /** Present only when `options.telemetry` was supplied. */
  persistTaskTelemetry?: MockFn;
  /** Committed rows, present only when `options.telemetry` was supplied. */
  telemetryStore?: MockTelemetryStore;
}

let mockTelemetryAutoId = 0;

export function createMockSubstrateClient(
  options: MockSubstrateClientOptions = {},
): MockSubstrateClient {
  const client: MockSubstrateClient = {
    query: vi.fn(async (typeName: string) => {
      if (typeName === "SwarmRoute") return MOCK_SWARM_ROUTES;
      if (typeName === "SwarmConfig") return MOCK_SWARM_CONFIGS;
      if (typeName === "SwarmContent") return MOCK_SWARM_CONTENT;
      return [];
    }),
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };

  // Resolver path: collapse the per-tier queries into one loadContext round trip.
  if (options.loadContextResponse) {
    const bundle = options.loadContextResponse;
    client.loadContext = vi.fn(async () => bundle);
  }

  // Resolver path: one atomic persistTaskTelemetry call. Stages every row and
  // commits only on full success; a configured mid-batch failure throws before
  // any commit, so `telemetryStore` stays empty (no partial rows) — mirroring
  // the real resolver's `dataset.withTransaction` rollback.
  if (options.telemetry) {
    const failOn = options.telemetry.failOn;
    const store: MockTelemetryStore = {
      SessionEvent: [],
      TranscriptEntry: [],
      WorkerResult: [],
      ReviewVerdict: [],
    };
    client.telemetryStore = store;
    client.persistTaskTelemetry = vi.fn(
      async (req: {
        sessionEvent?: Record<string, unknown>;
        transcript?: Record<string, unknown>;
        workerResult?: Record<string, unknown>;
        reviewVerdict?: Record<string, unknown>;
      }) => {
        // SessionEvent + TranscriptEntry + WorkerResult are required; the
        // ReviewVerdict is optional (no verdict yet on a fresh worker run).
        const staged: Array<
          [keyof MockTelemetryStore, string, Record<string, unknown> | undefined]
        > = [
          ["SessionEvent", "sessionEvent", req.sessionEvent],
          ["TranscriptEntry", "transcript", req.transcript],
          ["WorkerResult", "workerResult", req.workerResult],
        ];
        if (req.reviewVerdict) {
          staged.push(["ReviewVerdict", "reviewVerdict", req.reviewVerdict]);
        }
        for (const [, key, value] of staged) {
          if (!value) {
            throw new Error(`persistTaskTelemetry: '${key}' is required`);
          }
        }
        // Stage into a transaction-local buffer; flush only if every write
        // succeeds. A failure throws before the flush — nothing is committed.
        const buffer: Array<[keyof MockTelemetryStore, Record<string, unknown>]> = [];
        const ids: Record<string, string> = {};
        for (const [type, key, value] of staged) {
          if (failOn === key) {
            throw new Error(
              `persistTaskTelemetry: injected write fault for ${key}`,
            );
          }
          const id = `mock-${++mockTelemetryAutoId}`;
          ids[key] = id;
          buffer.push([type, { id, ...(value as Record<string, unknown>) }]);
        }
        for (const [type, row] of buffer) store[type].push(row);
        return { ids };
      },
    );
  }

  return client;
}

// ---------------------------------------------------------------------------
// Factory functions (Substrate-based)
// ---------------------------------------------------------------------------

export function createRouter(): Router {
  return new Router(createMockSubstrateClient() as any);
}

export function createLoader(): Loader {
  return new Loader(createMockSubstrateClient() as any);
}

/**
 * Create a Router and Loader that share the same mock SubstrateClient instance.
 * This ensures both see the same cached data.
 */
export function createRouterAndLoader(): { router: Router; loader: Loader } {
  const client = createMockSubstrateClient();
  return {
    router: new Router(client as any),
    loader: new Loader(client as any),
  };
}

// ---------------------------------------------------------------------------
// Constants — intent names from swarm.json
// ---------------------------------------------------------------------------

export const INTENTS = {
  CODE_REVIEW: "code-review",
  IMPLEMENTATION: "implementation",
  INVESTIGATION: "investigation",
  ONBOARDING: "onboarding",
  ORCHESTRATION: "orchestration",
  FALLBACK: "fallback",
} as const;

export const ALL_INTENTS = [
  INTENTS.CODE_REVIEW,
  INTENTS.IMPLEMENTATION,
  INTENTS.INVESTIGATION,
  INTENTS.ONBOARDING,
  INTENTS.ORCHESTRATION,
] as const;

// ---------------------------------------------------------------------------
// Constants — model IDs used in swarm.json budget overrides
// ---------------------------------------------------------------------------

export const MODELS = {
  OPUS: "claude-opus-4-6",
  SONNET: "claude-sonnet-4-6",
} as const;

// ---------------------------------------------------------------------------
// Known projects from route-coverage config
// ---------------------------------------------------------------------------

export const KNOWN_PROJECTS = config.knownProjects as string[];

// ---------------------------------------------------------------------------
// Required tiers from config
// ---------------------------------------------------------------------------

export const REQUIRED_TIERS = config.requiredTiers as string[];

// ---------------------------------------------------------------------------
// Reviewer tiers from config
// ---------------------------------------------------------------------------

export const REVIEWER_TIERS = new Set(
  config.roles.reviewer.tiers as string[],
);
