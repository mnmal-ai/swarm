/**
 * Workers get no GitHub access. The Claude Code backend's process env carries
 * none of GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN /
 * GITHUB_ENTERPRISE_TOKEN, and GH_CONFIG_DIR points at an empty directory
 * (BackendConfig.ghConfigDir, else a per-process default) so gh inside the
 * worker has no login and cannot reach the machine's keyring login.
 *
 * Mocks the SDK and asserts on what reaches `sdk.query({ options })`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync } from "node:fs";

const queryCalls: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args.options);
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        duration_ms: 1,
        modelUsage: { "claude-x": { inputTokens: 1, outputTokens: 1 } },
      };
    })();
  },
}));

const { ClaudeCodeBackend } = await import("../src/claude-code.js");
const { instantiateFallback } = await import("../src/index.js");
const { GITHUB_TOKEN_ENV_VARS } = await import("@mnmal-ai/swarm-types");

const INPUT = { task: "do a thing", workingDirectory: "/tmp", swarmContext: "", maxTurns: 1 };
const MACHINE_GH_CONFIG = "/home/example/.config/gh";

function envOf(call: Record<string, unknown>): Record<string, string | undefined> {
  return call.env as Record<string, string | undefined>;
}

describe("ClaudeCodeBackend: workers get no GitHub access", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    queryCalls.length = 0;
    for (const k of [...GITHUB_TOKEN_ENV_VARS, "GH_CONFIG_DIR"]) {
      saved[k] = process.env[k];
      // What the shell swarm runs in might hold: all of it must stay out.
      process.env[k] = k === "GH_CONFIG_DIR" ? MACHINE_GH_CONFIG : "ambient-token";
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("passes no GitHub token variable and the configured empty GH_CONFIG_DIR", async () => {
    await new ClaudeCodeBackend({ type: "claude-code", ghConfigDir: "/tmp/swarm-worker-gh-run" }).execute(INPUT);

    const env = envOf(queryCalls[0]);
    for (const name of GITHUB_TOKEN_ENV_VARS) expect(env, name).not.toHaveProperty(name);
    expect(env.GH_CONFIG_DIR).toBe("/tmp/swarm-worker-gh-run");
  });

  it("with no directory configured, still points gh at an empty directory, never the machine's", async () => {
    await new ClaudeCodeBackend({ type: "claude-code" }).execute(INPUT);

    const env = envOf(queryCalls[0]);
    for (const name of GITHUB_TOKEN_ENV_VARS) expect(env, name).not.toHaveProperty(name);
    expect(env.GH_CONFIG_DIR).toBeDefined();
    expect(env.GH_CONFIG_DIR).not.toBe(MACHINE_GH_CONFIG);
    expect(existsSync(env.GH_CONFIG_DIR!)).toBe(true);
    expect(readdirSync(env.GH_CONFIG_DIR!)).toEqual([]);
  });

  it("carries the directory onto a claude-code fallback backend", async () => {
    const fallback = instantiateFallback({ type: "api", fallback: "claude-code", ghConfigDir: "/tmp/swarm-worker-gh-run" });
    await fallback!.execute(INPUT);

    expect(envOf(queryCalls[0]).GH_CONFIG_DIR).toBe("/tmp/swarm-worker-gh-run");
  });
});
