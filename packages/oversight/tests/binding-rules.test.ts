import { describe, it, expect, vi } from "vitest";
import { Oversight } from "../src/index.js";
import type { IWorkerBackend, ModelProvider, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// The reviewer and the arbiter judge work against the project's binding rules
// (core rules and the project's constraints), delivered in full ahead of the
// role-specific content, on the backend path and on the API path alike.
// ---------------------------------------------------------------------------

const RULES = "--- core/rules.md ---\n- Never force push to main.\n\n--- domains/acme/constraints.md ---\n- Never edit an existing migration.";
const HEADING = "## Project Rules (binding)";
const LONG_OUTPUT = "worker output text here that is long enough to pass validation easily ".repeat(3);

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

function oversight(reviewerSays: string, arbiterSays: string) {
  const reviewerProvider = provider(reviewerSays);
  const arbiterProvider = provider(arbiterSays);
  const o = new Oversight({ reviewerProvider, reviewerModel: "r", arbiterProvider, arbiterModel: "a" });
  return { o, reviewerProvider, arbiterProvider };
}

const APPROVE = '{"verdict": "approved", "reasons": [], "suggestions": []}';
const REJECT = '{"verdict": "rejected", "reasons": ["breaks a rule"], "suggestions": []}';
const RULING = '{"verdict": "approved", "reasoning": "fine"}';

const promptOf = (fn: unknown) => ((fn as ReturnType<typeof vi.fn>).mock.calls[0][0] as { prompt: string }).prompt;
const taskOf = (fn: unknown) => ((fn as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerTaskInput).task;

function expectRulesFirst(text: string): void {
  expect(text.startsWith(HEADING)).toBe(true);
  expect(text).toContain("A violation of any of them is grounds to reject");
  expect(text).toContain("- Never force push to main.");
  expect(text).toContain("- Never edit an existing migration.");
}

describe("binding rules in the reviewer's and the arbiter's prompts", () => {
  it("puts them first in the reviewer's backend prompt", async () => {
    const { o } = oversight(APPROVE, RULING);
    const b = backend(APPROVE);
    await o.review("mode context", "the task", LONG_OUTPUT, { reviewerBackend: b, workingDirectory: "/tmp/w", bindingRules: RULES });
    const task = taskOf(b.execute);
    expectRulesFirst(task);
    expect(task.indexOf(HEADING)).toBeLessThan(task.indexOf("## Swarm Expectations"));
  });

  it("puts them first in the reviewer's API prompt", async () => {
    const { o, reviewerProvider } = oversight(APPROVE, RULING);
    await o.review("mode context", "the task", LONG_OUTPUT, { bindingRules: RULES });
    expectRulesFirst(promptOf(reviewerProvider.execute));
  });

  it("puts them first in the arbiter's backend and API prompts", async () => {
    const { o, arbiterProvider } = oversight(APPROVE, RULING);
    const b = backend(RULING);
    await o.arbitrate("the task", LONG_OUTPUT, ["breaks a rule"], { arbiterBackend: b, workingDirectory: "/tmp/w", bindingRules: RULES });
    expectRulesFirst(taskOf(b.execute));

    await o.arbitrate("the task", LONG_OUTPUT, ["breaks a rule"], { bindingRules: RULES });
    expectRulesFirst(promptOf(arbiterProvider.execute));
  });

  it("threads them from runFullChain to the reviewer and to the arbiter", async () => {
    const { o, reviewerProvider, arbiterProvider } = oversight(REJECT, RULING);
    await o.runFullChain({ modeContext: "mode", originalTask: "the task", workerOutput: LONG_OUTPUT, maxRetries: 0, sessionId: "s1", bindingRules: RULES });
    expectRulesFirst(promptOf(reviewerProvider.execute));
    expectRulesFirst(promptOf(arbiterProvider.execute));
  });

  it("leaves the prompts as they were when a project has no binding rules", async () => {
    const { o, reviewerProvider } = oversight(APPROVE, RULING);
    await o.review("mode context", "the task", LONG_OUTPUT, {});
    expect(promptOf(reviewerProvider.execute)).not.toContain(HEADING);
    expect(promptOf(reviewerProvider.execute).startsWith("## Swarm Expectations")).toBe(true);
  });
});

describe("binding rules delivered by index (context.rules)", () => {
  const INDEXED = "## Project Rules\n\nEvery rule below binds.\n\n### /srv/swarm/core/rules.md\n\n- Never force push to main.\n\nRead when relevant:\n- L20–28 Releases (40 tok) — Release notes are for users.";

  it("gives a reviewer on a backend the indexed rules, and one on the API the rules in full", async () => {
    const { o, reviewerProvider } = oversight(APPROVE, RULING);
    const b = backend(APPROVE);
    await o.review("mode", "the task", LONG_OUTPUT, { reviewerBackend: b, workingDirectory: "/tmp/w", bindingRules: RULES, bindingRulesIndexed: INDEXED });
    expect(taskOf(b.execute)).toContain("- L20–28 Releases (40 tok)");
    expect(taskOf(b.execute)).not.toContain("- Never edit an existing migration.");

    await o.review("mode", "the task", LONG_OUTPUT, { bindingRules: RULES, bindingRulesIndexed: INDEXED });
    expectRulesFirst(promptOf(reviewerProvider.execute));
    expect(promptOf(reviewerProvider.execute)).not.toContain("L20–28");
  });

  it("does the same for the arbiter, and threads both from runFullChain", async () => {
    const { o, arbiterProvider } = oversight(REJECT, RULING);
    const b = backend(RULING);
    await o.arbitrate("the task", LONG_OUTPUT, ["breaks a rule"], { arbiterBackend: b, workingDirectory: "/tmp/w", bindingRules: RULES, bindingRulesIndexed: INDEXED });
    expect(taskOf(b.execute)).toContain("- L20–28 Releases (40 tok)");

    const reviewer = backend(REJECT);
    const arbiter = backend(RULING);
    await o.runFullChain({
      modeContext: "mode",
      originalTask: "the task",
      workerOutput: LONG_OUTPUT,
      maxRetries: 0,
      sessionId: "s1",
      bindingRules: RULES,
      bindingRulesIndexed: INDEXED,
      reviewerBackend: reviewer,
      arbiterBackend: arbiter,
      workingDirectory: "/tmp/w",
    });
    expect(taskOf(reviewer.execute)).toContain("- L20–28 Releases (40 tok)");
    expect(taskOf(arbiter.execute)).toContain("- L20–28 Releases (40 tok)");
    expect(arbiterProvider.execute).not.toHaveBeenCalled();
  });
});
