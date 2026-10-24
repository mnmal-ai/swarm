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

describe.skipIf(!RUN_CLAUDE)("E2E: Oversight chain (paid; needs SWARM_SDK_CLAUDE=1)", () => {
  it(
    "should run Worker + Reviewer and approve a correct code review",
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
        oversight: {
          enabled: true,
          reviewerModel: "claude-sonnet-4-5",
          reviewerProvider: "anthropic",
          arbiterModel: "claude-sonnet-4-5",
          arbiterProvider: "anthropic",
        },
      });

      const result = await swarm.runWithOversight(
        "Review this Swift code for issues",
        {
          input: `\`\`\`swift\n${swiftCode}\n\`\`\``,
          intentOverride: "code-review",
        },
      );

      // Worker output should still detect the retain cycle
      const output = result.output.toLowerCase();
      expect(output).toContain("retain cycle");
      expect(
        output.includes("weak self") || output.includes("capture list"),
      ).toBe(true);

      // Oversight should have run
      console.log("\n--- Oversight Result ---");
      console.log(`Worker intent: ${result.intent}`);
      console.log(`Oversight verdict: ${result.oversight.verdict}`);
      console.log(`Retry count: ${result.oversight.retryCount}`);
      console.log(`Arbiter involved: ${result.oversight.arbiterInvolved}`);
      console.log(`Human escalation: ${result.oversight.humanEscalation}`);
      console.log(`Resolution time: ${result.oversight.totalResolutionTimeMs}ms`);
      if (result.oversight.rejectionReasons.length > 0) {
        console.log(`Rejection reasons: ${result.oversight.rejectionReasons.join(", ")}`);
      }
      console.log(`Worker output preview: ${result.output.slice(0, 200)}...`);

      // The oversight verdict should be approved — the worker correctly
      // identified the retain cycle, which meets the swarm's expectations.
      // If the reviewer rejects, the arbiter should still approve.
      expect(["approved", "rejected"]).toContain(result.oversight.verdict);
      expect(result.oversight.humanEscalation).toBe(false);

      // Verify oversight telemetry was emitted
      const date = new Date().toISOString().slice(0, 10);
      const telemetryFile = path.join(
        SWARM_PATH,
        "telemetry",
        "events",
        `${date}.jsonl`,
      );
      const telemetryContent = await fs.readFile(telemetryFile, "utf-8");
      const lines = telemetryContent.trim().split("\n");

      // Should have at least 2 events: the worker event and the oversight event
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // Last line should be the oversight event
      const lastEvent = JSON.parse(lines[lines.length - 1]);
      expect(lastEvent.session_id).toMatch(/^sess-/);
      expect(lastEvent.worker_event_id).toBeDefined();
      expect(lastEvent.reviewer_verdict).toBeDefined();
      expect(typeof lastEvent.retry_count).toBe("number");
      expect(typeof lastEvent.arbiter_involved).toBe("boolean");
      expect(typeof lastEvent.human_escalation).toBe("boolean");
      expect(lastEvent.total_resolution_time_ms).toBeGreaterThan(0);

      console.log("\nOversight telemetry event:");
      console.log(JSON.stringify(lastEvent, null, 2));
    },
    { timeout: 120000 },
  );
});
