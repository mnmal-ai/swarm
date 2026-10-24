/**
 * `prepareTask` — server-side query resolver for the swarm coordinator plugin.
 *
 * Collapses `classifyIntent` + `loadContext` + a complexity score into ONE
 * round trip so the Swarm SDK can prepare a task with a single call instead of
 * three. It delegates to the two existing resolvers (rather than
 * reimplementing their logic), so every passed-through field is value-equal to
 * calling `classifyIntent` then `loadContext` in sequence — verified by the
 * field-for-field parity test.
 *
 * Backend-neutral, pure data shaping: ZERO LLM calls and ZERO live HTTP. The
 * only I/O is what the delegated resolvers perform. Mirrors the (ctx, args)
 * shape of the other resolvers; reads params off `args.params` and forwards
 * `ctx` and `args.dataset` unchanged.
 */

import type {
  ClassifyConfidence,
  LoadContextResponse,
  PrepareTaskRequest,
  PrepareTaskResponse,
} from "@mnmal-ai/swarm-substrate-shared";
import type { RequestContext, ResolverArgs, TypedResolver } from "@mnmal-ai/substrate/sdk";
import { makeClassifyIntent } from "./classify-intent.js";
import { type DocsSource, makeLoadContext } from "./load-context.js";
import type { SwarmRecallDeps } from "./recall.js";

/**
 * Normalization divisor for the file-count term: a route loading this many
 * files saturates the file dimension. Eight covers a full
 * core+mode+oversight+capabilities+domain+skills spread; beyond that the
 * marginal signal flattens.
 */
const FILE_COUNT_SATURATION = 8;

/**
 * Derive a bounded complexity score in [0, 1] from the classification
 * confidence and the assembled context. A convex combination of three terms,
 * each already in [0, 1], so the result is in [0, 1] without clamping — the
 * clamp is defensive belt-and-suspenders for unexpected inputs.
 *
 *   - confidence: a matched route (exact/keyword) implies real, sized work;
 *     a fallback implies "ask for clarification" — the lowest band.
 *   - file count: more files loaded → broader blast radius → more complex.
 *   - budget pressure: the share of the token budget the context consumes.
 *
 * A fallback (no route, no files, zero tokens, zero budget) scores 0; any
 * matched route scores strictly higher. Pure and exported for unit testing.
 */
export function scoreComplexity(
  confidence: ClassifyConfidence,
  fileCount: number,
  tokensUsed: number,
  budgetTokens: number,
): number {
  const confidenceTerm =
    confidence === "exact"
      ? 1
      : confidence === "keyword" || confidence === "semantic"
        ? 0.6
        : 0;
  const fileTerm = Math.min(fileCount / FILE_COUNT_SATURATION, 1);
  const budgetTerm =
    budgetTokens > 0 ? Math.min(tokensUsed / budgetTokens, 1) : 0;

  const raw = 0.4 * confidenceTerm + 0.3 * fileTerm + 0.3 * budgetTerm;
  return Math.max(0, Math.min(1, raw));
}

/**
 * The `prepareTask` query resolver.
 *
 * 1. Classify the prompt (delegating to `classifyIntent`, which reads
 *    `args.params.{prompt, intentOverride}` and `args.dataset`).
 * 2. Load context for the matched intent (delegating to `loadContext` with a
 *    fresh params object — `{intent, projectId, modelId}` — and the SAME
 *    dataset handle).
 * 3. Score complexity from the confidence + assembled context.
 *
 * Validation is delegated: `classifyIntent` throws on a missing dataset/prompt
 * and `loadContext` throws on a missing intent/modelId, so an under-specified
 * call fails loudly with the same message a direct call would produce.
 */
export function makePrepareTask(
  recall?: SwarmRecallDeps,
  docs?: DocsSource,
): TypedResolver<PrepareTaskResponse> {
  const classify = makeClassifyIntent(recall);
  const load = makeLoadContext(recall, docs);

  return async (
    ctx: RequestContext,
    args: ResolverArgs,
  ): Promise<PrepareTaskResponse> => {
    const params = (args.params ?? {}) as Partial<PrepareTaskRequest>;
    const projectId = params.projectId ?? "";

    // classifyIntent reads prompt + intentOverride straight off args.params, so
    // the prepareTask args pass through unchanged (modelId is simply ignored there).
    const classification = await classify(ctx, args);

    // loadContext needs {intent, projectId, modelId}; build a fresh args carrying
    // the resolved intent and the SAME dataset handle. Forward `prompt` too so
    // the recall-augmented loader can do within-route semantic content selection
    // (a no-op when recall is unwired — then it ignores the prompt).
    const loadArgs: ResolverArgs = {
      ...args,
      params: {
        intent: classification.intent,
        projectId,
        modelId: params.modelId,
        prompt: params.prompt,
        sections: params.sections,
        index: params.index,
        rank: params.rank,
        rankLimit: params.rankLimit,
      },
    };
    const loaded: LoadContextResponse = await load(ctx, loadArgs);

    return {
      intent: classification.intent,
      confidence: classification.confidence,
      matchedKeywords: classification.matchedKeywords,
      content: loaded.content,
      filesIncluded: loaded.filesIncluded,
      tokensUsed: loaded.tokensUsed,
      budgetTokens: loaded.budgetTokens,
      routeMatched: loaded.routeMatched,
      truncated: loaded.truncated,
      omitted: loaded.omitted,
      ...(loaded.documents ? { documents: loaded.documents } : {}),
      ...(loaded.ranking ? { ranking: loaded.ranking } : {}),
      complexity: scoreComplexity(
        classification.confidence,
        loaded.filesIncluded.length,
        loaded.tokensUsed,
        loaded.budgetTokens,
      ),
    };
  };
}

/**
 * Recall-unwired prepareTask — delegates to the keyword/path baselines. The
 * unit tests consume this; the plugin registers the recall-augmented variant
 * built by `makePrepareTask(recall, docs)`.
 */
export const prepareTask: TypedResolver<PrepareTaskResponse> = makePrepareTask();
