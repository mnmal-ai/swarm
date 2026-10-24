---
name: vitest-coverage-enforcer
description: Enforce meaningful test coverage on changed files using Vitest — happy path, one error path, one edge case minimum. Use when adding behavior or before opening a PR that touches testable code.
---

# Skill: Vitest Coverage Enforcer

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt the coverage threshold and
     run command to your project's gate before trusting it. -->

## When this loads

The swarm detected a `vitest` dependency. Loads when adding behavior or preparing a PR,
to confirm changed files carry adequate tests.

## What to check

- **Behavior, not implementation.** Tests assert on outputs and side effects, not internal structure.
- **Minimum coverage per change.** Happy path, one error path, one edge case for each new public function.
- **Changed-file coverage meets the bar.** The project's threshold (commonly >=80%) applies to files you touched.
- **Tests are independent.** Mocks reset between tests; no test depends on another's state or on wall-clock time.
- **Names read as sentences.** `it('rejects an expired token', ...)` — never `test1`.

## Workflow

1. Identify changed files with testable logic.
2. Run the suite in non-watch mode (`vitest run`) with coverage.
3. For each changed file below the bar, add the missing happy/error/edge cases.
4. Re-run to confirm green and that coverage on changed files clears the threshold.
5. Kill any spawned watcher/runner processes when done.

## Red flags to surface

- A new public function with no test.
- Tests that hit a live network or share global state.
- A test asserting on private internals rather than observable behavior.
