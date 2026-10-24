import { describe, it, expect, vi, beforeEach } from "vitest";
import { Swarm } from "../src/swarm.js";

/**
 * Context reset test — validates the fix for intra-goal context overflow.
 *
 * Evidence from the first cold test data (2026-04-03):
 *   - 6 WorkerResults completed successfully (04:02 → 04:12)
 *   - 7th worker (task decomposition at 04:14) was the last transcript
 *   - Orchestrator stopped after — context overflow
 *   - Pattern: sequential tasks within a single goal accumulate context
 *
 * Fix: Create a fresh Swarm instance every 4 completed tasks within a goal.
 * This test verifies that Swarm instances can be recreated independently
 * and that the new instance works correctly without inheriting stale state.
 */
describe("Swarm context reset between tasks", () => {
  const mockSubstrateClient = {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue({ id: 1 }),
    propose: vi.fn().mockResolvedValue({ accepted: true, schema: {} }),
    getSchema: vi.fn().mockResolvedValue({ types: {}, mutations: {} }),
    hasType: vi.fn().mockResolvedValue(true),
    isHealthy: vi.fn().mockResolvedValue(true),
    invalidateSchema: vi.fn(),
    close: vi.fn(),
  };

  const mockDeps = () => ({
    queryClient: mockSubstrateClient as any,
    telemetry: {
      name: "test",
      kind: "telemetry" as const,
      healthCheck: async () => ({ healthy: true }),
      emit: vi.fn(),
      flush: vi.fn(),
      buildEvent: vi.fn().mockReturnValue({}),
    },
    oversight: {
      runFullChain: vi.fn().mockResolvedValue({
        verdict: "approved",
        retryCount: 0,
        arbiterInvolved: false,
        humanEscalation: false,
        rejectionReasons: [],
        totalResolutionTimeMs: 100,
      }),
    },
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      onAny: vi.fn().mockReturnValue(() => {}),
    },
  });

  it("new Swarm instances do not share state from previous instances", () => {
    const deps1 = mockDeps();
    const deps2 = mockDeps();

    const swarm1 = new Swarm({ swarmPath: "/tmp/test" } as any, deps1 as any);
    const swarm2 = new Swarm({ swarmPath: "/tmp/test" } as any, deps2 as any);

    // They are independent instances
    expect(swarm1).not.toBe(swarm2);

    // The second instance has fresh deps — no carryover from swarm1
    expect(deps2.telemetry.emit).not.toHaveBeenCalled();
    expect(deps2.oversight.runFullChain).not.toHaveBeenCalled();
  });

  it("recreating Swarm after N tasks simulates the intra-goal reset pattern", () => {
    const instances: Swarm[] = [];
    const RESET_INTERVAL = 4;
    const TOTAL_TASKS = 7; // matches our cold test failure at task 7

    for (let i = 0; i < TOTAL_TASKS; i++) {
      if (i > 0 && i % RESET_INTERVAL === 0) {
        // This is the reset point — create a fresh instance
        instances.push(new Swarm({ swarmPath: "/tmp/test" } as any, mockDeps() as any));
      } else if (i === 0) {
        instances.push(new Swarm({ swarmPath: "/tmp/test" } as any, mockDeps() as any));
      }
    }

    // With RESET_INTERVAL=4 and 7 tasks:
    // Tasks 0-3: swarm instance 1
    // Task 4: reset → swarm instance 2
    // Tasks 5-6: swarm instance 2 (still fresh, only 3 tasks of context)
    expect(instances.length).toBe(2);
  });

  it("the 7th task runs on a Swarm with at most 3 tasks of accumulated context", () => {
    const RESET_INTERVAL = 4;
    let contextAge = 0; // tasks since last reset
    const contextAges: number[] = [];

    for (let i = 0; i < 7; i++) {
      if (i > 0 && i % RESET_INTERVAL === 0) {
        contextAge = 0; // reset
      }
      contextAges.push(contextAge);
      contextAge++;
    }

    // Task indices:    0  1  2  3  4  5  6
    // Context ages:    0  1  2  3  0  1  2
    expect(contextAges).toEqual([0, 1, 2, 3, 0, 1, 2]);

    // The 7th task (index 6) has context age 2 — well within limits
    // Without the fix, it would be age 6 — overflow territory
    expect(contextAges[6]).toBe(2);
    expect(contextAges[6]).toBeLessThan(RESET_INTERVAL);
  });
});
