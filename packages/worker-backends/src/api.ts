import type { IWorkerBackend, ProviderName, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";

export class ApiWorkerBackend implements IWorkerBackend {
  readonly type = "api" as const;
  readonly supportsDirectExecution = false;
  private provider?: ProviderName;

  constructor(provider?: ProviderName) {
    this.provider = provider;
  }

  async isAvailable(): Promise<boolean> {
    if (this.provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
    if (this.provider === "openai") return !!process.env.OPENAI_API_KEY;
    // No provider specified — accept either
    return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  }

  async execute(_input: WorkerTaskInput): Promise<WorkerTaskOutput> {
    throw new Error(
      "ApiWorkerBackend.execute() should not be called directly. " +
      "Swarm.run() handles API execution via its internal agentic loop."
    );
  }
}
