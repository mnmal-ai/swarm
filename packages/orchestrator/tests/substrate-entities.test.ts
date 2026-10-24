import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Goal,
  Task,
  TaskBackend,
  ProjectConfig,
  TrustLevel,
  SwarmOversightRunResult,
} from "@mnmal-ai/swarm-types";
import { Orchestrator } from "../src/orchestrator/index.js";
import { captureRunObservation } from "../src/learning/capture.js";
import type { CaptureInput } from "../src/learning/capture.js";
import type { TaskOutcomeSummary } from "@mnmal-ai/swarm-types";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock SubstrateClient that records mutate() and query() calls
// ---------------------------------------------------------------------------

interface MutateCall {
  mutationName: string;
  params: Record<string, unknown>;
  fields: Record<string, unknown>;
}

interface QueryCall {
  typeName: string;
  params: Record<string, unknown>;
  fields: Record<string, unknown>;
}

function createMockSubstrateClient() {
  const mutateCalls: MutateCall[] = [];
  const queryCalls: QueryCall[] = [];
  let queryResults: any[] = [];

  return {
    mutateCalls,
    queryCalls,
    setQueryResults(results: any[]) {
      queryResults = results;
    },
    query: vi.fn(async (typeName: string, params: Record<string, unknown>, fields: Record<string, unknown>) => {
      queryCalls.push({ typeName, params, fields });
      return queryResults;
    }),
    mutate: vi.fn(async (mutationName: string, params: Record<string, unknown>, fields: Record<string, unknown>) => {
      mutateCalls.push({ mutationName, params, fields });
      return { id: mutateCalls.length };
    }),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockBackend(): TaskBackend {
  return {
    getGoals: vi.fn().mockResolvedValue([]),
    createGoal: vi.fn().mockResolvedValue("goal-1"),
    getTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue("task-1"),
    updateTask: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    escalate: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(trust: TrustLevel = "medium"): ProjectConfig {
  const concurrency = {
    low: { max_workers: 1, max_tokens_per_session: 5_000_000, max_tokens_per_task: 1_000_000, max_tokens_per_goal: 3_000_000 },
    medium: { max_workers: 3, max_tokens_per_session: 20_000_000, max_tokens_per_task: 2_000_000, max_tokens_per_goal: 10_000_000 },
    high: { max_workers: 5, max_tokens_per_session: 50_000_000, max_tokens_per_task: 5_000_000, max_tokens_per_goal: 25_000_000 },
  };
  return {
    project: "test-project",
    swarm_path: "/tmp/swarm",
    trust_level: trust,
    concurrency: concurrency[trust],
    task_backend: "local",
    created: "2026-02-21T00:00:00Z",
  };
}

function makeGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: "goal-1",
    description: "Implement authentication flow",
    priority: 1,
    status: "pending",
    constraints: ["Must use OAuth2", "No third-party cookies"],
    acceptance_criteria: ["Users can log in with GitHub", "Session persists across tabs"],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    description: "Set up OAuth2 provider integration",
    intent: "implementation",
    status: "pending",
    order: 1,
    ...overrides,
  };
}

function makeOversightResult(overrides?: Partial<SwarmOversightRunResult>): SwarmOversightRunResult {
  return {
    output: "Task completed successfully",
    tokensUsed: { context: 0, input: 1_000, output: 100 },
    oversight: {
      verdict: "approved",
      retryCount: 0,
      arbiterInvolved: false,
      humanEscalation: false,
      rejectionReasons: [],
    },
    ...overrides,
  };
}

function makeTaskOutcome(overrides: Partial<TaskOutcomeSummary> = {}): TaskOutcomeSummary {
  return {
    taskId: "goal-1-task-1",
    goalId: "goal-1",
    intent: "implementation",
    description: "Build the model",
    verdict: "approved",
    inputTokens: 1_500_000,
    latencyMs: 30000,
    retryCount: 0,
    arbiterInvolved: false,
    humanEscalation: false,
    rejectionReasons: [],
    ...overrides,
  };
}

function makeCaptureInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    runId: "run-test-substrate",
    project: "test-project",
    swarmVersion: "v0.12.0",
    workerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-sonnet-4-6",
    startTime: Date.parse("2026-03-22T14:00:00Z"),
    endTime: Date.parse("2026-03-22T14:30:00Z"),
    goals: [
      { id: "goal-1", description: "Build the model", status: "completed" },
    ],
    taskOutcomes: [
      makeTaskOutcome({ taskId: "goal-1-task-1", goalId: "goal-1", verdict: "approved" }),
    ],
    filesChanged: ["src/model.ts"],
    mergeConflicts: [],
    totalTokens: 1_500_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Goal loading from Substrate
// ---------------------------------------------------------------------------

describe("Substrate entity integration in orchestrator", () => {

  describe("loadGoalsFromSubstrate()", () => {
    it("queries Goal entities from Substrate and converts to Goal[]", async () => {
      const substrate = createMockSubstrateClient();
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      substrate.setQueryResults([
        {
          goalId: "goal-1",
          projectId: "test-project",
          description: "Build auth",
          priority: "1",
          status: "pending",
          acceptanceCriteria: JSON.stringify(["Login works"]),
          constraints: JSON.stringify(["Use OAuth2"]),
          dependsOn: JSON.stringify([]),
          timestamp: "2026-03-22T14:00:00Z",
        },
        {
          goalId: "goal-2",
          projectId: "test-project",
          description: "Build dashboard",
          priority: "2",
          status: "pending",
          acceptanceCriteria: JSON.stringify(["Charts render"]),
          constraints: JSON.stringify([]),
          dependsOn: JSON.stringify(["goal-1"]),
          timestamp: "2026-03-22T14:00:00Z",
        },
        {
          goalId: "goal-3",
          projectId: "other-project",
          description: "Unrelated goal",
          priority: "1",
          status: "pending",
          acceptanceCriteria: JSON.stringify([]),
          constraints: JSON.stringify([]),
          dependsOn: JSON.stringify([]),
          timestamp: "2026-03-22T14:00:00Z",
        },
      ]);

      const goals = await orchestrator.loadGoalsFromSubstrate("test-project");

      // Should have queried Goal type
      expect(substrate.queryCalls).toHaveLength(1);
      expect(substrate.queryCalls[0].typeName).toBe("Goal");
      expect(substrate.queryCalls[0].fields).toMatchObject({
        goalId: true,
        projectId: true,
        description: true,
        priority: true,
        status: true,
        acceptanceCriteria: true,
        constraints: true,
        dependsOn: true,
        timestamp: true,
      });

      // Should filter by projectId and return 2 goals
      expect(goals).toHaveLength(2);
      expect(goals[0].id).toBe("goal-1");
      expect(goals[0].description).toBe("Build auth");
      expect(goals[0].acceptance_criteria).toEqual(["Login works"]);
      expect(goals[0].constraints).toEqual(["Use OAuth2"]);
      expect(goals[0].dependsOn).toEqual([]);

      expect(goals[1].id).toBe("goal-2");
      expect(goals[1].dependsOn).toEqual(["goal-1"]);
    });

    it("returns empty array when no goals match the project", async () => {
      const substrate = createMockSubstrateClient();
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      substrate.setQueryResults([
        {
          goalId: "goal-1",
          projectId: "other-project",
          description: "Unrelated",
          priority: "1",
          status: "pending",
          acceptanceCriteria: "[]",
          constraints: "[]",
          dependsOn: "[]",
          timestamp: "2026-03-22T14:00:00Z",
        },
      ]);

      const goals = await orchestrator.loadGoalsFromSubstrate("test-project");
      expect(goals).toHaveLength(0);
    });

    it("returns null when substrateClient is not configured", async () => {
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        // No substrateClient
      });

      const goals = await orchestrator.loadGoalsFromSubstrate("test-project");
      expect(goals).toBeNull();
    });

    it("handles malformed JSON fields gracefully", async () => {
      const substrate = createMockSubstrateClient();
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      substrate.setQueryResults([
        {
          goalId: "goal-1",
          projectId: "test-project",
          description: "Goal with bad JSON",
          priority: "1",
          status: "pending",
          acceptanceCriteria: "not valid json",
          constraints: "",
          dependsOn: "also not json",
          timestamp: "2026-03-22T14:00:00Z",
        },
      ]);

      const goals = await orchestrator.loadGoalsFromSubstrate("test-project");
      expect(goals).toHaveLength(1);
      // Malformed fields should default to empty arrays
      expect(goals[0].acceptance_criteria).toEqual([]);
      expect(goals[0].constraints).toEqual([]);
      expect(goals[0].dependsOn).toEqual([]);
    });

    it("sorts goals by priority", async () => {
      const substrate = createMockSubstrateClient();
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      substrate.setQueryResults([
        {
          goalId: "goal-b",
          projectId: "test-project",
          description: "Second",
          priority: "3",
          status: "pending",
          acceptanceCriteria: "[]",
          constraints: "[]",
          dependsOn: "[]",
          timestamp: "2026-03-22T14:00:00Z",
        },
        {
          goalId: "goal-a",
          projectId: "test-project",
          description: "First",
          priority: "1",
          status: "pending",
          acceptanceCriteria: "[]",
          constraints: "[]",
          dependsOn: "[]",
          timestamp: "2026-03-22T14:00:00Z",
        },
      ]);

      const goals = await orchestrator.loadGoalsFromSubstrate("test-project");
      expect(goals[0].id).toBe("goal-a");
      expect(goals[1].id).toBe("goal-b");
    });
  });

  // ---------------------------------------------------------------------------
  // TaskExecution entity creation during dispatch
  // ---------------------------------------------------------------------------

  describe("TaskExecution entity creation during dispatch", () => {
    it("creates a TaskExecution entity when a task completes successfully", async () => {
      const substrate = createMockSubstrateClient();
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      const goal = makeGoal();
      const task = makeTask();
      const result = makeOversightResult();

      await orchestrator.dispatchParallel({
        tasks: [task],
        goal,
        project: "test-project",
        workingDirectory: "/tmp/work",
        executeTask: vi.fn().mockResolvedValue(result),
      });

      // Should have created a TaskExecution entity
      const taskExecCalls = substrate.mutateCalls.filter(c => c.mutationName === "createTaskExecution");
      expect(taskExecCalls.length).toBeGreaterThanOrEqual(1);

      // Find the "completed" entry
      const completedCall = taskExecCalls.find(c => c.params.status === "completed");
      expect(completedCall).toBeDefined();
      expect(completedCall!.params.goalId).toBe("goal-1");
      expect(completedCall!.params.sessionId).toBeDefined();
      // Substrate's field.number() refuses a string.
      expect(completedCall!.params.retries).toBe(0);
      expect(completedCall!.fields).toEqual({ id: true });
    });

    it("creates a TaskExecution entity with status 'failed' when a task fails", async () => {
      const substrate = createMockSubstrateClient();
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      const goal = makeGoal();
      const task = makeTask();

      await orchestrator.dispatchParallel({
        tasks: [task],
        goal,
        project: "test-project",
        workingDirectory: "/tmp/work",
        executeTask: vi.fn().mockRejectedValue(new Error("Worker failed")),
      });

      const taskExecCalls = substrate.mutateCalls.filter(c => c.mutationName === "createTaskExecution");
      const failedCall = taskExecCalls.find(c => c.params.status === "failed");
      expect(failedCall).toBeDefined();
      expect(failedCall!.params.goalId).toBe("goal-1");
      expect(failedCall!.params.retries).toBe(0);
    });

    it("does NOT create TaskExecution entities when substrateClient is absent", async () => {
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        // No substrateClient
      });

      const goal = makeGoal();
      const task = makeTask();
      const result = makeOversightResult();

      // Should not throw — just works without Substrate
      const dispatchResult = await orchestrator.dispatchParallel({
        tasks: [task],
        goal,
        project: "test-project",
        workingDirectory: "/tmp/work",
        executeTask: vi.fn().mockResolvedValue(result),
      });

      expect(dispatchResult.completed).toHaveLength(1);
    });

    it("dispatch succeeds even when Substrate mutate fails", async () => {
      const substrate = createMockSubstrateClient();
      substrate.mutate.mockRejectedValue(new Error("Substrate sidecar is down"));

      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
        substrateClient: substrate as any,
      });

      const goal = makeGoal();
      const task = makeTask();
      const result = makeOversightResult();

      // Should still complete despite Substrate failure
      const dispatchResult = await orchestrator.dispatchParallel({
        tasks: [task],
        goal,
        project: "test-project",
        workingDirectory: "/tmp/work",
        executeTask: vi.fn().mockResolvedValue(result),
      });

      expect(dispatchResult.completed).toHaveLength(1);
      expect(substrate.mutate).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // LearningEntry entity creation
  // ---------------------------------------------------------------------------

  describe("LearningEntry entity creation via captureRunObservation", () => {
    let tempSwarm: string;
    const tempDirs: string[] = [];

    beforeEach(async () => {
      tempSwarm = await mkdtemp(join(tmpdir(), "swarm-substrate-learn-test-"));
      tempDirs.push(tempSwarm);
    });

    // Cleanup after all tests
    afterAll(async () => {
      for (const d of tempDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("creates LearningEntry entities for patterns when substrateClient is provided", async () => {
      const substrate = createMockSubstrateClient();
      const input = makeCaptureInput({
        mergeConflicts: ["src/index.ts"],  // triggers a file_contention pattern
      });

      captureRunObservation(tempSwarm, input, substrate as any);

      const learningCalls = substrate.mutateCalls.filter(c => c.mutationName === "createLearningEntry");
      expect(learningCalls.length).toBeGreaterThanOrEqual(1);

      // Should have a file_contention pattern entry
      const contentionEntry = learningCalls.find(c =>
        (c.params.category as string) === "constraint_discovered"
        || (c.params.content as string).includes("contention")
        || (c.params.content as string).includes("Merge conflict")
      );
      expect(contentionEntry).toBeDefined();
      expect(contentionEntry!.params.projectId).toBe("test-project");
      expect(contentionEntry!.params.goalId).toBeDefined();
      expect(contentionEntry!.fields).toEqual({ id: true });
    });

    it("creates LearningEntry entities for failures when substrateClient is provided", async () => {
      const substrate = createMockSubstrateClient();
      const input = makeCaptureInput({
        taskOutcomes: [
          makeTaskOutcome({
            taskId: "goal-1-task-1",
            goalId: "goal-1",
            verdict: "rejected",
            rejectionReasons: ["Missing error handling"],
          }),
        ],
      });

      captureRunObservation(tempSwarm, input, substrate as any);

      const learningCalls = substrate.mutateCalls.filter(c => c.mutationName === "createLearningEntry");
      expect(learningCalls.length).toBeGreaterThanOrEqual(1);

      // Should have a failure_pattern entry
      const failureEntry = learningCalls.find(c =>
        (c.params.category as string) === "failure_pattern"
      );
      expect(failureEntry).toBeDefined();
      expect(failureEntry!.params.projectId).toBe("test-project");
    });

    it("creates success_pattern LearningEntry for fully successful runs", async () => {
      const substrate = createMockSubstrateClient();
      const input = makeCaptureInput({
        goals: [{ id: "goal-1", description: "Build the model", status: "completed" }],
        taskOutcomes: [
          makeTaskOutcome({ verdict: "approved", retryCount: 0, rejectionReasons: [] }),
        ],
        mergeConflicts: [],
      });

      captureRunObservation(tempSwarm, input, substrate as any);

      const learningCalls = substrate.mutateCalls.filter(c => c.mutationName === "createLearningEntry");
      const successEntry = learningCalls.find(c =>
        (c.params.category as string) === "success_pattern"
      );
      expect(successEntry).toBeDefined();
      expect(successEntry!.params.projectId).toBe("test-project");
    });

    it("still writes filesystem files when substrateClient is provided", async () => {
      const substrate = createMockSubstrateClient();
      const input = makeCaptureInput();

      captureRunObservation(tempSwarm, input, substrate as any);

      // Filesystem output should still exist
      const learnedDir = join(tempSwarm, "domains", "test-project", "learned");
      const runsDir = join(learnedDir, "runs");
      const files = await readdir(runsDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^run-test-substrate\.md$/);
    });

    it("still writes filesystem files when substrateClient is NOT provided", async () => {
      const input = makeCaptureInput();

      captureRunObservation(tempSwarm, input);

      // Filesystem output should still exist
      const learnedDir = join(tempSwarm, "domains", "test-project", "learned");
      const runsDir = join(learnedDir, "runs");
      const files = await readdir(runsDir);
      expect(files.length).toBe(1);
    });

    it("handles Substrate mutate failures gracefully during learning capture", () => {
      const substrate = createMockSubstrateClient();
      substrate.mutate.mockRejectedValue(new Error("Substrate sidecar is down"));
      const input = makeCaptureInput({ mergeConflicts: ["src/index.ts"] });

      // Should not throw — Substrate failures are non-blocking
      expect(() => captureRunObservation(tempSwarm, input, substrate as any)).not.toThrow();
    });

    it("includes timestamp in all LearningEntry entities", async () => {
      const substrate = createMockSubstrateClient();
      const input = makeCaptureInput({ mergeConflicts: ["src/index.ts"] });

      captureRunObservation(tempSwarm, input, substrate as any);

      const learningCalls = substrate.mutateCalls.filter(c => c.mutationName === "createLearningEntry");
      for (const call of learningCalls) {
        expect(call.params.timestamp).toBeDefined();
        expect(typeof call.params.timestamp).toBe("string");
        expect(new Date(call.params.timestamp as string).toISOString()).toBe(call.params.timestamp);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Backward compatibility: orchestrator works as before without substrateClient
  // ---------------------------------------------------------------------------

  describe("backward compatibility (no substrateClient)", () => {
    it("orchestrator constructor works without substrateClient", () => {
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
      });
      expect(orchestrator.getSessionId()).toBeDefined();
    });

    it("buildDirective works without substrateClient", () => {
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
      });
      const directive = orchestrator.buildDirective(makeGoal(), makeTask());
      expect(directive.task_id).toBe("task-1");
    });

    it("dispatch works without substrateClient", async () => {
      const backend = mockBackend();
      const orchestrator = new Orchestrator({
        projectConfig: makeConfig(),
        backend,
      });

      const result = await orchestrator.dispatchParallel({
        tasks: [makeTask()],
        goal: makeGoal(),
        project: "test-project",
        workingDirectory: "/tmp/work",
        executeTask: vi.fn().mockResolvedValue(makeOversightResult()),
      });

      expect(result.completed).toHaveLength(1);
      expect(result.totalTokens).toBe(1_100);
    });
  });
});
