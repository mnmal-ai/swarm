/**
 * Secret scrubbing for telemetry payloads.
 *
 * Three layers:
 * 1. secrets.md exclusion — parse globs from the file, exclude matching paths
 * 2. Config scrubbing — redact env values from MCP server configs and
 *    sensitive identity fields (github_username) in config.json
 * 3. Regex safety net — catch leaked keys, tokens, paths in all text content
 */

import { basename } from "node:path";
import { matchesGlob } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Layer 1: secrets.md parsing
// ---------------------------------------------------------------------------

export interface SecretsExclusions {
  sensitiveFiles: string[];
  sensitiveSwarmFiles: string[];
}

/**
 * Parse secrets.md content and extract glob patterns from the
 * "Sensitive Files" and "Sensitive Swarm Files" sections.
 */
export function parseSecretsExclusions(content: string): SecretsExclusions {
  const sensitiveFiles: string[] = [];
  const sensitiveSwarmFiles: string[] = [];

  let currentSection: "files" | "swarm" | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "## Sensitive Files") {
      currentSection = "files";
      continue;
    }
    if (trimmed === "## Sensitive Swarm Files") {
      currentSection = "swarm";
      continue;
    }
    if (trimmed.startsWith("## ") && currentSection) {
      currentSection = null;
      continue;
    }

    if (currentSection && trimmed.startsWith("- ")) {
      const pattern = trimmed.slice(2).trim();
      if (pattern && !pattern.startsWith("<!--")) {
        if (currentSection === "files") sensitiveFiles.push(pattern);
        else sensitiveSwarmFiles.push(pattern);
      }
    }
  }

  return { sensitiveFiles, sensitiveSwarmFiles };
}

/**
 * Check if a file path should be excluded from the upload payload.
 * secrets.md itself is always excluded.
 */
export function shouldExcludeFile(
  filePath: string,
  exclusions: SecretsExclusions,
): boolean {
  // secrets.md is never uploaded (check basename to avoid matching e.g. "no-secrets.md")
  if (basename(filePath) === "secrets.md") return true;

  const allPatterns = [...exclusions.sensitiveFiles, ...exclusions.sensitiveSwarmFiles];
  return allPatterns.some((pattern) => matchesGlob(filePath, pattern));
}

// ---------------------------------------------------------------------------
// Layer 3: Regex safety net
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS: RegExp[] = [
  // Anthropic keys
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Google API keys
  /AIza[A-Za-z0-9_-]{30,}/g,
  // AWS access keys
  /AKIA[A-Z0-9]{16}/g,
  // GitHub tokens
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  // GitHub fine-grained PATs
  /github_pat_[A-Za-z0-9_]{82}/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9_-]{20,}/g,
  // PEM private keys
  /-----BEGIN[A-Z\s]*PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]*PRIVATE KEY-----/g,
];

// Note: Unix-only. Windows paths (C:\Users\...) are not matched.
// If Windows support is added, extend this pattern.
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s]+\//g;

/** Text file extensions that get regex-scanned. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".json", ".jsonl", ".txt", ".yaml", ".yml",
  ".swift", ".ts", ".js", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".toml", ".cfg", ".ini", ".conf", ".xml",
  ".html", ".css", ".sh", ".bash", ".zsh",
]);

/**
 * Returns true if the file is a text file that should be regex-scanned.
 * Binary files rely solely on Layer 1 (glob exclusion).
 */
export function isTextFile(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return false;
  return TEXT_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}

/**
 * Scrub text content: redact API keys, tokens, PEM content, and
 * replace absolute home paths with ~/
 */
export function scrubContent(content: string): string {
  let result = content;

  for (const pattern of REDACTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }

  // Replace home directory paths
  result = result.replace(HOME_PATH_PATTERN, "~/");

  return result;
}

// ---------------------------------------------------------------------------
// Layer 2: Config JSON scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub a config.json string: redact MCP server env values and
 * sensitive identity fields before including in the telemetry payload.
 *
 * Targets:
 *  - backends.worker.mcpServers.*.env  (all values replaced with "[REDACTED]")
 *  - telemetry_sharing.identity.github_username  (replaced with "[REDACTED]")
 *
 * If the content is not valid JSON, falls back to the generic scrubContent()
 * regex safety net and returns the result.
 */
export function scrubConfigJson(content: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Not valid JSON — fall back to regex scrubbing
    return scrubContent(content);
  }

  // Redact MCP server env values in backends.worker.mcpServers.*.env
  const backends = parsed.backends as Record<string, unknown> | undefined;
  if (backends && typeof backends === "object") {
    const worker = backends.worker as Record<string, unknown> | undefined;
    if (worker && typeof worker === "object") {
      const mcpServers = worker.mcpServers as Record<string, unknown> | undefined;
      if (mcpServers && typeof mcpServers === "object") {
        for (const serverName of Object.keys(mcpServers)) {
          const server = mcpServers[serverName] as Record<string, unknown> | undefined;
          if (server && typeof server === "object" && server.env && typeof server.env === "object") {
            const env = server.env as Record<string, unknown>;
            for (const key of Object.keys(env)) {
              env[key] = "[REDACTED]";
            }
          }
        }
      }
    }
  }

  // Redact telemetry_sharing.identity.github_username
  const telemetrySharing = parsed.telemetry_sharing as Record<string, unknown> | undefined;
  if (telemetrySharing && typeof telemetrySharing === "object") {
    const identity = telemetrySharing.identity as Record<string, unknown> | undefined;
    if (identity && typeof identity === "object" && identity.github_username !== undefined) {
      identity.github_username = "[REDACTED]";
    }
  }

  // Re-serialize and then run through the regex safety net
  return scrubContent(JSON.stringify(parsed, null, 2));
}
