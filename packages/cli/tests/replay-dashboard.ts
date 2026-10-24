/**
 * Telemetry Replay Dashboard
 *
 * Reads a JSONL telemetry file and replays all events through a DashboardServer
 * so you can see the dashboard populated with real cold test data.
 *
 * Usage:
 *   npx tsx tests/replay-dashboard.ts [path-to-jsonl] [--fast]
 *
 * Examples:
 *   npx tsx tests/replay-dashboard.ts "$SWARM_PATH"/telemetry/events/2026-02-24.jsonl
 *   npx tsx tests/replay-dashboard.ts "$SWARM_PATH"/telemetry/events/2026-02-24.jsonl --fast
 *
 * --fast: Replay all events instantly (no timing delays). Default: replay with
 *         compressed timing (100x speedup from real timestamps).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import { DashboardServer } from "../src/server/index.js";

interface TelemetryEvent {
  _type?: string;
  event: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const fast = args.includes("--fast");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: npx tsx tests/replay-dashboard.ts <path-to-jsonl> [--fast]");
    console.error("\nExample:");
    console.error("  npx tsx tests/replay-dashboard.ts $SWARM_PATH/telemetry/events/2026-02-24.jsonl --fast");
    process.exit(1);
  }

  const absPath = resolve(filePath);
  const raw = readFileSync(absPath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  const events: TelemetryEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  console.log(`Loaded ${events.length} events from ${absPath}`);

  // Extract timestamps for timing
  const timestamps: number[] = [];
  for (const e of events) {
    const ts = e.payload?.timestamp;
    if (typeof ts === "number" && ts > 1000000000) {
      timestamps.push(ts);
    }
  }

  const eventBus = new SwarmEventBus();
  const port = 3141;
  const dashboard = new DashboardServer(eventBus, port);

  // Try to set project info from session:start event
  const sessionStart = events.find((e) => e.event === "session:start");
  if (sessionStart) {
    const p = sessionStart.payload;
    dashboard.setProject(
      (p.project as string) || "replay",
      (p.tokenLimit as number) || 0,
    );
  }

  console.log(`\nDashboard running at http://localhost:${port}`);
  console.log(`Mode: ${fast ? "instant replay" : "compressed timing (100x speedup)"}`);
  console.log("Waiting 2s for browser connection...\n");
  await sleep(2000);

  const SPEEDUP = 100; // 100x faster than real time
  let lastTs = 0;
  let emitted = 0;

  for (const e of events) {
    const eventType = e.event;
    if (!eventType || eventType === "NONE") continue;

    // Timing
    if (!fast) {
      const ts = (e.payload?.timestamp as number) || 0;
      if (ts > 1000000000 && lastTs > 0) {
        const delta = ts - lastTs;
        if (delta > 0 && delta < 600000) { // cap at 10 min gaps
          const wait = Math.min(delta / SPEEDUP, 500); // cap individual waits at 500ms
          if (wait > 5) await sleep(wait);
        }
      }
      if (ts > 1000000000) lastTs = ts;
    }

    eventBus.emit(eventType, e.payload);
    emitted++;

    // Progress indicator every 100 events
    if (emitted % 100 === 0) {
      process.stdout.write(`  replayed ${emitted}/${events.length} events\r`);
    }
  }

  console.log(`\nReplay complete: ${emitted} events emitted.`);

  // Summary from the data
  const verdicts = events.filter((e) => e.event === "task:verdict");
  const approved = verdicts.filter((e) => e.payload?.verdict === "approved" || e.payload?.verdict === "skipped");
  const tokensOf = (t: unknown): number => {
    const b = (t ?? {}) as Record<string, unknown>;
    return ["freshInput", "cacheRead", "cacheWrite", "output"].reduce((n, k) => n + (Number(b[k]) || 0), 0);
  };
  const totalTokens = verdicts.reduce((sum, e) => sum + tokensOf(e.payload?.tokens), 0);
  const goals = events.filter((e) => e.event === "goal:completed");

  console.log(`  Tasks with verdicts: ${verdicts.length}`);
  console.log(`  Approved: ${approved.length}/${verdicts.length}`);
  console.log(`  Total tokens (verdicts): ${totalTokens.toLocaleString("en-US")}`);
  console.log(`  Goals completed: ${goals.length}`);
  console.log(`\nDashboard still running at http://localhost:${port} — press Ctrl+C to stop.\n`);
}

main().catch((err) => {
  console.error("Replay error:", err);
  process.exit(1);
});
