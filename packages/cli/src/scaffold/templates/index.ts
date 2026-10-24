/**
 * Swarm scaffold templates as TypeScript string constants.
 *
 * Avoids file-reading at runtime and works with Bun compilation.
 * Template placeholders: {project}, {timestamp}
 */

export const TEMPLATES = {
  // ---------------------------------------------------------------------------
  // Layer 1 — Core (always loaded)
  // ---------------------------------------------------------------------------

  "core/values.md": `# Values

<!-- These values define your team's quality bar. The swarm loads this file on every invocation. Keep it short — every token counts against the context budget. Target: ~500 tokens. -->

## Quality Bar

- Code compiles clean with zero warnings.
- All existing tests pass before and after changes.
- No known vulnerabilities introduced.
- Changes are reviewable in a single sitting.

## Principles

<!-- Add 3-5 engineering principles your team actually follows. Delete the examples and write your own. -->

- **Simplicity over cleverness.** If a junior engineer cannot read it, rewrite it.
- **Ship incrementally.** Prefer three small PRs over one large one.
- **Leave it better.** If you touch a file, leave it cleaner than you found it.
- **Measure before optimizing.** No performance work without a benchmark showing the problem.
`,

  "core/rules.md": `# Rules

<!-- Hard constraints. Agents must never violate these. Keep this list short and non-negotiable. Target: ~400 tokens. -->

## Never Do

- Never force push to main or any shared branch.
- Never commit secrets, API keys, or credentials to the repository.
- Never delete production data without explicit human approval.
- Never skip tests to unblock a merge.
- Never merge code that does not compile.
- Never leave spawned processes running after your task completes. This includes test runners (vitest, jest, playwright), dev servers (vite, next dev), and any background process you started. An orphaned process is a bug you shipped.

## Always Do

- Run the full test suite before opening a PR.
- Use conventional commit messages (\`feat:\`, \`fix:\`, \`test:\`, \`chore:\`, \`docs:\`).
- Preserve existing functionality unless explicitly told to change it.
- Add tests for new behavior.
- Request review for changes touching security-sensitive code.
- Kill all processes you spawned before exiting. Use process-group kills (\`pkill -P $PID\`) to catch child processes and worker threads, not just the parent. Verify with \`pgrep\` that nothing survives.
`,

  "core/voice.md": `# Voice

<!-- How agents should communicate when writing comments, commit messages, and PR descriptions. Target: ~400 tokens. -->

## Tone

- Concise and technical. No filler words.
- No emojis in code, comments, or commit messages.
- Direct statements over hedging. Say "this causes a memory leak" not "this might potentially cause issues."
- Use active voice. "This function validates input" not "Input is validated by this function."

## Code Comments

- Explain why, not what. The code shows what — comments explain the reasoning.
- No obvious comments. \`// increment counter\` above \`counter++\` is noise.
- Document non-obvious constraints, edge cases, and workarounds.

## Commit Messages

- Follow conventional commits: \`type(scope): description\`
- Keep the subject line under 72 characters.
- Explain why in the body, not what changed — the diff shows what changed.
- Reference issue numbers when applicable.
`,

  // ---------------------------------------------------------------------------
  // Layer 2 — Modes (loaded by intent classification)
  // ---------------------------------------------------------------------------

  "modes/code-review.md": `# Mode: Code Review

<!-- Loaded when the swarm classifies intent as "code-review". Defines how agents review pull requests and diffs. Target: ~600 tokens. -->

## Review Priority

Review in this order. Stop at the first category with issues — do not nitpick style if there are correctness problems.

1. **Correctness** — Does the code do what it claims? Are there logic errors, off-by-ones, race conditions?
2. **Security** — Are there injection risks, hardcoded secrets, missing auth checks, unsafe deserialization?
3. **Conventions** — Does it follow the project's patterns? Naming, file structure, error handling?
4. **Clarity** — Can another engineer understand this without asking questions?
5. **Scope** — Does the PR do one thing? Flag scope creep.

## What NOT to Do

- Do not rewrite the author's code in your preferred style.
- Do not suggest changes unrelated to the PR's purpose.
- Do not approve with "LGTM" — state what you verified.
- Do not block on subjective preferences. Reserve blocking feedback for correctness and security.

## Output Format

For each issue found:
- State the file and line range.
- Describe the problem in one sentence.
- Suggest a fix or ask a clarifying question.
- Classify severity: \`blocking\`, \`suggestion\`, or \`nit\`.
`,

  "modes/implementation.md": `# Mode: Implementation

<!-- Loaded when the swarm classifies intent as "implementation". Defines how agents build features and fix bugs. Target: ~600 tokens. -->

## Approach

1. **Understand the request.** Restate the goal before writing code.
2. **Check existing patterns.** Look at how similar features are implemented in the codebase. Follow the same patterns.
3. **Make the smallest change that works.** Do not refactor unrelated code. Do not add features not asked for.
4. **Test your changes.** Write tests for new behavior. Run existing tests to verify nothing breaks. Always run test commands in non-watch mode (\`vitest run\`, \`jest --watchAll=false\`).
5. **Verify the build.** Ensure the project compiles and all checks pass.
6. **Clean up processes.** Before committing or reporting completion, kill every process you spawned (test runners, dev servers, build watchers). Verify with \`pgrep\` that nothing remains. This is not optional.

## Code Quality

- Follow the project's existing conventions for naming, file organization, and error handling.
- Handle errors explicitly. No swallowed exceptions.
- Prefer composition over inheritance.
- Keep functions under 30 lines. Extract when logic is reusable or complex.

## Testing

- Test behavior, not implementation details.
- Cover the happy path, one error path, and one edge case at minimum.
- Use the project's existing test framework and patterns.
- Name tests descriptively: \`should reject expired tokens\` not \`test1\`.
`,

  "modes/investigation.md": `# Mode: Investigation

<!-- Loaded when the swarm classifies intent as "investigation". Defines how agents debug issues and research topics. Target: ~500 tokens. -->

## Approach

1. **Reproduce the problem.** Find the exact steps or inputs that trigger the issue.
2. **Read the error.** Parse stack traces, error messages, and logs before hypothesizing.
3. **Form a hypothesis.** State what you think is wrong and why, based on evidence.
4. **Test the hypothesis.** Make one change, observe the result. Do not change multiple things at once.
5. **Revert if wrong.** If a change does not fix the issue, undo it before trying the next hypothesis.

## What to Report

- The root cause (not just the symptom).
- The evidence that confirms the root cause.
- The fix, or a recommendation if the fix requires human judgment.
- Whether the issue could recur and how to prevent it.

## What NOT to Do

- Do not guess and commit. If you are not confident, say so.
- Do not make unrelated changes while investigating.
- Do not ignore warnings or deprecation notices encountered during investigation — note them.
`,

  // ---------------------------------------------------------------------------
  // Layer 3 — Capabilities (loaded when route specifies)
  // ---------------------------------------------------------------------------

  "modes/orchestration.md": `# Mode: Orchestration

<!-- Loaded when the swarm classifies intent as "orchestration". Defines how agents coordinate multi-task execution toward project goals. Target: ~600 tokens. -->

## Approach

1. **Decompose the goal.** Break it into independent, parallelizable tasks. Each task must be completable in a single worktree session.
2. **Dispatch workers.** Assign tasks to worktree agents with clear acceptance criteria. Include the relevant domain context.
3. **Track progress.** Monitor task completion, handle failures, and escalate blockers.
4. **Merge results.** Integrate completed worktrees back to the target branch. Resolve conflicts.
5. **Verify the whole.** After all tasks merge, run the full build and test suite on the integrated branch.

## Worktree Lifecycle

Every worktree agent MUST follow this lifecycle:

1. **Create** — Branch from the target, install dependencies.
2. **Execute** — Do the work, run tests.
3. **Cleanup** — Kill ALL spawned processes before exiting. This is mandatory. Use process-group kills (\`pkill -P $PID\`) to catch child processes and worker threads. Verify with \`pgrep\` that nothing survives.
4. **Commit** — Stage and commit with a conventional commit message.
5. **Report** — Return status to orchestrator.

A worktree agent that exits without killing its processes has failed, even if the code is correct.

## Concurrency Limits

- Do not dispatch more worktree agents than the machine can handle. Default: 4 concurrent worktrees.
- Each worktree may spawn test runners with multiple worker threads. Account for this when sizing concurrency.
- If a task requires a dev server, it counts as 2 concurrency slots.

## What NOT to Do

- Do not execute tasks yourself. You are a coordinator, not a worker.
- Do not dispatch tasks that depend on each other in parallel. Sequence dependencies.
- Do not ignore failed tasks. Either retry, reassign, or escalate.
- Do not merge a worktree without confirming the worker killed its processes.
`,

  "capabilities/git-workflow.md": `# Capability: Git Workflow

<!-- Loaded when the route includes git-related work. Target: ~400 tokens. -->

## Branching

- Create feature branches from main: \`feat/short-description\`
- Create fix branches from main: \`fix/short-description\`
- Never commit directly to main.

## Commits

- Use conventional commits: \`feat:\`, \`fix:\`, \`test:\`, \`chore:\`, \`docs:\`
- One logical change per commit.
- Write the subject in imperative mood: "add validation" not "added validation."

## Pull Requests

- One concern per PR. If you are fixing a bug and refactoring, make two PRs.
- Title: concise summary under 72 characters.
- Description: what changed and why. Link the issue if one exists.
- Request review before merging.
`,

  "capabilities/testing.md": `# Capability: Testing

<!-- Loaded when the route includes testing guidance. Target: ~400 tokens. -->

## What to Test

- Public API surface — every exported function or method.
- Edge cases — empty inputs, boundary values, null/undefined.
- Integration points — database queries, API calls, file I/O.
- Error paths — what happens when dependencies fail.

## How to Test

- **Arrange, Act, Assert.** Set up state, perform the action, verify the result.
- Test behavior, not implementation. Assert on outputs and side effects, not internal state.
- Use descriptive test names that read as sentences.
- Keep tests independent. No test should depend on another test's state.

## When to Skip

- Pure UI layout with no logic (manual review is more effective).
- Generated code that is never manually edited.
- Vendored third-party code.
`,

  // ---------------------------------------------------------------------------
  // Layer 4 — Domain (project-specific, loaded per project)
  // ---------------------------------------------------------------------------

  "domains/{project}/overview.md": `# {project}

<!-- Project overview. This is the first file agents read about your project. Keep it factual and current. Target: ~600 tokens. -->

## What This Is

<!-- One paragraph describing what this project does and who uses it. -->

{project} is a project. Describe its purpose, users, and core value proposition here.

## Tech Stack

<!-- List the primary technologies. Be specific about versions when they matter. -->

| Layer | Technology |
|---|---|
| Language | TypeScript 5.x |
| Runtime | Node.js 20+ |
| Framework | Express 4.x |
| Database | PostgreSQL 16 |
| ORM | Drizzle |
| Testing | Vitest |

## Project Structure

<!-- Show the top-level directory layout. Keep it to the most important directories. -->

\`\`\`
src/
\u251C\u2500\u2500 routes/        # HTTP route handlers
\u251C\u2500\u2500 services/      # Business logic
\u251C\u2500\u2500 models/        # Data models and schemas
\u251C\u2500\u2500 middleware/    # Express middleware
\u2514\u2500\u2500 utils/         # Shared utilities
tests/
\u251C\u2500\u2500 unit/
\u2514\u2500\u2500 integration/
\`\`\`

## Key Files

<!-- List the 5-10 most important files an agent should know about. -->

- \`src/routes/index.ts\` — Route registration
- \`src/services/auth.ts\` — Authentication logic
- \`src/models/schema.ts\` — Database schema definitions
- \`package.json\` — Dependencies and scripts
`,

  "domains/{project}/architecture.md": `# {project} — Architecture

<!-- How the system is structured internally. Target: ~600 tokens. -->

## Data Flow

<!-- Describe the request lifecycle or main data flow through the system. Use a simple diagram if helpful. -->

\`\`\`
Request \u2192 Middleware \u2192 Router \u2192 Service \u2192 Database
                                      \u2193
                                  Response
\`\`\`

## Patterns

<!-- Document the architectural patterns used in this project. -->

- **Service layer pattern.** Routes delegate to services. Services contain business logic. Routes handle HTTP concerns only.
- **Repository pattern.** Database access is abstracted behind repository functions. Services never write raw SQL.
- **Dependency injection.** Services receive their dependencies as constructor parameters or function arguments.

## Import Rules

<!-- Constraints on what can import what. Prevents circular dependencies and enforces layer boundaries. -->

- Routes may import services and middleware. Routes must not import other routes.
- Services may import models and utilities. Services must not import routes or middleware.
- Models must not import anything from routes or services.
`,

  "domains/{project}/conventions.md": `# {project} — Conventions

<!-- Naming, formatting, and structural patterns for this project. Target: ~600 tokens. -->

## Naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | \`user-profile.ts\` |
| Functions | camelCase | \`getUserProfile()\` |
| Classes | PascalCase | \`UserProfileService\` |
| Constants | SCREAMING_SNAKE | \`MAX_RETRY_COUNT\` |
| DB Tables | snake_case | \`user_profiles\` |
| DB Columns | snake_case | \`created_at\` |
| Env Vars | SCREAMING_SNAKE | \`DATABASE_URL\` |

## Code Templates

<!-- Examples of the canonical way to write common patterns in this project. Agents should follow these. -->

### Route Handler

\`\`\`typescript
router.get("/users/:id", async (req, res) => {
  const user = await userService.getById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json(user);
});
\`\`\`

### Service Method

\`\`\`typescript
export async function getById(id: string): Promise<User | null> {
  const result = await db.select().from(users).where(eq(users.id, id));
  return result[0] ?? null;
}
\`\`\`
`,

  "domains/{project}/constraints.md": `# {project} — Constraints

<!-- Hard limits and protected areas in this project. Target: ~400 tokens. -->

## Protected Files

<!-- Files that agents must not modify without explicit instruction. -->

- \`package-lock.json\` — Only modify via \`npm install\`. Never edit manually.
- \`.env\` — Contains secrets. Never commit. Never read values into swarm files.
- \`migrations/\` — Never modify existing migrations. Create new ones to alter the schema.

## Runtime Constraints

<!-- Performance and resource limits agents should be aware of. -->

- API response time must stay under 500ms for all endpoints.
- Database queries must not perform full table scans on tables over 10,000 rows.
- File uploads are limited to 10MB.

## Dependency Rules

<!-- Constraints on adding or modifying dependencies. -->

- Do not add new dependencies without checking for existing alternatives in the project.
- Prefer packages with TypeScript types included (no \`@types/\` needed).
- Security-sensitive packages (crypto, auth, parsing) require human approval before adding.
`,

  "domains/{project}/definition-of-done.md": `# {project} — Definition of Done

<!-- What "done" means for a task in this project. Agents check these before marking work complete. Target: ~300 tokens. -->

## Build

\`\`\`bash
npm run build
# Must exit 0 with no TypeScript errors
\`\`\`

## Test

\`\`\`bash
npm test
# Must exit 0 with all tests passing
\`\`\`

## Lint

\`\`\`bash
npm run lint
# Must exit 0 with no errors (warnings acceptable)
\`\`\`

## Type Check

\`\`\`bash
npx tsc --noEmit
# Must exit 0 with no type errors
\`\`\`

## Manual Verification

<!-- Add any manual steps that must be completed before considering a task done. -->

- The feature works as described in the task requirements.
- No regressions in existing functionality.
- Commit messages follow conventional commit format.
`,

  "domains/{project}/environment.md": `# {project} — Environment

<!-- Environment variables, secrets, and setup instructions. Target: ~500 tokens. -->

## Secret Storage

<!-- Where secrets are stored and how to access them. NEVER write actual secret values into swarm files. -->

Secrets are stored in environment variables. For local development, use a \`.env\` file (gitignored). For production, use your platform's secret management (e.g., AWS Secrets Manager, Vercel env vars).

## Required Variables

| Variable | Purpose | Example Format |
|---|---|---|
| \`DATABASE_URL\` | PostgreSQL connection string | \`postgresql://user:pass@host:5432/db\` |
| \`ANTHROPIC_API_KEY\` | Anthropic API access | \`sk-ant-...\` |
| \`JWT_PRIVATE_KEY\` | Token signing key | Base64-encoded RSA key |

## Optional Variables

| Variable | Purpose | Default |
|---|---|---|
| \`PORT\` | HTTP server port | \`3000\` |
| \`LOG_LEVEL\` | Logging verbosity | \`info\` |
| \`NODE_ENV\` | Runtime environment | \`development\` |

## Setup Instructions

\`\`\`bash
# 1. Clone the repository
git clone <repo-url>
cd {project}

# 2. Install dependencies
npm install

# 3. Copy environment template
cp .env.example .env

# 4. Fill in secret values (ask a team member for access)

# 5. Run database migrations
npm run migrate

# 6. Start development server
npm run dev
\`\`\`
`,

  "domains/{project}/goals.json": `{
  "goals": [
    {
      "id": "goal-1",
      "description": "Describe your first goal here",
      "priority": 1,
      "status": "pending",
      "acceptance_criteria": [
        "Criterion 1: What must be true when this goal is complete",
        "Criterion 2: Another measurable outcome"
      ],
      "constraints": []
    },
    {
      "id": "goal-2",
      "description": "Clean up and finalize",
      "priority": 2,
      "status": "pending",
      "dependsOn": ["goal-1"],
      "acceptance_criteria": [
        "All previous goals' acceptance criteria still pass"
      ],
      "constraints": []
    }
  ]
}`,

  "domains/{project}/config.json": `{
  "project": "{project}",
  "swarm_path": ".swarm",
  "trust_level": "medium",
  "concurrency": {
    "max_workers": 3,
    "max_tokens_per_session": 60000000,
    "max_tokens_per_goal": 20000000,
    "max_tokens_per_task": 6000000
  },
  "task_backend": "local",
  "models": {
    "worker": "claude-sonnet-4-6",
    "reviewer": "claude-sonnet-4-6",
    "arbiter": "claude-opus-4-6",
    "provider": "anthropic"
  },
  "backends": {
    "worker": {
      "type": "claude-code",
      "fallback": "api"
    },
    "reviewer": {
      "type": "claude-code",
      "fallback": "api"
    },
    "arbiter": {
      "type": "claude-code",
      "fallback": "api"
    }
  },
  "base_branch": "main",
  "isolation": null,
  "created": "{timestamp}"
}`,

  // ---------------------------------------------------------------------------
  // Oversight
  // ---------------------------------------------------------------------------

  "oversight/review-policy.json": `{
  "oversight": {
    "roles": {
      "worker": {
        "description": "Executes tasks using swarm files.",
        "default_model": "claude-sonnet-4-6",
        "can_modify": ["source code", "documentation", "config files"],
        "cannot_modify": ["swarm/", "tests/", "oversight/", "telemetry/schema/"],
        "max_retries": 3,
        "exit_requirements": [
          "All spawned processes (test runners, dev servers, build watchers) must be terminated before task completion",
          "Use process-group kills to catch child processes and worker threads",
          "Verify with pgrep that no orphaned processes remain in the worktree"
        ]
      },
      "reviewer": {
        "description": "Evaluates worker output against swarm expectations. Separate context window.",
        "default_model": "claude-sonnet-4-6",
        "additional_context": ["tests/behavioral/{mode}/*.json"],
        "checks": [
          "output_conforms_to_mode_expectations",
          "no_restricted_file_modifications",
          "test_assertions_pass",
          "scope_matches_original_request",
          "no_orphaned_processes"
        ]
      },
      "arbiter": {
        "description": "Resolves disagreements between worker and reviewer. Can escalate to human.",
        "default_model": "claude-opus-4-6",
        "triggers": [
          "reviewer_rejects_after_max_retries",
          "worker_attempts_restricted_modification",
          "confidence_below_threshold"
        ],
        "can_escalate_to": "human"
      },
      "orchestrator": {
        "description": "Plans and dispatches tasks toward project goals. Does not execute tasks.",
        "default_model": "claude-opus-4-6",
        "can_modify": [],
        "cannot_modify": ["swarm/", "tests/", "oversight/", "telemetry/schema/", "source code"],
        "responsibilities": [
          "goal decomposition into ordered tasks",
          "task dispatch with trust-appropriate directives",
          "progress tracking and status updates",
          "human escalation on blocked goals or token limits",
          "concurrency management per trust level"
        ],
        "always_review": ["scope_expansion", "task_token_exceeded", "constraint_violation"],
        "can_escalate_to": "human"
      }
    },

    "sub_task_policy": {
      "description": "Sub-decomposed tasks always inherit the parent task's review requirements from its dispatch directive. Sub-tasks are never less reviewed than their parent."
    },

    "review_policy": {
      "always_review": [
        "changes to production config",
        "database migrations",
        "security-related code",
        "changes to CI/CD pipeline",
        "dependency additions or upgrades"
      ],
      "review_if_large": {
        "files_changed_threshold": 5,
        "lines_changed_threshold": 200
      },
      "skip_review": [
        "documentation-only changes",
        "comment additions",
        "test-only changes with no production code"
      ]
    },

    "disagreement_protocol": {
      "minor": {
        "description": "Style, naming, minor improvements.",
        "action": "auto_retry_with_feedback",
        "max_attempts": 2
      },
      "moderate": {
        "description": "Logic concerns, missing tests, scope questions.",
        "action": "arbiter_review",
        "max_attempts": 1
      },
      "severe": {
        "description": "Security issues, restricted file access, repeated failures.",
        "action": "human_escalation",
        "max_attempts": 0
      }
    }
  }
}`,

  // ---------------------------------------------------------------------------
  // Router manifest
  // ---------------------------------------------------------------------------

  "swarm.json": `{
  "version": "0.1.0",
  "description": "Swarm router manifest. Agents read this first to determine what context to load.",

  "context_budget": {
    "description": "Maximum swarm-file tokens to load per invocation. Prevents context window degradation.",
    "default_max_tokens": 15000,
    "model_overrides": {
      "claude-opus-4-6": 20000,
      "claude-sonnet-4-6": 14000
    },
    "loading_priority": [
      { "tier": "core", "required": true, "description": "Always loaded. Non-negotiable." },
      { "tier": "secrets", "required": false, "description": "Secret locations and setup instructions. Loaded on every invocation when present." },
      { "tier": "mode", "required": true, "description": "Behavioral context for the classified intent." },
      { "tier": "oversight", "required": true, "description": "Review policy for the session." },
      { "tier": "capabilities", "required": false, "description": "Loaded if relevant and budget allows." },
      { "tier": "domain", "required": false, "description": "Project-specific context." },
      { "tier": "skills_vetted", "required": false, "description": "Reviewed third-party knowledge." },
      { "tier": "skills_community", "required": false, "description": "Reference only. Not auto-loaded." }
    ]
  },

  "complexity": {
    "description": "Unitless 0-100 score of a task's wording: simple (<=simple_max), moderate (between), complex (>=complex_min). The band sets the task's timeout. Whether a task is split into sub-tasks is the project's decomposition policy (config.json decomposition.sub_decompose): under auto, the default, complex tasks are split before they run and moderate ones get a standby split. escalation: fractions of a moderate task's token, turn and time limits at which it is split, when splitting on failure is allowed.",
    "simple_max": 30,
    "complex_min": 61,
    "escalation": {
      "token_fraction": 0.5,
      "turn_fraction": 0.7,
      "timeout_fraction": 0.6
    }
  },

  "routes": [
    {
      "intent": "code-review",
      "description": "Review code changes for quality, conventions, and correctness.",
      "load": {
        "core": ["core/values.md", "core/rules.md", "core/voice.md"],
        "mode": ["modes/code-review.md"],
        "oversight": ["oversight/review-policy.json"],
        "capabilities": ["capabilities/git-workflow.md"],
        "domain": ["domains/{project}/conventions.md", "domains/{project}/constraints.md"]
      },
      "keywords": ["review", "PR", "pull request", "code review", "check this", "look at this diff"]
    },
    {
      "intent": "implementation",
      "description": "Build a feature or fix a bug.",
      "load": {
        "core": ["core/values.md", "core/rules.md", "core/voice.md"],
        "mode": ["modes/implementation.md"],
        "oversight": ["oversight/review-policy.json"],
        "capabilities": ["capabilities/git-workflow.md", "capabilities/testing.md"],
        "domain": ["domains/{project}/architecture.md", "domains/{project}/conventions.md", "domains/{project}/constraints.md", "domains/{project}/overview.md"]
      },
      "keywords": ["build", "implement", "create", "fix", "feature", "bug", "add"]
    },
    {
      "intent": "investigation",
      "description": "Debug an issue or research a topic.",
      "load": {
        "core": ["core/values.md", "core/rules.md"],
        "mode": ["modes/investigation.md"],
        "oversight": ["oversight/review-policy.json"],
        "capabilities": [],
        "domain": ["domains/{project}/architecture.md", "domains/{project}/constraints.md", "domains/{project}/overview.md"]
      },
      "keywords": ["debug", "investigate", "why", "broken", "error", "failing", "research", "understand"]
    },
    {
      "intent": "onboarding",
      "description": "Initialize the swarm for a new project. Generate domain context and goals.",
      "load": {
        "core": ["core/values.md", "core/rules.md", "core/voice.md"],
        "mode": ["modes/onboarding.md"],
        "oversight": ["oversight/review-policy.json"]
      },
      "keywords": ["init", "onboard", "new project", "get started", "initialize", "adopt", "setup project"]
    },
    {
      "intent": "orchestration",
      "description": "Coordinate multi-task execution toward project goals.",
      "load": {
        "core": ["core/values.md", "core/rules.md", "core/voice.md"],
        "mode": ["modes/orchestration.md"],
        "oversight": ["oversight/review-policy.json"],
        "domain": [
          "domains/{project}/overview.md",
          "domains/{project}/constraints.md",
          "domains/{project}/conventions.md",
          "domains/{project}/definition-of-done.md",
          "domains/{project}/goals.json"
        ]
      },
      "keywords": ["orchestrate", "dispatch", "coordinate", "run goals", "execute goals", "plan execution"]
    }
  ],

  "fallback": {
    "description": "When no intent matches, load core only and ask for clarification.",
    "load": {
      "core": ["core/values.md", "core/rules.md", "core/voice.md"]
    }
  }
}`,

  // ---------------------------------------------------------------------------
  // Secrets
  // ---------------------------------------------------------------------------

  "domains/{project}/secrets.md": `# {project} — Secrets

<!-- This file is the source of truth for sensitive data in this project.
     The swarm router loads this on every invocation so agents know how to
     find and configure secrets. Files and patterns listed below are NEVER
     uploaded to telemetry sharing. -->

## Setup Instructions

<!-- Agents: follow these steps before running builds or tests.
     If a secret is missing, tell the user — do not proceed without it. -->

<!-- Add setup steps here, e.g.:
1. Copy \\\`Secrets.xcconfig.template\\\` → \\\`Secrets.xcconfig\\\`
2. Fill in the required values
3. Verify the file is valid -->

## Secret Variables

<!-- List every secret the project needs. Never put actual values here. -->

| Variable | Purpose | Location | Accessor |
|---|---|---|---|
| <!-- e.g. --> | <!-- e.g. API access --> | <!-- e.g. .env --> | <!-- e.g. process.env.KEY --> |

## Sensitive Files

<!-- Glob patterns relative to project root. These files are excluded from
     telemetry uploads and should never be committed to version control. -->

- .env
- .env.*

## Sensitive Swarm Files

<!-- Swarm context files excluded from telemetry uploads even when
     "share context" is enabled. -->

- domains/{project}/environment.md
`,

  // ---------------------------------------------------------------------------
  // Designs
  // ---------------------------------------------------------------------------

  "designs/README.md": `# Designs

Place design assets here for swarm to reference during task planning and execution.

## Supported Formats

| Format | Usage |
|---|---|
| \`.png\`, \`.jpg\`, \`.svg\` | Mockups, screenshots, napkin sketches — included as visual context for multimodal LLMs |
| \`.md\` with mermaid blocks | Flowcharts, navigation diagrams — parsed for task ordering |
| \`.figma.url\` | Text file containing a Figma URL — requires Figma MCP server |

## How Swarm Uses Designs

When a goal in \`goals.json\` references a design file:

\`\`\`json
{
  "id": "goal-3",
  "description": "Build the main list view",
  "designs": ["designs/list-view.png", "designs/nav-flow.md"]
}
\`\`\`

Swarm includes these files in the LLM context when:
1. **Decomposing the goal into tasks** — the LLM sees the mockup and creates tasks that implement it
2. **Executing each task** — the worker has the visual reference while coding
3. **Verifying output** — screenshots can be compared against the design

## Figma Integration

To use Figma URLs, add the Figma MCP server to your config:

\`\`\`bash
swarm add mcp figma
\`\`\`

Then create a \`.figma.url\` file:

\`\`\`
https://www.figma.com/file/abc123/MyDesign
\`\`\`
`,

  // ---------------------------------------------------------------------------
  // .gitignore
  // ---------------------------------------------------------------------------

  ".gitignore": `# Transient content — do not commit
.cache/
.tasks/
.checkpoints/
telemetry/events/
`,
} as const;

export type TemplatePath = keyof typeof TEMPLATES;
