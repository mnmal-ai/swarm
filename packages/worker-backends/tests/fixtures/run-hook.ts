// The real codex hook, for the backend tests: the same runCodexHook that
// `swarm codex-hook <event> --policy … --log …` runs, through tsx.
import { parseCodexHookArgs, runCodexHook } from "../../src/codex-hook.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
const reply = await runCodexHook(Buffer.concat(chunks).toString("utf8"), parseCodexHookArgs(process.argv.slice(2)));
if (reply.stdout) process.stdout.write(reply.stdout);
process.exit(reply.exitCode);
