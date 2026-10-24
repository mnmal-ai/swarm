import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CatalogEntry,
  detectEnvironment,
  loadCatalog,
  matchSuggestions,
  type SuggestionAxis,
  SUGGESTION_AXES,
} from "@mnmal-ai/swarm-cli";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end gate for the /prepare-for-swarm matcher engine: prove the
 * deterministic (no-LLM) pipeline — detectEnvironment → matchSuggestions over
 * the shipped catalog — surfaces real offers for a real multi-stack repo. The
 * companion suggestion-catalog.test.ts gates the catalog's static shape; this
 * suite gates the runtime behaviour the catalog enables, against the
 * Vercel+Hono+Drizzle fixture that exercises all three detection paths
 * (vercel.json file-presence, hono + drizzle-orm dependencies).
 *
 * Anchor on this test file's own location via import.meta.url (mirroring the
 * sibling integration tests) so fixture resolution is independent of the
 * process working directory: the fixture lives alongside this file under
 * fixtures/vercel-hono-drizzle/.
 */
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/vercel-hono-drizzle",
);

// loadCatalog reads the in-SDK catalog the runtime uses; matching against it
// (rather than a hand-built array) keeps this test honest about real coverage.
const catalog: CatalogEntry[] = loadCatalog();

describe("prepare-for-swarm matcher engine over the vercel-hono-drizzle fixture", () => {
  // detectEnvironment is async (Scanner + fs reads). Run it once for the suite:
  // every assertion below is read-only over the same report and the matcher is
  // a pure function of it.
  let report: Awaited<ReturnType<typeof detectEnvironment>>;
  let groups: Record<SuggestionAxis, CatalogEntry[]>;

  beforeAll(async () => {
    report = await detectEnvironment(FIXTURE_PATH);
    groups = matchSuggestions(report, catalog);
  });

  it("reports the filesystem was readable", () => {
    // A degraded (available: false) report would make the stack assertions below
    // vacuously fail in a confusing way; surface the fs-access failure directly.
    expect(report.available).toBe(true);
  });

  it("detects all three stacks — Vercel, Hono, Drizzle", () => {
    expect(report.detected.vercel).toBe(true);
    expect(report.detected.hono).toBe(true);
    expect(report.detected.drizzle).toBe(true);
  });

  it("emits at least one suggestion in each of the three axes", () => {
    // Core acceptance criterion: a fully-detected stack must produce a non-empty
    // menu section for every axis (deployment-completion, skill, mcp). matchSuggestions
    // always returns every axis as a key, so assert on the grouped array lengths.
    for (const axis of SUGGESTION_AXES) {
      expect(groups[axis].length).toBeGreaterThan(0);
    }
  });

  it("caps each axis at no more than five suggestions", () => {
    // MAX_PER_AXIS guards against suggestion fatigue; the cap drops a stable tail
    // by deterministic ordering, so the per-axis count never exceeds five.
    for (const axis of SUGGESTION_AXES) {
      expect(groups[axis].length).toBeLessThanOrEqual(5);
    }
  });

  it("only groups each entry under its own declared axis", () => {
    // Guards the grouping itself: an entry must never leak into an axis bucket it
    // does not belong to, which would corrupt the per-axis menu sections.
    for (const axis of SUGGESTION_AXES) {
      for (const entry of groups[axis]) {
        expect(entry.axis).toBe(axis);
      }
    }
  });
});
