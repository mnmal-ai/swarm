/**
 * `swarm init` writes a project that budgets in tokens: its config.json names
 * token limits and no dollar key (a dollar key would stop `swarm run` at
 * startup), and its swarm.json escalation fraction is the token one.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateBudgetConfig } from "@mnmal-ai/swarm-orchestrator";
import { scaffold } from "../src/scaffold/index.js";
import { loadComplexityThresholds } from "../src/cli/complexity-thresholds.js";

describe("scaffolded budgets", () => {
  it("writes a project config with token limits and no dollar key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-scaffold-tokens-"));
    try {
      await scaffold({ projectName: "sample-project", outputDir: dir, fillLevel: "quick", backend: "undecided", answers: {} });

      const raw = await readFile(join(dir, "domains", "sample-project", "config.json"), "utf-8");
      const config = JSON.parse(raw);

      expect(raw).not.toContain("max_cost");
      expect(config.concurrency.max_tokens_per_session).toBeGreaterThan(0);
      expect(config.concurrency.max_tokens_per_goal).toBeGreaterThan(0);
      expect(config.concurrency.max_tokens_per_task).toBeGreaterThan(0);
      expect(validateBudgetConfig(config)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a swarm.json whose complexity section swarm run accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-scaffold-tokens-"));
    try {
      await scaffold({ projectName: "sample-project", outputDir: dir, fillLevel: "quick", backend: "undecided", answers: {} });

      expect(await readFile(join(dir, "swarm.json"), "utf-8")).not.toContain("cost_fraction");
      expect(() => loadComplexityThresholds(dir)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
