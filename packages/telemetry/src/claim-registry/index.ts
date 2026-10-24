import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  FileClaim,
  ClaimConflict,
  ClaimValidationResult,
  Task,
  ISwarmEventBus,
} from "@mnmal-ai/swarm-types";

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

export class ClaimRegistry {
  private claims: Map<string, FileClaim> = new Map();
  private goalId: string = "";
  private workingDir: string;
  private eventBus: ISwarmEventBus;

  constructor(workingDir: string, eventBus: ISwarmEventBus) {
    this.workingDir = workingDir;
    this.eventBus = eventBus;
  }

  register(claims: FileClaim[], goalId: string): void {
    this.goalId = goalId;
    this.claims.clear();

    for (const claim of claims) {
      const dedupedCreates = [...new Set(claim.creates.map(normalizePath))];
      const dedupedModifies = [...new Set(claim.modifies.map(normalizePath))];
      const normalized: FileClaim = {
        taskId: claim.taskId,
        creates: dedupedCreates,
        modifies: dedupedModifies,
      };
      this.claims.set(claim.taskId, normalized);
    }

    const allModifiedFiles = new Set<string>();
    const overlapFiles = new Set<string>();
    for (const claim of this.claims.values()) {
      for (const f of claim.modifies) {
        if (allModifiedFiles.has(f)) overlapFiles.add(f);
        allModifiedFiles.add(f);
      }
    }

    const allFilesClaimed = new Set<string>();
    for (const claim of this.claims.values()) {
      for (const f of [...claim.creates, ...claim.modifies]) {
        allFilesClaimed.add(f);
      }
    }

    this.eventBus.emit("claim:registered", {
      goalId,
      totalClaims: claims.length,
      totalFilesClaimed: allFilesClaimed.size,
      overlapCount: overlapFiles.size,
      timestamp: Date.now(),
    });
  }

  async validate(): Promise<ClaimValidationResult> {
    const missingFiles: string[] = [];
    const duplicateCreates: string[] = [];

    for (const claim of this.claims.values()) {
      for (const f of claim.modifies) {
        const fullPath = resolve(this.workingDir, f);
        if (!fullPath.startsWith(this.workingDir + "/") && fullPath !== this.workingDir) {
          missingFiles.push(f); // treat out-of-bounds paths as invalid
          continue;
        }
        if (!existsSync(fullPath)) missingFiles.push(f);
      }
    }

    const createsSeen = new Map<string, string>();
    for (const claim of this.claims.values()) {
      for (const f of claim.creates) {
        if (createsSeen.has(f)) duplicateCreates.push(f);
        createsSeen.set(f, claim.taskId);
      }
    }

    const conflicts = this.getConflicts();
    const valid = missingFiles.length === 0 && duplicateCreates.length === 0;

    this.eventBus.emit("claim:validated", {
      goalId: this.goalId,
      valid,
      missingFiles,
      duplicateCreates,
      conflictsDetected: conflicts.length,
      timestamp: Date.now(),
    });

    return { valid, missingFiles, duplicateCreates, conflicts };
  }

  revise(revisedClaims: FileClaim[]): void {
    const conflictsBefore = this.getConflicts().length;

    let filesChanged = 0;
    for (const revised of revisedClaims) {
      const existing = this.claims.get(revised.taskId);
      const normalizedCreates = revised.creates.map(normalizePath);
      const normalizedModifies = revised.modifies.map(normalizePath);

      if (existing) {
        const oldFiles = new Set([...existing.creates, ...existing.modifies]);
        const newFiles = new Set([...normalizedCreates, ...normalizedModifies]);
        for (const f of newFiles) { if (!oldFiles.has(f)) filesChanged++; }
        for (const f of oldFiles) { if (!newFiles.has(f)) filesChanged++; }
      } else {
        filesChanged += normalizedCreates.length + normalizedModifies.length;
      }

      this.claims.set(revised.taskId, {
        taskId: revised.taskId,
        creates: normalizedCreates,
        modifies: normalizedModifies,
      });
    }

    const conflictsAfter = this.getConflicts().length;

    this.eventBus.emit("claim:revised", {
      goalId: this.goalId,
      filesChangedInRevision: filesChanged,
      conflictsResolved: Math.max(0, conflictsBefore - conflictsAfter),
      conflictsRemaining: conflictsAfter,
      timestamp: Date.now(),
    });
  }

  getConflicts(): ClaimConflict[] {
    const fileToClaimants = new Map<string, string[]>();
    for (const claim of this.claims.values()) {
      for (const f of claim.modifies) {
        const existing = fileToClaimants.get(f) || [];
        existing.push(claim.taskId);
        fileToClaimants.set(f, existing);
      }
    }

    const conflicts: ClaimConflict[] = [];
    for (const [file, claimants] of fileToClaimants) {
      if (claimants.length > 1) {
        conflicts.push({ file, claimants, resolution: "serialize" });
      }
    }
    return conflicts;
  }

  getSerializationConstraints(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const conflict of this.getConflicts()) {
      result.set(conflict.file, conflict.claimants);
    }
    return result;
  }

  applyToTasks(tasks: Task[]): Task[] {
    const result = tasks.map(task => {
      const claim = this.claims.get(task.id);
      if (!claim || claim.modifies.length === 0) return task;
      return { ...task, serializedFiles: [...claim.modifies] };
    });

    const conflicts = this.getConflicts();
    const pairs: [string, string][] = [];
    for (const conflict of conflicts) {
      for (let i = 0; i < conflict.claimants.length; i++) {
        for (let j = i + 1; j < conflict.claimants.length; j++) {
          pairs.push([conflict.claimants[i], conflict.claimants[j]]);
        }
      }
    }

    const taskIds = new Set(tasks.map(task => task.id));
    const serializedTaskIds = new Set<string>();
    for (const conflict of conflicts) {
      for (const id of conflict.claimants) {
        if (taskIds.has(id)) {
          serializedTaskIds.add(id);
        }
      }
    }

    this.eventBus.emit("claim:serialization_applied", {
      goalId: this.goalId,
      tasksSerialized: serializedTaskIds.size,
      tasksParallel: Math.max(0, tasks.length - serializedTaskIds.size),
      serializationPairs: pairs,
      timestamp: Date.now(),
    });

    return result;
  }

  clear(): void {
    this.claims.clear();
    this.goalId = "";
  }
}

/**
 * Compute Jaccard similarity between claimed and actual file sets.
 * Returns 0-1. Paths are normalized before comparison.
 */
export function computeClaimAccuracy(claimed: string[], actual: string[]): number {
  const claimedSet = new Set(claimed.map(normalizePath));
  const actualSet = new Set(actual.map(normalizePath));

  if (claimedSet.size === 0 && actualSet.size === 0) return 1;

  const intersection = new Set([...claimedSet].filter(f => actualSet.has(f)));
  const union = new Set([...claimedSet, ...actualSet]);

  return union.size === 0 ? 1 : intersection.size / union.size;
}
