import { describe, it, expect, vi } from "vitest";
import { Oversight } from "../src/index.js";
import type { DocumentGuard, IWorkerBackend, ModelProvider, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// A reviewer running on a backend gets the worker's document index (with the
// sections the worker read) after the worker's summary, and the same read
// guard. Without them, its prompt and input are as before. The API path is
// unchanged.
// ---------------------------------------------------------------------------

const LONG_OUTPUT = "worker output text here that is long enough to pass validation easily ".repeat(3);
const APPROVE = '{"verdict": "approved", "reasons": [], "suggestions": []}';
const INDEX = "## Sections the worker read\n- docs/api.md L41–120\n\n## Documents\n\n- docs/api.md (1,200 tok, 2 sections) — API reference";
const GUARD: DocumentGuard = {
  maxReadTokens: 4000,
  documents: [{ absolutePath: "/tmp/w/docs/api.md", displayPath: "docs/api.md", contentHash: "h", sections: [] }],
};

function provider(response: string): ModelProvider {
  return {
    name: "anthropic",
    execute: vi.fn().mockResolvedValue({
      output: response,
      tokens: { input: 100, output: 50 },
      latencyMs: 5,
      model: { provider: "anthropic", modelId: "test" },
    }),
  };
}

function backend(output: string): IWorkerBackend {
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({
      output,
      latencyMs: 5,
      tokensUsed: { input: 10, output: 10 },
      filesChanged: [],
      backendUsed: "claude-code",
    } satisfies WorkerTaskOutput),
  };
}

function oversight() {
  const reviewerProvider = provider(APPROVE);
  const o = new Oversight({ reviewerProvider, reviewerModel: "r", arbiterProvider: provider(APPROVE), arbiterModel: "a" });
  return { o, reviewerProvider };
}

const inputOf = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerTaskInput;

describe("the document index in the reviewer's backend session", () => {
  it("ends the reviewer's task with the index and gives it the worker's guard", async () => {
    const { o } = oversight();
    const b = backend(APPROVE);
    await o.review("mode context", "the task", LONG_OUTPUT, { reviewerBackend: b, workingDirectory: "/tmp/w", documentIndex: () => INDEX, documentGuard: GUARD });
    const input = inputOf(b.execute);
    expect(input.task.endsWith(`## Worker's Summary\n${LONG_OUTPUT}\n\n${INDEX}`)).toBe(true);
    expect(input.documents).toBe(GUARD);
  });

  it("leaves the reviewer's task and input as before without them, or when the index is empty", async () => {
    for (const opts of [{}, { documentIndex: () => "" }]) {
      const { o } = oversight();
      const b = backend(APPROVE);
      await o.review("mode context", "the task", LONG_OUTPUT, { reviewerBackend: b, workingDirectory: "/tmp/w", ...opts });
      const input = inputOf(b.execute);
      expect(input.task.endsWith(`## Worker's Summary\n${LONG_OUTPUT}`)).toBe(true);
      expect(input).not.toHaveProperty("documents");
    }
  });

  it("leaves the API path alone", async () => {
    const { o, reviewerProvider } = oversight();
    await o.review("mode context", "the task", LONG_OUTPUT, { documentIndex: () => INDEX, documentGuard: GUARD });
    const prompt = ((reviewerProvider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("## Sections the worker read");
  });

  it("is passed through by runFullChain", async () => {
    const { o } = oversight();
    const b = backend(APPROVE);
    const documentIndex = vi.fn(() => INDEX);
    await o.runFullChain({
      modeContext: "mode context",
      originalTask: "the task",
      workerOutput: LONG_OUTPUT,
      maxRetries: 0,
      sessionId: "sess-1",
      reviewerBackend: b,
      workingDirectory: "/tmp/w",
      documentIndex,
      documentGuard: GUARD,
    });
    const input = inputOf(b.execute);
    expect(documentIndex).toHaveBeenCalled();
    expect(input.task.endsWith(INDEX)).toBe(true);
    expect(input.documents).toBe(GUARD);
  });
});
