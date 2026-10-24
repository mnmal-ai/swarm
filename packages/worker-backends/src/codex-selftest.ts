/**
 * Before a codex session starts, the backend runs the exact hook command it
 * will give Codex, with the session's environment and policy, on made-up
 * PreToolUse calls: one the policy must deny and one it must allow. Codex
 * treats a hook that crashes or cannot be found as "allow", so without this
 * a broken install would run with no deny list at all.
 */

import { spawn } from "node:child_process";
import { SELF_TEST_ID_PREFIX, type CodexHookPolicy } from "./codex-hook.js";
import { ruleWords } from "./deny-matcher.js";

export class CodexHookSelfTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexHookSelfTestError";
  }
}

export interface SelfTestProbe {
  tool: string;
  command: string;
  expect: "deny" | "allow";
}

/** The calls a policy's hook must answer correctly: something it denies, then something it allows. */
export function selfTestProbes(policy: CodexHookPolicy): SelfTestProbe[] {
  if (!policy.canRunCommands) return [{ tool: "Bash", command: "true", expect: "deny" }];
  const bashRule = policy.deniedTools.find((r) => r === "Bash" || /^Bash\([\s\S]+\)$/.test(r));
  const words = bashRule === undefined ? undefined : ruleWords(bashRule);
  if (words === null) return [{ tool: "Bash", command: "true", expect: "deny" }];
  const probes: SelfTestProbe[] = [];
  // A wildcard in a rule word matches the word without it: `push*` matches `push`.
  const probeWords = (words ?? []).map((w) => w.replace(/\*/g, "")).filter((w) => w !== "");
  if (probeWords.length > 0) probes.push({ tool: "Bash", command: probeWords.join(" "), expect: "deny" });
  else if (!policy.canEdit) probes.push({ tool: "apply_patch", command: "*** Begin Patch\n*** End Patch", expect: "deny" });
  probes.push({ tool: "Bash", command: "true", expect: "allow" });
  return probes;
}

/** Resolves when the hook answers every probe as the policy requires; throws CodexHookSelfTestError otherwise. */
export async function selfTestCodexHook(o: {
  hookCommand: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  policy: CodexHookPolicy;
  timeoutMs?: number;
}): Promise<void> {
  const probes = selfTestProbes(o.policy);
  for (const [i, probe] of probes.entries()) {
    const input = {
      session_id: SELF_TEST_ID_PREFIX,
      hook_event_name: "PreToolUse",
      tool_name: probe.tool,
      tool_input: { command: probe.command },
      tool_use_id: `${SELF_TEST_ID_PREFIX}-${i}`,
      cwd: o.cwd,
    };
    const { code, stdout, stderr } = await runHook(o.hookCommand, JSON.stringify(input), o.env, o.cwd, o.timeoutMs ?? 30_000);
    if (code !== 0) {
      const said = stderr.trim() ? `: ${stderr.trim().split("\n")[0].slice(0, 200)}` : "";
      throw new CodexHookSelfTestError(`the codex hook exited ${code}${said}; swarm will not start a session whose deny list it cannot enforce`);
    }
    let denied = false;
    if (stdout.trim()) {
      try {
        const reply = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
        denied = reply.hookSpecificOutput?.permissionDecision === "deny";
      } catch {
        throw new CodexHookSelfTestError("the codex hook answered with something that is not JSON");
      }
    }
    if ((probe.expect === "deny") !== denied) {
      throw new CodexHookSelfTestError(`the codex hook did not ${probe.expect} a probe ${probe.tool} call; swarm will not start the session`);
    }
  }
}

function runHook(
  command: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env, cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(new CodexHookSelfTestError(`the codex hook did not answer within ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 4096) stderr += String(d);
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new CodexHookSelfTestError(`the codex hook could not run: ${err.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
