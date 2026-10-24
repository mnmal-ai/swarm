/**
 * `swarm logs` reads runs from the telemetry collector. With no collector
 * configured for the build (the `.invalid` placeholder endpoint) or with
 * telemetry sharing off, it says so in one line instead of dialing the
 * placeholder and surfacing a DNS error. gh and the network are stubbed:
 * nothing here leaves the machine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execCalls: string[] = [];
vi.mock("node:child_process", () => ({
  execFileSync: (cmd: string, args: string[]) => {
    execCalls.push([cmd, ...args].join(" "));
    throw new Error("not in tests");
  },
}));
const dialed: string[] = [];
vi.mock("node:https", () => ({
  request: (opts: { hostname?: string }) => {
    dialed.push(String(opts.hostname));
    throw new Error("no network in tests");
  },
}));

const { runLogs, telemetryUnavailableReason } = await import("../src/cli/logs.js");
const { DEFAULT_TELEMETRY_ENDPOINT } = await import("@mnmal-ai/swarm-telemetry");

const COLLECTOR = "https://telemetry.example.com";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-logs-guard-"));
  execCalls.length = 0;
  dialed.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function domain(name: string, config: unknown): void {
  mkdirSync(join(dir, ".swarm", "domains", name), { recursive: true });
  writeFileSync(join(dir, ".swarm", "domains", name, "config.json"), JSON.stringify(config));
}

describe("telemetryUnavailableReason", () => {
  it("names the placeholder endpoint: no collector is configured for this build", () => {
    domain("app", { telemetry_sharing: { enabled: true } });
    const reason = telemetryUnavailableReason(DEFAULT_TELEMETRY_ENDPOINT, join(dir, ".swarm"));
    expect(reason).toMatch(/no telemetry collector is configured/i);
    expect(reason).toContain(DEFAULT_TELEMETRY_ENDPOINT);
    expect(reason?.split("\n")).toHaveLength(1);
  });

  it("says telemetry sharing is off when no project here has opted in", () => {
    domain("app", { telemetry_sharing: { enabled: false } });
    domain("other", {});
    const reason = telemetryUnavailableReason(COLLECTOR, join(dir, ".swarm"));
    expect(reason).toMatch(/telemetry sharing is off/i);
    expect(reason).toContain("swarm sharing");
    expect(telemetryUnavailableReason(COLLECTOR, join(dir, "no-such-swarm"))).toMatch(/telemetry sharing is off/i);
  });

  it("is null for a real endpoint with sharing on in some project", () => {
    domain("app", { telemetry_sharing: { enabled: false } });
    domain("other", { telemetry_sharing: { enabled: true } });
    expect(telemetryUnavailableReason(COLLECTOR, join(dir, ".swarm"))).toBeNull();
  });
});

describe("swarm logs with the placeholder endpoint", () => {
  it.each([["list"], ["report", "run-1"], ["fetch", "run-1"], ["grade", "run-1"]])(
    "%s prints one line and exits 1 without calling gh or dialing anything",
    async (...positional) => {
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit");
      }) as never);
      await expect(runLogs({}, positional)).rejects.toThrow("process.exit");
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/no telemetry collector is configured/i);
      expect(execCalls).toEqual([]);
      expect(dialed).toEqual([]);
    },
  );
});
