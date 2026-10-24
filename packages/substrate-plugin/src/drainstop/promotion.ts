/**
 * Promotion of observations into the cortext context store, and the strict
 * engine wrapper that keeps a refused promotion from losing its observation.
 *
 * Mappings, written against `@mnmal-ai/cortext@1.0.0-alpha.7`:
 *
 *   - `fold-back-candidate`           → `<context>/createTodo`
 *   - `architectural`, confidence > 80 → `<context>/createDecision`, with
 *     `sessionId: null` (the crossRef is nullable at alpha.7; a promotion has no
 *     work session, and a dangling id is refused with `missing_referent`)
 *   - `user-framing`, confidence 100   → `<context>/createAgentRule`
 *   - `concern`, ≥ 3 sharing a tag signature → one `Recurrent concern: <sig>`
 *     Todo; later concerns with that signature are appended to it while open
 *
 * Every promoted row carries a lineage marker (`<plane>/Observation id=…`) in
 * `notes` (Todo) or `rationale` (Decision, AgentRule), which is how
 * `reject-promotion` recognises a drainstop promotion. Single-source writes
 * carry the idempotency key `swarm-promotion:<observation id>`, so a run that
 * wrote the target but failed the delete does not duplicate the target when
 * the next run retries.
 */
import type { EngineHandle, EngineInput, PackEnvelope, RequestContext } from "@mnmal-ai/substrate/sdk";
import type { ObservationRow } from "./expiry.js";
import { mutateOne, queryRows } from "./frames.js";

/** A promotion write the context store refused. The observation is kept. */
export class PromotionWriteError extends Error {
  override readonly name = "PromotionWriteError";
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

function namespaceOf(key: string): string | undefined {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : undefined;
}

/**
 * `engine` with a strict `mutate`: an envelope error on a frame key in one of
 * `targetNamespaces` (every namespace, when omitted) throws
 * {@link PromotionWriteError} instead of coming back as a refused-but-resolved
 * envelope. An error with no path is attributed to the strict keys. Queries
 * and every other property pass through.
 */
export function withStrictPromotions(engine: EngineHandle, targetNamespaces?: Iterable<string>): EngineHandle {
  const targets = targetNamespaces === undefined ? undefined : new Set(targetNamespaces);
  const isStrict = (key: string): boolean => {
    if (targets === undefined) return true;
    const ns = namespaceOf(key);
    return ns !== undefined && targets.has(ns);
  };
  const mutate = async (input: EngineInput): Promise<PackEnvelope> => {
    const env = await engine.mutate(input);
    const errors = env.errors ?? [];
    if (errors.length === 0) return env;
    const strictKeys = Object.keys(input.frame).filter(isStrict);
    if (strictKeys.length === 0) return env;
    const relevant = errors.find((e) => {
      const key = e.path?.[0];
      return key === undefined || strictKeys.includes(key);
    });
    if (relevant === undefined) return env;
    const key = relevant.path?.[0] ?? strictKeys.join(",");
    throw new PromotionWriteError(
      `${key} refused: ${relevant.message ?? "no message"}${relevant.code !== undefined ? ` (${relevant.code})` : ""}`,
      relevant.code,
    );
  };
  return new Proxy(engine, {
    get(obj, prop, receiver) {
      if (prop === "mutate") return mutate;
      const value: unknown = Reflect.get(obj, prop, receiver);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

/** `Todo.area` of every promoted Todo. */
export const PROMOTION_AREA = "swarm-promotion";

/** Category for a user-framing rule whose body has no `[category]` prefix. */
export const AGENT_RULE_DEFAULT_CATEGORY = "miscellaneous";

/** Concerns sharing a tag signature promote once there are this many. Pairs coincide too often. */
export const CONCERN_RECURRENCE_MIN_GROUP_SIZE = 3;

export const RECURRENCE_TITLE_PREFIX = "Recurrent concern: ";

/** Todo lifecycle states that end a recurrence; a later recurrence then promotes afresh. */
const CLOSED_TODO_STATUSES = ["closed"];

/** One lineage line of a recurrence Todo. */
const LINEAGE_ID_PATTERN = /^- id=(\S+) ts=/gm;

/** Where promotions go and who they run as. */
export interface PromotionTarget {
  /** A strict engine (see {@link withStrictPromotions}) over the context namespace. */
  engine: EngineHandle;
  planeNamespace: string;
  contextNamespace: string;
  ctx: Partial<RequestContext> | undefined;
}

/** The first line of `s`, cut to `max` characters. */
export function shortLine(s: string, max = 80): string {
  const firstLine = s.split("\n")[0] ?? s;
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max - 1)}…`;
}

function lineageSuffix(planeNamespace: string, obs: ObservationRow): string {
  return `\n\n_Promoted from ${planeNamespace}/Observation id=${obs.id} ts=${obs.ts}_`;
}

function lineageLine(obs: ObservationRow): string {
  return `- id=${obs.id} ts=${obs.ts}${obs.context ? ` ctx=${obs.context}` : ""}`;
}

/**
 * The canonical signature of a comma-separated tag list: trimmed, empties
 * dropped, deduplicated, sorted, joined with `,`. Two observations with the
 * same set of tags share a signature.
 */
export function tagSignature(tags: string | null | undefined): string {
  if (tags === undefined || tags === null || tags === "") return "";
  const parts = tags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return Array.from(new Set(parts)).sort().join(",");
}

/**
 * A user-framing body's `[category]` prefix: the first bracketed token on line
 * one (letters, digits, `-`, `_`), followed by whitespace. No prefix →
 * {@link AGENT_RULE_DEFAULT_CATEGORY} and the whole body.
 */
export function parseCategoryPrefix(body: string): { category: string; rule: string } {
  const match = body.match(/^\[([a-zA-Z0-9_-]+)\]\s+/);
  if (match === null) return { category: AGENT_RULE_DEFAULT_CATEGORY, rule: body };
  return { category: match[1] as string, rule: body.slice(match[0].length) };
}

/** Every concern group with a non-empty tag signature, whatever its size. */
export function groupConcernsBySig(observations: readonly ObservationRow[]): Map<string, ObservationRow[]> {
  const groups = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    if (obs.kind !== "concern" || obs.isAnchor === true) continue;
    const sig = tagSignature(obs.tags);
    if (sig === "") continue;
    const bucket = groups.get(sig);
    if (bucket === undefined) groups.set(sig, [obs]);
    else bucket.push(obs);
  }
  return groups;
}

function idempotencyKeyFor(obs: ObservationRow): string {
  return `swarm-promotion:${obs.id}`;
}

export async function promoteToTodo(t: PromotionTarget, obs: ObservationRow): Promise<void> {
  await mutateOne(
    t.engine,
    t.contextNamespace,
    "createTodo",
    {
      title: shortLine(obs.body),
      area: PROMOTION_AREA,
      status: "open",
      priority: "medium",
      notes: `${obs.body}${lineageSuffix(t.planeNamespace, obs)}`,
      archived: false,
      project: null,
    },
    t.ctx,
    idempotencyKeyFor(obs),
  );
}

export async function promoteToDecision(t: PromotionTarget, obs: ObservationRow): Promise<void> {
  const rationalePrefix =
    obs.context !== undefined && obs.context !== null && obs.context !== ""
      ? `Surfaced with context: ${obs.context}.`
      : "Surfaced from an Observation without additional context.";
  await mutateOne(
    t.engine,
    t.contextNamespace,
    "createDecision",
    {
      topic: shortLine(obs.body),
      choice: obs.body,
      rationale: `${rationalePrefix}${lineageSuffix(t.planeNamespace, obs)}`,
      sessionId: null,
      status: "active",
      archived: false,
      project: null,
    },
    t.ctx,
    idempotencyKeyFor(obs),
  );
}

export async function promoteToAgentRule(t: PromotionTarget, obs: ObservationRow): Promise<void> {
  const { category, rule } = parseCategoryPrefix(obs.body);
  await mutateOne(
    t.engine,
    t.contextNamespace,
    "createAgentRule",
    {
      rule,
      category,
      active: false,
      rationale:
        "User-framing observation promoted at confidence=100. Review the rule, set its severity, and set active=true when ready; " +
        `archive rules that don't survive scrutiny.${lineageSuffix(t.planeNamespace, obs)}`,
      archived: false,
      project: null,
    },
    t.ctx,
    idempotencyKeyFor(obs),
  );
}

/** An open promoted recurrence Todo and the observation ids its lineage lists. */
export interface OpenRecurrence {
  id: string;
  notes: string;
  lineage: Set<string>;
}

function lineageIds(notes: string): Set<string> {
  const ids = new Set<string>();
  for (const match of notes.matchAll(LINEAGE_ID_PATTERN)) ids.add(match[1] as string);
  return ids;
}

/**
 * Open promoted recurrence Todos, keyed by tag signature. With several open
 * for one signature, the first is kept and its lineage covers all of them.
 * Throws when the context store refuses the query.
 */
export async function loadOpenRecurrences(t: PromotionTarget): Promise<Map<string, OpenRecurrence>> {
  const todos = await queryRows<{ id: string; title: string; notes?: string | null }>(
    t.engine,
    t.contextNamespace,
    "Todo",
    {
      where: {
        title: { startsWith: RECURRENCE_TITLE_PREFIX },
        area: { eq: PROMOTION_AREA },
        archived: { eq: false },
        status: { nin: CLOSED_TODO_STATUSES },
        project: { eq: null },
      },
      limit: 1000,
    },
    ["id", "title", "notes"],
    t.ctx,
  );
  const open = new Map<string, OpenRecurrence>();
  for (const todo of todos) {
    const tagSig = todo.title.slice(RECURRENCE_TITLE_PREFIX.length);
    const notes = todo.notes ?? "";
    const existing = open.get(tagSig);
    if (existing === undefined) open.set(tagSig, { id: String(todo.id), notes, lineage: lineageIds(notes) });
    else for (const id of lineageIds(notes)) existing.lineage.add(id);
  }
  return open;
}

export async function promoteConcernRecurrence(t: PromotionTarget, tagSig: string, group: readonly ObservationRow[]): Promise<void> {
  const sortedIds = group.map((o) => o.id).sort();
  const lines = group.map(lineageLine).join("\n");
  const bodies = group.map((o, i) => `(${i + 1}/${group.length}) ${o.body}`).join("\n\n---\n\n");
  await mutateOne(
    t.engine,
    t.contextNamespace,
    "createTodo",
    {
      title: `${RECURRENCE_TITLE_PREFIX}${tagSig}`,
      area: PROMOTION_AREA,
      status: "open",
      priority: "medium",
      notes: `${bodies}\n\n_Promoted from ${group.length} ${t.planeNamespace}/Observation records with tags '${tagSig}':\n${lines}_`,
      archived: false,
      project: null,
    },
    t.ctx,
    `swarm-concern-recurrence:${tagSig}:${sortedIds.join("-")}`,
  );
}

/**
 * Append the group members not yet in `open`'s lineage to its notes. The
 * caller deletes the members afterwards, so a failed delete retries next run
 * without appending the same source twice. Returns the ids appended.
 */
export async function absorbIntoRecurrence(
  t: PromotionTarget,
  tagSig: string,
  open: OpenRecurrence,
  group: readonly ObservationRow[],
): Promise<string[]> {
  const fresh = group.filter((o) => !open.lineage.has(o.id));
  if (fresh.length === 0) return [];
  const bodies = fresh.map((o) => o.body).join("\n\n---\n\n");
  const lines = fresh.map(lineageLine).join("\n");
  // updateTodo replaces the field, so the existing notes are carried whole.
  const notes = `${open.notes}\n\n---\n\n${bodies}\n\n_Absorbed ${fresh.length} later ${t.planeNamespace}/Observation records with tags '${tagSig}':\n${lines}_`;
  await mutateOne(t.engine, t.contextNamespace, "updateTodo", { id: open.id, notes }, t.ctx);
  open.notes = notes;
  for (const o of fresh) open.lineage.add(o.id);
  return fresh.map((o) => o.id);
}
