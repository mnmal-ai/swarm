---
name: express-route-review
description: Review Express routes for layering, centralized error handling, and thin-handler discipline. Use when adding or modifying HTTP routes in an Express app.
---

# Skill: Express Route Review

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt to your app's layer
     boundaries and error hierarchy before trusting it. -->

## When this loads

The swarm detected an `express` dependency. Loads when adding or reviewing route
definitions and their handlers.

## What to check

- **Thin routes.** Handlers parse/validate input and delegate to a service; business logic does not live in the route.
- **No per-route try/catch.** Errors propagate to one central error middleware; routes stay clean.
- **Layer rules hold.** Routes import services/validators/lib — not the database directly, not other routes.
- **Typed errors.** Failures throw a typed error (e.g. NotFound/Validation/Upstream) the central handler maps to a status.
- **Versioned mount.** Routes mount under a versioned prefix so a future major version is additive.

## Workflow

1. Read the route file and its handlers.
2. Confirm input is validated at the boundary and the handler delegates to a service.
3. Confirm no handler swallows errors or duplicates the central error path.
4. Check imports against the project's layer rules; flag any reverse import.
5. Recommend the smallest change that restores discipline.

## Red flags to surface

- Business logic or a raw DB query inside a route handler.
- `try/catch` in a handler that hides the central error path.
- A route importing another route, or the DB layer importing a service.
