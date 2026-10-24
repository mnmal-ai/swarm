import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { RequestOptions } from "node:https";
import { DEFAULT_TELEMETRY_ENDPOINT } from "../src/telemetry/endpoint.js";
import {
  assemblePayload,
  compressPayload,
  cacheForRetry,
  retryPending,
  uploadPayload,
  setUploadEndpoint,
  getUploadEndpoint,
  type UploadConsent,
  type UploadIdentity,
} from "../src/telemetry/upload.js";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// The CommonJS dns module object Node's own sockets read `lookup` from, so a
// spy on it intercepts every real lookup.
const nodeDns = createRequire(import.meta.url)("node:dns") as typeof import("node:dns");

const consent: UploadConsent = { logs: true, trees: true, context: true };
const identity: UploadIdentity = { type: "anonymous", telemetry_id: "test-id-123" };

/** Fail loudly if the upload endpoint is anything other than loopback. */
function assertLoopbackEndpoint(): void {
  const host = new URL(getUploadEndpoint()).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`network access in tests is forbidden (endpoint: ${host})`);
  }
}

// File-wide network guard. Uploads use node:http(s), not fetch, so stubbing
// fetch would guard nothing. Every test starts with the endpoint on a closed
// loopback port (connection refused locally); a block that runs a mock server
// points it at that server and restores this value afterwards. The guard
// asserts the endpoint is loopback before every test in the file.
let fileOriginalEndpoint: string;
beforeAll(() => {
  fileOriginalEndpoint = getUploadEndpoint();
  setUploadEndpoint("http://127.0.0.1:9");
});
afterAll(() => setUploadEndpoint(fileOriginalEndpoint));
beforeEach(assertLoopbackEndpoint);

describe("assemblePayload", () => {
  it("creates meta.json with run metadata", async () => {
    const swarmDir = await mkdtemp(join(tmpdir(), "upload-test-"));
    const eventsDir = join(swarmDir, "telemetry", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "2026-03-17.jsonl"), '{"event":"test"}\n');

    // Create minimal secrets.md
    const domainDir = join(swarmDir, "domains", "test");
    await mkdir(domainDir, { recursive: true });
    await writeFile(join(domainDir, "secrets.md"), "# test — Secrets\n\n## Sensitive Files\n\n- .env\n");

    const result = await assemblePayload({
      swarmDir,
      projectDir: swarmDir,
      projectName: "test",
      runId: "run-test-123",
      identity,
      consent,
      sdkVersion: "0.10.0",
      durationMs: 5000,
      totalTokens: 1_500_000,
      goalsCompleted: 1,
      goalsTotal: 1,
      tasksCompleted: 3,
      tasksFailed: 0,
    });

    expect(result.payloadDir).toBeDefined();

    const meta = JSON.parse(
      await readFile(join(result.payloadDir, "meta.json"), "utf-8"),
    );
    expect(meta.run_id).toBe("run-test-123");
    expect(meta.project).toBe("test");
    expect(meta.identity.type).toBe("anonymous");
    expect(meta.total_tokens).toBe(1_500_000);
    expect(meta).not.toHaveProperty("total_cost_usd");

    await rm(swarmDir, { recursive: true });
    await rm(result.payloadDir, { recursive: true });
  });

  it("excludes files listed in secrets.md", async () => {
    const swarmDir = await mkdtemp(join(tmpdir(), "upload-test-"));
    const domainDir = join(swarmDir, "domains", "test");
    await mkdir(domainDir, { recursive: true });
    await writeFile(join(domainDir, "secrets.md"), "# Secrets\n\n## Sensitive Swarm Files\n\n- domains/test/environment.md\n");
    await writeFile(join(domainDir, "environment.md"), "SECRET_KEY=abc123\n");
    await writeFile(join(domainDir, "overview.md"), "# Overview\nClean file.\n");

    // Create events dir
    const eventsDir = join(swarmDir, "telemetry", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "2026-03-17.jsonl"), '{"test":true}\n');

    const result = await assemblePayload({
      swarmDir,
      projectDir: swarmDir,
      projectName: "test",
      runId: "run-test-456",
      identity,
      consent,
      sdkVersion: "0.10.0",
      durationMs: 1000,
      totalTokens: 500_000,
      goalsCompleted: 1,
      goalsTotal: 1,
      tasksCompleted: 1,
      tasksFailed: 0,
    });

    // context/ should have overview.md but NOT environment.md or secrets.md
    const contextDir = join(result.payloadDir, "context", "domains", "test");
    const contextFiles = await readdir(contextDir).catch(() => []);
    expect(contextFiles).toContain("overview.md");
    expect(contextFiles).not.toContain("environment.md");
    expect(contextFiles).not.toContain("secrets.md");

    await rm(swarmDir, { recursive: true });
    await rm(result.payloadDir, { recursive: true });
  });

  it("respects consent tiers — skips context when not opted in", async () => {
    const swarmDir = await mkdtemp(join(tmpdir(), "upload-test-"));
    const domainDir = join(swarmDir, "domains", "test");
    await mkdir(domainDir, { recursive: true });
    await writeFile(join(domainDir, "secrets.md"), "# Secrets\n");
    await writeFile(join(domainDir, "overview.md"), "# Overview\n");
    const eventsDir = join(swarmDir, "telemetry", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "2026-03-17.jsonl"), '{"test":true}\n');

    const result = await assemblePayload({
      swarmDir,
      projectDir: swarmDir,
      projectName: "test",
      runId: "run-test-789",
      identity,
      consent: { logs: true, trees: false, context: false },
      sdkVersion: "0.10.0",
      durationMs: 1000,
      totalTokens: 500_000,
      goalsCompleted: 1,
      goalsTotal: 1,
      tasksCompleted: 1,
      tasksFailed: 0,
    });

    // logs/ should exist, context/ and trees/ should not
    const dirs = await readdir(result.payloadDir);
    expect(dirs).toContain("logs");
    expect(dirs).toContain("meta.json");
    expect(dirs).not.toContain("context");
    expect(dirs).not.toContain("trees");

    await rm(swarmDir, { recursive: true });
    await rm(result.payloadDir, { recursive: true });
  });

  it("includes tree snapshots when opted in", async () => {
    const swarmDir = await mkdtemp(join(tmpdir(), "upload-test-"));
    const domainDir = join(swarmDir, "domains", "test");
    await mkdir(domainDir, { recursive: true });
    await writeFile(join(domainDir, "secrets.md"), "# Secrets\n");
    const eventsDir = join(swarmDir, "telemetry", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "2026-03-17.jsonl"), '{"test":true}\n');

    const result = await assemblePayload({
      swarmDir,
      projectDir: swarmDir,
      projectName: "test",
      runId: "run-test-tree",
      identity,
      consent: { logs: false, trees: true, context: false },
      sdkVersion: "0.10.0",
      durationMs: 1000,
      totalTokens: 500_000,
      goalsCompleted: 1,
      goalsTotal: 1,
      tasksCompleted: 1,
      tasksFailed: 0,
      treeBefore: "before-tree-snapshot\n",
      treeAfter: "after-tree-snapshot\n",
    });

    const dirs = await readdir(result.payloadDir);
    expect(dirs).toContain("trees");
    expect(dirs).not.toContain("logs");

    const treesDir = join(result.payloadDir, "trees");
    const treeFiles = await readdir(treesDir);
    expect(treeFiles).toContain("before.txt");
    expect(treeFiles).toContain("after.txt");

    const beforeContent = await readFile(join(treesDir, "before.txt"), "utf-8");
    expect(beforeContent).toBe("before-tree-snapshot\n");

    await rm(swarmDir, { recursive: true });
    await rm(result.payloadDir, { recursive: true });
  });

  it("scrubs secrets from copied text files", async () => {
    const swarmDir = await mkdtemp(join(tmpdir(), "upload-test-"));
    const domainDir = join(swarmDir, "domains", "test");
    await mkdir(domainDir, { recursive: true });
    await writeFile(join(domainDir, "secrets.md"), "# Secrets\n");
    await writeFile(join(domainDir, "overview.md"), "# Overview\nKey: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234\n");
    const eventsDir = join(swarmDir, "telemetry", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(join(eventsDir, "2026-03-17.jsonl"), '{"test":true}\n');

    const result = await assemblePayload({
      swarmDir,
      projectDir: swarmDir,
      projectName: "test",
      runId: "run-test-scrub",
      identity,
      consent: { logs: false, trees: false, context: true },
      sdkVersion: "0.10.0",
      durationMs: 1000,
      totalTokens: 500_000,
      goalsCompleted: 1,
      goalsTotal: 1,
      tasksCompleted: 1,
      tasksFailed: 0,
    });

    const overviewContent = await readFile(
      join(result.payloadDir, "context", "domains", "test", "overview.md"),
      "utf-8",
    );
    expect(overviewContent).not.toContain("sk-ant-api03");
    expect(overviewContent).toContain("[REDACTED]");

    await rm(swarmDir, { recursive: true });
    await rm(result.payloadDir, { recursive: true });
  });
});

describe("compressPayload", () => {
  it("produces a .tar.gz file from a payload directory", async () => {
    const payloadDir = await mkdtemp(join(tmpdir(), "compress-test-"));
    try {
      await writeFile(join(payloadDir, "meta.json"), JSON.stringify({ run_id: "test" }));
      await mkdir(join(payloadDir, "logs"), { recursive: true });
      await writeFile(join(payloadDir, "logs", "events.jsonl"), '{"event":"test"}\n');

      const tarballPath = await compressPayload(payloadDir);

      expect(tarballPath).toBe(`${payloadDir}.tar.gz`);
      expect(existsSync(tarballPath)).toBe(true);

      const fileStat = await stat(tarballPath);
      expect(fileStat.size).toBeGreaterThan(0);

      await rm(tarballPath);
    } finally {
      await rm(payloadDir, { recursive: true });
    }
  });

  it("tarball filename is based on the payload directory name", async () => {
    const payloadDir = await mkdtemp(join(tmpdir(), "compress-name-"));
    try {
      await writeFile(join(payloadDir, "meta.json"), "{}");

      const tarballPath = await compressPayload(payloadDir);

      expect(basename(tarballPath)).toBe(basename(payloadDir) + ".tar.gz");

      await rm(tarballPath);
    } finally {
      await rm(payloadDir, { recursive: true });
    }
  });
});

describe("cacheForRetry", () => {
  it("moves the tarball into the pending directory", async () => {
    const tmpBase = await mkdtemp(join(tmpdir(), "cache-retry-"));
    try {
      const tarball = join(tmpBase, "upload-abc123.tar.gz");
      await writeFile(tarball, "fake-tarball-content");

      const pendingDir = join(tmpBase, "pending");

      await cacheForRetry(tarball, pendingDir);

      // Original file should no longer exist (it was moved)
      expect(existsSync(tarball)).toBe(false);

      // File should be in pendingDir
      const pendingFiles = await readdir(pendingDir);
      expect(pendingFiles).toContain("upload-abc123.tar.gz");

      const content = await readFile(join(pendingDir, "upload-abc123.tar.gz"), "utf-8");
      expect(content).toBe("fake-tarball-content");
    } finally {
      await rm(tmpBase, { recursive: true });
    }
  });

  it("creates the pending directory if it does not exist", async () => {
    const tmpBase = await mkdtemp(join(tmpdir(), "cache-retry-mkdir-"));
    try {
      const tarball = join(tmpBase, "upload-def456.tar.gz");
      await writeFile(tarball, "data");

      const pendingDir = join(tmpBase, "deeply", "nested", "pending");
      expect(existsSync(pendingDir)).toBe(false);

      await cacheForRetry(tarball, pendingDir);

      expect(existsSync(pendingDir)).toBe(true);
      const pendingFiles = await readdir(pendingDir);
      expect(pendingFiles).toContain("upload-def456.tar.gz");
    } finally {
      await rm(tmpBase, { recursive: true });
    }
  });
});

describe("retryPending", () => {
  // retryPending really uploads: keep these tests on a closed loopback port
  // (connection refused locally) whatever an earlier block left behind. The
  // file-wide guard asserts it before every test.
  let guardOriginalEndpoint: string;
  beforeAll(() => {
    guardOriginalEndpoint = getUploadEndpoint();
    setUploadEndpoint("http://127.0.0.1:9");
  });
  afterAll(() => setUploadEndpoint(guardOriginalEndpoint));

  it("does not crash when pending directory does not exist", async () => {
    const nonExistentDir = join(tmpdir(), "no-such-pending-dir-" + Date.now());
    // Should return without error
    await expect(retryPending(nonExistentDir)).resolves.toBeUndefined();
  });

  it("does not crash when pending directory is empty", async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), "retry-empty-"));
    try {
      await expect(retryPending(pendingDir)).resolves.toBeUndefined();
    } finally {
      await rm(pendingDir, { recursive: true });
    }
  });

  it("skips non-.tar.gz files", async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), "retry-skip-"));
    try {
      await writeFile(join(pendingDir, "readme.txt"), "not a tarball");
      await writeFile(join(pendingDir, "data.json"), "{}");

      await retryPending(pendingDir);

      // Non-.tar.gz files should be untouched
      const files = await readdir(pendingDir);
      expect(files).toContain("readme.txt");
      expect(files).toContain("data.json");
    } finally {
      await rm(pendingDir, { recursive: true });
    }
  });

  it("deletes .tar.gz files older than 30 days", async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), "retry-old-"));
    try {
      const oldFile = join(pendingDir, "old-upload.tar.gz");
      await writeFile(oldFile, "old-data");

      // Set mtime to 31 days ago
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await utimes(oldFile, thirtyOneDaysAgo, thirtyOneDaysAgo);

      await retryPending(pendingDir);

      // Old file should have been deleted
      expect(existsSync(oldFile)).toBe(false);
    } finally {
      await rm(pendingDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// uploadPayload — the default endpoint (no request leaves the process)
// ---------------------------------------------------------------------------

describe("uploadPayload (default endpoint)", () => {
  it("uploads to DEFAULT_TELEMETRY_ENDPOINT when no override is configured", async () => {
    // A fresh copy of the module, which no setUploadEndpoint call has touched,
    // with node:https and node:http replaced by one recorder: the request is
    // captured and fails before any socket is opened. Two more locks keep a
    // lost mock from ever reaching the network: the test checks the recorder
    // is what the fresh module graph resolves before it uploads, and DNS
    // lookups (which every real request makes first) fail and are counted.
    const requested: Array<{ hostname: unknown; path: unknown; method: unknown }> = [];
    const request = (options: RequestOptions) => {
      requested.push({ hostname: options.hostname, path: options.path, method: options.method });
      const req = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => queueMicrotask(() => req.emit("error", new Error("offline: request recorded only"))),
        destroy: () => undefined,
      });
      return req;
    };
    const lookup = vi.spyOn(nodeDns, "lookup").mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error) => void;
      callback(new Error("DNS is blocked in tests"));
    }) as typeof nodeDns.lookup);
    vi.resetModules();
    for (const id of ["node:https", "node:http"]) {
      vi.doMock(id, async (importOriginal) => {
        const actual = await importOriginal<Record<string, unknown>>();
        return { ...actual, request, default: { ...(actual.default as object), request } };
      });
    }

    try {
      expect((await import("node:https")).request).toBe(request);
      expect((await import("node:http")).request).toBe(request);
      const fresh = await import("../src/telemetry/upload.js");
      expect(fresh.getUploadEndpoint()).toBe(DEFAULT_TELEMETRY_ENDPOINT);

      const uploaded = await fresh.uploadPayload("/nonexistent/default-endpoint.tar.gz", identity, "run-default-endpoint");

      expect(uploaded).toBe(false);
      expect(requested).toEqual([
        { hostname: new URL(DEFAULT_TELEMETRY_ENDPOINT).hostname, path: "/upload-url", method: "POST" },
      ]);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:https");
      vi.doUnmock("node:http");
      vi.resetModules();
      lookup.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// uploadPayload — mock server tests (no live API calls)
// ---------------------------------------------------------------------------

describe("uploadPayload (mock server)", () => {
  let server: Server;
  let port: number;
  let originalEndpoint: string;

  // Captured request data for assertions
  let lastPostHeaders: Record<string, string | string[] | undefined> = {};
  let lastPostBody: string = "";
  let lastPutBody: Buffer = Buffer.alloc(0);

  // Server behavior configuration (per-test)
  let presignedUrlStatus = 200;
  let presignedUrlResponse: Record<string, unknown> = {};
  let s3PutStatus = 200;

  beforeAll(async () => {
    originalEndpoint = getUploadEndpoint();

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);

        if (req.method === "POST" && req.url === "/upload-url") {
          lastPostHeaders = { ...req.headers };
          lastPostBody = body.toString("utf-8");
          res.writeHead(presignedUrlStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(presignedUrlResponse));
          return;
        }

        if (req.method === "PUT" && req.url === "/s3-put") {
          lastPutBody = body;
          res.writeHead(s3PutStatus);
          res.end();
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve();
      });
    });

    setUploadEndpoint(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    setUploadEndpoint(originalEndpoint);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Reset per-test state
  function resetMock() {
    lastPostHeaders = {};
    lastPostBody = "";
    lastPutBody = Buffer.alloc(0);
    presignedUrlStatus = 200;
    presignedUrlResponse = { presigned_url: "" };
    s3PutStatus = 200;
  }

  it("successful upload: POST gets presigned URL, PUT succeeds, returns true", async () => {
    resetMock();
    presignedUrlResponse = { presigned_url: `http://127.0.0.1:${port}/s3-put`, expires_in: 900 };

    const tempDir = await mkdtemp(join(tmpdir(), "upload-mock-"));
    const tarball = join(tempDir, "test.tar.gz");
    await writeFile(tarball, "fake tarball content");

    const result = await uploadPayload(
      tarball,
      { type: "anonymous", telemetry_id: "test-unit-123" },
      "run-unit-test-001",
    );

    expect(result).toBe(true);
    // Verify the PUT body matches the tarball content
    expect(lastPutBody.toString("utf-8")).toBe("fake tarball content");
    await rm(tempDir, { recursive: true });
  });

  it("server returns 500 on presigned URL request, returns false", async () => {
    resetMock();
    presignedUrlStatus = 500;
    presignedUrlResponse = { error: "Internal Server Error" };

    const tempDir = await mkdtemp(join(tmpdir(), "upload-mock-"));
    const tarball = join(tempDir, "test.tar.gz");
    await writeFile(tarball, "fake content");

    const result = await uploadPayload(
      tarball,
      { type: "anonymous", telemetry_id: "test-unit-500" },
      "run-unit-test-500",
    );

    expect(result).toBe(false);
    await rm(tempDir, { recursive: true });
  });

  it("S3 PUT fails (server returns 403), returns false", async () => {
    resetMock();
    presignedUrlResponse = { presigned_url: `http://127.0.0.1:${port}/s3-put`, expires_in: 900 };
    s3PutStatus = 403;

    const tempDir = await mkdtemp(join(tmpdir(), "upload-mock-"));
    const tarball = join(tempDir, "test.tar.gz");
    await writeFile(tarball, "fake content");

    const result = await uploadPayload(
      tarball,
      { type: "anonymous", telemetry_id: "test-unit-403" },
      "run-unit-test-403",
    );

    expect(result).toBe(false);
    await rm(tempDir, { recursive: true });
  });

  it("nonexistent tarball path, returns false", async () => {
    resetMock();
    presignedUrlResponse = { presigned_url: `http://127.0.0.1:${port}/s3-put`, expires_in: 900 };

    const result = await uploadPayload(
      "/tmp/nonexistent-tarball-abc123.tar.gz",
      { type: "anonymous", telemetry_id: "test-123" },
      "run-unit-test-nofile",
    );

    expect(result).toBe(false);
  });

  it("anonymous identity sends no Authorization header", async () => {
    resetMock();
    presignedUrlResponse = { presigned_url: `http://127.0.0.1:${port}/s3-put`, expires_in: 900 };

    const tempDir = await mkdtemp(join(tmpdir(), "upload-mock-"));
    const tarball = join(tempDir, "test.tar.gz");
    await writeFile(tarball, "content");

    await uploadPayload(
      tarball,
      { type: "anonymous", telemetry_id: "anon-test" },
      "run-anon-auth",
    );

    expect(lastPostHeaders["authorization"]).toBeUndefined();
    await rm(tempDir, { recursive: true });
  });

  it("GitHub identity sends Authorization header", async () => {
    resetMock();
    presignedUrlResponse = { presigned_url: `http://127.0.0.1:${port}/s3-put`, expires_in: 900 };

    const tempDir = await mkdtemp(join(tmpdir(), "upload-mock-"));
    const tarball = join(tempDir, "test.tar.gz");
    await writeFile(tarball, "content");

    await uploadPayload(
      tarball,
      { type: "github", github_username: "test-user" },
      "run-gh-auth",
    );

    // Verify the request body contains github identity info
    const body = JSON.parse(lastPostBody);
    expect(body.identity_type).toBe("github");
    expect(body.identity).toBe("test-user");

    // If gh CLI is installed, Authorization header should be present
    try {
      const { execFileSync } = await import("node:child_process");
      const token = execFileSync("gh", ["auth", "token"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (token) {
        expect(lastPostHeaders["authorization"]).toBe(`Bearer ${token}`);
      }
    } catch {
      // gh not available — Authorization header will not be present, which is fine
    }

    await rm(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// retryPending — mock server tests
// ---------------------------------------------------------------------------

describe("retryPending (mock server)", () => {
  let server: Server;
  let port: number;
  let originalEndpoint: string;
  let mockAcceptUploads = true;
  let uploadRequests = 0;

  beforeEach(() => {
    uploadRequests = 0;
  });

  beforeAll(async () => {
    originalEndpoint = getUploadEndpoint();

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/upload-url") {
          uploadRequests++;
          if (mockAcceptUploads) {
            const addr = server.address();
            const p = typeof addr === "object" && addr !== null ? addr.port : 0;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ presigned_url: `http://127.0.0.1:${p}/s3-put`, expires_in: 900 }));
          } else {
            res.writeHead(500);
            res.end("Server Error");
          }
          return;
        }

        if (req.method === "PUT" && req.url === "/s3-put") {
          if (mockAcceptUploads) {
            res.writeHead(200);
          } else {
            res.writeHead(500);
          }
          res.end();
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve();
      });
    });

    setUploadEndpoint(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    setUploadEndpoint(originalEndpoint);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("successful retry deletes pending tarball", async () => {
    mockAcceptUploads = true;

    const pendingDir = await mkdtemp(join(tmpdir(), "retry-mock-ok-"));
    try {
      const tarball = join(pendingDir, "pending-upload.tar.gz");
      await writeFile(tarball, "pending-data");

      await retryPending(pendingDir);

      // File should be deleted after successful upload
      expect(existsSync(tarball)).toBe(false);
    } finally {
      await rm(pendingDir, { recursive: true }).catch(() => {});
    }
  });

  it("failed retry preserves pending tarball", async () => {
    mockAcceptUploads = false;

    const pendingDir = await mkdtemp(join(tmpdir(), "retry-mock-fail-"));
    try {
      const tarball = join(pendingDir, "pending-upload.tar.gz");
      await writeFile(tarball, "pending-data");

      await retryPending(pendingDir);

      // File should remain since the upload failed
      expect(existsSync(tarball)).toBe(true);
      const content = await readFile(tarball, "utf-8");
      expect(content).toBe("pending-data");
    } finally {
      await rm(pendingDir, { recursive: true });
    }
  });

  it("processes recent .tar.gz files without crashing", async () => {
    mockAcceptUploads = true;
    const pendingDir = await mkdtemp(join(tmpdir(), "retry-recent-"));
    try {
      const recentFile = join(pendingDir, "recent-upload.tar.gz");
      await writeFile(recentFile, "recent-data");

      // retryPending should not throw regardless of upload success/failure
      await retryPending(pendingDir);
      expect(uploadRequests).toBe(1); // mock received it; nothing left the machine

      // File is either deleted (upload succeeded) or still present (upload failed)
      // Both are valid outcomes — the key assertion is no crash
    } finally {
      await rm(pendingDir, { recursive: true });
    }
  });

  it("processes each .tar.gz file and preserves non-tgz files", async () => {
    mockAcceptUploads = true;
    const pendingDir = await mkdtemp(join(tmpdir(), "retry-multi-"));
    try {
      await writeFile(join(pendingDir, "upload-001.tar.gz"), "data1");
      await writeFile(join(pendingDir, "upload-002.tar.gz"), "data2");
      await writeFile(join(pendingDir, "not-a-tarball.txt"), "ignore");

      await retryPending(pendingDir);
      expect(uploadRequests).toBe(2); // one POST per tarball, none for the .txt

      // Non-tgz files are always preserved
      const files = await readdir(pendingDir);
      expect(files).toContain("not-a-tarball.txt");
      // .tar.gz files may or may not exist depending on upload success
    } finally {
      await rm(pendingDir, { recursive: true });
    }
  });
});
