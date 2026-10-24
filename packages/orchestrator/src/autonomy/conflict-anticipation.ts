/**
 * Conflict Anticipation — Detect file overlaps and anticipated serializations.
 *
 * Static detection finds files that multiple tasks declare they will modify.
 * Learned detection augments static with conflict history — any file that
 * appears in conflict history AND is declared by at least one task is flagged
 * for serialization, because history proves it is contention-prone even when
 * only one task explicitly claims it (undeclared tasks touched it in past runs).
 */

import type { Task, ConflictAnticipation } from "@mnmal-ai/swarm-types";
import type { ConflictHistory } from "../orchestrator/conflict-history.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileOverlap {
  file: string;
  tasks: string[];
}

// ---------------------------------------------------------------------------
// Static overlap detection
// ---------------------------------------------------------------------------

/**
 * Detect files that multiple tasks declare they will modify (via serializedFiles).
 * Returns an array of overlaps, each containing the file path and the IDs of
 * the tasks that touch it.
 */
export function detectFileOverlaps(tasks: Task[]): FileOverlap[] {
  const fileToTasks = new Map<string, string[]>();

  for (const task of tasks) {
    for (const file of new Set(task.serializedFiles ?? [])) {
      const existing = fileToTasks.get(file) ?? [];
      existing.push(task.id);
      fileToTasks.set(file, existing);
    }
  }

  const overlaps: FileOverlap[] = [];
  for (const [file, taskIds] of fileToTasks) {
    if (taskIds.length >= 2) {
      overlaps.push({ file, tasks: taskIds });
    }
  }

  return overlaps;
}

// ---------------------------------------------------------------------------
// Learned conflict anticipation
// ---------------------------------------------------------------------------

/**
 * Combine static overlap detection with conflict history to anticipate
 * which files should trigger task serialization.
 *
 * - mode "none": returns empty — no anticipation.
 * - mode "static": returns files where 2+ tasks declare overlap.
 * - mode "learned": static overlaps PLUS any file from conflict history that
 *   at least one task declares — history proves contention even with a single
 *   declared task.
 */
export function getAnticipatedSerializations(
  tasks: Task[],
  history: ConflictHistory,
  mode: ConflictAnticipation,
): string[] {
  if (mode === "none") return [];

  const serialized = new Set<string>();

  // Static: files that multiple tasks declare they will modify
  const overlaps = detectFileOverlaps(tasks);
  for (const overlap of overlaps) {
    serialized.add(overlap.file);
  }

  // Learned: also include files from conflict history that ANY task declares —
  // history proves contention even if only one task claims the file (undeclared
  // tasks touched it in past runs)
  if (mode === "learned") {
    const historyFiles = new Set(Object.keys(history.files));
    const allDeclaredFiles = new Set<string>();
    for (const task of tasks) {
      for (const file of task.serializedFiles ?? []) {
        allDeclaredFiles.add(file);
      }
    }
    // Add any file from conflict history that ANY task declares — history proves
    // it's contention-prone even if only one task claims it (undeclared tasks
    // touched it in past runs)
    for (const file of allDeclaredFiles) {
      if (historyFiles.has(file) && !serialized.has(file)) {
        serialized.add(file);
      }
    }
  }

  return [...serialized];
}
