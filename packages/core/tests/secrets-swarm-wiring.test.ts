import { describe, it, expect, vi } from "vitest";
import { Loader } from "../src/index.js";
import type { LoadingPriorityEntry } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Mock SubstrateClient helper
// ---------------------------------------------------------------------------

function createMockSubstrateClient(entities: Array<Record<string, unknown>>) {
  return {
    query: vi.fn(async () => entities),
    mutate: vi.fn(),
    propose: vi.fn(),
    getSchema: vi.fn(),
    hasType: vi.fn(),
    invalidateSchema: vi.fn(),
    isHealthy: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// Loader secrets tier
// ---------------------------------------------------------------------------

describe("Loader secrets tier", () => {
  it("loads secrets.md when secrets tier is in loading priority", async () => {
    const entities = [
      {
        path: "domains/test-project/secrets.md",
        tier: "secrets",
        intent: "",
        content: "# test-project — Secrets\n\n## Setup Instructions\n\nDo the thing.\n",
        tokenEstimate: 16,
        lastReviewed: "2026-03-01",
        projectId: "test-project",
      },
    ];

    const client = createMockSubstrateClient(entities);
    const loader = new Loader(client as any);
    const route = {
      intent: "implementation",
      description: "test",
      keywords: [] as string[],
      load: {
        all: ["domains/test-project/secrets.md"],
      },
    };

    const priority: LoadingPriorityEntry[] = [
      { tier: "secrets", required: false },
    ];

    const result = await loader.load(route, 15000, priority);
    expect(result.files.length).toBe(1);
    expect(result.files[0].path).toBe("domains/test-project/secrets.md");
    expect(result.files[0].content).toContain("Setup Instructions");
  });

  it("silently skips secrets tier when entity does not exist", async () => {
    // No entities match — empty store
    const client = createMockSubstrateClient([]);
    const loader = new Loader(client as any);
    const route = {
      intent: "implementation",
      description: "test",
      keywords: [] as string[],
      load: {
        all: ["domains/test-project/secrets.md"],
      },
    };

    const priority: LoadingPriorityEntry[] = [
      { tier: "secrets", required: false },
    ];

    const result = await loader.load(route, 15000, priority);
    expect(result.files.length).toBe(0);
  });
});
