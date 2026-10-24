/**
 * Guard for the test-sidecar isolation (tests/setup/isolated-substrate.ts).
 *
 * Under SWARM_SDK_E2E=1 the globalSetup has pointed this process at private
 * sidecars: the endpoints must be loopback on ephemeral ports, and no
 * endpoint or port variable may name the live stacks (32337-32341, or the
 * pre-Substrate 31337-31341). Outside E2E the setup must set none of them.
 */
import { describe, expect, it } from "vitest";
import setup, { RESERVED_PORTS } from "../setup/isolated-substrate.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";
const VARS = ["SWARM_SUBSTRATE_PORT", "SWARM_META_PORT", "SWARM_SUBSTRATE_ENDPOINT", "SWARM_META_ENDPOINT"] as const;
const LIVE_PORTS = [31337, 31338, 31339, 31340, 31341, 32337, 32338, 32339, 32340, 32341];

/** The port a variable names: the number itself, or a URL's port. */
function portOf(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const url = new URL(value);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

describe.skipIf(!RUN_E2E)("isolated-substrate env under SWARM_SDK_E2E=1", () => {
  it("points the endpoints at loopback ephemeral ports", () => {
    for (const name of ["SWARM_SUBSTRATE_ENDPOINT", "SWARM_META_ENDPOINT"] as const) {
      const value = process.env[name];
      expect(value, name).toBeDefined();
      const url = new URL(value as string);
      expect(url.hostname, name).toBe("127.0.0.1");
      const port = Number(url.port);
      expect(port, name).toBeGreaterThanOrEqual(1024);
      expect(RESERVED_PORTS.has(port), `${name} names reserved port ${port}`).toBe(false);
    }
    expect(process.env.SWARM_SUBSTRATE_PORT).toBe(new URL(process.env.SWARM_SUBSTRATE_ENDPOINT as string).port);
    expect(process.env.SWARM_META_PORT).toBe(new URL(process.env.SWARM_META_ENDPOINT as string).port);
  });

  it("names no live port in any endpoint or port variable", () => {
    for (const name of VARS) {
      const value = process.env[name];
      expect(value, name).toBeDefined();
      expect(LIVE_PORTS, `${name}=${value}`).not.toContain(portOf(value as string));
    }
  });
});

describe.skipIf(RUN_E2E)("isolated-substrate env outside SWARM_SDK_E2E", () => {
  it("the globalSetup redirected nothing", () => {
    // The setup marks a redirect with these; a plain run must not have them.
    expect(process.env.SWARM_SUBSTRATE_TEST_RECALL).toBeUndefined();
    expect(process.env.SWARM_SUBSTRATE_TEST_CORTEXT).toBeUndefined();
  });

  it("setup() sets none of the endpoint or port variables and starts nothing", async () => {
    const before = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    const teardown = await setup();
    expect(Object.fromEntries(VARS.map((name) => [name, process.env[name]]))).toEqual(before);
    expect(process.env.SWARM_SUBSTRATE_TEST_RECALL).toBeUndefined();
    await teardown();
  });
});
