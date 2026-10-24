---
name: swift-concurrency-audit
description: Audit Swift code for strict-concurrency correctness — actor isolation, Sendable conformance, and main-actor UI access. Use when adding async code or chasing a data-race/Sendable warning.
---

# Skill: Swift Concurrency Audit

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt to your app's actor and
     model layout before trusting it. -->

## When this loads

The swarm detected a Swift package/project. Loads when adding async code, introducing an
actor, or resolving a strict-concurrency (Swift 6) diagnostic.

## What to check

- **Sendable across boundaries.** Types crossing actor or task boundaries conform to `Sendable`; flag implicit captures that don't.
- **UI on the main actor.** View state and UI mutation are `@MainActor`; background work hops back before touching it.
- **Actors own their state.** Shared mutable state lives behind an actor, not a global `var`.
- **No blocking in async.** No sync waits or sleeps on the cooperative thread pool.
- **Isolation is explicit.** Prefer compile-time isolation (`@MainActor`, actor types) over runtime checks.

## Workflow

1. Identify the async/concurrent code paths in the change.
2. Trace every value crossing a task/actor boundary; confirm `Sendable`.
3. Confirm UI-touching code is main-actor isolated and that hops are explicit.
4. Replace global mutable state with actor-owned state where races are possible.
5. Resolve concurrency warnings at the source — do not silence them with unchecked escapes unless justified and noted.

## Red flags to surface

- A non-`Sendable` type captured by a `Task` or passed to an actor.
- UI state mutated off the main actor.
- `@unchecked Sendable` added to quiet a warning without a stated invariant.
