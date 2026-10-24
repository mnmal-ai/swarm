/**
 * The swarm documents namespace (`<swarm namespace>-docs`): documents stored as
 * sections (stage 1 of docs/superpowers/specs/2026-10-01-context-sections-design.md),
 * ported from the previous engine plugin to
 * Substrate's field DSL. Field names, nullability, `indexed: false` flags, the
 * cascading Section → Document reference and `Section.embed.source` are
 * unchanged.
 *
 * A namespace of its own, not part of `swarm`, so its names can't collide
 * with swarm's types and its rows can be read, kept or dropped as a unit.
 * `docsNamespaceFor` (in `@mnmal-ai/swarm-substrate-shared`) derives its name
 * from the swarm namespace.
 *
 * `Section` carries `projectId` and `path` itself, as well as the reference to
 * its `Document`, so the context loader reads one project's sections in one
 * query, with no join.
 */
import { field, type Row, type TypeInput } from "@mnmal-ai/substrate/sdk";

/** Where a document comes from: swarm's own `.swarm/` files, or the project's repository. */
export const DOCUMENT_SOURCES = ["swarm", "project"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

/** How much of a section's body goes into its embedding. */
export const EMBED_BODY_CHARS = 2000;

/** The text a section is embedded from: heading path, synopsis, and the start of its body. */
export function sectionEmbedText(row: Row): string {
  let heading = "";
  if (typeof row.headingPath === "string" && row.headingPath !== "") {
    try {
      const parsed = JSON.parse(row.headingPath) as unknown;
      if (Array.isArray(parsed)) heading = parsed.map(String).join(" › ");
    } catch {
      heading = "";
    }
  }
  const synopsis = typeof row.synopsis === "string" ? row.synopsis : "";
  const body = typeof row.body === "string" ? row.body.slice(0, EMBED_BODY_CHARS) : "";
  return [heading, synopsis, body].filter((part) => part !== "").join("\n");
}

/** The namespace's types, with the Section → Document reference bound to `namespace`. */
export function swarmDocsTypes(namespace: string) {
  return {
    Document: {
      fields: {
        projectId: field.string(),
        path: field.string(),
        source: field.enum(DOCUMENT_SOURCES),
        title: field.string(),
        contentHash: field.string(),
        commit: field.string({ nullable: true }),
      },
    },
    Section: {
      fields: {
        document: field.crossRef(namespace, "Document", { onDelete: "cascade" }),
        projectId: field.string(),
        path: field.string(),
        source: field.enum(DOCUMENT_SOURCES),
        /** JSON array of heading texts, level 2 down; `[]` for the text before the first heading. */
        headingPath: field.string(),
        ordinal: field.number(),
        level: field.number(),
        synopsis: field.string(),
        body: field.string({ indexed: false }),
        tokens: field.number(),
        contentHash: field.string(),
        /**
         * The Document `contentHash` this section was written for. The loader
         * uses a file's sections only as a complete set for the Document's
         * current hash, so a sync that fails part way never loads half a file.
         */
        documentHash: field.string(),
      },
      // Stage 3 ranks sections by similarity; with no embedder configured this
      // installs and embeds nothing.
      embed: { source: sectionEmbedText },
    },
  } satisfies Record<string, TypeInput>;
}
