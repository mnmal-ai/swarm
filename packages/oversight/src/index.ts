import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type {
  DocumentGuard,
  ExecutionResult,
  ISwarmEventBus,
  IWorkerBackend,
  ModelProvider,
  OversightResult,
  OversightRunner,
  ReviewVerdict,
  ArbiterVerdict,
  ArbiterPolicy,
  ReviewPolicy,
} from "@mnmal-ai/swarm-types";
import { SUCCESS_VERDICTS, REVIEW_VALID_VERDICTS as VALID_REVIEW_VERDICTS, ARBITER_VALID_VERDICTS as VALID_ARBITER_VERDICTS, isLoginExpired } from "@mnmal-ai/swarm-types";
import type {
  ObserveRequest,
  ObserveResponse,
  ReviewVerdictInput,
  SubscribeOrPollHandle,
  SubstrateClient,
  TaskTelemetryBuffer,
  WorkerResultInput,
} from "@mnmal-ai/swarm-substrate";
import { subscribeOrPoll } from "@mnmal-ai/swarm-substrate";

/**
 * The observation helper lives on the full SubstrateClient but is feature-
 * detected structurally rather than relied on by type — mirrors the
 * ObserveCapable pattern in core/swarm.ts. A client without a plane (or an
 * older client predating observe()) simply produces no observations, and the
 * oversight flow is never coupled to the plane's availability.
 */
type ObserveCapable = {
  observe?(request: ObserveRequest): Promise<ObserveResponse | null>;
};

/** Default poll cadence when awaiting an out-of-process WorkerResult. A fixed
 *  interval, not backoff. */
const WORKER_RESULT_POLL_INTERVAL_MS = 1000;

/** Default deadline on the WorkerResult await — 30 minutes. An out-of-process
 *  worker that crashes between dispatch and writing its WorkerResult row would
 *  otherwise hang the oversight chain indefinitely. Callers can override via `timeoutMs` on `awaitWorkerResult`;
 *  pass `0` for no timeout (only safe when the worker runs in-process). */
const WORKER_RESULT_AWAIT_TIMEOUT_MS = 30 * 60 * 1000;

/** Fields projected from a WorkerResult row — enough to hand the reviewer the
 *  worker's output (and confirm the session) without a second fetch. */
const WORKER_RESULT_FIELDS = { sessionId: true, output: true } as const;

/**
 * Scope a query to one session's WorkerResult rows. The WhereClause grammar is
 * operator-keyed (`{ field: { eq: value } }`, mirrored from loadContext's
 * WorkerResult filter) — a BARE `{ sessionId }` is NOT an equality predicate,
 * so the poll would silently never resolve. The downstream `.find` re-check by
 * sessionId still stands as the defensive client-side filter (per loadContext's
 * "never depend on the substrate honouring the where-clause"), but the
 * predicate must be well-formed first.
 */
const WORKER_RESULT_WHERE = (sessionId: string) => ({ where: { sessionId: { eq: sessionId } } });

/** Minimal projection of a WorkerResult row as a poll query returns it. */
interface WorkerResultRow {
  sessionId?: string;
  output?: string;
}

/**
 * Honor the SWARM_* subscribe escape hatch. Mirrors `forcePollFallback()` in
 * cli/config.ts by reading the same two env vars — oversight cannot import that
 * helper without a dependency cycle (cli depends on oversight). When either flag
 * is truthy, the consumer skips subscribeOrPoll and runs its own poll, which
 * checks once immediately before the interval starts. (Substrate's client has
 * no push channel, so both paths poll.)
 */
function subscribeDisabledByFlag(): boolean {
  return isTruthyEnv(process.env.SWARM_DISABLE_SUBSCRIBE) || isTruthyEnv(process.env.SWARM_POLL_FALLBACK);
}

/** Project's standard truthy-string convention (mirrors cli/config.ts): set and
 *  not one of "", "0", "false", "off" (case-insensitive). The canonical
 *  implementation in `cli/config.ts forcePollFallback()` does NOT call
 *  `.trim()` before `.toLowerCase()`, so this copy must not either — otherwise
 *  `SWARM_DISABLE_SUBSCRIBE=" 1 "` (whitespace-padded) would enable the manual
 *  override here but not in the CLI's auto-detection, splitting behaviour
 *  across the two consumers of the same env var. */
function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const normalized = value.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

// TRUST BOUNDARY — graduated deferral/deviation verdicts:
// completed_with_notes and completed_with_deferrals rely on LLM judgment by the
// Reviewer (and Arbiter) to determine whether a documented deviation is legitimate
// or a HUMAN-DEFERRED label is warranted. A worker output that mimics the expected
// evidence format (e.g. fabricated file:line citations or false HUMAN-DEFERRED labels)
// could steer the Reviewer toward a success verdict for genuinely failing work.
// This is an inherent property of LLM-evaluated oversight — the Reviewer is instructed
// to verify independently ("read the evidence files yourself"), but cannot be made
// immune to adversarial content in the worker's output. Operators should treat these
// two verdicts as "success with caveats noted for human review" rather than "fully
// verified pass." The operator surfacing of deferrals in the close-goal PR body is
// the intended human checkpoint for these cases.

/**
 * How a reviewer reports what it left for a person. Swarm lists `deferred` on
 * the goal's pull request, on its source item and in the run summary, so a
 * deferral is never buried in the reasons.
 */
const LEFT_FOR_PERSON_FIELDS = `
- "deferred": one line per item left for a person (completed_with_deferrals): what remains, and why only a person can do it. Each line must stand on its own, since it is listed on the pull request. [] when nothing is deferred.
- "notes": one line per documented deviation you accepted (completed_with_notes). [] when there are none.`;

const REVIEWER_SYSTEM_PROMPT = `You are a code review auditor. You will receive:
1. The swarm's expectations for this task (mode file contents).
2. The original task/prompt.
3. The worker agent's output.

Your job is to evaluate whether the worker's output meets the swarm's expectations.

IMPORTANT: You MUST respond with ONLY a JSON object. No markdown, no explanation, no text before or after. Your entire response must be valid JSON.

Choose exactly one verdict:
- "approved" — every acceptance criterion strictly met
- "completed_with_notes" — after reading the evidence files yourself, you judge that all ACs are met, and the worker documented a deviation from the specified behavior with a file-path or line-number citation explaining why it is acceptable or by-design (e.g. "deviation_reason:", a "src/foo.ts:L42" citation, or an explanation of expected behavior for the test environment)
- "completed_with_deferrals" — after reading the evidence files yourself, you judge that all agent-feasible ACs pass, and the remaining items are deferred because they genuinely require credentials, external system access, or human judgment that the agent cannot have; evaluate whether the deferral reason is legitimate, not just whether the label is present
- "rejected" — at least one AC failed with no acceptable deviation or deferral

Evaluate independently. Do not simply accept the worker's claims about its own output — read the evidence files and verify each criterion yourself.

Respond with ONLY this JSON:
{"verdict": "approved" | "completed_with_notes" | "completed_with_deferrals" | "rejected", "reasons": ["..."], "suggestions": [], "deferred": [], "notes": []}

The reasons, suggestions, deferred and notes fields must be arrays of strings.
${LEFT_FOR_PERSON_FIELDS}`;

const ARBITER_SYSTEM_PROMPT = `You are an arbiter resolving a disagreement between a worker agent and a reviewer agent.

You will receive:
1. The original task.
2. The worker's output.
3. The reviewer's rejection reasons.
4. The worker's revised output (if a retry happened).

Choose exactly one verdict:
- "approved" — the worker's output is acceptable and all ACs were strictly met.
- "completed_with_notes" — the worker documented an architectural deviation with a file-path or line citation explaining why it is acceptable or by-design; the reviewer's concern about the deviation is not a genuine failure.
- "completed_with_deferrals" — the worker explicitly deferred items as HUMAN-DEFERRED because they require credentials or human judgment outside the agent's scope; the remaining ACs all passed.
- "rejected" — the reviewer's rejection is justified; the output needs more work.
- "escalate" — the situation is ambiguous and needs human judgment.

Respond with a JSON object:
{
  "verdict": "approved" | "completed_with_notes" | "completed_with_deferrals" | "rejected" | "escalate",
  "reasoning": "brief explanation"
}`;

interface ReviewResponse {
  verdict: ReviewVerdict;
  reasons: string[];
  suggestions: string[];
  /** Items left for a person: the reviewer's own list, or what
   *  {@link extractDeferred} finds in its reasons. */
  deferred: string[];
  /** Deviations the reviewer accepted. */
  notes: string[];
}

/** A JSON field as a list of non-empty strings; anything else is []. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/** A reviewer's phrasing for an item left to a person. */
const DEFERRAL_MARKER = /\b(HUMAN-DEFERRED|deferred to (a |the )?(person|human|people|operator)|needs? (a |the )?(person|human))\b/i;
/** "Nothing was deferred to a person", "Deferred to a person: none" and the like. */
const NO_DEFERRAL = /\b(no|nothing|none|not)\b[^.]{0,40}\b(HUMAN-DEFERRED|deferred|needs? (a |the )?(person|human))\b|\b(HUMAN-DEFERRED|deferred to (a |the )?(person|human|people|operator)|needs? (a |the )?(person|human))\b\s*[:—–-]?\s*(none|nothing|n\/a)\b/i;
/** A leading label, dropped so the item reads on its own. */
const DEFERRAL_LABEL = /^\s*(HUMAN-DEFERRED|deferred to (a |the )?(person|human|people|operator)|needs? (a |the )?(person|human))\s*[:—–-]\s*/i;

/**
 * The fallback for reviewers that put deferrals in their reasons rather than
 * in `deferred`: every sentence that says something was deferred to a person
 * ("Deferred to a person: …", "HUMAN-DEFERRED: …", "… needs a person …"),
 * minus sentences saying nothing was, with a leading label dropped.
 */
export function extractDeferred(reasons: readonly string[]): string[] {
  const items: string[] = [];
  for (const reason of reasons) {
    for (const sentence of reason.split(/(?<=[.!?])\s+|\n+/)) {
      const text = sentence.trim();
      if (!text || !DEFERRAL_MARKER.test(text) || NO_DEFERRAL.test(text)) continue;
      const item = text.replace(DEFERRAL_LABEL, "").trim();
      if (item) items.push(item.charAt(0).toUpperCase() + item.slice(1));
    }
  }
  return items;
}

/** `lines` without repeats; case and spacing don't count. */
function uniqueLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Validate worker output before sending it to the reviewer.
 * Catches empty, malformed, or trivially short output so we don't waste
 * a reviewer API call on obviously bad results (e.g. timeouts, crashes).
 */
export function validateWorkerOutput(output: string): { valid: true } | { valid: false; reason: string } {
  if (!output || !output.trim()) {
    return { valid: false, reason: "Worker produced empty output (likely timeout or crash)" };
  }

  const trimmed = output.trim();

  // Check if output is just a JSON error object
  if (trimmed.startsWith("{") && trimmed.includes('"error"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if ("error" in parsed) {
        return { valid: false, reason: "Worker returned error object (details redacted for safety)" };
      }
    } catch {
      // Not valid JSON — fall through to length check
    }
  }

  if (trimmed.length < 50) {
    return { valid: false, reason: `Worker output too short (${trimmed.length} chars) — likely incomplete` };
  }

  return { valid: true };
}

interface ArbiterResponse {
  verdict: ArbiterVerdict;
  reasoning: string;
}

/**
 * Capture the current git diff in a working directory.
 * Used to give API-only reviewers/arbiters visibility into actual code changes.
 * Truncated to 50KB to avoid blowing up the context window.
 */
export function captureGitDiff(workingDirectory: string): string {
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

  // NOTE: `git diff HEAD` captures uncommitted changes only. If the worker backend
  // committed its changes before oversight runs, this returns "" — which is benign
  // (falls back to text-only review) but can be surprising.
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--no-color", "HEAD"], {
      cwd: workingDirectory, encoding: "utf-8", stdio,
    });
  } catch {
    try {
      diff = execFileSync("git", ["diff", "--no-color"], {
        cwd: workingDirectory, encoding: "utf-8", stdio,
      });
    } catch {
      return "";
    }
  }

  // List untracked files (new files not yet staged)
  let untrackedSection = "";
  try {
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: workingDirectory, encoding: "utf-8", stdio,
    }).trim();
    if (untracked) {
      untrackedSection = "\n\n# Untracked files (not in diff):\n" + untracked;
    }
  } catch { /* ignore */ }

  const combined = (diff + untrackedSection).trim();
  if (!combined) return "";
  return `\n\n## Code Changes (git diff)\n\`\`\`diff\n${combined.slice(0, 50000)}\n\`\`\``;
}

const BACKEND_REVIEWER_PROMPT = `You are a code reviewer. Your job is to evaluate the worker's changes against the swarm's expectations.

## Instructions
1. Read the files that were created or modified in this directory
2. Check if a build/test command is available and run it
3. Evaluate whether the changes satisfy the task requirements
4. Look for: missing files, incorrect patterns, violated constraints, untested code
5. Do NOT modify any files — you are evaluating only

## Verdict choices
- "approved" — every requirement strictly met
- "completed_with_notes" — all requirements met but the worker documented an architectural deviation with a file-path or line citation explaining why it is acceptable (look for "PASS (with ... deviation)", "deviation_reason:", file:line citations near a deviation description)
- "completed_with_deferrals" — all agent-feasible requirements pass; some items are HUMAN-DEFERRED because they require credentials or human access outside the agent's scope (look for "HUMAN-DEFERRED" labels)
- "rejected" — at least one requirement failed with no acceptable deviation or deferral

## CRITICAL — Output Format
After reviewing, your FINAL response MUST be ONLY this JSON object — no other text:
{"verdict": "approved" | "completed_with_notes" | "completed_with_deferrals" | "rejected", "reasons": ["reason1", "reason2"], "deferred": [], "notes": []}
${LEFT_FOR_PERSON_FIELDS}
The JSON will be machine-parsed. Any text outside the JSON will cause a parse failure.`;

const BACKEND_ARBITER_PROMPT = `You are an arbiter resolving a disagreement between a worker agent and a reviewer agent.

## Instructions
1. Read the files that were created or modified in this directory
2. Evaluate the worker's output against the reviewer's concerns
3. Determine if the reviewer's rejection is justified
4. Do NOT modify any files — you are evaluating only

## Verdict choices
- "approved" — the worker's output is correct and the reviewer's concern is not justified
- "completed_with_notes" — the worker documented an acceptable architectural deviation; the reviewer's concern is about a deviation, not a genuine failure
- "completed_with_deferrals" — the worker explicitly deferred items as HUMAN-DEFERRED with a scope reason; those items are not failures
- "rejected" — the reviewer is right; the output needs more work
- "escalate" — the situation is ambiguous and needs human judgment

## CRITICAL — Output Format
After evaluating, your FINAL response MUST be ONLY this JSON object — no other text:
{"verdict": "approved" | "completed_with_notes" | "completed_with_deferrals" | "rejected" | "escalate", "reasoning": "brief explanation"}

The JSON will be machine-parsed. Any text outside the JSON will cause a parse failure.`;

export type { ArbiterPolicy };

const SIGNOFF_INTRO = `You are an arbiter giving an independent sign-off on work a reviewer has approved.

The reviewer is not the last word. Check the work yourself against the original task and its acceptance criteria. Approve only what you have verified.`;

const SIGNOFF_VERDICTS = `## Verdict choices
- "approved" — you verified the work meets the task and every acceptance criterion
- "completed_with_notes" — the work is acceptable with a documented, cited deviation
- "completed_with_deferrals" — the remaining items were explicitly deferred to a person, with a reason
- "rejected" — the reviewer was wrong to approve; the work does not meet the task
- "escalate" — you cannot tell; a person must decide`;

const ARBITER_SIGNOFF_SYSTEM_PROMPT = `${SIGNOFF_INTRO}

You will receive the original task, the worker's output and the reviewer's approval.

${SIGNOFF_VERDICTS}

Respond with a JSON object:
{
  "verdict": "approved" | "completed_with_notes" | "completed_with_deferrals" | "rejected" | "escalate",
  "reasoning": "brief explanation"
}`;

const BACKEND_ARBITER_SIGNOFF_PROMPT = `${SIGNOFF_INTRO}

## Instructions
1. Read the files that were created or modified in this directory
2. Verify the work against the original task and its acceptance criteria
3. Do NOT modify any files — you are evaluating only

${SIGNOFF_VERDICTS}

## CRITICAL — Output Format
After evaluating, your FINAL response MUST be ONLY this JSON object — no other text:
{"verdict": "approved" | "completed_with_notes" | "completed_with_deferrals" | "rejected" | "escalate", "reasoning": "brief explanation"}

The JSON will be machine-parsed. Any text outside the JSON will cause a parse failure.`;

/**
 * The project's binding rules, put ahead of a reviewer's or arbiter's prompt;
 * nothing when the project has none. Workers always load these rules, and the
 * roles that judge the work need them just as much.
 */
function bindingRulesSection(bindingRules: string | undefined): string[] {
  if (!bindingRules?.trim()) return [];
  return [
    "## Project Rules (binding)",
    "The work must comply with every rule below. A violation of any of them is grounds to reject, whatever else the work gets right.",
    "",
    bindingRules.trim(),
    "",
  ];
}

/** Parameters of {@link Oversight.runFullChain}. */
export interface RunFullChainParams {
  modeContext: string;
  /**
   * The project's binding rules (its core rules and its constraints file),
   * given to the reviewer and the arbiter in full ahead of everything else.
   */
  bindingRules?: string;
  /**
   * The same rules delivered by index (context.rules, over budget): for a
   * reviewer or an arbiter on a direct-execution backend, which can read the
   * indexed rules by line range. Roles on the API path get `bindingRules`.
   */
  bindingRulesIndexed?: string;
  originalTask: string;
  workerOutput: string;
  maxRetries: number;
  sessionId: string;
  onRetry?: (reasons: string[], attempt: number) => Promise<string>;
  reviewerBackend?: IWorkerBackend;
  arbiterBackend?: IWorkerBackend;
  workingDirectory?: string;
  authorId?: string;
  /**
   * The worker's document index (context.pull), with the sections it read,
   * for a reviewer running on a backend. A function, so a review after a
   * retry sees that attempt's reads. Returns "" when there is none.
   */
  documentIndex?: () => string;
  /** The read guard the worker's session had; the reviewer's session gets the same. */
  documentGuard?: DocumentGuard;
  /**
   * Opt in to awaiting an out-of-process worker. When set, the chain resolves
   * the worker output via {@link awaitWorkerResult} — subscribing to the
   * session's WorkerResult (push over WS, poll-by-sessionId on HTTP) when
   * `workerOutput` is empty. Defaults to the synchronous case: the supplied
   * `workerOutput` is used verbatim.
   */
  workerOutOfProcess?: boolean;
}

/** How a backend-run role is labelled: its model when it names one. */
function backendLabel(backend: IWorkerBackend): string {
  return backend.model ? `${backend.type}:${backend.model}` : `${backend.type}-backend`;
}

export class Oversight implements OversightRunner {
  private reviewerProvider: ModelProvider;
  private reviewerModel: string;
  private arbiterProvider: ModelProvider;
  private arbiterModel: string;
  private arbiterPolicy: ArbiterPolicy;
  private eventBus?: ISwarmEventBus;
  private substrateClient?: SubstrateClient;
  private taskBuffer?: TaskTelemetryBuffer;

  constructor(params: {
    reviewerProvider: ModelProvider;
    reviewerModel: string;
    arbiterProvider: ModelProvider;
    arbiterModel: string;
    /** Default "on_disagreement". "always" adds an arbiter sign-off to every approval. */
    arbiterPolicy?: ArbiterPolicy;
    eventBus?: ISwarmEventBus;
    substrateClient?: SubstrateClient;
  }) {
    this.reviewerProvider = params.reviewerProvider;
    this.reviewerModel = params.reviewerModel;
    this.arbiterProvider = params.arbiterProvider;
    this.arbiterModel = params.arbiterModel;
    this.arbiterPolicy = params.arbiterPolicy ?? "on_disagreement";
    this.eventBus = params.eventBus;
    this.substrateClient = params.substrateClient;
  }

  /**
   * Attach (or detach with `undefined`) a per-task buffer. While attached, the
   * WorkerResult and the (final) ReviewVerdict are buffered for the coordinator's
   * atomic `persistTaskTelemetry` flush instead of being written per-row here.
   *
   * The exception-path rows the single-envelope resolver has no slot for —
   * per-retry ReviewVerdicts and the ArbiterDecision — are not written as
   * dedicated Substrate entities in buffered mode; their detail still flows to the
   * telemetry event stream via the `oversight:*`/`retry` bus events, and the
   * verdict OUTCOME (which the cold-test parity gate checks) is returned in
   * `OversightResult` exactly as before. Detaching restores the immediate
   * per-row behavior.
   */
  setTaskBuffer(buffer?: TaskTelemetryBuffer): void {
    this.taskBuffer = buffer;
  }

  /**
   * Fire-and-forget Substrate mutation. If the client is not configured or
   * the mutation fails, log a warning but never block the oversight chain.
   */
  private async substrateMutate<T>(
    mutationName: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.substrateClient) return null;
    try {
      return await this.substrateClient.mutate<T>(mutationName, params, { id: true });
    } catch (err) {
      console.warn(
        `[swarm] Substrate ${mutationName} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Emit a cheap, fire-and-forget plane Observation tagged with the oversight
   * role ('reviewer' | 'arbiter'). Extends the worker-role observation surface
   * (emitted from core/swarm.ts) so a scheduled drainstop can promote
   * high-signal entries from all three roles into the durable claude store.
   *
   * Three guarantees keep this off the oversight critical path, matching the
   * worker-side helper:
   *   1. No-op when the client has no plane (file-only mode / older client).
   *   2. Not awaited — the promise is kicked off and its rejection swallowed.
   *   3. observe() already degrades gracefully (logs + returns null on
   *      transport error); the try/catch guards a missing helper or sync throw.
   *
   * Content stays short — verdict + a truncated reason tail, never the full
   * worker output or diff.
   */
  private observePlane(
    role: "reviewer" | "arbiter",
    event: string,
    content: string,
    confidence: number,
    kind: string,
  ): void {
    const client = this.substrateClient as ObserveCapable | undefined;
    if (!client || typeof client.observe !== "function") return;
    try {
      void client
        .observe({ kind, content: content.slice(0, 160), confidence, tags: [role, event] })
        .catch(() => {
          // Observations are best-effort; swallow rejections.
        });
    } catch {
      // Never let an observation break the oversight flow.
    }
  }

  /**
   * Observe a reviewer verdict. A rejection carries more signal than a clean
   * approval (mirrors the tool-failure > tool-completion weighting on the
   * worker side), so it scores higher and rides the 'concern' kind; rejection
   * reasons are appended (truncated) to the content.
   */
  private observeReviewVerdict(verdict: string, reasons: string[]): void {
    const success = SUCCESS_VERDICTS.has(verdict as ReviewVerdict);
    const confidence = success ? 55 : 70;
    const kind = success ? "lifecycle" : "concern";
    const reasonTail = success || reasons.length === 0 ? "" : `: ${reasons.slice(0, 2).join("; ")}`;
    this.observePlane("reviewer", "verdict", `reviewer ${verdict}${reasonTail}`, confidence, kind);
  }

  /**
   * Observe an arbiter resolution. The arbiter only fires on a worker/reviewer
   * disagreement, so every resolution is inherently high signal; an escalation
   * (human judgment required) outranks an autonomous resolution.
   */
  private observeArbiterDecision(verdict: string, reasoning: string): void {
    const escalate = verdict === "escalate";
    const confidence = escalate ? 80 : 70;
    const kind = escalate ? "concern" : "lifecycle";
    this.observePlane("arbiter", "resolution", `arbiter ${verdict}: ${reasoning}`, confidence, kind);
  }

  /**
   * Record a ReviewVerdict — buffered for the atomic flush (last write wins, so
   * the final verdict is the one persisted) when a task buffer is attached, or
   * created per-row otherwise. Returns the created entity id (per-row path) or
   * `null` (buffered path — the atomic resolver assigns the id at flush time).
   */
  private async recordReviewVerdict(input: {
    sessionId: string;
    workerResultId: string;
    verdict: string;
    reasons: string[];
    suggestions: string[];
    attempt: number;
    timestamp: string;
    authorId?: string;
  }): Promise<number | null> {
    const reviewVerdictInput: ReviewVerdictInput = {
      sessionId: input.sessionId,
      workerResultId: input.workerResultId,
      verdict: input.verdict,
      reasons: JSON.stringify(input.reasons),
      suggestions: JSON.stringify(input.suggestions),
      attempt: input.attempt,
      // Author attribution threads through unchanged — taxonomy now, enforcement
      // deferred. Defaults to undefined for callers that don't supply it.
      authorId: input.authorId,
      timestamp: input.timestamp,
    };
    if (this.taskBuffer) {
      this.taskBuffer.setReviewVerdict(reviewVerdictInput);
      return null;
    }
    // `attempt` stays a number: Substrate's field.number() refuses a string.
    const entity = await this.substrateMutate<{ id: number }>("createReviewVerdict", { ...reviewVerdictInput });
    return entity?.id ?? null;
  }

  /**
   * Determine whether review should be skipped based on the review policy.
   */
  shouldSkipReview(
    policy: ReviewPolicy,
    taskDescription: string,
  ): { skip: boolean; reason?: string } {
    const lower = taskDescription.toLowerCase();

    // Use skip_review patterns from the policy, falling back to defaults
    const policyPatterns = policy?.oversight?.review_policy?.skip_review ?? [];
    const skipPatterns = policyPatterns.length > 0
      ? policyPatterns
      : ["documentation", "docs only", "comment", "readme"];

    for (const pattern of skipPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return { skip: true, reason: `Matched skip pattern: ${pattern}` };
      }
    }

    return { skip: false };
  }

  /**
   * Run the reviewer on a worker's output.
   *
   * When a reviewerBackend with direct execution support is provided, the
   * reviewer runs through that backend (e.g. Claude Code) with filesystem
   * access. Otherwise falls back to a raw API call with the worker's text
   * output (augmented with git diff when a workingDirectory is available).
   */
  async review(
    modeContext: string,
    originalTask: string,
    workerOutput: string,
    opts?: {
      reviewerBackend?: IWorkerBackend;
      workingDirectory?: string;
      sessionId?: string;
      authorId?: string;
      bindingRules?: string;
      /** See RunFullChainParams.bindingRulesIndexed. */
      bindingRulesIndexed?: string;
      /** See RunFullChainParams.documentIndex. */
      documentIndex?: () => string;
      /** See RunFullChainParams.documentGuard. */
      documentGuard?: DocumentGuard;
    },
  ): Promise<ReviewResponse> {
    const reviewerBackend = opts?.reviewerBackend;
    const workingDirectory = opts?.workingDirectory;

    // Backend path: reviewer runs through Claude Code (or similar) with file access
    // No git diff needed — the backend has direct filesystem access.
    if (reviewerBackend?.supportsDirectExecution && workingDirectory) {
      // The worker's document index, with the sections it read, so the
      // reviewer reads the same documents the same way (context.pull).
      const documentIndex = opts?.documentIndex?.() ?? "";
      const backendPrompt = [
        ...bindingRulesSection(opts?.bindingRulesIndexed ?? opts?.bindingRules),
        "## Swarm Expectations",
        modeContext,
        "",
        "## Original Task",
        originalTask,
        "",
        "## Worker's Summary",
        workerOutput,
        ...(documentIndex !== "" ? ["", documentIndex] : []),
      ].join("\n");

      try {
        const backendResult = await reviewerBackend.execute({
          task: backendPrompt,
          workingDirectory,
          swarmContext: BACKEND_REVIEWER_PROMPT,
          maxTurns: 30,
          ...(opts?.documentGuard ? { documents: opts.documentGuard } : {}),
        });
        this.eventBus?.emit("transcript", {
          sessionId: opts?.sessionId ?? "",
          role: "reviewer" as const,
          timestamp: new Date().toISOString(),
          prompt: backendPrompt,
          response: backendResult.output,
          // tokens not available from Claude Code backend
          backend: reviewerBackend.type,
          authorId: opts?.authorId,
        });
        return this.parseReviewResponse(backendResult.output);
      } catch (err) {
        // An expired login stops the run; it never falls back to an API key.
        if (isLoginExpired(err)) throw err;
        // Fall through to API path on backend failure
        console.warn(
          `[swarm] Reviewer backend failed, falling back to API: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // API path: raw LLM call with worker output text + git diff
    // Only capture git diff on the API path — backend has direct filesystem access.
    const gitDiff = workingDirectory ? captureGitDiff(workingDirectory) : "";

    const prompt = [
      ...bindingRulesSection(opts?.bindingRules),
      "## Swarm Expectations (Mode File)",
      modeContext,
      "",
      "## Original Task",
      originalTask,
      "",
      "## Worker Output",
      workerOutput,
      gitDiff,
      "",
      "Evaluate the worker's output against the swarm's expectations. Respond with JSON only.",
    ].join("\n");

    try {
      const result: ExecutionResult = await this.reviewerProvider.execute(
        { systemContext: REVIEWER_SYSTEM_PROMPT, prompt },
        this.reviewerModel,
      );

      this.eventBus?.emit("transcript", {
        sessionId: opts?.sessionId ?? "",
        role: "reviewer" as const,
        timestamp: new Date().toISOString(),
        prompt,
        response: result.output,
        tokens: { input: result.tokens.input, output: result.tokens.output },
        backend: this.reviewerModel,
        authorId: opts?.authorId,
      });

      return this.parseReviewResponse(result.output);
    } catch (err) {
      // Rate limit: pause and retry once before rejecting
      if (err instanceof Error && (err.message.includes("rate limit") || err.message.includes("resets soon") || err.message.includes("429") || err.name === "RateLimitError")) {
        console.warn(`[swarm] Reviewer hit rate limit: ${err.message}. Pausing 60s and retrying...`);
        await new Promise(resolve => setTimeout(resolve, 60_000));
        try {
          const retryResult: ExecutionResult = await this.reviewerProvider.execute(
            { systemContext: REVIEWER_SYSTEM_PROMPT, prompt },
            this.reviewerModel,
          );
          return this.parseReviewResponse(retryResult.output);
        } catch (retryErr) {
          console.warn(`[swarm] Reviewer retry also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
        }
      }

      // API provider unavailable (e.g., no API key when using claude-code).
      // Fail closed — silently approving defeats the purpose of oversight.
      console.warn(
        `[swarm] Reviewer API fallback failed: ${err instanceof Error ? err.message : String(err)}. Rejecting for safety.`,
      );
      return {
        verdict: "rejected",
        reasons: ["Reviewer API unavailable — rejected for safety. Configure ANTHROPIC_API_KEY or ensure the claude-code backend handles reviews."],
        suggestions: [],
        deferred: [],
        notes: [],
      };
    }
  }

  /**
   * Run the arbiter to resolve a worker/reviewer disagreement.
   *
   * When an arbiterBackend with direct execution support is provided, the
   * arbiter runs through that backend with filesystem access. Otherwise
   * falls back to a raw API call (augmented with git diff).
   */
  async arbitrate(
    originalTask: string,
    workerOutput: string,
    rejectionReasons: string[],
    opts?: {
      arbiterBackend?: IWorkerBackend;
      workingDirectory?: string;
      sessionId?: string;
      authorId?: string;
      /** "signoff": the reviewer approved and the arbiter confirms or overturns. */
      mode?: "disagreement" | "signoff";
      /** The project's binding rules; see RunFullChainParams.bindingRules. */
      bindingRules?: string;
      /** See RunFullChainParams.bindingRulesIndexed. */
      bindingRulesIndexed?: string;
    },
  ): Promise<ArbiterResponse> {
    const arbiterBackend = opts?.arbiterBackend;
    const signoff = opts?.mode === "signoff";
    const reviewerHeading = signoff ? "## Reviewer Approval" : "## Reviewer Rejection Reasons";
    const workingDirectory = opts?.workingDirectory;
    const arbiterSessionId = opts?.sessionId ?? "";

    // Backend path: arbiter runs through Claude Code (or similar) with file access
    // No git diff needed — the backend has direct filesystem access.
    if (arbiterBackend?.supportsDirectExecution && workingDirectory) {
      const backendPrompt = [
        ...bindingRulesSection(opts?.bindingRulesIndexed ?? opts?.bindingRules),
        "## Original Task",
        originalTask,
        "",
        "## Worker Output",
        workerOutput,
        "",
        reviewerHeading,
        rejectionReasons.map((r) => `- ${r}`).join("\n"),
      ].join("\n");

      try {
        const backendResult = await arbiterBackend.execute({
          task: backendPrompt,
          workingDirectory,
          swarmContext: signoff ? BACKEND_ARBITER_SIGNOFF_PROMPT : BACKEND_ARBITER_PROMPT,
          maxTurns: 30,
        });
        this.eventBus?.emit("transcript", {
          sessionId: arbiterSessionId,
          role: "arbiter" as const,
          timestamp: new Date().toISOString(),
          prompt: backendPrompt,
          response: backendResult.output,
          // tokens not available from Claude Code backend
          backend: arbiterBackend.type,
          authorId: opts?.authorId,
        });
        return this.parseArbiterResponse(backendResult.output);
      } catch (err) {
        // An expired login stops the run; it never falls back to an API key.
        if (isLoginExpired(err)) throw err;
        // Fall through to API path on backend failure
        console.warn(
          `[swarm] Arbiter backend failed, falling back to API: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // API path: raw LLM call with worker output text + git diff
    // Only capture git diff on the API path — backend has direct filesystem access.
    const gitDiff = workingDirectory ? captureGitDiff(workingDirectory) : "";

    const prompt = [
      ...bindingRulesSection(opts?.bindingRules),
      "## Original Task",
      originalTask,
      "",
      "## Worker Output",
      workerOutput,
      "",
      reviewerHeading,
      rejectionReasons.map((r) => `- ${r}`).join("\n"),
      gitDiff,
      "",
      "Decide whether the worker's output is acceptable, needs more work, or should be escalated to a human. Respond with JSON only.",
    ].join("\n");

    try {
      const result: ExecutionResult = await this.arbiterProvider.execute(
        { systemContext: signoff ? ARBITER_SIGNOFF_SYSTEM_PROMPT : ARBITER_SYSTEM_PROMPT, prompt },
        this.arbiterModel,
      );

      this.eventBus?.emit("transcript", {
        sessionId: arbiterSessionId,
        role: "arbiter" as const,
        timestamp: new Date().toISOString(),
        prompt,
        response: result.output,
        tokens: { input: result.tokens.input, output: result.tokens.output },
        backend: this.arbiterModel,
        authorId: opts?.authorId,
      });

      return this.parseArbiterResponse(result.output);
    } catch (err) {
      // Rate limit: pause and retry once before escalating
      if (err instanceof Error && (err.message.includes("rate limit") || err.message.includes("resets soon") || err.message.includes("429") || err.name === "RateLimitError")) {
        console.warn(`[swarm] Arbiter hit rate limit: ${err.message}. Pausing 60s and retrying...`);
        await new Promise(resolve => setTimeout(resolve, 60_000));
        try {
          const retryResult: ExecutionResult = await this.arbiterProvider.execute(
            { systemContext: signoff ? ARBITER_SIGNOFF_SYSTEM_PROMPT : ARBITER_SYSTEM_PROMPT, prompt },
            this.arbiterModel,
          );
          return this.parseArbiterResponse(retryResult.output);
        } catch (retryErr) {
          console.warn(`[swarm] Arbiter retry also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
        }
      }

      // API provider unavailable — escalate since arbiter can't make a decision
      console.warn(
        `[swarm] Arbiter API fallback failed: ${err instanceof Error ? err.message : String(err)}. Escalating.`,
      );
      return { verdict: "escalate", reasoning: "Arbiter API unavailable" };
    }
  }

  /**
   * Resolve the worker's output for a session before the reviewer/arbiter runs.
   *
   * Fast-path (synchronous case, never regressed): when the worker ran in-process
   * and its output is already in hand (`localOutput` non-empty), return it
   * immediately — no Substrate round trip, no poll.
   *
   * Cross-process path: when the worker runs out-of-process there is no local
   * output, so the oversight chain must wait for the worker's WorkerResult row to
   * land in Substrate. The query-by-sessionId read runs once at once, then on
   * {@link subscribeOrPoll}'s fixed interval (the Substrate client has no push
   * channel, so its message handler is never called). The SWARM_* escape hatch
   * runs the same poll without subscribeOrPoll. Resolves on the first WorkerResult for
   * `sessionId`, then unsubscribes. Without a client there is nothing to
   * await — returns the (empty) local output unchanged.
   */
  async awaitWorkerResult(params: {
    sessionId: string;
    localOutput?: string;
    pollIntervalMs?: number;
    /** Hard deadline in ms before the await rejects with a timeout error. Defaults
     *  to {@link WORKER_RESULT_AWAIT_TIMEOUT_MS}. Pass `0` to disable (only safe
     *  for in-process workers). Without this, an out-of-process worker crashing
     *  between dispatch and writing its WorkerResult row hangs the chain forever. */
    timeoutMs?: number;
  }): Promise<string> {
    // Fast-path — do not regress the synchronous in-memory case.
    if (params.localOutput && params.localOutput.trim()) {
      return params.localOutput;
    }
    const client = this.substrateClient;
    if (!client) return params.localOutput ?? "";

    const { sessionId } = params;
    const intervalMs = params.pollIntervalMs ?? WORKER_RESULT_POLL_INTERVAL_MS;
    const timeoutMs = params.timeoutMs ?? WORKER_RESULT_AWAIT_TIMEOUT_MS;

    // The query-by-sessionId read shared by the subscribeOrPoll path AND the
    // manual escape-hatch path. Returns the output once a row exists, else null.
    const pollOnce = async (): Promise<string | null> => {
      const rows = await client.query<WorkerResultRow>(
        "WorkerResult",
        WORKER_RESULT_WHERE(sessionId),
        WORKER_RESULT_FIELDS,
      );
      const match = rows.find((r) => r.sessionId === sessionId) ?? rows[0];
      return typeof match?.output === "string" ? match.output : null;
    };

    // Manual override: an operator set SWARM_DISABLE_SUBSCRIBE / SWARM_POLL_FALLBACK,
    // so skip subscribeOrPoll and run the poll directly.
    if (subscribeDisabledByFlag()) {
      return this.pollForWorkerResult(pollOnce, intervalMs, timeoutMs, sessionId);
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let handle: SubscribeOrPollHandle | undefined;
      // Hard deadline so an out-of-process worker that crashes pre-WorkerResult
      // cannot strand the oversight chain. `0` disables (in-process callers
      // only).
      const timeoutHandle = timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            handle?.unsubscribe();
            reject(
              new Error(
                `awaitWorkerResult timed out after ${timeoutMs}ms for sessionId=${sessionId} — the worker may have crashed before writing its WorkerResult row, or the Substrate poll path is stuck.`,
              ),
            );
          }, timeoutMs)
        : undefined;
      const finish = (output: string): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        handle?.unsubscribe();
        resolve(output);
      };
      const tick = async (): Promise<void> => {
        if (settled) return;
        const output = await pollOnce();
        if (output !== null) finish(output);
      };
      // Check once at once: a row that has already landed is found without
      // waiting an interval (the latency the old push subscription had).
      void tick().catch((err) => {
        console.warn(
          `[swarm] WorkerResult poll failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      subscribeOrPoll(
        client,
        { typeName: "WorkerResult", params: WORKER_RESULT_WHERE(sessionId), fields: WORKER_RESULT_FIELDS },
        () => {
          // Never called: Substrate's client polls only. The poll below resolves.
        },
        { poll: tick, intervalMs },
      ).then(
        (h) => {
          handle = h;
          // A poll tick (or the deadline) can settle before this handle
          // resolves — in that case finish() already ran with no handle to
          // cancel, so tear down now.
          if (settled) handle.unsubscribe();
        },
        (err) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        },
      );
    });
  }

  /**
   * Poll-only wait for a WorkerResult, used on the SWARM_* escape-hatch path.
   * Fixed interval, no backoff. Checks once immediately, then on each tick. Hard
   * deadline at `timeoutMs` (0 disables) so an out-of-process worker that
   * crashes pre-WorkerResult cannot strand the oversight chain.
   */
  private async pollForWorkerResult(
    pollOnce: () => Promise<string | null>,
    intervalMs: number,
    timeoutMs: number,
    sessionId: string,
  ): Promise<string> {
    const immediate = await pollOnce();
    if (immediate !== null) return immediate;
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const deadline = timeoutMs > 0
        ? setTimeout(() => {
            if (timer) clearInterval(timer);
            reject(
              new Error(
                `pollForWorkerResult timed out after ${timeoutMs}ms for sessionId=${sessionId} — the worker may have crashed before writing its WorkerResult row, or the Substrate query path is stuck.`,
              ),
            );
          }, timeoutMs)
        : undefined;
      timer = setInterval(() => {
        void pollOnce()
          .then((output) => {
            if (output !== null) {
              if (timer) clearInterval(timer);
              if (deadline) clearTimeout(deadline);
              resolve(output);
            }
          })
          .catch((err) => {
            // Keep polling — a transient query failure must not strand the chain.
            // The deadline still fires if the failure is permanent.
            console.warn(
              `[swarm] WorkerResult poll tick failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }, intervalMs);
    });
  }

  /**
   * Run the full oversight flow: review → retry → arbiter → escalate.
   */
  async runFullChain(params: RunFullChainParams): Promise<OversightResult> {
    const startTime = Date.now();
    const workerSessionId = params.sessionId;
    // Resolve the worker output. The synchronous case is unchanged: callers with
    // the output in hand (the default) get params.workerOutput verbatim, so an
    // empty in-process output still falls through to pre-review validation rather
    // than waiting forever. Only an explicit out-of-process dispatch awaits the
    // worker's WorkerResult row by polling; even then
    // a non-empty localOutput short-circuits the wait.
    let currentOutput = params.workerOutOfProcess
      ? await this.awaitWorkerResult({ sessionId: workerSessionId, localOutput: params.workerOutput })
      : params.workerOutput;
    let retryCount = 0;
    let latestReasons: string[] = [];
    let latestDeferred: string[] = [];

    // Pre-review validation: skip reviewer for empty/malformed initial output
    const initialValidation = validateWorkerOutput(currentOutput);
    let skipInitialReview = false;
    if (!initialValidation.valid) {
      latestReasons = [initialValidation.reason];
      skipInitialReview = true;
    }

    // Track whether backends were used for accurate telemetry reporting
    const reviewerUsedBackend = !!(params.reviewerBackend?.supportsDirectExecution);
    const arbiterUsedBackend = !!(params.arbiterBackend?.supportsDirectExecution);
    const reviewerModelLabel = reviewerUsedBackend ? backendLabel(params.reviewerBackend!) : this.reviewerModel;
    const arbiterModelLabel = arbiterUsedBackend ? backendLabel(params.arbiterBackend!) : this.arbiterModel;

    // --- WorkerResult: buffer for the atomic flush, or create per-row ---
    const workerResultInput: WorkerResultInput = {
      sessionId: workerSessionId,
      intent: "",
      output: currentOutput,
      diff: "",
      filesModified: JSON.stringify([]),
      tokenUsage: 0,
      // Author attribution threads through from the public entry point —
      // taxonomy now, enforcement deferred. Undefined for callers that omit it.
      authorId: params.authorId,
      timestamp: new Date().toISOString(),
    };
    let workerResultEntity: { id: number } | null = null;
    if (this.taskBuffer) {
      this.taskBuffer.setWorkerResult(workerResultInput);
    } else {
      // `tokenUsage` stays a number: Substrate's field.number() refuses a string.
      workerResultEntity = await this.substrateMutate<{ id: number }>("createWorkerResult", { ...workerResultInput });
    }

    // Track the latest ReviewVerdict entity id for arbiter linking
    let latestReviewVerdictId: number | null = null;

    // Initial review (skipped if pre-validation failed)
    if (!skipInitialReview) {
      const reviewerSessionId = `sess-rev-${randomUUID().slice(0, 8)}`;
      this.eventBus?.emit("oversight:start", {
        sessionId: reviewerSessionId,
        role: "reviewer",
        model: reviewerModelLabel,
        timestamp: Date.now(),
      });
      this.eventBus?.emit("agent:role", {
        sessionId: reviewerSessionId,
        role: "reviewer",
        model: reviewerModelLabel,
        provider: this.reviewerProvider.name,
        parentSessionId: workerSessionId,
        timestamp: Date.now(),
      });

      const reviewResult = await this.review(
        params.modeContext,
        params.originalTask,
        currentOutput,
        {
          reviewerBackend: params.reviewerBackend,
          workingDirectory: params.workingDirectory,
          sessionId: workerSessionId,
          authorId: params.authorId,
          bindingRules: params.bindingRules,
          bindingRulesIndexed: params.bindingRulesIndexed,
          documentIndex: params.documentIndex,
          documentGuard: params.documentGuard,
        },
      );

      // --- ReviewVerdict: buffer for the atomic flush, or create per-row ---
      latestReviewVerdictId = await this.recordReviewVerdict({
        sessionId: workerSessionId,
        workerResultId: String(workerResultEntity?.id ?? 0),
        verdict: reviewResult.verdict,
        reasons: reviewResult.reasons,
        suggestions: reviewResult.suggestions,
        attempt: 0,
        authorId: params.authorId,
        timestamp: new Date().toISOString(),
      });

      // Reviewer-role observation: verdict + (on rejection) reasons.
      this.observeReviewVerdict(reviewResult.verdict, reviewResult.reasons);

      if (SUCCESS_VERDICTS.has(reviewResult.verdict)) {
        return this.concludeApproved({
          verdict: reviewResult.verdict,
          retryCount: 0,
          reviewNotes: reviewResult.reasons,
          deferred: reviewResult.deferred,
          notes: reviewResult.notes,
          chain: params,
          workerOutput: currentOutput,
          startTime,
          arbiterModelLabel,
          workerResultId: workerResultEntity?.id,
          reviewVerdictId: latestReviewVerdictId,
        });
      }

      latestReasons = reviewResult.reasons;
      latestDeferred = reviewResult.deferred;
    }

    // Single retry loop — handles both pre-validation failures and reviewer rejections
    while (retryCount < params.maxRetries && params.onRetry) {
      retryCount++;

      this.eventBus?.emit("retry", {
        sessionId: workerSessionId,
        attempt: retryCount,
        maxRetries: params.maxRetries,
        reasons: latestReasons,
        timestamp: Date.now(),
      });

      currentOutput = await params.onRetry(latestReasons, retryCount);

      // Validate retry output before sending to reviewer
      const retryValidation = validateWorkerOutput(currentOutput);
      if (!retryValidation.valid) {
        latestReasons = [retryValidation.reason];
        continue; // skip reviewer, try again
      }

      const retryReviewerSessionId = `sess-rev-${randomUUID().slice(0, 8)}`;
      this.eventBus?.emit("oversight:start", {
        sessionId: retryReviewerSessionId,
        role: "reviewer",
        model: reviewerModelLabel,
        timestamp: Date.now(),
      });
      this.eventBus?.emit("agent:role", {
        sessionId: retryReviewerSessionId,
        role: "reviewer",
        model: reviewerModelLabel,
        provider: this.reviewerProvider.name,
        parentSessionId: workerSessionId,
        timestamp: Date.now(),
      });

      const retryReview = await this.review(
        params.modeContext,
        params.originalTask,
        currentOutput,
        {
          reviewerBackend: params.reviewerBackend,
          workingDirectory: params.workingDirectory,
          sessionId: workerSessionId,
          authorId: params.authorId,
          bindingRules: params.bindingRules,
          bindingRulesIndexed: params.bindingRulesIndexed,
          documentIndex: params.documentIndex,
          documentGuard: params.documentGuard,
        },
      );

      // --- ReviewVerdict (retry): buffer (last write wins) or create per-row ---
      latestReviewVerdictId = await this.recordReviewVerdict({
        sessionId: workerSessionId,
        workerResultId: String(workerResultEntity?.id ?? 0),
        verdict: retryReview.verdict,
        reasons: retryReview.reasons,
        suggestions: retryReview.suggestions,
        attempt: retryCount,
        authorId: params.authorId,
        timestamp: new Date().toISOString(),
      });

      // Reviewer-role observation (retry): verdict + (on rejection) reasons.
      this.observeReviewVerdict(retryReview.verdict, retryReview.reasons);

      if (SUCCESS_VERDICTS.has(retryReview.verdict)) {
        return this.concludeApproved({
          verdict: retryReview.verdict,
          retryCount,
          reviewNotes: retryReview.reasons,
          deferred: retryReview.deferred,
          notes: retryReview.notes,
          chain: params,
          workerOutput: currentOutput,
          startTime,
          arbiterModelLabel,
          workerResultId: workerResultEntity?.id,
          reviewVerdictId: latestReviewVerdictId,
        });
      }

      latestReasons = retryReview.reasons;
      latestDeferred = retryReview.deferred;
    }

    // Single arbiter path — handles all exhausted-retry cases
    const arbiterSessionId = `sess-arb-${randomUUID().slice(0, 8)}`;
    this.eventBus?.emit("oversight:start", {
      sessionId: arbiterSessionId,
      role: "arbiter",
      model: arbiterModelLabel,
      timestamp: Date.now(),
    });
    this.eventBus?.emit("agent:role", {
      sessionId: arbiterSessionId,
      role: "arbiter",
      model: arbiterModelLabel,
      provider: this.arbiterProvider.name,
      parentSessionId: workerSessionId,
      timestamp: Date.now(),
    });

    const arbiterResult = await this.arbitrate(
      params.originalTask,
      currentOutput,
      latestReasons,
      { arbiterBackend: params.arbiterBackend, workingDirectory: params.workingDirectory, sessionId: arbiterSessionId, authorId: params.authorId, bindingRules: params.bindingRules, bindingRulesIndexed: params.bindingRulesIndexed },
    );

    // Arbiter-role observation: the resolution/decision.
    this.observeArbiterDecision(arbiterResult.verdict, arbiterResult.reasoning);

    // --- Substrate: create ArbiterDecision entity ---
    // The single-envelope persistTaskTelemetry resolver has no ArbiterDecision
    // slot, so in buffered mode this exception-path row is not written as a
    // dedicated entity — its detail remains in the oversight event stream and the
    // verdict outcome is returned in OversightResult below. Created per-row only
    // when no task buffer is attached.
    if (!this.taskBuffer) {
      await this.substrateMutate<{ id: number }>("createArbiterDecision", {
        sessionId: workerSessionId,
        workerResultId: String(workerResultEntity?.id ?? 0),
        reviewVerdictId: String(latestReviewVerdictId ?? 0),
        verdict: arbiterResult.verdict,
        reasoning: arbiterResult.reasoning,
        timestamp: new Date().toISOString(),
      });
    }

    // A pass the arbiter granted keeps what the last review left for a
    // person, plus anything the arbiter's own reasoning defers.
    const arbiterDeferred = SUCCESS_VERDICTS.has(arbiterResult.verdict)
      ? uniqueLines([...latestDeferred, ...extractDeferred([arbiterResult.reasoning])])
      : [];
    const finalResult: OversightResult = {
      verdict: arbiterResult.verdict,
      retryCount,
      arbiterInvolved: true,
      humanEscalation: arbiterResult.verdict === "escalate",
      rejectionReasons: latestReasons,
      totalResolutionTimeMs: Date.now() - startTime,
      ...(arbiterDeferred.length > 0 ? { deferred: arbiterDeferred } : {}),
    };

    this.eventBus?.emit("oversight:verdict", {
      sessionId: workerSessionId,
      verdict: arbiterResult.verdict,
      arbiterInvolved: true,
      retryCount,
      durationMs: finalResult.totalResolutionTimeMs,
      timestamp: Date.now(),
    });

    return finalResult;
  }

  /**
   * Finish a chain the reviewer approved. Under the default policy the
   * approval stands. Under "always", the arbiter signs off first: its verdict
   * stands if it agrees, and a task it overturns goes to a person rather than
   * back to the worker — two reviewers disagreeing is a question for a human.
   */
  private async concludeApproved(args: {
    verdict: ReviewVerdict;
    retryCount: number;
    reviewNotes: string[];
    /** What the approving review left for a person. */
    deferred: string[];
    /** Deviations the approving review accepted. */
    notes: string[];
    chain: RunFullChainParams;
    workerOutput: string;
    startTime: number;
    arbiterModelLabel: string;
    workerResultId?: number;
    reviewVerdictId: number | null;
  }): Promise<OversightResult> {
    const { chain, retryCount } = args;
    const workerSessionId = chain.sessionId;

    let verdict: ReviewVerdict | ArbiterVerdict = args.verdict;
    let arbiterInvolved = false;
    let humanEscalation = false;
    let rejectionReasons: string[] = [];
    let deferred = args.deferred;

    if (this.arbiterPolicy === "always") {
      const arbiterSessionId = `sess-arb-${randomUUID().slice(0, 8)}`;
      this.eventBus?.emit("oversight:start", {
        sessionId: arbiterSessionId,
        role: "arbiter",
        model: args.arbiterModelLabel,
        timestamp: Date.now(),
      });
      this.eventBus?.emit("agent:role", {
        sessionId: arbiterSessionId,
        role: "arbiter",
        model: args.arbiterModelLabel,
        provider: this.arbiterProvider.name,
        parentSessionId: workerSessionId,
        timestamp: Date.now(),
      });

      const reviewerSaid = args.reviewNotes.length > 0 ? args.reviewNotes : [`The reviewer approved this work (${args.verdict}).`];
      const ruling = await this.arbitrate(chain.originalTask, args.workerOutput, reviewerSaid, {
        arbiterBackend: chain.arbiterBackend,
        workingDirectory: chain.workingDirectory,
        sessionId: arbiterSessionId,
        authorId: chain.authorId,
        mode: "signoff",
        bindingRules: chain.bindingRules,
        bindingRulesIndexed: chain.bindingRulesIndexed,
      });
      this.observeArbiterDecision(ruling.verdict, ruling.reasoning);

      // As on the disagreement path above: the atomic persistTaskTelemetry
      // resolver has no ArbiterDecision slot, so in buffered mode the ruling is
      // not written as its own entity. It stays in the oversight event stream and
      // in the returned OversightResult. The buffer itself is flushed by the
      // caller after runFullChain returns, exactly as for any other approval.
      if (!this.taskBuffer) {
        await this.substrateMutate<{ id: number }>("createArbiterDecision", {
          sessionId: workerSessionId,
          workerResultId: String(args.workerResultId ?? 0),
          reviewVerdictId: String(args.reviewVerdictId ?? 0),
          verdict: ruling.verdict,
          reasoning: ruling.reasoning,
          timestamp: new Date().toISOString(),
        });
      }

      arbiterInvolved = true;
      if (SUCCESS_VERDICTS.has(ruling.verdict)) {
        verdict = ruling.verdict;
        deferred = uniqueLines([...deferred, ...extractDeferred([ruling.reasoning])]);
      } else {
        verdict = "escalate";
        humanEscalation = true;
        rejectionReasons = [`The arbiter overturned the reviewer's approval: ${ruling.reasoning}`];
        deferred = [];
      }
    }

    const notes = humanEscalation ? [] : uniqueLines(args.notes);
    deferred = uniqueLines(deferred);
    const result: OversightResult = {
      verdict,
      retryCount,
      arbiterInvolved,
      humanEscalation,
      rejectionReasons,
      totalResolutionTimeMs: Date.now() - args.startTime,
      ...(deferred.length > 0 ? { deferred } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
    this.eventBus?.emit("oversight:verdict", {
      sessionId: workerSessionId,
      verdict,
      arbiterInvolved,
      retryCount,
      durationMs: result.totalResolutionTimeMs,
      timestamp: Date.now(),
    });
    return result;
  }

  /**
   * Extract the first balanced JSON object from a string that may contain
   * prose, tool results, or other non-JSON content around it.
   * Handles braces inside JSON string values by tracking quote state.
   */
  extractJson(raw: string): Record<string, unknown> | null {
    // Strip code fences first
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "");

    // Scan for JSON objects — skip non-JSON braces (Swift closures, code snippets).
    // A valid JSON object always starts with `{"` so we look for that pattern.
    // If `{"` isn't found, fall back to any `{` for backward compat.
    let searchStart = 0;
    while (searchStart < cleaned.length) {
      // Prefer `{"` (definite JSON) over bare `{` (might be code)
      let idx = cleaned.indexOf('{"', searchStart);
      if (idx === -1) {
        // Fall back to bare `{` only on the first scan
        if (searchStart === 0) {
          idx = cleaned.indexOf("{", searchStart);
        }
        if (idx === -1) return null;
      }

      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = idx; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(idx, i + 1)) as Record<string, unknown>;
            // Verify it looks like a review response (has verdict or reasoning)
            if ("verdict" in parsed || "reasoning" in parsed) {
              return parsed;
            }
          } catch {
            // Not valid JSON at this position — keep scanning
          }
          break;
        }
      }

      // Move past this `{` and try the next one
      searchStart = idx + 1;
    }
    return null;
  }

  private parseReviewResponse(raw: string): ReviewResponse {
    const parsed = this.extractJson(raw) as Partial<ReviewResponse> | null;
    if (parsed && typeof parsed.verdict === "string") {
      const v = parsed.verdict as ReviewVerdict;
      const reasons = parsed.reasons ?? [];
      const deferred = stringList(parsed.deferred);
      return {
        verdict: VALID_REVIEW_VERDICTS.has(v) ? v : "rejected",
        reasons,
        suggestions: parsed.suggestions ?? [],
        deferred: deferred.length > 0 ? deferred : extractDeferred(stringList(reasons)),
        notes: stringList(parsed.notes),
      };
    }
    // If parsing fails, treat as rejected — silently approving malformed output
    // is more dangerous than a false rejection (which triggers a retry).
    return {
      verdict: "rejected",
      reasons: ["Reviewer response could not be parsed — treating as rejection for safety"],
      suggestions: [],
      deferred: [],
      notes: [],
    };
  }

  private parseArbiterResponse(raw: string): ArbiterResponse {
    const parsed = this.extractJson(raw) as Partial<ArbiterResponse> | null;
    if (parsed) {
      const verdict = parsed.verdict as ArbiterVerdict | undefined;
      if (verdict && VALID_ARBITER_VERDICTS.has(verdict)) {
        return { verdict, reasoning: parsed.reasoning ?? "" };
      }
    }
    return { verdict: "escalate", reasoning: "Unable to parse arbiter response." };
  }
}
