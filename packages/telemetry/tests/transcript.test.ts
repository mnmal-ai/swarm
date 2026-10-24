import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Telemetry } from "../src/telemetry/index.js";
import { mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptEntry } from "@mnmal-ai/swarm-types";

const TEMP_DIR = join(__dirname, "__fixtures__", "transcript-test");

function makeTranscript(overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    sessionId: "sess-test-123",
    role: "worker",
    timestamp: "2026-03-28T12:00:00.000Z",
    prompt: "## Task\nDo something\n\n## Swarm Context\nYou are helpful.",
    response: "I completed the task successfully.",
    tokens: { input: 100, output: 50 },
    backend: "claude-code",
    ...overrides,
  };
}

describe("Telemetry.emitTranscript", () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    // Transcripts are written to sibling dir (TEMP_DIR/../transcripts/)
    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  it("writes transcript to telemetry/transcripts/ directory with today's date", async () => {
    const telemetry = new Telemetry(TEMP_DIR, true);
    await telemetry.emitTranscript(makeTranscript());

    // Transcripts go to sibling of outputPath, i.e., TEMP_DIR/../transcripts/
    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    expect(existsSync(transcriptsDir)).toBe(true);

    const files = readdirSync(transcriptsDir);
    expect(files.length).toBe(1);

    const today = new Date().toISOString().slice(0, 10);
    expect(files[0]).toBe(`${today}.jsonl`);
  });

  it("writes valid JSONL with all fields", async () => {
    const telemetry = new Telemetry(TEMP_DIR, true);
    telemetry.setRunId("run-test-xyz");
    await telemetry.emitTranscript(makeTranscript());

    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    const files = readdirSync(transcriptsDir);
    const content = readFileSync(join(transcriptsDir, files[0]), "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.sessionId).toBe("sess-test-123");
    expect(entry.role).toBe("worker");
    expect(entry.prompt).toContain("Do something");
    expect(entry.response).toContain("completed the task");
    expect(entry.runId).toBe("run-test-xyz");
    expect(entry.backend).toBe("claude-code");
  });

  it("scrubs secrets from prompt and response", async () => {
    const telemetry = new Telemetry(TEMP_DIR, true);
    await telemetry.emitTranscript(makeTranscript({
      prompt: "Use key sk-ant-abcdefghijklmnopqrstuvwxyz to call the API",
      response: "I used sk-ant-abcdefghijklmnopqrstuvwxyz successfully",
    }));

    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    const files = readdirSync(transcriptsDir);
    const content = readFileSync(join(transcriptsDir, files[0]), "utf-8").trim();
    const entry = JSON.parse(content);

    // scrubContent should redact API key patterns
    expect(entry.prompt).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(entry.response).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
  });

  it("truncates content exceeding 500K characters", async () => {
    const telemetry = new Telemetry(TEMP_DIR, true);
    const longContent = "x".repeat(600_000);

    await telemetry.emitTranscript(makeTranscript({
      prompt: longContent,
      response: longContent,
    }));

    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    const files = readdirSync(transcriptsDir);
    const content = readFileSync(join(transcriptsDir, files[0]), "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.prompt.length).toBeLessThan(600_000);
    expect(entry.prompt).toContain("[truncated]");
    expect(entry.response.length).toBeLessThan(600_000);
    expect(entry.response).toContain("[truncated]");
  });

  it("does not truncate content under 500K characters", async () => {
    const telemetry = new Telemetry(TEMP_DIR, true);
    const normalContent = "x".repeat(1000);

    await telemetry.emitTranscript(makeTranscript({
      prompt: normalContent,
      response: normalContent,
    }));

    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    const files = readdirSync(transcriptsDir);
    const content = readFileSync(join(transcriptsDir, files[0]), "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.prompt).not.toContain("[truncated]");
    expect(entry.response).not.toContain("[truncated]");
  });

  it("does not write when telemetry is disabled", async () => {
    const telemetry = new Telemetry(TEMP_DIR, false); // disabled
    await telemetry.emitTranscript(makeTranscript());

    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    expect(existsSync(transcriptsDir)).toBe(false);
  });

  it("omits tokens when not provided", async () => {
    const telemetry = new Telemetry(TEMP_DIR, true);
    await telemetry.emitTranscript(makeTranscript({
      tokens: undefined,
    }));

    const transcriptsDir = join(TEMP_DIR, "..", "transcripts");
    const files = readdirSync(transcriptsDir);
    const content = readFileSync(join(transcriptsDir, files[0]), "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.tokens).toBeUndefined();
  });
});
