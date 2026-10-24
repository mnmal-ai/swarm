import { describe, it, expect } from "vitest";

import {
  detectFileOverlaps,
  getAnticipatedSerializations,
} from "../src/autonomy/conflict-anticipation.js";
import type { FileOverlap } from "../src/autonomy/conflict-anticipation.js";
import type { Task } from "@mnmal-ai/swarm-types";
import type { ConflictHistory } from "../src/orchestrator/conflict-history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string, serializedFiles?: string[]): Task {
  return {
    id,
    goal_id: "goal-1",
    description: `Task ${id}`,
    intent: "implementation",
    status: "pending",
    order: 1,
    serializedFiles,
  };
}

function makeHistory(
  files: Record<string, { conflict_count: number }>,
): ConflictHistory {
  const result: ConflictHistory = { files: {} };
  for (const [file, entry] of Object.entries(files)) {
    result.files[file] = {
      conflict_count: entry.conflict_count,
      last_conflict: new Date().toISOString(),
      first_seen: new Date().toISOString(),
    };
  }
  return result;
}

const emptyHistory: ConflictHistory = { files: {} };

// ---------------------------------------------------------------------------
// detectFileOverlaps (Task 3: Static overlap detection)
// ---------------------------------------------------------------------------

describe("detectFileOverlaps", () => {
  it("detects overlap when two tasks modify the same file", () => {
    const tasks = [
      makeTask("t1", ["src/index.ts", "src/app.ts"]),
      makeTask("t2", ["src/index.ts", "src/routes.ts"]),
    ];

    const overlaps = detectFileOverlaps(tasks);

    expect(overlaps).toEqual<FileOverlap[]>([
      { file: "src/index.ts", tasks: ["t1", "t2"] },
    ]);
  });

  it("detects multiple overlapping files", () => {
    const tasks = [
      makeTask("t1", ["src/a.ts", "src/b.ts"]),
      makeTask("t2", ["src/b.ts", "src/c.ts"]),
      makeTask("t3", ["src/a.ts", "src/c.ts"]),
    ];

    const overlaps = detectFileOverlaps(tasks);
    const overlapFiles = overlaps.map((o) => o.file).sort();

    expect(overlapFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("returns empty when no overlaps exist", () => {
    const tasks = [
      makeTask("t1", ["src/a.ts"]),
      makeTask("t2", ["src/b.ts"]),
    ];

    const overlaps = detectFileOverlaps(tasks);

    expect(overlaps).toEqual([]);
  });

  it("handles tasks without serializedFiles field", () => {
    const tasks = [
      makeTask("t1", undefined),
      makeTask("t2", ["src/a.ts"]),
      makeTask("t3", undefined),
    ];

    const overlaps = detectFileOverlaps(tasks);

    expect(overlaps).toEqual([]);
  });

  it("handles empty task list", () => {
    const overlaps = detectFileOverlaps([]);
    expect(overlaps).toEqual([]);
  });

  it("handles tasks with empty serializedFiles arrays", () => {
    const tasks = [makeTask("t1", []), makeTask("t2", [])];

    const overlaps = detectFileOverlaps(tasks);

    expect(overlaps).toEqual([]);
  });

  it("includes all task IDs when 3+ tasks touch the same file", () => {
    const tasks = [
      makeTask("t1", ["src/shared.ts"]),
      makeTask("t2", ["src/shared.ts"]),
      makeTask("t3", ["src/shared.ts"]),
    ];

    const overlaps = detectFileOverlaps(tasks);

    expect(overlaps).toEqual<FileOverlap[]>([
      { file: "src/shared.ts", tasks: ["t1", "t2", "t3"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getAnticipatedSerializations (Task 4: Learned conflict anticipation)
// ---------------------------------------------------------------------------

describe("getAnticipatedSerializations", () => {
  it('returns empty when mode is "none"', () => {
    const tasks = [
      makeTask("t1", ["src/index.ts"]),
      makeTask("t2", ["src/index.ts"]),
    ];

    const result = getAnticipatedSerializations(tasks, emptyHistory, "none");

    expect(result).toEqual([]);
  });

  it('returns static overlaps in "static" mode without needing history', () => {
    const tasks = [
      makeTask("t1", ["src/index.ts", "src/a.ts"]),
      makeTask("t2", ["src/index.ts"]),
    ];

    const result = getAnticipatedSerializations(tasks, emptyHistory, "static");

    expect(result).toEqual(["src/index.ts"]);
  });

  it('returns static overlaps in "learned" mode even without matching history', () => {
    const tasks = [
      makeTask("t1", ["src/index.ts"]),
      makeTask("t2", ["src/index.ts"]),
    ];

    const result = getAnticipatedSerializations(tasks, emptyHistory, "learned");

    expect(result).toEqual(["src/index.ts"]);
  });

  it('includes history-known files that multiple tasks touch in "learned" mode', () => {
    const tasks = [
      makeTask("t1", ["src/index.ts", "src/config.ts"]),
      makeTask("t2", ["src/routes.ts", "src/config.ts"]),
    ];

    const history = makeHistory({
      "src/config.ts": { conflict_count: 3 },
    });

    const result = getAnticipatedSerializations(tasks, history, "learned");

    // src/config.ts is touched by both tasks and has conflict history
    expect(result).toContain("src/config.ts");
  });

  it("DOES serialize when only 1 task touches a history-known file (learned adds value over static)", () => {
    const tasks = [
      makeTask("t1", ["src/index.ts"]),
      makeTask("t2", ["src/routes.ts"]),
    ];

    // src/index.ts has conflict history — even though only t1 declares it,
    // history proves undeclared tasks have touched it in past runs
    const history = makeHistory({
      "src/index.ts": { conflict_count: 5 },
    });

    const result = getAnticipatedSerializations(tasks, history, "learned");

    expect(result).toContain("src/index.ts");
  });

  it("combines static overlaps and learned history without duplicates", () => {
    const tasks = [
      makeTask("t1", ["src/shared.ts", "src/app.ts"]),
      makeTask("t2", ["src/shared.ts", "src/app.ts"]),
    ];

    // src/shared.ts is both a static overlap AND has conflict history
    const history = makeHistory({
      "src/shared.ts": { conflict_count: 2 },
    });

    const result = getAnticipatedSerializations(tasks, history, "learned");

    // Should appear once (not duplicated)
    const sharedCount = result.filter((f) => f === "src/shared.ts").length;
    expect(sharedCount).toBe(1);
    expect(result).toContain("src/shared.ts");
    expect(result).toContain("src/app.ts");
  });

  it('ignores history in "static" mode', () => {
    const tasks = [
      makeTask("t1", ["src/config.ts"]),
      makeTask("t2", ["src/config.ts"]),
    ];

    // History exists but static mode should only return static overlaps
    const history = makeHistory({
      "src/other.ts": { conflict_count: 10 },
    });

    const result = getAnticipatedSerializations(tasks, history, "static");

    expect(result).toEqual(["src/config.ts"]);
    expect(result).not.toContain("src/other.ts");
  });

  it("returns empty for learned mode with no overlaps and no matching history", () => {
    const tasks = [
      makeTask("t1", ["src/a.ts"]),
      makeTask("t2", ["src/b.ts"]),
    ];

    const history = makeHistory({
      "src/unrelated.ts": { conflict_count: 5 },
    });

    const result = getAnticipatedSerializations(tasks, history, "learned");

    expect(result).toEqual([]);
  });

  it("handles tasks without serializedFiles in learned mode", () => {
    const tasks = [makeTask("t1", undefined), makeTask("t2", undefined)];

    const history = makeHistory({
      "src/index.ts": { conflict_count: 3 },
    });

    const result = getAnticipatedSerializations(tasks, history, "learned");

    expect(result).toEqual([]);
  });
});
