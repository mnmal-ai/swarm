import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REQUEST_TIMEOUT_MS, HttpTransport, SubstrateHttpError, SubstrateTimeoutError } from "./http-transport.js";

/** Build a `fetch` mock returning a single canned Response-like object. */
function mockFetch(init: { ok: boolean; status?: number; statusText?: string; json?: unknown }) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    statusText: init.statusText ?? (init.ok ? "OK" : "Internal Server Error"),
    json: async () => init.json ?? {},
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("HttpTransport", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("query", () => {
    it("POSTs the body to /substrate/v1/query and returns the parsed envelope", async () => {
      const envelope = { data: { "swarm/Foo": [{ id: 1 }] } };
      const fetchMock = mockFetch({ ok: true, json: envelope });
      const t = new HttpTransport("http://localhost:4000");

      const body = { "swarm/Foo": { params: {}, fields: { id: true } } };
      const result = await t.query(body);

      expect(result).toEqual(envelope);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:4000/substrate/v1/query");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    });
  });

  describe("mutate", () => {
    it("POSTs the body to /substrate/v1/mutate", async () => {
      const fetchMock = mockFetch({ ok: true, json: { data: {} } });
      const t = new HttpTransport("http://localhost:4000");

      await t.mutate({ "swarm/createFoo": { params: { x: 1 }, fields: { id: true } } });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:4000/substrate/v1/mutate");
      expect(init?.method).toBe("POST");
      // No idempotency key supplied -> only the content-type header.
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    });

    it("sends the frame verbatim, de-dupe key included, and no Idempotency-Key header", async () => {
      const fetchMock = mockFetch({ ok: true, json: { data: {} } });
      const t = new HttpTransport("http://localhost:4000");

      const frame = { "swarm/createFoo": { params: {}, fields: { id: true }, idempotencyKey: "k-1" } };
      await t.mutate(frame);

      const init = fetchMock.mock.calls[0][1];
      // Substrate reads idempotencyKey from the frame entry; no header carries it.
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(init?.body as string)).toEqual(frame);
    });
  });

  describe("get", () => {
    it("GETs the given path and returns the parsed envelope", async () => {
      const schema = { types: {}, mutations: {} };
      const fetchMock = mockFetch({ ok: true, json: schema });
      const t = new HttpTransport("http://localhost:4000");

      const result = await t.get("/substrate/v1/schema/swarm");

      expect(result).toEqual(schema);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:4000/substrate/v1/schema/swarm");
      expect(init).toMatchObject({ method: "GET" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("endpoint normalization", () => {
    it("strips trailing slashes so paths never double up", async () => {
      const fetchMock = mockFetch({ ok: true, json: {} });
      const t = new HttpTransport("http://localhost:4000///");

      await t.query({});

      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4000/substrate/v1/query");
    });
  });

  describe("error format", () => {
    it("throws 'Substrate query failed: <status> <statusText>' on a non-ok POST", async () => {
      mockFetch({ ok: false, status: 400, statusText: "Bad Request" });
      const t = new HttpTransport("http://localhost:4000");

      await expect(t.query({})).rejects.toThrow("Substrate query failed: 400 Bad Request");
    });

    it("names the op from the path on a mutate failure", async () => {
      mockFetch({ ok: false, status: 500, statusText: "Internal Server Error" });
      const t = new HttpTransport("http://localhost:4000");

      await expect(t.mutate({})).rejects.toThrow(
        "Substrate mutate failed: 500 Internal Server Error",
      );
    });

    it("names the op from the path on a get failure, and carries the status", async () => {
      mockFetch({ ok: false, status: 404, statusText: "Not Found" });
      const t = new HttpTransport("http://localhost:4000");

      const err = await t.get("/substrate/v1/schema/swarm").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubstrateHttpError);
      expect((err as SubstrateHttpError).status).toBe(404);
      expect((err as Error).message).toBe("Substrate schema/swarm failed: 404 Not Found");
    });
  });

  describe("timeout", () => {
    /** A fetch that never answers on its own, only rejects when its signal aborts. */
    function hangingFetch() {
      const fn = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      vi.stubGlobal("fetch", fn);
      return fn;
    }

    it("gives every request a 30 s timeout by default", async () => {
      const fetchMock = mockFetch({ ok: true, json: { data: {} } });
      await new HttpTransport("http://localhost:4000").query({});
      expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
      expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("throws SubstrateTimeoutError naming the op when the endpoint never answers", async () => {
      hangingFetch();
      const t = new HttpTransport("http://localhost:4000", { timeoutMs: 50 });
      await expect(t.mutate({})).rejects.toThrow(SubstrateTimeoutError);
      await expect(t.query({})).rejects.toThrow("Substrate query timed out after 50 ms");
      await expect(t.get("/substrate/v1/schema/swarm")).rejects.toThrow("Substrate schema/swarm timed out after 50 ms");
    });
  });

  describe("close", () => {
    it("is a no-op (stateless fetch holds no connection)", () => {
      const t = new HttpTransport("http://localhost:4000");
      expect(t.close()).toBeUndefined();
    });
  });
});
