/**
 * Reviewer and arbiter backends in scaffold
 *
 * Every backend preset `swarm init` offers puts all three roles on the
 * chosen runtime, as written to config.json and as roleBackendConfigs
 * resolves it; and the config.json template itself carries
 * backends.worker, backends.reviewer and backends.arbiter.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffold, type RuntimeBackend } from "../src/scaffold/index.js";
import { roleBackendConfigs } from "../src/cli/role-models.js";

/** The domain config `swarm init` writes for a backend choice. */
async function scaffoldedConfig(backend: RuntimeBackend): Promise<Record<string, any>> {
  const dir = await mkdtemp(join(tmpdir(), "swarm-scaffold-backends-"));
  try {
    await scaffold({ projectName: "sample-project", outputDir: dir, fillLevel: "quick", backend, answers: {} });
    return JSON.parse(await readFile(join(dir, "domains", "sample-project", "config.json"), "utf-8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The backend preset `swarm init` applies must keep the reviewer and arbiter on
// the chosen runtime. A project that names only the worker runs its reviewer and
// arbiter on the direct API (roleBackendConfigs' default), so without an API key
// every review is rejected for safety and no goal can finish.
describe("swarm init gives the reviewer and arbiter the chosen backend", () => {
  for (const backend of ["claude-code", "cursor"] as const) {
    it(`a ${backend} project runs every role on claude-code`, async () => {
      const config = await scaffoldedConfig(backend);
      const resolved = roleBackendConfigs(config);

      for (const role of ["worker", "reviewer", "arbiter"] as const) {
        expect(config.backends?.[role]).toEqual({ type: "claude-code", fallback: "api" });
        expect(resolved[role].type).toBe("claude-code");
      }
    });
  }

  // The API presets: direct-api (Anthropic by default), codex (the OpenAI API)
  // and undecided (the Anthropic API until the user picks a runtime).
  for (const [backend, provider] of [
    ["direct-api", "anthropic"],
    ["codex", "openai"],
    ["undecided", "anthropic"],
  ] as const) {
    it(`a ${backend} project runs every role on the ${provider} API`, async () => {
      const config = await scaffoldedConfig(backend);
      const resolved = roleBackendConfigs(config);

      expect(config.models?.provider).toBe(provider);
      for (const role of ["worker", "reviewer", "arbiter"] as const) {
        expect(config.backends?.[role]).toEqual({ type: "api" });
        expect(resolved[role].type).toBe("api");
      }
    });
  }
});

describe("scaffold config.json template contains reviewer and arbiter backends", () => {
  it("config.json template contains backends.reviewer with type claude-code", async () => {
    const { TEMPLATES } = await import("../src/scaffold/templates/index.js");

    // Parse the config.json template (replace {project} and {timestamp} placeholders)
    const templateStr = (TEMPLATES as Record<string, string>)["domains/{project}/config.json"]
      .replace(/\{project\}/g, "test-project")
      .replace(/\{timestamp\}/g, new Date().toISOString());

    const config = JSON.parse(templateStr);

    expect(config.backends).toBeDefined();
    expect(config.backends.reviewer).toBeDefined();
    expect(config.backends.reviewer.type).toBe("claude-code");
  });

  it("config.json template contains backends.arbiter with type claude-code", async () => {
    const { TEMPLATES } = await import("../src/scaffold/templates/index.js");

    const templateStr = (TEMPLATES as Record<string, string>)["domains/{project}/config.json"]
      .replace(/\{project\}/g, "test-project")
      .replace(/\{timestamp\}/g, new Date().toISOString());

    const config = JSON.parse(templateStr);

    expect(config.backends).toBeDefined();
    expect(config.backends.arbiter).toBeDefined();
    expect(config.backends.arbiter.type).toBe("claude-code");
  });

  it("config.json template contains backends.worker with type claude-code", async () => {
    const { TEMPLATES } = await import("../src/scaffold/templates/index.js");

    const templateStr = (TEMPLATES as Record<string, string>)["domains/{project}/config.json"]
      .replace(/\{project\}/g, "test-project")
      .replace(/\{timestamp\}/g, new Date().toISOString());

    const config = JSON.parse(templateStr);

    expect(config.backends.worker).toBeDefined();
    expect(config.backends.worker.type).toBe("claude-code");
  });

  it("config.json template has all three backends: worker, reviewer, arbiter", async () => {
    const { TEMPLATES } = await import("../src/scaffold/templates/index.js");

    const templateStr = (TEMPLATES as Record<string, string>)["domains/{project}/config.json"]
      .replace(/\{project\}/g, "test-project")
      .replace(/\{timestamp\}/g, new Date().toISOString());

    const config = JSON.parse(templateStr);

    const backendKeys = Object.keys(config.backends);
    expect(backendKeys).toContain("worker");
    expect(backendKeys).toContain("reviewer");
    expect(backendKeys).toContain("arbiter");
  });
});
