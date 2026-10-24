import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, extname, relative } from "node:path";
import type { ScanResult } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Extension → Language mapping
// ---------------------------------------------------------------------------

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".swift": "Swift",
  ".m": "Objective-C",
  ".mm": "Objective-C",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".php": "PHP",
  ".scala": "Scala",
  ".clj": "Clojure",
  ".cljs": "Clojure",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".hs": "Haskell",
  ".lua": "Lua",
  ".r": "R",
  ".R": "R",
  ".dart": "Dart",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".sql": "SQL",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".json": "JSON",
  ".xml": "XML",
  ".md": "Markdown",
  ".proto": "Protocol Buffers",
  ".zig": "Zig",
};

// ---------------------------------------------------------------------------
// Package manager detection: file → manager name
// ---------------------------------------------------------------------------

const PACKAGE_MANAGER_FILES: Record<string, string> = {
  "package.json": "npm",
  "yarn.lock": "Yarn",
  "pnpm-lock.yaml": "pnpm",
  "bun.lockb": "Bun",
  "Cargo.toml": "Cargo",
  "go.mod": "Go Modules",
  "Gemfile": "Bundler",
  "requirements.txt": "pip",
  "Pipfile": "Pipenv",
  "pyproject.toml": "Poetry",
  "setup.py": "setuptools",
  "Podfile": "CocoaPods",
  "Package.swift": "Swift Package Manager",
  "build.gradle": "Gradle",
  "build.gradle.kts": "Gradle",
  "pom.xml": "Maven",
  "composer.json": "Composer",
  "mix.exs": "Mix",
  "pubspec.yaml": "pub",
  "CMakeLists.txt": "CMake",
  "Makefile": "Make",
};

// ---------------------------------------------------------------------------
// Framework detection from package.json dependencies
// ---------------------------------------------------------------------------

const NPM_FRAMEWORK_MAP: Record<string, string> = {
  react: "React",
  "react-dom": "React",
  "react-native": "React Native",
  next: "Next.js",
  vue: "Vue",
  nuxt: "Nuxt",
  "@angular/core": "Angular",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  hapi: "Hapi",
  hono: "Hono",
  nestjs: "NestJS",
  "@nestjs/core": "NestJS",
  "gatsby": "Gatsby",
  remix: "Remix",
  "@remix-run/node": "Remix",
  astro: "Astro",
  electron: "Electron",
  vite: "Vite",
  webpack: "webpack",
  tailwindcss: "Tailwind CSS",
  "styled-components": "styled-components",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  "drizzle-orm": "Drizzle",
  typeorm: "TypeORM",
  sequelize: "Sequelize",
  mongoose: "Mongoose",
  "socket.io": "Socket.IO",
  graphql: "GraphQL",
  "apollo-server": "Apollo",
  "@apollo/server": "Apollo",
  storybook: "Storybook",
  "@storybook/react": "Storybook",
};

// ---------------------------------------------------------------------------
// Test framework detection from package.json dependencies
// ---------------------------------------------------------------------------

const NPM_TEST_FRAMEWORK_MAP: Record<string, string> = {
  jest: "Jest",
  "@jest/core": "Jest",
  vitest: "Vitest",
  mocha: "Mocha",
  jasmine: "Jasmine",
  ava: "AVA",
  tap: "node-tap",
  "@testing-library/react": "Testing Library",
  "@testing-library/jest-dom": "Testing Library",
  cypress: "Cypress",
  playwright: "Playwright",
  "@playwright/test": "Playwright",
  puppeteer: "Puppeteer",
};

// ---------------------------------------------------------------------------
// CI detection: directory or file → platform name
// ---------------------------------------------------------------------------

const CI_INDICATORS: { path: string; type: "dir" | "file"; platform: string }[] = [
  { path: ".github/workflows", type: "dir", platform: "GitHub Actions" },
  { path: ".circleci", type: "dir", platform: "CircleCI" },
  { path: ".travis.yml", type: "file", platform: "Travis CI" },
  { path: "Jenkinsfile", type: "file", platform: "Jenkins" },
  { path: ".gitlab-ci.yml", type: "file", platform: "GitLab CI" },
  { path: "azure-pipelines.yml", type: "file", platform: "Azure Pipelines" },
  { path: "bitbucket-pipelines.yml", type: "file", platform: "Bitbucket Pipelines" },
  { path: "buildkite.yml", type: "file", platform: "Buildkite" },
  { path: ".buildkite", type: "dir", platform: "Buildkite" },
  { path: "appveyor.yml", type: "file", platform: "AppVeyor" },
  { path: "Taskfile.yml", type: "file", platform: "Taskfile" },
];

// ---------------------------------------------------------------------------
// Documentation file patterns (basename only)
// ---------------------------------------------------------------------------

const DOC_FILES = new Set([
  "README.md",
  "README",
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  "CHANGELOG.md",
  "CHANGELOG",
  "LICENSE",
  "LICENSE.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  ".cursorrules",
]);

// ---------------------------------------------------------------------------
// Entry point patterns (relative paths from project root)
// ---------------------------------------------------------------------------

const ENTRY_POINT_PATTERNS = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/index.jsx",
  "src/main.ts",
  "src/main.tsx",
  "src/main.js",
  "src/main.jsx",
  "src/app.ts",
  "src/app.tsx",
  "src/app.js",
  "src/app.jsx",
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "main.py",
  "app.py",
  "manage.py",
  "main.go",
  "cmd/main.go",
  "lib/main.dart",
  "Program.cs",
  "Main.java",
  "main.rs",
  "src/main.rs",
  "src/lib.rs",
];

// ---------------------------------------------------------------------------
// Directories to skip during tree walking
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".venv",
  "venv",
  "env",
  ".env",
  "vendor",
  "target",
  "Pods",
  ".build",
  ".swiftpm",
  "DerivedData",
  ".gradle",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

// ---------------------------------------------------------------------------
// Test directory/file patterns
// ---------------------------------------------------------------------------

const TEST_DIR_NAMES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "__specs__",
  "e2e",
  "integration",
]);

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /_test\.py$/,
  /test_.*\.py$/,
  /Tests?\.swift$/,
  /Tests?\.java$/,
  /Tests?\.kt$/,
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export class Scanner {
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Scan the project directory and return a structured ScanResult.
   */
  async scan(): Promise<ScanResult> {
    const allFiles = await this.walkDirectory(this.projectPath);
    const relativePaths = allFiles.map((f) => relative(this.projectPath, f));

    const projectName = await this.detectProjectName();
    const languages = this.detectLanguages(relativePaths);
    const packageManagers = await this.detectPackageManagers();
    const frameworks = await this.detectFrameworks();
    const { hasTests, testFrameworks } = await this.detectTests(relativePaths);
    const { hasCi, ciPlatforms } = await this.detectCI();
    const existingDocs = this.detectDocs(relativePaths);
    const entryPoints = this.detectEntryPoints(relativePaths);
    const projectStructure = await this.detectStructure();

    return {
      project_name: projectName,
      languages,
      package_managers: packageManagers,
      frameworks,
      project_structure: projectStructure,
      has_tests: hasTests,
      test_frameworks: testFrameworks,
      has_ci: hasCi,
      ci_platforms: ciPlatforms,
      existing_docs: existingDocs,
      entry_points: entryPoints,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Recursively walk a directory, returning all file paths.
   * Skips directories in the SKIP_DIRS set.
   */
  private async walkDirectory(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const nested = await this.walkDirectory(fullPath);
        results.push(...nested);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Derive the project name. Prefer the "name" field in package.json, then
   * fall back to the directory basename.
   */
  private async detectProjectName(): Promise<string> {
    try {
      const pkgRaw = await readFile(join(this.projectPath, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch {
      // No package.json — fall through
    }

    return basename(this.projectPath);
  }

  /**
   * Detect languages from file extensions and compute percentages.
   */
  private detectLanguages(relativePaths: string[]): { name: string; percentage: number }[] {
    const counts = new Map<string, number>();
    let totalCounted = 0;

    for (const p of relativePaths) {
      const ext = extname(p).toLowerCase();
      const lang = EXTENSION_LANGUAGE_MAP[ext];
      if (lang) {
        counts.set(lang, (counts.get(lang) ?? 0) + 1);
        totalCounted++;
      }
    }

    if (totalCounted === 0) return [];

    return Array.from(counts.entries())
      .map(([name, count]) => ({
        name,
        percentage: Math.round((count / totalCounted) * 100),
      }))
      .sort((a, b) => b.percentage - a.percentage);
  }

  /**
   * Detect package managers from known config files at project root.
   */
  private async detectPackageManagers(): Promise<string[]> {
    const found = new Set<string>();

    for (const [file, manager] of Object.entries(PACKAGE_MANAGER_FILES)) {
      try {
        await stat(join(this.projectPath, file));
        found.add(manager);
      } catch {
        // File does not exist
      }
    }

    return Array.from(found);
  }

  /**
   * Detect frameworks by inspecting package.json dependencies.
   * Extend later: Cargo.toml, go.mod, Gemfile, etc.
   */
  private async detectFrameworks(): Promise<string[]> {
    const found = new Set<string>();

    // Check package.json
    try {
      const pkgRaw = await readFile(join(this.projectPath, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      for (const dep of Object.keys(allDeps)) {
        const framework = NPM_FRAMEWORK_MAP[dep];
        if (framework) {
          found.add(framework);
        }
      }
    } catch {
      // No package.json
    }

    return Array.from(found);
  }

  /**
   * Detect test infrastructure: test directories, test file patterns,
   * and test framework dependencies.
   */
  private async detectTests(relativePaths: string[]): Promise<{ hasTests: boolean; testFrameworks: string[] }> {
    const frameworks = new Set<string>();
    let hasTestFiles = false;

    // Check for test directories
    for (const p of relativePaths) {
      const parts = p.split("/");
      for (const part of parts) {
        if (TEST_DIR_NAMES.has(part)) {
          hasTestFiles = true;
          break;
        }
      }

      // Check for test file patterns
      const fileName = basename(p);
      for (const pattern of TEST_FILE_PATTERNS) {
        if (pattern.test(fileName)) {
          hasTestFiles = true;
          break;
        }
      }
    }

    // Check package.json for test framework dependencies
    try {
      const pkgRaw = await readFile(join(this.projectPath, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      for (const dep of Object.keys(allDeps)) {
        const fw = NPM_TEST_FRAMEWORK_MAP[dep];
        if (fw) {
          frameworks.add(fw);
          hasTestFiles = true;
        }
      }
    } catch {
      // No package.json
    }

    return {
      hasTests: hasTestFiles,
      testFrameworks: Array.from(frameworks),
    };
  }

  /**
   * Detect CI/CD configuration by checking for known CI directories and files.
   */
  private async detectCI(): Promise<{ hasCi: boolean; ciPlatforms: string[] }> {
    const platforms = new Set<string>();

    for (const indicator of CI_INDICATORS) {
      try {
        const fullPath = join(this.projectPath, indicator.path);
        const s = await stat(fullPath);

        if (indicator.type === "dir" && s.isDirectory()) {
          platforms.add(indicator.platform);
        } else if (indicator.type === "file" && s.isFile()) {
          platforms.add(indicator.platform);
        }
      } catch {
        // Path does not exist
      }
    }

    return {
      hasCi: platforms.size > 0,
      ciPlatforms: Array.from(platforms),
    };
  }

  /**
   * Detect existing documentation files at the project root.
   */
  private detectDocs(relativePaths: string[]): string[] {
    const docs: string[] = [];

    for (const p of relativePaths) {
      // Only check root-level doc files (no directory separator in relative path)
      if (!p.includes("/") && DOC_FILES.has(p)) {
        docs.push(p);
      }
    }

    return docs.sort();
  }

  /**
   * Detect entry points from well-known file path patterns.
   */
  private detectEntryPoints(relativePaths: string[]): string[] {
    const entryPoints: string[] = [];
    const pathSet = new Set(relativePaths);

    for (const pattern of ENTRY_POINT_PATTERNS) {
      if (pathSet.has(pattern)) {
        entryPoints.push(pattern);
      }
    }

    return entryPoints;
  }

  /**
   * Build a high-level project structure listing top-level directories and files.
   */
  private async detectStructure(): Promise<{ path: string; type: "directory" | "file"; description?: string }[]> {
    const structure: { path: string; type: "directory" | "file"; description?: string }[] = [];

    let entries;
    try {
      entries = await readdir(this.projectPath, { withFileTypes: true });
    } catch {
      return structure;
    }

    // Well-known directory descriptions
    const DIR_DESCRIPTIONS: Record<string, string> = {
      src: "Source code",
      lib: "Library code",
      test: "Tests",
      tests: "Tests",
      __tests__: "Tests",
      spec: "Tests",
      docs: "Documentation",
      scripts: "Build/utility scripts",
      public: "Static assets",
      assets: "Assets",
      config: "Configuration",
      ".github": "GitHub configuration",
      ".circleci": "CircleCI configuration",
      ci: "CI configuration",
    };

    const FILE_DESCRIPTIONS: Record<string, string> = {
      "package.json": "Node.js package manifest",
      "tsconfig.json": "TypeScript configuration",
      "Cargo.toml": "Rust package manifest",
      "go.mod": "Go module definition",
      "Gemfile": "Ruby dependencies",
      "Makefile": "Build automation",
      "Dockerfile": "Container definition",
      "docker-compose.yml": "Container orchestration",
      ".gitignore": "Git ignore rules",
    };

    for (const entry of entries) {
      if (entry.name.startsWith(".") && !DIR_DESCRIPTIONS[entry.name]) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      if (entry.isDirectory()) {
        structure.push({
          path: entry.name,
          type: "directory",
          description: DIR_DESCRIPTIONS[entry.name],
        });
      } else if (entry.isFile()) {
        structure.push({
          path: entry.name,
          type: "file",
          description: FILE_DESCRIPTIONS[entry.name],
        });
      }
    }

    return structure.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }
}
