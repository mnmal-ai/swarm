---
name: vercel-handler-audit
description: Audit serverless/edge request handlers for Vercel-function correctness — no module-level mutable state, async-safety, bundle size, and cold-start cost. Use when adding or reviewing a handler that runs on Vercel Functions.
---

# Skill: Vercel Handler Audit

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt the limits and framework
     specifics (Hono, Express-on-Vercel, raw functions) to your project before trusting it. -->

## When this loads

The swarm detected Vercel plus a handler/serverless framework. Loads when adding or
reviewing request handlers that run as Vercel Functions.

## What to check

- **No module-level mutable state.** Functions are concurrency-shared across requests; a module-scoped
  cache or counter is a race waiting to happen. In-memory state is never a primary store.
- **Fully async-safe.** No racey singletons, no top-level side effects that assume single-request execution.
- **Module-import time is cheap.** Heavy work at import time inflates cold start. Defer it into the handler.
- **Bundle size stays under the platform cap.** Avoid pulling multi-MB deps into the function bundle.
- **Input validated at the boundary.** Every handler validates its request shape before use — no raw body access.
- **Errors are handled, not swallowed.** A central error path returns a typed response; failures are logged with a request id.

## Workflow

1. Identify each handler entrypoint (e.g. `api/**`, Hono route files).
2. Walk imports for module-level state and import-time work; flag anything that survives between requests.
3. Confirm request input passes through a validator before the handler reads it.
4. Confirm the execution-time budget for the route is realistic for the platform timeout.
5. Recommend the smallest fix; do not refactor unrelated handlers.

## Red flags to surface

- `let`/mutable module-scope variables in a handler module.
- A long-running request that could exceed the function timeout.
- Secrets read from anywhere other than environment variables.
