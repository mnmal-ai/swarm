/**
 * Agent SDK timeout configurable
 * API keys in env
 *
 * Tests ClaudeCodeBackend constructor timeout behavior and env var allowlist.
 */

import { describe, it, expect } from "vitest";
import { ClaudeCodeBackend } from "../src/claude-code.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — configurable timeout", () => {
  it("defaults to 600000ms (600s) when no timeout is specified", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(600_000);
  });

  it("converts seconds to milliseconds (timeout: 900 → 900000ms)", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code", timeout: 900 });
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(900_000);
  });

  it("sets unlimited timeout (0ms) when timeout: 0 is specified", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code", timeout: 0 });
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(0);
  });

  it("converts timeout: 60 to 60000ms", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code", timeout: 60 });
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(60_000);
  });

  it("converts timeout: 30 to 30000ms", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code", timeout: 30 });
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(30_000);
  });

  it("uses default 600s when timeout is undefined (not provided)", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code", timeout: undefined });
    expect((backend as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// API keys in env allowlist
// ---------------------------------------------------------------------------

describe("ALLOWED_ENV_VARS includes API keys", () => {
  it("allows ANTHROPIC_API_KEY and OPENAI_API_KEY in env", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../src/claude-code.ts"),
      "utf-8",
    );
    expect(source).toContain('"ANTHROPIC_API_KEY"');
    expect(source).toContain('"OPENAI_API_KEY"');
  });

  it("ALLOWED_ENV_VARS set includes ANTHROPIC_API_KEY", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../src/claude-code.ts"),
      "utf-8",
    );
    // Verify it's in the Set definition, not just mentioned in a comment
    expect(source).toMatch(/ALLOWED_ENV_VARS\s*=\s*new Set\(\[[\s\S]*?"ANTHROPIC_API_KEY"[\s\S]*?\]\)/);
  });

  it("ALLOWED_ENV_VARS set includes OPENAI_API_KEY", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../src/claude-code.ts"),
      "utf-8",
    );
    expect(source).toMatch(/ALLOWED_ENV_VARS\s*=\s*new Set\(\[[\s\S]*?"OPENAI_API_KEY"[\s\S]*?\]\)/);
  });
});
