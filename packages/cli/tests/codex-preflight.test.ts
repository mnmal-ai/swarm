/**
 * Before a run takes work, every role that will run on codex is checked; a
 * project with no codex role is not touched.
 */

import { describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "@mnmal-ai/swarm-types";
import { preflightCodexRoles } from "../src/cli/codex-preflight.js";

const roles = (worker: BackendConfig, reviewer: BackendConfig = { type: "claude-code" }) => ({ worker, reviewer, arbiter: { type: "claude-code" } as BackendConfig });

describe("preflightCodexRoles", () => {
  it("does nothing for a project with no codex role", async () => {
    const check = vi.fn(async () => {});
    const problems = await preflightCodexRoles(
      roles({ type: "claude-code", fallback: "api" }, { type: "api" }),
      { worker: "claude-code", reviewer: "api", arbiter: "claude-code" },
      "/repo",
      check,
    );
    expect(problems).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks a codex role and reports what is wrong with it", async () => {
    const check = vi.fn(async () => {
      throw new Error("codex is not installed (no `codex` on PATH)");
    });
    const problems = await preflightCodexRoles(roles({ type: "codex" }), { worker: "codex", reviewer: "claude-code", arbiter: "claude-code" }, "/repo", check);
    expect(problems).toEqual([{ role: "worker", message: "codex is not installed (no `codex` on PATH)" }]);
  });

  it("skips a codex role that fell back to another backend", async () => {
    const check = vi.fn(async () => {});
    await preflightCodexRoles(roles({ type: "codex", fallback: "claude-code" }), { worker: "claude-code", reviewer: "claude-code", arbiter: "claude-code" }, "/repo", check);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks a codex fallback with the deny list and hook it carries", async () => {
    const check = vi.fn(async () => {});
    const worker: BackendConfig = { type: "claude-code", fallback: "codex", codexHookCommand: "swarm codex-hook", permissions: { deniedTools: ["Bash(git push:*)"] } };
    await preflightCodexRoles(roles(worker), { worker: "codex", reviewer: "claude-code", arbiter: "claude-code" }, "/repo", check);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ type: "codex", codexHookCommand: "swarm codex-hook", permissions: { deniedTools: ["Bash(git push:*)"] } }),
      "/repo",
    );
  });
});
