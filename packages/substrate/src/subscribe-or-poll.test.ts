/**
 * Ported from the previous engine package's `subscribe-or-poll.test.ts`. The WebSocket
 * branches (delegate to subscribe, fall back after an 'auto' reject, propagate
 * a non-transport subscribe error) went with the WebSocket transport: the
 * Substrate client polls only, so those cases now pin that it polls whatever
 * the client and never invokes onMessage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubstrateClient } from "./client.js";
import { type SubscribeArgs, subscribeOrPoll } from "./subscribe-or-poll.js";

const ARGS: SubscribeArgs = { typeName: "Task", params: { status: "open" }, fields: { id: true } };

/** subscribeOrPoll never touches the client, so any object stands in for one. */
function stubClient(): SubstrateClient {
  return { query: vi.fn(), mutate: vi.fn() } as unknown as SubstrateClient;
}

describe("subscribeOrPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls on intervalMs and never calls the client or onMessage", async () => {
    const client = stubClient();
    const onMessage = vi.fn();
    const poll = vi.fn();

    const handle = await subscribeOrPoll(client, ARGS, onMessage, { poll, intervalMs: 1000 });

    expect(poll).not.toHaveBeenCalled(); // setInterval — first tick after intervalMs
    vi.advanceTimersByTime(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onMessage).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.mutate).not.toHaveBeenCalled();

    handle.unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(poll).toHaveBeenCalledTimes(3); // interval cleared
  });

  it("unsubscribe is idempotent", async () => {
    const poll = vi.fn();
    const handle = await subscribeOrPoll(stubClient(), ARGS, vi.fn(), { poll, intervalMs: 500 });
    vi.advanceTimersByTime(500);
    expect(poll).toHaveBeenCalledTimes(1);
    handle.unsubscribe();
    handle.unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("guards the timer against a rejected async poll (no unhandled rejection)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poll = vi.fn(async () => {
      throw new Error("poll boom");
    });

    const handle = await subscribeOrPoll(stubClient(), ARGS, vi.fn(), { poll, intervalMs: 100 });
    vi.advanceTimersByTime(100);
    await Promise.resolve(); // let the rejected poll's .catch run
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("poll boom"));
    handle.unsubscribe();
  });

  it("guards the timer against a poll that throws synchronously, and keeps polling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poll = vi.fn(() => {
      throw new Error("sync boom");
    });

    const handle = await subscribeOrPoll(stubClient(), ARGS, vi.fn(), { poll, intervalMs: 100 });
    vi.advanceTimersByTime(300);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sync boom"));
    handle.unsubscribe();
  });
});
