import { existsSync } from "node:fs";
import { join } from "node:path";

/** The repo's minimal content set: two routes, three core files. */
export const FIXTURE_CONTENT_PATH = join(__dirname, "..", "..", "..", "tests", "fixtures", "content");

/**
 * The swarm content directory these tests read: `override` (a config value)
 * when set, else `SWARM_PATH`, else the repo's fixture. Throws when the
 * directory has no `swarm.json`, so a missing content set fails loudly
 * instead of skipping.
 */
export function resolveSwarmPath(override?: string | null): string {
  const dir = override || process.env.SWARM_PATH || FIXTURE_CONTENT_PATH;
  if (!existsSync(join(dir, "swarm.json"))) {
    throw new Error(`No swarm content at ${dir}: swarm.json is missing. Set SWARM_PATH to a content directory.`);
  }
  return dir;
}
