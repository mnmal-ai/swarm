/**
 * Keeping a project's documents stored as sections (stage 1 of
 * docs/superpowers/specs/2026-10-01-context-sections-design.md).
 *
 * Given the files a project's context draws on, `syncDocuments` brings the
 * `swarm-docs` rows in line with them:
 *   - a file whose content hash is unchanged is skipped, with no writes;
 *   - a new or changed file is split into sections and stored, replacing its
 *     old sections;
 *   - a file that is gone (among the sources being synced) loses its Document
 *     and Sections.
 *
 * Writes are ordered so a failure part way never leaves a file loading in
 * part: a file's new sections are written first, each carrying the document
 * hash it belongs to (`documentHash`); only then does the Document take the
 * new hash, and only then are the old sections deleted. The loader uses a
 * file's sections only when they are a complete set for the Document's
 * current hash, so until the last step it still loads the old version, and
 * if a step fails it loads the old version or the whole file. A new file's
 * Document starts with an empty hash, so a failed first write is retried.
 *
 * Synopses come from a model, one call per changed file covering only the
 * sections that need one. A section whose text is unchanged keeps the synopsis
 * it already has (cached by content hash), and a writer's own
 * `<!-- synopsis: … -->` line always wins. When the model fails, or none is
 * given, a section gets its first sentence instead. One file failing to store
 * is reported and the rest carry on.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  capSynopsis,
  fallbackSynopsis,
  type SplitSection,
  splitSections,
  synopsisOverride,
} from "@mnmal-ai/swarm-substrate-shared";
import type { SubstrateClient } from "../client.js";

/** Where a stored document came from: the swarm content repo, or the project. */
export type DocumentSource = "swarm" | "project";

/** A file to store: its path within its source, and its text. */
export interface SourceFile {
  path: string;
  source: DocumentSource;
  content: string;
}

export interface StoredDocument {
  id: string;
  projectId: string;
  path: string;
  source: DocumentSource;
  title: string;
  contentHash: string;
  commit: string | null;
}

export interface SectionRecord {
  id: string;
  document: string;
  projectId: string;
  path: string;
  source: DocumentSource;
  /** JSON array of heading texts. */
  headingPath: string;
  ordinal: number;
  level: number;
  synopsis: string;
  body: string;
  tokens: number;
  contentHash: string;
  /** The Document `contentHash` this section was written for. */
  documentHash: string;
}

/** What sync needs from the store; {@link substrateDocsStore} backs it with Substrate. */
export interface DocsStore {
  listDocuments(projectId: string): Promise<StoredDocument[]>;
  listSections(projectId: string): Promise<SectionRecord[]>;
  createDocument(doc: Omit<StoredDocument, "id">): Promise<string>;
  updateDocument(id: string, patch: Partial<Omit<StoredDocument, "id">>): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  createSections(rows: Omit<SectionRecord, "id">[]): Promise<void>;
  deleteSections(ids: string[]): Promise<void>;
}

/** One file's sections that need a synopsis written. */
export interface SynopsisRequest {
  path: string;
  title: string;
  sections: Array<{ headingPath: string[]; body: string }>;
}

/** Writes one-line synopses: one per requested section, in order. */
export interface SynopsisWriter {
  write(request: SynopsisRequest): Promise<string[]>;
}

/**
 * How a sync is going, in counts only (no paths, headings or text): what a
 * progress line or a dashboard may show about a project under NDA.
 */
export type SyncProgress =
  | { phase: "start"; changedFiles: number; totalFiles: number; changedBytes: number }
  | { phase: "progress"; done: number; total: number; bytesDone: number; bytesTotal: number }
  | { phase: "done"; done: number; total: number; bytesDone: number; bytesTotal: number; failures: number; ms: number; fallbacks: number };

/** Changed files stored at once by default; each needs a model call for its synopses. */
export const DEFAULT_SYNC_CONCURRENCY = 4;
/** The most changed files a sync stores at once. */
export const MAX_SYNC_CONCURRENCY = 8;
/**
 * The most section text one synopsis call carries, and the most sections: a
 * large file is described in several calls, so no single call runs long
 * enough to be cut off.
 */
export const SYNOPSIS_BATCH_BYTES = 48 * 1024;
export const SYNOPSIS_BATCH_SECTIONS = 40;

export interface SyncOptions {
  projectId: string;
  /** Sources this sync covers: a stored file of one of these that isn't in `files` is deleted. */
  sources: readonly DocumentSource[];
  writer?: SynopsisWriter;
  /** Recorded on each stored Document. */
  commit?: string;
  log?: (message: string) => void;
  /** Changed files stored at once, 1 to {@link MAX_SYNC_CONCURRENCY}. Default {@link DEFAULT_SYNC_CONCURRENCY}. */
  concurrency?: number;
  /** Told when the sync starts, as each changed file finishes, and at the end. Never fails the sync. */
  onProgress?: (progress: SyncProgress) => void;
}

export interface SyncReport {
  documents: { created: number; updated: number; unchanged: number; deleted: number };
  synopses: { model: number; override: number; fallback: number; cached: number };
  errors: string[];
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A document's title: its first level-1 heading, else its file name. */
export function documentTitle(path: string, content: string): string {
  const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(content);
  return h1 ? h1[1] : basename(path).replace(/\.[^.]+$/, "");
}

/** Bring the project's stored documents in line with `files`. */
export async function syncDocuments(store: DocsStore, files: SourceFile[], opts: SyncOptions): Promise<SyncReport> {
  const report: SyncReport = {
    documents: { created: 0, updated: 0, unchanged: 0, deleted: 0 },
    synopses: { model: 0, override: 0, fallback: 0, cached: 0 },
    errors: [],
  };
  const log = opts.log ?? (() => {});
  const docs = await store.listDocuments(opts.projectId);
  const sections = await store.listSections(opts.projectId);
  const docByPath = new Map(docs.map((d) => [`${d.source}:${d.path}`, d]));
  const sectionsByDoc = new Map<string, SectionRecord[]>();
  const cachedSynopsis = new Map<string, string>();
  for (const s of sections) {
    sectionsByDoc.set(s.document, [...(sectionsByDoc.get(s.document) ?? []), s]);
    if (s.synopsis !== "") cachedSynopsis.set(s.contentHash, s.synopsis);
  }

  const seen = new Set<string>();
  const changed: Array<{ file: SourceFile; contentHash: string; existing: StoredDocument | undefined; bytes: number }> = [];
  for (const file of files) {
    const key = `${file.source}:${file.path}`;
    seen.add(key);
    const contentHash = hash(file.content);
    const existing = docByPath.get(key);
    if (existing && existing.contentHash === contentHash) {
      report.documents.unchanged++;
      // Sections left behind by an earlier sync that failed after moving the
      // hash: the loader already ignores them; clear them out.
      const stale = (sectionsByDoc.get(existing.id) ?? []).filter((s) => s.documentHash !== contentHash);
      if (stale.length > 0) await store.deleteSections(stale.map((s) => s.id)).catch(() => {});
      continue;
    }
    changed.push({ file, contentHash, existing, bytes: Buffer.byteLength(file.content, "utf8") });
  }
  // Files run from 1 KB to hundreds, so progress is weighed by text as well as counted.
  const bytesTotal = changed.reduce((sum, c) => sum + c.bytes, 0);

  const progress = (p: SyncProgress) => {
    try {
      opts.onProgress?.(p);
    } catch {
      // A progress sink that throws doesn't stop the sync.
    }
  };
  const started = Date.now();
  const errorsBefore = report.errors.length;
  const fallbacksBefore = report.synopses.fallback;
  progress({ phase: "start", changedFiles: changed.length, totalFiles: files.length, changedBytes: bytesTotal });

  // Each changed file is stored on its own, with its own writes in order (new
  // sections, then the Document's hash, then old sections out), so several
  // can run at once without one file's failure touching another's rows.
  const storeFile = async ({ file, contentHash, existing }: (typeof changed)[number]) => {
    let documentId: string | undefined = existing?.id;
    try {
      const title = documentTitle(file.path, file.content);
      const split = splitSections(file.content);
      const synopses = await writeSynopses(file, title, split, cachedSynopsis, opts.writer, report, log);
      if (documentId === undefined) {
        documentId = await store.createDocument({
          projectId: opts.projectId,
          path: file.path,
          source: file.source,
          title,
          contentHash: "",
          commit: opts.commit ?? null,
        });
      }
      const docId = documentId;
      if (split.length > 0) {
        try {
          await store.createSections(
            split.map((s, i) => ({
              document: docId,
              projectId: opts.projectId,
              path: file.path,
              source: file.source,
              headingPath: JSON.stringify(s.headingPath),
              ordinal: s.ordinal,
              level: s.level,
              synopsis: synopses[i],
              body: s.body,
              tokens: s.tokens,
              contentHash: s.contentHash,
              documentHash: contentHash,
            })),
          );
        } catch (err) {
          // Remove what this attempt wrote; the old version stays in place.
          const partial = (await store.listSections(opts.projectId).catch(() => [] as SectionRecord[])).filter(
            (s) => s.document === docId && s.documentHash === contentHash,
          );
          if (partial.length > 0) await store.deleteSections(partial.map((s) => s.id)).catch(() => {});
          throw err;
        }
      }
      await store.updateDocument(docId, { title, contentHash, commit: opts.commit ?? null });
      const old = existing ? (sectionsByDoc.get(existing.id) ?? []) : [];
      if (old.length > 0) {
        await store.deleteSections(old.map((s) => s.id)).catch((err: unknown) => {
          log(`[swarm] old sections of ${file.path} remain until the next sync: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      if (existing) report.documents.updated++;
      else report.documents.created++;
    } catch (err) {
      const message = `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
      report.errors.push(message);
      log(`[swarm] could not store sections for ${message}`);
    }
  };

  const limit = Math.min(MAX_SYNC_CONCURRENCY, Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_SYNC_CONCURRENCY)));
  let next = 0;
  let done = 0;
  let bytesDone = 0;
  const lanes = Array.from({ length: Math.min(limit, changed.length) }, async () => {
    while (next < changed.length) {
      const item = changed[next++];
      await storeFile(item);
      done++;
      bytesDone += item.bytes;
      progress({ phase: "progress", done, total: changed.length, bytesDone, bytesTotal });
    }
  });
  await Promise.all(lanes);
  progress({
    phase: "done",
    done,
    total: changed.length,
    bytesDone,
    bytesTotal,
    failures: report.errors.length - errorsBefore,
    ms: Date.now() - started,
    fallbacks: report.synopses.fallback - fallbacksBefore,
  });

  for (const doc of docs) {
    if (!opts.sources.includes(doc.source) || seen.has(`${doc.source}:${doc.path}`)) continue;
    try {
      const old = sectionsByDoc.get(doc.id) ?? [];
      if (old.length > 0) await store.deleteSections(old.map((s) => s.id));
      await store.deleteDocument(doc.id);
      report.documents.deleted++;
    } catch (err) {
      const message = `${doc.path}: ${err instanceof Error ? err.message : String(err)}`;
      report.errors.push(message);
      log(`[swarm] could not delete stored sections for ${message}`);
    }
  }
  return report;
}

/** Each section's synopsis: override, then cache, then one model call for the rest, then first sentence. */
async function writeSynopses(
  file: SourceFile,
  title: string,
  split: SplitSection[],
  cache: ReadonlyMap<string, string>,
  writer: SynopsisWriter | undefined,
  report: SyncReport,
  log: (message: string) => void,
): Promise<string[]> {
  const result: Array<string | null> = split.map((s) => {
    const own = synopsisOverride(s.body);
    if (own !== null) {
      report.synopses.override++;
      return own;
    }
    const cached = cache.get(s.contentHash);
    if (cached !== undefined) {
      report.synopses.cached++;
      return cached;
    }
    return null;
  });

  const needed = split.map((s, i) => ({ s, i })).filter(({ i }) => result[i] === null);
  if (needed.length > 0 && writer) {
    // Batches of at most SYNOPSIS_BATCH_BYTES of text (a single larger section
    // goes alone) and SYNOPSIS_BATCH_SECTIONS sections, one call each, so a
    // large file never sends one huge call; a batch that fails falls back on
    // its own.
    const batches: Array<typeof needed> = [];
    let batch: typeof needed = [];
    let batchBytes = 0;
    for (const item of needed) {
      const bytes = Buffer.byteLength(item.s.body, "utf8");
      if (batch.length > 0 && (batchBytes + bytes > SYNOPSIS_BATCH_BYTES || batch.length >= SYNOPSIS_BATCH_SECTIONS)) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(item);
      batchBytes += bytes;
    }
    if (batch.length > 0) batches.push(batch);
    for (const part of batches) {
      try {
        const written = await writer.write({
          path: file.path,
          title,
          sections: part.map(({ s }) => ({ headingPath: s.headingPath, body: s.body })),
        });
        part.forEach(({ i }, j) => {
          const text = typeof written[j] === "string" ? written[j].replace(/\s+/g, " ").trim() : "";
          if (text !== "") {
            result[i] = capSynopsis(text);
            report.synopses.model++;
          }
        });
      } catch (err) {
        log(`[swarm] ${part.length} synopses for ${file.path} fell back to first sentences: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result.map((value, i) => {
    if (value !== null) return value;
    report.synopses.fallback++;
    return fallbackSynopsis(split[i].body);
  });
}


/** A {@link DocsStore} over a Substrate client bound to the documents namespace (`swarm-docs`). */
export function substrateDocsStore(client: Pick<SubstrateClient, "query" | "mutate">): DocsStore {
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  return {
    async listDocuments(projectId) {
      const rows = await client.query<Record<string, unknown>>(
        "Document",
        { where: { projectId: { eq: projectId } } },
        { id: true, projectId: true, path: true, source: true, title: true, contentHash: true, commit: true },
      );
      return rows
        .filter((r) => r.projectId === projectId)
        .map((r) => ({
          id: str(r.id),
          projectId: str(r.projectId),
          path: str(r.path),
          source: (r.source === "swarm" ? "swarm" : "project") as DocumentSource,
          title: str(r.title),
          contentHash: str(r.contentHash),
          commit: typeof r.commit === "string" ? r.commit : null,
        }));
    },
    async listSections(projectId) {
      const rows = await client.query<Record<string, unknown>>(
        "Section",
        { where: { projectId: { eq: projectId } } },
        { id: true, document: true, projectId: true, path: true, source: true, headingPath: true, ordinal: true, level: true, synopsis: true, tokens: true, contentHash: true, documentHash: true },
      );
      return rows
        .filter((r) => r.projectId === projectId)
        .map((r) => ({
          id: str(r.id),
          document: str(r.document),
          projectId: str(r.projectId),
          path: str(r.path),
          source: (r.source === "swarm" ? "swarm" : "project") as DocumentSource,
          headingPath: str(r.headingPath),
          ordinal: Number(r.ordinal) || 0,
          level: Number(r.level) || 0,
          synopsis: str(r.synopsis),
          body: "",
          tokens: Number(r.tokens) || 0,
          contentHash: str(r.contentHash),
          documentHash: str(r.documentHash),
        }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.ordinal - b.ordinal);
    },
    async createDocument(doc) {
      const created = await client.mutate<{ id?: unknown }>("createDocument", { ...doc }, { id: true });
      const id = str(created?.id);
      if (id === "") throw new Error("createDocument returned no id");
      return id;
    },
    async updateDocument(id, patch) {
      await client.mutate("updateDocument", { id, ...patch }, { id: true });
    },
    async deleteDocument(id) {
      await client.mutate("deleteDocument", { id }, { id: true });
    },
    async createSections(rows) {
      for (const row of rows) await client.mutate("createSection", { ...row }, { id: true });
    },
    async deleteSections(ids) {
      for (const id of ids) await client.mutate("deleteSection", { id }, { id: true });
    },
  };
}
