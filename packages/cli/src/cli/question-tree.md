# swarm init — Question Tree

> This file documents the complete interactive flow for `swarm init`.
> It is the source of truth for what the CLI asks, in what order, and how
> answers branch. Keep this file updated when the flow changes.

## Flow Overview

```
swarm init
  │
  ├─ 0. Pre-check (if .swarm/ exists)
  │     → Add missing files / Start fresh / Abort
  │
  ├─ 1. Project detection (automatic)
  │     Scans: package.json, Cargo.toml, Package.swift, go.mod,
  │            pyproject.toml, *.xcodeproj, .git/, .env.example
  │     Shows: project name, language, framework, git status
  │
  ├─ 1b. Project stage
  │     → "An existing codebase" (discovery-oriented questions)
  │     → "A new project" (intent-oriented questions)
  │
  ├─ 2. Speed dial
  │     → Guided (9 questions)
  │     → Quick (templates with examples, skip to step 4)
  │     → Empty (skeleton only, skip to step 4)
  │
  ├─ 3. Guided questions (if Guided selected)
  │     Escape hatches: "skip" any question, "done" to stop early
  │     ┌──────────────────────────────────────────────────────────┐
  │     │ Questions branch based on project stage (step 1b)       │
  │     │ Core questions (Q1-Q3) are the same for both paths      │
  │     │ Domain questions (Q4-Q9) differ by path                 │
  │     └──────────────────────────────────────────────────────────┘
  │
  ├─ 4. Runtime backend (always asked, even in Quick/Empty)
  │     → Claude Code / Cursor / Codex / Direct API / Not sure yet
  │     └─ If Direct API → Which provider? (Anthropic / OpenAI)
  │     └─ If not "Not sure yet" → API key check
  │        → In my environment (validate) / Enter now / Set up later
  │
  ├─ 5. Tool detection + skill generation
  │     → Claude Code / Cursor / GitHub Copilot / Other
  │     └─ If nothing selected → "Generate universal SWARM-PROMPT.md?" (default: yes)
  │
  ├─ 6. Scaffold (automatic)
  │     Writes .swarm/ directory with all files
  │
  └─ 7. Summary
        Shows: file counts, skill file explanation, next steps
```

## Step 0: Pre-check

**Condition**: Only shown if `.swarm/` directory already exists.

| Option | Behavior |
|---|---|
| Add missing files only | Non-destructive merge — skips existing files |
| Start fresh | Overwrites everything |
| Abort | Exits |

## Step 1: Project Detection

Automatic, no user input. Scans the current directory for:

| Signal | Detects |
|---|---|
| `package.json` | Node.js, TypeScript/JavaScript, framework (Express, Next.js, React, etc.), dependencies |
| `Cargo.toml` | Rust, crate name |
| `Package.swift` | Swift, project name |
| `go.mod` | Go, module name |
| `pyproject.toml` | Python, project name |
| `requirements.txt` | Python, dependencies |
| `*.xcodeproj` / `*.xcworkspace` | Swift, Xcode project |
| `.git/` | Branch, remote URL |
| `.env.example` / `.env.template` / `.env.sample` | Environment variable names |

**Warnings shown:**
- If no `.git/`: "This directory is not a git repo. Swarm uses worktrees — you'll need git init before swarm run."
- If no manifest files found: shows directory name as project name

## Step 1b: Project Stage

| Option | Effect on later questions |
|---|---|
| **An existing codebase** | Questions focus on discovery: what patterns exist, what to protect, what commands verify work |
| **A new project** | Questions focus on intent: what you want to build, what conventions to establish, what your first goal is |

## Step 2: Speed Dial

| Option | What happens |
|---|---|
| **Guided** | 9 questions (Q1-Q9), each with context explaining the file |
| **Quick** | Templates with example content, skips to step 4 |
| **Empty** | Bare skeleton (headers + HTML comments only), skips to step 4 |

Can be pre-selected via CLI flags: `--guided`, `--quick`, `--empty`.

## Step 3: Guided Questions

Every question uses a **select-or-type** prompt (similar to Claude Code's suggestion UX):

1. **Progress counter** — `[1/9]`, `[2/9]`, etc. with a swarm animation beat between questions
2. **Context block** — which file it populates, why it matters, how swarm uses it
3. **Suggested answers** — 3 pre-built options the user can arrow through
4. **Custom input** — start typing to write your own answer instead
5. **Tab to edit** — press Tab on a suggestion to copy it into the text field for editing
6. **Navigation** — type "back" to return to the previous question (answer is pre-filled)
7. **Escape hatches** — type "skip" to leave as template, "done" to template all remaining
8. **Review screen** — after all questions, see a summary of all answers with option to edit any

### Interaction model

```
◇ [3/9] domains/conventions.md — This is the most important domain file...

? What patterns and conventions matter most?
> Controller-service separation, kebab-case files, camelCase functions  [tab to edit]
  Feature modules with co-located tests, barrel exports, strict types
  Functional core / imperative shell, minimal OOP, composition over inheritance
──────────────────────────────────────────────────────
  type your own, or "skip" / "done" / "back"
```

- **Arrow keys**: navigate suggestions
- **Enter**: select the highlighted suggestion
- **Tab**: copy suggestion into editable text field
- **Start typing**: switch to custom input (suggestions dim)
- **Escape**: if typing, return to browse mode; if browsing, cancel
- **"back"**: return to previous question with your answer pre-filled for editing
- **"skip"**: leave this file as template
- **"done"**: template all remaining files and move to review

### Review screen

After all questions (or "done"), a summary shows all answers:

```
┌ Review your answers ──────────────────────────────────────────────────────┐
│                                                                           │
│  + 1. What does your team value most?  Correctness first — measure tw... │
│  + 2. Any hard rules?  Never force push, never commit secrets...          │
│  - 3. How should agents communicate?  (template)                          │
│  + 4. What are you building?  A REST API with TypeScript and Express      │
│  ...                                                                      │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────╯

? How does this look?
  ● Looks good — continue
  ○ Edit an answer
```

Selecting "Edit an answer" shows a list of all questions to pick from. The selected question re-opens with the previous answer pre-filled.

### Core Questions (same for both paths)

| # | File | Question | Why it matters |
|---|---|---|---|
| Q1 | `core/values.md` | "What does your team value most?" | Loaded on every agent invocation. Guides what "good enough" means. |
| Q2 | `core/rules.md` | "Any hard rules agents must follow?" | Non-negotiable constraints. Violating these is never acceptable. |
| Q3 | `core/voice.md` | "How should agents communicate?" | Shapes code comments, commit messages, PR descriptions. |

### Domain Questions — Existing Codebase

| # | File | Question | Why it matters |
|---|---|---|---|
| Q4 | `domains/{project}/overview.md` | "Describe your tech stack" | Project facts for navigation. Shows auto-detected language/framework. |
| Q5 | `domains/{project}/conventions.md` | "What patterns and conventions matter most?" | Most important domain file. Teaches agents your existing style. |
| Q6 | `domains/{project}/constraints.md` | "What should agents never touch or change?" | Harder than conventions — violating these breaks things. |
| Q7 | `domains/{project}/definition-of-done.md` | "How do you verify something is done?" | Exact commands agents must run. Copy-pasteable, pass/fail. |
| Q8 | `domains/{project}/environment.md` | "What services does your project connect to?" | API keys and secrets metadata. Shows detected .env.example vars. |
| Q9 | `domains/{project}/goals.json` | "What are you working on right now?" | Current work for the orchestrator to decompose. |

### Domain Questions — New Project

| # | File | Question | Why it matters |
|---|---|---|---|
| Q4 | `domains/{project}/overview.md` | "What are you building, and with what tech?" | Vision and tech choices before code exists. |
| Q5 | `domains/{project}/conventions.md` | "What conventions do you want to establish?" | Set standards early to prevent style drift. |
| Q6 | `domains/{project}/constraints.md` | "Anything agents should stay away from?" | Guardrails even before there's code to protect. |
| Q7 | `domains/{project}/definition-of-done.md` | "How will you verify work is done?" | Define "done" early, update as tooling evolves. |
| Q8 | `domains/{project}/environment.md` | "What services will you connect to?" | Plan external dependencies upfront. |
| Q9 | `domains/{project}/goals.json` | "What's your first goal?" | First thing for the orchestrator to work on. |

## Step 4: Runtime Backend

**Always asked**, even in Quick/Empty modes.

| Option | `backends.<role>.type` | `models.provider` | API key env var |
|---|---|---|---|
| Claude Code | `claude-code` | `anthropic` | `ANTHROPIC_API_KEY` |
| Cursor | `claude-code` | `anthropic` | `ANTHROPIC_API_KEY` |
| Codex | `api` | `openai` | `OPENAI_API_KEY` |
| Direct API | `api` | (asked) | (derived) |
| Not sure yet | `api` | `anthropic` | `ANTHROPIC_API_KEY` |

The type is written for all three roles (`worker`, `reviewer`, `arbiter`); a `claude-code` role also gets `fallback: "api"`. A role left out of `backends` runs on the direct API, which needs the key.

### Sub-question: Direct API Provider

**Condition**: Only shown if "Direct API" selected.

| Option | Effect |
|---|---|
| Anthropic | Uses Claude models, `ANTHROPIC_API_KEY` |
| OpenAI | Uses GPT/o-series models, `OPENAI_API_KEY` |

### Sub-question: API Key

**Condition**: Shown unless "Not sure yet" selected.

| Option | Behavior |
|---|---|
| Yes, it's in my environment | Checks if the env var exists. Warns if not found. |
| Yes, I'll enter it now | Prompts for key. Checks .gitignore before writing to .env. If .env not gitignored, asks to add it. |
| No, I'll set it up later | Deferred — instructions printed in summary. |

## Step 5: Tool Detection + Skill Generation

**Condition**: Skipped if `--no-skill` flag is set.

Shows an explanation of what skill files are and why they help, then asks which tools to generate for.

| Option | Output path |
|---|---|
| Claude Code | `.claude/commands/prepare-for-swarm.md` |
| Cursor | `.cursor/rules/prepare-for-swarm.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md` (appended with `<!-- swarm:begin/end -->` markers) |
| Other / generate a prompt | `SWARM-PROMPT.md` in project root |

**Fallback**: If nothing selected, asks "Generate a universal SWARM-PROMPT.md?" (defaults to yes).

## Step 6: Scaffold

Automatic. Creates the `.swarm/` directory with all template files:

```
.swarm/
├── swarm.json              (router manifest, 5 routes, pre-wired)
├── .gitignore              (ignores transient content)
├── core/                   (3 files: values, rules, voice)
├── modes/                  (3 files: code-review, implementation, investigation)
├── capabilities/           (2 files: git-workflow, testing)
├── domains/{project}/      (8 files: config, overview, architecture, conventions,
│                            constraints, definition-of-done, environment, goals)
├── skills/                 (3 empty dirs: core, vetted, community — with .gitkeep)
└── oversight/              (1 file: review-policy.json)
```

**Fill level affects content:**
- **Guided**: User answers injected into templates
- **Quick**: Templates with example content
- **Empty**: Section headers and HTML comments only

## Step 7: Summary

Shows:
1. File counts per directory
2. Skill files created (if any)
3. "What the skill file does" explanation box (if skill generated)
4. Next steps: populate swarm, set API key (if deferred), run swarm

## CLI Flags

| Flag | Effect |
|---|---|
| `--guided` | Skip speed dial, go straight to guided |
| `--quick` | Skip speed dial, go straight to quick |
| `--empty` | Skip speed dial, go straight to empty |
| `--project <name>` | Override detected project name |
| `--dir <path>` | Scaffold at custom path (default: `.swarm/`) |
| `--no-skill` | Skip skill file generation |
| `--no-animation` | Disable loading animation |
