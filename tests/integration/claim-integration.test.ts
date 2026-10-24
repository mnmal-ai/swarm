import { describe, it, expect, vi } from "vitest";
import { ClaimRegistry } from "@mnmal-ai/swarm-telemetry";
import type { Task } from "@mnmal-ai/swarm-types";
import {
  applySharedFileConstraints,
  topologicalSort,
} from "@mnmal-ai/swarm-orchestrator";

function mockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    onAny: vi.fn(),
    removeAllListeners: vi.fn(),
  } as any;
}

describe("ClaimRegistry → DAG integration", () => {
  it("claims inject serializedFiles that DAG uses to serialize conflicting tasks", () => {
    const eventBus = mockEventBus();
    const registry = new ClaimRegistry("/tmp/test", eventBus);

    registry.register(
      [
        { taskId: "t1", creates: ["src/auth.ts"], modifies: ["src/routes/index.ts"] },
        { taskId: "t2", creates: ["src/events.ts"], modifies: ["src/routes/index.ts"] },
        { taskId: "t3", creates: ["src/utils.ts"], modifies: [] },
      ],
      "goal-1",
    );

    const tasks: Task[] = [
      {
        id: "t1",
        goal_id: "g1",
        description: "auth",
        intent: "implementation",
        status: "pending",
        order: 1,
      },
      {
        id: "t2",
        goal_id: "g1",
        description: "events",
        intent: "implementation",
        status: "pending",
        order: 2,
      },
      {
        id: "t3",
        goal_id: "g1",
        description: "utils",
        intent: "implementation",
        status: "pending",
        order: 3,
      },
    ];

    const withClaims = registry.applyToTasks(tasks);

    // t1 and t2 should have serializedFiles set
    expect(withClaims[0].serializedFiles).toEqual(["src/routes/index.ts"]);
    expect(withClaims[1].serializedFiles).toEqual(["src/routes/index.ts"]);
    expect(withClaims[2].serializedFiles).toBeUndefined();

    // Build DAG nodes and apply shared file constraints
    const dagNodes = withClaims.map((t) => ({
      id: t.id,
      dependsOn: t.dependsOn ?? [],
      serializedFiles: t.serializedFiles,
    }));

    // Use the DAG function to apply shared file constraints
    const constrained = applySharedFileConstraints(dagNodes);

    // t1 and t2 should now have a dependency relationship
    const t2Node = constrained.find((n) => n.id === "t2");
    expect(t2Node?.dependsOn).toContain("t1");

    // t3 should still be independent
    const t3Node = constrained.find((n) => n.id === "t3");
    expect(t3Node?.dependsOn).toHaveLength(0);

    // Topological sort should put t1 and t2 in different tiers
    const tiers = topologicalSort(constrained);
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    expect(tiers[0]).toContain("t3");
  });

  it("tasks with no overlapping claims remain fully parallel", () => {
    const eventBus = mockEventBus();
    const registry = new ClaimRegistry("/tmp/test", eventBus);

    registry.register(
      [
        { taskId: "t1", creates: ["src/a.ts"], modifies: ["src/a-config.ts"] },
        { taskId: "t2", creates: ["src/b.ts"], modifies: ["src/b-config.ts"] },
        { taskId: "t3", creates: ["src/c.ts"], modifies: ["src/c-config.ts"] },
      ],
      "goal-1",
    );

    expect(registry.getConflicts()).toHaveLength(0);

    const tasks: Task[] = [
      {
        id: "t1",
        goal_id: "g1",
        description: "a",
        intent: "implementation",
        status: "pending",
        order: 1,
      },
      {
        id: "t2",
        goal_id: "g1",
        description: "b",
        intent: "implementation",
        status: "pending",
        order: 2,
      },
      {
        id: "t3",
        goal_id: "g1",
        description: "c",
        intent: "implementation",
        status: "pending",
        order: 3,
      },
    ];

    const withClaims = registry.applyToTasks(tasks);
    const dagNodes = withClaims.map((t) => ({
      id: t.id,
      dependsOn: t.dependsOn ?? [],
      serializedFiles: t.serializedFiles,
    }));

    const constrained = applySharedFileConstraints(dagNodes);
    const tiers = topologicalSort(constrained);

    // All tasks should be in tier 0 — fully parallel
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toHaveLength(3);
  });
});
