import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadConflictHistory,
  recordConflict,
  getSerializationFiles,
} from "../src/orchestrator/conflict-history.js";
import type { ConflictHistory } from "../src/orchestrator/conflict-history.js";

// ---------------------------------------------------------------------------
// Test setup: create a temporary directory for each test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "conflict-history-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

function historyPath(): string {
  return join(tmpDir, "conflict_history.json");
}

// ---------------------------------------------------------------------------
// loadConflictHistory
// ---------------------------------------------------------------------------

describe("loadConflictHistory", () => {
  it("returns empty history when file does not exist", () => {
    const history = loadConflictHistory(historyPath());
    expect(history).toEqual({ files: {} });
  });

  it("returns empty history when file contains invalid JSON", () => {
    const path = historyPath();
    require("node:fs").writeFileSync(path, "not json", "utf-8");
    const history = loadConflictHistory(path);
    expect(history).toEqual({ files: {} });
  });

  it("returns empty history when file has wrong shape", () => {
    const path = historyPath();
    require("node:fs").writeFileSync(path, JSON.stringify({ notFiles: 42 }), "utf-8");
    const history = loadConflictHistory(path);
    expect(history).toEqual({ files: {} });
  });
});

// ---------------------------------------------------------------------------
// recordConflict
// ---------------------------------------------------------------------------

describe("recordConflict", () => {
  it("creates the file and records entries", () => {
    const path = historyPath();
    expect(existsSync(path)).toBe(false);

    recordConflict(path, ["src/index.ts", "src/utils.ts"]);

    expect(existsSync(path)).toBe(true);
    const history = loadConflictHistory(path);
    expect(Object.keys(history.files)).toHaveLength(2);
    expect(history.files["src/index.ts"].conflict_count).toBe(1);
    expect(history.files["src/utils.ts"].conflict_count).toBe(1);
  });

  it("increments count on repeated conflicts", () => {
    const path = historyPath();

    recordConflict(path, ["src/index.ts"]);
    recordConflict(path, ["src/index.ts"]);
    recordConflict(path, ["src/index.ts"]);

    const history = loadConflictHistory(path);
    expect(history.files["src/index.ts"].conflict_count).toBe(3);
  });

  it("preserves first_seen across multiple conflicts", () => {
    const path = historyPath();

    recordConflict(path, ["src/index.ts"]);
    const firstHistory = loadConflictHistory(path);
    const firstSeen = firstHistory.files["src/index.ts"].first_seen;

    recordConflict(path, ["src/index.ts"]);
    const secondHistory = loadConflictHistory(path);

    expect(secondHistory.files["src/index.ts"].first_seen).toBe(firstSeen);
    expect(secondHistory.files["src/index.ts"].conflict_count).toBe(2);
  });

  it("updates last_conflict on repeated conflicts", () => {
    const path = historyPath();

    recordConflict(path, ["src/index.ts"]);
    const first = loadConflictHistory(path);
    const firstLastConflict = first.files["src/index.ts"].last_conflict;

    // Small delay to ensure different timestamps
    recordConflict(path, ["src/index.ts"]);
    const second = loadConflictHistory(path);

    // last_conflict should be >= first (within the same test it may be equal)
    expect(new Date(second.files["src/index.ts"].last_conflict).getTime())
      .toBeGreaterThanOrEqual(new Date(firstLastConflict).getTime());
  });

  it("does nothing when files array is empty", () => {
    const path = historyPath();
    recordConflict(path, []);
    expect(existsSync(path)).toBe(false);
  });

  it("creates nested directories if they do not exist", () => {
    const nestedPath = join(tmpDir, "deep", "nested", "conflict_history.json");
    recordConflict(nestedPath, ["src/index.ts"]);
    expect(existsSync(nestedPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSerializationFiles
// ---------------------------------------------------------------------------

describe("getSerializationFiles", () => {
  it("returns files within age limit", () => {
    const now = new Date().toISOString();
    const history: ConflictHistory = {
      files: {
        "src/index.ts": {
          conflict_count: 3,
          last_conflict: now,
          first_seen: now,
        },
        "src/utils.ts": {
          conflict_count: 1,
          last_conflict: now,
          first_seen: now,
        },
      },
    };

    const result = getSerializationFiles(history);
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/utils.ts");
  });

  it("excludes files older than maxAgeDays", () => {
    const recent = new Date().toISOString();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

    const history: ConflictHistory = {
      files: {
        "src/index.ts": {
          conflict_count: 3,
          last_conflict: recent,
          first_seen: recent,
        },
        "src/old-file.ts": {
          conflict_count: 5,
          last_conflict: oldDate,
          first_seen: oldDate,
        },
      },
    };

    const result = getSerializationFiles(history, 30);
    expect(result).toContain("src/index.ts");
    expect(result).not.toContain("src/old-file.ts");
  });

  it("returns empty array for empty history", () => {
    const result = getSerializationFiles({ files: {} });
    expect(result).toEqual([]);
  });

  it("respects custom maxAgeDays", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    const history: ConflictHistory = {
      files: {
        "src/index.ts": {
          conflict_count: 1,
          last_conflict: fiveDaysAgo,
          first_seen: fiveDaysAgo,
        },
      },
    };

    // Within 7 days: included
    expect(getSerializationFiles(history, 7)).toContain("src/index.ts");
    // Within 3 days: excluded (5 days ago > 3 day limit)
    expect(getSerializationFiles(history, 3)).not.toContain("src/index.ts");
  });
});

// ---------------------------------------------------------------------------
// Integration: record → load → get serialization files
// ---------------------------------------------------------------------------

describe("integration: conflict recording to serialization", () => {
  it("record a conflict then get it back as a serialization file", () => {
    const path = historyPath();

    // Record a conflict
    recordConflict(path, ["src/models/User.swift"]);

    // Load history
    const history = loadConflictHistory(path);

    // Get serialization files
    const files = getSerializationFiles(history);

    // The conflicted file should be in the serialization list
    expect(files).toContain("src/models/User.swift");
    expect(files).toHaveLength(1);
  });

  it("multiple conflicts increase count but file appears only once", () => {
    const path = historyPath();

    recordConflict(path, ["src/index.ts"]);
    recordConflict(path, ["src/index.ts"]);
    recordConflict(path, ["src/index.ts"]);

    const history = loadConflictHistory(path);
    const files = getSerializationFiles(history);

    expect(files).toHaveLength(1);
    expect(files).toContain("src/index.ts");
    expect(history.files["src/index.ts"].conflict_count).toBe(3);
  });

  it("mixed old and new conflicts return only recent files", () => {
    const path = historyPath();

    // Record a conflict now
    recordConflict(path, ["src/recent.ts"]);

    // Manually inject an old entry
    const history = loadConflictHistory(path);
    history.files["src/ancient.ts"] = {
      conflict_count: 10,
      last_conflict: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      first_seen: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
    };
    require("node:fs").writeFileSync(path, JSON.stringify(history, null, 2), "utf-8");

    // Get serialization files — only recent should appear
    const reloaded = loadConflictHistory(path);
    const files = getSerializationFiles(reloaded, 30);

    expect(files).toContain("src/recent.ts");
    expect(files).not.toContain("src/ancient.ts");
  });
});
