import { resolve, basename } from "node:path";
import { readFile, access } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  name: string;
  language: string | null;
  framework: string | null;
  dependencies: string[];
  gitBranch: string | null;
  gitRemote: string | null;
  hasGit: boolean;
  envVars: EnvVarInfo[];
  detectedFrom: string | null;
}

export interface EnvVarInfo {
  name: string;
  comment: string;
  hasDefault: boolean;
}

// ---------------------------------------------------------------------------
// Framework detection: dependency name -> framework label
// ---------------------------------------------------------------------------

const FRAMEWORK_MAP: Record<string, string> = {
  express: "Express",
  next: "Next.js",
  react: "React",
  fastify: "Fastify",
  "@angular/core": "Angular",
  angular: "Angular",
  vue: "Vue",
  svelte: "Svelte",
  nuxt: "Nuxt",
  remix: "Remix",
  hono: "Hono",
  elysia: "Elysia",
  koa: "Koa",
  "@nestjs/core": "NestJS",
  nestjs: "NestJS",
  electron: "Electron",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function execGit(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Individual detectors
// ---------------------------------------------------------------------------

interface DetectionResult {
  name?: string;
  language?: string;
  framework?: string;
  dependencies?: string[];
  detectedFrom?: string;
}

async function detectPackageJson(dir: string): Promise<DetectionResult | null> {
  const content = await readTextFile(resolve(dir, "package.json"));
  if (!content) return null;

  try {
    const pkg = JSON.parse(content) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const depNames = Object.keys(allDeps);

    // Detect framework from dependencies
    let framework: string | undefined;
    for (const [dep, label] of Object.entries(FRAMEWORK_MAP)) {
      if (dep in allDeps) {
        framework = label;
        break;
      }
    }

    // Detect language: TypeScript if typescript dep or tsconfig.json exists
    let language = "JavaScript";
    if ("typescript" in allDeps || await fileExists(resolve(dir, "tsconfig.json"))) {
      language = "TypeScript";
    }

    return {
      name: pkg.name || undefined,
      language,
      framework,
      dependencies: depNames,
      detectedFrom: "package.json",
    };
  } catch {
    return null;
  }
}

async function detectCargoToml(dir: string): Promise<DetectionResult | null> {
  const content = await readTextFile(resolve(dir, "Cargo.toml"));
  if (!content) return null;

  // Regex parse [package] name = "..."
  const nameMatch = content.match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/s);

  return {
    name: nameMatch?.[1],
    language: "Rust",
    detectedFrom: "Cargo.toml",
  };
}

async function detectPackageSwift(dir: string): Promise<DetectionResult | null> {
  const content = await readTextFile(resolve(dir, "Package.swift"));
  if (!content) return null;

  // Regex for name: "..."
  const nameMatch = content.match(/name:\s*"([^"]+)"/);

  return {
    name: nameMatch?.[1],
    language: "Swift",
    detectedFrom: "Package.swift",
  };
}

async function detectGoMod(dir: string): Promise<DetectionResult | null> {
  const content = await readTextFile(resolve(dir, "go.mod"));
  if (!content) return null;

  // Parse module path, last segment as name
  const moduleMatch = content.match(/^module\s+(\S+)/m);
  let name: string | undefined;
  if (moduleMatch) {
    const segments = moduleMatch[1].split("/");
    name = segments[segments.length - 1];
  }

  return {
    name,
    language: "Go",
    detectedFrom: "go.mod",
  };
}

async function detectPyprojectToml(dir: string): Promise<DetectionResult | null> {
  const content = await readTextFile(resolve(dir, "pyproject.toml"));
  if (!content) return null;

  // Regex for [project] name = "..."
  const nameMatch = content.match(/\[project\][^[]*?name\s*=\s*"([^"]+)"/s);

  return {
    name: nameMatch?.[1],
    language: "Python",
    detectedFrom: "pyproject.toml",
  };
}

async function detectRequirementsTxt(dir: string): Promise<DetectionResult | null> {
  const content = await readTextFile(resolve(dir, "requirements.txt"));
  if (!content) return null;

  // Parse package names (lines like "flask==2.0", "requests>=1.0", "numpy")
  const dependencies = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map((line) => line.split(/[>=<!~;@\s]/)[0])
    .filter(Boolean);

  return {
    language: "Python",
    dependencies,
    detectedFrom: "requirements.txt",
  };
}

function detectXcodeProject(dir: string): DetectionResult | null {
  try {
    const entries = readdirSync(dir);
    const xcodeEntry = entries.find(
      (e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"),
    );
    if (!xcodeEntry) return null;

    // Strip extension for project name
    const name = xcodeEntry.replace(/\.(xcodeproj|xcworkspace)$/, "");

    return {
      name,
      language: "Swift",
      framework: "Xcode",
      detectedFrom: xcodeEntry,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git detection
// ---------------------------------------------------------------------------

interface GitInfo {
  branch: string | null;
  remote: string | null;
  hasGit: boolean;
}

async function detectGit(dir: string): Promise<GitInfo> {
  const hasGit = await fileExists(resolve(dir, ".git"));
  if (!hasGit) {
    return { branch: null, remote: null, hasGit: false };
  }

  const branch = execGit("git branch --show-current", dir);
  const remote = execGit("git remote get-url origin", dir);

  return { branch, remote, hasGit: true };
}

// ---------------------------------------------------------------------------
// Env file parsing
// ---------------------------------------------------------------------------

async function detectEnvVars(dir: string): Promise<EnvVarInfo[]> {
  const candidates = [".env.example", ".env.template", ".env.sample"];

  for (const filename of candidates) {
    const content = await readTextFile(resolve(dir, filename));
    if (!content) continue;

    const vars: EnvVarInfo[] = [];
    let pendingComment = "";

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();

      // Comment line: accumulate for the next variable
      if (line.startsWith("#")) {
        const commentText = line.slice(1).trim();
        pendingComment = pendingComment
          ? `${pendingComment} ${commentText}`
          : commentText;
        continue;
      }

      // Empty line: reset pending comment
      if (!line) {
        pendingComment = "";
        continue;
      }

      // Variable line: KEY=value or KEY= or bare KEY
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) {
        // Bare KEY (no equals sign)
        vars.push({
          name: line,
          comment: pendingComment,
          hasDefault: false,
        });
      } else {
        const name = line.slice(0, eqIndex).trim();
        const value = line.slice(eqIndex + 1).trim();
        vars.push({
          name,
          comment: pendingComment,
          hasDefault: value.length > 0,
        });
      }

      pendingComment = "";
    }

    return vars;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Main detection entry point
// ---------------------------------------------------------------------------

export async function detectProject(dir: string): Promise<ProjectInfo> {
  const resolvedDir = resolve(dir);

  // Run all detectors in parallel (best-effort)
  const [
    packageJsonResult,
    cargoResult,
    swiftResult,
    goResult,
    pyprojectResult,
    requirementsResult,
    gitInfo,
    envVars,
  ] = await Promise.all([
    detectPackageJson(resolvedDir).catch(() => null),
    detectCargoToml(resolvedDir).catch(() => null),
    detectPackageSwift(resolvedDir).catch(() => null),
    detectGoMod(resolvedDir).catch(() => null),
    detectPyprojectToml(resolvedDir).catch(() => null),
    detectRequirementsTxt(resolvedDir).catch(() => null),
    detectGit(resolvedDir).catch(() => ({ branch: null, remote: null, hasGit: false })),
    detectEnvVars(resolvedDir).catch(() => [] as EnvVarInfo[]),
  ]);

  // Xcode detection is sync (uses readdirSync)
  let xcodeResult: DetectionResult | null = null;
  try {
    xcodeResult = detectXcodeProject(resolvedDir);
  } catch {
    // ignore
  }

  // Priority order: package.json, Cargo.toml, Package.swift, go.mod,
  // pyproject.toml, requirements.txt, Xcode project
  const detectors: (DetectionResult | null)[] = [
    packageJsonResult,
    cargoResult,
    swiftResult,
    goResult,
    pyprojectResult,
    requirementsResult,
    xcodeResult,
  ];

  // Find the first successful detection
  const primary = detectors.find((d) => d !== null) ?? null;

  return {
    name: primary?.name ?? basename(resolvedDir),
    language: primary?.language ?? null,
    framework: primary?.framework ?? null,
    dependencies: primary?.dependencies ?? [],
    gitBranch: gitInfo.branch,
    gitRemote: gitInfo.remote,
    hasGit: gitInfo.hasGit,
    envVars,
    detectedFrom: primary?.detectedFrom ?? null,
  };
}
