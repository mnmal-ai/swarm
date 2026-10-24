/**
 * A stand-in for the cortext coordinator, owning the context-store types the
 * drainstop promotes into: `SessionLog`, `Decision`, `Todo` and `AgentRule`.
 *
 * The field definitions mirror `@mnmal-ai/cortext@1.0.0-alpha.7`
 * (`buildClaudeNamespace` in `src/namespace.ts` of the public
 * `mnmal-ai/synoptic` repo; the vocabularies from its `src/kernel` constants,
 * as published in `dist/plugin-*.js`): the same required fields, nullability,
 * defaults, vocabularies, aliases and implications, so a promotion that this
 * fixture accepts is one real cortext accepts too.
 *
 * Left out, because the drainstop never writes them and their targets are
 * types this fixture does not carry: `Decision.establishesConcept` and
 * `AgentRule.expressesConcept` (crossRefs to `Concept`), `Todo.owner` (a
 * crossRef to `AgentIdentity`). Also left out: `embed.source` and
 * `lexical.source`, which shape recall and are not write requirements. An
 * undeclared field is refused here, so a promotion that started writing one
 * of them would fail this fixture rather than pass it silently.
 *
 * One test-only knob: `createTodo` refuses any title containing
 * {@link FIXTURE_REFUSED_TITLE_MARKER}, so a test can force a refused
 * promotion write.
 */
import {
  type CoordinatorPlugin,
  defineNamespace,
  field,
  type NamespaceDefinition,
  type RegistryEntryResolver,
  ResolverFrameError,
  type TypeInput,
} from "@mnmal-ai/substrate/sdk";

/** cortext's `TODO_LIFECYCLE_VOCAB`. */
export const TODO_LIFECYCLE_VOCAB = ["open", "in_progress", "blocked", "deferred", "closed"] as const;
/** cortext's `TODO_RESOLUTION_VOCAB`. */
export const TODO_RESOLUTION_VOCAB = ["completed", "wont_do", "superseded", "duplicate", "obsolete", "unspecified"] as const;
/** cortext's `TODO_PRIORITY_VOCAB` (a strict `field.enum`). */
export const TODO_PRIORITY_VOCAB = ["low", "medium", "high"] as const;

const TODO_STATUS_ALIASES = {
  done: "closed",
  finished: "closed",
  completed: "closed",
  shipped: "closed",
  cancelled: "closed",
  dropped: "closed",
  superseded: "closed",
  not_started: "open",
};
const TODO_STATUS_IMPLIES = {
  done: { resolution: "completed" },
  finished: { resolution: "completed" },
  completed: { resolution: "completed" },
  shipped: { resolution: "completed" },
  cancelled: { resolution: "wont_do" },
  dropped: { resolution: "wont_do" },
  superseded: { resolution: "superseded" },
};
const TODO_RESOLUTION_ALIASES = {
  done: "completed",
  shipped: "completed",
  wontfix: "wont_do",
  declined: "wont_do",
  dup: "duplicate",
  moot: "obsolete",
};

/** cortext's `DECISION_STATUS_VOCAB` (non-strict, default `active`). */
export const DECISION_STATUS_VOCAB = ["open", "active", "superseded", "deferred"] as const;
const DECISION_STATUS_ALIASES = { accepted: "active", adopted: "active", decided: "active", proposed: "open" };

/** cortext's `AGENT_RULE_SEVERITY_VOCAB` (strict, nullable). */
export const AGENT_RULE_SEVERITY_VOCAB = ["must", "should"] as const;
const AGENT_RULE_SEVERITY_ALIASES = { high: "must", medium: "should" };

/** cortext's `AGENT_RULE_CATEGORY_VOCAB` (non-strict: other categories are admitted). */
export const AGENT_RULE_CATEGORY_VOCAB = [
  "git",
  "testing",
  "style",
  "process",
  "tooling",
  "communication",
  "investigation",
  "migration-patterns",
  "permissions",
  "scope-discipline",
  "side-findings",
  "verification",
] as const;

/** A Todo title containing this is refused by the fixture's `createTodo`. */
export const FIXTURE_REFUSED_TITLE_MARKER = "fixture-refuse";

/** The fixture's refusal code. */
export const FIXTURE_REFUSED_CODE = "fixture_refused";

function cortextTypes(ns: string): Record<string, TypeInput> {
  return {
    SessionLog: {
      fields: {
        branch: field.string(),
        startedAt: field.date(),
        summary: field.string({ indexed: false }),
        synopsis: field.string({ nullable: true }),
        decisionsCount: field.number(),
        packages: field.string(),
        body: field.string({ nullable: true, indexed: false }),
        tags: field.list(field.string(), { nullable: true }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true }),
      },
    },
    Decision: {
      fields: {
        topic: field.string(),
        choice: field.string(),
        rationale: field.string({ indexed: false }),
        sessionId: field.crossRef(ns, "SessionLog", { nullable: true, onDelete: "set_null" }),
        supersedes: field.crossRef(ns, "Decision", { nullable: true, onDelete: "set_null", spread: true }),
        status: field.vocab(DECISION_STATUS_VOCAB, {
          aliases: DECISION_STATUS_ALIASES,
          strict: false,
          default: "active",
        }),
        tags: field.list(field.string(), { nullable: true }),
        revisitWhen: field.string({ nullable: true, indexed: false }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true }),
      },
    },
    Todo: {
      fields: {
        title: field.string(),
        area: field.string(),
        status: field.vocab(TODO_LIFECYCLE_VOCAB, { aliases: TODO_STATUS_ALIASES, implies: TODO_STATUS_IMPLIES }),
        resolution: field.vocab(TODO_RESOLUTION_VOCAB, { aliases: TODO_RESOLUTION_ALIASES, nullable: true }),
        priority: field.enum(TODO_PRIORITY_VOCAB),
        notes: field.string({ nullable: true, indexed: false }),
        blockedBy: field.string({ nullable: true, indexed: false }),
        revisitWhen: field.string({ nullable: true, indexed: false }),
        body: field.string({ nullable: true, indexed: false }),
        tags: field.list(field.string(), { nullable: true, indexed: true }),
        archived: field.boolean({ default: false }),
        targetDate: field.date({ nullable: true }),
        implementsDecision: field.crossRef(ns, "Decision", { nullable: true, onDelete: "set_null" }),
        project: field.string({ nullable: true }),
      },
    },
    AgentRule: {
      fields: {
        rule: field.string({ indexed: false }),
        category: field.vocab(AGENT_RULE_CATEGORY_VOCAB, { strict: false }),
        severity: field.vocab(AGENT_RULE_SEVERITY_VOCAB, { aliases: AGENT_RULE_SEVERITY_ALIASES, nullable: true }),
        active: field.boolean(),
        pinned: field.boolean({ nullable: true }),
        synopsis: field.string({ nullable: true }),
        rationale: field.string({ indexed: false }),
        archived: field.boolean({ default: false }),
        project: field.string({ nullable: true }),
      },
    },
  };
}

function cortextNamespace(ns: string): NamespaceDefinition {
  const base = defineNamespace(ns, cortextTypes(ns));
  return {
    ...base,
    async install(ctx) {
      await base.install(ctx);
      const entry = ctx.registry.get("createTodo");
      if (entry === undefined) throw new Error("cortext fixture: autoCRUD did not register createTodo");
      const create = entry.resolver;
      const refusing: RegistryEntryResolver = (rctx, args) => {
        const title = args.params?.title;
        if (typeof title === "string" && title.includes(FIXTURE_REFUSED_TITLE_MARKER)) {
          throw new ResolverFrameError(FIXTURE_REFUSED_CODE, `cortext fixture refuses the title '${title}'`);
        }
        return create(rctx, args);
      };
      ctx.registry.replace("createTodo", { ...entry, resolver: refusing });
    },
  };
}

/** The fixture coordinator, owning `namespace` (default `cortext`). */
export function createCortextFixture(opts: { namespace?: string } = {}): CoordinatorPlugin {
  return {
    name: "cortext-fixture",
    contractVersion: ">=1.0.0-alpha.0 <2.0.0",
    namespaces: [cortextNamespace(opts.namespace ?? "cortext")],
  };
}
