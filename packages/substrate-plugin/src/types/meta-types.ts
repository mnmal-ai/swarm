/**
 * The swarm meta namespace's types (`<swarm namespace>_meta`), ported from the
 * previous engine plugin to Substrate's field DSL. Field
 * names, nullability and `indexed: false` flags are unchanged.
 */
import { field, type TypeInput } from "@mnmal-ai/substrate/sdk";

export const swarmMetaTypes = {
  SessionLog: {
    fields: {
      branch: field.string(),
      summary: field.string({ indexed: false }),
      decisionsCount: field.number(),
      bugsCount: field.number(),
      landmarksCount: field.number(),
      coldTestsCount: field.number(),
      timestamp: field.string(),
    },
  },
  Decision: {
    fields: {
      topic: field.string(),
      choice: field.string(),
      rationale: field.string({ indexed: false }),
      supersedes: field.string({ nullable: true }),
      // `createdAt` is a row-metadata name: a client-supplied value is refused
      // (`client_supplied_server_field`), as it was under the previous engine. A
      // non-nullable scalar is also required on create, so without `nullable`
      // no Decision could be created at all. Nullable keeps the field readable
      // on existing rows.
      createdAt: field.string({ nullable: true }),
    },
  },
  CodeLandmark: {
    fields: {
      filePath: field.string(),
      purpose: field.string({ indexed: false }),
      addedAt: field.string(),
    },
  },
  ColdTestRun: {
    fields: {
      runNumber: field.number(),
      goalsAttempted: field.number(),
      goalsCompleted: field.number(),
      // Legacy dollar figure, nullable so existing rows stay readable and new
      // rows need not carry it; swarm budgets in tokens.
      cost: field.number({ nullable: true }),
      tokens: field.number({ nullable: true }),
      firstPassRate: field.number(),
      notes: field.string({ indexed: false }),
      timestamp: field.string(),
    },
  },
  BugReport: {
    fields: {
      title: field.string(),
      symptom: field.string({ indexed: false }),
      rootCause: field.string({ indexed: false, nullable: true }),
      fix: field.string({ indexed: false, nullable: true }),
      diagnosingQuery: field.string({ indexed: false, nullable: true }),
      status: field.string(),
      foundAt: field.string(),
    },
  },
} satisfies Record<string, TypeInput>;
