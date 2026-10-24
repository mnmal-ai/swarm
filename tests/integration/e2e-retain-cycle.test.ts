import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveSwarmPath } from "./helpers.js";
import * as fs from "node:fs/promises";
import { Swarm } from "@mnmal-ai/swarm-core";

const SWARM_PATH = resolveSwarmPath();
const TEST_APP_PATH = path.join(__dirname, "fixtures/retain-cycle-test-app");

// Paid: this suite calls the Anthropic API. It runs only with the separate opt-in
// SWARM_SDK_CLAUDE=1 (SWARM_SDK_E2E=1 alone never runs it); it needs no sidecar.
const RUN_CLAUDE = process.env.SWARM_SDK_CLAUDE === "1";

describe.skipIf(!RUN_CLAUDE)("E2E: Retain cycle detection (paid; needs SWARM_SDK_CLAUDE=1)", () => {
  it(
    "should detect the retain cycle in ProfileViewModel.swift",
    async () => {
      const swiftCode = await fs.readFile(
        path.join(TEST_APP_PATH, "ProfileViewModel.swift"),
        "utf-8",
      );

      const swarm = new Swarm({
        swarmPath: SWARM_PATH,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        telemetry: { enabled: true },
      });

      const result = await swarm.run("Review this Swift code for issues", {
        input: `\`\`\`swift\n${swiftCode}\n\`\`\``,
        intentOverride: "code-review",
      });

      // Verify the model detected the retain cycle
      const output = result.output.toLowerCase();
      expect(output).toContain("retain cycle");
      expect(
        output.includes("weak self") || output.includes("capture list"),
      ).toBe(true);
      expect(output).not.toContain("looks good");

      // Verify metadata
      expect(result.intent).toBe("code-review");
      expect(result.filesLoaded.length).toBeGreaterThan(0);
      expect(result.tokensUsed.input).toBeGreaterThan(0);
      expect(result.tokensUsed.output).toBeGreaterThan(0);
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result).not.toHaveProperty("costUsd");
      expect(result.sessionId).toMatch(/^sess-/);

      // Verify telemetry JSONL was written
      const date = new Date().toISOString().slice(0, 10);
      const telemetryFile = path.join(
        SWARM_PATH,
        "telemetry",
        "events",
        `${date}.jsonl`,
      );
      const telemetryContent = await fs.readFile(telemetryFile, "utf-8");
      const lines = telemetryContent.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const event = JSON.parse(lines[lines.length - 1]);
      expect(event.id).toMatch(/^evt-/);
      expect(event.session_id).toMatch(/^sess-/);
      expect(event.intent).toBe("code-review");
      expect(event.swarm_files_loaded).toBeInstanceOf(Array);
      expect(event.swarm_files_loaded.length).toBeGreaterThan(0);
      expect(event.tokens.input).toBeGreaterThan(0);
      expect(event.tokens.output).toBeGreaterThan(0);
      expect(event.latency_ms).toBeGreaterThan(0);
      expect(event).not.toHaveProperty("cost_usd");

      console.log("\n--- E2E Result ---");
      console.log(`Intent: ${result.intent}`);
      console.log(`Files loaded: ${result.filesLoaded.join(", ")}`);
      console.log(`Tokens: input=${result.tokensUsed.input}, output=${result.tokensUsed.output}`);
      console.log(`Latency: ${result.latencyMs}ms`);
      console.log(`Output preview: ${result.output.slice(0, 300)}...`);
    },
    { timeout: 60000 },
  );
});
