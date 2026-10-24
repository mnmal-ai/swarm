/**
 * Upload Lambda — run metadata in tokens.
 *
 * swarm reports a run's size in tokens (`total_tokens`: all input, cache
 * included, plus output) and no longer sends a dollar figure. The Lambda
 * stores `total_tokens` from the upload body, still accepts an older
 * client's `total_cost_usd` without requiring it, and returns `total_tokens`
 * wherever it returns run metadata.
 *
 * The AWS SDK is replaced with in-memory fakes: nothing here reaches AWS.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// The AWS SDK is mapped to the fakes in test/fakes/aws-sdk (jest.config.js).
import { sent, setDdbReply, reset } from "./fakes/aws-sdk/recorder.mjs";
import { handler } from "../lambda/index.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upload(body) {
  return handler({ httpMethod: "POST", resource: "/upload-url", body: JSON.stringify(body), headers: {} });
}

/** The run-index item the last upload wrote. */
function storedItem() {
  const put = sent.filter((c) => c.name === "ddb:Put").at(-1);
  return put.input.Item;
}

const ANON_UPLOAD = { identity_type: "anon", identity: "anon-id-1", run_id: "run-1", project: "sample-project" };

const realFetch = globalThis.fetch;

beforeEach(() => {
  reset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// POST /upload-url
// ---------------------------------------------------------------------------

describe("POST /upload-url", () => {
  it("stores the run's total_tokens", async () => {
    const res = await upload({ ...ANON_UPLOAD, total_tokens: 1_140_000 });

    expect(res.statusCode).toBe(200);
    expect(storedItem().total_tokens).toBe(1_140_000);
  });

  it("stores 0 when total_tokens is missing or not a number", async () => {
    await upload(ANON_UPLOAD);
    expect(storedItem().total_tokens).toBe(0);

    await upload({ ...ANON_UPLOAD, total_tokens: "lots" });
    expect(storedItem().total_tokens).toBe(0);
  });

  it("does not store a dollar figure a current client never sent", async () => {
    await upload({ ...ANON_UPLOAD, total_tokens: 500 });

    expect(storedItem()).not.toHaveProperty("total_cost_usd");
  });

  it("still accepts an older client's total_cost_usd, without requiring total_tokens", async () => {
    const res = await upload({ ...ANON_UPLOAD, total_cost_usd: 1.25 });

    expect(res.statusCode).toBe(200);
    expect(storedItem().total_cost_usd).toBe(1.25);
    expect(storedItem().total_tokens).toBe(0);
  });

  it("drops an older client's total_cost_usd that is negative or not finite", async () => {
    for (const bad of [-5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const res = await upload({ ...ANON_UPLOAD, total_cost_usd: bad });

      expect(res.statusCode).toBe(200);
      expect(storedItem()).not.toHaveProperty("total_cost_usd");
    }
  });
});

// ---------------------------------------------------------------------------
// Read routes
// ---------------------------------------------------------------------------

/** A signed-in, allow-listed reader: GitHub says who they are, the access table lets them in. */
function signedIn(itemsForRead) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ login: "reader" }) });
  setDdbReply((cmd) => {
    if (cmd.name === "ddb:Get") return { Item: { github_username: "reader" } };
    return { Items: itemsForRead };
  });
}

function read(resource, extra = {}) {
  return handler({ httpMethod: "GET", resource, headers: { Authorization: "Bearer test-token" }, queryStringParameters: {}, ...extra });
}

const NEW_RUN = { identity: "anon:anon-id-1", run_id: "run-new", project: "sample-project", timestamp: "2026-09-01T00:00:00Z", total_tokens: 2_500_000, s3_key: "anon/anon-id-1/run-new/x.tar.gz" };
const OLD_RUN = { identity: "anon:anon-id-1", run_id: "run-old", project: "sample-project", timestamp: "2026-08-01T00:00:00Z", total_cost_usd: 3.5, s3_key: "anon/anon-id-1/run-old/x.tar.gz" };

describe("GET /runs", () => {
  it("returns each run's total_tokens", async () => {
    signedIn([NEW_RUN]);

    const res = await read("/runs");

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).runs[0].total_tokens).toBe(2_500_000);
  });

  it("returns null tokens for a run uploaded before tokens were recorded, keeping its dollar figure", async () => {
    signedIn([OLD_RUN]);

    const run = JSON.parse((await read("/runs")).body).runs[0];

    expect(run).toHaveProperty("total_tokens", null);
    expect(run.total_cost_usd).toBe(3.5);
  });
});

describe("GET /runs/{runId}", () => {
  it("returns the run's total_tokens in its metadata", async () => {
    signedIn([NEW_RUN]);

    const res = await read("/runs/{runId}", { pathParameters: { runId: "run-new" } });

    expect(JSON.parse(res.body).meta.total_tokens).toBe(2_500_000);
  });
});

describe("GET /admin/stats", () => {
  it("totals tokens across runs", async () => {
    setDdbReply(() => ({ Items: [NEW_RUN, OLD_RUN, { ...NEW_RUN, run_id: "run-3", total_tokens: 500_000 }] }));

    const res = await handler({ httpMethod: "GET", resource: "/admin/stats", headers: {} });

    expect(JSON.parse(res.body).total_tokens).toBe(3_000_000);
  });
});

// ---------------------------------------------------------------------------
// Read access: repository collaborators, then the allowlist
// ---------------------------------------------------------------------------

describe("read access", () => {
  const originalServiceToken = process.env.GITHUB_SERVICE_TOKEN;

  afterEach(() => {
    if (originalServiceToken === undefined) delete process.env.GITHUB_SERVICE_TOKEN;
    else process.env.GITHUB_SERVICE_TOKEN = originalServiceToken;
  });

  /** GitHub (faked) says the token is `reader`'s and answers the collaborator check with `status`. */
  function github(collaboratorStatus) {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url) === "https://api.github.com/user") {
        return { ok: true, status: 200, json: async () => ({ login: "reader" }) };
      }
      return { ok: collaboratorStatus < 300, status: collaboratorStatus };
    };
    return urls;
  }

  it("lets in a collaborator on mnmal-ai/swarm without reading the allowlist", async () => {
    process.env.GITHUB_SERVICE_TOKEN = "service-token";
    const urls = github(204);
    setDdbReply(() => ({ Items: [] }));

    const res = await read("/runs");

    expect(res.statusCode).toBe(200);
    expect(urls).toContain("https://api.github.com/repos/mnmal-ai/swarm/collaborators/reader");
    expect(sent.some((c) => c.name === "ddb:Get")).toBe(false);
  });

  it("refuses a reader who is neither a collaborator nor allow-listed, naming the repository", async () => {
    process.env.GITHUB_SERVICE_TOKEN = "service-token";
    github(404);
    setDdbReply(() => ({}));

    const res = await read("/runs");

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("mnmal-ai/swarm");
  });
});
