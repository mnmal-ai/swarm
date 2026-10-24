/**
 * Conflict History — Automatic merge conflict learning for serialization.
 *
 * Tracks which files have caused merge conflicts during parallel dispatch.
 * Over time, learned conflict-prone files are injected as serialization
 * constraints so the DAG automatically serializes tasks that touch them,
 * preventing future conflicts without manual configuration.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConflictHistoryEntry {
  conflict_count: number;
  last_conflict: string; // ISO date
  first_seen: string; // ISO date
}

export interface ConflictHistory {
  files: Record<string, ConflictHistoryEntry>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load conflict history from disk. Returns an empty history if the file
 * does not exist or is unreadable.
 */
export function loadConflictHistory(historyPath: string): ConflictHistory {
  try {
    const raw = readFileSync(historyPath, "utf-8");
    const parsed = JSON.parse(raw) as ConflictHistory;
    // Validate shape — must have a `files` object
    if (parsed && typeof parsed.files === "object" && parsed.files !== null) {
      return parsed;
    }
    return { files: {} };
  } catch {
    // File doesn't exist or is invalid JSON — start fresh
    return { files: {} };
  }
}

/**
 * Record a merge conflict for the given files. Loads the existing history,
 * increments conflict_count for each file, updates last_conflict, and
 * writes back to disk.
 */
export function recordConflict(historyPath: string, files: string[]): void {
  if (files.length === 0) return;

  const history = loadConflictHistory(historyPath);
  const now = new Date().toISOString();

  for (const file of files) {
    const existing = history.files[file];
    if (existing) {
      existing.conflict_count += 1;
      existing.last_conflict = now;
    } else {
      history.files[file] = {
        conflict_count: 1,
        last_conflict: now,
        first_seen: now,
      };
    }
  }

  // Ensure the directory exists before writing
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
  } catch {
    // Directory already exists — fine
  }

  writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Returns all files with conflict_count >= 1 that were last seen within
 * maxAgeDays (default 30). Files older than maxAgeDays are excluded —
 * they may no longer be conflict-prone.
 */
export function getSerializationFiles(history: ConflictHistory, maxAgeDays = 30): string[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result: string[] = [];

  for (const [file, entry] of Object.entries(history.files)) {
    if (entry.conflict_count < 1) continue;
    const lastConflictMs = new Date(entry.last_conflict).getTime();
    if (lastConflictMs >= cutoff) {
      result.push(file);
    }
  }

  return result;
}
