/**
 * swarm run's side of stages 1 and 2 of the context-sections spec
 * (docs/superpowers/specs/2026-10-01-context-sections-design.md): checking
 * the project's `context` block at startup, and, when sections are on,
 * storing the swarm's markdown and the project's documents as sections in the
 * `swarm-docs` namespace before each task, from that task's own checkout.
 * With `context.pull` on as well, sessions get an index of those documents
 * and read them by section.
 *
 * Sync never fails a task. If it throws, swarm logs one line and the task's
 * context loads from whole files, as it does with sections off.
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { SwarmEventMap, ContextConfig, DocumentReads, ProjectConfig } from "@mnmal-ai/swarm-types";
import { DEFAULT_EMBED_TIMEOUT_MS, KNOWN_EMBEDDING_DIMENSIONS, MAX_SYNC_CONCURRENCY, type SourceFile, type SyncOptions, type SyncProgress, type SyncReport } from "@mnmal-ai/swarm-substrate";

const CONTEXT_KEYS = ["sections", "pull", "rules", "ranking"];
const RANKING_KEYS = ["enabled", "model", "dimension", "ollamaUrl", "maxSections", "timeoutMs"];
/** One embed's timeout unless `context.ranking.timeoutMs` says otherwise: the sidecar's own default. */
export const DEFAULT_RANKING_TIMEOUT_MS = DEFAULT_EMBED_TIMEOUT_MS;
/** Ranked sections added per task unless `context.ranking.maxSections` says otherwise; the gate found the needed one in the top 5. */
export const DEFAULT_RANKING_MAX_SECTIONS = 5;
const MAX_RANKING_SECTIONS = 40;
/** context.ranking's defaults: the model production uses, on this machine's Ollama. */
export const DEFAULT_RANKING_MODEL = "bge-m3";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const SECTIONS_KEYS = ["enabled", "paths", "concurrency"];
const PULL_KEYS = ["enabled", "maxReadTokens"];
export const DEFAULT_SECTION_PATHS = ["docs/"];
/** A read spanning several sections over this many tokens is refused, unless `context.pull.maxReadTokens` says otherwise. */
export const DEFAULT_MAX_READ_TOKENS = 4000;
const MIN_READ_TOKENS = 500;
const MAX_READ_TOKENS = 100000;
const RULES_KEYS = ["enabled", "maxTokens", "relevant", "paths"];
/** Rules up to this many tokens are delivered in full, unless `context.rules.maxTokens` says otherwise. */
export const DEFAULT_RULES_MAX_TOKENS = 2000;
/** `should` rules delivered in full for matching the task, unless `context.rules.relevant` says otherwise. */
export const DEFAULT_RULES_RELEVANT = 3;
const MIN_RULES_TOKENS = 200;
const MAX_RULES_TOKENS = 100000;
const MAX_RULES_RELEVANT = 20;

function isRelativeInside(p: string): boolean {
  if (p.trim() === "" || isAbsolute(p)) return false;
  const n = normalize(p);
  return n !== ".." && !n.startsWith(`..${sep}`) && !n.startsWith("../");
}

/** Problems with a project's `context` block, one message each; empty when valid. */
export function validateContextConfig(context: unknown): string[] {
  if (context === undefined) return [];
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return [`context must be an object like { "sections": { "enabled": true } } (got ${JSON.stringify(context)})`];
  }
  const errors: string[] = [];
  const c = context as Record<string, unknown>;
  const sections = c.sections;
  if (sections !== undefined) {
    if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
      errors.push(`context.sections must be an object like { "enabled": true, "paths": ["docs/"] } (got ${JSON.stringify(sections)})`);
    } else {
      const s = sections as Record<string, unknown>;
      if (s.enabled !== undefined && typeof s.enabled !== "boolean") {
        errors.push(`context.sections.enabled must be true or false (got ${JSON.stringify(s.enabled)})`);
      }
      if (s.paths !== undefined) {
        const ok = Array.isArray(s.paths) && s.paths.every((p) => typeof p === "string" && isRelativeInside(p));
        if (!ok) errors.push(`context.sections.paths must be folders inside the repository, e.g. ["docs/"] (got ${JSON.stringify(s.paths)})`);
      }
      if (s.concurrency !== undefined && !(Number.isInteger(s.concurrency) && (s.concurrency as number) >= 1 && (s.concurrency as number) <= MAX_SYNC_CONCURRENCY)) {
        errors.push(`context.sections.concurrency must be a whole number from 1 to ${MAX_SYNC_CONCURRENCY} (got ${JSON.stringify(s.concurrency)})`);
      }
      for (const key of Object.keys(s)) {
        if (!SECTIONS_KEYS.includes(key)) errors.push(`context.sections.${key} is not a setting (known: ${SECTIONS_KEYS.join(", ")})`);
      }
    }
  }
  const pull = c.pull;
  if (pull !== undefined) {
    if (pull === null || typeof pull !== "object" || Array.isArray(pull)) {
      errors.push(`context.pull must be an object like { "enabled": true } (got ${JSON.stringify(pull)})`);
    } else {
      const p = pull as Record<string, unknown>;
      if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
        errors.push(`context.pull.enabled must be true or false (got ${JSON.stringify(p.enabled)})`);
      }
      const max = p.maxReadTokens;
      if (max !== undefined && !(Number.isInteger(max) && (max as number) >= MIN_READ_TOKENS && (max as number) <= MAX_READ_TOKENS)) {
        errors.push(`context.pull.maxReadTokens must be a whole number from ${MIN_READ_TOKENS} to ${MAX_READ_TOKENS} (got ${JSON.stringify(max)})`);
      }
      for (const key of Object.keys(p)) {
        if (!PULL_KEYS.includes(key)) errors.push(`context.pull.${key} is not a setting (known: ${PULL_KEYS.join(", ")})`);
      }
      const sectionsOn = sections !== null && typeof sections === "object" && (sections as Record<string, unknown>).enabled === true;
      if (p.enabled === true && !sectionsOn) {
        errors.push("context.pull needs context.sections.enabled: the index lists stored sections");
      }
    }
  }
  const rules = c.rules;
  if (rules !== undefined) {
    if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
      errors.push(`context.rules must be an object like { "enabled": true } (got ${JSON.stringify(rules)})`);
    } else {
      const r = rules as Record<string, unknown>;
      if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
        errors.push(`context.rules.enabled must be true or false (got ${JSON.stringify(r.enabled)})`);
      }
      if (r.maxTokens !== undefined && !(Number.isInteger(r.maxTokens) && (r.maxTokens as number) >= MIN_RULES_TOKENS && (r.maxTokens as number) <= MAX_RULES_TOKENS)) {
        errors.push(`context.rules.maxTokens must be a whole number from ${MIN_RULES_TOKENS} to ${MAX_RULES_TOKENS} (got ${JSON.stringify(r.maxTokens)})`);
      }
      if (r.relevant !== undefined && !(Number.isInteger(r.relevant) && (r.relevant as number) >= 0 && (r.relevant as number) <= MAX_RULES_RELEVANT)) {
        errors.push(`context.rules.relevant must be a whole number from 0 to ${MAX_RULES_RELEVANT} (got ${JSON.stringify(r.relevant)})`);
      }
      if (r.paths !== undefined) {
        const ok = Array.isArray(r.paths) && r.paths.every((p) => typeof p === "string" && isRelativeInside(p) && p.endsWith(".md"));
        if (!ok) errors.push(`context.rules.paths must be markdown files inside the swarm folder, e.g. ["domains/acme/conventions.md"] (got ${JSON.stringify(r.paths)})`);
      }
      for (const key of Object.keys(r)) {
        if (!RULES_KEYS.includes(key)) errors.push(`context.rules.${key} is not a setting (known: ${RULES_KEYS.join(", ")})`);
      }
    }
  }
  const ranking = c.ranking;
  if (ranking !== undefined) {
    if (ranking === null || typeof ranking !== "object" || Array.isArray(ranking)) {
      errors.push(`context.ranking must be an object like { "enabled": true } (got ${JSON.stringify(ranking)})`);
    } else {
      errors.push(...validateRanking(ranking as Record<string, unknown>, sections));
    }
  }
  for (const key of Object.keys(c)) {
    if (!CONTEXT_KEYS.includes(key)) errors.push(`context.${key} is not a setting (known: ${CONTEXT_KEYS.join(", ")})`);
  }
  return errors;
}

function validateRanking(r: Record<string, unknown>, sections: unknown): string[] {
  const errors: string[] = [];
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
    errors.push(`context.ranking.enabled must be true or false (got ${JSON.stringify(r.enabled)})`);
  }
  if (r.model !== undefined && !(typeof r.model === "string" && /^[A-Za-z0-9][\w.\-/:]*$/.test(r.model))) {
    errors.push(`context.ranking.model must be an Ollama model name, e.g. "bge-m3" (got ${JSON.stringify(r.model)})`);
  }
  if (r.dimension !== undefined && !(Number.isInteger(r.dimension) && (r.dimension as number) > 0 && (r.dimension as number) <= 16000)) {
    errors.push(`context.ranking.dimension must be a positive whole number, the model's vector size (got ${JSON.stringify(r.dimension)})`);
  }
  if (r.ollamaUrl !== undefined) {
    let ok = false;
    try {
      const u = new URL(String(r.ollamaUrl));
      ok = typeof r.ollamaUrl === "string" && (u.protocol === "http:" || u.protocol === "https:");
    } catch {
      ok = false;
    }
    if (!ok) errors.push(`context.ranking.ollamaUrl must be an http(s) URL, e.g. "${DEFAULT_OLLAMA_URL}" (got ${JSON.stringify(r.ollamaUrl)})`);
  }
  if (r.maxSections !== undefined && !(Number.isInteger(r.maxSections) && (r.maxSections as number) >= 1 && (r.maxSections as number) <= MAX_RANKING_SECTIONS)) {
    errors.push(`context.ranking.maxSections must be a whole number from 1 to ${MAX_RANKING_SECTIONS} (got ${JSON.stringify(r.maxSections)})`);
  }
  if (r.timeoutMs !== undefined && !(Number.isInteger(r.timeoutMs) && (r.timeoutMs as number) >= 1000 && (r.timeoutMs as number) <= 120_000)) {
    errors.push(`context.ranking.timeoutMs must be a whole number of milliseconds from 1000 to 120000 (got ${JSON.stringify(r.timeoutMs)})`);
  }
  for (const key of Object.keys(r)) {
    if (!RANKING_KEYS.includes(key)) errors.push(`context.ranking.${key} is not a setting (known: ${RANKING_KEYS.join(", ")})`);
  }
  if (errors.length === 0 && r.enabled === true) {
    const sectionsOn = sections !== null && typeof sections === "object" && (sections as Record<string, unknown>).enabled === true;
    if (!sectionsOn) errors.push("context.ranking needs context.sections.enabled: it ranks stored sections");
    const model = typeof r.model === "string" ? r.model : DEFAULT_RANKING_MODEL;
    if (r.dimension === undefined && knownDimension(model) === undefined) {
      errors.push(`swarm doesn't know the vector size of '${model}'; set context.ranking.dimension`);
    }
  }
  return errors;
}

function knownDimension(model: string): number | undefined {
  return KNOWN_EMBEDDING_DIMENSIONS[model.replace(/:latest$/, "")];
}

/** Fail fast on a malformed `context` block, with every problem and the config file named. */
export function assertValidContextConfig(projectConfig: ProjectConfig, configPath: string): void {
  const errors = validateContextConfig(projectConfig.context);
  if (errors.length === 0) return;
  throw new Error(`Invalid context in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

/** The folders to store as sections, and how many files to write at once; null when sections are off. */
export function resolveContextSections(context: ContextConfig | undefined): { paths: string[]; concurrency?: number } | null {
  if (context?.sections?.enabled !== true) return null;
  const concurrency = context.sections.concurrency;
  return { paths: [...(context.sections.paths ?? DEFAULT_SECTION_PATHS)], ...(concurrency === undefined ? {} : { concurrency }) };
}

/** The read limit for indexed documents; null unless both `pull` and `sections` are on. */
export function resolveContextPull(context: ContextConfig | undefined): { maxReadTokens: number } | null {
  if (context?.pull?.enabled !== true || context.sections?.enabled !== true) return null;
  return { maxReadTokens: context.pull.maxReadTokens ?? DEFAULT_MAX_READ_TOKENS };
}

/** How rules are delivered (context.rules); null when the setting is off. Needs neither sections nor pull. */
export function resolveContextRules(context: ContextConfig | undefined): { maxTokens: number; relevant: number; paths: string[] } | null {
  if (context?.rules?.enabled !== true) return null;
  return {
    maxTokens: context.rules.maxTokens ?? DEFAULT_RULES_MAX_TOKENS,
    relevant: context.rules.relevant ?? DEFAULT_RULES_RELEVANT,
    paths: [...(context.rules.paths ?? [])],
  };
}

/** The embedder ranking uses; null unless both `ranking` and `sections` are on. Assumes a validated block. */
export function resolveContextRanking(
  context: ContextConfig | undefined,
): { model: string; dimension: number; ollamaUrl: string; maxSections: number; timeoutMs: number } | null {
  if (context?.ranking?.enabled !== true || context.sections?.enabled !== true) return null;
  const model = context.ranking.model ?? DEFAULT_RANKING_MODEL;
  const dimension = context.ranking.dimension ?? knownDimension(model);
  if (dimension === undefined) return null;
  return {
    model,
    dimension,
    ollamaUrl: context.ranking.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    maxSections: context.ranking.maxSections ?? DEFAULT_RANKING_MAX_SECTIONS,
    timeoutMs: context.ranking.timeoutMs ?? DEFAULT_RANKING_TIMEOUT_MS,
  };
}

/**
 * The variables that give a project's sidecars its ranking embedder, embedding
 * sections as they are stored. The lifecycle reads them
 * (`resolveEmbedderSettings`) into each stack's recall config.
 */
export function rankingEnv(r: { model: string; dimension: number; ollamaUrl: string; timeoutMs: number }): Record<string, string> {
  return {
    SWARM_EMBEDDER_KIND: "ollama",
    SWARM_EMBEDDER_OLLAMA_URL: r.ollamaUrl,
    SWARM_EMBEDDER_MODEL: r.model,
    SWARM_EMBEDDER_DIMENSION: String(r.dimension),
    SWARM_EMBEDDER_TIMEOUT_MS: String(r.timeoutMs),
    SWARM_EMBED_ON_WRITE: "1",
  };
}

/** `5 section reads, 1 refused, 2 whole` for a session's "session done" line; null when it read no indexed document. */
export function describeDocumentReads(reads: DocumentReads): string | null {
  if (reads.bounded === 0 && reads.refused === 0 && reads.whole === 0) return null;
  const sectionReads = `${reads.bounded} section ${reads.bounded === 1 ? "read" : "reads"}`;
  return `${sectionReads}, ${reads.refused} refused${reads.whole > 0 ? `, ${reads.whole} whole` : ""}`;
}

/** `3m 12s`, `45s`. */
function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

/** `3.2 MB`, `391 KB`, `512 B`. */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** `about 16 min left`, `under a minute left`. */
function timeLeft(ms: number): string {
  return ms < 60_000 ? "under a minute left" : `about ${Math.round(ms / 60_000)} min left`;
}

/** An estimate needs this much measured first: two files, or half a minute. */
const ESTIMATE_AFTER_FILES = 2;
const ESTIMATE_AFTER_MS = 30_000;

/**
 * Markdown files under `dir`. A folder that doesn't exist is empty; any other
 * read error throws, because an empty answer would make sync delete every
 * stored document under it.
 */
async function walkMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** The markdown under `paths` in a checkout, by `/`-separated path relative to it. */
export async function listProjectMarkdown(checkout: string, paths: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  const root = resolve(checkout);
  const seen = new Set<string>();
  const files: Array<{ path: string; content: string }> = [];
  for (const p of paths) {
    if (!isRelativeInside(p)) continue;
    const dir = resolve(root, p);
    if (dir !== root && !dir.startsWith(root + sep)) continue;
    for (const full of await walkMarkdown(dir)) {
      const path = relative(root, full).split(sep).join("/");
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({ path, content: await readFile(full, "utf-8") });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The checkout's HEAD commit, or null. */
export function gitHead(checkout: string): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: checkout, timeout: 5000 }, (err, stdout) => done(err ? null : String(stdout).trim() || null));
  });
}

export interface SectionSyncDeps {
  projectId: string;
  paths: readonly string[];
  listSwarmFiles: () => Promise<Array<{ path: string; content: string }>>;
  listProjectFiles: (checkout: string, paths: readonly string[]) => Promise<Array<{ path: string; content: string }>>;
  commitOf: (checkout: string) => Promise<string | null>;
  syncDocuments: (files: SourceFile[], opts: SyncOptions) => Promise<SyncReport>;
  /** Changed files whose synopses are written at once; the sync's default when unset. */
  concurrency?: number;
  log?: (message: string) => void;
  /** The clock throughput is measured with. Default Date.now. */
  now?: () => number;
  /** Where the sync's counts go (the run's event bus), for the live dashboard. */
  emit?: <K extends Extract<keyof SwarmEventMap, `context:sync-${string}`>>(type: K, payload: SwarmEventMap[K]) => void;
}

/** A progress line every few files or every 15 seconds, whichever comes first. */
const PROGRESS_LINES = 5;
const PROGRESS_SECONDS = 15;

/**
 * The per-task sync: stores the swarm's markdown and the checkout's documents
 * as sections. Syncs run one at a time, so tasks running side by side never
 * write the same rows at once. Never throws.
 */
export function createSectionSync(deps: SectionSyncDeps): (checkout: string) => Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  let queue: Promise<void> = Promise.resolve();
  return (checkout: string) => {
    let sync = { started: false, ended: false, done: 0, total: 0, bytesDone: 0, bytesTotal: 0, startedAt: 0 };
    const run = async () => {
      sync = { started: false, ended: false, done: 0, total: 0, bytesDone: 0, bytesTotal: 0, startedAt: 0 };
      try {
        const swarm = await deps.listSwarmFiles();
        const project = await deps.listProjectFiles(checkout, deps.paths);
        const files: SourceFile[] = [
          ...swarm.map((f) => ({ ...f, source: "swarm" as const })),
          ...project.map((f) => ({ ...f, source: "project" as const })),
        ];
        const commit = (await deps.commitOf(checkout)) ?? undefined;
        const now = deps.now ?? Date.now;
        let step = 1;
        let startedAt = now();
        let lastLine = startedAt;
        // What was reported, so a sync that throws part way still reports its end.
        sync = { started: false, ended: false, done: 0, total: 0, bytesDone: 0, bytesTotal: 0, startedAt };
        /** Throughput so far, measured over wall-clock time since the sync began; null until there's enough to go on. */
        const measured = (done: number, bytesDone: number, at: number) => {
          const ms = at - startedAt;
          if (bytesDone <= 0 || ms <= 0 || (done < ESTIMATE_AFTER_FILES && ms < ESTIMATE_AFTER_MS)) return null;
          return bytesDone / ms;
        };
        const onProgress = (p: SyncProgress) => {
          const timestamp = now();
          if (p.phase === "start") {
            step = Math.max(1, Math.ceil(p.changedFiles / PROGRESS_LINES));
            startedAt = timestamp;
            sync = { started: true, ended: false, done: 0, total: p.changedFiles, bytesDone: 0, bytesTotal: p.changedBytes, startedAt };
            lastLine = timestamp;
            log(
              p.changedFiles > 0
                ? `context: writing synopses for ${p.changedFiles} changed files, ${size(p.changedBytes)} of text (a first sync can take a few minutes)`
                : "context: sections up to date",
            );
            deps.emit?.("context:sync-start", { changedFiles: p.changedFiles, totalFiles: p.totalFiles, changedBytes: p.changedBytes, timestamp });
          } else if (p.phase === "progress") {
            sync = { ...sync, done: p.done, total: p.total, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal };
            const rate = measured(p.done, p.bytesDone, timestamp);
            const bytesPerMinute = rate === null ? undefined : Math.round(rate * 60_000);
            const etaMs = rate === null ? undefined : Math.round((p.bytesTotal - p.bytesDone) / rate);
            if (p.done === 1 || p.done === p.total || p.done % step === 0 || timestamp - lastLine >= PROGRESS_SECONDS * 1000) {
              const percent = p.bytesTotal > 0 ? Math.round((100 * p.bytesDone) / p.bytesTotal) : 100;
              const head = `context: synopses ${p.done}/${p.total} files · ${percent}% of text`;
              const tail =
                p.done === p.total ? "" : etaMs === undefined || bytesPerMinute === undefined ? " · estimating…" : ` · ${timeLeft(etaMs)} at ${Math.round(bytesPerMinute / 1024)} KB/min`;
              log(head + tail);
              lastLine = timestamp;
            }
            deps.emit?.("context:sync-progress", {
              done: p.done,
              total: p.total,
              bytesDone: p.bytesDone,
              bytesTotal: p.bytesTotal,
              ...(etaMs === undefined ? {} : { etaMs }),
              ...(bytesPerMinute === undefined ? {} : { bytesPerMinute }),
              timestamp,
            });
          } else {
            sync = { ...sync, ended: true };
            const bytesPerMinute = p.ms > 0 && p.bytesDone > 0 ? Math.round((p.bytesDone / p.ms) * 60_000) : undefined;
            if (p.total > 0) {
              const failed = p.failures > 0 ? `; ${p.failures} failed and load${p.failures === 1 ? "s" : ""} whole` : "";
              const rate = bytesPerMinute === undefined ? "" : ` at ${Math.round(bytesPerMinute / 1024)} KB/min`;
              const fellBack = p.fallbacks > 0 ? ` · ${p.fallbacks} section${p.fallbacks === 1 ? "" : "s"} fell back to first sentences` : "";
              log(`context: synopses written for ${p.done} files, ${size(p.bytesDone)} of text, in ${elapsed(p.ms)}${rate}${failed}${fellBack}`);
            }
            deps.emit?.("context:sync-done", {
              done: p.done,
              total: p.total,
              bytesDone: p.bytesDone,
              bytesTotal: p.bytesTotal,
              failures: p.failures,
              ms: p.ms,
              fallbacks: p.fallbacks,
              ...(bytesPerMinute === undefined ? {} : { bytesPerMinute }),
              timestamp,
            });
          }
        };
        const report = await deps.syncDocuments(files, {
          projectId: deps.projectId,
          sources: ["swarm", "project"],
          commit,
          log,
          onProgress,
          ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
        });
        const d = report.documents;
        if (d.created + d.updated + d.deleted > 0 || report.errors.length > 0) {
          log(
            `[swarm] sections: ${d.created} new, ${d.updated} changed, ${d.deleted} removed, ${d.unchanged} unchanged` +
              (report.errors.length > 0 ? `; ${report.errors.length} file(s) failed and load whole` : ""),
          );
        }
      } catch (err) {
        log(`[swarm] sections not synced, so this task loads whole files: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        // A sync that threw after it started still ends, so the dashboard
        // doesn't show it preparing context forever; what wasn't stored failed.
        if (sync.started && !sync.ended) {
          deps.emit?.("context:sync-done", {
            done: sync.done,
            total: sync.total,
            bytesDone: sync.bytesDone,
            bytesTotal: sync.bytesTotal,
            failures: sync.total - sync.done,
            ms: (deps.now ?? Date.now)() - sync.startedAt,
            fallbacks: 0,
            timestamp: (deps.now ?? Date.now)(),
          });
        }
      }
    };
    const next = queue.then(run, run);
    queue = next;
    return next;
  };
}
