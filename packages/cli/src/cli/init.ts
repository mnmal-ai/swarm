/**
 * swarm init — Interactive scaffolding for a new swarm.
 *
 * Scaffolds a .swarm/ directory with templates, detects the project,
 * asks guided questions, and generates a skill file for the user's LLM tool.
 * No LLM interaction — everything is local.
 *
 * See question-tree.md in this directory for the complete interactive flow
 * documentation. That file is the source of truth — keep it updated when
 * the flow changes.
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
// Dynamic imports for ESM-only packages (resolved at runtime)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let p: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pc: any;

import { detectProject } from "../detect/index.js";
import {
  scaffold,
  getBackendPreset,
  type FillLevel,
  type RuntimeBackend,
  type GuidedAnswers,
  type ScaffoldConfig,
} from "../scaffold/index.js";
import { getSkillTemplate } from "../scaffold/skill-templates/index.js";
import { startAnimation } from "../animation/index.js";
import { selectOrType } from "./select-or-type.js";
import { VERSION } from "../version.js";
import type { SwarmMeta } from "./swarm-meta.js";

// ---------------------------------------------------------------------------
// Init command
// ---------------------------------------------------------------------------

/**
 * After `swarm init` sets up a database (Docker or connection string),
 * resolve the docker-compose directory, bring Substrate up
 * (`ensureProjectSubstrate`), and seed swarm content from the scaffolded
 * `.swarm/` directory.
 *
 * Exported so tests can exercise the Docker-mode wiring directly.
 */
export async function startSidecarAndSeed(
  dbMode: "docker" | "connection_string" | "file",
  outputDir: string,
  projectName: string,
  quiet = false,
): Promise<void> {
  if (dbMode === "file") return;

  try {
    const { ensureProjectSubstrate } = await import("../substrate/ready.js");
    const { existsSync: fileExists } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    // Resolve dockerComposeDir for Docker mode.
    // Check the standard location first; fall back to resolveDbConfig if it differs.
    let dockerComposeDir: string | undefined;
    if (dbMode === "docker") {
      const standardDir = joinPath(homedir(), ".swarm", "infrastructure");
      if (fileExists(joinPath(standardDir, "docker-compose.yml"))) {
        dockerComposeDir = standardDir;
      } else {
        // Non-standard location — try resolveDbConfig
        const { resolveDbConfig } = await import("../config.js");
        const dbConfig = await resolveDbConfig({ swarmDir: outputDir });
        dockerComposeDir = dbConfig?.dockerComposeDir;
        if (!dockerComposeDir) {
          console.warn("[swarm] Could not locate docker-compose.yml — sidecar startup may fail.");
        }
      }
    }

    // Honour a `substrate` block the project already carries (dedicated stack,
    // local_only) exactly as every other command does — init must not seed a
    // dedicated or local_only project into the shared stack.
    const { prepareProjectSubstrate, ProjectSubstrateConfigError } = await import("../project-substrate.js");
    const { LocalOnlyViolation } = await import("@mnmal-ai/swarm-substrate");
    let isolated: Awaited<ReturnType<typeof prepareProjectSubstrate>>["isolated"];
    try {
      ({ isolated } = await prepareProjectSubstrate(outputDir, projectName));
    } catch (err) {
      if (err instanceof ProjectSubstrateConfigError || err instanceof LocalOnlyViolation) {
        console.error(`[swarm] ${err.message}`);
        console.error("[swarm] Content was not seeded; fix the above and run `swarm sync`.");
        return;
      }
      throw err;
    }

    const client = await ensureProjectSubstrate({
      quiet,
      ...(isolated !== undefined ? { isolated } : { dockerComposeDir }),
    });
    if (client) {
      // Seed swarm content from the just-scaffolded .swarm/ directory
      const { seedSwarmContent } = await import("./seed.js");
      const counts = await seedSwarmContent(client, outputDir, projectName);
      console.log(`[swarm] Seeded ${counts.content} content, ${counts.routes} routes, ${counts.configs} configs.`);

      // Reconcile any MCP servers the scaffolded templates wrote into
      // config.json so they exist as McpServer entities before first `swarm run`.
      const { reconcileMcpServers } = await import("./mcp-manage.js");
      const reconciled = await reconcileMcpServers(client, outputDir, projectName);
      if (reconciled.length > 0) {
        console.log(`[swarm] Registered MCP server(s) in Substrate: ${reconciled.join(", ")}`);
      }
    }
  } catch (err) {
    console.warn(`[swarm] Could not seed swarm content: ${err instanceof Error ? err.message : String(err)}`);
    console.warn("[swarm] You can seed later with: swarm sync");
  }
}

export async function runInit(args: Record<string, string>): Promise<void> {
  // Load ESM-only dependencies dynamically
  p = await import("@clack/prompts");
  pc = (await import("picocolors")).default;

  const cwd = process.cwd();
  let outputDir = resolve(cwd, args["dir"] ?? ".swarm");
  const noSkill = args["no-skill"] === "true";
  const noAnimation = args["no-animation"] === "true";
  const fromSwarm = args["from"];

  // Determine fill level from flags
  let fillLevel: FillLevel | null = null;
  if (args["guided"] === "true") fillLevel = "guided";
  if (args["quick"] === "true") fillLevel = "quick";
  if (args["empty"] === "true") fillLevel = "empty";

  // ── Welcome ──────────────────────────────────────────────────────────────

  console.log("");

  // Show the swarm animation as a welcome splash
  if (!noAnimation) {
    const stopSplash = startAnimation(`swarm v${VERSION}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    stopSplash();
  }

  p.intro(pc.magenta(`swarm v${VERSION}`));

  // ── Step 0: Pre-check ────────────────────────────────────────────────────

  let existingBehavior: "merge" | "overwrite" | undefined;
  let addDomainMode = false;

  // --from: add a new domain to an existing swarm (writes into source swarm, not a copy)
  if (fromSwarm) {
    const sourcePath = resolve(fromSwarm);
    if (!existsSync(sourcePath)) {
      p.log.error(`Source swarm not found: ${sourcePath}`);
      process.exit(1);
    }
    // Validate it's actually a swarm (has core/ or swarm.json)
    const hasCore = existsSync(join(sourcePath, "core"));
    const hasSwarmJson = existsSync(join(sourcePath, "swarm.json"));
    if (!hasCore && !hasSwarmJson) {
      p.log.error(`${sourcePath} doesn't look like a swarm directory (no core/ or swarm.json).`);
      process.exit(1);
    }

    // Resolve to real path to prevent symlink attacks
    const realSourcePath = realpathSync(sourcePath);

    // Point outputDir to the source swarm — new domain files are written there
    outputDir = realSourcePath;
    p.log.success(`Using swarm at ${pc.cyan(realSourcePath)}`);
    addDomainMode = true;
    existingBehavior = "merge";
  }

  if (!fromSwarm && existsSync(outputDir)) {
    // Detect symlinked .swarm/ — auto-enter add-domain mode.
    // A symlinked swarm points to a shared swarm. We should never overwrite it.
    let isSymlink = false;
    try {
      isSymlink = lstatSync(outputDir).isSymbolicLink();
    } catch { /* ignore */ }

    if (isSymlink) {
      let realPath: string;
      try {
        realPath = realpathSync(outputDir);
      } catch {
        p.log.error(`Symlink at ${outputDir} points to a missing target. Fix the symlink or remove it.`);
        process.exit(1);
      }
      p.log.success(`Found symlinked swarm → ${pc.cyan(realPath)}`);
      p.log.info("Adding a new domain to the shared swarm. Core, modes, and skills will be preserved.");
      outputDir = realPath;
      addDomainMode = true;
      existingBehavior = "merge";
    } else {
    // Check if this swarm has populated core files
    const valuesPath = join(outputDir, "core", "values.md");
    const hasPopulatedCore = existsSync(valuesPath) &&
      readFileSync(valuesPath, "utf-8").length > 200;

    if (hasPopulatedCore) {
      const action = await p.select({
        message: "A swarm already exists here. What would you like to do?",
        options: [
          { value: "add-domain", label: "Add a new domain", hint: "keep core/modes/skills, add domain files for a new project" },
          { value: "merge", label: "Add missing files only (non-destructive)" },
          { value: "overwrite", label: "Start fresh (overwrites everything)" },
          { value: "abort", label: "Abort" },
        ],
      });

      if (p.isCancel(action) || action === "abort") {
        p.cancel("Aborted.");
        process.exit(0);
      }

      if (action === "add-domain") {
        addDomainMode = true;
        existingBehavior = "merge";
      } else {
        existingBehavior = action as "merge" | "overwrite";
      }
    } else {
      // Original flow for swarms without populated core
      const action = await p.select({
        message: "A swarm already exists here. What would you like to do?",
        options: [
          { value: "merge", label: "Add missing files only (non-destructive)" },
          { value: "overwrite", label: "Start fresh (overwrites everything)" },
          { value: "abort", label: "Abort" },
        ],
      });

      if (p.isCancel(action) || action === "abort") {
        p.cancel("Aborted.");
        process.exit(0);
      }

      existingBehavior = action as "merge" | "overwrite";
    }
    } // close isSymlink else
  }

  if (addDomainMode) {
    p.log.info(`Adding a new domain to existing swarm. Core, modes, and skills will be preserved.`);
  }

  // ── Step 1: Project detection ────────────────────────────────────────────

  const projectInfo = await detectProject(cwd);

  const projectNameOverride = args["project"];
  let projectName = projectNameOverride ?? projectInfo.name;

  // Show detection results
  const detectedItems: string[] = [];
  if (projectInfo.language) detectedItems.push(projectInfo.language);
  if (projectInfo.framework) detectedItems.push(projectInfo.framework);
  if (projectInfo.detectedFrom) detectedItems.push(`from ${projectInfo.detectedFrom}`);

  if (detectedItems.length > 0) {
    p.log.info(`Detected: ${pc.cyan(projectName)} (${detectedItems.join(", ")})`);
  } else {
    p.log.info(`Project: ${pc.cyan(projectName)} (no manifest files found)`);
  }

  if (!projectInfo.hasGit) {
    p.log.warn("This directory is not a git repo. Swarm uses worktrees — you'll need git init before swarm run.");
  }

  // ── Step 1b: Existing codebase or new project? ───────────────────────────

  const projectStage = await p.select({
    message: "What are you working with?",
    options: [
      { value: "existing", label: "An existing codebase", hint: "swarm will learn your project's patterns" },
      { value: "new", label: "A new project", hint: "swarm will help you set up conventions from scratch" },
    ],
  });

  if (p.isCancel(projectStage)) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  const isNewProject = projectStage === "new";

  if (isNewProject) {
    p.log.info("Starting fresh — swarm will help you define conventions and standards before you write code.");
  }

  // ── Step 2: Speed dial ───────────────────────────────────────────────────

  if (!fillLevel) {
    const selected = await p.select({
      message: "How would you like to get started?",
      options: [
        { value: "guided", label: "Guided", hint: "walk me through it (9 questions)" },
        { value: "quick", label: "Quick", hint: "starter templates with example content" },
        { value: "empty", label: "Empty", hint: "just the skeleton" },
      ],
    });

    if (p.isCancel(selected)) {
      p.cancel("Aborted.");
      process.exit(0);
    }

    fillLevel = selected as FillLevel;
  }

  // ── Step 3: Guided questions ─────────────────────────────────────────────

  const answers: GuidedAnswers = {};

  if (fillLevel === "guided") {
    p.log.step(pc.dim('You can type "skip" to leave any file as a template, or "done" to template all remaining files and move on.'));

    interface GuidedQuestion {
      key: keyof GuidedAnswers;
      context: string;
      message: string;
      suggestions: string[];
    }

    // Core questions are the same regardless of project stage
    const coreQuestions: GuidedQuestion[] = [
      {
        key: "values",
        context: `${pc.bold("core/values.md")} — This file is loaded on ${pc.underline("every")} agent invocation. It tells agents what your team considers "good enough" and what principles guide technical decisions. Keep it short — every token counts against the context budget.`,
        message: "What does your team value most?",
        suggestions: [
          "Simplicity over cleverness, ship incrementally, leave the codebase better",
          "Correctness first — measure twice, cut once, comprehensive tests",
          "Ship fast, iterate based on user feedback, pragmatic trade-offs",
        ],
      },
      {
        key: "rules",
        context: `${pc.bold("core/rules.md")} — Hard constraints agents must ${pc.underline("never")} violate. These are non-negotiable — if something is a preference rather than a rule, it belongs in values or conventions instead.`,
        message: "Any hard rules agents must follow?",
        suggestions: [
          "Never force push, never commit secrets, always run tests before proposing changes",
          "Never skip tests, never add deps without justification, always use conventional commits",
          "Never modify CI config, never delete production data, always preserve existing behavior",
        ],
      },
      {
        key: "voice",
        context: `${pc.bold("core/voice.md")} — Controls how agents communicate: code comments, commit messages, PR descriptions, and any text they produce. This shapes the "personality" of agent output.`,
        message: "How should agents communicate?",
        suggestions: [
          "Terse and direct — lead with the answer, no filler, no emojis",
          "Detailed and thorough — explain reasoning, include context, be explicit",
          "Casual but professional — conversational tone, conventional commits, concise PRs",
        ],
      },
    ];

    // Domain questions differ based on whether there's an existing codebase
    const domainQuestions: GuidedQuestion[] = isNewProject
      ? [
          {
            key: "techStack",
            context: `${pc.bold("domains/overview.md")} — Describe what you're building and what tech you plan to use. This helps agents make decisions that fit your vision from the start.`,
            message: "What are you building, and with what tech?",
            suggestions: [
              "A REST API with TypeScript, Express, and PostgreSQL via Drizzle",
              "A web app with React, Next.js, and a serverless backend",
              "A CLI tool in TypeScript, distributed via npm",
            ],
          },
          {
            key: "patterns",
            context: `${pc.bold("domains/conventions.md")} — This is the ${pc.underline("most important")} domain file. Define the conventions you want agents to follow from day one — naming, file structure, code patterns. Setting these early prevents style drift as the project grows.`,
            message: "What conventions do you want to establish?",
            suggestions: [
              "kebab-case files, camelCase functions, PascalCase types, controller-service separation",
              "Feature folders, co-located tests, barrel exports, strict TypeScript",
              "Flat src/ structure, functional style, no classes, minimal abstractions",
            ],
          },
          {
            key: "constraints",
            context: `${pc.bold("domains/constraints.md")} — Guardrails for agents. Even in a new project, there are things you know you want protected — like your CI config, certain dependencies, or deployment setup.`,
            message: "Anything agents should stay away from?",
            suggestions: [
              "CI/CD config, deployment scripts, don't add dependencies without asking",
              "Database migrations must be human-reviewed, never modify .env files",
              "No constraints yet — I'll add them as the project takes shape",
            ],
          },
          {
            key: "definitionOfDone",
            context: `${pc.bold("domains/definition-of-done.md")} — The commands agents must run to verify their work. Even for a new project, define what "done" looks like early. You can update this as your tooling evolves.`,
            message: "How will you verify work is done?",
            suggestions: [
              "npm run build && npm test && npm run lint",
              "cargo build && cargo test && cargo clippy",
              "Not set up yet — I'll define this once tooling is in place",
            ],
          },
          {
            key: "secrets",
            context: `${pc.bold("domains/environment.md")} — What external services will your project connect to? Swarm uses this so agents know what API keys and environment variables to set up. ${pc.yellow("Never put actual secret values here.")}`,
            message: "What services will you connect to?",
            suggestions: [
              "PostgreSQL (Neon), Anthropic API, maybe S3 for storage",
              "Supabase for auth + database, Vercel for hosting",
              "Not sure yet — I'll figure out services as I build",
            ],
          },
          {
            key: "secretSetup",
            context: `${pc.bold("domains/secrets.md")} — This file tells agents exactly where secrets live and how to set them up. It's loaded on every invocation so agents can verify secrets are configured before attempting builds. It's also the exclusion list for telemetry uploads.`,
            message: "How should agents find and set up secrets?",
            suggestions: [
              "Copy .env.example to .env and fill in values",
              "Copy Secrets.xcconfig.template to Secrets.xcconfig",
              "No secrets needed yet — I'll add them later",
            ],
          },
          {
            key: "goals",
            context: `${pc.bold("domains/goals.json")} — What's the first thing you want to build? Swarm's orchestrator will decompose this into tasks and dispatch agents to work on them.`,
            message: "What's your first goal?",
            suggestions: [
              "Set up project scaffolding: package.json, TypeScript config, linting, basic CI",
              "Build the core data model and database schema",
              "Create an MVP with authentication and one key feature",
            ],
          },
        ]
      : [
          {
            key: "techStack",
            context: `${pc.bold("domains/overview.md")} — Project facts that agents need to navigate your codebase: what it is, what tech it uses, how it's structured, and which files to read first.${projectInfo.language ? `\n  Auto-detected: ${pc.cyan(projectInfo.language)}${projectInfo.framework ? ` / ${pc.cyan(projectInfo.framework)}` : ""}${projectInfo.dependencies.length > 0 ? ` with ${projectInfo.dependencies.length} dependencies` : ""}` : ""}`,
            message: "Describe your tech stack",
            suggestions: [
              `${projectInfo.language ?? "TypeScript"}${projectInfo.framework ? `, ${projectInfo.framework}` : ""}, deployed on Vercel`,
              `${projectInfo.language ?? "TypeScript"} monorepo with shared packages`,
              `${projectInfo.language ?? "TypeScript"} backend with PostgreSQL and REST API`,
            ],
          },
          {
            key: "patterns",
            context: `${pc.bold("domains/conventions.md")} — This is the ${pc.underline("most important")} domain file. It teaches agents your naming conventions and code patterns so their output matches your existing style. Include copy-paste templates for common patterns (routes, services, tests, etc.).`,
            message: "What patterns and conventions matter most?",
            suggestions: [
              "Controller-service separation, kebab-case files, camelCase functions",
              "Feature modules with co-located tests, barrel exports, strict types",
              "Functional core / imperative shell, minimal OOP, composition over inheritance",
            ],
          },
          {
            key: "constraints",
            context: `${pc.bold("domains/constraints.md")} — Files and systems agents must not touch. Harder than conventions — violating these breaks things. Think: config files, CI pipelines, migration directories, protected branches.`,
            message: "What should agents never touch or change?",
            suggestions: [
              "migrations/, .github/workflows/, any config at the project root",
              "Auth middleware, database connection setup, deployment config",
              "Nothing specific — agents can touch anything as long as tests pass",
            ],
          },
          {
            key: "definitionOfDone",
            context: `${pc.bold("domains/definition-of-done.md")} — The exact commands an agent must run to verify its work. These must be copy-pasteable and return clear pass/fail. This is how swarm knows a task is actually complete.`,
            message: "How do you verify something is done?",
            suggestions: [
              "npm run build && npm test && npm run lint",
              "make check (runs build + test + lint + typecheck)",
              "cargo build && cargo test && cargo clippy",
            ],
          },
          {
            key: "secrets",
            context: `${pc.bold("domains/environment.md")} — Documents what API keys and secrets your project needs, where they come from, and where to set them. Swarm uses this so agents can configure the right environment. ${pc.yellow("Never put actual secret values here")} — only metadata.${projectInfo.envVars.length > 0 ? `\n  Detected from .env.example: ${pc.cyan(projectInfo.envVars.map(v => v.name).join(", "))}` : ""}`,
            message: "What services does your project connect to?",
            suggestions: projectInfo.envVars.length > 0
              ? [
                  `Detected: ${projectInfo.envVars.map(v => v.name).join(", ")}`,
                  "Those, plus additional services I'll describe",
                  "No secrets needed — everything runs locally",
                ]
              : [
                  "PostgreSQL, an LLM API (Anthropic/OpenAI), maybe object storage",
                  "Several third-party APIs — I'll list them",
                  "No external services — everything is self-contained",
                ],
          },
          {
            key: "secretSetup",
            context: `${pc.bold("domains/secrets.md")} — This file tells agents exactly where secrets live and how to set them up. It's loaded on every invocation so agents can verify secrets are configured before attempting builds. It's also the exclusion list for telemetry uploads.`,
            message: "How should agents find and set up secrets?",
            suggestions: projectInfo.envVars.length > 0
              ? [
                  "Copy .env.example to .env and fill in values",
                  "Secrets are already configured in my environment",
                  "I'll set up secret management later",
                ]
              : [
                  "Copy .env.example to .env and fill in values",
                  "Copy Secrets.xcconfig.template to Secrets.xcconfig",
                  "No secrets needed yet — I'll add them later",
                ],
          },
          {
            key: "goals",
            context: `${pc.bold("domains/goals.json")} — What you're currently working on. Swarm's orchestrator uses this to decompose work into tasks and dispatch agents. Each goal gets acceptance criteria so swarm knows when it's done.`,
            message: "What are you working on right now?",
            suggestions: [
              "Add a new feature (I'll describe it)",
              "Fix bugs and improve test coverage",
              "Refactor and modernize the codebase",
            ],
          },
        ];

    const questions = addDomainMode ? [...domainQuestions] : [...coreQuestions, ...domainQuestions];

    // Use index-based loop so we can go back
    let idx = 0;
    let done = false;
    const answeredValues: Record<string, string> = {}; // key → raw answer text

    while (idx < questions.length && !done) {
      const q = questions[idx];
      const questionNum = idx + 1;

      // Transition beat (skip on first question and when going back)
      if (questionNum > 1 && !answeredValues[q.key]) {
        const stopBeat = noAnimation ? null : startAnimation("Loading next question...");
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (stopBeat) stopBeat();
      }

      // Progress indicator + context
      const progress = pc.dim(`[${questionNum}/${questions.length}]`);
      console.log("");
      p.log.step(`${progress} ${q.context}`);
      console.log("");

      const previousAnswer = answeredValues[q.key];

      const result = await selectOrType({
        message: q.message,
        suggestions: q.suggestions,
        placeholder: 'type your own, or "skip" / "done" / "back"',
        initialValue: previousAnswer,
      });

      if (result.cancelled) {
        p.cancel("Aborted.");
        process.exit(0);
      }

      const trimmed = result.value.trim();

      if (trimmed.toLowerCase() === "back") {
        if (idx > 0) {
          idx--;
          p.log.info(pc.dim("Going back..."));
        } else {
          p.log.warn("Already at the first question.");
        }
        continue;
      }

      if (trimmed.toLowerCase() === "done") {
        done = true;
        p.log.info(pc.dim(`Templating remaining ${questions.length - questionNum} files.`));
        break;
      }

      if (trimmed.toLowerCase() !== "skip" && trimmed !== "") {
        answers[q.key] = trimmed;
        answeredValues[q.key] = trimmed;
        p.log.success(pc.dim("Saved."));
      } else {
        delete answers[q.key];
        delete answeredValues[q.key];
        p.log.info(pc.dim("Skipped — will use template."));
      }

      idx++;
    }

    // ── Review screen ─────────────────────────────────────────────────────
    // Show all answers and let the user edit any before proceeding

    let reviewing = true;
    while (reviewing) {
      const reviewLines: string[] = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const val = answeredValues[q.key];
        const label = q.message;
        if (val) {
          // Truncate long answers for the summary
          const display = val.length > 60 ? val.slice(0, 57) + "..." : val;
          reviewLines.push(`  ${pc.green("+")} ${pc.dim(`${i + 1}.`)} ${label} ${pc.cyan(display)}`);
        } else {
          reviewLines.push(`  ${pc.dim("-")} ${pc.dim(`${i + 1}.`)} ${label} ${pc.dim("(template)")}`);
        }
      }

      p.note(reviewLines.join("\n"), "Review your answers");

      const reviewAction = await p.select({
        message: "How does this look?",
        options: [
          { value: "continue", label: "Looks good — continue" },
          { value: "edit", label: "Edit an answer" },
        ],
      });

      if (p.isCancel(reviewAction)) {
        p.cancel("Aborted.");
        process.exit(0);
      }

      if (reviewAction === "continue") {
        reviewing = false;
      } else {
        // Let them pick which answer to edit
        const editOptions = questions.map((q, i) => ({
          value: String(i),
          label: `${i + 1}. ${q.message}`,
          hint: answeredValues[q.key]
            ? (answeredValues[q.key].length > 40
              ? answeredValues[q.key].slice(0, 37) + "..."
              : answeredValues[q.key])
            : "(template)",
        }));

        const editChoice = await p.select({
          message: "Which answer do you want to edit?",
          options: editOptions,
        });

        if (p.isCancel(editChoice)) {
          p.cancel("Aborted.");
          process.exit(0);
        }

        const editIdx = parseInt(editChoice as string, 10);
        const editQ = questions[editIdx];

        console.log("");
        p.log.message(editQ.context);
        console.log("");

        const editResult = await selectOrType({
          message: editQ.message,
          suggestions: editQ.suggestions,
          placeholder: 'type your own, or "skip" to clear',
          initialValue: answeredValues[editQ.key],
        });

        if (!editResult.cancelled) {
          const editTrimmed = editResult.value.trim();
          if (editTrimmed.toLowerCase() !== "skip" && editTrimmed !== "") {
            answers[editQ.key] = editTrimmed;
            answeredValues[editQ.key] = editTrimmed;
            p.log.success(pc.dim("Updated."));
          } else {
            delete answers[editQ.key];
            delete answeredValues[editQ.key];
            p.log.info(pc.dim("Cleared — will use template."));
          }
        }
      }
    }
  }

  // ── Step 4: Runtime backend (always asked) ───────────────────────────────

  const backendSelection = await p.select({
    message: "How will you run swarm?",
    options: [
      { value: "claude-code", label: "Claude Code", hint: "dispatches work via Claude Code CLI" },
      { value: "cursor", label: "Cursor", hint: "dispatches work via Cursor agent" },
      { value: "codex", label: "Codex", hint: "dispatches work via OpenAI Codex CLI" },
      { value: "direct-api", label: "Direct API", hint: "calls LLM APIs directly (swarm)" },
      { value: "undecided", label: "Not sure yet", hint: "I'll decide later" },
    ],
  });

  if (p.isCancel(backendSelection)) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  let backend = backendSelection as RuntimeBackend;
  let directApiProvider: "anthropic" | "openai" | undefined;

  // If Direct API, ask which provider
  if (backend === "direct-api") {
    const provider = await p.select({
      message: "Which LLM provider?",
      options: [
        { value: "anthropic", label: "Anthropic", hint: "Claude models" },
        { value: "openai", label: "OpenAI", hint: "GPT / o-series models" },
      ],
    });

    if (p.isCancel(provider)) {
      p.cancel("Aborted.");
      process.exit(0);
    }

    directApiProvider = provider as "anthropic" | "openai";
  }

  const preset = getBackendPreset(backend, directApiProvider);

  // API key check (skip for "undecided")
  let apiKeyDeferred = false;

  if (backend !== "undecided") {
    const keyStatus = await p.select({
      message: `Do you have your ${preset.apiKeyEnv} ready?`,
      options: [
        { value: "in-env", label: "Yes, it's in my environment" },
        { value: "enter-now", label: "Yes, I'll enter it now" },
        { value: "later", label: "No, I'll set it up later" },
      ],
    });

    if (p.isCancel(keyStatus)) {
      p.cancel("Aborted.");
      process.exit(0);
    }

    if (keyStatus === "in-env") {
      if (process.env[preset.apiKeyEnv]) {
        p.log.success(`${preset.apiKeyEnv} found in environment.`);
      } else {
        p.log.warn(`${preset.apiKeyEnv} not found in environment. Set it before running swarm.`);
        apiKeyDeferred = true;
      }
    } else if (keyStatus === "enter-now") {
      const key = await p.password({
        message: `Enter your ${preset.apiKeyEnv}:`,
      });

      if (p.isCancel(key)) {
        p.cancel("Aborted.");
        process.exit(0);
      }

      const keyValue = key as string;

      if (keyValue.trim()) {
        // Check .gitignore before writing to .env
        const gitignorePath = join(cwd, ".gitignore");
        let envGitignored = false;

        if (existsSync(gitignorePath)) {
          const gitignoreContent = readFileSync(gitignorePath, "utf-8");
          envGitignored = gitignoreContent.split("\n").some(
            (line) => line.trim() === ".env" || line.trim() === ".env*",
          );
        }

        if (!envGitignored) {
          const addToGitignore = await p.confirm({
            message: ".env is not in .gitignore. Add it before writing your key?",
          });

          if (p.isCancel(addToGitignore)) {
            p.cancel("Aborted.");
            process.exit(0);
          }

          if (addToGitignore) {
            appendFileSync(gitignorePath, "\n.env\n");
            p.log.success("Added .env to .gitignore.");
            envGitignored = true;
          }
        }

        if (envGitignored) {
          // Only write to .env if it's confirmed gitignored
          const envPath = join(cwd, ".env");
          const envLine = `${preset.apiKeyEnv}=${keyValue.trim()}\n`;

          if (existsSync(envPath)) {
            appendFileSync(envPath, envLine);
          } else {
            writeFileSync(envPath, envLine);
          }

          p.log.success(`Key written to .env`);
        } else {
          p.log.info(`Set your key manually:\n  export ${preset.apiKeyEnv}=...`);
          p.log.warn(`.env is not gitignored — key was NOT written to prevent accidental commit.`);
        }
      }
    } else {
      apiKeyDeferred = true;
    }
  } else {
    apiKeyDeferred = true;
  }

  // ── Step 5: Telemetry sharing ───────────────────────────────────────────

  let sharingEnabled = false;
  let shareLogs = false;
  let shareTrees = false;
  let shareContext = false;
  let shareTranscripts = false;
  let identityType: "github" | "anonymous" = "anonymous";
  let githubUsername: string | undefined;
  let telemetryId: string | undefined;

  const shareChoice = await p.confirm({
    message: "Share anonymous run data to help improve swarm?",
    initialValue: false,
  });

  if (!p.isCancel(shareChoice) && shareChoice) {
    sharingEnabled = true;

    const tiers = await p.multiselect({
      message: "What would you like to share? (space to toggle)",
      options: [
        { value: "logs", label: "Logs", hint: "telemetry events, checkpoint, grade report" },
        { value: "trees", label: "Tree snapshots", hint: "directory structure before/after run" },
        { value: "context", label: "Swarm context", hint: "goals, domain docs — secrets.md excluded" },
        { value: "transcripts", label: "Transcripts", hint: "full prompt/response pairs — may include sensitive content" },
      ],
      required: false,
    });

    if (!p.isCancel(tiers)) {
      const selected = tiers as string[];
      shareLogs = selected.includes("logs");
      shareTrees = selected.includes("trees");
      shareContext = selected.includes("context");
      shareTranscripts = selected.includes("transcripts");
    }

    const linkGithub = await p.confirm({
      message: "Link your GitHub account? (helps us correlate runs — not required)",
      initialValue: false,
    });

    if (!p.isCancel(linkGithub) && linkGithub) {
      try {
        const { execFileSync } = await import("node:child_process");
        const username = execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        if (username) {
          identityType = "github";
          githubUsername = username;
          p.log.success(`Linked as ${pc.cyan(username)}`);
        }
      } catch {
        p.log.warn("Could not read GitHub identity. Using anonymous ID.");
      }
    }

    if (identityType === "anonymous") {
      const { randomUUID } = await import("node:crypto");
      telemetryId = randomUUID();
    }
  }

  // ── Step 6: Tool detection + skill generation ────────────────────────────

  let selectedTools: string[] = [];

  if (!noSkill) {
    p.log.message(
      `${pc.bold("Skill file generation")} — Swarm can create a prompt/skill file that you paste into your existing AI tool (Claude Code, Cursor, etc.). That prompt will walk your LLM through scanning your codebase and filling in the swarm template files with real, project-specific content.\n\n  This is the fastest way to populate your swarm after scaffolding.`,
    );

    const tools = await p.multiselect({
      message: "Which AI tools do you use? (space to toggle, enter to confirm)",
      options: [
        { value: "claude-code", label: "Claude Code", hint: "creates .claude/commands/prepare-for-swarm.md" },
        { value: "cursor", label: "Cursor", hint: "creates .cursor/rules/prepare-for-swarm.mdc" },
        { value: "copilot", label: "GitHub Copilot", hint: "appends to .github/copilot-instructions.md" },
        { value: "universal", label: "Other / generate a prompt I can copy-paste", hint: "creates SWARM-PROMPT.md" },
      ],
      required: false,
    });

    if (p.isCancel(tools)) {
      p.cancel("Aborted.");
      process.exit(0);
    }

    selectedTools = (tools as string[]) ?? [];

    // If nothing selected, default to universal so the user always gets a skill file
    if (selectedTools.length === 0) {
      const generateAnyway = await p.confirm({
        message: "No tools selected. Generate a universal SWARM-PROMPT.md you can paste into any LLM?",
        initialValue: true,
      });

      if (!p.isCancel(generateAnyway) && generateAnyway) {
        selectedTools = ["universal"];
      }
    }
  }

  // ── Step 7: Scaffold ─────────────────────────────────────────────────────

  const stopAnim = noAnimation ? null : startAnimation("Scaffolding swarm...");
  const scaffoldStart = Date.now();

  const config: ScaffoldConfig = {
    projectName,
    outputDir,
    fillLevel: fillLevel!,
    backend,
    answers,
    directApiProvider,
    existingBehavior: existingBehavior ?? "error",
  };

  const result = await scaffold(config);

  // Ensure animation is visible for at least 1.5 seconds
  const elapsed = Date.now() - scaffoldStart;
  if (stopAnim && elapsed < 1500) {
    await new Promise((resolve) => setTimeout(resolve, 1500 - elapsed));
  }

  // Write telemetry sharing config
  if (sharingEnabled) {
    const sharingConfigPath = join(outputDir, "domains", projectName, "config.json");
    if (existsSync(sharingConfigPath)) {
      const configContent = JSON.parse(readFileSync(sharingConfigPath, "utf-8"));
      configContent.telemetry_sharing = {
        enabled: true,
        share_logs: shareLogs,
        share_trees: shareTrees,
        share_context: shareContext,
        share_transcripts: shareTranscripts,
        identity: identityType === "github"
          ? { type: "github", github_username: githubUsername }
          : { type: "anonymous", telemetry_id: telemetryId },
      };
      writeFileSync(sharingConfigPath, JSON.stringify(configContent, null, 2) + "\n");
    }
  }

  // Generate skill files
  const skillFilesCreated: string[] = [];
  for (const tool of selectedTools) {
    const skill = getSkillTemplate(
      tool as "claude-code" | "cursor" | "copilot" | "universal",
      projectName,
      addDomainMode,
    );
    const skillPath = join(cwd, skill.path);
    const skillDir = join(skillPath, "..");

    if (!existsSync(skillDir)) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(skillDir, { recursive: true });
    }

    if (tool === "copilot" && existsSync(skillPath)) {
      // Append with markers
      const existing = readFileSync(skillPath, "utf-8");
      if (!existing.includes("<!-- swarm:begin -->")) {
        appendFileSync(skillPath, `\n\n<!-- swarm:begin -->\n${skill.content}\n<!-- swarm:end -->\n`);
        skillFilesCreated.push(skill.path);
      }
    } else {
      writeFileSync(skillPath, skill.content);
      skillFilesCreated.push(skill.path);
    }
  }

  // Write .swarm-meta.json — tracks what was created for clean uninstall
  try {
    const meta: SwarmMeta = {
      created_at: new Date().toISOString(),
      version: VERSION,
      project_name: projectName,
      skill_files: skillFilesCreated,
    };
    writeFileSync(join(outputDir, ".swarm-meta.json"), JSON.stringify(meta, null, 2) + "\n");
  } catch {
    // Non-fatal — uninstall will fall back to checking known paths
  }

  if (stopAnim) stopAnim();

  // --- Database setup ---
  const { runDbSetup } = await import("./db.js");
  const dbResult = await runDbSetup();

  // If database was set up (Docker or connection string), start sidecar and seed swarm content.
  // Quiet=true: sidecar status messages shouldn't appear during the interactive init flow.
  if (dbResult.mode !== "file") {
    await startSidecarAndSeed(dbResult.mode, outputDir, projectName, true);
  }

  // Check for Figma URLs without Figma MCP
  const designsDir = join(outputDir, "designs");
  if (existsSync(designsDir)) {
    try {
      const designFiles = readdirSync(designsDir);
      const hasFigma = designFiles.some(f => f.endsWith(".figma.url"));
      if (hasFigma) {
        const configPath = join(outputDir, "domains", projectName, "config.json");
        let hasFigmaMcp = false;
        if (existsSync(configPath)) {
          try {
            const configObj = JSON.parse(readFileSync(configPath, "utf-8"));
            hasFigmaMcp = !!configObj.backends?.worker?.mcpServers?.figma;
          } catch {
            // Ignore parse errors
          }
        }
        if (!hasFigmaMcp) {
          p.log.warn(`Figma URL found in designs/ but Figma MCP not configured. Run: ${pc.cyan("swarm add mcp figma")}`);
        }
      }
    } catch {
      // Ignore errors reading designs directory
    }
  }

  // ── Step 8: Summary ──────────────────────────────────────────────────────

  console.log("");

  // Count files by directory
  const counts: Record<string, number> = {};
  for (const f of result.filesCreated) {
    const dir = f.split("/")[0] ?? "root";
    counts[dir] = (counts[dir] ?? 0) + 1;
  }

  const summary = [
    `${pc.green("core/")}           ${counts["core"] ?? 0} files`,
    `${pc.green("modes/")}          ${counts["modes"] ?? 0} files`,
    `${pc.green("capabilities/")}   ${counts["capabilities"] ?? 0} files`,
    `${pc.green("domains/")}        ${counts["domains"] ?? 0} files`,
    `${pc.green("designs/")}        ${counts["designs"] ?? 0} files`,
    `${pc.green("oversight/")}      ${counts["oversight"] ?? 0} files`,
    `${pc.green("skills/")}         0 installed ${pc.dim("(run npx skills add to browse)")}`,
  ].join("\n  ");

  if (addDomainMode) {
    // Migrate swarm.json routes from hardcoded domain paths to {project} placeholders
    // so the router loads the correct domain files for any --project value.
    const swarmJsonPath = join(outputDir, "swarm.json");
    if (existsSync(swarmJsonPath)) {
      let swarmJsonContent = readFileSync(swarmJsonPath, "utf-8");
      // Match any "domains/<hardcoded-name>/" and replace with "domains/{project}/"
      const hardcodedPattern = /"domains\/[a-zA-Z0-9_-]+\//g;
      if (hardcodedPattern.test(swarmJsonContent) && !swarmJsonContent.includes("domains/{project}/")) {
        swarmJsonContent = swarmJsonContent.replace(/"domains\/[a-zA-Z0-9_-]+\//g, '"domains/{project}/');
        writeFileSync(swarmJsonPath, swarmJsonContent);
        p.log.info(`Updated swarm.json routes to use ${pc.cyan("{project}")} placeholder`);
      }
    }
    p.log.success(`New domain added at ${pc.cyan(join(outputDir, "domains", projectName))}`);
  } else {
    p.log.success(`Swarm scaffolded at ${pc.cyan(outputDir)}\n  ${summary}`);
  }

  for (const warning of result.warnings) {
    p.log.warn(warning);
  }

  // Design files hint
  if (result.filesCreated.some(f => f.startsWith("designs/"))) {
    p.log.info(`${pc.bold("Design files:")} Drop mockups, screenshots, or Figma URLs into ${pc.cyan(".swarm/designs/")} and reference them in goals.json`);
  }

  // Next steps
  const nextSteps: string[] = [];

  if (skillFilesCreated.length > 0) {
    p.log.info(`Skill files created:\n  ${skillFilesCreated.map((f) => pc.cyan(f)).join("\n  ")}`);

    // Show what the skill file will do — demystify it
    const fileCount = result.filesCreated.length;
    const domainFiles = result.filesCreated.filter((f) => f.startsWith("domains/"));

    const skillExplanation = isNewProject
      ? [
          `When you give this prompt to your AI assistant, it will:`,
          ``,
          `  1. ${pc.bold("Ask about your vision")} — what you're building, tech choices, standards`,
          `  2. ${pc.bold("Draft content")} for each of the ${fileCount} swarm files, one at a time`,
          `  3. ${pc.bold("Ask for your approval")} before writing anything`,
          `  4. ${pc.bold("Stop when you say")} "done" — remaining files stay as templates`,
          ``,
          `Since you're starting fresh, it focuses on ${pc.bold("what you want")} rather than`,
          `what already exists. It starts with the ${domainFiles.length} domain files, then core,`,
          `then modes, then capabilities. You stay in control the whole time.`,
          ``,
          `${pc.dim("The prompt itself is readable markdown — open it to see exactly what it says.")}`,
        ]
      : [
          `When you give this prompt to your AI assistant, it will:`,
          ``,
          `  1. ${pc.bold("Scan your codebase")} — read your source files, configs, and structure`,
          `  2. ${pc.bold("Propose content")} for each of the ${fileCount} swarm files, one at a time`,
          `  3. ${pc.bold("Ask for your approval")} before writing anything`,
          `  4. ${pc.bold("Stop when you say")} "done" — remaining files stay as templates`,
          ``,
          `It starts with the ${domainFiles.length} domain files (most valuable), then core,`,
          `then modes, then capabilities. You stay in control the whole time.`,
          ``,
          `${pc.dim("The prompt itself is readable markdown — open it to see exactly what it says.")}`,
        ];

    p.note(skillExplanation.join("\n"), "What the skill file does");

    const firstSkill = skillFilesCreated[0];
    if (firstSkill?.includes(".claude")) {
      nextSteps.push(`${pc.bold("Populate your swarm:")} Run ${pc.cyan("/prepare-for-swarm")} in Claude Code`);
    } else if (firstSkill?.includes("SWARM-PROMPT")) {
      nextSteps.push(`${pc.bold("Populate your swarm:")} Open ${pc.cyan("SWARM-PROMPT.md")} and paste it into your AI`);
    } else {
      nextSteps.push(`${pc.bold("Populate your swarm:")} Use the generated skill file with your AI tool`);
    }
  } else {
    nextSteps.push(`Edit the files in ${pc.cyan(outputDir)} to customize your swarm`);
  }

  if (apiKeyDeferred) {
    const providerUrl = preset.provider === "anthropic"
      ? "https://console.anthropic.com/settings/keys"
      : "https://platform.openai.com/api-keys";
    nextSteps.push(`Set your API key: ${pc.cyan(`export ${preset.apiKeyEnv}=...`)}\n    Get one at: ${pc.dim(providerUrl)}`);
  }

  if (fromSwarm) {
    nextSteps.push(`When ready: ${pc.cyan(`swarm run --swarm-path ${outputDir} --project ${projectName}`)}`);
  } else {
    nextSteps.push(`When ready: ${pc.cyan(`swarm run --project ${projectName}`)}`);
  }

  p.note(nextSteps.join("\n  "), "Next steps");

  p.outro(pc.green("Done!"));
}
