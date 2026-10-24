/**
 * Planning and investigation sessions used to start with every source file in
 * the checkout pasted into the prompt (up to 500 KB), on every backend. A
 * backend that reads files itself (direct execution) gets a pointer to the
 * checkout instead and reads what it needs; the API loop, whose read_file
 * costs a tool round trip, keeps the pre-read.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmConfig, IWorkerBackend, WorkerTaskInput } from "@mnmal-ai/swarm-types";
import { Swarm } from "../src/index.js";

const apiPrompts: string[] = [];
vi.mock("../src/executor/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createProvider: () => ({
      name: "anthropic",
      execute: async (input: { prompt: string }) => {
        apiPrompts.push(input.prompt);
        return { output: "api result", tokens: { input: 1, output: 1 }, latencyMs: 1 };
      },
    }),
  };
});

const MARKER = "PRE_READ_MARKER_7f3a";

const prepared = (intent: string) => ({
  intent,
  confidence: "exact" as const,
  matchedKeywords: [],
  content: "--- swarm: core/rules.md (core) ---\nRULES",
  filesIncluded: [{ path: "core/rules.md", tier: "core", tokens: 5 }],
  tokensUsed: 5,
  budgetTokens: 15000,
  routeMatched: { intent, description: "" },
  truncated: [],
  complexity: 0.5,
});

let workdir: string;

beforeEach(() => {
  apiPrompts.length = 0;
  workdir = mkdtempSync(join(tmpdir(), "swarm-pre-read-"));
  mkdirSync(join(workdir, "src"));
  writeFileSync(join(workdir, "src", "app.ts"), `export const marker = "${MARKER}";\n`);
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function swarmWith(intent: string, direct: boolean) {
  const inputs: WorkerTaskInput[] = [];
  const backend = {
    type: direct ? "claude-code" : "api",
    supportsDirectExecution: direct,
    isAvailable: async () => true,
    execute: async (input: WorkerTaskInput) => {
      inputs.push(input);
      return { output: "done", tokensUsed: { input: 1, output: 1 }, latencyMs: 1, filesChanged: [], backendUsed: "claude-code" };
    },
  } as unknown as IWorkerBackend;
  const config = {
    swarmPath: "/srv/swarm",
    provider: "anthropic",
    model: "test-model",
    apiKey: "test-key-not-used",
    workerBackend: backend,
  } as SwarmConfig;
  const swarm = new Swarm(config, {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    queryClient: { prepareTask: vi.fn(async () => prepared(intent)), query: vi.fn(async () => []) } as any,
  });
  return { swarm, inputs };
}

const run = (swarm: Swarm) => swarm.run("Break the goal into tasks", { input: "", workingDirectory: workdir, project: "acme" });

describe("pre-reading source files", () => {
  for (const intent of ["orchestration", "investigation"]) {
    it(`gives a direct-execution ${intent} session a pointer to the checkout, not every source file`, async () => {
      const { swarm, inputs } = swarmWith(intent, true);
      await run(swarm);

      expect(inputs).toHaveLength(1);
      expect(inputs[0].task).not.toContain(MARKER);
      expect(inputs[0].task).not.toContain("Pre-loaded Source Files");
      expect(inputs[0].task).toContain("## Source files");
      // The turn allowance is the run's, as before (Swarm.run passes its resolved maxTurns).
      expect(inputs[0].maxTurns).toBe(50);
    });
  }

  it("still pre-reads for the API loop, whose read_file costs a tool round trip", async () => {
    const { swarm, inputs } = swarmWith("orchestration", false);
    await run(swarm);

    expect(inputs).toHaveLength(0);
    expect(apiPrompts).toHaveLength(1);
    expect(apiPrompts[0]).toContain("Pre-loaded Source Files");
    expect(apiPrompts[0]).toContain(MARKER);
  });

  it("adds nothing for other intents", async () => {
    const { swarm, inputs } = swarmWith("implementation", true);
    await run(swarm);

    expect(inputs[0].task).toBe("Break the goal into tasks");
  });
});
