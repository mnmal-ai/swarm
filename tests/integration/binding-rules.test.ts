/**
 * The reviewer's and the arbiter's binding rules are read by path from a real
 * Substrate sidecar over HTTP: Loader.loadByPaths asks the sidecar for just
 * those paths (`where: { path: { in } }`) and keeps only the project's own rows.
 *
 * The suite spawns its own sidecar (memory store, ephemeral port) so its rows
 * are the only ones in the store; it runs only under SWARM_SDK_E2E=1.
 */

import { Loader } from "@mnmal-ai/swarm-core";
import { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2E_SKIP_REASON, startTestSubstrate, stopTestSubstrate } from "../setup/isolated-substrate.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";

let client: SubstrateClient;

async function content(path: string, tier: string, body: string, projectId: string): Promise<void> {
  await client.mutate(
    "createSwarmContent",
    { path, tier, intent: "", content: body, tokenEstimate: Math.ceil(body.length / 4), lastReviewed: "2026-10-01", projectId },
    { id: true },
  );
}

beforeAll(async () => {
  if (!RUN_E2E) return;
  const substrate = await startTestSubstrate({ meta: false, cortext: false, recall: "none" });
  client = new SubstrateClient(substrate.cold.url);

  await content("core/rules.md", "core", "- Never force push to main.", "acme");
  await content("domains/acme/constraints.md", "domain", "- Never edit an existing migration.", "acme");
  await content("domains/acme/architecture.md", "domain", "A monolith.", "acme");
  await content("domains/acme/constraints.md", "domain", "- Another project's rule.", "other");
});

afterAll(async () => {
  // Every pair this file started, including one still booting after a timeout.
  await stopTestSubstrate();
});

describe.skipIf(!RUN_E2E)(`Loader.loadByPaths against a real Substrate sidecar (${E2E_SKIP_REASON})`, () => {
  it("has the sidecar filter by path, rather than send every row", async () => {
    const rows = await client.query<{ path: string }>("SwarmContent", { where: { path: { in: ["core/rules.md"] } } }, { path: true });
    expect(rows.map((r) => r.path)).toEqual(["core/rules.md"]);
  });

  it("returns just the requested paths for the project, in the order asked", async () => {
    const files = await new Loader(client).loadByPaths(["core/rules.md", "domains/acme/constraints.md"], "acme");
    expect(files.map((f) => f.path)).toEqual(["core/rules.md", "domains/acme/constraints.md"]);
    expect(files[0].content).toContain("Never force push");
    expect(files[1].content).toContain("Never edit an existing migration");
    expect(files.some((f) => f.content.includes("Another project's rule"))).toBe(false);
  });

  it("skips a path the project has no content for", async () => {
    const files = await new Loader(client).loadByPaths(["core/rules.md", "domains/acme/missing.md"], "acme");
    expect(files.map((f) => f.path)).toEqual(["core/rules.md"]);
  });
});
