/**
 * `swarm codex-hook`, the command Codex runs before each tool a codex
 * session uses, and how swarm finds the command line that runs itself.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexHookArgs } from "@mnmal-ai/swarm-worker-backends";
import { swarmSelfCommand, codexHookCommand } from "../src/cli/codex-hook.js";

describe("swarmSelfCommand", () => {
  it("re-runs a compiled binary by itself", () => {
    expect(swarmSelfCommand("/usr/local/bin/swarm", "/$bunfs/root/main", true)).toEqual(["/usr/local/bin/swarm"]);
  });
  it("re-runs an npm install with node and its entry script", () => {
    expect(swarmSelfCommand("/usr/bin/node", "/x/node_modules/.bin/swarm", false)).toEqual(["/usr/bin/node", "/x/node_modules/.bin/swarm"]);
  });
  it("re-runs a source checkout through tsx", () => {
    expect(swarmSelfCommand("/usr/bin/node", "/repo/packages/cli/src/cli/main.ts", false)).toEqual(["npx", "tsx", "/repo/packages/cli/src/cli/main.ts"]);
  });
});

describe("codexHookCommand", () => {
  it("quotes each part for /bin/sh", () => {
    expect(codexHookCommand(["/opt/my swarm/swarm"])).toBe("'/opt/my swarm/swarm' codex-hook");
    expect(codexHookCommand(["/usr/bin/node", "/x/it's/main.js"])).toBe(`/usr/bin/node '/x/it'\\''s/main.js' codex-hook`);
  });
});

describe("swarm codex-hook (process)", () => {
  const main = resolve(__dirname, "../src/cli/main.ts");
  const run = (stdin: string, args: string[]) =>
    spawnSync("npx", ["tsx", main, "codex-hook", ...args], { input: stdin, encoding: "utf8", timeout: 60_000 });
  const policy = { version: 1 as const, deniedTools: ["Bash(git push:*)"], canRunCommands: true, canEdit: true };

  it("answers a denied command with a deny, logs it, and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-codex-hook-cli-"));
    const r = run(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sh -c 'git push'" }, tool_use_id: "t" }),
      codexHookArgs("PreToolUse", policy, dir),
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).toContain('"decision":"deny"');
  }, 60_000);

  it("denies when its arguments carry no policy", () => {
    const r = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), ["pre-tool-use"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  }, 60_000);
});
