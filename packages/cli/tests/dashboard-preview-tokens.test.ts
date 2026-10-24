/**
 * `swarm dashboard preview` replays a scripted session so a person can check
 * the live page without a real run. The page now shows tokens, split into
 * fresh input, cache reads, cache writes and output, so the script must emit
 * that split — on the session (tokens:update) and on each task (task:verdict) —
 * and a session token limit so the budget bar is drawn. It carries no dollar
 * figure anywhere.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { SwarmEventBus } from "@mnmal-ai/swarm-events";
import type { TokensUpdateEvent, TaskVerdictEvent, TokenBreakdown } from "@mnmal-ai/swarm-types";
import { playFixture, PREVIEW_TOKEN_LIMIT } from "../src/cli/dashboard.js";

function total(t: TokenBreakdown): number {
  return t.freshInput + t.cacheRead + t.cacheWrite + t.output;
}

async function replay(): Promise<{ tokenUpdates: TokensUpdateEvent[]; verdicts: TaskVerdictEvent[]; all: Array<[string, unknown]> }> {
  vi.useFakeTimers();
  const bus = new SwarmEventBus();
  const tokenUpdates: TokensUpdateEvent[] = [];
  const verdicts: TaskVerdictEvent[] = [];
  const all: Array<[string, unknown]> = [];
  bus.on("tokens:update", (e) => tokenUpdates.push(e));
  bus.on("task:verdict", (e) => verdicts.push(e));
  bus.onAny((event, payload) => all.push([event, payload]));
  const done = playFixture(bus);
  await vi.runAllTimersAsync();
  await done;
  return { tokenUpdates, verdicts, all };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard preview fixture", () => {
  it("sends the session's token split and token limit on every tokens:update", async () => {
    const { tokenUpdates } = await replay();

    expect(tokenUpdates.length).toBeGreaterThan(0);
    for (const e of tokenUpdates) {
      expect(e.tokens).toBeDefined();
      expect(e.cumulativeTokens).toBe(total(e.tokens!));
      expect(e.sessionTokenLimit).toBe(PREVIEW_TOKEN_LIMIT);
    }
    const last = tokenUpdates[tokenUpdates.length - 1].tokens!;
    // Like a real Claude Code session, cache reads are most of the input.
    expect(last.cacheRead).toBeGreaterThan(last.freshInput);
    expect(last.cacheWrite).toBeGreaterThan(0);
    // The session stays under the preview's limit, so the bar is part-filled.
    expect(total(last)).toBeLessThan(PREVIEW_TOKEN_LIMIT);
  });

  it("sends each task's own token split on task:verdict, summing to the session", async () => {
    const { tokenUpdates, verdicts } = await replay();

    expect(verdicts).toHaveLength(3);
    for (const v of verdicts) {
      expect(v.tokens).toBeDefined();
      expect(v.tokens!.cacheRead).toBeGreaterThan(0);
      expect(v.tokens!.output).toBeGreaterThan(0);
    }
    const sum = verdicts.reduce((n, v) => n + total(v.tokens!), 0);
    expect(sum).toBe(tokenUpdates[tokenUpdates.length - 1].cumulativeTokens);
  });

  it("names tasks after their goal, so the page sums their tokens into the goal's line", async () => {
    const { verdicts } = await replay();

    // The page groups a goal's tasks by id prefix, as run.ts names them.
    for (const v of verdicts) expect(v.taskId.startsWith("goal-preview-1-")).toBe(true);
  });

  it("emits no dollar field on any event", async () => {
    const { all } = await replay();

    expect(JSON.stringify(all)).not.toMatch(/cost|Usd|usd/i);
  });
});
