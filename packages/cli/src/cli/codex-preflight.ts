/**
 * Before `swarm run` takes work, every role that will run on codex (as its
 * backend, or as the fallback it fell back to) is checked: Codex installed,
 * the role's deny list enforceable, and its hook passing the self-test.
 * Codex runs a command its hook failed to judge, so a role that fails this
 * must not start. A project with no codex role is not touched.
 */

import type { BackendConfig, WorkerBackendType } from "@mnmal-ai/swarm-types";
import { CodexBackend, fallbackBackendConfig } from "@mnmal-ai/swarm-worker-backends";

export interface CodexRoleProblem {
  role: string;
  message: string;
}

export async function preflightCodexRoles(
  roles: Record<string, BackendConfig>,
  resolved: Record<string, WorkerBackendType>,
  cwd: string,
  check: (config: BackendConfig, cwd: string) => Promise<void> = (config, dir) => new CodexBackend(config).preflight(dir),
): Promise<CodexRoleProblem[]> {
  const problems: CodexRoleProblem[] = [];
  for (const [role, config] of Object.entries(roles)) {
    if (resolved[role] !== "codex") continue;
    const codexConfig = config.type === "codex" ? config : fallbackBackendConfig(config);
    if (!codexConfig || codexConfig.type !== "codex") continue;
    try {
      await check(codexConfig, cwd);
    } catch (err) {
      problems.push({ role, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return problems;
}
