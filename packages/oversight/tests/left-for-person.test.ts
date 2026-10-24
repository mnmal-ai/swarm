import { describe, it, expect, vi } from "vitest";
import { Oversight, extractDeferred } from "../src/index.js";
import { LoginExpiredError } from "@mnmal-ai/swarm-types";
import type { IWorkerBackend, ModelProvider, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";

/**
 * What a reviewer leaves for a person. The reviewer lists it in `deferred`
 * (and accepted deviations in `notes`); a reviewer that only says so in its
 * reasons is still heard, through extractDeferred. Either way the items reach
 * OversightResult, which `swarm run` puts on the PR, the source item and the
 * run summary.
 */

function provider(response: string): ModelProvider & { execute: ReturnType<typeof vi.fn> } {
  return {
    name: "anthropic",
    execute: vi.fn().mockResolvedValue({
      output: response,
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: { provider: "anthropic", modelId: "unused" },
    }),
  };
}

function backend(outputs: Array<string | Error>): IWorkerBackend & { prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    prompts,
    execute: vi.fn(async (input: WorkerTaskInput): Promise<WorkerTaskOutput> => {
      prompts.push(`${input.swarmContext}\n${input.task}`);
      const output = outputs[Math.min(call++, outputs.length - 1)];
      if (output instanceof Error) throw output;
      return { output, latencyMs: 1, tokensUsed: { input: 1, output: 1 }, filesChanged: [], backendUsed: "claude-code" };
    }),
  };
}

function oversight(opts: { arbiterPolicy?: "on_disagreement" | "always"; reviewerApi?: ModelProvider; arbiterApi?: ModelProvider } = {}) {
  return new Oversight({
    reviewerProvider: opts.reviewerApi ?? provider('{"verdict": "approved", "reasons": []}'),
    reviewerModel: "reviewer-model",
    arbiterProvider: opts.arbiterApi ?? provider('{"verdict": "approved", "reasoning": "fine"}'),
    arbiterModel: "arbiter-model",
    arbiterPolicy: opts.arbiterPolicy,
  });
}

function chain(o: Oversight, reviewer: IWorkerBackend, arbiter: IWorkerBackend, onRetry?: () => Promise<string>) {
  return o.runFullChain({
    modeContext: "",
    originalTask: "Add the export button",
    workerOutput: "I added the export button and a test for it; the on-device check is HUMAN-DEFERRED.",
    maxRetries: onRetry ? 1 : 0,
    sessionId: "sess-worker",
    reviewerBackend: reviewer,
    arbiterBackend: arbiter,
    workingDirectory: "/tmp/wt",
    onRetry,
  });
}

describe("the reviewer's deferred and notes lists", () => {
  it("asks for them in both reviewer prompts", async () => {
    const reviewer = backend(['{"verdict": "approved", "reasons": [], "deferred": [], "notes": []}']);
    await chain(oversight(), reviewer, backend(["unused"]));
    expect(reviewer.prompts[0]).toContain('"deferred": []');
    expect(reviewer.prompts[0]).toContain("one line per item left for a person");

    const api = provider('{"verdict": "approved", "reasons": []}');
    await oversight({ reviewerApi: api }).runFullChain({
      modeContext: "",
      originalTask: "Add the export button",
      workerOutput: "I added the export button, wired it to the existing export service, and added a unit test covering the empty and full cases; all tests pass.",
      maxRetries: 0,
      sessionId: "sess-api",
    });
    expect(api.execute.mock.calls[0][0].systemContext).toContain('"deferred": []');
  });

  it("carries a passed task's items to OversightResult", async () => {
    const reviewer = backend([JSON.stringify({
      verdict: "completed_with_deferrals",
      reasons: ["All agent-feasible criteria pass."],
      deferred: ["Check the button on a physical phone", " ", "Check the button on a physical phone"],
      notes: ["Used the existing icon instead of a new one"],
    })]);
    const result = await chain(oversight(), reviewer, backend(["unused"]));
    expect(result.verdict).toBe("completed_with_deferrals");
    expect(result.deferred).toEqual(["Check the button on a physical phone"]);
    expect(result.notes).toEqual(["Used the existing icon instead of a new one"]);
  });

  it("leaves both out when there are none", async () => {
    const reviewer = backend(['{"verdict": "approved", "reasons": ["Every criterion met."], "deferred": [], "notes": []}']);
    const result = await chain(oversight(), reviewer, backend(["unused"]));
    expect(result).not.toHaveProperty("deferred");
    expect(result).not.toHaveProperty("notes");
  });

  it("falls back to the deferral sentences in the reasons", async () => {
    const reviewer = backend([JSON.stringify({
      verdict: "completed_with_deferrals",
      reasons: [
        "All agent-feasible criteria pass. Deferred to a person: the on-device check needs a phone.",
        "HUMAN-DEFERRED: rotate the staging key.",
        "The screen-reader pass needs a person with the device.",
      ],
    })]);
    const result = await chain(oversight(), reviewer, backend(["unused"]));
    expect(result.deferred).toEqual([
      "The on-device check needs a phone.",
      "Rotate the staging key.",
      "The screen-reader pass needs a person with the device.",
    ]);
  });

  it("keeps an approval's items when the arbiter signs off, and drops them when it overturns", async () => {
    const review = JSON.stringify({ verdict: "completed_with_deferrals", reasons: [], deferred: ["Check it on a phone"] });
    const agreed = await chain(
      oversight({ arbiterPolicy: "always" }),
      backend([review]),
      backend(['{"verdict": "completed_with_deferrals", "reasoning": "Verified. HUMAN-DEFERRED: review the copy."}']),
    );
    expect(agreed.deferred).toEqual(["Check it on a phone", "Review the copy."]);

    const overturned = await chain(
      oversight({ arbiterPolicy: "always" }),
      backend([review]),
      backend(['{"verdict": "rejected", "reasoning": "the button is missing"}']),
    );
    expect(overturned.humanEscalation).toBe(true);
    expect(overturned).not.toHaveProperty("deferred");
  });

  it("keeps the last review's items when the arbiter passes a disputed task", async () => {
    const reject = JSON.stringify({ verdict: "rejected", reasons: ["no test for the empty state"], deferred: ["Check it on a phone"] });
    const result = await chain(
      oversight(),
      backend([reject, reject]),
      backend(['{"verdict": "completed_with_deferrals", "reasoning": "the empty state is covered by an existing test"}']),
      async () => "Added a note on the empty-state test.",
    );
    expect(result.arbiterInvolved).toBe(true);
    expect(result.deferred).toEqual(["Check it on a phone"]);
  });
});

describe("extractDeferred", () => {
  it("skips sentences that say nothing was deferred", () => {
    expect(extractDeferred([
      "Nothing was deferred to a person.",
      "Deferred to a person: none.",
      "No items need a person.",
      "Every criterion met.",
    ])).toEqual([]);
  });

  it("splits reasons into sentences and lines", () => {
    expect(extractDeferred(["First check passed. Needs a person: approve the wording.\nHUMAN-DEFERRED — test on a tablet"]))
      .toEqual(["Approve the wording.", "Test on a tablet"]);
  });
});

describe("an expired login during review", () => {
  it("stops the chain instead of falling back to the API reviewer", async () => {
    const api = provider('{"verdict": "approved", "reasons": []}');
    const reviewer = backend([new LoginExpiredError("OAuth session expired and could not be refreshed")]);
    await expect(chain(oversight({ reviewerApi: api }), reviewer, backend(["unused"]))).rejects.toThrow(LoginExpiredError);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("stops the chain instead of falling back to the API arbiter", async () => {
    const arbiterApi = provider('{"verdict": "approved", "reasoning": "fine"}');
    const reviewer = backend(['{"verdict": "approved", "reasons": []}']);
    const arbiter = backend([new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired")]);
    await expect(chain(oversight({ arbiterPolicy: "always", arbiterApi }), reviewer, arbiter)).rejects.toThrow(/Failed to authenticate/);
    expect(arbiterApi.execute).not.toHaveBeenCalled();
  });
});
