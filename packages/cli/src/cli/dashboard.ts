// `swarm dashboard` — diagnostic/preview commands for the live dashboard UI.
//
// `swarm dashboard preview` spins up the same DashboardServer that `swarm run`
// uses, then replays a short scripted sequence of swarm events against an
// in-memory event bus. No Substrate, no API keys, no orchestrator. Purpose: let a
// human (or CI) verify rendering and design system tokens without standing up
// the full stack — the diagnostic surface the design-system work was
// missing.

import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { addTokenBreakdown, emptyTokenBreakdown, tokenBreakdownTotal } from "@mnmal-ai/swarm-types";
import type { TokenBreakdown } from "@mnmal-ai/swarm-types";
import { isLocalOnlyEnv } from "@mnmal-ai/swarm-substrate";
import { DashboardServer, lanWarning } from "../server/index.js";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";

/** Session token limit the preview reports, so the page draws its budget bar.
 *  The scripted session uses roughly 60% of it. */
export const PREVIEW_TOKEN_LIMIT = 500_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp(): void {
  console.log("Usage: swarm dashboard <command>");
  console.log("");
  console.log("Commands:");
  console.log("  preview     Replay a scripted swarm session against a live dashboard");
  console.log("");
  console.log("Preview options:");
  console.log("  --port <n>      Dashboard port (default 3141)");
  console.log("  --lan           Bind on 0.0.0.0 (default 127.0.0.1) — no login: anyone on the network");
  console.log("                  can see the dashboard, and read and change this project's Substrate store");
}

export async function runDashboard(
  args: Record<string, string>,
  positional: string[],
): Promise<void> {
  const sub = positional[0];
  if (!sub || sub === "help" || args["help"] === "true" || args["h"] === "true") {
    printHelp();
    return;
  }
  switch (sub) {
    case "preview":
      await runDashboardPreview(args);
      return;
    default:
      console.error(`${RED}Unknown dashboard command:${RST} ${sub}`);
      console.error("");
      printHelp();
      process.exit(1);
  }
}

async function runDashboardPreview(args: Record<string, string>): Promise<void> {
  const port = parseInt(args["port"] ?? "3141", 10);
  const lan = args["lan"] === "true" || args["dashboard-lan"] === "true";

  const eventBus = new SwarmEventBus();
  const dashboard = new DashboardServer(eventBus, port, undefined, lan);
  dashboard.setProject("dashboard-preview", PREVIEW_TOKEN_LIMIT);

  for (const line of previewBanner(port, lan, isLocalOnlyEnv())) console.log(line);

  // Give the dashboard ~1s to bind + accept WS connections so the operator
  // can have the page open before events start landing.
  await sleep(1000);
  await playFixture(eventBus);

  // Hold the process open after the script finishes so the dashboard keeps
  // serving and the operator can poke around in the rendered state.
  console.log(`  ${DIM}Fixture complete. Dashboard idle — Ctrl+C to exit.${RST}`);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
}

/**
 * What `swarm dashboard preview` prints when it starts: where to open it and,
 * under --lan, what serving it on the network exposes.
 */
export function previewBanner(port: number, lan: boolean, localOnly: boolean): string[] {
  const host = lan ? "0.0.0.0" : "localhost";
  return [
    "",
    `  ${CYAN}swarm dashboard preview${RST}`,
    `  ${DIM}URL:${RST}    http://${host}:${port}/`,
    `  ${DIM}Mode:${RST}   in-memory fixture (no Substrate, no API keys)`,
    `  ${DIM}Stop:${RST}   Ctrl+C`,
    ...(lan ? ["", ...lanWarning(localOnly).map((line) => `${YELLOW}${line}${RST}`)] : []),
    "",
  ];
}

// ---------------------------------------------------------------------------
// Fixture — a compressed scripted session that exercises the main UI sections,
// optimised for "can a human eyeball whether the page renders correctly" in
// ~15s. tests/dashboard-page-tokens.test.ts checks the page itself.
// ---------------------------------------------------------------------------

export async function playFixture(bus: SwarmEventBus): Promise<void> {
  const now = (): number => Date.now();
  const sessionId = "sess-preview";
  const reviewerSessionId = "sess-preview-reviewer";
  const goalId = "goal-preview-1";
  const taskIds = [`${goalId}-task-1`, `${goalId}-task-2`, `${goalId}-task-3`];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTurns = 0;
  const sessionStartedAt = now();
  const rand = (n: number): number => Math.floor(Math.random() * n);

  // The dashboard shows tokens: fresh input, cache reads, cache writes and
  // output, per session and per task. Accumulate the split from
  // the per-turn and reviewer-pass values emitted below, the way run.ts sums
  // each task result into its session total. Cache reads dominate, as they do
  // in a real Claude Code session.
  let sessionTokens: TokenBreakdown = emptyTokenBreakdown();
  const addTokens = (t: TokenBreakdown): void => {
    sessionTokens = addTokenBreakdown(sessionTokens, t);
    totalInputTokens += t.freshInput + t.cacheRead + t.cacheWrite;
    totalOutputTokens += t.output;
  };
  const emitTokensUpdate = (): void => {
    const cumulative = tokenBreakdownTotal(sessionTokens);
    bus.emit("tokens:update", {
      cumulativeTokens: cumulative,
      tokens: sessionTokens,
      sessionTokenLimit: PREVIEW_TOKEN_LIMIT,
      percentUsed: (cumulative / PREVIEW_TOKEN_LIMIT) * 100,
      timestamp: now(),
    });
  };

  bus.emit("session:start", {
    sessionId,
    swarmPath: ".swarm",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    role: "worker",
    swarmVersion: "v0.35.0-preview",
    project: "dashboard-preview",
    trustLevel: "medium",
    tokenLimit: PREVIEW_TOKEN_LIMIT,
    timestamp: now(),
  });
  await sleep(300);

  bus.emit("agent:role", {
    sessionId,
    role: "worker",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    timestamp: now(),
  });
  await sleep(200);

  bus.emit("goal:start", {
    goalId,
    description: "Wire the Axon design system into the live dashboard",
    taskCount: 3,
    timestamp: now(),
  });
  await sleep(300);

  bus.emit("goal:decomposed", {
    goalId,
    tasks: [
      { id: taskIds[0], description: "Inline Axon CSS at build time", intent: "implementation" },
      { id: taskIds[1], description: "Add `swarm dashboard preview` subcommand", intent: "implementation" },
      { id: taskIds[2], description: "Verify rendering across viewports", intent: "verification" },
    ],
    timestamp: now(),
  });
  await sleep(400);

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i];
    const isVerification = i === 2;
    const description =
      i === 0 ? "Inline Axon CSS at build time" :
      i === 1 ? "Add `swarm dashboard preview` subcommand" :
                "Verify rendering across viewports";

    bus.emit("task:start", {
      taskId,
      goalId,
      description,
      intent: isVerification ? "verification" : "implementation",
      timestamp: now(),
    });
    let taskTokens: TokenBreakdown = emptyTokenBreakdown();
    await sleep(200);

    bus.emit("intent:classified", {
      sessionId,
      intent: isVerification ? "verification" : "implementation",
      confidence: "keyword",
      matchedKeywords: isVerification ? ["verify", "check"] : ["add", "implement"],
      routeDescription: isVerification ? "Validate behavior end-to-end" : "Build a feature or implement changes",
      timestamp: now(),
    });
    await sleep(200);

    bus.emit("context:loaded", {
      sessionId,
      files: [
        { path: "core/values.md", tier: "core", estimatedTokens: 450 },
        { path: "core/rules.md", tier: "core", estimatedTokens: 380 },
        { path: "modes/implementation.md", tier: "mode", estimatedTokens: 520 },
        { path: "capabilities/dashboard.md", tier: "capabilities", estimatedTokens: 280 },
      ],
      totalTokens: 1630,
      budgetMax: 15000,
      budgetUsedPercent: 11,
      truncated: [],
      timestamp: now(),
    });
    await sleep(300);

    // Two turns per task — enough to populate the event log and token panel.
    for (let turn = 1; turn <= 2; turn++) {
      totalTurns++;
      bus.emit("turn:start", {
        turn: totalTurns,
        messageCount: totalTurns * 2,
        timestamp: now(),
      });
      await sleep(200);

      const toolName = turn === 1 ? "Read" : "Edit";
      const toolUseId = `tu_${taskId}_t${turn}`;
      bus.emit("tool:start", {
        turn: totalTurns,
        toolName,
        toolInput: { file_path: "packages/cli/src/server/index.ts" },
        toolUseId,
        taskId,
        sessionId,
        timestamp: now(),
      });
      await sleep(300);

      bus.emit("tool:end", {
        turn: totalTurns,
        toolName,
        durationMs: 180,
        isError: false,
        toolUseId,
        taskId,
        sessionId,
        timestamp: now(),
      });
      await sleep(200);

      const turnTokens: TokenBreakdown = {
        freshInput: 4000 + rand(1500),
        cacheRead: 30_000 + rand(10_000),
        cacheWrite: 2000 + rand(1000),
        output: 600 + rand(300),
      };
      taskTokens = addTokenBreakdown(taskTokens, turnTokens);
      addTokens(turnTokens);
      bus.emit("turn:end", {
        turn: totalTurns,
        inputTokens: turnTokens.freshInput,
        outputTokens: turnTokens.output,
        toolCallCount: 1,
        timestamp: now(),
      });
      emitTokensUpdate();
      await sleep(250);
    }

    // Oversight: a quick reviewer pass to populate the oversight panel.
    bus.emit("oversight:start", {
      sessionId: reviewerSessionId,
      role: "reviewer",
      model: "claude-sonnet-4-6",
      timestamp: now(),
    });
    await sleep(300);

    // Reviewer-pass tokens, counted toward the task and the session. Smaller
    // than a worker turn (reviewers process diffs, not raw context).
    const reviewerTokens: TokenBreakdown = {
      freshInput: 1500 + rand(500),
      cacheRead: 8000 + rand(2000),
      cacheWrite: 500 + rand(300),
      output: 200 + rand(100),
    };
    taskTokens = addTokenBreakdown(taskTokens, reviewerTokens);
    addTokens(reviewerTokens);
    bus.emit("oversight:verdict", {
      sessionId: reviewerSessionId,
      verdict: "approved",
      arbiterInvolved: false,
      retryCount: 0,
      durationMs: 320,
      timestamp: now(),
    });
    emitTokensUpdate();
    await sleep(200);

    bus.emit("task:verdict", {
      taskId,
      verdict: "approved",
      latencyMs: 320,
      retryCount: 0,
      tokens: taskTokens,
      timestamp: now(),
    });
    await sleep(400);
  }

  bus.emit("goal:completed", {
    goalId,
    completedTasks: taskIds.length,
    totalTasks: taskIds.length,
    totalTokens: tokenBreakdownTotal(sessionTokens),
    timestamp: now(),
  });
  await sleep(300);

  // What the fnl tile shows: one build command digested, one left as written,
  // and what the digest saved: its log was over Claude Code's limit, so
  // without fnl the agent would have got a 2,000-character preview.
  const fnl = {
    buildCommands: 2,
    wrapped: 1,
    leftAlone: { structure: 1 },
    byTool: { vitest: { wrapped: 1, leftAlone: 1 } },
    unanswered: 0,
    savings: { calls: 1, rawTokens: 21_400, sentTokens: 90, withoutFnlTokens: 500, savedTokens: 410, unmeasured: 0, oversized: 1 },
  };
  bus.emit("backend:fnl_coverage", { role: "worker", coverage: fnl, timestamp: now() });

  bus.emit("session:end", {
    sessionId,
    role: "worker",
    fnl,
    totalInputTokens,
    totalOutputTokens,
    totalTurns,
    latencyMs: now() - sessionStartedAt,
    maxTurnsReached: false,
    timestamp: now(),
  });
}
