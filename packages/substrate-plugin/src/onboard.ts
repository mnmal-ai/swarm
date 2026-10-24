/**
 * The swarm plugin's onboard record: `GET /substrate/v1/onboard` aggregates it
 * under `instructions.plugins.swarm`, and the plugin serves the same object at
 * `GET /substrate/v1/plugins/swarm/onboard`. An agent reads it once at cold
 * start, so it stays short: what the plugin is, one line per type, and the
 * frames worth knowing.
 *
 * It describes only what this instance serves: a `meta` instance lists the
 * meta types and no swarm workflows.
 */
import { docsNamespaceFor, metaNamespaceFor, TRIGGER_DRAINSTOP_PATH } from "@mnmal-ai/swarm-substrate-shared";
import type { SwarmScope } from "./plugin.js";

const SWARM_TYPE_LINES: Readonly<Record<string, string>> = {
  SwarmConfig: "Key/value settings by category: context budgets, recall threshold, isolation.",
  SwarmContent: "One swarm file (path, tier, intent, content), per project; semantically indexed.",
  SwarmRoute: "An intent's keywords and the content paths it loads.",
  WorkerResult: "One worker execution: output, diff, files modified, token usage.",
  ReviewVerdict: "One reviewer verdict on a worker result, with reasons and suggestions.",
  ArbiterDecision: "The arbiter's ruling when worker and reviewer disagree.",
  SessionEvent: "One LLM invocation: role, provider, model, tokens, latency.",
  OversightChain: "A session's oversight chain: verdicts, retries, arbiter and escalation.",
  TranscriptEntry: "The prompt and response of one invocation.",
  Goal: "A goal for multi-task orchestration, with acceptance criteria and dependencies.",
  TaskExecution: "One dispatched sub-task of a goal and its status.",
  LearningEntry: "A pattern learned while executing a goal.",
  McpServer: "An MCP server configuration agents may be given.",
  FailurePostmortem: "A captured failure: event, tool calls, transcript turns, verdict.",
  Observation:
    "A cheap working-memory note (kind, body, confidence 0-100, comma-separated tags). The drainstop promotes high-signal ones into the context store and expires the rest.",
};

const DOCS_TYPE_LINES: Readonly<Record<string, string>> = {
  Document: "A source document (path, source, content hash) split into sections.",
  Section: "One section of a document: heading path, body, synopsis; semantically indexed.",
};

const META_TYPE_LINES: Readonly<Record<string, string>> = {
  SessionLog: "One work session: branch, summary, decision count.",
  Decision: "An architectural choice with rationale; `supersedes` links its predecessor.",
  CodeLandmark: "A notable file path and its purpose.",
  ColdTestRun: "One cold-test run's metrics.",
  BugReport: "A bug: symptom, root cause, fix, and the query that found it.",
};

export interface OnboardOptions {
  scope: SwarmScope;
  namespace: string;
  contextNamespace: string;
}

function qualified(ns: string, lines: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(lines).map(([type, line]) => [`${ns}/${type}`, line]));
}

export function buildOnboardInstructions(opts: OnboardOptions) {
  const ns = opts.namespace;
  const cold = opts.scope !== "meta";
  const meta = opts.scope !== "cold";
  const types: Record<string, string> = {
    ...(cold ? qualified(ns, SWARM_TYPE_LINES) : {}),
    ...(cold ? qualified(docsNamespaceFor(ns), DOCS_TYPE_LINES) : {}),
    ...(meta ? qualified(metaNamespaceFor(ns), META_TYPE_LINES) : {}),
  };
  const workflows: Record<string, { frameKey: string; params: string; notes: string[] }> = cold
    ? {
        prepareTask: {
          frameKey: `${ns}/prepareTask`,
          params: "prompt, projectId, modelId, intentOverride?, sections?, index?, rank?, rankLimit?",
          notes: [
            "A query (POST /substrate/v1/query): classifies the prompt's intent and loads the routed swarm content within the model's token budget.",
            "Returns intent, confidence, matchedKeywords, content, filesIncluded, tokensUsed, budgetTokens, truncated, complexity.",
          ],
        },
        persistTaskTelemetry: {
          frameKey: `${ns}/persistTaskTelemetry`,
          params: "sessionEvent, transcript, workerResult, reviewVerdict?",
          notes: [
            "A mutation (POST /substrate/v1/mutate): writes the four rows in one transaction; any refused row rolls back all of them.",
            "Select `ids`: the created row ids by input name.",
          ],
        },
        observe: {
          frameKey: `${ns}/createObservation`,
          params: "ts (ISO-8601), kind, body, context?, confidence? (0-100 or null), tags (comma-separated), ttlHours?, isAnchor: null",
          notes: [
            "Kinds the drainstop acts on: fold-back-candidate -> Todo; architectural with confidence > 80 -> Decision; user-framing with confidence 100 -> AgentRule ('[category] rule' body); 3+ concerns with the same tags -> one Todo.",
            "Retention when not promoted: rationale 72h, fold-back-candidate 48h, pattern and concern 168h, unknown kinds 168h; architectural, user-framing and open-question never expire. A positive ttlHours overrides.",
            "Never set isAnchor or write confidence 50 as a default: the drainstop owns the calibration anchor.",
          ],
        },
        drainstop: {
          frameKey: `POST ${TRIGGER_DRAINSTOP_PATH}`,
          params: "none",
          notes: [
            `Runs one pass: seeds the anchor, promotes into ${opts.contextNamespace}, expires by TTL. Answers { promoted: { todos, decisions, agentRules }, absorbed, expired, anchorSeeded, failures, truncated }.`,
            "A refused promotion keeps its observation and is listed in failures. Expiry also runs on a schedule; promotion runs only here.",
          ],
        },
      }
    : {};
  return {
    summary:
      "The swarm: routed context loading, oversight and telemetry records, documents and working-memory observations for agent runs" +
      (cold ? `, with observation promotion into ${opts.contextNamespace}.` : ".") +
      (meta ? ` ${metaNamespaceFor(ns)} keeps institutional memory across sessions.` : ""),
    types,
    workflows,
  };
}

export type SwarmOnboardInstructions = ReturnType<typeof buildOnboardInstructions>;
