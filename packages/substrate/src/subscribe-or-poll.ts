/**
 * subscribeOrPoll — keep a consumer's view of a type fresh by polling.
 *
 * Under the previous engine this subscribed over a WebSocket when one was negotiated and
 * polled otherwise. The Substrate client speaks HTTP only, so it always polls:
 * it starts the caller-supplied `poll` on `intervalMs` and returns a handle
 * whose `unsubscribe()` clears the interval. The call keeps its pre-Substrate shape
 * (client, subscription args, message handler, options) so callers move over
 * without restructuring; `onMessage` is never invoked, because there is no
 * push channel, and each poll tick is the caller's own read.
 */

import type { FieldSelection, SubstrateClient } from "./client.js";

/** What the caller wants kept fresh: one type in the client's namespace. */
export interface SubscribeArgs {
  typeName: string;
  params?: Record<string, unknown>;
  fields: FieldSelection;
}

/** A pushed message. Never delivered over Substrate's HTTP client; kept for the call shape. */
export interface SubscribeMessage {
  kind: string;
  data?: unknown;
}

export type SubscribeMessageHandler = (message: SubscribeMessage) => void;

/** Polling configuration for {@link subscribeOrPoll}. */
export interface SubscribeOrPollOptions {
  /**
   * The caller's polling action, invoked on every tick. Owns its own data
   * fetch + error handling; a rejected promise or a throw is caught here (and
   * warned) only to keep the timer from raising an unhandled rejection.
   */
  poll: () => void | Promise<void>;
  /** Interval between {@link poll} ticks, in milliseconds. */
  intervalMs: number;
}

/** Returned by {@link subscribeOrPoll}; `unsubscribe()` stops polling (idempotent). */
export interface SubscribeOrPollHandle {
  unsubscribe(): void;
}

/**
 * Poll `options.poll` every `options.intervalMs` until `unsubscribe()`. The
 * first tick runs after one interval. Async so existing `await` / `.then`
 * call sites keep working.
 */
export async function subscribeOrPoll(
  _client: SubstrateClient,
  _args: SubscribeArgs,
  _onMessage: SubscribeMessageHandler,
  options: SubscribeOrPollOptions,
): Promise<SubscribeOrPollHandle> {
  return startPolling(options);
}

/** Drive `poll` on `intervalMs` until `unsubscribe()` clears the interval. */
function startPolling({ poll, intervalMs }: SubscribeOrPollOptions): SubscribeOrPollHandle {
  const interval = setInterval(() => {
    try {
      const result = poll();
      if (result instanceof Promise) result.catch(warnPollFailure);
    } catch (error) {
      warnPollFailure(error);
    }
  }, intervalMs);
  return {
    unsubscribe(): void {
      clearInterval(interval);
    },
  };
}

function warnPollFailure(error: unknown): void {
  console.warn(
    `[substrate] subscribeOrPoll poll tick failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
