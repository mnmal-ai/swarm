import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { FnlCoverage, ISwarmEventBus, Task, TaskBackend, TaskSource, TaskStatus, TokenBreakdown, WorktreeStatus } from "@mnmal-ai/swarm-types";
import { subscribeOrPoll } from "@mnmal-ai/swarm-substrate";
import type { FieldSelection, SubscribeOrPollHandle, SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { scrubContent } from "@mnmal-ai/swarm-telemetry";
import { FnlTotals } from "../cli/fnl-coverage.js";

// Module-level constants shared between the WS state updater and the REST merge path.
// Allocated once; referenced wherever task status classification is needed.
const TASK_SUCCESS_VERDICTS = new Set(["approved", "skipped", "completed_with_notes", "completed_with_deferrals"]);
const TASK_TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed", "failed", "blocked", "interrupted", "token_exceeded", "skipped_tokens",
  "completed_with_notes", "completed_with_deferrals",
]);

// Load the vendored Axon design tokens and combine them into a single CSS response.
//
// Two-path load to cover both the Bun-compiled binary (files live in the
// $bunfs, not on disk) and the Node/tsx dev path (no Bun text-import support;
// static `import` of CSS throws at module evaluation):
//
//   1. Bun binary  — `tokens-embed.ts` bundles the two CSS files as string
//                    constants at compile time. Dynamic-import that first.
//   2. Node / tsx  — the dynamic import fails (Node rejects the `with
//                    { type: "text" }` attribute on a `.css` specifier).
//                    Fall back to reading ./axon/*.css relative to this module.
let axonCss: string;
try {
  const embed = await import("./tokens-embed.js");
  axonCss = embed.default.tokens + "\n@media (prefers-color-scheme: light) {\n" + embed.default.light + "\n}";
} catch {
  try {
    const dark  = readFileSync(new URL("./axon/tokens.css", import.meta.url), "utf-8");
    const light = readFileSync(new URL("./axon/theme-light.css", import.meta.url), "utf-8");
    axonCss = dark + "\n@media (prefers-color-scheme: light) {\n" + light + "\n}";
  } catch (err) {
    // No bundled tokens and no vendored files on disk — serve a placeholder so
    // the dashboard still renders against browser defaults.
    console.warn("[axon] Failed to load the vendored Axon CSS:", err);
    axonCss = "/* Axon tokens not found — run pnpm turbo build */";
  }
}

// Load dashboard HTML. In Bun-compiled binary: embedded via dashboard-embed.ts.
// In dev mode (node): read from disk after tsc copies the file to dist/.
let dashboardHtmlContent: string;
try {
  // Bun bundler resolves the static import in dashboard-embed.ts at compile
  // time, embedding the 55KB HTML string directly in the binary.
  const embed = await import("./dashboard-embed.js");
  dashboardHtmlContent = embed.default;
} catch {
  // Dev mode: dashboard-embed.ts fails (Bun-only syntax), read from disk
  try {
    const __server_dirname = dirname(fileURLToPath(import.meta.url));
    dashboardHtmlContent = readFileSync(join(__server_dirname, "dashboard.html"), "utf-8");
  } catch {
    dashboardHtmlContent = "<html><body><h1>Dashboard</h1><p>Dashboard HTML not found. Run <code>pnpm turbo build</code> first.</p></body></html>";
  }
}

interface SessionTask {
  id: string;
  goalId?: string;
  title?: string;
  description: string;
  intent: string;
  status: TaskStatus;
  order?: number;
  verdict?: string;
  latencyMs?: number;
  arbiterInvolved?: boolean;
  retryCount?: number;
  /** Fresh input, cache reads, cache writes and output, from task:verdict. */
  tokens?: TokenBreakdown;
  /** What the reviewer left for a person, from task:verdict. */
  deferred?: string[];
  subTaskIds?: string[];
  parentTaskId?: string;
  source?: TaskSource;
}

/**
 * What swarm is doing now, for the header's status line: preparing context,
 * planning a goal, working on a task, reviewing it, or between tasks, since
 * when, and how far a section sync has got. Ids, a task title and counts only.
 */
interface RunPhase {
  kind: "preparing-context" | "planning" | "working" | "reviewing" | "between-tasks" | "goal-finished" | "waiting-to-merge" | "merging";
  since: number;
  /** waiting-to-merge: turns ahead, and who holds the repository's merge turn. */
  ahead?: number;
  holderProject?: string;
  holderPrUrl?: string;
  goalId?: string;
  /** The planning goal's label, before its goal:start brings it to `goals`. */
  goalLabel?: string;
  taskId?: string;
  title?: string;
  /** Tasks under way at once (parallel workers); the status line names the latest. */
  activeTasks?: number;
  /**
   * A section sync under way during this phase: files done of how many, the
   * text done of how much, and the time left at the measured throughput as of
   * `at` (absent until there's enough to measure).
   */
  sync?: { done: number; total: number; bytesDone: number; bytesTotal: number; etaMs?: number; at: number };
}

interface SessionState {
  startedAt: number;
  project: string;
  goals: Array<{ id: string; description: string; status: string; url?: string; label?: string }>;
  tasks: SessionTask[];
  currentGoal: string | null;
  currentTask: string | null;
  /** The session's tokens so far — all input (cache included) plus output.
   *  Initialised to 0 so the WS snapshot is always numeric; `tokens:update`
   *  carries the running total. */
  cumulativeTokens: number;
  /** The session's tokens split into fresh input, cache reads, cache writes
   *  and output — what the page shows in its header and main tile. */
  tokens: TokenBreakdown;
  /** `max_tokens_per_session`, or 0 until the run reports it. The page draws
   *  its budget bar only when this is above 0. */
  tokenLimit: number;
  /** What swarm is doing now; absent until the run says. */
  phase?: RunPhase;
  /** Tasks under way, oldest first, so a page opened mid-run keeps track of parallel tasks. */
  activeTasks?: Array<{ taskId: string; goalId?: string; title?: string; since: number }>;
  /** The run's fnl coverage so far, every session added up; absent until a
   *  session counts one (see FnlCoverage). */
  fnl?: { sessions: number; total: FnlCoverage };
  currentRole?: string;
  currentModel?: string;
  intent?: string;
  intentConfidence?: string;
  swarmFiles?: Array<{ path: string; tier: string; estimatedTokens: number }>;
  budgetUsedPercent?: number;
  firstPassRate?: number;    // Computed: approved / total verdicts
  arbiterRate?: number;      // Computed: arbiter involved / total verdicts
  backendType?: string;      // "claude-code" | "api"
  latestActivity?: string;   // Most recent progress detail (e.g., tool name)
  worktrees: Array<{ id: string; taskId: string; path: string; branch: string; status: WorktreeStatus; filesChanged: string[] }>;
  activeWorkerCount: number;
  maxWorkers: number;
  events: Array<{ type: string; payload: unknown; timestamp: number }>;
}

/** Redact large or sensitive fields from tool events before broadcasting.
 *
 *  Two truncation tiers:
 *  - `content`/`contents` (file write payloads) collapse to `<N chars>` —
 *    these can be huge and the dashboard never wants to display them
 *    inline; size suffices.
 *  - Other string fields (commands, paths, JSON args) keep up to 5_000
 *    chars so the dashboard can show the full input when the operator
 *    expands a log entry. The previous 200-char cap silently truncated
 *    most useful tool inputs (commands, JSON tool args) to a teaser.
 */
const TOOL_INPUT_FIELD_MAX_CHARS = 5_000;
function redactToolPayload(payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  if (!p.toolInput || typeof p.toolInput !== "object") return payload;
  const input = p.toolInput as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (key === "content" || key === "contents") {
      redacted[key] = typeof val === "string" ? `<${val.length} chars>` : val;
    } else if (typeof val === "string" && val.length > TOOL_INPUT_FIELD_MAX_CHARS) {
      redacted[key] = val.slice(0, TOOL_INPUT_FIELD_MAX_CHARS) + `... (${val.length - TOOL_INPUT_FIELD_MAX_CHARS} more chars)`;
    } else {
      redacted[key] = val;
    }
  }
  return { ...p, toolInput: redacted };
}

/** Longest string kept in an event the dashboard stores or streams. */
const EVENT_STRING_MAX_CHARS = 8_000;

/**
 * Cut long strings anywhere in an event payload, keeping its shape (ids,
 * statuses, counts) so the page can still act on it. A cut string ends with a
 * marker saying how much was dropped.
 */
export function capEventStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= EVENT_STRING_MAX_CHARS) return value;
    const droppedKb = Math.ceil((value.length - EVENT_STRING_MAX_CHARS) / 1024);
    return `${value.slice(0, EVENT_STRING_MAX_CHARS)}… [truncated, ${droppedKb} KB]`;
  }
  if (value === null || typeof value !== "object") return value;
  // Past this depth the rest is kept as one capped string, so nothing deep
  // slips past the limit.
  if (depth > 8) {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return "[not serialisable]";
    }
    return capEventStrings(text, depth);
  }
  if (Array.isArray(value)) return value.map((v) => capEventStrings(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) out[key] = capEventStrings(val, depth + 1);
  return out;
}

/**
 * What the dashboard streams for a session's transcript: who ran it, with what,
 * and how big the prompt and response were. The full transcript is served only
 * on request (GET /api/transcript/:transcriptId), so a whole prompt and response
 * don't go to every page, or every viewer on the network, as they arrive.
 */
export function summarizeTranscript(payload: unknown): Record<string, unknown> {
  const { prompt, response, ...rest } = (payload ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    promptBytes: typeof prompt === "string" ? Buffer.byteLength(prompt) : 0,
    responseBytes: typeof response === "string" ? Buffer.byteLength(response) : 0,
  };
}

/** Full transcripts the server holds for GET /api/transcript/:transcriptId; the oldest go first past either limit. */
const TRANSCRIPTS_KEPT = 100;
const TRANSCRIPT_BYTES_KEPT = 32 * 1024 * 1024;

// The SessionEvent fields the dashboard's stream reads.
const SESSION_EVENT_FIELD_ORDER = [
  "eventId",
  "sessionId",
  "role",
  "modelId",
  "intent",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "timestamp",
] as const;

// SessionEvent fields projected for the dashboard stream. eventId is the
// dedup key; the rest mirror what the dashboard's Substrate panel already reads
// (role/tokens/latency/timestamp) so a front-end can render the row without a
// follow-up query.
const SESSION_EVENT_FIELDS: FieldSelection = Object.fromEntries(
  SESSION_EVENT_FIELD_ORDER.map((k) => [k, true]),
);

// Poll cadence for the SessionEvent stream. ~1s matches the on-demand REST
// refresh the stream replaced. Fixed interval, no backoff.
const SESSION_EVENT_POLL_INTERVAL_MS = 1000;

/** Minimal SessionEvent row as a poll query returns it. */
interface SessionEventRow {
  eventId?: string;
  [field: string]: unknown;
}

/** True for a payload field shaped like a TokenBreakdown (all four parts numeric). */
/** A session's fnl coverage as the backend reports it (see FnlCoverage). */
function isFnlCoverage(v: unknown): v is FnlCoverage {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.buildCommands === "number" &&
    typeof c.wrapped === "number" &&
    typeof c.unanswered === "number" &&
    c.leftAlone !== null && typeof c.leftAlone === "object" &&
    c.byTool !== null && typeof c.byTool === "object"
  );
}

function isTokenBreakdown(value: unknown): value is TokenBreakdown {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.freshInput === "number" && typeof v.cacheRead === "number"
    && typeof v.cacheWrite === "number" && typeof v.output === "number";
}

/** This machine's hostname and current interface addresses. */
export interface MachineNames {
  hostname: string;
  interfaces: ReturnType<typeof networkInterfaces>;
}

const thisMachine = (): MachineNames => ({ hostname: hostname(), interfaces: networkInterfaces() });

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** A Host header's name (lowercase, IPv6 without brackets) and port, or null when malformed. */
function parseHost(value: string): { name: string; port: string | null } | null {
  const v = value.trim().toLowerCase();
  const m = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(v) ?? /^([^:[\]\s]+)(?::(\d+))?$/.exec(v);
  return m === null ? null : { name: m[1], port: m[2] ?? null };
}

/**
 * Whether a request's Host header names this dashboard, so a DNS-rebinding
 * page (a hostile name re-pointed at this machine) is refused. Loopback names
 * always; on the LAN, also this machine's hostname (plain and `.local`) and
 * its current interface addresses (IPv4 and IPv6, LAN and tailnet alike),
 * read per request so a changed network is followed. The port, when given,
 * must be the dashboard's.
 */
export function isDashboardHost(
  host: string | undefined,
  port: number,
  lan: boolean,
  machine: () => MachineNames = thisMachine,
): boolean {
  const parsed = host === undefined ? null : parseHost(host);
  if (parsed === null || (parsed.port !== null && parsed.port !== String(port))) return false;
  if (LOOPBACK_NAMES.has(parsed.name)) return true;
  if (!lan) return false;
  const { hostname: name, interfaces } = machine();
  const base = name.toLowerCase().replace(/\.local$/, "");
  const names = new Set(base === "" ? [] : [base, `${base}.local`]);
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) names.add(a.address.toLowerCase());
  }
  return names.has(parsed.name);
}

/**
 * Whether a WebSocket upgrade comes from the dashboard's own page: no Origin
 * (a non-browser client), or exactly http:// plus the request's own Host. Any
 * other page in the viewer's browser could otherwise read the live events.
 */
export function isDashboardOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  if (host === undefined) return false;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && u.host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

const MISDIRECTED = "Misdirected request: this dashboard answers only to this machine's own names.\n";

/**
 * What a dashboard served on every interface (`swarm run --dashboard-lan`,
 * `swarm dashboard preview --lan`) exposes, printed when it starts. The owner
 * chose this warning over a read-only proxy: LAN viewers get full access.
 */
/** What the dashboard's proxy forwards to its Substrate sidecar; everything else is refused. */
export const PROXIED_SUBSTRATE_OPS = "POST query, POST mutate, GET schema/<namespace> and GET schema/<namespace>/<Type>";

/** The largest POST body the Substrate proxy forwards (1 MiB); larger ones get 413. */
export const MAX_PROXY_BODY = 1024 * 1024;

/** A namespace or type name the schema op accepts: never `_system` or another `_`-prefixed one. */
const PROXIED_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The sidecar path a dashboard request is forwarded to, or null when it is not
 * one of {@link PROXIED_SUBSTRATE_OPS}. The page itself calls only POST query.
 *
 * `url` is `/api/substrate/<op>` or `/substrate/v1/<op>`. Every path segment is
 * percent-decoded before it is matched (one that does not decode is refused),
 * `.`/`..`/empty segments and any query string are refused, and the upstream
 * path is rebuilt from the decoded segments, so an encoded `_system` or `..`
 * cannot reach anything else on the sidecar.
 */
export function substrateProxyPath(method: string, url: string): string | null {
  if (url.includes("?") || url.includes("#")) return null;
  const prefix = url.startsWith("/api/substrate/") ? "/api/substrate/" : url.startsWith("/substrate/v1/") ? "/substrate/v1/" : null;
  if (prefix === null) return null;
  const segments: string[] = [];
  for (const raw of url.slice(prefix.length).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment === "." || segment === ".." || /[/\\]/.test(segment)) return null;
    segments.push(segment);
  }
  if (method === "POST" && segments.length === 1 && (segments[0] === "query" || segments[0] === "mutate")) {
    return `/substrate/v1/${segments[0]}`;
  }
  if (
    method === "GET" &&
    segments[0] === "schema" &&
    (segments.length === 2 || segments.length === 3) &&
    segments.slice(1).every((s) => PROXIED_NAME.test(s))
  ) {
    return `/substrate/v1/${segments.join("/")}`;
  }
  return null;
}

export function lanWarning(localOnly: boolean): string[] {
  return [
    "  WARNING: the dashboard is served on all network interfaces with no login.",
    "  Anyone on the same network can see this run's live events and task text, and can",
    "  read and change everything in this project's Substrate store through the dashboard's",
    "  Substrate proxy. Use it only on a network you trust.",
    ...(localOnly
      ? [
          "  This project is local_only: its data is meant to stay on this machine, and serving",
          "  the dashboard on the network lets it leave.",
        ]
      : []),
  ];
}

export class DashboardServer {
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private lan: boolean;
  private port: number;
  private state: SessionState;
  private fnlTotals = new FnlTotals();
  private dashboardHtml: string;
  private unsubscribe: (() => void) | null = null;
  /** Full transcripts by transcript id, for GET /api/transcript/:transcriptId (see keepTranscript). */
  private transcripts = new Map<string, { transcript: unknown; bytes: number }>();
  private transcriptBytes = 0;
  private transcriptSeq = 0;
  private taskBackend: TaskBackend | undefined;
  private substrateClient: SubstrateClient | undefined;
  private sessionEventStream: SubscribeOrPollHandle | undefined;
  // eventIds already pushed to dashboard clients. Push is incremental — the REST
  // poll (front-end panel + this server's fallback) covers backfill — so this
  // dedup set guarantees each row is broadcast at most once across a snapshot,
  // and every later poll tick. SessionEvent volume per run is small (a few
  // per task), so an unbounded set is fine for a session's lifetime.
  private seenSessionEventIds = new Set<string>();

  constructor(eventBus: ISwarmEventBus, port = 3141, taskBackend?: TaskBackend, lan = false, substrateClient?: SubstrateClient) {
    this.lan = lan;
    this.port = port;
    this.taskBackend = taskBackend;
    this.substrateClient = substrateClient;
    this.state = {
      startedAt: Date.now(),
      project: "",
      goals: [],
      tasks: [],
      currentGoal: null,
      currentTask: null,
      // Init to 0 alongside the other numeric state fields. A client that
      // connects BEFORE the first tokens:update bearing this field would
      // otherwise receive `undefined` in the snapshot and any arithmetic on
      // it (the dashboard's token tile renders `tokens.toLocaleString()`)
      // would surface `NaN`.
      cumulativeTokens: 0,
      tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      tokenLimit: 0,
      worktrees: [],
      activeWorkerCount: 0,
      maxWorkers: 1,
      events: [],
    };

    this.dashboardHtml = dashboardHtmlContent;

    // HTTP server — serves dashboard HTML and REST API endpoints
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res);
    });

    // Handle listen errors (e.g., EADDRINUSE)
    this.server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[swarm] Dashboard server failed: port ${port} already in use. ` +
          `Disable with --no-dashboard or use --dashboard-port <port>.`,
        );
      } else {
        console.error("[swarm] Dashboard server error:", err.message);
      }
    });

    // WebSocket server
    // Only this dashboard's own page (or a non-browser client) may open the
    // event stream, and only under one of this machine's own names.
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: ({ origin, req }, done) => {
        if (!isDashboardHost(req.headers.host, this.port, this.lan)) done(false, 421, "Misdirected Request");
        else if (!isDashboardOrigin(origin, req.headers.host)) done(false, 403, "Forbidden");
        else done(true);
      },
    });
    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      // Send current state on connect
      ws.send(JSON.stringify({ type: "state", payload: this.state }));
      ws.on("close", () => this.clients.delete(ws));
    });

    // Subscribe to all events from the bus
    this.unsubscribe = eventBus.onAny((event: string, payload: unknown) => {
      // Redact tool payloads before storing/broadcasting
      let safePayload = event.startsWith("tool:") ? redactToolPayload(payload) : payload;
      // A transcript is held here and streamed as a summary; a page asks for
      // the full one when someone opens it.
      if (event === "transcript") {
        safePayload = { ...summarizeTranscript(payload), transcriptId: this.keepTranscript(payload) };
      }
      safePayload = capEventStrings(safePayload);
      this.updateState(event, safePayload);
      this.broadcast(event, safePayload);
    });

    // Bind to loopback by default. Use --dashboard-lan to expose on the network.
    // With port 0 the OS picks one; the Host check then uses the port it chose.
    const host = this.lan ? "0.0.0.0" : "127.0.0.1";
    this.server.once("listening", () => {
      const bound = this.listeningPort;
      if (bound !== null) this.port = bound;
    });
    this.server.listen(port, host);

    // Push new SessionEvent rows to dashboard clients over the dashboard WS,
    // polled from the store (the Substrate client has no push channel).
    // Fire-and-forget: a stream failure must never stop the dashboard serving.
    if (this.substrateClient) {
      void this.startSessionEventStream(this.substrateClient);
    }
  }

  /** Tasks under way, oldest first, for the status line when workers run in parallel. */
  private phaseTasks = new Map<string, { goalId?: string; title?: string; since: number }>();

  /** The phase for the tasks still under way: the latest one, or between tasks. */
  private workingPhase(now: number, goalId: string | undefined): RunPhase {
    const latest = [...this.phaseTasks.entries()].at(-1);
    if (!latest) return { kind: "between-tasks", since: now, goalId };
    const [taskId, t] = latest;
    return { kind: "working", since: t.since, goalId: t.goalId, taskId, ...(t.title ? { title: t.title } : {}), activeTasks: this.phaseTasks.size };
  }

  /** Keep `state.phase` in step with what the run is doing; see RunPhase. */
  private updatePhase(event: string, p: Record<string, unknown>): void {
    const now = Date.now();
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const current = this.state.phase;
    // A sync under way carries over when the phase changes around it (a
    // parallel task starting or finishing); only its own end clears it.
    const carried = current?.sync;
    switch (event) {
      case "goal:planning":
        this.state.phase = { kind: "planning", since: now, goalId: str(p.goalId), ...(str(p.label) ? { goalLabel: str(p.label) } : {}) };
        break;
      case "task:start": {
        const taskId = str(p.taskId);
        if (taskId === undefined) break;
        const title = str(p.title) ?? this.state.tasks.find((t) => t.id === taskId)?.title;
        this.phaseTasks.delete(taskId);
        this.phaseTasks.set(taskId, { goalId: str(p.goalId), title, since: now });
        this.state.phase = this.workingPhase(now, str(p.goalId));
        break;
      }
      case "oversight:start":
        this.state.phase = { kind: "reviewing", since: now, goalId: current?.goalId, taskId: current?.taskId, ...(current?.title ? { title: current.title } : {}) };
        break;
      case "task:verdict":
      case "task:aborted": {
        const taskId = str(p.taskId);
        if (taskId !== undefined) this.phaseTasks.delete(taskId);
        this.state.phase = this.workingPhase(now, current?.goalId);
        break;
      }
      case "goal:completed":
        this.phaseTasks.clear();
        this.state.phase = { kind: "goal-finished", since: now, goalId: str(p.goalId) };
        break;
      case "source_control:merge_waiting":
        this.state.phase = {
          kind: "waiting-to-merge",
          since: current?.kind === "waiting-to-merge" ? current.since : now,
          goalId: str(p.goalId),
          ...(typeof p.ahead === "number" ? { ahead: p.ahead } : {}),
          ...(str(p.holderProject) ? { holderProject: str(p.holderProject) } : {}),
          ...(str(p.holderPrUrl) ? { holderPrUrl: str(p.holderPrUrl) } : {}),
        };
        break;
      case "source_control:merge_turn_taken":
        this.state.phase = { kind: "merging", since: now, goalId: str(p.goalId) };
        break;
      case "source_control:pr_merged":
      case "source_control:merge_skipped":
        if (current?.kind === "merging" || current?.kind === "waiting-to-merge") this.state.phase = { kind: "goal-finished", since: now, goalId: str(p.goalId) };
        break;
      case "context:sync-start": {
        const total = typeof p.changedFiles === "number" ? p.changedFiles : 0;
        if (total > 0) {
          const bytesTotal = typeof p.changedBytes === "number" ? p.changedBytes : 0;
          this.state.phase = { ...(current ?? { kind: "preparing-context", since: now }), sync: { done: 0, total, bytesDone: 0, bytesTotal, at: now } };
        }
        break;
      }
      case "context:sync-progress":
        if (current && typeof p.done === "number" && typeof p.total === "number") {
          const num = (v: unknown) => (typeof v === "number" ? v : 0);
          current.sync = {
            done: p.done,
            total: p.total,
            bytesDone: num(p.bytesDone),
            bytesTotal: num(p.bytesTotal),
            ...(typeof p.etaMs === "number" ? { etaMs: p.etaMs } : {}),
            at: now,
          };
        }
        break;
      case "context:sync-done":
        if (current) {
          delete current.sync;
          if (current.kind === "preparing-context") this.state.phase = undefined;
        }
        break;
    }
    const next = this.state.phase;
    if (carried && next && next !== current && !next.sync && event !== "context:sync-done") next.sync = carried;
    this.state.activeTasks = [...this.phaseTasks.entries()].map(([taskId, t]) => ({ taskId, ...t }));
  }

  /**
   * Hold a transcript for on-demand fetches under an id of its own (a worker
   * and the reviewer of its work share a session id), scrubbed of keys, tokens
   * and home folders first (scrubContent), keeping the newest TRANSCRIPTS_KEPT
   * within TRANSCRIPT_BYTES_KEPT. Returns the id.
   */
  private keepTranscript(payload: unknown): string {
    const p = (payload ?? {}) as Record<string, unknown>;
    const id = `t${++this.transcriptSeq}`;
    const transcript = {
      ...p,
      ...(typeof p.prompt === "string" ? { prompt: scrubContent(p.prompt) } : {}),
      ...(typeof p.response === "string" ? { response: scrubContent(p.response) } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(transcript));
    this.transcripts.set(id, { transcript, bytes });
    this.transcriptBytes += bytes;
    while (this.transcripts.size > TRANSCRIPTS_KEPT || (this.transcriptBytes > TRANSCRIPT_BYTES_KEPT && this.transcripts.size > 1)) {
      const oldest = this.transcripts.keys().next().value;
      if (oldest === undefined) break;
      this.forgetTranscript(oldest);
    }
    return id;
  }

  private forgetTranscript(id: string): void {
    const held = this.transcripts.get(id);
    if (held === undefined) return;
    this.transcriptBytes -= held.bytes;
    this.transcripts.delete(id);
  }

  /** Update session state based on event type. */
  private updateState(event: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;

    // Keep a rolling log (max 500 events)
    this.state.events.push({ type: event, payload, timestamp: Date.now() });
    if (this.state.events.length > 500) {
      this.state.events = this.state.events.slice(-500);
    }
    this.updatePhase(event, p);

    switch (event) {
      case "backend:fnl_coverage":
        if (isFnlCoverage(p.coverage)) {
          this.fnlTotals.add(p.coverage);
          const total = this.fnlTotals.total();
          if (total) this.state.fnl = { sessions: this.fnlTotals.sessions, total };
        }
        break;

      case "goal:start":
        this.state.currentGoal = p.goalId as string;
        this.state.goals.push({
          id: p.goalId as string,
          description: p.description as string,
          status: "in_progress",
          ...(typeof p.url === "string" ? { url: p.url } : {}),
          ...(typeof p.label === "string" ? { label: p.label } : {}),
        });
        break;

      case "goal:decomposed":
        for (const t of (p.tasks as Array<{ id: string; title?: string; description: string; intent: string; source?: TaskSource }>)) {
          this.state.tasks.push({ id: t.id, goalId: p.goalId as string, title: t.title, description: t.description, intent: t.intent, status: "pending", source: t.source });
        }
        break;

      case "goal:completed": {
        const g = this.state.goals.find((g) => g.id === p.goalId);
        if (g) g.status = (p.completedTasks as number) === (p.totalTasks as number) ? "completed" : "partial";
        this.state.currentGoal = null;
        break;
      }

      case "task:aborted": {
        // A split task gets no task:verdict; this is where its run and the
        // decomposition call report their tokens. A task can be split more
        // than once, so add rather than replace.
        const t = this.state.tasks.find((t) => t.id === p.taskId);
        if (t && isTokenBreakdown(p.tokens)) {
          const prev = t.tokens ?? { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
          t.tokens = {
            freshInput: prev.freshInput + p.tokens.freshInput,
            cacheRead: prev.cacheRead + p.tokens.cacheRead,
            cacheWrite: prev.cacheWrite + p.tokens.cacheWrite,
            output: prev.output + p.tokens.output,
          };
        }
        break;
      }

      case "task:id_remapped": {
        const oldId = typeof p.oldId === "string" ? p.oldId : undefined;
        const newId = typeof p.newId === "string" ? p.newId : undefined;
        if (!oldId || !newId) break;
        const rt = this.state.tasks.find((t) => t.id === oldId);
        // Remove any existing entry with newId to prevent duplicates
        const dupeIdx = this.state.tasks.findIndex((t) => t.id === newId);
        if (dupeIdx !== -1 && rt) {
          this.state.tasks.splice(dupeIdx, 1);
        }
        if (rt) {
          rt.id = newId;
          if (p.source && typeof p.source === "object" && "type" in (p.source as Record<string, unknown>)) {
            rt.source = p.source as TaskSource;
          }
        }
        if (this.state.currentTask === oldId) {
          this.state.currentTask = newId;
        }
        break;
      }

      case "task:start": {
        this.state.currentTask = p.taskId as string;
        const t = this.state.tasks.find((t) => t.id === p.taskId);
        if (t) {
          t.status = "in_progress";
        } else {
          // Subtasks aren't in goal:decomposed — create them on first task:start
          this.state.tasks.push({
            id: p.taskId as string,
            goalId: p.goalId as string,
            title: (p.title as string) || undefined,
            description: (p.description as string) || (p.taskId as string),
            intent: (p.intent as string) || "implementation",
            status: "in_progress",
            parentTaskId: (p.parentTaskId as string) || undefined,
            source: p.source as TaskSource | undefined,
          });
        }
        break;
      }

      case "task:verdict": {
        const t = this.state.tasks.find((t) => t.id === p.taskId);
        if (t) {
          const _v = p.verdict as string;
          t.status = TASK_SUCCESS_VERDICTS.has(_v)
            ? (_v === "completed_with_notes" ? "completed_with_notes"
               : _v === "completed_with_deferrals" ? "completed_with_deferrals"
               : "completed") as TaskStatus
            : "failed";
          t.verdict = p.verdict as string;
          if (typeof p.latencyMs === "number") t.latencyMs = p.latencyMs;
          if (p.arbiterInvolved) t.arbiterInvolved = true;
          if (typeof p.retryCount === "number") t.retryCount = p.retryCount;
          if (isTokenBreakdown(p.tokens)) t.tokens = p.tokens;
          if (Array.isArray(p.deferred)) t.deferred = (p.deferred as unknown[]).filter((d): d is string => typeof d === "string");
        }
        this.state.currentTask = null;
        break;
      }

      case "tokens:update":
        // Guarded field by field: a payload missing one keeps the value the
        // page already shows.
        if (typeof p.cumulativeTokens === "number") {
          this.state.cumulativeTokens = p.cumulativeTokens;
        }
        if (isTokenBreakdown(p.tokens)) {
          this.state.tokens = p.tokens;
        }
        if (typeof p.sessionTokenLimit === "number") {
          this.state.tokenLimit = p.sessionTokenLimit;
        }
        break;

      case "session:start":
        this.state.currentRole = p.role as string;
        this.state.currentModel = p.model as string;
        // backendType is not part of SessionStartEvent today but may be added
        // in the future. Guard defensively so the dashboard picks it up when available.
        if (p.backendType) {
          this.state.backendType = p.backendType as string;
        }
        break;

      case "backend:fallback":
        this.state.backendType = p.to as string;
        break;

      case "intent:classified":
        this.state.intent = p.intent as string;
        this.state.intentConfidence = p.confidence as string;
        break;

      case "context:loaded":
        this.state.swarmFiles = p.files as Array<{ path: string; tier: string; estimatedTokens: number }>;
        this.state.budgetUsedPercent = p.budgetUsedPercent as number;
        break;

      case "backend:progress": {
        // Track latest activity for live display
        const progress = p as { type?: string; detail?: string };
        if (progress.type === "tool_call" && typeof progress.detail === "string") {
          this.state.latestActivity = progress.detail;
        }
        break;
      }

      case "agent:role":
        this.state.currentRole = p.role as string;
        this.state.currentModel = p.model as string;
        break;

      case "worktree:created":
        this.state.worktrees.push({
          id: p.worktreeId as string,
          taskId: p.taskId as string,
          path: p.path as string,
          branch: p.branch as string,
          status: "active",
          filesChanged: [],
        });
        this.updateActiveWorkerCount();
        break;

      case "worktree:changed": {
        const wt = this.state.worktrees.find(w => w.id === p.worktreeId);
        if (wt) {
          wt.filesChanged = Array.isArray(p.filesChanged) ? (p.filesChanged as string[]) : [];
        }
        break;
      }

      case "worktree:merged": {
        const wt = this.state.worktrees.find(w => w.id === p.worktreeId);
        if (wt) wt.status = "merged";
        this.updateActiveWorkerCount();
        break;
      }

      case "worktree:conflict": {
        const wt = this.state.worktrees.find(w => w.id === p.worktreeId);
        if (wt) wt.status = "conflict";
        this.updateActiveWorkerCount();
        break;
      }

      case "worktree:destroyed": {
        this.state.worktrees = this.state.worktrees.filter(w => w.id !== p.worktreeId);
        this.updateActiveWorkerCount();
        break;
      }
    }

    // Compute real-time metrics
    const verdicts = this.state.tasks.filter((t) => t.verdict);
    const firstPassApproved = verdicts.filter((t) => t.verdict === "approved" && (t.retryCount ?? 0) === 0);
    this.state.firstPassRate = verdicts.length > 0 ? firstPassApproved.length / verdicts.length : undefined;

    // Only consider tasks where arbiterInvolved is explicitly known (not undefined)
    // to avoid deflating the rate with tasks that haven't been through oversight yet.
    const tasksWithArbiterInfo = verdicts.filter((t) => typeof t.arbiterInvolved === "boolean");
    const arbiterInvolved = tasksWithArbiterInfo.filter((t) => t.arbiterInvolved);
    this.state.arbiterRate = tasksWithArbiterInfo.length > 0 ? arbiterInvolved.length / tasksWithArbiterInfo.length : undefined;
  }

  /** Broadcast an event to all connected WebSocket clients. */
  private broadcast(event: string, payload: unknown): void {
    const msg = JSON.stringify({ type: event, payload, timestamp: Date.now() });
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    }
  }

  // -----------------------------------------------------------------------
  // SessionEvent stream
  // -----------------------------------------------------------------------

  /**
   * Keep dashboard clients up to date with SessionEvent rows: poll the query
   * every SESSION_EVENT_POLL_INTERVAL_MS (the Substrate client has no push
   * channel, so `subscribeOrPoll` always polls) and broadcast each new (unseen)
   * row as a `substrate:sessionEvent` message. A failing tick is warned about
   * and the next one tries again.
   *
   * Fire-and-forget and fully guarded: any failure logs and leaves the dashboard
   * serving, with the front-end's own REST poll still refreshing the panel.
   */
  private async startSessionEventStream(client: SubstrateClient): Promise<void> {
    const pollOnce = async (): Promise<void> => {
      const rows = await client.query<SessionEventRow>("SessionEvent", {}, SESSION_EVENT_FIELDS);
      this.pushNewSessionEvents(rows);
    };

    try {
      this.sessionEventStream = await subscribeOrPoll(
        client,
        { typeName: "SessionEvent", fields: SESSION_EVENT_FIELDS },
        () => {},
        {
          poll: async () => {
            try {
              await pollOnce();
            } catch (err) {
              console.warn(
                `[dashboard] SessionEvent poll tick failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
          intervalMs: SESSION_EVENT_POLL_INTERVAL_MS,
        },
      );
    } catch (err) {
      console.warn(
        `[dashboard] SessionEvent stream failed to start (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Broadcast each SessionEvent row not seen before as a `substrate:sessionEvent`
   * message. Dedup by eventId, so a row every poll returns is pushed once.
   */
  private pushNewSessionEvents(rows: SessionEventRow[]): void {
    for (const row of rows) {
      const id = row?.eventId;
      if (typeof id !== "string" || this.seenSessionEventIds.has(id)) continue;
      this.seenSessionEventIds.add(id);
      this.broadcast("substrate:sessionEvent", row);
    }
  }

  /** Set project info for the session state. `tokenLimit` is the session
   *  token limit (`max_tokens_per_session`). */
  setProject(project: string, tokenLimit: number): void {
    this.state.project = project;
    this.state.tokenLimit = tokenLimit;
  }

  /** Set the max worker count for display in the dashboard. */
  setMaxWorkers(maxWorkers: number): void {
    this.state.maxWorkers = maxWorkers;
  }

  /**
   * Update activeWorkerCount from worktree statuses, capped at maxWorkers.
   * The cap prevents the dashboard from showing more workers than configured
   * when worktree lifecycle events (created/merged/destroyed) arrive out of
   * order during parallel execution.
   */
  private updateActiveWorkerCount(): void {
    const raw = this.state.worktrees.filter(w => w.status === "active").length;
    this.state.activeWorkerCount = Math.min(raw, this.state.maxWorkers);
  }

  /** The port the server listens on (the OS's choice when constructed with 0), or null before it listens. */
  get listeningPort(): number | null {
    const address = this.server.address();
    return typeof address === "object" && address !== null ? address.port : null;
  }

  /**
   * Stop the server without waiting for anyone: every viewer's WebSocket is
   * terminated and every HTTP connection dropped (see below), then the server
   * closes. Resolves once it has; safe to call more than once.
   */
  async stop(): Promise<void> {
    this.sessionEventStream?.unsubscribe();
    if (this.unsubscribe) this.unsubscribe();
    // Drop the viewers' connections rather than wait for them. The server's
    // close only completes once every connection has ended, and `swarm run`
    // awaits this right before its summary and learning capture: a page that
    // is slow to answer the close frame, or a request still arriving, kept it
    // pending, and under Bun (the compiled binary) an open page alone did. The
    // page reconnects on any close, so an abrupt one costs it nothing.
    for (const client of this.clients) {
      client.terminate();
    }
    this.wss.close();
    this.server.closeAllConnections();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  // -----------------------------------------------------------------------
  // HTTP request routing
  // -----------------------------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // DNS rebinding: a hostile name re-pointed at this machine would be the
    // same origin as its own page. Answer only to this machine's own names.
    if (!isDashboardHost(req.headers.host, this.port, this.lan)) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end(MISDIRECTED);
      return;
    }

    // No CORS, anywhere: the dashboard page is served from this origin and is
    // the only caller of its API. A wildcard allow header let any website the
    // viewer had open read the run and the Substrate store (and PATCH tasks).

    // Axon design system tokens (CSS custom properties, both modes)
    if (url === "/axon.css") {
      res.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "max-age=3600" });
      res.end(axonCss);
      return;
    }

    // Dashboard HTML
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(this.dashboardHtml);
      return;
    }

    // Substrate proxy — forward to the run's own cold sidecar (see
    // proxyToSubstrate), so the page needs no CORS and no Substrate address of
    // its own. Only the ops in PROXIED_SUBSTRATE_OPS are forwarded, addressed
    // as /api/substrate/<op> or the sidecar's own /substrate/v1/<op>.
    if ((url.startsWith("/api/substrate/") || url.startsWith("/substrate/")) && (method === "POST" || method === "GET")) {
      this.proxyToSubstrate(req, res, method, url);
      return;
    }

    // One transcript, held since it arrived, by the id its summary carries (see keepTranscript).
    const transcriptPath = /^\/api\/transcript\/([^/?#]+)$/.exec(url);
    if (transcriptPath && method === "GET") {
      let id: string;
      try {
        id = decodeURIComponent(transcriptPath[1]);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed transcript id" }));
        return;
      }
      const full = this.transcripts.get(id)?.transcript;
      res.writeHead(full === undefined ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(full ?? { error: "No transcript with that id" }));
      return;
    }

    // REST API
    if (url === "/api/tasks" && method === "GET") {
      this.handleGetTasks(res);
      return;
    }

    const taskMatch = url.match(/^\/api\/tasks\/(.+)$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      // Validate taskId contains only safe characters (alphanumeric, hyphens, underscores)
      if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
        this.jsonResponse(res, 400, { error: "Invalid task ID" });
        return;
      }
      if (method === "GET") {
        this.handleGetTaskById(taskId, res);
        return;
      }
      if (method === "PATCH") {
        this.readBody(req).then((body) => {
          this.handlePatchTask(taskId, body, res);
        }).catch(() => {
          this.jsonResponse(res, 400, { error: "Invalid request body" });
        });
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  }

  // -----------------------------------------------------------------------
  // REST API handlers
  // -----------------------------------------------------------------------

  private handleGetTasks(res: ServerResponse): void {
    if (this.taskBackend) {
      this.taskBackend.getAllTasks().then((backendTasks) => {
        // Merge backend data with in-memory session state
        const merged = this.mergeTasksWithBackend(backendTasks);
        this.jsonResponse(res, 200, merged);
      }).catch(() => {
        // Fall back to session state on backend error
        this.jsonResponse(res, 200, this.state.tasks);
      });
    } else {
      this.jsonResponse(res, 200, this.state.tasks);
    }
  }

  private handleGetTaskById(taskId: string, res: ServerResponse): void {
    if (this.taskBackend) {
      this.taskBackend.getTaskById(taskId).then((backendTask) => {
        if (backendTask) {
          const sessionTask = this.state.tasks.find((t) => t.id === taskId);
          const merged = this.mergeOneTask(backendTask, sessionTask);
          this.jsonResponse(res, 200, merged);
        } else {
          // Try session state
          const t = this.state.tasks.find((t) => t.id === taskId);
          if (t) {
            this.jsonResponse(res, 200, t);
          } else {
            this.jsonResponse(res, 404, { error: "Task not found" });
          }
        }
      }).catch(() => {
        const t = this.state.tasks.find((t) => t.id === taskId);
        if (t) {
          this.jsonResponse(res, 200, t);
        } else {
          this.jsonResponse(res, 404, { error: "Task not found" });
        }
      });
    } else {
      const t = this.state.tasks.find((t) => t.id === taskId);
      if (t) {
        this.jsonResponse(res, 200, t);
      } else {
        this.jsonResponse(res, 404, { error: "Task not found" });
      }
    }
  }

  private handlePatchTask(taskId: string, body: string, res: ServerResponse): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.jsonResponse(res, 400, { error: "Invalid JSON" });
      return;
    }

    // Find the task in session state
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.jsonResponse(res, 404, { error: "Task not found" });
      return;
    }

    // Only pending tasks are editable
    if (task.status !== "pending") {
      this.jsonResponse(res, 403, { error: `Cannot edit task with status "${task.status}". Only pending tasks are editable.` });
      return;
    }

    // Only allow updating description
    const newDescription = parsed.description;
    if (typeof newDescription !== "string" || newDescription.trim().length === 0) {
      this.jsonResponse(res, 400, { error: "Only 'description' (non-empty string) can be updated" });
      return;
    }

    // Update in-memory state
    task.description = newDescription;

    // Write through to backend if available
    const backendPromise = this.taskBackend
      ? this.taskBackend.updateTask(taskId, { description: newDescription }).catch((err) => {
          console.error(`[dashboard] Backend write-through failed for task ${taskId}:`, err);
        })
      : Promise.resolve();

    backendPromise.then(() => {
      // Broadcast update over WebSocket
      this.broadcast("task:updated", { taskId, description: newDescription });
      this.jsonResponse(res, 200, task);
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private mergeTasksWithBackend(backendTasks: Task[]): SessionTask[] {
    const sessionMap = new Map(this.state.tasks.map((t) => [t.id, t]));
    const merged: SessionTask[] = [];

    for (const bt of backendTasks) {
      const st = sessionMap.get(bt.id);
      merged.push(this.mergeOneTask(bt, st));
      sessionMap.delete(bt.id);
    }

    // Add session-only tasks not in backend
    for (const st of sessionMap.values()) {
      merged.push(st);
    }

    return merged;
  }

  private mergeOneTask(backendTask: Task, sessionTask?: SessionTask): SessionTask {
    // Prefer the backend's terminal status when the session still shows a
    // non-terminal status — e.g., when a task:verdict WebSocket event was
    // missed and the session stuck at "in_progress" while tasks.json has "completed".
    const sessionIsNonTerminal = sessionTask?.status !== undefined && !TASK_TERMINAL_STATUSES.has(sessionTask.status);
    const backendIsTerminal = TASK_TERMINAL_STATUSES.has(backendTask.status);
    const status = backendIsTerminal && sessionIsNonTerminal ? backendTask.status : (sessionTask?.status ?? backendTask.status);

    return {
      id: backendTask.id,
      goalId: backendTask.goal_id,
      title: sessionTask?.title ?? backendTask.title,
      description: backendTask.description,
      intent: backendTask.intent,
      status,
      order: backendTask.order,
      verdict: sessionTask?.verdict,
      latencyMs: sessionTask?.latencyMs ?? backendTask.result?.latency_ms,
      arbiterInvolved: sessionTask?.arbiterInvolved,
      retryCount: sessionTask?.retryCount ?? backendTask.result?.retry_count,
      tokens: sessionTask?.tokens ?? backendTask.result?.tokens,
      subTaskIds: backendTask.subTaskIds,
      parentTaskId: backendTask.parentTaskId,
    };
  }

  /**
   * Forward a GET or POST to the run's own Substrate: the endpoint of the
   * SubstrateClient `swarm run` handed this dashboard. That client is the one
   * ensureSubstrateReady returned after the CLI applied the project's stack — a
   * dedicated project's own sidecar, or the shared one — so the dashboard shows
   * exactly the store the run reads and writes. Never a hard-coded port: with no
   * client (a file-only run, or `swarm dashboard preview`) there is no store to
   * show, and this answers 503. The upstream's status and Content-Type pass
   * through.
   */
  private proxyToSubstrate(req: IncomingMessage, res: ServerResponse, method: string, url: string): void {
    // Only JSON POSTs. A hostile page can send a text/plain, form or multipart
    // POST cross-origin without a preflight; forwarding it as JSON let it
    // write to the store blind. A JSON POST from another origin needs a
    // preflight, which this server never grants.
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (method === "POST" && contentType !== "application/json") {
      req.resume();
      this.jsonResponse(res, 415, { error: "Substrate proxy POSTs must be Content-Type: application/json" });
      return;
    }
    const upstreamPath = substrateProxyPath(method, url);
    if (upstreamPath === null) {
      req.resume();
      this.jsonResponse(res, 403, {
        error: `The dashboard forwards only ${PROXIED_SUBSTRATE_OPS} to its Substrate sidecar (as /api/substrate/<op> or /substrate/v1/<op>, no query string).`,
      });
      return;
    }
    const endpoint = this.substrateClient?.endpoint;
    if (!endpoint) {
      this.jsonResponse(res, 503, {
        error: "No Substrate store for this dashboard: the run is in file-only mode, or this is a preview.",
      });
      return;
    }
    const target = `${endpoint.replace(/\/+$/, "")}${upstreamPath}`;
    const forward = (body?: string): void => {
      const init = method === "POST" ? { method: "POST", headers: { "Content-Type": "application/json" }, body } : undefined;
      fetch(target, init)
        .then(async (upstream) => {
          const data = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
          });
          res.end(data);
        })
        .catch(() => {
          this.jsonResponse(res, 502, { error: "Substrate sidecar unreachable" });
        });
    };
    if (method === "POST") {
      // Bounded: under --dashboard-lan any host on the network can POST here.
      // Past the cap the rest of the body is read and dropped, never held.
      const tooLarge = (): void => {
        this.jsonResponse(res, 413, { error: `Substrate proxy POST bodies are limited to ${MAX_PROXY_BODY} bytes` });
      };
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_PROXY_BODY) {
        req.resume();
        tooLarge();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      req.on("data", (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size > MAX_PROXY_BODY) {
          refused = true;
          chunks.length = 0;
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!refused) forward(Buffer.concat(chunks).toString("utf-8"));
      });
    } else {
      forward();
    }
  }

  private jsonResponse(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 65536; // 64 KB
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}
