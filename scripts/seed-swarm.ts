#!/usr/bin/env tsx
/**
 * Seed the Substrate store with swarm content from the file-based swarm repo.
 *
 * Usage:
 *   npx tsx scripts/seed-swarm.ts --swarm-path tests/fixtures/content --project todo-test
 *
 * Flags:
 *   --swarm-path  (required) Path to the swarm content directory containing swarm.json
 *   --project     (optional) Project ID for domain-scoped content (default: "global")
 *   --endpoint    (optional) Substrate sidecar URL (default: "http://localhost:32338")
 *
 * This script delegates to the shared seedSwarmContent() function in
 * packages/cli/src/cli/seed.ts to avoid duplicating the seed logic.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { SIDECAR_SPECS, SubstrateClient, ensureTypesRegistered } from "../packages/substrate/src/index.js";
import { seedSwarmContent } from "../packages/cli/src/cli/seed.js";

// --- CLI args ---

const { values } = parseArgs({
  options: {
    "swarm-path": { type: "string" },
    project: { type: "string", default: "global" },
    endpoint: { type: "string", default: "http://localhost:32338" },
  },
  strict: true,
});

const swarmPathRaw = values["swarm-path"];
if (!swarmPathRaw) {
  console.error("Error: --swarm-path is required");
  console.error(
    "Usage: npx tsx scripts/seed-swarm.ts --swarm-path tests/fixtures/content --project todo-test",
  );
  process.exit(1);
}

const swarmPath = resolve(swarmPathRaw);
const projectId = values.project!;
const endpoint = values.endpoint!;

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Swarm Seed Script ===");
  console.log(`  Swarm path: ${swarmPath}`);
  console.log(`  Project:    ${projectId}`);
  console.log(`  Endpoint:   ${endpoint}`);
  console.log();

  const client = new SubstrateClient(endpoint);
  console.log("1. Health check...");
  const healthy = await client.isHealthy();
  if (!healthy) {
    console.error(`   FAIL: Substrate sidecar not reachable at ${endpoint}`);
    console.error("   Start it with: swarm substrate start");
    process.exit(1);
  }
  console.log("   OK");

  // Verify types are registered (the plugin registers them when the sidecar starts)
  console.log("2. Verifying swarm types...");
  await ensureTypesRegistered(client, SIDECAR_SPECS.filter((spec) => spec.scope === "cold"), false);

  // Seed using shared logic from CLI package
  console.log("3. Seeding swarm content...");
  const counts = await seedSwarmContent(client, swarmPath, projectId);

  // Summary
  console.log();
  console.log("=== Seed Complete ===");
  console.log(`  SwarmConfig:      ${counts.configs}`);
  console.log(`  SwarmContent:     ${counts.content}`);
  console.log(`  SwarmRoute:       ${counts.routes}`);
  console.log(`  Total entities:   ${counts.configs + counts.content + counts.routes}`);
}

main().catch((err: unknown) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
