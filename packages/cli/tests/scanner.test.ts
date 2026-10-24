import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Scanner } from "../src/scanner/index.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(__dirname, "__fixtures__", "test-project");

describe("Scanner", () => {
  beforeAll(() => {
    mkdirSync(join(FIXTURE_DIR, "src"), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, "tests"), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, ".github", "workflows"), { recursive: true });

    writeFileSync(join(FIXTURE_DIR, "package.json"), JSON.stringify({
      name: "test-project",
      dependencies: { react: "^18.0.0", express: "^4.18.0" },
      devDependencies: { jest: "^29.0.0", typescript: "^5.0.0" },
    }));
    writeFileSync(join(FIXTURE_DIR, "tsconfig.json"), "{}");
    writeFileSync(join(FIXTURE_DIR, "src", "index.ts"), "export const main = () => {}");
    writeFileSync(join(FIXTURE_DIR, "src", "app.tsx"), "export default function App() { return <div /> }");
    writeFileSync(join(FIXTURE_DIR, "tests", "index.test.ts"), "test('works', () => {})");
    writeFileSync(join(FIXTURE_DIR, "README.md"), "# Test Project");
    writeFileSync(join(FIXTURE_DIR, ".github", "workflows", "ci.yml"), "name: CI");
  });

  afterAll(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("detects languages from file extensions", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    const langNames = result.languages.map((l) => l.name);
    expect(langNames).toContain("TypeScript");
  });

  it("detects package managers", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    expect(result.package_managers).toContain("npm");
  });

  it("detects frameworks from dependencies", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    expect(result.frameworks).toContain("React");
    expect(result.frameworks).toContain("Express");
  });

  it("detects test infrastructure", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    expect(result.has_tests).toBe(true);
    expect(result.test_frameworks).toContain("Jest");
  });

  it("detects CI configuration", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    expect(result.has_ci).toBe(true);
    expect(result.ci_platforms).toContain("GitHub Actions");
  });

  it("finds existing documentation", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    expect(result.existing_docs).toContain("README.md");
  });

  it("uses directory name as project name", async () => {
    const scanner = new Scanner(FIXTURE_DIR);
    const result = await scanner.scan();
    expect(result.project_name).toBe("test-project");
  });
});
