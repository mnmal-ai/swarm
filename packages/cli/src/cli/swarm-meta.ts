import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Manifest written by `swarm init` at `.swarm/.swarm-meta.json`.
 * Read by `swarm uninstall` to discover files to clean up.
 */
export interface SwarmMeta {
  created_at?: string;
  version?: string;
  project_name?: string;
  skill_files?: string[];
}

/**
 * Resolve the project name for Substrate operations without requiring --project.
 *
 * Priority:
 *   1. Explicit override (from `--project` flag).
 *   2. `project_name` in `.swarm/.swarm-meta.json`.
 *   3. The single subfolder under `.swarm/domains/` if there is exactly one.
 *   4. Fallback: "global".
 */
export function resolveProjectName(swarmDir: string, override?: string): string {
  if (override && override.length > 0) return override;

  const metaPath = join(swarmDir, ".swarm-meta.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SwarmMeta;
      if (meta.project_name && meta.project_name.length > 0) return meta.project_name;
    } catch {
      // Malformed meta file — fall through.
    }
  }

  const domainsDir = join(swarmDir, "domains");
  if (existsSync(domainsDir)) {
    try {
      const entries = readdirSync(domainsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);
      if (entries.length === 1) return entries[0];
    } catch {
      // Ignore — fall through.
    }
  }

  return "global";
}
