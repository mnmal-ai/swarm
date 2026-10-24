/**
 * `swarm run` scores every task's complexity against thresholds. They used to
 * be hardcoded in run.ts, so swarm.json's `complexity` section was ignored.
 * loadComplexityThresholds reads them from the swarm's swarm.json, validated,
 * with today's values when the section is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_COMPLEXITY_THRESHOLDS,
  estimateComplexity,
  getTimeoutForComplexity,
} from "@mnmal-ai/swarm-orchestrator";
import { describeComplexityThresholds, loadComplexityThresholds } from "../src/cli/complexity-thresholds.js";

let swarmPath: string;

beforeEach(async () => {
  swarmPath = await mkdtemp(join(tmpdir(), "swarm-thresholds-"));
});

afterEach(async () => {
  await rm(swarmPath, { recursive: true, force: true });
});

async function writeSwarmJson(manifest: unknown): Promise<void> {
  await writeFile(join(swarmPath, "swarm.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
}

const ESCALATION = { token_fraction: 0.4, turn_fraction: 0.6, timeout_fraction: 0.5 };

/** A 468-character renewal task that scores 47: moderate under the defaults. */
const RENEWAL_TASK =
  "Check the loan renewal endpoint in src/loans/renewals.ts and its test in src/loans/renewals.test.ts, " +
  "and confirm the due date moves forward by the renewal period, and that a renewal on a reserved title is refused, " +
  "and that the response names the new due date, and that the event entry records who renewed it, and that nothing else changes. " +
  "Keep the change small and local to the renewal path so the reviewer can read it in one sitting without context from other areas.";

describe("loadComplexityThresholds", () => {
  it("uses today's thresholds when there is no swarm.json", () => {
    const loaded = loadComplexityThresholds(swarmPath);
    expect(loaded.thresholds).toEqual(DEFAULT_COMPLEXITY_THRESHOLDS);
    expect(loaded.source).toBeNull();
  });

  it("uses today's thresholds when swarm.json has no complexity section", async () => {
    await writeSwarmJson({ version: "0.1.0", routes: [] });
    const loaded = loadComplexityThresholds(swarmPath);
    expect(loaded.thresholds).toEqual(DEFAULT_COMPLEXITY_THRESHOLDS);
    expect(loaded.source).toBeNull();
  });

  it("reads simple_max, complex_min and the escalation fractions from swarm.json", async () => {
    await writeSwarmJson({
      version: "0.1.0",
      complexity: { description: "tuned", simple_max: 20, complex_min: 45, escalation: ESCALATION },
      routes: [],
    });
    const loaded = loadComplexityThresholds(swarmPath);
    expect(loaded.thresholds).toEqual({
      simpleMax: 20,
      complexMin: 45,
      tokenEscalationFraction: 0.4,
      turnEscalationFraction: 0.6,
      timeoutEscalationFraction: 0.5,
    });
    expect(loaded.source).toBe(join(swarmPath, "swarm.json"));
  });

  it("keeps today's escalation fractions for any the section leaves out", async () => {
    await writeSwarmJson({ complexity: { simple_max: 20, complex_min: 45, escalation: { token_fraction: 0.3 } } });
    expect(loadComplexityThresholds(swarmPath).thresholds).toEqual({
      simpleMax: 20,
      complexMin: 45,
      tokenEscalationFraction: 0.3,
      turnEscalationFraction: DEFAULT_COMPLEXITY_THRESHOLDS.turnEscalationFraction,
      timeoutEscalationFraction: DEFAULT_COMPLEXITY_THRESHOLDS.timeoutEscalationFraction,
    });

    await writeSwarmJson({ complexity: { simple_max: 10, complex_min: 90 } });
    const noEscalation = loadComplexityThresholds(swarmPath).thresholds;
    expect(noEscalation.simpleMax).toBe(10);
    expect(noEscalation.complexMin).toBe(90);
    expect(noEscalation.tokenEscalationFraction).toBe(DEFAULT_COMPLEXITY_THRESHOLDS.tokenEscalationFraction);
  });

  it("refuses simple_max at or above complex_min, naming the file", async () => {
    await writeSwarmJson({ complexity: { simple_max: 61, complex_min: 30, escalation: ESCALATION } });
    const file = join(swarmPath, "swarm.json");
    let message = "";
    try {
      loadComplexityThresholds(swarmPath);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toContain("simple_max (61) must be less than complex_min (30)");
  });

  it("refuses unknown keys, so a typo cannot be silently ignored", async () => {
    await writeSwarmJson({ complexity: { "simple-max": 20, simple_max: 30, complex_min: 61 } });
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/unknown key complexity\.simple-max/);
    await writeSwarmJson({ complexity: { simple_max: 30, complex_min: 61, escalation: { cost_fracton: 0.5 } } });
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/unknown key complexity\.escalation\.cost_fracton/);
  });

  it("accepts the description key the scaffold writes into the section", async () => {
    await writeSwarmJson({ complexity: { description: "Unitless 0-100 heuristic score.", simple_max: 20, complex_min: 70 } });
    expect(loadComplexityThresholds(swarmPath).thresholds.simpleMax).toBe(20);
  });

  it("refuses escalation fractions outside (0, 1]", async () => {
    for (const bad of [0, -0.2, 1.5]) {
      await writeSwarmJson({ complexity: { simple_max: 30, complex_min: 61, escalation: { token_fraction: bad } } });
      expect(() => loadComplexityThresholds(swarmPath)).toThrow(/complexity\.escalation\.token_fraction must be greater than 0 and at most 1/);
    }
    await writeSwarmJson({ complexity: { simple_max: 30, complex_min: 61, escalation: { turn_fraction: 1 } } });
    expect(loadComplexityThresholds(swarmPath).thresholds.turnEscalationFraction).toBe(1);
  });

  it("refuses a threshold that is not a number, naming the key", async () => {
    await writeSwarmJson({ complexity: { simple_max: "30", complex_min: 61 } });
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/complexity\.simple_max must be a number/);

    await writeSwarmJson({ complexity: { simple_max: 30 } });
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/complexity\.complex_min must be a number/);

    await writeSwarmJson({ complexity: { simple_max: 30, complex_min: 61, escalation: { turn_fraction: "most" } } });
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/complexity\.escalation\.turn_fraction must be a number/);

    await writeSwarmJson({ complexity: [30, 61] });
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/complexity must be an object/);
  });

  it("refuses a swarm.json that is not JSON, naming the file", async () => {
    await writeSwarmJson("{ not json");
    expect(() => loadComplexityThresholds(swarmPath)).toThrow(join(swarmPath, "swarm.json"));
  });
});

describe("swarm.json thresholds in the run path", () => {
  it("changes the band, and so the timeout, a task gets", async () => {
    expect(RENEWAL_TASK.length).toBe(468);

    const byDefault = estimateComplexity(RENEWAL_TASK, loadComplexityThresholds(swarmPath).thresholds);
    expect(byDefault.score).toBe(47);
    expect(byDefault.band).toBe("moderate");

    await writeSwarmJson({ complexity: { simple_max: 20, complex_min: 45, escalation: ESCALATION } });
    const stricter = estimateComplexity(RENEWAL_TASK, loadComplexityThresholds(swarmPath).thresholds);
    expect(stricter.score).toBe(47);
    expect(stricter.band).toBe("complex");
    expect(getTimeoutForComplexity(stricter.band)).toBeGreaterThan(getTimeoutForComplexity(byDefault.band));

    await writeSwarmJson({ complexity: { simple_max: 50, complex_min: 80, escalation: ESCALATION } });
    expect(estimateComplexity(RENEWAL_TASK, loadComplexityThresholds(swarmPath).thresholds).band).toBe("simple");
  });
});

describe("describeComplexityThresholds", () => {
  it("names the bands and where the thresholds came from", () => {
    expect(describeComplexityThresholds({ thresholds: DEFAULT_COMPLEXITY_THRESHOLDS, source: null })).toBe(
      "simple ≤30 · complex ≥61 (defaults)",
    );
    expect(
      describeComplexityThresholds({
        thresholds: { ...DEFAULT_COMPLEXITY_THRESHOLDS, simpleMax: 20, complexMin: 45 },
        source: "/b/swarm.json",
      }),
    ).toBe("simple ≤20 · complex ≥45 (swarm.json)");
  });

  it("refuses escalation.cost_fraction, naming escalation.token_fraction as its replacement", async () => {
    await writeSwarmJson({ complexity: { simple_max: 30, complex_min: 61, escalation: { cost_fraction: 0.5 } } });

    expect(() => loadComplexityThresholds(swarmPath)).toThrow(/complexity\.escalation\.cost_fraction.*complexity\.escalation\.token_fraction/);
  });
});
