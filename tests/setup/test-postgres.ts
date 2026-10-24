/**
 * The Postgres a test may use: only the alt-port docker test stack
 * (docker-compose.test.yml), on loopback. Tests never read the production
 * `SWARM_SUBSTRATE_POSTGRES_URL` / `SWARM_META_POSTGRES_URL`; an override goes
 * through `SWARM_TEST_POSTGRES_URL` / `SWARM_TEST_META_POSTGRES_URL`, and even
 * then the URL must name a loopback host on the test stack's port.
 */
import { isLoopbackHost } from "@mnmal-ai/swarm-substrate";

export type TestPostgresRole = "cold" | "meta";

/** The test stack's URLs (docker-compose.test.yml). */
export const TEST_POSTGRES_DEFAULTS: Readonly<Record<TestPostgresRole, string>> = {
  cold: "postgresql://swarm:swarm@localhost:42337/swarm",
  meta: "postgresql://swarm:swarm@localhost:42340/swarm_meta",
};

/** The only port each role's test Postgres may be on. */
export const TEST_POSTGRES_PORTS: Readonly<Record<TestPostgresRole, number>> = { cold: 42337, meta: 42340 };

/** The environment variable that overrides each role's URL. */
export const TEST_POSTGRES_ENV: Readonly<Record<TestPostgresRole, string>> = {
  cold: "SWARM_TEST_POSTGRES_URL",
  meta: "SWARM_TEST_META_POSTGRES_URL",
};

/**
 * The test Postgres URL for `role`: `SWARM_TEST_POSTGRES_URL` (cold) or
 * `SWARM_TEST_META_POSTGRES_URL` (meta), else the test stack's default. Throws
 * when the URL does not parse, is not a postgres URL, names a host that is not
 * loopback, or names a port other than the role's test-stack port (42337 cold,
 * 42340 meta).
 */
export function testPostgresUrl(role: TestPostgresRole, env: NodeJS.ProcessEnv = process.env): string {
  const name = TEST_POSTGRES_ENV[role];
  const raw = env[name] || TEST_POSTGRES_DEFAULTS[role];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL (${JSON.stringify(raw)}); tests use only the test stack's Postgres.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must be a postgres:// URL (got ${url.protocol}); tests use only the test stack's Postgres.`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`${name} names host ${url.hostname}, which is not loopback; tests use only the local test stack's Postgres.`);
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  const expected = TEST_POSTGRES_PORTS[role];
  if (port !== expected) {
    throw new Error(
      `${name} names port ${port}; the ${role} test Postgres is on ${expected} (docker-compose.test.yml). ` +
        "Tests never use another Postgres.",
    );
  }
  return raw;
}
