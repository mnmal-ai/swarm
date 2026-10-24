/**
 * Route sync against a spawned Substrate sidecar running the swarm plugin (its
 * own, on the memory store), over HTTP through the real SubstrateClient: an
 * edited route in swarm.json reaches Substrate on the next sync, and the
 * run-time loader then reads the new route. (A fake client can accept a
 * mutation the real server doesn't have.)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seedSwarmContent } from "@mnmal-ai/swarm-cli";
import { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2E_SKIP_REASON, startTestSubstrate, stopTestSubstrate } from "../setup/isolated-substrate.js";

const RUN_E2E = process.env.SWARM_SDK_E2E === "1";

const PROJECT = "acme";
let url: string;
let root: string | undefined;

function writeSwarm(swarmDir: string, domainFiles: string[]): void {
  const files: Record<string, string> = {
    "swarm.json": JSON.stringify({
      context_budget: { default_max_tokens: 10000 },
      routes: [
        {
          intent: "orchestration",
          description: "Plan the work.",
          keywords: ["plan"],
          load: { core: ["core/values.md"], domain: domainFiles },
        },
      ],
    }),
    "core/values.md": "values",
    [`domains/${PROJECT}/overview.md`]: "overview of the project",
    [`domains/${PROJECT}/goals.json`]: JSON.stringify({ goals: [{ id: "g1", title: "a long list of goals" }] }),
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(swarmDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

beforeAll(async () => {
  if (!RUN_E2E) return;
  const substrate = await startTestSubstrate({ meta: false, cortext: false, recall: "none" });
  url = substrate.cold.url;
  root = mkdtempSync(join(tmpdir(), "swarm-seed-routes-"));
});

afterAll(async () => {
  await stopTestSubstrate();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// seedSwarmContent sends SwarmContent.tokenEstimate as a number, which
// Substrate's field.number() requires (a string is refused, invalid_field_type).
describe.skipIf(!RUN_E2E)(`route sync over a real Substrate sidecar (${E2E_SKIP_REASON})`, () => {
  it("applies an edited route on the next sync, and the loader reads it", async () => {
    const swarmDir = join(root as string, ".swarm");
    const client = new SubstrateClient(url);
    const domain = (file: string) => `domains/${PROJECT}/${file}`;

    writeSwarm(swarmDir, [domain("overview.md"), domain("goals.json")]);
    expect(await seedSwarmContent(client, swarmDir, PROJECT)).toMatchObject({ routes: 1 });
    const before = await client.loadContext({ intent: "orchestration", projectId: PROJECT, modelId: "m" });
    expect(before.filesIncluded.map((f) => f.path)).toContain(domain("goals.json"));

    writeSwarm(swarmDir, [domain("overview.md")]);
    expect(await seedSwarmContent(client, swarmDir, PROJECT)).toMatchObject({ routes: 1 });

    const routes = await client.query<Record<string, unknown>>(
      "SwarmRoute",
      { where: { projectId: { eq: PROJECT } } },
      { intent: true, contentPaths: true },
    );
    expect(routes).toHaveLength(1);
    expect(JSON.parse(String(routes[0].contentPaths))).toEqual(["core/values.md", domain("overview.md")]);

    const after = await client.loadContext({ intent: "orchestration", projectId: PROJECT, modelId: "m" });
    expect(after.filesIncluded.map((f) => f.path)).not.toContain(domain("goals.json"));
    expect(after.filesIncluded.map((f) => f.path)).toContain(domain("overview.md"));

    // Nothing changed: nothing written.
    expect(await seedSwarmContent(client, swarmDir, PROJECT)).toMatchObject({ routes: 0 });
  });
});
