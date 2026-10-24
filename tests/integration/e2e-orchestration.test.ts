/**
 * Integration test: init + orchestration flow (no LLM required)
 *
 * Tests the full pipeline of:
 *   1. Scanner detecting project characteristics
 *   2. LocalTaskBackend persisting goals and tasks
 *   3. Orchestrator building trust-appropriate directives
 *   4. Orchestrator token tracking and warning thresholds
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Scanner } from "@mnmal-ai/swarm-cli";
import { LocalTaskBackend } from "@mnmal-ai/swarm-task-backends";
import { Orchestrator } from "@mnmal-ai/swarm-orchestrator";
import type {
  Goal,
  Task,
  ProjectConfig,
  TrustLevel,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = join(__dirname, "__fixtures__", "e2e-orchestration");
const PROJECT_DIR = join(FIXTURE_ROOT, "sample-project");
const BACKEND_DIR = join(FIXTURE_ROOT, "task-storage");

beforeAll(() => {
  // Create a realistic project fixture with package.json, TypeScript, Express
  mkdirSync(join(PROJECT_DIR, "src"), { recursive: true });
  mkdirSync(join(PROJECT_DIR, "tests"), { recursive: true });

  writeFileSync(
    join(PROJECT_DIR, "package.json"),
    JSON.stringify({
      name: "sample-express-app",
      version: "1.0.0",
      dependencies: {
        express: "^4.18.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
        vitest: "^1.0.0",
      },
    }),
  );

  writeFileSync(
    join(PROJECT_DIR, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );

  writeFileSync(
    join(PROJECT_DIR, "src", "index.ts"),
    'import express from "express";\nconst app = express();\nexport default app;\n',
  );

  writeFileSync(
    join(PROJECT_DIR, "src", "routes.ts"),
    'export function healthCheck() { return { status: "ok" }; }\n',
  );

  writeFileSync(
    join(PROJECT_DIR, "tests", "routes.test.ts"),
    'import { describe, it } from "vitest";\ndescribe("routes", () => { it("works", () => {}); });\n',
  );

  writeFileSync(join(PROJECT_DIR, "README.md"), "# Sample Express App\n");

  // Ensure backend storage directory exists
  mkdirSync(BACKEND_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectConfig(trust: TrustLevel): ProjectConfig {
  const concurrency = {
    low: { max_workers: 1, max_tokens_per_session: 5_000_000, max_tokens_per_task: 1_000_000, max_tokens_per_goal: 3_000_000 },
    medium: { max_workers: 3, max_tokens_per_session: 20_000_000, max_tokens_per_task: 2_000_000, max_tokens_per_goal: 10_000_000 },
    high: { max_workers: 5, max_tokens_per_session: 50_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 25_000_000 },
  };
  return {
    project: "sample-express-app",
    swarm_path: "/tmp/swarm",
    trust_level: trust,
    concurrency: concurrency[trust],
    task_backend: "local",
    created: new Date().toISOString(),
  };
}

function makeGoal(): Goal {
  return {
    id: "goal-auth",
    description: "Add JWT authentication to the Express API",
    priority: 1,
    status: "pending",
    constraints: ["Use jsonwebtoken library", "No session cookies"],
    acceptance_criteria: [
      "POST /login returns a JWT",
      "Protected routes reject requests without valid token",
    ],
  };
}

function makeTask(): Task {
  return {
    id: "task-jwt-middleware",
    goal_id: "goal-auth",
    description: "Create JWT verification middleware",
    intent: "implementation",
    status: "pending",
    order: 1,
  };
}

// ---------------------------------------------------------------------------
// 1. Scanner detects project characteristics
// ---------------------------------------------------------------------------

describe("Integration: Scanner detects project characteristics", () => {
  it("detects npm as package manager", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    expect(result.package_managers).toContain("npm");
  });

  it("detects Express as a framework", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    expect(result.frameworks).toContain("Express");
  });

  it("detects TypeScript as a language", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    const langNames = result.languages.map((l) => l.name);
    expect(langNames).toContain("TypeScript");
  });

  it("detects Vitest as a test framework", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    expect(result.has_tests).toBe(true);
    expect(result.test_frameworks).toContain("Vitest");
  });

  it("finds the project name from package.json", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    expect(result.project_name).toBe("sample-express-app");
  });

  it("finds entry points", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    expect(result.entry_points).toContain("src/index.ts");
  });

  it("finds existing docs", async () => {
    const scanner = new Scanner(PROJECT_DIR);
    const result = await scanner.scan();
    expect(result.existing_docs).toContain("README.md");
  });
});

// ---------------------------------------------------------------------------
// 2. LocalTaskBackend persists goals and tasks
// ---------------------------------------------------------------------------

describe("Integration: LocalTaskBackend persists goals and tasks", () => {
  it("round-trips a goal through create and retrieve", async () => {
    const backendDir = join(BACKEND_DIR, "goals-test");
    const backend = new LocalTaskBackend(backendDir);

    const goal = makeGoal();
    const id = await backend.createGoal(goal);
    expect(id).toBe("goal-auth");

    const retrieved = await backend.getGoals();
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].description).toBe("Add JWT authentication to the Express API");
    expect(retrieved[0].constraints).toContain("Use jsonwebtoken library");
    expect(retrieved[0].acceptance_criteria).toContain("POST /login returns a JWT");
  });

  it("round-trips a task through create and retrieve", async () => {
    const backendDir = join(BACKEND_DIR, "tasks-test");
    const backend = new LocalTaskBackend(backendDir);

    const task = makeTask();
    const id = await backend.createTask(task);
    expect(id).toBe("task-jwt-middleware");

    const retrieved = await backend.getTasks("goal-auth");
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].description).toBe("Create JWT verification middleware");
    expect(retrieved[0].intent).toBe("implementation");
    expect(retrieved[0].status).toBe("pending");
  });

  it("persists data across backend instances", async () => {
    const backendDir = join(BACKEND_DIR, "persistence-test");

    // Instance 1: create
    const backend1 = new LocalTaskBackend(backendDir);
    await backend1.createGoal(makeGoal());
    await backend1.createTask(makeTask());

    // Instance 2: read
    const backend2 = new LocalTaskBackend(backendDir);
    const goals = await backend2.getGoals();
    const tasks = await backend2.getTasks("goal-auth");

    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("goal-auth");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-jwt-middleware");
  });
});

// ---------------------------------------------------------------------------
// 3. Orchestrator builds correct directives at each trust level
// ---------------------------------------------------------------------------

describe("Integration: Orchestrator builds directives by trust level", () => {
  it("low trust: full context, core-only skills (from preset), review required", () => {
    const config = makeProjectConfig("low");
    const backend = new LocalTaskBackend(join(BACKEND_DIR, "orch-low"));
    const orchestrator = new Orchestrator({ projectConfig: config, backend });

    const directive = orchestrator.buildDirective(makeGoal(), makeTask());

    expect(directive.directive.trust_level).toBe("low");
    expect(directive.directive.context_depth).toBe("full");
    // Low trust preset: skill_tiers = ["core"]
    expect(directive.directive.skills_allowed).toEqual(["core"]);
    expect(directive.directive.review_required).toBe(true);
  });

  it("medium trust: standard context, core+vetted skills, review required (from preset)", () => {
    const config = makeProjectConfig("medium");
    const backend = new LocalTaskBackend(join(BACKEND_DIR, "orch-medium"));
    const orchestrator = new Orchestrator({ projectConfig: config, backend });

    const directive = orchestrator.buildDirective(makeGoal(), makeTask());

    expect(directive.directive.trust_level).toBe("medium");
    expect(directive.directive.context_depth).toBe("standard");
    expect(directive.directive.skills_allowed).toEqual(["core", "vetted"]);
    // Medium trust preset: require_review = true
    expect(directive.directive.review_required).toBe(true);
  });

  it("high trust: lean context, includes community skills, no review required", () => {
    const config = makeProjectConfig("high");
    const backend = new LocalTaskBackend(join(BACKEND_DIR, "orch-high"));
    const orchestrator = new Orchestrator({ projectConfig: config, backend });

    const directive = orchestrator.buildDirective(makeGoal(), makeTask());

    expect(directive.directive.trust_level).toBe("high");
    expect(directive.directive.context_depth).toBe("lean");
    expect(directive.directive.skills_allowed).toEqual(["core", "vetted", "community"]);
    expect(directive.directive.review_required).toBe(false);
  });

  it("propagates goal constraints and acceptance criteria into directive", () => {
    const config = makeProjectConfig("medium");
    const backend = new LocalTaskBackend(join(BACKEND_DIR, "orch-criteria"));
    const orchestrator = new Orchestrator({ projectConfig: config, backend });

    const directive = orchestrator.buildDirective(makeGoal(), makeTask());

    expect(directive.directive.constraints).toContain("Use jsonwebtoken library");
    expect(directive.directive.constraints).toContain("No session cookies");
    // Acceptance criteria are scoped to the task, not the goal — prevents
    // reviewers from rejecting tasks for sibling tasks' requirements.
    expect(directive.directive.acceptance_criteria).toHaveLength(1);
    expect(directive.directive.acceptance_criteria[0]).toContain("Task completed as described:");
  });

  it("includes task metadata in directive", () => {
    const config = makeProjectConfig("low");
    const backend = new LocalTaskBackend(join(BACKEND_DIR, "orch-meta"));
    const orchestrator = new Orchestrator({ projectConfig: config, backend });

    const directive = orchestrator.buildDirective(makeGoal(), makeTask());

    expect(directive.task_id).toBe("task-jwt-middleware");
    expect(directive.goal_id).toBe("goal-auth");
    expect(directive.intent).toBe("implementation");
    expect(directive.description).toBe("Create JWT verification middleware");
  });
});

// ---------------------------------------------------------------------------
// 4. Orchestrator tracks tokens and warns at threshold
// ---------------------------------------------------------------------------

describe("Integration: Orchestrator token tracking and warnings", () => {
  it("tracks cumulative tokens with addTokens", () => {
    const orchestrator = new Orchestrator({
      projectConfig: makeProjectConfig("low"), // max_tokens_per_session = 5M
      backend: new LocalTaskBackend(join(BACKEND_DIR, "token-track")),
    });

    expect(orchestrator.getCumulativeTokens()).toBe(0);
    orchestrator.addTokens(1_000_000);
    orchestrator.addTokens(500_000);
    expect(orchestrator.getCumulativeTokens()).toBe(1_500_000);
  });

  it("warns at 80% of the session limit and is exceeded only above it", () => {
    const orchestrator = new Orchestrator({
      projectConfig: makeProjectConfig("low"), // 5M; 80% = 4M
      backend: new LocalTaskBackend(join(BACKEND_DIR, "token-warn")),
    });

    orchestrator.addTokens(3_000_000);
    expect(orchestrator.shouldWarnTokens(orchestrator.getCumulativeTokens())).toBe(false);

    orchestrator.addTokens(1_200_000);
    expect(orchestrator.shouldWarnTokens(orchestrator.getCumulativeTokens())).toBe(true);
    expect(orchestrator.isSessionTokenExceeded(orchestrator.getCumulativeTokens())).toBe(false);

    orchestrator.addTokens(1_000_000);
    expect(orchestrator.isSessionTokenExceeded(orchestrator.getCumulativeTokens())).toBe(true);
  });
});
