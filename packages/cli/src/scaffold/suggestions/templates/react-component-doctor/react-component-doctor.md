---
name: react-component-doctor
description: Review React components for hook correctness, render-cost, and effect discipline. Use when adding or refactoring components, or chasing a re-render/stale-closure bug.
---

# Skill: React Component Doctor

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt to your project's React
     version and state conventions before trusting it. -->

## When this loads

The swarm detected a `react` dependency. Loads when adding or refactoring components, or
investigating unexpected re-renders and effect bugs.

## What to check

- **Hooks rules hold.** Hooks run unconditionally at the top level; dependency arrays are complete and honest.
- **Effects are for side effects.** No deriving state in an effect that could be computed during render; no effect that only mirrors a prop into state.
- **Stable identities.** Callbacks/values passed to memoized children are stable where it matters; keys are stable and unique.
- **Render stays cheap.** No expensive work or new object/array literals created inline in a hot render path without reason.
- **State lives at the right level.** Lifted only as far as needed; co-located otherwise.

## Workflow

1. Read the component and its hooks.
2. Verify every effect's dependency array is complete; flag missing or suppressed deps.
3. Look for state that should be derived during render instead of stored.
4. Check list rendering for stable keys and unnecessary remounts.
5. Recommend the smallest fix; avoid sweeping memoization that adds complexity without a measured win.

## Red flags to surface

- An effect whose only job is to copy a prop into local state.
- A dependency array silenced with an eslint-disable instead of fixed.
- A new function/object created inline and passed to a memoized child every render.
