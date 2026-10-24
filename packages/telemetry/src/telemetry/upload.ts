/**
 * Telemetry upload pipeline.
 *
 * Assembles a payload from consent tiers, scrubs secrets, compresses, and
 * uploads it through a presigned URL (see uploadPayload). Caches on failure
 * for retry.
 */

import { mkdir, writeFile, readFile, readdir, copyFile, rm, stat, rename } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { existsSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { parseSecretsExclusions, shouldExcludeFile, scrubContent, scrubConfigJson, isTextFile } from "./scrub.js";
import type { SecretsExclusions } from "./scrub.js";
import type { TelemetrySharingIdentity } from "@mnmal-ai/swarm-types";
import { DEFAULT_TELEMETRY_ENDPOINT } from "./endpoint.js";

// Upload endpoint: the package-wide default, never read from config or
// user-facing files. Only tests may override it (setUploadEndpoint).
let uploadEndpoint = DEFAULT_TELEMETRY_ENDPOINT;

/**
 * Override the upload endpoint. Only works when NODE_ENV=test or
 * VITEST=true. Silently ignored in production to prevent supply-chain
 * attacks from redirecting telemetry to attacker-controlled endpoints.
 */
export function setUploadEndpoint(url: string): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    return; // silently ignore in production
  }
  uploadEndpoint = url;
}

/** Return the current upload endpoint. */
export function getUploadEndpoint(): string {
  return uploadEndpoint;
}

/** Pick the right request function based on URL protocol. */
function pickRequest(url: URL) {
  return url.protocol === "https:" ? httpsRequest : httpRequest;
}

// Max age for cached pending uploads (30 days in ms)
const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadConsent {
  logs: boolean;
  trees: boolean;
  context: boolean;
  transcripts?: boolean;
}

/** Re-export for backward compat — canonical type is TelemetrySharingIdentity in types/ */
export type UploadIdentity = TelemetrySharingIdentity;

export interface AssembleOptions {
  swarmDir: string;
  projectDir: string;
  projectName: string;
  runId: string;
  identity: UploadIdentity;
  consent: UploadConsent;
  sdkVersion: string;
  durationMs: number;
  /** All input tokens (cache included) plus output across the run. */
  totalTokens: number;
  goalsCompleted: number;
  goalsTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  treeBefore?: string;
  treeAfter?: string;
}

export interface AssembleResult {
  payloadDir: string;
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the upload payload directory based on consent tiers.
 * Creates a temp directory with meta.json and consent-gated subdirectories.
 */
export async function assemblePayload(options: AssembleOptions): Promise<AssembleResult> {
  const payloadDir = join(tmpdir(), `swarm-upload-${randomUUID()}`);
  await mkdir(payloadDir, { recursive: true });

  // Read secrets.md for exclusions
  const secretsPath = join(options.swarmDir, "domains", options.projectName, "secrets.md");
  let exclusions: SecretsExclusions = { sensitiveFiles: [], sensitiveSwarmFiles: [] };
  try {
    const secretsContent = await readFile(secretsPath, "utf-8");
    exclusions = parseSecretsExclusions(secretsContent);
  } catch {
    // no secrets.md — use defaults
  }

  // meta.json — always created
  const meta = {
    run_id: options.runId,
    project: options.projectName,
    swarm_sdk_version: options.sdkVersion,
    identity: {
      type: options.identity.type,
      ...(options.identity.type === "github"
        ? { github_username: options.identity.github_username }
        : { telemetry_id: options.identity.telemetry_id }),
    },
    consent: {
      logs: options.consent.logs,
      trees: options.consent.trees,
      context: options.consent.context,
    },
    timestamp: new Date().toISOString(),
    duration_ms: options.durationMs,
    total_tokens: options.totalTokens,
    goals_completed: options.goalsCompleted,
    goals_total: options.goalsTotal,
    tasks_completed: options.tasksCompleted,
    tasks_failed: options.tasksFailed,
  };
  await writeFile(join(payloadDir, "meta.json"), JSON.stringify(meta, null, 2));

  // Logs tier
  if (options.consent.logs) {
    const logsDir = join(payloadDir, "logs");
    await mkdir(logsDir, { recursive: true });

    // Copy JSONL event files
    const eventsDir = join(options.swarmDir, "telemetry", "events");
    await copyDirectoryFilesScrubbedFlat(eventsDir, logsDir, exclusions);

    // Copy checkpoint if it exists
    const checkpointPath = join(options.swarmDir, "domains", options.projectName, ".checkpoints", "checkpoint.json");
    if (existsSync(checkpointPath)) {
      await copyFileScrubbed(checkpointPath, join(logsDir, "checkpoint.json"));
    }
  }

  // Trees tier
  if (options.consent.trees && (options.treeBefore || options.treeAfter)) {
    const treesDir = join(payloadDir, "trees");
    await mkdir(treesDir, { recursive: true });
    if (options.treeBefore) await writeFile(join(treesDir, "before.txt"), scrubContent(options.treeBefore));
    if (options.treeAfter) await writeFile(join(treesDir, "after.txt"), scrubContent(options.treeAfter));
  }

  // Context tier
  if (options.consent.context) {
    await copySwarmContext(options.swarmDir, payloadDir, options.projectName, exclusions);
  }

  // Transcripts tier
  if (options.consent.transcripts) {
    const transcriptsSourceDir = join(options.swarmDir, "telemetry", "transcripts");
    if (existsSync(transcriptsSourceDir)) {
      const transcriptsDir = join(payloadDir, "transcripts");
      await mkdir(transcriptsDir, { recursive: true });
      await copyDirectoryFilesScrubbedFlat(transcriptsSourceDir, transcriptsDir, exclusions);
    }
  }

  return { payloadDir };
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Compress the payload directory into a .tar.gz file.
 * Uses `tar` via execFileSync to avoid shell injection.
 */
export async function compressPayload(payloadDir: string): Promise<string> {
  const tarball = `${payloadDir}.tar.gz`;
  const parentDir = dirname(payloadDir);
  const baseName = basename(payloadDir);

  execFileSync("tar", ["-czf", tarball, "-C", parentDir, baseName]);

  return tarball;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload a tarball to the telemetry collector: POST `<endpoint>/upload-url`
 * for a presigned S3 PUT URL, then PUT the tarball there. Returns true if the
 * upload succeeded, false on any failure; connection failures are expected
 * while no collector is deployed (the default endpoint is a placeholder).
 *
 * SECURITY NOTE: the upload-url request carries no credentials, because no
 * collector verifies any yet. A collector needs identity verification for
 * GitHub users and rate limiting for anonymous uploads before it is
 * deployed; send credentials here only once it enforces them.
 */
export async function uploadPayload(
  tarballPath: string,
  identity: UploadIdentity,
  runId: string,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  try {
    // Step 1: POST to /upload-url to get a presigned S3 PUT URL
    const presignedUrl = await getPresignedUrl(identity, runId, meta);
    if (!presignedUrl) return false;

    // Step 2: PUT the tarball to S3 via the presigned URL
    return await putToPresignedUrl(presignedUrl, tarballPath);
  } catch {
    return false;
  }
}

/**
 * POST to the API to get a presigned S3 PUT URL.
 */
async function getPresignedUrl(
  identity: UploadIdentity,
  runId: string,
  meta?: Record<string, unknown>,
): Promise<string | null> {
  const body = JSON.stringify({
    ...meta,
    identity_type: identity.type,
    identity: identity.type === "github" ? identity.github_username : identity.telemetry_id,
    run_id: runId,
  });

  // SECURITY: Do not send credentials until the collector enforces
  // authentication. See the SECURITY NOTE on uploadPayload.
  const authHeader: string | undefined = undefined;

  return new Promise<string | null>((resolve) => {
    const url = new URL(`${uploadEndpoint}/upload-url`);
    const doRequest = pickRequest(url);

    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (authHeader) headers["Authorization"] = authHeader;

    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers,
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.presigned_url || null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * PUT a tarball to a presigned S3 URL.
 */
async function putToPresignedUrl(presignedUrl: string, tarballPath: string): Promise<boolean> {
  const fileStat = await stat(tarballPath);
  const url = new URL(presignedUrl);

  return new Promise<boolean>((resolve) => {
    const doRequest = pickRequest(url);
    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "PUT",
        headers: {
          "Content-Type": "application/gzip",
          "Content-Length": fileStat.size,
        },
        timeout: 60000,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const success = statusCode >= 200 && statusCode < 300;
        res.resume();
        res.on("end", () => resolve(success));
      },
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });

    const stream = createReadStream(tarballPath);
    stream.pipe(req);
  });
}

// ---------------------------------------------------------------------------
// Retry cache
// ---------------------------------------------------------------------------

/**
 * Cache a failed upload tarball for later retry.
 * Moves the tarball into the pending/ directory.
 */
export async function cacheForRetry(tarballPath: string, pendingDir: string): Promise<void> {
  await mkdir(pendingDir, { recursive: true });
  const filename = basename(tarballPath);
  await rename(tarballPath, join(pendingDir, filename));
}

/**
 * At run start, check pending/ for cached uploads and attempt them.
 * Deletes files older than 30 days. On successful upload, removes the file.
 */
export async function retryPending(pendingDir: string): Promise<void> {
  if (!existsSync(pendingDir)) return;

  let entries;
  try {
    entries = await readdir(pendingDir);
  } catch {
    return;
  }

  const now = Date.now();

  for (const entry of entries) {
    if (!entry.endsWith(".tar.gz")) continue;

    const filePath = join(pendingDir, entry);

    try {
      const fileStat = await stat(filePath);

      // Delete files older than 30 days
      if (now - fileStat.mtimeMs > PENDING_MAX_AGE_MS) {
        await rm(filePath).catch(() => {});
        continue;
      }

      // Attempt upload with minimal identity (we don't have the original metadata)
      const uploaded = await uploadPayload(
        filePath,
        { type: "anonymous", telemetry_id: "retry" },
        `retry-${entry}`,
      );

      if (uploaded) {
        await rm(filePath).catch(() => {});
      }
    } catch {
      // Skip this file on any error
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy swarm context files into the payload, respecting secrets.md exclusions
 * and scrubbing text content.
 */
async function copySwarmContext(
  swarmDir: string,
  payloadDir: string,
  projectName: string,
  exclusions: SecretsExclusions,
): Promise<void> {
  const contextDir = join(payloadDir, "context");

  // Copy swarm content directories: core, modes, capabilities, domains
  const dirsToInclude = ["core", "modes", "capabilities", `domains/${projectName}`];

  for (const subDir of dirsToInclude) {
    const srcDir = join(swarmDir, subDir);
    if (!existsSync(srcDir)) continue;

    await copyDirectoryRecursive(srcDir, join(contextDir, subDir), swarmDir, exclusions);
  }
}

/**
 * Recursively copy a directory, filtering by exclusions and scrubbing text content.
 */
async function copyDirectoryRecursive(
  srcDir: string,
  destDir: string,
  swarmDir: string,
  exclusions: SecretsExclusions,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    // Normalize backslashes so exclusion globs match on Windows too
    const relativePath = relative(swarmDir, srcPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath, swarmDir, exclusions);
    } else {
      // Check exclusions
      if (shouldExcludeFile(relativePath, exclusions)) continue;

      await mkdir(dirname(destPath), { recursive: true });

      if (entry.name === "config.json") {
        // Layer 2: config.json gets structured scrubbing for env values and identity
        const content = await readFile(srcPath, "utf-8");
        await writeFile(destPath, scrubConfigJson(content));
      } else if (isTextFile(entry.name)) {
        // Read, scrub, and write
        const content = await readFile(srcPath, "utf-8");
        await writeFile(destPath, scrubContent(content));
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }
}

/**
 * Copy files from a directory (non-recursively) into a destination,
 * scrubbing text content. Used for flat directories like telemetry/events/.
 */
async function copyDirectoryFilesScrubbedFlat(
  srcDir: string,
  destDir: string,
  exclusions: SecretsExclusions,
): Promise<void> {
  if (!existsSync(srcDir)) return;

  let entries;
  try {
    entries = await readdir(srcDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);

    if (shouldExcludeFile(entry, exclusions)) continue;

    try {
      const fileStat = await stat(srcPath);
      if (!fileStat.isFile()) continue;

      if (isTextFile(entry)) {
        const content = await readFile(srcPath, "utf-8");
        await writeFile(destPath, scrubContent(content));
      } else {
        await copyFile(srcPath, destPath);
      }
    } catch {
      // Skip files that can't be read
    }
  }
}

/**
 * Copy a single file, scrubbing if it's a text file.
 */
async function copyFileScrubbed(srcPath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });

  if (isTextFile(srcPath)) {
    const content = await readFile(srcPath, "utf-8");
    await writeFile(destPath, scrubContent(content));
  } else {
    await copyFile(srcPath, destPath);
  }
}
