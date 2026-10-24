import { describe, it, expect } from "vitest";

/**
 * Backward-compatibility smoke test.
 *
 * Verifies that `import { ... } from "@mnmal-ai/swarm"` still resolves every
 * public API that existed before the monorepo split. If any re-export is
 * missing from packages/@mnmal-ai/swarm/src/index.ts, these tests will fail.
 */
describe("backward compatibility — @mnmal-ai/swarm re-exports", () => {
  it("re-exports core classes", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.Swarm).toBeDefined();
    expect(mod.Router).toBeDefined();
    expect(mod.Loader).toBeDefined();
    expect(mod.createProvider).toBeDefined();
    expect(mod.AnthropicProvider).toBeDefined();
    expect(mod.OpenAIProvider).toBeDefined();
    expect(mod.SkillFetcher).toBeDefined();
    expect(mod.BUILTIN_TOOLS).toBeDefined();
    expect(mod.getBuiltinTools).toBeDefined();
    expect(mod.executeTool).toBeDefined();
  });

  it("re-exports telemetry", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.Telemetry).toBeDefined();
    expect(mod.ClaimRegistry).toBeDefined();
    expect(mod.computeClaimAccuracy).toBeDefined();
  });

  it("re-exports oversight", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.Oversight).toBeDefined();
    expect(mod.validateWorkerOutput).toBeDefined();
    expect(mod.captureGitDiff).toBeDefined();
  });

  it("re-exports benchmark", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.BenchmarkRunner).toBeDefined();
  });

  it("re-exports orchestrator", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.Orchestrator).toBeDefined();
    expect(mod.TaskTimeoutError).toBeDefined();
    expect(mod.validatePrerequisites).toBeDefined();
    expect(mod.runDiscovery).toBeDefined();
    expect(mod.SourceControlManager).toBeDefined();
    expect(mod.loadConflictHistory).toBeDefined();
    expect(mod.recordConflict).toBeDefined();
    expect(mod.getSerializationFiles).toBeDefined();
    expect(mod.estimateComplexity).toBeDefined();
    expect(mod.createEscalationWatcher).toBeDefined();
    expect(mod.subDecompose).toBeDefined();
    expect(mod.configToThresholds).toBeDefined();
    expect(mod.DEFAULT_COMPLEXITY_THRESHOLDS).toBeDefined();
  });

  it("re-exports events", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.SwarmEventBus).toBeDefined();
  });

  it("re-exports type utilities", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.formatTokens).toBeDefined();
    expect(mod.matchesGlob).toBeDefined();
  });

  it("re-exports worker backends", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.ClaudeCodeBackend).toBeDefined();
    expect(mod.ApiWorkerBackend).toBeDefined();
    expect(mod.resolveWorkerBackend).toBeDefined();
    expect(mod.detectAvailableBackends).toBeDefined();
  });

  it("re-exports task backends", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.LocalTaskBackend).toBeDefined();
    expect(mod.GitHubTaskBackend).toBeDefined();
    expect(mod.createTaskBackend).toBeDefined();
  });

  it("re-exports CLI utilities", async () => {
    const mod = await import("@mnmal-ai/swarm");
    expect(mod.Scanner).toBeDefined();
    expect(mod.DashboardServer).toBeDefined();
    expect(mod.aggregateEvents).toBeDefined();
  });
});
