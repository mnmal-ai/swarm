import { describe, it, expect } from "vitest";

import {
  runShipReadinessGate,
  defaultCommandRunner,
  defaultFetch,
} from "../src/ship-readiness/gate.js";
import type {
  CommandResult,
  CommandRunner,
  Fetch,
  FetchResponse,
  ShipReadinessContract,
  SmokeEndpoint,
} from "../src/ship-readiness/types.js";

// ---------------------------------------------------------------------------
// Builders + fakes. No real process or network is ever touched.
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<ShipReadinessContract> = {}): ShipReadinessContract {
  return {
    platform: "generic",
    target: "production",
    schemaVersion: "1",
    gates: [],
    promoteCommand: "deploy-it",
    ...overrides,
  };
}

/** A command runner that records its inputs and returns a canned result. */
function stubRunner(result: CommandResult): {
  run: CommandRunner;
  calls: Array<{ command: string; cwd?: string }>;
} {
  const calls: Array<{ command: string; cwd?: string }> = [];
  const run: CommandRunner = async (command, opts) => {
    calls.push({ command, cwd: opts?.cwd });
    return result;
  };
  return { run, calls };
}

/** A runner that should never be invoked (asserts deploy-failed short-circuits). */
const explodingRunner: CommandRunner = async () => {
  throw new Error("command runner must not be called");
};

/** A fetch that should never be invoked. */
const explodingFetch: Fetch = async () => {
  throw new Error("fetch must not be called");
};

/** Build a fake fetch that maps urls to responses (or throws for network errors). */
function stubFetch(
  routes: Record<string, Partial<FetchResponse> | (() => never)>,
): Fetch {
  return async (url) => {
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected url: ${url}`);
    if (typeof route === "function") route();
    return {
      status: 200,
      text: async () => "",
      json: async () => ({}),
      ...(route as Partial<FetchResponse>),
    };
  };
}

// ---------------------------------------------------------------------------
// Deploy step
// ---------------------------------------------------------------------------

describe("runShipReadinessGate — deploy step", () => {
  it("returns deploy-failed with exit code + stderr and does NOT poll endpoints", async () => {
    const contract = makeContract({
      promoteCommand: "make ship",
      smokeEndpoints: [{ url: "https://x/health" }],
    });

    const result = await runShipReadinessGate({
      contract,
      goalId: "goal-6",
      runCommand: stubRunner({ exitCode: 2, stdout: "", stderr: "boom: deploy rejected" }).run,
      // If the gate polled after a failed deploy, this would throw.
      fetch: explodingFetch,
    });

    expect(result).toEqual({
      outcome: "deploy-failed",
      deployExitCode: 2,
      deployStderr: "boom: deploy rejected",
    });
  });

  it("passes the contract command and cwd through to the runner", async () => {
    const runner = stubRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    await runShipReadinessGate({
      contract: makeContract({ promoteCommand: "vercel deploy --prod" }),
      goalId: "goal-6",
      cwd: "/tmp/work",
      runCommand: runner.run,
      fetch: explodingFetch,
    });

    expect(runner.calls).toEqual([{ command: "vercel deploy --prod", cwd: "/tmp/work" }]);
  });
});

// ---------------------------------------------------------------------------
// Smoke step
// ---------------------------------------------------------------------------

describe("runShipReadinessGate — smoke step", () => {
  const okDeploy = stubRunner({ exitCode: 0, stdout: "", stderr: "" }).run;

  it("passes when deploy succeeds and there are no smoke endpoints", async () => {
    const result = await runShipReadinessGate({
      contract: makeContract(),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: explodingFetch,
    });
    expect(result).toEqual({ outcome: "passed" });
  });

  it("passes when every endpoint meets its status and JSON assertion", async () => {
    const endpoints: SmokeEndpoint[] = [
      { url: "https://x/health", expectStatus: 200 },
      { url: "https://x/api", jsonPath: "$.ok", expectEquals: true },
    ];
    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: endpoints }),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: stubFetch({
        "https://x/health": { status: 200 },
        "https://x/api": { status: 200, json: async () => ({ ok: true }) },
      }),
    });
    expect(result).toEqual({ outcome: "passed" });
  });

  it("defaults the expected status to 200 when the contract omits it", async () => {
    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: [{ url: "https://x/health" }] }),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: stubFetch({ "https://x/health": { status: 500 } }),
    });
    expect(result).toEqual({
      outcome: "smoke-failed",
      failedEndpoints: [
        {
          url: "https://x/health",
          expectedStatus: 200,
          actualStatus: 500,
          reason: "expected status 200, got 500",
        },
      ],
    });
  });

  it("collects every failing endpoint, not just the first", async () => {
    const endpoints: SmokeEndpoint[] = [
      { url: "https://x/a", expectStatus: 200 },
      { url: "https://x/b", expectStatus: 200 },
      { url: "https://x/c", jsonPath: "$.ready", expectEquals: true },
    ];
    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: endpoints }),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: stubFetch({
        "https://x/a": { status: 200 },
        "https://x/b": { status: 503 },
        "https://x/c": { status: 200, json: async () => ({ ready: false }) },
      }),
    });

    expect(result.outcome).toBe("smoke-failed");
    if (result.outcome !== "smoke-failed") throw new Error("unreachable");
    expect(result.failedEndpoints.map((f) => f.url)).toEqual(["https://x/b", "https://x/c"]);
    expect(result.failedEndpoints[1].reason).toMatch(/JSON assertion failed at \$\.ready/);
  });

  it("reports a network error with actualStatus null", async () => {
    const result = await runShipReadinessGate({
      contract: makeContract({ smokeEndpoints: [{ url: "https://x/down" }] }),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: stubFetch({
        "https://x/down": () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    });

    expect(result).toEqual({
      outcome: "smoke-failed",
      failedEndpoints: [
        {
          url: "https://x/down",
          expectedStatus: 200,
          actualStatus: null,
          reason: "request failed: ECONNREFUSED",
        },
      ],
    });
  });

  it("resolves nested JSONPath with bracket and array segments", async () => {
    const result = await runShipReadinessGate({
      contract: makeContract({
        smokeEndpoints: [{ url: "https://x/api", jsonPath: '$.data[0]["status"]', expectEquals: "up" }],
      }),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: stubFetch({
        "https://x/api": { status: 200, json: async () => ({ data: [{ status: "up" }] }) },
      }),
    });
    expect(result).toEqual({ outcome: "passed" });
  });

  it("fails the JSON assertion when the body cannot be parsed", async () => {
    const result = await runShipReadinessGate({
      contract: makeContract({
        smokeEndpoints: [{ url: "https://x/api", jsonPath: "$.ok", expectEquals: true }],
      }),
      goalId: "goal-6",
      runCommand: okDeploy,
      fetch: stubFetch({
        "https://x/api": {
          status: 200,
          json: async () => {
            throw new Error("invalid json");
          },
        },
      }),
    });
    expect(result.outcome).toBe("smoke-failed");
    if (result.outcome !== "smoke-failed") throw new Error("unreachable");
    expect(result.failedEndpoints[0].reason).toMatch(/parsing failed/);
  });
});

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

describe("default implementations", () => {
  it("defaultCommandRunner captures stdout and a zero exit for a real success", async () => {
    const result = await defaultCommandRunner("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("defaultCommandRunner surfaces a non-zero exit code rather than throwing", async () => {
    const result = await defaultCommandRunner("exit 3");
    expect(result.exitCode).toBe(3);
  });

  it("exposes defaultFetch as a function", () => {
    expect(typeof defaultFetch).toBe("function");
  });
});
