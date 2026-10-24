/**
 * Ported from the previous engine package's `tests/client.test.ts`: the same cases over
 * Substrate's routes (`/substrate/v1/query`, `/substrate/v1/mutate`,
 * `/substrate/v1/schema/<ns>`). The WebSocket transport cases (transport
 * routing, transport selection, close under ws, subscribe) went with the
 * WebSocket transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubstrateClient, SubstrateFrameError } from "../src/client.js";

// Port 9 (discard): if a stub were ever missed, nothing answers there.
const ENDPOINT = "http://127.0.0.1:9";

/** Read one header off a fetch `init` whose headers are the plain object the transport builds. */
function header(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

/** The idempotencyKey of every entry in a request body. */
function entryKeys(init: RequestInit | undefined): Array<string | undefined> {
  const body = JSON.parse(init?.body as string) as Record<string, { idempotencyKey?: string }>;
  return Object.values(body).map((entry) => entry.idempotencyKey);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route GET /substrate/v1/schema/<ns> to `schemas[ns]`, 404 for any other namespace. */
function schemaRoutes(schemas: Record<string, unknown>) {
  return (url: string) => {
    const ns = decodeURIComponent(url.split("/substrate/v1/schema/")[1] ?? "");
    return Promise.resolve(
      ns in schemas ? jsonResponse(schemas[ns]) : jsonResponse({ error: `unknown namespace '${ns}'` }, 404),
    );
  };
}

describe("SubstrateClient", () => {
  describe("query", () => {
    it("namespaces op-keys with the configured namespace", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { "swarm/SwarmContent": [{ id: 1, path: "values.md" }] } }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const rows = await client.query<{ id: number; path: string }>(
        "SwarmContent",
        { tier: "always-load" },
        { id: true, path: true },
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/query");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        "swarm/SwarmContent": {
          params: { tier: "always-load" },
          fields: { id: true, path: true },
        },
      });
      expect(rows).toEqual([{ id: 1, path: "values.md" }]);
    });

    it("uses the swarm_meta namespace when configured", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { "swarm_meta/Decision": [{ id: 1, topic: "JSON over YAML" }] } }),
      );
      const client = new SubstrateClient(ENDPOINT, { namespace: "swarm_meta" });
      const rows = await client.query<{ id: number; topic: string }>(
        "Decision",
        {},
        { id: true, topic: true },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toHaveProperty("swarm_meta/Decision");
      expect(rows).toEqual([{ id: 1, topic: "JSON over YAML" }]);
    });

    it("returns [] when the frame's value is null, and throws when the key is missing from data", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { "swarm/SwarmContent": null } }));
      const client = new SubstrateClient(ENDPOINT);
      expect(await client.query("SwarmContent", {}, { id: true })).toEqual([]);

      fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }));
      const err = await client.query("SwarmContent", {}, { id: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubstrateFrameError);
      expect(err).toMatchObject({ key: "swarm/SwarmContent", code: "missing_key" });
    });

    it("follows Substrate's page cursor and returns every row when the caller names no limit", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: { "swarm/Section": [{ id: "s1" }, { id: "s2" }] },
            _pagination: { "swarm/Section": { hasMore: true, nextCursor: "c1" } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: { "swarm/Section": [{ id: "s3" }] },
            _pagination: { "swarm/Section": { hasMore: false } },
          }),
        );
      const client = new SubstrateClient(ENDPOINT);
      const where = { where: { projectId: { eq: "acme" } } };
      const rows = await client.query<{ id: string }>("Section", where, { id: true });

      expect(rows.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
      expect(bodies[0]["swarm/Section"].params).toEqual(where);
      expect(bodies[1]["swarm/Section"].params).toEqual({ ...where, cursor: "c1" });
    });

    it("returns the one page a caller asked for with limit or cursor", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { "swarm/Section": [{ id: "s1" }] },
          _pagination: { "swarm/Section": { hasMore: true, nextCursor: "c1" } },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const rows = await client.query<{ id: string }>("Section", { limit: 1 }, { id: true });
      expect(rows).toEqual([{ id: "s1" }]);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("checks errors before data: a refused frame throws with the server's code and message", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {},
          errors: [{ message: "unknown type 'Nope' in namespace 'swarm'", code: "unknown_type", path: ["swarm/Nope"] }],
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const err = await client.query("Nope", {}, { id: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubstrateFrameError);
      expect(err).toMatchObject({
        key: "swarm/Nope",
        code: "unknown_type",
        message: expect.stringContaining("unknown type 'Nope'"),
      });
    });
  });

  describe("mutate", () => {
    it("namespaces the mutation key", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { "swarm/createSwarmContent": { id: "abc" } } }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.mutate<{ id: string }>(
        "createSwarmContent",
        { path: "values.md", content: "..." },
        { id: true },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toHaveProperty("swarm/createSwarmContent");
      expect(result).toEqual({ id: "abc" });
    });

    it("throws SubstrateFrameError when the server refuses the write", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {},
          errors: [{ message: "field 'path' is required", code: "missing_field", path: ["swarm/createSwarmContent"] }],
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      await expect(client.mutate("createSwarmContent", {}, { id: true })).rejects.toMatchObject({
        name: "SubstrateFrameError",
        key: "swarm/createSwarmContent",
        code: "missing_field",
      });
    });
  });

  describe("loadContext", () => {
    it("posts the namespaced query key and returns the single object (not an array)", async () => {
      const response = {
        content: "# core\n...",
        filesIncluded: [{ path: "core/values.md", tier: "core", tokens: 120 }],
        tokensUsed: 120,
        budgetTokens: 15000,
        routeMatched: { intent: "implementation", description: "write code" },
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { "swarm/loadContext": response } }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.loadContext({
        intent: "implementation",
        projectId: "sample-app",
        modelId: "claude-opus-4-8",
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/query");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        "swarm/loadContext": {
          params: {
            intent: "implementation",
            projectId: "sample-app",
            modelId: "claude-opus-4-8",
          },
          fields: {
            content: true,
            filesIncluded: { path: true, tier: true, tokens: true },
            tokensUsed: true,
            budgetTokens: true,
            routeMatched: { intent: true, description: true },
            // The `context:loaded` event consumer iterates `truncated` —
            // omitting it from the field selection lands the response with
            // `truncated: undefined` and crashes every swarm.run.
            truncated: true,
            omitted: { path: true, tier: true, tokens: true },
            // context.pull's index; the resolver returns it only when asked.
            documents: {
              path: true,
              source: true,
              title: true,
              tokens: true,
              contentHash: true,
              sections: { ordinal: true, headingPath: true, synopsis: true, tokens: true, startLine: true, endLine: true, loaded: true, score: true },
            },
            // context.ranking's report; the resolver returns it only when asked.
            ranking: { status: true, candidates: true, loaded: true, tokens: true, model: true },
          },
        },
      });
      // Single object, NOT wrapped in an array like query() would.
      expect(result).toEqual(response);
    });
  });

  describe("classifyIntent", () => {
    it("posts to /substrate/v1/query and returns the classification", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            "swarm/classifyIntent": {
              intent: "implementation",
              confidence: "keyword",
              matchedKeywords: ["add", "implement"],
            },
          },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.classifyIntent({
        prompt: "add a new chain adapter",
        projectId: "sample-app",
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/query");
      const body = JSON.parse(init.body as string);
      expect(body).toHaveProperty("swarm/classifyIntent");
      expect(result).toEqual({
        intent: "implementation",
        confidence: "keyword",
        matchedKeywords: ["add", "implement"],
      });
    });

    it("forwards intentOverride for the exact-match path", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            "swarm/classifyIntent": {
              intent: "code-review",
              confidence: "exact",
              matchedKeywords: [],
            },
          },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      await client.classifyIntent({
        prompt: "whatever",
        projectId: "p",
        intentOverride: "code-review",
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body["swarm/classifyIntent"].params.intentOverride).toBe("code-review");
    });
  });

  describe("persistTaskTelemetry", () => {
    it("posts to /substrate/v1/mutate and returns the assigned ids", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            // The resolver answers { id: "ack", ids }; the client returns { ids }.
            "swarm/persistTaskTelemetry": {
              id: "ack",
              ids: { sessionEvent: "se1", transcript: "t1", workerResult: "w1" },
            },
          },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.persistTaskTelemetry({
        sessionEvent: {} as never,
        transcript: {} as never,
        workerResult: {} as never,
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/mutate");
      const body = JSON.parse(init.body as string);
      expect(body).toHaveProperty("swarm/persistTaskTelemetry");
      expect(result).toEqual({
        ids: { sessionEvent: "se1", transcript: "t1", workerResult: "w1" },
      });
    });

    it("forwards all telemetry inputs (incl. the optional reviewVerdict) in params and parses its id", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            "swarm/persistTaskTelemetry": {
              id: "ack",
              ids: { sessionEvent: "se1", transcript: "t1", workerResult: "w1", reviewVerdict: "rv1" },
            },
          },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const args = {
        sessionEvent: { eventId: "e1" },
        transcript: { sessionId: "s1" },
        workerResult: { sessionId: "s1" },
        reviewVerdict: { sessionId: "s1", verdict: "approve" },
      };
      const result = await client.persistTaskTelemetry(args as never);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      // Atomic resolver: the four telemetry inputs ride verbatim in one params
      // object — NOT split into separate ops like the batchMutate fallback.
      expect(body["swarm/persistTaskTelemetry"].params).toEqual(args);
      // The reviewVerdict id is surfaced only because the request carried one.
      expect(result.ids.reviewVerdict).toBe("rv1");
    });
  });

  describe("batchMutate (fallback envelope)", () => {
    it("bundles every operation into ONE mutate request keyed by namespaced op-key", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            "swarm/createSessionEvent": { id: "se1" },
            "swarm/createTranscriptEntry": { id: "t1" },
            "swarm/createWorkerResult": { id: "w1" },
          },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.batchMutate([
        { mutationName: "createSessionEvent", params: { eventId: "e" } },
        { mutationName: "createTranscriptEntry", params: { sessionId: "s" } },
        { mutationName: "createWorkerResult", params: { sessionId: "s" }, fields: { id: true } },
      ]);

      // Exactly one HTTP round trip — the point of the envelope.
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/mutate");
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body)).toEqual([
        "swarm/createSessionEvent",
        "swarm/createTranscriptEntry",
        "swarm/createWorkerResult",
      ]);
      // Default field selection is { id: true } when omitted.
      expect(body["swarm/createSessionEvent"].fields).toEqual({ id: true });
      expect(result).toEqual({
        "swarm/createSessionEvent": { id: "se1" },
        "swarm/createTranscriptEntry": { id: "t1" },
        "swarm/createWorkerResult": { id: "w1" },
      });
    });

    it("degrades the full atomic-persist set — including the optional ReviewVerdict — to individual namespace-prefixed mutations", async () => {
      // When persistTaskTelemetry is unavailable, the caller batches the same
      // four rows the atomic resolver would have written into ONE envelope of
      // individual create ops. This is the non-atomic equivalent; assert every
      // op is namespace-prefixed, carries its own params, and parses back.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            "swarm/createSessionEvent": { id: "se1" },
            "swarm/createTranscriptEntry": { id: "t1" },
            "swarm/createWorkerResult": { id: "w1" },
            "swarm/createReviewVerdict": { id: "rv1" },
          },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.batchMutate([
        { mutationName: "createSessionEvent", params: { eventId: "e" } },
        { mutationName: "createTranscriptEntry", params: { sessionId: "s" } },
        { mutationName: "createWorkerResult", params: { sessionId: "s" } },
        { mutationName: "createReviewVerdict", params: { workerResultId: "w1", verdict: "approve" } },
      ]);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/mutate");
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body)).toEqual([
        "swarm/createSessionEvent",
        "swarm/createTranscriptEntry",
        "swarm/createWorkerResult",
        "swarm/createReviewVerdict",
      ]);
      // Each individual op keeps its own params and the default { id: true } selection.
      expect(body["swarm/createReviewVerdict"].params).toEqual({
        workerResultId: "w1",
        verdict: "approve",
      });
      expect(body["swarm/createReviewVerdict"].fields).toEqual({ id: true });
      expect(result).toEqual({
        "swarm/createSessionEvent": { id: "se1" },
        "swarm/createTranscriptEntry": { id: "t1" },
        "swarm/createWorkerResult": { id: "w1" },
        "swarm/createReviewVerdict": { id: "rv1" },
      });
    });

    it("throws for the first operation the server refused", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { "swarm/createSessionEvent": { id: "se1" } },
          errors: [{ message: "bad verdict", code: "invalid_enum", path: ["swarm/createReviewVerdict"] }],
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      await expect(
        client.batchMutate([
          { mutationName: "createSessionEvent", params: {} },
          { mutationName: "createReviewVerdict", params: {} },
        ]),
      ).rejects.toMatchObject({ key: "swarm/createReviewVerdict", code: "invalid_enum" });
    });
  });

  describe("isHealthy", () => {
    it("hits /health", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = new SubstrateClient(ENDPOINT);
      const healthy = await client.isHealthy();
      expect(healthy).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9/health",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns false on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
      const client = new SubstrateClient(ENDPOINT);
      expect(await client.isHealthy()).toBe(false);
    });

    it("returns false on fetch failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const client = new SubstrateClient(ENDPOINT);
      expect(await client.isHealthy()).toBe(false);
    });

    it("gives up after 2 s on an endpoint that never answers", async () => {
      fetchMock.mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const started = Date.now();
      expect(await client.isHealthy()).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  describe("getSchema", () => {
    it("requests the namespace and its docs namespace, and caches the result", async () => {
      fetchMock.mockImplementation(
        schemaRoutes({
          swarm: { schemaVersion: "v1", types: { SwarmContent: {} }, mutations: { createSwarmContent: {} } },
          "swarm-docs": { schemaVersion: "v1", types: { Document: {}, Section: {} }, mutations: {} },
        }),
      );
      const client = new SubstrateClient(ENDPOINT);
      const schema1 = await client.getSchema();
      const schema2 = await client.getSchema();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "http://127.0.0.1:9/substrate/v1/schema/swarm",
        "http://127.0.0.1:9/substrate/v1/schema/swarm-docs",
      ]);
      expect(schema1).toBe(schema2);
      expect(Object.keys(schema1.namespaces.swarm.types)).toContain("SwarmContent");
      expect(Object.keys(schema1.namespaces.swarm.mutations)).toContain("createSwarmContent");
      expect(schema1.namespaces.swarm.queries).toEqual({});
      expect(Object.keys(schema1.namespaces["swarm-docs"].types)).toEqual(["Document", "Section"]);
    });

    it("throws when the server does not serve the configured namespace", async () => {
      fetchMock.mockImplementation(schemaRoutes({ other: { types: {} } }));
      const client = new SubstrateClient(ENDPOINT);
      await expect(client.getSchema()).rejects.toThrow(/'swarm' not found/);
    });

    it("leaves out a docs namespace the server does not serve (a meta client has none)", async () => {
      fetchMock.mockImplementation(schemaRoutes({ swarm_meta: { types: { Decision: {} }, mutations: {} } }));
      const client = new SubstrateClient(ENDPOINT, { namespace: "swarm_meta" });
      const schema = await client.getSchema();
      expect(Object.keys(schema.namespaces)).toEqual(["swarm_meta"]);
      expect(await client.hasType("Decision")).toBe(true);
      expect(await client.hasType("Goal")).toBe(false);
    });

    it("invalidateSchema forces re-fetch", async () => {
      fetchMock
        .mockImplementationOnce(schemaRoutes({ swarm: { types: { SwarmContent: {} } } }))
        .mockImplementationOnce(schemaRoutes({}))
        .mockImplementationOnce(schemaRoutes({ swarm: { types: { SwarmContent: {}, SwarmRoute: {} } } }))
        .mockImplementationOnce(schemaRoutes({}));
      const client = new SubstrateClient(ENDPOINT);
      await client.getSchema();
      client.invalidateSchema();
      const schema = await client.getSchema();
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(Object.keys(schema.namespaces.swarm.types)).toContain("SwarmRoute");
    });
  });

  describe("ingest", () => {
    it("loops mutate('create<Type>', row) for each input row", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ data: { "swarm/createSwarmContent": { id: "x" } } }),
        ),
      );
      const client = new SubstrateClient(ENDPOINT);
      const result = await client.ingest("SwarmContent", [
        { path: "a.md", content: "A" },
        { path: "b.md", content: "B" },
      ]);
      expect(result).toEqual({ accepted: 2, typeName: "SwarmContent" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("replace mode surfaces partial-delete failure with caller-actionable error", async () => {
      // Sequence: query returns 2 rows, first delete OK, second delete 500.
      // Expectation: throws naming the failed id, mentions the partial-cleared
      // state, and never proceeds to the create loop.
      let call = 0;
      fetchMock.mockImplementation((_url, init) => {
        call++;
        const body = JSON.parse((init as RequestInit).body as string);
        if ("swarm/SwarmContent" in body) {
          return Promise.resolve(
            jsonResponse({ data: { "swarm/SwarmContent": [{ id: "a" }, { id: "b" }] } }),
          );
        }
        if ("swarm/deleteSwarmContent" in body) {
          const params = (body as Record<string, { params: { id: string } }>)["swarm/deleteSwarmContent"].params;
          if (params.id === "b") {
            return Promise.resolve(new Response("nope", { status: 500, statusText: "Internal Server Error" }));
          }
          return Promise.resolve(jsonResponse({ data: { "swarm/deleteSwarmContent": { id: params.id } } }));
        }
        if ("swarm/createSwarmContent" in body) {
          // Should never reach here — the throw aborts the ingest before create runs.
          return Promise.resolve(jsonResponse({ data: { "swarm/createSwarmContent": { id: "x" } } }));
        }
        throw new Error(`unexpected call ${call}: ${JSON.stringify(body)}`);
      });

      const client = new SubstrateClient(ENDPOINT);
      await expect(
        client.ingest("SwarmContent", [{ path: "c.md", content: "C" }], "replace"),
      ).rejects.toThrow(/replace ingest for SwarmContent.*1 delete\(s\) failed.*id=b/s);
      // Verify no create was attempted.
      const createCalls = fetchMock.mock.calls.filter(([, init]) =>
        ((init as RequestInit).body as string).includes("createSwarmContent"),
      );
      expect(createCalls).toHaveLength(0);
    });

    it("replace mode propagates an initial query failure rather than silently continuing", async () => {
      // If the existence query fails, swallowing it would turn `replace` into an
      // inadvertent `extend`. The failure surfaces to the caller.
      fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "Internal Server Error" }));
      const client = new SubstrateClient(ENDPOINT);
      await expect(
        client.ingest("SwarmContent", [{ path: "a.md", content: "A" }], "replace"),
      ).rejects.toThrow(/query failed/i);
    });
  });

  describe("HTTP error propagation", () => {
    it("query throws with status + statusText on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("bad request body", { status: 400, statusText: "Bad Request" }),
      );
      const client = new SubstrateClient(ENDPOINT);
      await expect(
        client.query("SwarmContent", {}, { id: true }),
      ).rejects.toThrow(/query failed.*400.*Bad Request/i);
    });

    it("mutate throws with status + statusText on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("server error", { status: 500, statusText: "Internal Server Error" }),
      );
      const client = new SubstrateClient(ENDPOINT);
      await expect(
        client.mutate("createSwarmContent", { path: "a.md" }, { id: true }),
      ).rejects.toThrow(/mutate failed.*500.*Internal Server Error/i);
    });
  });

  describe("constructor", () => {
    it("strips trailing slashes from the endpoint so URLs join cleanly", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { "swarm/SwarmContent": [] } }));
      const client = new SubstrateClient(`${ENDPOINT}///`);
      await client.query("SwarmContent", {}, { id: true });
      const [url] = fetchMock.mock.calls[0];
      // Should be exactly one slash between host and /substrate/v1/query.
      expect(url).toBe("http://127.0.0.1:9/substrate/v1/query");
    });
  });

  describe("close", () => {
    it("is safe to call (idempotent)", () => {
      const client = new SubstrateClient(ENDPOINT);
      // HTTP holds no connection — close is a safe, repeatable no-op.
      expect(() => client.close()).not.toThrow();
      expect(() => client.close()).not.toThrow();
    });
  });

  describe("idempotency keys", () => {
    it("mutate puts a fresh idempotencyKey beside params in its frame entry; query carries none", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { "swarm/SwarmContent": [] } }))
        .mockResolvedValueOnce(jsonResponse({ data: { "swarm/createSwarmContent": { id: "1" } } }));
      const client = new SubstrateClient(ENDPOINT);

      await client.query("SwarmContent", {}, { id: true });
      await client.mutate("createSwarmContent", { path: "a.md" }, { id: true });

      // A read carries no de-dupe key.
      expect(entryKeys(fetchMock.mock.calls[0][1])).toEqual([undefined]);
      // A write does, as a sibling of params (Substrate's FrameEntry.idempotencyKey), never inside it.
      const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(Object.keys(body["swarm/createSwarmContent"]).sort()).toEqual(["fields", "idempotencyKey", "params"]);
      expect(body["swarm/createSwarmContent"].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(body["swarm/createSwarmContent"].params).toEqual({ path: "a.md" });
      // No header carries it.
      expect(header(fetchMock.mock.calls[1][1], "Idempotency-Key")).toBeUndefined();
    });

    it("batchMutate puts ONE key on every entry of its envelope", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { "swarm/createSessionEvent": { id: "se" }, "swarm/createWorkerResult": { id: "w" } } }),
      );
      const client = new SubstrateClient(ENDPOINT);
      await client.batchMutate([
        { mutationName: "createSessionEvent", params: { eventId: "e" } },
        { mutationName: "createWorkerResult", params: { sessionId: "s" } },
      ]);
      const keys = entryKeys(fetchMock.mock.calls[0][1]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/.+/);
      expect(keys[1]).toBe(keys[0]);
    });

    it("mints a DISTINCT key per mutation across mutate / batchMutate / persistTaskTelemetry", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { "swarm/createSwarmContent": { id: "1" } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { "swarm/createSwarmContent": { id: "2" } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { "swarm/createSessionEvent": { id: "se" } } }))
        .mockResolvedValueOnce(jsonResponse({ data: { "swarm/persistTaskTelemetry": { id: "ack", ids: {} } } }));
      const client = new SubstrateClient(ENDPOINT);

      await client.mutate("createSwarmContent", { path: "a.md" }, { id: true });
      await client.mutate("createSwarmContent", { path: "b.md" }, { id: true });
      await client.batchMutate([{ mutationName: "createSessionEvent", params: { eventId: "e" } }]);
      await client.persistTaskTelemetry({
        sessionEvent: {} as never,
        transcript: {} as never,
        workerResult: {} as never,
      });

      const keys = fetchMock.mock.calls.map(([, init]) => entryKeys(init as RequestInit)[0]);
      // Every write path carried a key, and all four are unique.
      expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
      expect(new Set(keys).size).toBe(4);
    });

    it("ingest's per-row create mutations each carry their own key", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { "swarm/createSwarmContent": { id: "x" } } })),
      );
      const client = new SubstrateClient(ENDPOINT);
      await client.ingest("SwarmContent", [{ path: "a.md" }, { path: "b.md" }]);

      const keys = fetchMock.mock.calls.map(([, init]) => entryKeys(init as RequestInit)[0]);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
    });
  });
});

describe("SubstrateClient timeoutMs", () => {
  it("bounds query and mutate by the client's timeoutMs", async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = new SubstrateClient(ENDPOINT, { timeoutMs: 50 });
    await expect(client.query("SwarmContent", {}, { id: true })).rejects.toThrow("Substrate query timed out after 50 ms");
    await expect(client.mutate("createSwarmContent", {}, { id: true })).rejects.toThrow("Substrate mutate timed out after 50 ms");
  });
});

describe("SubstrateClient.endpoint", () => {
  it("exposes the endpoint the client talks to, without a trailing slash", () => {
    const client = new SubstrateClient("http://127.0.0.1:42338/");
    expect(client.endpoint).toBe("http://127.0.0.1:42338");
    expect(client.namespace).toBe("swarm");
  });
});
