import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CatalogEntry,
  type DetectionSignal,
  loadCatalog,
  SUGGESTION_AXES,
} from "@mnmal-ai/swarm-cli";
import { describe, expect, it } from "vitest";

/**
 * Shape gate for the /prepare-for-swarm suggestion catalog.
 *
 * The catalog ships as pure data (suggestions/catalog.json) with no runtime
 * logic, so the only thing that can keep it honest is a test that walks every
 * entry and asserts the structural invariants the matcher, prompt loop, and
 * suggestions-log transcript all rely on. Loading via the public `loadCatalog`
 * export (rather than reading the JSON directly) exercises the same path the
 * runtime uses, so a broken packaging/copy step fails here too.
 */

// Load once for the whole suite: the catalog is small, ships in-SDK, and every
// assertion below is read-only over the same entries.
const catalog: CatalogEntry[] = loadCatalog();

// Absolute path to the on-disk template tree. Each entry's `templateFiles` are
// bare filenames relative to suggestions/templates/<id>/, so the only way to
// prove the catalog's copy step won't fail at runtime is to resolve those names
// against the real directory and stat them. Anchor on this test file's own
// location via import.meta.url (mirroring tests/setup/isolated-substrate.ts) so
// resolution is independent of the process working directory: from
// tests/integration/ the repo root is two levels up.
const TEMPLATES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages/cli/src/scaffold/suggestions/templates",
);

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// swarm-cli exports DetectionSignal as a type only — there is no runtime enum or
// Zod schema to parse against — so the test owns the list of valid kinds. The
// `satisfies` clause ties it back to the exported union: adding or removing a
// DetectionSignal variant in the source breaks this line at compile time, so the
// list can never silently drift from the schema it is meant to gate.
const DETECTION_SIGNAL_KINDS = [
  "dependency",
  "file",
  "env",
] as const satisfies ReadonlyArray<DetectionSignal["kind"]>;

describe("suggestion catalog structural invariants", () => {
  it("is non-empty", () => {
    // A zero-entry catalog would make every per-entry assertion below vacuously
    // pass, so guard the iteration explicitly.
    expect(catalog.length).toBeGreaterThan(0);
  });

  it("has no duplicate ids across the whole catalog", () => {
    // id keys the suggestions-log transcript and names the per-entry template
    // directory, so a collision silently overwrites one entry's record.
    const ids = catalog.map((entry) => entry.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  for (const [index, entry] of catalog.entries()) {
    // Label by id when present, falling back to the array index so a malformed
    // entry missing its id still produces a locatable test name.
    describe(`entry #${index} (${entry.id ?? "<missing id>"})`, () => {
      it("has a present, kebab-case id", () => {
        expect(typeof entry.id).toBe("string");
        expect(entry.id).toMatch(KEBAB_CASE);
      });

      it("declares one of the allowed axes", () => {
        expect(SUGGESTION_AXES).toContain(entry.axis);
      });

      it("has a non-empty title", () => {
        expect(typeof entry.title).toBe("string");
        expect(entry.title.trim().length).toBeGreaterThan(0);
      });

      it("has non-empty suggestionText", () => {
        expect(typeof entry.suggestionText).toBe("string");
        expect(entry.suggestionText.trim().length).toBeGreaterThan(0);
      });

      it("carries at least one detection signal", () => {
        // The matcher gates this entry on its detection signals; an entry with
        // zero signals would only ever surface via the always-offer fallback,
        // which the catalog deliberately does not use.
        expect(Array.isArray(entry.detection)).toBe(true);
        expect(entry.detection.length).toBeGreaterThan(0);
      });

      it("has only known-kind detection signals with the right payload", () => {
        for (const signal of entry.detection) {
          // Every signal must be one of the discriminated DetectionSignal
          // variants, and carry the non-empty payload field that variant's
          // matcher branch reads. A stray kind or empty field would make the
          // matcher silently skip the signal at runtime.
          expect(DETECTION_SIGNAL_KINDS).toContain(signal.kind);
          switch (signal.kind) {
            case "dependency":
              expect(typeof signal.pattern).toBe("string");
              expect(signal.pattern.trim().length).toBeGreaterThan(0);
              break;
            case "file":
              expect(typeof signal.glob).toBe("string");
              expect(signal.glob.trim().length).toBeGreaterThan(0);
              break;
            case "env":
              expect(typeof signal.name).toBe("string");
              expect(signal.name.trim().length).toBeGreaterThan(0);
              break;
          }
        }
      });

      it("declares templateFiles as an array", () => {
        // string[] at the type level, but the catalog is hand-edited JSON:
        // a dropped or non-array field would otherwise blow up where the
        // accept path iterates templateFiles to copy them. Fail loudly here.
        expect(Array.isArray(entry.templateFiles)).toBe(true);
      });

      // One assertion per declared template file so a missing file names itself
      // in the test report. Register-only entries carry templateFiles: [] and
      // legitimately generate no cases here.
      for (const file of entry.templateFiles) {
        it(`ships template file "${file}" inside its template directory`, () => {
          // templateFiles are bare filenames relative to
          // suggestions/templates/<id>/. Resolve against the entry's own
          // directory, then assert both containment and existence:
          //   - containment guards against a stray "../other-id/x" or absolute
          //     path reaching outside this entry's <id> directory, which would
          //     let one entry's accept step clobber another's templates.
          //   - existence guards the common case: the catalog promises to copy
          //     this file on accept, so a missing one is a broken entry.
          const entryDir = resolve(TEMPLATES_ROOT, entry.id);
          const resolved = resolve(entryDir, file);
          const rel = relative(entryDir, resolved);

          expect(isAbsolute(rel)).toBe(false);
          expect(rel.startsWith("..")).toBe(false);
          expect(existsSync(resolved)).toBe(true);
        });
      }
    });
  }

  it("collectively represents every allowed axis", () => {
    // The per-entry check above proves no entry declares an *unknown* axis; this
    // proves the inverse for the catalog as a whole — that no allowed axis ships
    // with zero entries. The suggestion flow groups offers by axis (deployment-
    // completion, skill, mcp), so an axis with no catalog coverage would render
    // an empty menu section the user never gets to act on. Sourcing the expected
    // set from the same SUGGESTION_AXES the structural axis check uses keeps the
    // two assertions in lockstep: adding an axis there forces a catalog entry
    // here. Superset (not strict equality) so a stray out-of-list axis is the
    // per-entry check's job to fail, not this one's.
    const present = new Set(catalog.map((entry) => entry.axis));
    for (const axis of SUGGESTION_AXES) {
      expect(present).toContain(axis);
    }
  });
});
