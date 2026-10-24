import type { IWorkerBackend, BackendConfig, WorkerBackendType } from "@mnmal-ai/swarm-types";
import { ApiWorkerBackend } from "./api.js";
import { ClaudeCodeBackend } from "./claude-code.js";
import { CodexBackend } from "./codex.js";
export { RateLimitError } from "./claude-code.js";

const DEFAULT_CONFIG: BackendConfig = { type: "api" };

function instantiate(config: BackendConfig): IWorkerBackend {
  switch (config.type) {
    case "api":
      return new ApiWorkerBackend();
    case "claude-code":
      return new ClaudeCodeBackend(config);
    case "codex":
      return new CodexBackend(config);
    default:
      throw new Error(`Unknown worker backend type: ${(config as BackendConfig).type}`);
  }
}

/** The settings a fallback backend keeps from its primary's config: the git
 *  identity for its commits, the empty GH_CONFIG_DIR that keeps GitHub out
 *  of its reach, the role's built-in tools, and the fnl its Bash goes through.
 *  A codex fallback also keeps the deny list and the hook command, since its
 *  own hook enforces the list; other fallbacks get exactly what they always did. */
function carriedToFallback(
  config: BackendConfig,
): Pick<BackendConfig, "gitIdentity" | "ghConfigDir" | "tools" | "fnl" | "permissions" | "codexHookCommand"> {
  const toCodex = config.fallback === "codex";
  return {
    ...(config.gitIdentity ? { gitIdentity: config.gitIdentity } : {}),
    ...(config.ghConfigDir ? { ghConfigDir: config.ghConfigDir } : {}),
    ...(config.tools ? { tools: [...config.tools] } : {}),
    ...(config.fnl ? { fnl: { bin: config.fnl.bin, wrap: [...config.fnl.wrap] } } : {}),
    ...(toCodex && config.permissions ? { permissions: config.permissions } : {}),
    ...(toCodex && config.codexHookCommand ? { codexHookCommand: config.codexHookCommand } : {}),
  };
}

/**
 * Resolve a worker backend with fallback support.
 * If primary is unavailable and fallback is specified, returns the fallback.
 */
export async function resolveWorkerBackend(
  config?: BackendConfig,
): Promise<{ backend: IWorkerBackend; fallbackUsed: boolean }> {
  const cfg = config ?? DEFAULT_CONFIG;

  // Warn if mcpServers is configured but the selected backend doesn't support it
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0 && cfg.type !== "claude-code" && cfg.type !== "codex") {
    console.warn(`[swarm] mcpServers configured but backend "${cfg.type}" does not support MCP servers. MCP tools will not be available.`);
  }

  const primary = instantiate(cfg);

  const available = await primary.isAvailable();
  if (available) {
    return { backend: primary, fallbackUsed: false };
  }

  if (cfg.fallback) {
    if (cfg.fallback === cfg.type) {
      console.warn(`[swarm] Fallback type "${cfg.fallback}" is the same as primary — ignoring.`);
    } else {
      const fallbackCfg: BackendConfig = { type: cfg.fallback, ...carriedToFallback(cfg) };
      const fallback = instantiate(fallbackCfg);
      const fallbackAvailable = await fallback.isAvailable();
      if (fallbackAvailable) {
        return { backend: fallback, fallbackUsed: true };
      }
      console.warn(`[swarm] Warning: both primary backend "${cfg.type}" and fallback "${cfg.fallback}" are unavailable.`);
    }
  }

  // Return primary even though it's unavailable — caller can check or handle gracefully
  console.warn(`[swarm] Warning: returning unavailable backend "${cfg.type}". Operations may fail.`);
  return { backend: primary, fallbackUsed: false };
}

/** The config a role's fallback backend runs with, or null when it has none. */
export function fallbackBackendConfig(config: BackendConfig): BackendConfig | null {
  if (!config.fallback || config.fallback === config.type) return null;
  return { type: config.fallback, ...carriedToFallback(config) };
}

/** Instantiate a fallback backend from config, if specified. */
export function instantiateFallback(config?: BackendConfig): IWorkerBackend | null {
  if (!config) return null;
  if (!config.fallback || config.fallback === config.type) return null;
  try {
    return instantiate({ type: config.fallback, ...carriedToFallback(config) });
  } catch (err) {
    console.warn("[swarm] Failed to instantiate fallback backend:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Detect which backends are available on this system. */
export async function detectAvailableBackends(): Promise<WorkerBackendType[]> {
  const types: WorkerBackendType[] = ["api", "claude-code", "codex"];
  const available: WorkerBackendType[] = [];

  for (const type of types) {
    const backend = instantiate({ type });
    if (await backend.isAvailable()) {
      available.push(type);
    }
  }

  return available;
}

export { ApiWorkerBackend } from "./api.js";
export { ClaudeCodeBackend, trackChangedFiles, toProgressEvent, DEFAULT_WORKER_TOOLS, DEFAULT_REVIEW_TOOLS } from "./claude-code.js";
export { createClaudeSynopsisWriter, parseSynopses, DEFAULT_SYNOPSIS_MODEL } from "./synopsis-writer.js";
export type { ClaudeSynopsisWriterOptions, SynopsisRequestLike } from "./synopsis-writer.js";
export { DocumentReadCounter, decideDocumentRead, documentGuardPreToolUse, outline } from "./doc-guard.js";
export type { DocumentGuardHookCallback, DocumentGuardHookOutput, GuardDecision } from "./doc-guard.js";
export { createClaudeLabelWriter } from "./label-writer.js";
export type { ClaudeLabelWriterOptions, LabelRequest, LabelWriter } from "./label-writer.js";
export { runCodexHook, decidePreToolUse, readDecisions, codexHookArgs, parseCodexHookArgs, DECISIONS_FILE, HOOK_FAILURE_DENY, SELF_TEST_ID_PREFIX } from "./codex-hook.js";
export type { CodexHookPolicy, CodexHookLogEntry, CodexHookArgs, CodexHookEvent } from "./codex-hook.js";
export { matchDenied, ruleWords, unenforceableRules, deniesEditing } from "./deny-matcher.js";
export type { DenyMatch } from "./deny-matcher.js";
export { CodexBackend, codexHookCommands, isCodexLoginFailure, parseCodexUsageLimit } from "./codex.js";
export { selfTestCodexHook, selfTestProbes, CodexHookSelfTestError } from "./codex-selftest.js";
export type { SelfTestProbe } from "./codex-selftest.js";
export { buildCodexArgs, tomlString } from "./codex-args.js";
export type { CodexArgsOptions } from "./codex-args.js";
export { CodexEventCollector } from "./codex-events.js";
