/**
 * `testPostgresUrl` (tests/setup/test-postgres.ts): the only Postgres a test may
 * reach is the local alt-port test stack. Production variables are ignored, and
 * an override that names another host or port is refused.
 */
import { describe, expect, it } from "vitest";
import { TEST_POSTGRES_DEFAULTS, testPostgresUrl } from "../setup/test-postgres.js";

describe("testPostgresUrl", () => {
  it("defaults to the test stack's loopback URLs on 42337 and 42340", () => {
    expect(testPostgresUrl("cold", {})).toBe(TEST_POSTGRES_DEFAULTS.cold);
    expect(testPostgresUrl("meta", {})).toBe(TEST_POSTGRES_DEFAULTS.meta);
    expect(new URL(testPostgresUrl("cold", {})).port).toBe("42337");
    expect(new URL(testPostgresUrl("meta", {})).port).toBe("42340");
  });

  it("never reads the production SWARM_SUBSTRATE_POSTGRES_URL / SWARM_META_POSTGRES_URL", () => {
    const env = {
      SWARM_SUBSTRATE_POSTGRES_URL: "postgresql://swarm:swarm@localhost:32337/swarm",
      SWARM_META_POSTGRES_URL: "postgresql://swarm:swarm@localhost:32340/swarm_meta",
    };
    expect(testPostgresUrl("cold", env)).toBe(TEST_POSTGRES_DEFAULTS.cold);
    expect(testPostgresUrl("meta", env)).toBe(TEST_POSTGRES_DEFAULTS.meta);
  });

  it("takes a loopback override on the role's test-stack port", () => {
    const cold = "postgresql://u:p@127.0.0.1:42337/other";
    const meta = "postgres://u:p@[::1]:42340/other_meta";
    expect(testPostgresUrl("cold", { SWARM_TEST_POSTGRES_URL: cold })).toBe(cold);
    expect(testPostgresUrl("meta", { SWARM_TEST_META_POSTGRES_URL: meta })).toBe(meta);
  });

  it("refuses a host that is not loopback", () => {
    expect(() =>
      testPostgresUrl("cold", { SWARM_TEST_POSTGRES_URL: "postgresql://swarm:swarm@db.example.com:42337/swarm" }),
    ).toThrow(/not loopback/);
    expect(() =>
      testPostgresUrl("meta", { SWARM_TEST_META_POSTGRES_URL: "postgresql://swarm:swarm@10.0.0.5:42340/swarm_meta" }),
    ).toThrow(/not loopback/);
  });

  it("refuses a port other than the role's test-stack port, the live ports included", () => {
    for (const port of [32337, 31337, 5432, 42340]) {
      expect(() =>
        testPostgresUrl("cold", { SWARM_TEST_POSTGRES_URL: `postgresql://swarm:swarm@localhost:${port}/swarm` }),
      ).toThrow(/port/);
    }
    expect(() =>
      testPostgresUrl("meta", { SWARM_TEST_META_POSTGRES_URL: "postgresql://swarm:swarm@localhost/swarm_meta" }),
    ).toThrow(/port 5432/);
  });

  it("refuses something that is not a postgres URL", () => {
    expect(() => testPostgresUrl("cold", { SWARM_TEST_POSTGRES_URL: "not a url" })).toThrow(/not a URL/);
    expect(() => testPostgresUrl("cold", { SWARM_TEST_POSTGRES_URL: "http://localhost:42337/" })).toThrow(/postgres/);
  });
});
