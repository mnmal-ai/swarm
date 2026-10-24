import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Script-level test for scripts/harvest-recall-fixtures.ts against a fake
// Substrate sidecar that pages as Substrate does: a list read returns at most
// 1000 rows, refuses a larger `limit` (limit_exceeds_max, under HTTP 200), and
// reports the rest through `_pagination[key].nextCursor`. The harvester used
// to ask for `limit: 100000` (the previous engine's unpaged read) and so failed on its first
// query against any real Substrate store.
// ---------------------------------------------------------------------------

const REPO = resolve(__dirname, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "harvest-recall-fixtures.ts");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const MAX_PAGE = 1000;

type Row = Record<string, unknown>;

const TABLES: Record<string, Row[]> = {
  "swarm/SessionEvent": [
    { eventId: "evt-1", sessionId: "sess-a", role: "worker", intent: "documentation", swarmFilesLoaded: '["core/style.md","core/docs.md"]', timestamp: "2026-01-01T00:00:01Z" },
    { eventId: "evt-2", sessionId: "sess-a", role: "reviewer", intent: "", swarmFilesLoaded: "[]", timestamp: "2026-01-01T00:00:02Z" },
    { eventId: "evt-3", sessionId: "sess-b", role: "worker", intent: "implementation", swarmFilesLoaded: '["core/style.md","core/testing.md"]', timestamp: "2026-01-01T00:00:03Z" },
  ],
  "swarm/TranscriptEntry": [
    { sessionId: "sess-a", role: "worker", prompt: "## Task\nWrite the README section", timestamp: "2026-01-01T00:00:01Z" },
    { sessionId: "sess-b", role: "worker", prompt: "## Task\nAdd a test for greet", timestamp: "2026-01-01T00:00:03Z" },
  ],
  "swarm/SwarmContent": [{ path: "core/style.md" }, { path: "core/docs.md" }, { path: "core/testing.md" }],
};

/** One frame of a query, paged one row at a time when no limit is named, so the harvester must follow cursors. */
function answer(key: string, params: { limit?: number; cursor?: string }) {
  if (typeof params.limit === "number" && params.limit > MAX_PAGE) {
    return { error: { path: [key], code: "limit_exceeds_max", message: `limit ${params.limit} exceeds the maximum page of ${MAX_PAGE}; page with the returned cursor` } };
  }
  const rows = TABLES[key] ?? [];
  const size = params.limit ?? 1;
  const offset = Number(params.cursor ?? 0);
  const next = offset + size;
  return { rows: rows.slice(offset, next), page: { hasMore: next < rows.length, ...(next < rows.length ? { nextCursor: String(next) } : {}) } };
}

/**
 * Answers only what a Substrate sidecar would for the harvester: GET /health
 * (the client's health check) and POST /substrate/v1/query. Any other method
 * or path is a 404, so a harvester that queried the wrong route would fail
 * here as it would against a real sidecar. Every request is recorded.
 */
function fakeSidecar(): Promise<{ server: Server; endpoint: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (req.method !== "POST" || req.url !== "/substrate/v1/query") {
      req.resume();
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const frames = JSON.parse(body) as Record<string, { params?: { limit?: number; cursor?: string } }>;
      const data: Record<string, unknown> = {};
      const pagination: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const [key, frame] of Object.entries(frames)) {
        const out = answer(key, frame.params ?? {});
        if ("error" in out) errors.push(out.error);
        else {
          data[key] = out.rows;
          pagination[key] = out.page;
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ schemaVersion: "x", data, _pagination: pagination, ...(errors.length ? { errors } : {}) }));
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done({ server, seen, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("scripts/harvest-recall-fixtures.ts against a paging Substrate", () => {
  it("reads every page and writes one fixture per worker session", async () => {
    const { server, endpoint, seen } = await fakeSidecar();
    cleanups.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "swarm-harvest-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "recall-fixtures.json");

    await promisify(execFile)(TSX, [SCRIPT, "--endpoint", endpoint, "--sources", "substrate", "--out", out], {
      cwd: REPO,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined } as NodeJS.ProcessEnv,
    });

    const written = JSON.parse(readFileSync(out, "utf-8")) as {
      meta: { fixtureCount: number; testCount: number; testPercent: number; targetTestPercent: number };
      fixtures: Array<{ prompt: string; expectedIntent: string; expectedContentPaths: string[]; pathsResolved: number }>;
    };
    expect(written.meta.fixtureCount).toBe(2);
    expect(written.meta.testCount).toBeGreaterThan(0);
    // testPercent is the split the file actually holds; the requested floor is kept beside it.
    expect(written.meta.testPercent).toBe(Math.round((written.meta.testCount / written.meta.fixtureCount) * 100));
    expect(written.meta.testPercent).toBe(50);
    expect(written.meta.targetTestPercent).toBe(20);
    expect(written.fixtures.map((f) => [f.expectedIntent, f.expectedContentPaths, f.pathsResolved])).toEqual([
      ["documentation", ["core/style.md", "core/docs.md"], 2],
      ["implementation", ["core/style.md", "core/testing.md"], 2],
    ]);
    // Only the health check and query frames: nothing that would 404 on a sidecar.
    expect(new Set(seen)).toEqual(new Set(["GET /health", "POST /substrate/v1/query"]));
  }, 60_000);
});
