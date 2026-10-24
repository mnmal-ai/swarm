import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectEnvironment } from "../src/scaffold/suggestions/matcher.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ESM-idiomatic __dirname. Every other new test file in this PR uses
// this pattern; the older `__dirname` global only works here because
// Vitest injects it as a compatibility shim.
const __dirname = dirname(fileURLToPath(import.meta.url));

const TMP_ROOT = join(__dirname, "__fixtures__", "detect-env");

// A repo that exercises every recognized signal: a Vercel deploy (vercel.json +
// .vercel/ + a vercel dep), a Hono server, and a Drizzle ORM dependency.
const FULL_DIR = join(TMP_ROOT, "full-stack");
// A readable repo with none of the recognized tooling — distinguishes "empty
// findings" from "degraded / unreadable".
const BARE_DIR = join(TMP_ROOT, "bare");
// A readable directory with no package.json at all.
const NO_PKG_DIR = join(TMP_ROOT, "no-package-json");
// Never created on disk — drives the degraded path.
const MISSING_DIR = join(TMP_ROOT, "does-not-exist");

describe("detectEnvironment", () => {
  beforeAll(() => {
    mkdirSync(join(FULL_DIR, ".vercel"), { recursive: true });
    writeFileSync(
      join(FULL_DIR, "package.json"),
      JSON.stringify({
        name: "full-stack",
        dependencies: { hono: "^4.0.0", "drizzle-orm": "^0.30.0", vercel: "^33.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    writeFileSync(join(FULL_DIR, "vercel.json"), "{}");

    mkdirSync(BARE_DIR, { recursive: true });
    writeFileSync(
      join(BARE_DIR, "package.json"),
      JSON.stringify({ name: "bare", dependencies: { lodash: "^4.0.0" } }),
    );

    mkdirSync(NO_PKG_DIR, { recursive: true });
    writeFileSync(join(NO_PKG_DIR, "README.md"), "# no package");
  });

  afterAll(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("recognizes Vercel, Hono, and Drizzle in a full stack", async () => {
    const report = await detectEnvironment(FULL_DIR);
    expect(report.available).toBe(true);
    expect(report.detected.vercel).toBe(true);
    expect(report.detected.hono).toBe(true);
    expect(report.detected.drizzle).toBe(true);
  });

  it("reuses the Scanner for the base detected-stacks report", async () => {
    const report = await detectEnvironment(FULL_DIR);
    expect(report.scan).not.toBeNull();
    expect(report.scan?.project_name).toBe("full-stack");
    // Hono and Drizzle were added to the Scanner's framework map by this task.
    expect(report.scan?.frameworks).toContain("Hono");
    expect(report.scan?.frameworks).toContain("Drizzle");
  });

  it("exposes merged dependency names for arbitrary signal matching", async () => {
    const report = await detectEnvironment(FULL_DIR);
    expect(report.dependencies).toEqual(
      expect.arrayContaining(["hono", "drizzle-orm", "vercel", "typescript"]),
    );
  });

  it("detects Vercel from file presence even without a vercel dependency", async () => {
    // Drop a repo whose only Vercel signal is the config file.
    const fileOnly = join(TMP_ROOT, "vercel-file-only");
    mkdirSync(fileOnly, { recursive: true });
    writeFileSync(join(fileOnly, "vercel.json"), "{}");
    writeFileSync(
      join(fileOnly, "package.json"),
      JSON.stringify({ name: "vercel-file-only", dependencies: {} }),
    );

    const report = await detectEnvironment(fileOnly);
    expect(report.detected.vercel).toBe(true);
    expect(report.dependencies).not.toContain("vercel");
  });

  it("returns an available report with no findings for a bare repo", async () => {
    const report = await detectEnvironment(BARE_DIR);
    expect(report.available).toBe(true);
    expect(report.detected).toEqual({ vercel: false, hono: false, drizzle: false });
  });

  it("treats a missing package.json as no dependencies, not an error", async () => {
    const report = await detectEnvironment(NO_PKG_DIR);
    expect(report.available).toBe(true);
    expect(report.dependencies).toEqual([]);
    expect(report.detected.hono).toBe(false);
  });

  it("degrades to an empty report when the path is unreadable", async () => {
    const report = await detectEnvironment(MISSING_DIR);
    expect(report.available).toBe(false);
    expect(report.scan).toBeNull();
    expect(report.dependencies).toEqual([]);
    expect(report.detected).toEqual({ vercel: false, hono: false, drizzle: false });
  });
});
