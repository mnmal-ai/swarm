/**
 * Tests for per-role model selection and reporting: each role's backend asks
 * for the model the project names for that role, and every session reports,
 * tagged with its role, which models actually served it.
 */

import { describe, it, expect } from "vitest";
import type { IWorkerBackend, ModelReport, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";
import { roleBackendConfig, roleBackendConfigs, withModelReporting, modelMismatch, describeModelReport } from "../src/cli/role-models.js";
import type { RoleModelReport } from "../src/cli/role-models.js";

const INPUT: WorkerTaskInput = { task: "t", workingDirectory: "/w", swarmContext: "", maxTurns: 1 };

function report(overrides: Partial<ModelReport> = {}): ModelReport {
  return {
    requested: "claude-opus-5-5",
    sessionModel: "claude-opus-5-5",
    responses: { "claude-opus-5-5": 3 },
    usage: { "claude-opus-5-5": { input: 100, output: 20 } },
    ...overrides,
  };
}

function fakeBackend(modelReport?: ModelReport): IWorkerBackend {
  return {
    type: "claude-code",
    supportsDirectExecution: true,
    model: modelReport?.requested,
    isAvailable: async () => true,
    execute: async (): Promise<WorkerTaskOutput> => ({
      output: "done",
      latencyMs: 1,
      tokensUsed: { input: 1, output: 1 },
      filesChanged: [],
      backendUsed: "claude-code",
      modelReport,
    }),
  };
}

describe("roleBackendConfig", () => {
  it("asks for the model the project names for the role", () => {
    expect(roleBackendConfig({ type: "claude-code" }, "claude-sonnet-5-5")).toEqual({
      type: "claude-code",
      model: "claude-sonnet-5-5",
    });
  });

  it("keeps a model set on the backend itself", () => {
    expect(roleBackendConfig({ type: "claude-code", model: "claude-haiku-4-5-20251001" }, "claude-sonnet-5-5").model).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("leaves the model unset when the project names none, so existing projects keep the runtime default", () => {
    expect(roleBackendConfig({ type: "claude-code" }, undefined)).not.toHaveProperty("model");
  });
});

describe("withModelReporting", () => {
  it("reports each session's models, tagged with the role", async () => {
    const reports: RoleModelReport[] = [];
    const backend = withModelReporting(fakeBackend(report()), "reviewer", (r) => reports.push(r));

    await backend.execute(INPUT);

    expect(reports).toHaveLength(1);
    expect(reports[0].role).toBe("reviewer");
    expect(reports[0].report.sessionModel).toBe("claude-opus-5-5");
  });

  it("returns the inner backend's result unchanged", async () => {
    const out = await withModelReporting(fakeBackend(report()), "worker", () => {}).execute(INPUT);

    expect(out.output).toBe("done");
  });

  it("keeps the inner backend's type, model and direct-execution support", () => {
    const backend = withModelReporting(fakeBackend(report()), "arbiter", () => {});

    expect(backend.type).toBe("claude-code");
    expect(backend.model).toBe("claude-opus-5-5");
    expect(backend.supportsDirectExecution).toBe(true);
  });

  it("passes every session's tokens on, with or without a model report", async () => {
    const spent: Array<{ input: number; output: number }> = [];
    await withModelReporting(fakeBackend(report()), "reviewer", () => {}, (t) => spent.push(t)).execute(INPUT);
    await withModelReporting(fakeBackend(undefined), "worker", () => {}, (t) => spent.push(t)).execute(INPUT);

    expect(spent).toEqual([{ input: 1, output: 1 }, { input: 1, output: 1 }]);
  });

  it("reports nothing when the backend gives no report", async () => {
    const reports: RoleModelReport[] = [];
    await withModelReporting(fakeBackend(undefined), "worker", (r) => reports.push(r)).execute(INPUT);

    expect(reports).toEqual([]);
  });
});

describe("modelMismatch", () => {
  it("is null when the session ran on the model asked for", () => {
    expect(modelMismatch(report())).toBeNull();
  });

  it("names the difference when the session started on another model", () => {
    expect(modelMismatch(report({ sessionModel: "claude-sonnet-5-5" }))).toMatch(/asked for claude-opus-5-5.*claude-sonnet-5-5/);
  });

  it("names the difference when no response came from the model asked for", () => {
    expect(modelMismatch(report({ responses: { "claude-sonnet-5-5": 4 } }))).toMatch(/no response from claude-opus-5-5/);
  });

  it("names the absence of evidence when a model was asked for but the session reported none", () => {
    expect(modelMismatch(report({ sessionModel: undefined, responses: {} }))).toMatch(/reported no model/);
  });

  it("is null when nothing was asked for", () => {
    expect(modelMismatch(report({ requested: undefined, sessionModel: "claude-sonnet-5-5" }))).toBeNull();
  });
});

describe("describeModelReport", () => {
  it("states role, model asked for, session model, responses and tokens", () => {
    const line = describeModelReport({ role: "arbiter", report: report({ requested: "claude-fable-5-1", sessionModel: "claude-fable-5-1", responses: { "claude-fable-5-1": 2 }, usage: { "claude-fable-5-1": { input: 10, output: 5 } } }), timestamp: 0 });

    expect(line).toContain("arbiter");
    expect(line).toContain("asked claude-fable-5-1");
    expect(line).toContain("session claude-fable-5-1");
    expect(line).toContain("claude-fable-5-1×2");
  });
});

// Built-in tools each role's Claude Code sessions get unless the project lists
// its own. Reviewers and arbiters are told not to modify files, so they get no
// file-writing tool.
const WORKER_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
const REVIEW_TOOLS = ["Read", "Glob", "Grep", "Bash"];

describe("roleBackendConfigs — what run.ts hands each role's backend", () => {
  const IDENTITY = { name: "Example Bot", email: "bot@example.com" };

  it("gives the worker, reviewer and arbiter backends the project's git identity", () => {
    const configs = roleBackendConfigs({
      backends: { worker: { type: "claude-code" }, reviewer: { type: "claude-code" } },
      models: { worker: "claude-opus-5-5", reviewer: "claude-sonnet-5-5" },
      source_control: { strategy: "remote_pr", git_identity: IDENTITY },
    });

    expect(configs.worker).toEqual({ type: "claude-code", model: "claude-opus-5-5", tools: WORKER_TOOLS, gitIdentity: IDENTITY });
    expect(configs.reviewer).toEqual({ type: "claude-code", model: "claude-sonnet-5-5", tools: REVIEW_TOOLS, gitIdentity: IDENTITY });
    // No arbiter block: the API default, still carrying the identity (its
    // agentic loop's run_command is a shell too).
    expect(configs.arbiter).toEqual({ type: "api", gitIdentity: IDENTITY });
  });

  it("adds no gitIdentity key when none is configured", () => {
    const configs = roleBackendConfigs({
      backends: { worker: { type: "claude-code" } },
      models: {},
      source_control: { strategy: "remote_pr" },
    });

    for (const role of ["worker", "reviewer", "arbiter"] as const) {
      expect(configs[role]).not.toHaveProperty("gitIdentity");
    }
    expect(configs.worker).toEqual({ type: "claude-code", tools: WORKER_TOOLS });
  });

  it("gives every role the run's empty GH_CONFIG_DIR, so no agent has GitHub access", () => {
    const configs = roleBackendConfigs(
      {
        backends: { worker: { type: "claude-code" } },
        models: {},
        source_control: { strategy: "remote_pr", github_account: "example-bot", git_identity: IDENTITY },
      },
      { ghConfigDir: "/tmp/swarm-worker-gh-run" },
    );

    for (const role of ["worker", "reviewer", "arbiter"] as const) {
      expect(configs[role].ghConfigDir, role).toBe("/tmp/swarm-worker-gh-run");
      expect(configs[role].gitIdentity, role).toEqual(IDENTITY);
    }
  });
});

describe("roleBackendConfigs — built-in tools per role", () => {
  const SC = { strategy: "remote_pr" as const };

  it("gives Claude Code workers the worker set, and reviewers and arbiters the read-only set", () => {
    const configs = roleBackendConfigs({
      backends: { worker: { type: "claude-code" }, reviewer: { type: "claude-code" }, arbiter: { type: "claude-code" } },
      models: {},
      source_control: SC,
    });

    expect(configs.worker.tools).toEqual(WORKER_TOOLS);
    expect(configs.reviewer.tools).toEqual(REVIEW_TOOLS);
    expect(configs.arbiter.tools).toEqual(REVIEW_TOOLS);
  });

  it("keeps a role's own tools list", () => {
    const configs = roleBackendConfigs({
      backends: { reviewer: { type: "claude-code", tools: ["Read", "Bash", "WebFetch"] } },
      models: {},
      source_control: SC,
    });

    expect(configs.reviewer.tools).toEqual(["Read", "Bash", "WebFetch"]);
  });

  it("gives an API role with a Claude Code fallback its role's set, which the fallback keeps", () => {
    const configs = roleBackendConfigs({
      backends: {
        worker: { type: "api", fallback: "claude-code" },
        reviewer: { type: "api", fallback: "claude-code" },
        arbiter: { type: "api", fallback: "claude-code" },
      },
      models: {},
      source_control: SC,
    });

    expect(configs.worker.tools).toEqual(WORKER_TOOLS);
    expect(configs.reviewer.tools).toEqual(REVIEW_TOOLS);
    expect(configs.arbiter.tools).toEqual(REVIEW_TOOLS);
  });

  it("adds no tools key to an API backend, which has no built-in tools", () => {
    const configs = roleBackendConfigs({ backends: {}, models: {}, source_control: SC });

    for (const role of ["worker", "reviewer", "arbiter"] as const) {
      expect(configs[role], role).not.toHaveProperty("tools");
    }
  });
});

describe("codex roles", () => {
  const FNL = { bin: "/usr/local/bin/fnl", wrap: ["pnpm test"] };
  const config = (worker: "codex" | "claude-code", reviewer: "codex" | "claude-code") => ({
    backends: { worker: { type: worker }, reviewer: { type: reviewer }, arbiter: { type: "claude-code" as const } },
    models: { worker: "w", reviewer: "r", arbiter: "a" },
  });

  it("get the role's tools, fnl and the hook command", () => {
    const roles = roleBackendConfigs(config("codex", "codex"), { fnl: FNL, codexHookCommand: "swarm codex-hook" });
    expect(roles.worker).toMatchObject({ type: "codex", model: "w", tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], fnl: FNL, codexHookCommand: "swarm codex-hook" });
    expect(roles.reviewer).toMatchObject({ type: "codex", tools: ["Read", "Glob", "Grep", "Bash"], codexHookCommand: "swarm codex-hook" });
    expect(roles.arbiter).not.toHaveProperty("codexHookCommand");
  });

  it.each([
    [{ type: "api" as const }],
    [{ type: "claude-code" as const, fallback: "api" as const }],
    [{ type: "api" as const, fallback: "claude-code" as const }],
  ])("leave %j roles exactly as before", (backend) => {
    const project = { backends: { worker: backend, reviewer: backend, arbiter: backend }, models: { worker: "w", reviewer: "r", arbiter: "a" } };
    expect(roleBackendConfigs(project, { fnl: FNL, codexHookCommand: "swarm codex-hook" })).toEqual(roleBackendConfigs(project, { fnl: FNL }));
  });

  it("leave claude-code roles exactly as before", () => {
    const withHook = roleBackendConfigs(config("claude-code", "claude-code"), { fnl: FNL, codexHookCommand: "swarm codex-hook" });
    const without = roleBackendConfigs(config("claude-code", "claude-code"), { fnl: FNL });
    expect(withHook).toEqual(without);
    expect(withHook.worker).not.toHaveProperty("codexHookCommand");
  });
});
