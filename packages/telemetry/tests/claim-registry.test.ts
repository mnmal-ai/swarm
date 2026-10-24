import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaimRegistry, computeClaimAccuracy } from "../src/claim-registry/index.js";
import type { FileClaim, Task } from "@mnmal-ai/swarm-types";

function mockEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn(), onAny: vi.fn(), removeAllListeners: vi.fn() } as any;
}

describe("ClaimRegistry", () => {
  let registry: ClaimRegistry;
  let eventBus: ReturnType<typeof mockEventBus>;

  beforeEach(() => {
    eventBus = mockEventBus();
    registry = new ClaimRegistry("/tmp/test-project", eventBus);
  });

  describe("register", () => {
    it("stores claims and emits claim:registered event", () => {
      const claims: FileClaim[] = [
        { taskId: "t1", creates: ["src/a.ts"], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: ["src/b.ts"], modifies: ["src/index.ts"] },
      ];
      registry.register(claims, "goal-1");
      expect(eventBus.emit).toHaveBeenCalledWith("claim:registered", expect.objectContaining({
        goalId: "goal-1",
        totalClaims: 2,
        overlapCount: 1,
      }));
    });

    it("normalizes file paths (strips leading ./)", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["./src/index.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      const conflicts = registry.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].file).toBe("src/index.ts");
    });
  });

  describe("getConflicts", () => {
    it("detects overlapping modifies as conflicts", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/routes/index.ts", "src/app.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/routes/index.ts"] },
        { taskId: "t3", creates: [], modifies: ["src/app.ts"] },
      ], "goal-1");
      const conflicts = registry.getConflicts();
      expect(conflicts).toHaveLength(2);
      expect(conflicts.find(c => c.file === "src/routes/index.ts")?.claimants).toEqual(["t1", "t2"]);
      expect(conflicts.find(c => c.file === "src/app.ts")?.claimants).toEqual(["t1", "t3"]);
    });

    it("does not flag creates as conflicts", () => {
      registry.register([
        { taskId: "t1", creates: ["src/a.ts"], modifies: [] },
        { taskId: "t2", creates: ["src/b.ts"], modifies: [] },
      ], "goal-1");
      expect(registry.getConflicts()).toHaveLength(0);
    });

    it("returns empty for single task", () => {
      registry.register([
        { taskId: "t1", creates: ["src/a.ts"], modifies: ["src/index.ts"] },
      ], "goal-1");
      expect(registry.getConflicts()).toHaveLength(0);
    });
  });

  describe("validate", () => {
    it("flags modifies targets that do not exist", async () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/nonexistent.ts"] },
      ], "goal-1");
      const result = await registry.validate();
      expect(result.valid).toBe(false);
      expect(result.missingFiles).toContain("src/nonexistent.ts");
    });

    it("flags duplicate creates", async () => {
      registry.register([
        { taskId: "t1", creates: ["src/new.ts"], modifies: [] },
        { taskId: "t2", creates: ["src/new.ts"], modifies: [] },
      ], "goal-1");
      const result = await registry.validate();
      expect(result.valid).toBe(false);
      expect(result.duplicateCreates).toContain("src/new.ts");
    });

    it("returns valid when no issues", async () => {
      registry.register([
        { taskId: "t1", creates: ["src/new.ts"], modifies: [] },
      ], "goal-1");
      const result = await registry.validate();
      expect(result.valid).toBe(true);
      expect(result.missingFiles).toHaveLength(0);
      expect(result.duplicateCreates).toHaveLength(0);
    });

    it("emits claim:validated event", async () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: [] },
      ], "goal-1");
      await registry.validate();
      expect(eventBus.emit).toHaveBeenCalledWith("claim:validated", expect.objectContaining({
        goalId: "goal-1",
        valid: true,
      }));
    });
  });

  describe("revise", () => {
    it("replaces claims for specified tasks", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      expect(registry.getConflicts()).toHaveLength(1);
      registry.revise([{ taskId: "t2", creates: [], modifies: ["src/other.ts"] }]);
      expect(registry.getConflicts()).toHaveLength(0);
    });

    it("emits claim:revised event", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      registry.revise([{ taskId: "t2", creates: [], modifies: ["src/other.ts"] }]);
      expect(eventBus.emit).toHaveBeenCalledWith("claim:revised", expect.objectContaining({
        goalId: "goal-1",
        conflictsResolved: 1,
        conflictsRemaining: 0,
      }));
    });
  });

  describe("applyToTasks", () => {
    it("sets serializedFiles to modifies array only", () => {
      registry.register([
        { taskId: "t1", creates: ["src/a.ts"], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: ["src/b.ts"], modifies: ["src/index.ts", "src/app.ts"] },
      ], "goal-1");
      const tasks: Task[] = [
        { id: "t1", goal_id: "g1", description: "task 1", intent: "implementation", status: "pending", order: 1 },
        { id: "t2", goal_id: "g1", description: "task 2", intent: "implementation", status: "pending", order: 2 },
      ];
      const result = registry.applyToTasks(tasks);
      expect(result[0].serializedFiles).toEqual(["src/index.ts"]);
      expect(result[1].serializedFiles).toEqual(["src/index.ts", "src/app.ts"]);
    });

    it("emits claim:serialization_applied event", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      const tasks: Task[] = [
        { id: "t1", goal_id: "g1", description: "task 1", intent: "implementation", status: "pending", order: 1 },
        { id: "t2", goal_id: "g1", description: "task 2", intent: "implementation", status: "pending", order: 2 },
      ];
      registry.applyToTasks(tasks);
      expect(eventBus.emit).toHaveBeenCalledWith("claim:serialization_applied", expect.objectContaining({
        goalId: "goal-1",
        tasksSerialized: 2,
      }));
    });

    it("leaves tasks without claims unchanged", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      const tasks: Task[] = [
        { id: "t1", goal_id: "g1", description: "task 1", intent: "implementation", status: "pending", order: 1 },
        { id: "t2", goal_id: "g1", description: "task 2", intent: "implementation", status: "pending", order: 2 },
      ];
      const result = registry.applyToTasks(tasks);
      expect(result[0].serializedFiles).toEqual(["src/index.ts"]);
      expect(result[1].serializedFiles).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("resets all state", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      expect(registry.getConflicts()).toHaveLength(1);
      registry.clear();
      expect(registry.getConflicts()).toHaveLength(0);
    });
  });

  describe("getSerializationConstraints", () => {
    it("returns file-to-taskIds mapping for conflicting files", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts", "src/app.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
        { taskId: "t3", creates: [], modifies: ["src/app.ts"] },
      ], "goal-1");
      const constraints = registry.getSerializationConstraints();
      expect(constraints.get("src/index.ts")).toEqual(["t1", "t2"]);
      expect(constraints.get("src/app.ts")).toEqual(["t1", "t3"]);
      expect(constraints.size).toBe(2);
    });

    it("returns empty map when no conflicts", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/a.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/b.ts"] },
      ], "goal-1");
      expect(registry.getSerializationConstraints().size).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty claims array", () => {
      registry.register([], "goal-1");
      expect(registry.getConflicts()).toHaveLength(0);
    });

    it("handles claims with empty creates and modifies", () => {
      registry.register([{ taskId: "t1", creates: [], modifies: [] }], "goal-1");
      expect(registry.getConflicts()).toHaveLength(0);
    });

    it("re-registering replaces prior claims", () => {
      registry.register([
        { taskId: "t1", creates: [], modifies: ["src/index.ts"] },
        { taskId: "t2", creates: [], modifies: ["src/index.ts"] },
      ], "goal-1");
      expect(registry.getConflicts()).toHaveLength(1);
      registry.register([{ taskId: "t3", creates: [], modifies: ["src/other.ts"] }], "goal-2");
      expect(registry.getConflicts()).toHaveLength(0);
    });
  });
});

describe("computeClaimAccuracy", () => {
  it("returns 1 for perfect match", () => {
    expect(computeClaimAccuracy(["a.ts", "b.ts"], ["a.ts", "b.ts"])).toBe(1);
  });

  it("returns 0 for no overlap", () => {
    expect(computeClaimAccuracy(["a.ts"], ["b.ts"])).toBe(0);
  });

  it("returns Jaccard similarity for partial overlap", () => {
    expect(computeClaimAccuracy(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBeCloseTo(0.333, 2);
  });

  it("normalizes paths", () => {
    expect(computeClaimAccuracy(["./src/a.ts"], ["src/a.ts"])).toBe(1);
  });

  it("returns 1 for both empty", () => {
    expect(computeClaimAccuracy([], [])).toBe(1);
  });
});
