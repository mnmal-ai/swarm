/**
 * HTTP {@link Transport} for the Substrate sidecar: JSON over `fetch`.
 *
 * `query`/`mutate` POST to `/substrate/v1/query` and `/substrate/v1/mutate`.
 * `get` exposes the one GET path family the client needs
 * (`/substrate/v1/schema/<ns>` for `getSchema`); it is not on the
 * {@link Transport} interface. A non-ok response throws
 * `Substrate <op> failed: <status> <statusText>`, naming the op from the path
 * after `/substrate/v1/`; a request that outlives `timeoutMs` throws
 * {@link SubstrateTimeoutError}. Substrate answers 200 with per-frame `errors`
 * for a refused frame; the client reads those (see `client.ts`), not this layer.
 */

import type { SubstrateResponseEnvelope, Transport } from "./types.js";

/** How long one request may take by default. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** The error a non-ok response raises; `status` lets callers tell a 404 from a fault. */
export class SubstrateHttpError extends Error {
  override readonly name = "SubstrateHttpError";
  constructor(
    readonly op: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`Substrate ${op} failed: ${status} ${statusText}`);
  }
}

/** A request that got no answer within its timeout. */
export class SubstrateTimeoutError extends Error {
  override readonly name = "SubstrateTimeoutError";
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
  ) {
    super(`Substrate ${op} timed out after ${timeoutMs} ms`);
  }
}

export interface HttpTransportOptions {
  /** Per-request timeout. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export class HttpTransport implements Transport {
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  /** `endpoint` is normalized once (trailing slashes stripped) so path
   *  concatenation never produces a double slash. */
  constructor(endpoint: string, options: HttpTransportOptions = {}) {
    this.#endpoint = endpoint.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** POST `/substrate/v1/query`. */
  async query(body: unknown): Promise<SubstrateResponseEnvelope> {
    return this.#request("/substrate/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** POST `/substrate/v1/mutate`. The de-dupe key rides in the frame, not a header. */
  async mutate(body: unknown): Promise<SubstrateResponseEnvelope> {
    return this.#request("/substrate/v1/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** GET an absolute Substrate path (e.g. `/substrate/v1/schema/swarm`). */
  async get(path: string): Promise<SubstrateResponseEnvelope> {
    return this.#request(path, { method: "GET" });
  }

  /** No-op — stateless fetch holds no connection to tear down. */
  close(): void {
    // intentionally empty
  }

  async #request(path: string, init: RequestInit): Promise<SubstrateResponseEnvelope> {
    const op = opName(path);
    try {
      const response = await fetch(`${this.#endpoint}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw new SubstrateHttpError(op, response.status, response.statusText);
      return (await response.json()) as SubstrateResponseEnvelope;
    } catch (err) {
      if (isTimeout(err)) throw new SubstrateTimeoutError(op, this.#timeoutMs);
      throw err;
    }
  }
}

/** `AbortSignal.timeout` rejects fetch with a `TimeoutError` DOMException. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** `/substrate/v1/query` -> `query`; `/substrate/v1/schema/swarm` -> `schema/swarm`. */
function opName(path: string): string {
  return path.replace(/^\/substrate\/v1\//, "").replace(/^\//, "");
}
