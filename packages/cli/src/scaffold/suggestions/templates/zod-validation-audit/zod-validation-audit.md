---
name: zod-validation-audit
description: Audit that every external input crosses a Zod schema at the boundary before use. Use when reviewing route handlers, API edges, or any code reading untrusted request data.
---

# Skill: Zod Validation Audit

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt to your project's boundary
     layout and schema location before trusting it. -->

## When this loads

The swarm detected a `zod` dependency. Loads when reviewing input handling at any trust
boundary (HTTP routes, message consumers, file/CLI input).

## What to check

- **Every boundary validates.** No handler reads a raw request body, query, or params object directly.
- **Parse, don't assert.** Use `.parse`/`.safeParse` so invalid input fails loudly at the edge, not deep in a service.
- **Schemas are the source of truth.** Derive types from schemas (`z.infer`) rather than declaring duplicate interfaces that can drift.
- **Bounds are explicit.** String lengths, array sizes, and numeric ranges have caps — unbounded input is a denial-of-service vector.
- **Errors map to a typed response.** A validation failure returns a clean 4xx, not a 500.

## Workflow

1. Enumerate boundary entrypoints (route files, consumers).
2. For each, confirm the input passes through a Zod schema before any business logic touches it.
3. Flag any direct access to untrusted data that skips validation.
4. Confirm length/size/range bounds exist where input is user-controlled.
5. Recommend the minimal schema addition; do not restructure unrelated code.

## Red flags to surface

- `req.body.x` (or equivalent) read before any `.parse`.
- A hand-written interface duplicating a schema's shape.
- Unbounded string or array fields accepted from a client.
