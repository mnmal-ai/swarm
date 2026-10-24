#!/usr/bin/env node
// A stand-in for `codex exec --json`, driven by FAKE_CODEX_MODE: it records
// its argv and environment, calls the configured hooks the way Codex does,
// and prints a session's JSONL.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const setting = (prefix) => args.find((a, i) => args[i - 1] === "-c" && a.startsWith(prefix));
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const record = process.env.FAKE_CODEX_RECORD;
if (record) appendFileSync(record, JSON.stringify({ args, env: process.env }) + "\n");
const hookCommandFor = (event) => JSON.parse(setting(`hooks.${event}=`).match(/command=("(?:[^"\\]|\\.)*")/)[1]);
const callHook = (payload) => {
  try {
    return execFileSync("/bin/sh", ["-c", hookCommandFor(payload.hook_event_name)], { input: JSON.stringify(payload), encoding: "utf8" });
  } catch {
    return "";
  }
};
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const stdin = await new Promise((resolve) => {
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => resolve(s));
});

if (mode === "login") {
  process.stderr.write("ERROR failed to connect: 401 Unauthorized\n");
  out({ type: "thread.started", thread_id: "t1" });
  out({ type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized)" });
  out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" } });
  process.exit(1);
} else if (mode === "tamper-fail") {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  writeFileSync(`${common}/hooks/pre-push`, "#!/bin/sh\necho planted\n");
  out({ type: "turn.failed", error: { message: "something broke" } });
  process.exit(1);
} else if (mode === "tamper") {
  // What a planted hook would look like; the fake is not sandboxed, so it can write it.
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  writeFileSync(`${common}/hooks/pre-push`, "#!/bin/sh\necho planted\n");
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } });
  writeFileSync(args[args.indexOf("-o") + 1], "done");
  out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
} else if (mode === "hang") {
  spawn("sleep", ["60"], { stdio: "ignore" });
  if (record) appendFileSync(record, JSON.stringify({ hung: process.pid }) + "\n");
  setInterval(() => {}, 1000);
} else {
  console.log("Reading additional input from stdin...");
  out({ type: "thread.started", thread_id: "t1" });
  callHook({ hook_event_name: "SessionStart", model: "fake-codex-model", session_id: "s" });
  const pushAnswer = callHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "sh -c 'git push origin main'" },
    tool_use_id: "call-push",
    cwd: process.cwd(),
  });
  out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'node --test'" } });
  out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'node --test'", exit_code: 0 } });
  out({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: `${process.cwd()}/src/discount.js`, kind: "update" }] } });
  out({ type: "error", message: "Reconnecting... 1/5" });
  const decision = JSON.parse(pushAnswer || "{}").hookSpecificOutput?.permissionDecision ?? "allowed";
  const text = mode === "silent" ? "" : `task=${stdin.trim()} push=${decision}`;
  if (text) {
    out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text } });
    writeFileSync(args[args.indexOf("-o") + 1], text);
  }
  out({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50 } });
}
