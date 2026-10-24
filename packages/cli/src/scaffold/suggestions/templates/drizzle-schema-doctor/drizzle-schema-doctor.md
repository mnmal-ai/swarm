---
name: drizzle-schema-doctor
description: Audit and repair Drizzle ORM schema and migrations. Use when adding a table or column, changing an enum, or reconciling drift between the schema source and generated SQL migrations.
---

# Skill: Drizzle Schema Doctor

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Review and adapt to your repo's
     schema layout, migration command, and database driver before trusting the swarm to run it. -->

## When this loads

The swarm detected a `drizzle-orm` dependency. Loads for tasks that touch the database
schema, add or alter a table/column/enum, or investigate a migration that won't apply.

## Core rules

- Never hand-edit a generated migration SQL file. Edit the schema source, regenerate, commit the new file.
- Schema + migration travel together in one change. A schema edit without its regenerated migration is incomplete.
- Migrations are forward-only. To undo, write a new migration that reverses — never delete a committed one.
- Enum changes are coordinated: update the enum and every adapter/consumer that switches on it in the same change.

## Workflow

1. Locate the schema source (commonly `src/db/schema/`) and read the table you are changing.
2. Make the change in the schema source only.
3. Regenerate migrations with the project's drizzle-kit command (e.g. `drizzle-kit generate`).
4. Review the generated SQL — confirm it matches intent and contains no destructive surprise (dropped column, narrowed type).
5. Run the migration against a disposable/preview branch, never production.
6. Add or update tests for the new shape.

## Red flags to surface

- A generated migration that drops a column or table you did not intend to remove.
- Manual edits inside a `drizzle/*.sql` file (breaks drizzle-kit's tracking).
- A schema change with no corresponding new migration file in the same change set.
