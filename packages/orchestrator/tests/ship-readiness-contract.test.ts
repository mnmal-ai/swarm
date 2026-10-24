import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadShipReadinessContract,
  gateAppliesToGoal,
} from "../src/ship-readiness/contract.js";
import type { ShipReadinessContract } from "../src/ship-readiness/types.js";

// ---------------------------------------------------------------------------
// Setup: a temp swarm root per test, with an oversight/ subdir.
// ---------------------------------------------------------------------------

let swarmPath: string;

beforeEach(() => {
  swarmPath = mkdtempSync(join(tmpdir(), "ship-readiness-test-"));
  mkdirSync(join(swarmPath, "oversight"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(swarmPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

function writeContract(content: string): void {
  writeFileSync(join(swarmPath, "oversight", "ship-readiness.json"), content, "utf-8");
}

const VALID_CONTRACT = {
  platform: "vercel",
  target: "production",
  schemaVersion: "1",
  gates: [],
  promoteCommand: "pnpm deploy",
  goalIds: ["goal-6"],
  smokeEndpoints: [
    { url: "https://example.com/health", expectStatus: 200 },
    { url: "https://example.com/api", jsonPath: "$.ok", expectEquals: true },
  ],
};

// ---------------------------------------------------------------------------
// loadShipReadinessContract
// ---------------------------------------------------------------------------

describe("loadShipReadinessContract", () => {
  it("returns null when the contract file is absent (gate inactive)", () => {
    expect(loadShipReadinessContract(swarmPath)).toBeNull();
  });

  it("loads and returns a valid contract", () => {
    writeContract(JSON.stringify(VALID_CONTRACT));
    const contract = loadShipReadinessContract(swarmPath);
    expect(contract).not.toBeNull();
    expect(contract?.promoteCommand).toBe("pnpm deploy");
    expect(contract?.goalIds).toEqual(["goal-6"]);
    expect(contract?.smokeEndpoints).toHaveLength(2);
  });

  it("accepts a contract without the optional orchestrator fields", () => {
    writeContract(
      JSON.stringify({
        platform: "vercel",
        target: "production",
        schemaVersion: "1",
        gates: [],
        promoteCommand: "make deploy",
      }),
    );
    const contract = loadShipReadinessContract(swarmPath);
    expect(contract?.goalIds).toBeUndefined();
    expect(contract?.smokeEndpoints).toBeUndefined();
  });

  it("throws on malformed JSON", () => {
    writeContract("{ not valid json");
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/Malformed ship-readiness contract/);
  });

  it("throws when the JSON is not an object", () => {
    writeContract("[]");
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/expected a JSON object/);
  });

  it("throws when promoteCommand is missing", () => {
    writeContract(JSON.stringify({ platform: "vercel" }));
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/"promoteCommand" must be a non-empty string/);
  });

  it("throws when promoteCommand is empty", () => {
    writeContract(JSON.stringify({ promoteCommand: "   " }));
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/"promoteCommand" must be a non-empty string/);
  });

  it("throws when smokeEndpoints is not an array", () => {
    writeContract(JSON.stringify({ promoteCommand: "x", smokeEndpoints: {} }));
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/"smokeEndpoints" must be an array/);
  });

  it("throws when a smoke endpoint lacks a url", () => {
    writeContract(JSON.stringify({ promoteCommand: "x", smokeEndpoints: [{ expectStatus: 200 }] }));
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/smokeEndpoints\[0\]\.url must be a non-empty string/);
  });

  it("throws when a smoke endpoint expectStatus is not a number", () => {
    writeContract(
      JSON.stringify({ promoteCommand: "x", smokeEndpoints: [{ url: "https://x", expectStatus: "200" }] }),
    );
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/smokeEndpoints\[0\]\.expectStatus must be a number/);
  });

  it("throws when goalIds is not an array of strings", () => {
    writeContract(JSON.stringify({ promoteCommand: "x", goalIds: [1, 2] }));
    expect(() => loadShipReadinessContract(swarmPath)).toThrow(/"goalIds" must be an array of strings/);
  });
});

// ---------------------------------------------------------------------------
// gateAppliesToGoal
// ---------------------------------------------------------------------------

describe("gateAppliesToGoal", () => {
  it("applies to every goal when goalIds is absent", () => {
    const contract = { promoteCommand: "x" } as ShipReadinessContract;
    expect(gateAppliesToGoal(contract, "goal-anything")).toBe(true);
  });

  it("applies only to listed goals when goalIds is present", () => {
    const contract = { promoteCommand: "x", goalIds: ["goal-6", "goal-7"] } as ShipReadinessContract;
    expect(gateAppliesToGoal(contract, "goal-6")).toBe(true);
    expect(gateAppliesToGoal(contract, "goal-8")).toBe(false);
  });

  it("applies to no goal when goalIds is an explicit empty array", () => {
    const contract = { promoteCommand: "x", goalIds: [] } as ShipReadinessContract;
    expect(gateAppliesToGoal(contract, "goal-6")).toBe(false);
  });
});
