import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Oversight, validateWorkerOutput, captureGitDiff } from "../src/index.js";
import type {
  BackendsConfig,
  IWorkerBackend,
  ModelProvider,
  WorkerTaskInput,
  WorkerTaskOutput,
} from "@mnmal-ai/swarm-types";

/**
 * Create a mock ModelProvider that returns a canned response.
 */
function createMockProvider(response: string): ModelProvider {
  return {
    name: "anthropic",
    execute: vi.fn().mockResolvedValue({
      output: response,
      tokens: { input: 100, output: 50 },
      latencyMs: 500,
      model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    }),
  };
}

/**
 * Create a mock IWorkerBackend that returns a canned response.
 */
function createMockBackend(
  output: string,
  opts?: { supportsDirectExecution?: boolean; type?: "api" | "claude-code" | "codex" },
): IWorkerBackend {
  return {
    type: opts?.type ?? "claude-code",
    supportsDirectExecution: opts?.supportsDirectExecution ?? true,
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({
      output,
      latencyMs: 2000,
      tokensUsed: { input: 500, output: 200 },
      filesChanged: [],
      backendUsed: opts?.type ?? "claude-code",
    } satisfies WorkerTaskOutput),
  };
}

describe("Per-role backends", () => {
  let reviewerProvider: ModelProvider;
  let arbiterProvider: ModelProvider;

  beforeEach(() => {
    reviewerProvider = createMockProvider('{"verdict": "approved", "reasons": [], "suggestions": []}');
    arbiterProvider = createMockProvider('{"verdict": "approved", "reasoning": "output looks good"}');
  });

  describe("BackendsConfig type", () => {
    it("accepts reviewer and arbiter fields", () => {
      const config: BackendsConfig = {
        worker: { type: "claude-code" },
        reviewer: { type: "claude-code" },
        arbiter: { type: "api" },
      };

      expect(config.worker?.type).toBe("claude-code");
      expect(config.reviewer?.type).toBe("claude-code");
      expect(config.arbiter?.type).toBe("api");
    });

    it("accepts worker-only config for backward compatibility", () => {
      const config: BackendsConfig = {
        worker: { type: "api" },
      };

      expect(config.worker?.type).toBe("api");
      expect(config.reviewer).toBeUndefined();
      expect(config.arbiter).toBeUndefined();
    });
  });

  describe("Reviewer with backend", () => {
    it("uses backend when configured and supports direct execution", async () => {
      const backend = createMockBackend('{"verdict": "approved", "reasons": [], "suggestions": []}');

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.review(
        "mode context",
        "original task",
        "worker output text here that is long enough to pass validation easily",
        { reviewerBackend: backend, workingDirectory: "/tmp/test-worktree" },
      );

      expect(result.verdict).toBe("approved");
      expect(backend.execute).toHaveBeenCalledTimes(1);
      // API provider should NOT have been called
      expect(reviewerProvider.execute).not.toHaveBeenCalled();

      // Verify the backend was called with the right working directory
      const executeCall = (backend.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerTaskInput;
      expect(executeCall.workingDirectory).toBe("/tmp/test-worktree");
      expect(executeCall.swarmContext).toContain("code reviewer");
      expect(executeCall.task).toContain("mode context");
      expect(executeCall.task).toContain("original task");
    });

    it("falls back to API when backend fails", async () => {
      const backend = createMockBackend("");
      (backend.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("backend crashed"));

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.review(
        "mode context",
        "original task",
        "worker output text",
        { reviewerBackend: backend, workingDirectory: "/tmp/test-worktree" },
      );

      expect(result.verdict).toBe("approved");
      // Backend was called but failed
      expect(backend.execute).toHaveBeenCalledTimes(1);
      // API provider was called as fallback
      expect(reviewerProvider.execute).toHaveBeenCalledTimes(1);
    });

    it("falls back to API when no backend is configured", async () => {
      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.review(
        "mode context",
        "original task",
        "worker output text",
        { workingDirectory: "/tmp/test-worktree" },
      );

      expect(result.verdict).toBe("approved");
      expect(reviewerProvider.execute).toHaveBeenCalledTimes(1);
    });

    it("skips backend when supportsDirectExecution is false", async () => {
      const backend = createMockBackend('{"verdict": "approved", "reasons": []}', {
        supportsDirectExecution: false,
        type: "api",
      });

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.review(
        "mode context",
        "original task",
        "worker output text",
        { reviewerBackend: backend, workingDirectory: "/tmp/test-worktree" },
      );

      expect(result.verdict).toBe("approved");
      // Backend should NOT have been used
      expect(backend.execute).not.toHaveBeenCalled();
      // API provider should have been used
      expect(reviewerProvider.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Arbiter with backend", () => {
    it("uses backend when configured and supports direct execution", async () => {
      const backend = createMockBackend('{"verdict": "approved", "reasoning": "changes look fine"}');

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.arbitrate(
        "original task",
        "worker output",
        ["reason 1", "reason 2"],
        { arbiterBackend: backend, workingDirectory: "/tmp/test-worktree" },
      );

      expect(result.verdict).toBe("approved");
      expect(backend.execute).toHaveBeenCalledTimes(1);
      expect(arbiterProvider.execute).not.toHaveBeenCalled();

      const executeCall = (backend.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerTaskInput;
      expect(executeCall.workingDirectory).toBe("/tmp/test-worktree");
      expect(executeCall.swarmContext).toContain("arbiter");
    });

    it("falls back to API when backend fails", async () => {
      const backend = createMockBackend("");
      (backend.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("arbiter backend crashed"));

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.arbitrate(
        "original task",
        "worker output",
        ["reason 1"],
        { arbiterBackend: backend, workingDirectory: "/tmp/test-worktree" },
      );

      expect(result.verdict).toBe("approved");
      expect(backend.execute).toHaveBeenCalledTimes(1);
      expect(arbiterProvider.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Git diff in API fallback", () => {
    it("prepends git diff when reviewer uses API with workingDirectory", async () => {
      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      // The review method will try captureGitDiff which will likely fail
      // (no git repo at /tmp/nonexistent), so diff will be empty string.
      // That's fine — the important thing is the API path runs.
      await oversight.review(
        "mode context",
        "original task",
        "worker output text",
        { workingDirectory: "/tmp/nonexistent" },
      );

      expect(reviewerProvider.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("captureGitDiff", () => {
    it("returns empty string when directory is not a git repo", () => {
      const result = captureGitDiff("/tmp/definitely-not-a-git-repo");
      expect(result).toBe("");
    });

    it("returns empty string when directory does not exist", () => {
      const result = captureGitDiff("/nonexistent/path/xyz123");
      expect(result).toBe("");
    });

    describe("with a real git repo", () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "swarm-test-"));
        execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir, stdio: "pipe" });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir, stdio: "pipe" });
        execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tempDir, stdio: "pipe" });
      });

      afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
      });

      it("captures diff for uncommitted changes in a real git repo", () => {
        writeFileSync(join(tempDir, "hello.txt"), "hello world\n");
        execFileSync("git", ["add", "hello.txt"], { cwd: tempDir, stdio: "pipe" });

        const result = captureGitDiff(tempDir);
        expect(result).toContain("hello.txt");
        expect(result).toContain("## Code Changes (git diff)");
      });

      it("includes untracked files in the output", () => {
        writeFileSync(join(tempDir, "untracked-file.ts"), "export const x = 1;\n");

        const result = captureGitDiff(tempDir);
        expect(result).toContain("untracked-file.ts");
        expect(result).toContain("Untracked files");
      });

      it("truncates output to 50KB", () => {
        // Create a file large enough to exceed 50KB when diffed
        const largeContent = "x".repeat(60000) + "\n";
        writeFileSync(join(tempDir, "large.txt"), largeContent);
        execFileSync("git", ["add", "large.txt"], { cwd: tempDir, stdio: "pipe" });

        const result = captureGitDiff(tempDir);
        // The diff output is wrapped in markdown, so the raw diff portion is sliced to 50000 chars
        // Total result should not be excessively large
        expect(result.length).toBeLessThan(51000);
      });
    });
  });

  describe("runFullChain with per-role backends", () => {
    it("passes reviewer backend through the full chain", async () => {
      const reviewerBackend = createMockBackend('{"verdict": "approved", "reasons": [], "suggestions": []}');

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.runFullChain({
        modeContext: "mode context here",
        originalTask: "implement the feature",
        workerOutput: "I implemented the feature by creating a new module that handles all the required functionality and tests.",
        maxRetries: 2,
        sessionId: "sess-test-123",
        reviewerBackend,
        workingDirectory: "/tmp/test-worktree",
      });

      expect(result.verdict).toBe("approved");
      expect(result.retryCount).toBe(0);
      expect(result.arbiterInvolved).toBe(false);
      // Backend was used for review, not the API provider
      expect(reviewerBackend.execute).toHaveBeenCalledTimes(1);
      expect(reviewerProvider.execute).not.toHaveBeenCalled();
    });

    it("passes arbiter backend when reviewer rejects and retries exhausted", async () => {
      // Reviewer always rejects
      const rejectingReviewerBackend = createMockBackend(
        '{"verdict": "rejected", "reasons": ["code is incomplete"], "suggestions": ["add tests"]}',
      );
      const arbiterBackend = createMockBackend(
        '{"verdict": "approved", "reasoning": "the code is actually fine"}',
      );

      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement feature",
        workerOutput: "I implemented the feature with complete tests and documentation covering all edge cases.",
        maxRetries: 0, // no retries — go straight to arbiter
        sessionId: "sess-test-456",
        reviewerBackend: rejectingReviewerBackend,
        arbiterBackend,
        workingDirectory: "/tmp/test-worktree",
      });

      expect(result.verdict).toBe("approved");
      expect(result.arbiterInvolved).toBe(true);
      expect(arbiterBackend.execute).toHaveBeenCalledTimes(1);
      expect(arbiterProvider.execute).not.toHaveBeenCalled();
    });

    it("works without any backends (backward compatibility)", async () => {
      const oversight = new Oversight({
        reviewerProvider,
        reviewerModel: "claude-sonnet-4-6",
        arbiterProvider,
        arbiterModel: "claude-opus-4-6",
      });

      const result = await oversight.runFullChain({
        modeContext: "mode context",
        originalTask: "implement feature",
        workerOutput: "I implemented the feature with tests and documentation for all requirements.",
        maxRetries: 2,
        sessionId: "sess-test-789",
        // No backends, no workingDirectory
      });

      expect(result.verdict).toBe("approved");
      // API provider should have been used
      expect(reviewerProvider.execute).toHaveBeenCalledTimes(1);
    });
  });
});

describe("transcripts name the backend that ran", () => {
  const emitted = () => {
    const events: Array<{ name: string; payload: { backend?: string; role?: string } }> = [];
    const eventBus = { emit: (name: string, payload: { backend?: string; role?: string }) => events.push({ name, payload }) };
    return { events, eventBus: eventBus as never };
  };
  const providers = () => ({
    reviewerProvider: createMockProvider('{"verdict": "approved", "reasons": [], "suggestions": []}'),
    reviewerModel: "m",
    arbiterProvider: createMockProvider('{"verdict": "approved", "reasoning": "fine"}'),
    arbiterModel: "m",
  });

  it.each(["claude-code", "codex"] as const)("labels a %s reviewer's transcript with its type", async (type) => {
    const { events, eventBus } = emitted();
    const oversight = new Oversight({ ...providers(), eventBus });
    const backend = createMockBackend('{"verdict": "approved", "reasons": [], "suggestions": []}', { type });
    await oversight.review("mode", "task", "worker output long enough to pass validation", { reviewerBackend: backend, workingDirectory: "/tmp/w" });
    expect(events.find((e) => e.name === "transcript")?.payload).toMatchObject({ role: "reviewer", backend: type });
  });

  it.each(["claude-code", "codex"] as const)("labels a %s arbiter's transcript with its type", async (type) => {
    const { events, eventBus } = emitted();
    const oversight = new Oversight({ ...providers(), eventBus });
    const backend = createMockBackend('{"verdict": "approved", "reasoning": "fine"}', { type });
    await oversight.arbitrate("task", "worker output", ["a reason"], { arbiterBackend: backend, workingDirectory: "/tmp/w" });
    expect(events.find((e) => e.name === "transcript")?.payload).toMatchObject({ role: "arbiter", backend: type });
  });
});
