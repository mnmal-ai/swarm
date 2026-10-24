import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDiscovery } from "../src/orchestrator/discovery.js";
import type {
  DiscoveryCommand,
  DiscoveryPhaseResult,
} from "../src/orchestrator/discovery.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import type {
  TaskBackend,
  ProjectConfig,
  TrustLevel,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockBackend(): TaskBackend {
  return {
    getGoals: vi.fn().mockResolvedValue([]),
    createGoal: vi.fn().mockResolvedValue("goal-1"),
    getTasks: vi.fn().mockResolvedValue([]),
    getAllTasks: vi.fn().mockResolvedValue([]),
    getTaskById: vi.fn().mockResolvedValue(null),
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
    created: "2026-02-28T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Tests — runDiscovery (standalone function)
// ---------------------------------------------------------------------------

describe("runDiscovery", () => {
  it("captures successful command output", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "echo hello",
        cwd: "/tmp",
        label: "echo-test",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].exitCode).toBe(0);
    expect(result.results[0].stdout).toContain("hello");
    expect(result.results[0].label).toBe("echo-test");
    expect(result.results[0].command).toBe("echo hello");
    expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.results[0].timestamp).toBeGreaterThan(0);
    expect(result.summary).toBe("Discovery: 1/1 passed, 0 failed");
    expect(result.errorContext).toBe("");
  });

  it("captures failed command output", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "sh -c 'echo error-output >&2; exit 1'",
        cwd: "/tmp",
        label: "fail-test",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].exitCode).toBe(1);
    expect(result.results[0].stderr).toContain("error-output");
    expect(result.summary).toBe("Discovery: 0/1 passed, 1 failed");
    expect(result.errorContext).toContain("[fail-test] exit 1:");
    expect(result.errorContext).toContain("error-output");
  });

  it("handles multiple commands with mixed results", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "echo success",
        cwd: "/tmp",
        label: "passing",
      },
      {
        command: "sh -c 'exit 2'",
        cwd: "/tmp",
        label: "failing",
      },
      {
        command: "echo also-success",
        cwd: "/tmp",
        label: "also-passing",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.results).toHaveLength(3);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].exitCode).toBe(2);
    expect(result.results[2].success).toBe(true);
    expect(result.summary).toBe("Discovery: 2/3 passed, 1 failed");
    // errorContext only includes failed commands
    expect(result.errorContext).toContain("[failing] exit 2:");
    expect(result.errorContext).not.toContain("passing");
  });

  it("handles timeout", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "sleep 10",
        cwd: "/tmp",
        timeoutMs: 200,
        label: "timeout-test",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    // Exit code may vary on timeout (null -> 1 via the ?? 1 fallback)
    expect(result.results[0].exitCode).toBeGreaterThanOrEqual(1);
    expect(result.summary).toContain("0/1 passed");
  });

  it("truncates stdout and stderr to 5000 chars", async () => {
    // Generate output longer than 5000 chars
    // Use a command that produces a long string
    const commands: DiscoveryCommand[] = [
      {
        command: "sh -c 'python3 -c \"print(\\\"x\\\" * 10000)\" 2>/dev/null || printf \"%010000d\" 0'",
        cwd: "/tmp",
        label: "truncation-test",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.results).toHaveLength(1);
    // stdout should be at most 5000 chars (the last 5000)
    expect(result.results[0].stdout.length).toBeLessThanOrEqual(5000);
  });

  it("builds error context from multiple failures", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "sh -c 'echo build-error >&2; exit 1'",
        cwd: "/tmp",
        label: "build",
      },
      {
        command: "sh -c 'echo test-error >&2; exit 1'",
        cwd: "/tmp",
        label: "test",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.errorContext).toContain("[build] exit 1:");
    expect(result.errorContext).toContain("build-error");
    expect(result.errorContext).toContain("---");
    expect(result.errorContext).toContain("[test] exit 1:");
    expect(result.errorContext).toContain("test-error");
  });

  it("uses stdout as fallback when stderr is empty in error context", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "sh -c 'echo stdout-only; exit 1'",
        cwd: "/tmp",
        label: "stdout-fallback",
      },
    ];

    const result = await runDiscovery(commands);

    expect(result.results[0].success).toBe(false);
    // errorContext should use stdout since stderr is empty
    expect(result.errorContext).toContain("stdout-only");
  });

  it("returns empty results for empty commands array", async () => {
    const result = await runDiscovery([]);

    expect(result.results).toHaveLength(0);
    expect(result.summary).toBe("Discovery: 0/0 passed, 0 failed");
    expect(result.errorContext).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests — Orchestrator.runDiscovery (method with event emission)
// ---------------------------------------------------------------------------

describe("Orchestrator.runDiscovery", () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator({
      projectConfig: makeConfig(),
      backend: mockBackend(),
    });
  });

  it("runs discovery and returns results", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "echo orchestrator-test",
        cwd: "/tmp",
        label: "test",
      },
    ];

    const result = await orchestrator.runDiscovery(commands);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
    expect(result.summary).toContain("1/1 passed");
  });

  it("emits discovery_started and discovery_completed events", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "echo ok",
        cwd: "/tmp",
        label: "build",
      },
    ];

    await orchestrator.runDiscovery(commands, "goal-42");

    const events = orchestrator.getEvents();
    const discoveryEvents = events.filter(
      (e) => e.event_type === "discovery_started" || e.event_type === "discovery_completed",
    );

    expect(discoveryEvents).toHaveLength(2);
    expect(discoveryEvents[0].event_type).toBe("discovery_started");
    expect(discoveryEvents[0].goal_id).toBe("goal-42");
    expect(discoveryEvents[0].detail).toContain("1 discovery command(s)");

    expect(discoveryEvents[1].event_type).toBe("discovery_completed");
    expect(discoveryEvents[1].goal_id).toBe("goal-42");
    expect(discoveryEvents[1].detail).toContain("1/1 passed");
  });

  it("emits events without goalId when not provided", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "echo ok",
        cwd: "/tmp",
        label: "lint",
      },
    ];

    await orchestrator.runDiscovery(commands);

    const events = orchestrator.getEvents();
    const discoveryEvents = events.filter(
      (e) => e.event_type === "discovery_started" || e.event_type === "discovery_completed",
    );

    expect(discoveryEvents).toHaveLength(2);
    expect(discoveryEvents[0].goal_id).toBeUndefined();
    expect(discoveryEvents[1].goal_id).toBeUndefined();
  });

  it("records failure information in completed event", async () => {
    const commands: DiscoveryCommand[] = [
      {
        command: "echo ok",
        cwd: "/tmp",
        label: "build",
      },
      {
        command: "sh -c 'exit 1'",
        cwd: "/tmp",
        label: "test",
      },
    ];

    const result = await orchestrator.runDiscovery(commands);

    expect(result.summary).toContain("1/2 passed, 1 failed");
    expect(result.errorContext.length).toBeGreaterThan(0);

    const events = orchestrator.getEvents();
    const completed = events.find((e) => e.event_type === "discovery_completed");
    expect(completed).toBeDefined();
    expect(completed!.detail).toContain("1/2 passed");
  });
});
