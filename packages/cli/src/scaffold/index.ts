/**
 * Scaffold engine for initializing a new .swarm directory.
 *
 * Creates swarm context files from templates, configures backend presets,
 * and injects guided answers when provided.
 */

import { TEMPLATES, type TemplatePath } from "./templates/index.js";
import { join, dirname, resolve } from "node:path";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FillLevel = "guided" | "quick" | "empty";
export type RuntimeBackend =
  | "claude-code"
  | "cursor"
  | "codex"
  | "direct-api"
  | "undecided";

export interface BackendPreset {
  backendType: "claude-code" | "api";
  provider: "anthropic" | "openai";
  apiKeyEnv: string;
  models: { worker: string; reviewer: string; arbiter: string };
}

export interface ScaffoldConfig {
  projectName: string;
  outputDir: string;
  fillLevel: FillLevel;
  backend: RuntimeBackend;
  answers: GuidedAnswers;
  /** For direct-api backend: which provider to use. */
  directApiProvider?: "anthropic" | "openai";
  /** How to handle existing .swarm/ directory. Default: "error" */
  existingBehavior?: "merge" | "overwrite" | "error";
}

export interface GuidedAnswers {
  values?: string;
  rules?: string;
  voice?: string;
  techStack?: string;
  patterns?: string;
  constraints?: string;
  definitionOfDone?: string;
  secrets?: string;
  secretSetup?: string;
  goals?: string;
}

export interface ScaffoldResult {
  filesCreated: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Backend presets
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS = {
  worker: "claude-sonnet-4-6",
  reviewer: "claude-sonnet-4-6",
  arbiter: "claude-opus-4-6",
};

const OPENAI_MODELS = {
  worker: "o3",
  reviewer: "o3",
  arbiter: "o3",
};

/**
 * Returns the backend preset for a given runtime target.
 *
 * | Backend      | Type        | Provider  | API Key Env         | Models              |
 * |-------------|-------------|-----------|---------------------|---------------------|
 * | claude-code | claude-code | anthropic | ANTHROPIC_API_KEY   | sonnet/sonnet/opus  |
 * | cursor      | claude-code | anthropic | ANTHROPIC_API_KEY   | sonnet/sonnet/opus  |
 * | codex       | api         | openai    | OPENAI_API_KEY      | o3/o3/o3            |
 * | direct-api  | api         | (param)   | (derived)           | (derived)           |
 * | undecided   | api         | anthropic | ANTHROPIC_API_KEY   | sonnet/sonnet/opus  |
 */
export function getBackendPreset(
  backend: RuntimeBackend,
  provider?: "anthropic" | "openai",
): BackendPreset {
  switch (backend) {
    case "claude-code":
      return {
        backendType: "claude-code",
        provider: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        models: { ...ANTHROPIC_MODELS },
      };

    case "cursor":
      return {
        backendType: "claude-code",
        provider: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        models: { ...ANTHROPIC_MODELS },
      };

    case "codex":
      return {
        backendType: "api",
        provider: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
        models: { ...OPENAI_MODELS },
      };

    case "direct-api": {
      const resolvedProvider = provider ?? "anthropic";
      const isOpenAI = resolvedProvider === "openai";
      return {
        backendType: "api",
        provider: resolvedProvider,
        apiKeyEnv: isOpenAI ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
        models: isOpenAI ? { ...OPENAI_MODELS } : { ...ANTHROPIC_MODELS },
      };
    }

    case "undecided":
      return {
        backendType: "api",
        provider: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        models: { ...ANTHROPIC_MODELS },
      };
  }
}

// ---------------------------------------------------------------------------
// Template processing
// ---------------------------------------------------------------------------

/**
 * Replace `{project}` and `{timestamp}` placeholders in both file paths
 * and content strings.
 */
function replacePlaceholders(
  input: string,
  projectName: string,
  timestamp: string,
): string {
  return input.replace(/\{project\}/g, projectName).replace(/\{timestamp\}/g, timestamp);
}

/**
 * Mapping from template paths to the GuidedAnswers field that should be
 * injected into them.  Each entry specifies the section header after which
 * the answer content is inserted.
 */
const GUIDED_INJECTION_MAP: Record<
  string,
  { answerKey: keyof GuidedAnswers; sectionHeader: string }
> = {
  "core/values.md": { answerKey: "values", sectionHeader: "## Principles" },
  "core/rules.md": { answerKey: "rules", sectionHeader: "## Always Do" },
  "core/voice.md": { answerKey: "voice", sectionHeader: "## Tone" },
  "domains/{project}/overview.md": {
    answerKey: "techStack",
    sectionHeader: "## Tech Stack",
  },
  "domains/{project}/architecture.md": {
    answerKey: "patterns",
    sectionHeader: "## Patterns",
  },
  "domains/{project}/constraints.md": {
    answerKey: "constraints",
    sectionHeader: "## Protected Files",
  },
  "domains/{project}/definition-of-done.md": {
    answerKey: "definitionOfDone",
    sectionHeader: "## Build",
  },
  "domains/{project}/environment.md": {
    answerKey: "secrets",
    sectionHeader: "## Required Variables",
  },
  "domains/{project}/secrets.md": {
    answerKey: "secretSetup",
    sectionHeader: "## Setup Instructions",
  },
};

/**
 * Inject a guided answer into a template by appending it after the
 * specified section header line.
 */
function injectGuidedAnswer(
  content: string,
  sectionHeader: string,
  answer: string,
): string {
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  if (headerIndex === -1) {
    // Section not found — append at the end with the header
    return content + "\n" + sectionHeader + "\n\n" + answer + "\n";
  }

  // Insert the answer content right after the header line and any
  // immediately following HTML comment block.
  let insertAt = headerIndex + 1;
  // Skip blank lines and HTML comments after the header
  while (insertAt < lines.length) {
    const trimmed = lines[insertAt].trim();
    if (trimmed === "" || trimmed.startsWith("<!--") || trimmed.endsWith("-->")) {
      insertAt++;
    } else {
      break;
    }
  }

  lines.splice(insertAt, 0, "", answer, "");
  return lines.join("\n");
}

/**
 * Strip example content for "empty" fill level, keeping only section
 * headers (lines starting with #) and HTML comments.
 */
function stripToHeaders(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let inComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track HTML comment blocks
    if (trimmed.startsWith("<!--")) {
      inComment = true;
      kept.push(line);
      if (trimmed.endsWith("-->")) {
        inComment = false;
      }
      continue;
    }
    if (inComment) {
      kept.push(line);
      if (trimmed.endsWith("-->")) {
        inComment = false;
      }
      continue;
    }

    // Keep section headers
    if (trimmed.startsWith("#")) {
      kept.push(line);
      kept.push(""); // Blank line after header
      continue;
    }
  }

  return kept.join("\n") + "\n";
}

/**
 * Process a template's content based on the fill level and guided answers.
 */
function processTemplate(
  templatePath: TemplatePath,
  content: string,
  config: ScaffoldConfig,
  timestamp: string,
): string {
  const projectName = config.projectName;
  let processed = replacePlaceholders(content, projectName, timestamp);

  // For JSON files, do not strip or inject — just return with placeholders replaced.
  if (templatePath.endsWith(".json") || templatePath === ".gitignore") {
    return processed;
  }

  switch (config.fillLevel) {
    case "empty":
      // Strip to headers + comments only
      processed = stripToHeaders(processed);
      break;

    case "guided": {
      // Inject guided answers where configured
      const injection = GUIDED_INJECTION_MAP[templatePath];
      if (injection) {
        const answer = config.answers[injection.answerKey];
        if (answer) {
          processed = injectGuidedAnswer(
            processed,
            injection.sectionHeader,
            answer,
          );
        }
      }
      break;
    }

    case "quick":
      // Use the template as-is (with placeholders replaced)
      break;
  }

  return processed;
}

/**
 * Apply backend preset overrides to the config.json template content.
 */
function applyBackendPreset(
  configContent: string,
  preset: BackendPreset,
): string {
  const parsed = JSON.parse(configContent);

  parsed.models = {
    worker: preset.models.worker,
    reviewer: preset.models.reviewer,
    arbiter: preset.models.arbiter,
    provider: preset.provider,
  };

  // Every role runs on the chosen runtime. A role the config leaves out runs on
  // the direct API, so a Claude Code project without an API key would have its
  // reviewer and arbiter reject every task for safety.
  const roleBackend = (): Record<string, string> => ({
    type: preset.backendType,
    ...(preset.backendType === "claude-code" ? { fallback: "api" } : {}),
  });
  parsed.backends = { worker: roleBackend(), reviewer: roleBackend(), arbiter: roleBackend() };

  return JSON.stringify(parsed, null, 2);
}

/**
 * Apply guided goals answer to goals.json.  If the answer parses as JSON,
 * use it directly.  Otherwise, create a single goal from the text.
 */
function applyGoalsAnswer(goalsContent: string, answer: string): string {
  // Try parsing the answer as JSON first
  try {
    const parsed = JSON.parse(answer);
    if (parsed.goals && Array.isArray(parsed.goals)) {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Not JSON — treat as a description for a single goal
  }

  const goalsObj = JSON.parse(goalsContent);
  goalsObj.goals[0].description = answer;
  return JSON.stringify(goalsObj, null, 2);
}

// ---------------------------------------------------------------------------
// Directory structure
// ---------------------------------------------------------------------------

/** All directories that must exist in a scaffolded swarm. */
function getDirectories(projectName: string): string[] {
  return [
    "core",
    "modes",
    "capabilities",
    `domains/${projectName}`,
    "designs",
    "skills/core",
    "skills/vetted",
    "skills/community",
    "oversight",
  ];
}

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

/**
 * Scaffold a complete .swarm directory from templates.
 *
 * 1. Creates all directories.
 * 2. Processes each template: replaces placeholders, applies fill level
 *    transformations, injects guided answers.
 * 3. Applies backend preset to config.json.
 * 4. Creates .gitkeep files in empty skill directories.
 * 5. Returns list of files created and any warnings.
 */
export async function scaffold(config: ScaffoldConfig): Promise<ScaffoldResult> {
  const filesCreated: string[] = [];
  const warnings: string[] = [];
  const timestamp = new Date().toISOString();
  const preset = getBackendPreset(config.backend, config.directApiProvider);

  // Check if output directory already has swarm files
  const behavior = config.existingBehavior ?? "error";
  let swarmExists = false;
  try {
    await access(join(config.outputDir, "swarm.json"));
    swarmExists = true;
  } catch {
    // Does not exist
  }

  if (swarmExists && behavior === "error") {
    warnings.push(
      `swarm.json already exists in ${config.outputDir}. Use --dir or delete the directory first.`,
    );
    return { filesCreated, warnings };
  }

  // 1. Create all directories
  const dirs = getDirectories(config.projectName);
  for (const dir of dirs) {
    await mkdir(join(config.outputDir, dir), { recursive: true });
  }

  // 2. Process and write each template
  const templatePaths = Object.keys(TEMPLATES) as TemplatePath[];

  for (const templatePath of templatePaths) {
    const rawContent = TEMPLATES[templatePath];

    // Resolve output file path: replace {project} in the path
    const resolvedPath = replacePlaceholders(
      templatePath,
      config.projectName,
      timestamp,
    );
    const fullPath = join(config.outputDir, resolvedPath);

    // Ensure the parent directory exists
    await mkdir(dirname(fullPath), { recursive: true });

    // Process the content
    let content = processTemplate(templatePath, rawContent, config, timestamp);

    // Special handling for config.json — apply backend preset
    if (templatePath === "domains/{project}/config.json") {
      content = applyBackendPreset(content, preset);
    }

    // Special handling for goals.json — inject guided answer if present
    if (
      templatePath === "domains/{project}/goals.json" &&
      config.fillLevel === "guided" &&
      config.answers.goals
    ) {
      content = applyGoalsAnswer(content, config.answers.goals);
    }

    // In merge mode, skip files that already exist
    if (behavior === "merge") {
      try {
        await access(fullPath);
        // File exists — skip it
        continue;
      } catch {
        // File doesn't exist — write it
      }
    }

    await writeFile(fullPath, content, "utf-8");
    filesCreated.push(resolvedPath);
  }

  // 3. Create .gitkeep files in empty skill directories
  const skillDirs = ["skills/core", "skills/vetted", "skills/community"];
  for (const dir of skillDirs) {
    const gitkeepPath = join(config.outputDir, dir, ".gitkeep");
    await writeFile(gitkeepPath, "", "utf-8");
    filesCreated.push(join(dir, ".gitkeep"));
  }

  // 4. Validate route references — create stubs for missing files
  const validation = await validateRouteReferences(config.outputDir, config.projectName);
  for (const stub of validation.stubs) {
    filesCreated.push(stub);
  }
  for (const warning of validation.warnings) {
    warnings.push(warning);
  }
  if (validation.stubs.length > 0) {
    warnings.push(`Created ${validation.stubs.length} stub file(s). Run your prepare-for-swarm skill to populate them.`);
  }

  return { filesCreated, warnings };
}

// ---------------------------------------------------------------------------
// Route reference validation
// ---------------------------------------------------------------------------

/**
 * After scaffolding, parse swarm.json and verify that every file referenced
 * in route load objects exists. Creates stubs for missing files.
 */
async function validateRouteReferences(
  outputDir: string,
  projectName: string,
): Promise<{ stubs: string[]; warnings: string[] }> {
  const stubs: string[] = [];
  const warnings: string[] = [];

  const swarmJsonPath = join(outputDir, "swarm.json");
  let swarmJson: unknown;
  try {
    const content = await readFile(swarmJsonPath, "utf-8");
    swarmJson = JSON.parse(content);
  } catch {
    return { stubs, warnings };
  }
  if (typeof swarmJson !== "object" || swarmJson === null) {
    return { stubs, warnings };
  }
  const bj = swarmJson as Record<string, unknown>;

  // Collect all referenced file paths from routes and fallback
  const referencedPaths = new Set<string>();

  function collectPaths(load: Record<string, unknown>) {
    for (const tier of Object.values(load)) {
      if (Array.isArray(tier)) {
        for (const path of tier) {
          if (typeof path === "string") {
            referencedPaths.add(path.replace(/\{project\}/g, projectName));
          }
        }
      }
    }
  }

  const routes = Array.isArray(bj.routes) ? bj.routes : [];
  for (const route of routes) {
    if (route && typeof route === "object" && "load" in route) {
      collectPaths(route.load as Record<string, unknown>);
    }
  }
  const fallback = bj.fallback as Record<string, unknown> | undefined;
  if (fallback?.load) {
    collectPaths(fallback.load as Record<string, unknown>);
  }

  // Check each referenced path and create stubs for missing files
  const resolvedOutputDir = resolve(outputDir);
  for (const refPath of referencedPaths) {
    const fullPath = resolve(outputDir, refPath);
    // Path traversal protection — refuse to write outside outputDir
    if (!fullPath.startsWith(resolvedOutputDir + "/")) {
      warnings.push(`swarm.json references "${refPath}" which resolves outside the swarm directory. Skipped.`);
      continue;
    }
    try {
      await access(fullPath);
    } catch {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(
        fullPath,
        `<!-- STUB: This file is referenced in swarm.json but was not scaffolded. Fill it in or remove the route reference. -->\n`,
        "utf-8",
      );
      stubs.push(refPath);
      warnings.push(`swarm.json references "${refPath}" but no template exists. Created stub.`);
    }
  }

  return { stubs, warnings };
}
