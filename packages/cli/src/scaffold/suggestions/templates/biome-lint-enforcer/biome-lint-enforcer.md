---
name: biome-lint-enforcer
description: Enforce a clean Biome run on changed files — zero warnings, organized imports, consistent formatting. Use when touching source or before opening a PR in a Biome-managed repo.
---

# Skill: Biome Lint Enforcer

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt the run command and
     the warning policy to your project's gate before trusting it. -->

## When this loads

The swarm detected a `@biomejs/biome` dependency or a `biome.json` config. Loads when
editing source or preparing a PR, to confirm changed files pass Biome cleanly.

## What to check

- **Zero warnings on changed files.** A remaining warning is a blocker unless explicitly justified in the PR.
- **Imports are organized.** Biome's import sorting has run; no unused or out-of-order imports.
- **Formatting is consistent.** Files match the project's Biome formatter config — no hand-formatting that the tool would rewrite.
- **Config, not inline ignores.** Rule exceptions live in `biome.json`, not scattered `biome-ignore` comments, unless the suppression is genuinely local.
- **Lint and format are one pass.** Biome covers both; don't reintroduce a separate Prettier/ESLint step.

## Workflow

1. Identify changed files with `git diff --name-only`.
2. Run Biome over them (`biome check` for lint + format, or `biome check --write` to apply safe fixes).
3. Resolve each diagnostic at the source; reach for an inline suppression only when the rule is wrong for that one line.
4. Re-run to confirm a clean exit before opening the PR.

## Red flags to surface

- A warning silenced repo-wide to make one file pass.
- Formatting reverted by hand after Biome wrote it.
- A new Prettier or ESLint config landing alongside Biome.
