# Swarm OS Plan 11: Local models through OpenCode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every role swarm runs (worker, reviewer, arbiter, the small one-shot calls, and in Swarm OS the chief of staff) can run on a model served on the run host by Ollama or LM Studio, through a fourth backend, `opencode`, with the same guards as Claude Code, a check before work, a once-per-host acknowledgement, and a project-level promise, `privacy: "local"`, that refuses to start when anything would leave the machine.

**Architecture:** Shared, pure names live in `packages/types/src/local-models.ts` (model references, providers, what counts as local, the privacy classes, the chief-of-staff locality validator). `packages/worker-backends` gains a fetch-only OpenAI-compatible client (`openai-compatible.ts`) that the small calls, the pre-run check and the chief of staff's tool-less turns use, and `OpenCodeBackend`: one `opencode run --standalone` process per session, whose whole configuration is inline, whose config, data, state and cache homes live in a private session directory, and whose every tool call goes through swarm's guard plugin to a guard server in swarm's own process. `packages/cli` gains the pre-run check, the acknowledgement, `swarm local-models check` and the `privacy: "local"` refusal. `packages/os` learns the `"local"` privacy value, counts OpenCode sessions, takes the `local_models_unacknowledged` exit like `login_expired`, and bounds paid use by remote tokens only.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest, node `http`/`net` (the guard server on a Unix socket, the scripted chat server, the fake endpoint in tests), `fetch` (the OpenAI-compatible client; no new SDK), OpenCode 2.1.4 (`opencode run --standalone --format json`), Ollama and LM Studio as the only tested endpoints.

**Spec:** `docs/superpowers/specs/2026-10-25-local-models-opencode-design.md` (approved 2026-10-25, with the two owner decisions in "Decided with the owner's approval"). Shared contracts and rulings: `docs/superpowers/plans/2026-10-25-swarm-os/00-overview.md`, including its "Local models (plan 11)" block. Where this plan and the design disagree, the design wins.

**Order:** after plans 01 and 04 and plan 10's remaining tasks (7 to 13); before plans 05 to 09. Plan 06 gains one task from this plan (its Task 14, the chief of staff on OpenCode) and plan 08's register task gains steps; both run with their plans.

## Global Constraints

- **`swarm run` with no local backend configured behaves exactly as before.** No project that names no `opencode` backend, no `provider/model` model, no `openai-compatible` provider and no `privacy` key sees a new line of output, a new prompt, a new check or a new file. The CLI suite (`cd packages/cli && npx vitest run`) stays green after every task.
- **The design's values, verbatim:** the backend is `"opencode"`; models are `provider/model` (`ollama/gpt-oss:20b-64k`); the run command is `opencode run --standalone --format json --model <provider/model> --auto [--agent swarm-<role>]`, in the worktree, the task on stdin; the session directory is `~/.swarm/opencode-sessions/s-<id>`, mode `0700`, removed afterwards, overridden by `SWARM_OPENCODE_SESSIONS_DIR`; provider defaults are `ollama` at `http://127.0.0.1:11434/v1` and `lmstudio` at `http://127.0.0.1:1234/v1`; the acknowledgement is typed `I understand`, stored in `.swarm/state/local-models-ack.json`, never committed, keyed by role, model and warning kind; the OS exit reason is `local_models_unacknowledged`; the metric label is `locality` with values `local` and `remote`.
- **OpenCode never reads the owner's setup or the repository's.** Every session: inline config only, an empty global config directory, the project-config switch off, XDG config/data/state/cache homes inside the session directory; sharing, auto-update, the model catalogue fetch, free models, Claude Code compatibility, its skills and the file watcher off; exactly one plugin, swarm's guard. A switch the installed version does not have stops the backend from starting, naming it.
- **The guard fails closed.** A session whose guard self-test does not pass never receives its task. A guard request that times out, fails or cannot be parsed blocks the tool call.
- **Credentials never reach a session:** no API key variables, no GitHub token variables, an empty `GH_CONFIG_DIR`, git with `credential.helper=` and `core.sshCommand=false`, `GIT_SSH_COMMAND=false`, `GIT_TERMINAL_PROMPT=0`, as codex sessions get today.
- **Nothing downloads a model, and nothing in a local session reaches a non-loopback address** (or a `local_models.trusted_hosts` host). The probe (Task 1) and the live proof (Task 17) record outbound connections to show it.
- **Warnings report evidence**, never a guess about quality: the window size against the role's estimate, a failed tool round trip, a window swarm could not read.
- **Safety never depends on the model:** the guard, the permission rules, the git guard, the privacy refusal and the chief of staff's executor hold whatever the model says.
- **Live-model tests stay out of the suites.** Unit and integration tests use the fixtures Task 1 records and the fake OpenAI-compatible endpoint (`packages/worker-backends/tests/fixtures/fake-openai.ts`). The only live runs are Task 1's probe and Task 17's proof, both run by the controller on the owner's machine, in a scratch directory, never a client project, never the owner's OpenCode config.
- **Metrics** follow the overview: every row is declared in `packages/metrics/src/catalogue/` before it is recorded; labels are bounded (provider names from config are bounded by the config; model names go on span records, not series); tokens never become currency; timers, servers and event handlers pass their parent explicitly (the run's root, `null` in the brain). Task 16 records the rows.
- **Anonymity:** no personal names, client names, hostnames, IPs other than loopback and documentation placeholders (`192.0.2.10`, `studio.example`), and no home paths beyond `~`. Examples use `project-a`, `board-a`, `owner`, `/path/to/project`.
- **No new GitHub workflows, no trigger changes, no publishing.** Verification is local only.
- Typed errors (`LocalEndpointError`, `OpenCodeVersionError`, `OpenCodeGuardError`, `LocalModelsConfigError`, `PrivacyViolation`); conventional commits; never commit `packages/cli/src/version.ts`; every commit with `git -c commit.gpgsign=false commit`.
- A task that changes `packages/types`, `packages/worker-backends` or `packages/core` runs `pnpm turbo build --filter=@mnmal-ai/swarm-cli^...` before the CLI suite, since the CLI's tests read its dependencies from `dist`.

## Review Focus

1. **OpenCode reaches the network behind swarm's back:** installing the `@ai-sdk/openai-compatible` provider package or `@opencode-ai/plugin` into the empty config or cache directory, fetching models.dev, or generating a session title with a hosted small model. Expected: none of it; the session runs with the network cut off. Pinned in Task 1 (the probe's offline run and connection log, which also decides `small_model` and `--title`) and Task 5 (`buildOpenCodeConfig` sets `small_model` to the role's own model and names only configured providers).
2. **The local model is slow to load** (a 13 GB model's first request takes tens of seconds) **or stops answering mid-session.** Expected: the tool round trip waits up to its own 180 s limit and says so; a session whose endpoint dies ends with `LocalEndpointError` naming the provider and URL, is not retried as a login failure, and never falls back to a Claude backend silently. Pinned in Task 3 (timeouts and `unreachable`) and Task 8 (`fails a session whose endpoint stops answering with the provider's name`).
3. **A model's reply is not the tool-call shape OpenCode expects** (tool calls as text, a JSON argument string that does not parse). Expected: the pre-run check stops a tool-using role with the evidence quoted; a session that receives one mid-run reports it as a `status_change` and ends with the model's last text, never hangs. Pinned in Task 10 (`stops a worker whose model answers the tool round trip with text`) and Task 7 (the `malformed-tool` fixture).
4. **The agent edits the files that keep it in check:** the work repo's `opencode.json` or `.opencode/`, git hooks or config, the guard plugin file, or the OS home. Expected: the repository's files never load (the project switch is off and the test proves a planted `opencode.json` is ignored), the git guard restores and fails the session, the plugin is verified by hash before every session, and reads and edits of the OS home are blocked by the guard. Pinned in Task 5, Task 6 and Task 8.
5. **An acknowledged run meets a changed model or a new warning.** Expected: the stored acknowledgement no longer matches, so a terminal run asks again and an OS-dispatched run exits `local_models_unacknowledged` before work; a change in the numbers alone (window 8,192 to 16,384, both below the estimate) does not ask again. Pinned in Task 11 (`asks again only when the role, model or warning kind changes`).

## File structure

| File | Responsibility |
|---|---|
| `packages/types/src/local-models.ts` (new) | `ModelRef`, providers and defaults, `resolveModelTarget`, `isLocalEndpoint`, `isLoopbackHost`, `PrivacyClass`, `privacyClassOf`, `cosTurnLocality` (the validator plans 06 and 08 use) |
| `packages/types/src/config.ts`, `orchestration.ts`, `os-protocol.ts`, `login-expired.ts` | `"opencode"`, `"openai-compatible"`, `BackendConfig.localProviders`, project `privacy`, `local_models`, `context.sections.model`, `local_models_unacknowledged`, heartbeat `remoteTokens`, attach `privacy` |
| `packages/worker-backends/src/opencode-contract.ts` (new) | What the probe confirmed about OpenCode 2.1.4: flags, switches, config keys, event names, measured overhead |
| `packages/worker-backends/src/openai-compatible.ts` (new) | `chatCompletion`, `listModels`, `modelDetails`, `LocalEndpointError` |
| `packages/worker-backends/src/scripted-chat.ts` (new) | `ScriptedChatServer`, a loopback OpenAI-compatible server that replays a script (the guard's end-to-end self-test) |
| `packages/worker-backends/src/opencode-config.ts` (new) | Session directory, `buildOpenCodeConfig`, `openCodeEnv` |
| `packages/worker-backends/src/opencode-guard.ts`, `opencode-guard-plugin.ts` (new) | `GuardServer` (decisions, doc guard, path rules, fnl, waits), the plugin source and `ensureGuardPlugin` |
| `packages/worker-backends/src/opencode-events.ts` (new) | `OpenCodeEventCollector`: events to `ProgressEvent`, tokens, files, `ModelReport` |
| `packages/worker-backends/src/opencode.ts` (new) | `OpenCodeBackend`, `findOpenCode`, `openCodeVersion` |
| `packages/worker-backends/src/small-model.ts`, `label-writer.ts`, `synopsis-writer.ts`, `index.ts` | Local targets for small calls; registry, detection, fallback carry-over |
| `packages/worker-backends/tests/fixtures/opencode/*`, `tests/fixtures/fake-openai.ts` (new) | Recorded OpenCode events, endpoint replies, the fake endpoint |
| `packages/core/src/executor/index.ts` | `OpenAIProvider` `baseURL`; `createProvider("openai-compatible", …)` |
| `packages/cli/src/cli/role-models.ts`, `run.ts`, `goal-labels.ts`, `context-sections.ts` | Wiring: roles, room tools, small-call targets, the check and the acknowledgement in the run |
| `packages/cli/src/cli/local-models-check.ts`, `local-models-ack.ts`, `local-models-command.ts` (new) | The pre-run check, the acknowledgement, `swarm local-models check` |
| `packages/cli/src/privacy.ts` (new), `packages/cli/src/project-substrate.ts` | `privacy: "local"` and the `local_only` extension |
| `packages/os/src/launcher/*`, `packages/os/src/dispatch/*`, `packages/os/src/resources/usage.ts`, `packages/substrate-plugin/src/types/os-types.ts`, `packages/cli/src/cli/os-host.ts` | `privacy: "local"` on registrations and rooms, `PathReport.privacy`, `opencodeSessions`, the new exit reason, remote-token limits |
| `packages/metrics/src/catalogue/run.ts`, `os.ts` (plan 11 block) | The rows of Task 16 |
| `docs/local-models.md` (new), `environment.md`, `docs/project-structure.md`, `README.md` | Docs |
| `scripts/opencode-probe.sh` (new) | The probe, repeatable on a later OpenCode version |

---

### Task 1: Probe the installed OpenCode, and record the contract and the fixtures (controller-run)

The design leaves OpenCode 2.1.4's event names and exact config keys to this probe. It runs the owner's OpenCode and Ollama, so the controller runs it (never a subagent without the controller watching), in a scratch directory under the scratchpad, never a client project, never with the owner's OpenCode config: every invocation is `--standalone` with `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR` and the four `XDG_*_HOME` pointed into the scratch directory. One model at a time.

**Files:**
- Create: `scripts/opencode-probe.sh` (the probe; takes `--opencode <path>` and `--model <provider/model>`, default `~/.opencode/bin/opencode` and `ollama/gpt-oss:20b-64k`; writes into `--out <dir>`)
- Create: `packages/worker-backends/src/opencode-contract.ts`
- Create: `packages/worker-backends/tests/fixtures/opencode/PROBE.md`, `*.jsonl`, `packages/worker-backends/tests/fixtures/openai/*.json`
- Test: `packages/worker-backends/tests/opencode-contract.test.ts`

**Interfaces:**
- Produces (`opencode-contract.ts`; every value below is what the probe confirmed, and a later task that needs a value reads it from here, never from a literal):

```ts
export const OPENCODE_TESTED_VERSION = "2.1.4";
export const OPENCODE_MIN_VERSION = "2.1.4";        // older refused; newer warned once per run, as external-deps does for gh
export const OPENCODE_RUN_FLAGS: readonly string[];   // ["--standalone", "--format", "--model", "--auto", "--agent"]: each must appear in `opencode run --help`
export const OPENCODE_ENV: {
  configContent: "OPENCODE_CONFIG_CONTENT"; configDir: "OPENCODE_CONFIG_DIR"; disableProjectConfig: string;   // whichever of OPENCODE_DISABLE_PROJECT_CONFIG / OPENCODE_CONFIG_PROJECT_DISABLE the probe shows working
  disableAutoupdate: "OPENCODE_DISABLE_AUTOUPDATE"; disableModelsFetch: "OPENCODE_DISABLE_MODELS_FETCH"; modelsPath: "OPENCODE_MODELS_PATH";
  disableFreeModels: "OPENCODE_DISABLE_FREE_MODELS"; disableClaudeCode: "OPENCODE_DISABLE_CLAUDE_CODE"; disableClaudeCodeSkills: "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS";
  disableFileWatcher: string;                                                                                     // OPENCODE_DISABLE_FILEWATCHER or OPENCODE_FILEWATCHER_DISABLE, as above
};
export const OPENCODE_EVENTS: { text: string; toolUse: string; stepStart: string; stepFinish: string; error: string };   // expected "text", "tool_use", "step_start", "step_finish", "error"; the probe's names win
export const OPENCODE_TOOL_NAMES: { bash: string; read: string; edit: string; write: string; list: string; glob: string; grep: string; webfetch: string; patch?: string; todo?: string };   // the built-in tool ids 2.1.4 calls its tools
export const OPENCODE_DENIED_TOOLS: readonly string[];   // every built-in id swarm never uses (webfetch, websearch, task, todowrite, todoread, codesearch, …: the probe lists them from a session's tool list)
export const OPENCODE_PLUGIN_HOOKS: { before: "tool.execute.before"; after: "tool.execute.after" };
export const OPENCODE_AGENT_KEYS: { maxSteps: string; disable: string; prompt: string };   // the agent keys for a step limit, disabling a built-in agent, and its prompt (plan 06 Task 14 uses maxSteps for cos.max_turns)
export const OPENCODE_BASE_TOKENS: number;   // the prompt tokens of a one-word prompt in a session with the worker's tools, rounded up to the next 1,000
export const OLLAMA_DEFAULT_CONTEXT: number; // the window Ollama 0.32 serves a model whose /api/show has no num_ctx, as the probe measured it
```

- [ ] **Step 1: Confirm the switches.** For each, record in `PROBE.md` the command, what it printed and the conclusion:
  1. `opencode --version` (the version line's exact form) and `opencode run --help` (each of `OPENCODE_RUN_FLAGS` present).
  2. With `OPENCODE_CONFIG_CONTENT` holding a config whose `provider` names only `ollama` (`npm` the probe's choice, `options.baseURL` `http://127.0.0.1:11434/v1`, one model with `limit.context`), `opencode run --standalone --format json --model ollama/<model> --auto` in a scratch git repo with the task on stdin, answering a one-word prompt. Record the events.
  3. The same with the scratch repo holding an `opencode.json` that sets a different model and an `.opencode/agent/x.md`: with the project switch set, neither loads (the session's model and agents prove it). Find which of the two project-switch names works; record it.
  4. The same with `XDG_CONFIG_HOME` and `HOME`-relative paths left alone versus pointed into the scratch dir: confirm nothing is written under `~/.config/opencode`, `~/.local/share/opencode` or `~/.cache/opencode` (compare their `ls -la --time-style=full-iso` before and after) when the four XDG homes and `OPENCODE_CONFIG_DIR` point into the scratch dir.
  5. **Network:** run step 2 again with every switch on while recording connections (`sudo` is not used: `lsof -i -n -P -a -p <pid>` sampled every 250 ms for the opencode process and its children, plus `nettop -P -L 1 -p <pid>` once at the end on macOS). Then run it with the network off for the process (on macOS, Wi-Fi off is acceptable for the probe; record which). Expected: only `127.0.0.1:11434` and the private server's own loopback port. If OpenCode installs an npm package (the provider, `@opencode-ai/plugin`) or fetches models.dev, find the switch or config that prevents it and record it; if none exists, stop and report to the controller: the design's anti-goal fails on this version.
  6. **Title and small model:** whether a session generates a title with a model call; whether `small_model` in the config or `--title` stops a call to anything but the configured provider. Record the choice.
  7. **Permissions:** `permission.bash` with a deny pattern, `permission.edit` `deny`, `permission.webfetch` `deny`, and the key for paths outside the worktree (`external_directory` or the version's name): one session each with a prompt that triggers the call; record the event a denied call produces and whether `--auto` approves anything not denied.
  8. **Plugin:** a file plugin listed in `plugin` (record the exact form: `file://` URL or path) whose `tool.execute.before` throws for `bash` with `echo blocked`: the call is blocked and the event says so; a plugin that cannot be loaded (syntax error) — record whether the session still runs (if it does, the guard's handshake in Task 6 is the only proof the plugin loaded, which is the design). Record the hook signatures: what `input` (`tool`, `sessionID`, `callID`) and `output` (`args`) carry, and whether mutating `output.args` changes the command run.
  9. **MCP:** a local stdio MCP server in `mcp` with `environment` and `timeout`: its tool's id as the model sees it, and the event for its call.
  10. **Stdin:** whether `opencode run` waits for stdin EOF before the first model call (so the guard handshake can finish before the task is written).
  11. **Tokens:** the token fields of the step-finish event (input, output, reasoning, cache read and write); `OPENCODE_BASE_TOKENS` from the one-word prompt with the worker's tools enabled.
  12. **Endpoints, for the fixtures:** against the running Ollama: `GET /v1/models`, `POST /api/show {"model": "<model>"}`, a chat completion with text, one with a `tools` array asking for one call (`tool_choice: "auto"`); the same against LM Studio if a model is loaded there (`GET /api/v0/models`), else record that LM Studio fixtures are hand-written from its documented shape and marked so. `OLLAMA_DEFAULT_CONTEXT`: `/api/show` of a model without `num_ctx` in its parameters, then a prompt of known size to see where it truncates (or the server log's `n_ctx`).
- [ ] **Step 2: Save the fixtures**, each redacted of anything local (paths become `/path/to/scratch`, session ids stay): `opencode/hello.jsonl`, `opencode/bash-tool.jsonl`, `opencode/bash-denied.jsonl` (permission rule), `opencode/plugin-blocked.jsonl`, `opencode/edit.jsonl`, `opencode/mcp-tool.jsonl`, `opencode/model-missing.jsonl` (model not on the endpoint), `opencode/endpoint-down.jsonl` (Ollama on a port nothing listens on), `opencode/malformed-tool.jsonl` (if the probe produced one; else hand-written and marked); `openai/models-ollama.json`, `openai/show-ollama.json`, `openai/show-ollama-no-ctx.json`, `openai/models-lmstudio-v0.json`, `openai/chat-text.json`, `openai/chat-tool-call.json`, `openai/chat-tool-as-text.json`. `PROBE.md` lists each with the command that made it and the date.
- [ ] **Step 3: Write the failing test** `opencode-contract.test.ts`: every fixture line parses as JSON; every `type` in the `opencode/*.jsonl` fixtures is a value of `OPENCODE_EVENTS`; `bash-tool.jsonl` holds a `toolUse` event whose tool is `OPENCODE_TOOL_NAMES.bash`; `hello.jsonl` has a `stepFinish` event with numeric input and output tokens; `OPENCODE_BASE_TOKENS % 1000 === 0` and is at least the prompt tokens recorded in `hello.jsonl`; `OPENCODE_RUN_FLAGS` equals the list above.
- [ ] **Step 4: Run it to see it fail** (`cd packages/worker-backends && npx vitest run tests/opencode-contract.test.ts`; expected FAIL, module missing), **write `opencode-contract.ts`** from `PROBE.md`, and run it to see it pass.
- [ ] **Step 5: Report to the controller** any switch that does not exist on 2.1.4, any network access not stopped, and any event name that differs from the expected ones. Later tasks use the contract's names; a difference in a name changes no task, a missing switch is a ruling.
- [ ] **Step 6: Commit**

```bash
git add scripts/opencode-probe.sh packages/worker-backends/src/opencode-contract.ts packages/worker-backends/tests/fixtures packages/worker-backends/tests/opencode-contract.test.ts
git -c commit.gpgsign=false commit -m "test(worker-backends): OpenCode 2.1.4's flags, switches and events, recorded by a probe"
```

---

### Task 2: The shared names: model references, what counts as local, privacy classes, the chief-of-staff validator

**Files:**
- Create: `packages/types/src/local-models.ts`; Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/config.ts` (`WorkerBackendType`, `ProviderName`, `BackendConfig.localProviders`), `packages/types/src/orchestration.ts` (`ProjectConfig.privacy`, `local_models`, `models.provider`, `ContextConfig.sections.model`), `packages/types/src/os-protocol.ts` (`RunExitReason`, `HeartbeatBody.remoteTokens`, `AttachBody.privacy`), `packages/types/src/login-expired.ts` (`AgentRuntime` gains `"opencode"`)
- Modify: `packages/substrate/src/local-only.ts` (`isLoopbackHost` re-exported from `@mnmal-ai/swarm-types`; `packages/substrate/package.json` gains `"@mnmal-ai/swarm-types": "workspace:*"`, no cycle: types depends only on metrics)
- Test: `packages/types/tests/local-models.test.ts`

**Interfaces:**
- Produces (`packages/types/src/local-models.ts`):

```ts
export type PrivacyClass = "normal" | "local_only" | "local";
export type LocalProviderKind = "ollama" | "lmstudio" | "openai";
export interface LocalProviderConfig { base_url: string; kind?: LocalProviderKind }   // kind defaults from the name: "ollama", "lmstudio", else "openai"
export interface ResolvedProvider { name: string; baseUrl: string; kind: LocalProviderKind }
export interface LocalModelsConfig { providers?: Record<string, LocalProviderConfig>; trusted_hosts?: string[] }
export const DEFAULT_LOCAL_PROVIDERS: Readonly<Record<"ollama" | "lmstudio", ResolvedProvider>>;   // ollama http://127.0.0.1:11434/v1, lmstudio http://127.0.0.1:1234/v1
export function localProviders(cfg?: LocalModelsConfig): Record<string, ResolvedProvider>;      // the defaults, then cfg.providers over them by name; base URLs without a trailing "/"
export interface ModelRef { provider: string; model: string }
export function parseModelRef(ref: string): ModelRef | null;   // split at the first "/"; provider /^[a-z0-9][a-z0-9_-]{0,31}$/, model non-empty, no whitespace; else null
export type ModelTarget = { kind: "claude"; model: string } | { kind: "local"; provider: ResolvedProvider; model: string; ref: string };
export class LocalModelsConfigError extends Error {}
export function resolveModelTarget(model: string, cfg?: LocalModelsConfig): ModelTarget;
  // no "/": claude. "/" with a provider localProviders() knows: local. "/" otherwise: throws `<model> names provider "<p>", which local_models.providers does not define (known: ollama, lmstudio, …)`
export function isLoopbackHost(host: string): boolean;          // moved from packages/substrate, unchanged
export function isLocalEndpoint(url: string, trustedHosts?: readonly string[]): boolean;   // host loopback, or equal (case-insensitive, no port) to a trusted host; an unparseable URL is not local
export function validateLocalModelsConfig(value: unknown): string[];   // one message per problem: unknown keys, a base_url that is not http(s), a kind outside the three, a trusted host with a scheme, port or path
export function privacyClassOf(configs: readonly unknown[]): PrivacyClass;
  // over the swarm-dir config and every domain config: any top-level `privacy: "local"` → "local"; else any top-level object block with local_only: true → "local_only"; else "normal". Any other privacy value throws LocalModelsConfigError(`privacy must be "local" (got …)`).
export type CosTurnKind = "owner" | "readiness" | "follow_up";
export interface CosModelSettings { harness?: "agent-sdk" | "opencode"; model: string; readiness_model?: string }
export interface CosTurnLocality { kind: CosTurnKind; model: string; local: boolean; why: string }
export function cosTurnLocality(cos: CosModelSettings, localModels?: LocalModelsConfig): CosTurnLocality[];   // the validator; always three entries, in the order owner, readiness, follow_up
export function cosIsLocal(cos: CosModelSettings, localModels?: LocalModelsConfig): boolean;            // every entry local
```

- `cosTurnLocality` rules: `owner` uses `cos.model` and is local only when `harness` is `"opencode"` and the model resolves to a local target whose base URL `isLocalEndpoint`. `readiness` uses `readiness_model ?? model`, `follow_up` uses `model`; both are tool-less, so either is local when its model resolves local and its URL is local, whatever the harness. `why`: `local: <provider> at <baseUrl>`, `cos.harness is agent-sdk, which runs on Claude`, `<model> is a Claude model`, `<provider> at <baseUrl> is neither loopback nor in local_models.trusted_hosts`, or the resolve error's message.
- Other additions: `WorkerBackendType = "api" | "claude-code" | "codex" | "opencode"`; `ProviderName = "anthropic" | "openai" | "openai-compatible"`; `BackendConfig.localProviders?: Record<string, ResolvedProvider>` (what `swarm run` resolved from `local_models`, only for roles that use one); `ProjectConfig.privacy?: "local"`, `ProjectConfig.local_models?: LocalModelsConfig`, `ProjectConfig.models.provider?: "anthropic" | "openai" | "openai-compatible"`; `ContextConfig.sections.model?: string` (the synopsis writer's model, `DEFAULT_SYNOPSIS_MODEL` when absent); `RunExitReason` gains `"local_models_unacknowledged"`; `HeartbeatBody.remoteTokens?: number`; `AttachBody.privacy?: PrivacyClass`; `AgentRuntime` gains `"opencode"` (no login of its own; reserved so the login-stop code compiles with the union, never thrown by Task 8).

- [ ] **Step 1: Write the failing test**

```ts
describe("resolveModelTarget", () => {
  it("keeps a model without a provider on Claude", () => expect(resolveModelTarget("claude-haiku-4-5-20251001")).toEqual({ kind: "claude", model: "claude-haiku-4-5-20251001" }));
  it("resolves a default provider and a configured one", () => {
    expect(resolveModelTarget("ollama/gpt-oss:20b-64k")).toEqual({ kind: "local", model: "gpt-oss:20b-64k", ref: "ollama/gpt-oss:20b-64k", provider: { name: "ollama", baseUrl: "http://127.0.0.1:11434/v1", kind: "ollama" } });
    expect(resolveModelTarget("studio/qwen3:32b", { providers: { studio: { base_url: "http://studio.example:11434/v1/", kind: "ollama" } } }))
      .toMatchObject({ kind: "local", provider: { name: "studio", baseUrl: "http://studio.example:11434/v1", kind: "ollama" } });
  });
  it("refuses an unknown provider by name", () => expect(() => resolveModelTarget("nope/x")).toThrow('nope/x names provider "nope", which local_models.providers does not define (known: ollama, lmstudio)'));
});
describe("isLocalEndpoint", () => {
  it.each([["http://127.0.0.1:11434/v1", true], ["http://localhost:1234/v1", true], ["http://[::1]:11434", true], ["http://192.0.2.10:11434/v1", false], ["https://api.openai.com/v1", false], ["not a url", false]])("%s → %s", (u, l) => expect(isLocalEndpoint(u)).toBe(l));
  it("trusts a listed host, without its port", () => expect(isLocalEndpoint("http://Studio.example:11434/v1", ["studio.example"])).toBe(true));
});
describe("privacyClassOf", () => {
  it("ranks local over local_only over normal, across configs", () => {
    expect(privacyClassOf([{}, { substrate: { local_only: true } }])).toBe("local_only");
    expect(privacyClassOf([{ privacy: "local" }, {}])).toBe("local");
    expect(privacyClassOf([{}])).toBe("normal");
    expect(() => privacyClassOf([{ privacy: "private" }])).toThrow('privacy must be "local" (got "private")');
  });
});
describe("cosTurnLocality", () => {
  it("calls every turn remote on the Agent SDK with Claude models", () =>
    expect(cosTurnLocality({ model: "claude-sonnet-5-5" }).map((t) => [t.kind, t.local])).toEqual([["owner", false], ["readiness", false], ["follow_up", false]]));
  it("calls every turn local on OpenCode with a loopback model", () =>
    expect(cosIsLocal({ harness: "opencode", model: "ollama/gpt-oss:20b-64k" })).toBe(true));
  it("names the turn that is not local", () => {
    const t = cosTurnLocality({ harness: "opencode", model: "ollama/gpt-oss:20b-64k", readiness_model: "claude-haiku-4-5-20251001" });
    expect(t[1]).toEqual({ kind: "readiness", model: "claude-haiku-4-5-20251001", local: false, why: "claude-haiku-4-5-20251001 is a Claude model" });
  });
  it("treats a local readiness model under the Agent SDK as local for that turn only", () =>
    expect(cosTurnLocality({ model: "claude-sonnet-5-5", readiness_model: "ollama/gpt-oss:20b-64k" }).map((t) => t.local)).toEqual([false, true, false]));
});
it("validates local_models", () => expect(validateLocalModelsConfig({ providers: { x: { base_url: "ftp://h" } }, trusted_hosts: ["http://h:1"], extra: 1 })).toEqual([
  "local_models.extra is not a setting (settings: providers, trusted_hosts)",
  'local_models.providers.x.base_url must be an http or https URL (got "ftp://h")',
  'local_models.trusted_hosts[0] must be a host name or address without scheme, port or path (got "http://h:1")',
]));
```

- [ ] **Step 2: Run to see it fail.** `cd packages/types && npx vitest run tests/local-models.test.ts` → FAIL, module missing.
- [ ] **Step 3: Implement `local-models.ts` and the union and field additions**, export it from `index.ts`, move `isLoopbackHost` (substrate keeps its export name through the re-export, so its tests run unchanged), and build: `pnpm turbo build --filter=@mnmal-ai/swarm-types --filter=@mnmal-ai/swarm-substrate`.
- [ ] **Step 4: Run** `cd packages/types && npx vitest run`, `cd packages/substrate && npx vitest run`, then the CLI gate. Expected: PASS. A `switch` over `WorkerBackendType` that no longer compiles (`instantiate`) gets a `case "opencode":` that throws `the opencode backend is not built yet` until Task 8.
- [ ] **Step 5: Commit**

```bash
git add packages/types packages/substrate pnpm-lock.yaml packages/worker-backends/src/index.ts
git -c commit.gpgsign=false commit -m "feat(types): model references, what counts as local, privacy classes and the chief of staff's locality"
```

---

### Task 3: The OpenAI-compatible client, the scripted chat server and the fake endpoint

**Files:**
- Create: `packages/worker-backends/src/openai-compatible.ts`, `packages/worker-backends/src/scripted-chat.ts`
- Create: `packages/worker-backends/tests/fixtures/fake-openai.ts`
- Modify: `packages/worker-backends/src/index.ts` (exports)
- Test: `packages/worker-backends/tests/openai-compatible.test.ts`, `packages/worker-backends/tests/scripted-chat.test.ts`

**Interfaces:**
- Consumes: `ResolvedProvider` (Task 2); the `openai/*.json` fixtures (Task 1); `Metrics`, `noopMetrics`.
- Produces:

```ts
// openai-compatible.ts: fetch only, no SDK, never an Authorization header
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ChatToolCall[]; tool_call_id?: string }
export interface ChatToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatTool { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface ChatRequest { provider: ResolvedProvider; model: string; messages: ChatMessage[]; tools?: ChatTool[]; maxTokens?: number; timeoutMs: number; signal?: AbortSignal; fetchImpl?: typeof fetch; metrics?: Metrics; purpose: "label" | "synopsis" | "cos_readiness" | "cos_follow_up" | "check" | "api_worker" | "other" }
export interface ChatReply { text: string; toolCalls: ChatToolCall[]; usage: { input: number; output: number }; finishReason: string | null; latencyMs: number }
export type LocalEndpointErrorCode = "unreachable" | "timeout" | "http" | "malformed";
export class LocalEndpointError extends Error { constructor(readonly code: LocalEndpointErrorCode, readonly provider: string, readonly baseUrl: string, message: string) }
  // message: `<provider> at <baseUrl> <did not answer|took longer than <n> s|answered <status>: <first 200 chars of body>|answered with something that is not a chat completion>`
export function chatCompletion(req: ChatRequest): Promise<ChatReply>;   // POST <baseUrl>/chat/completions { model, messages, tools?, max_tokens?, temperature: 0, stream: false }
export function listModels(provider: ResolvedProvider, opts: { timeoutMs: number; fetchImpl?: typeof fetch }): Promise<string[]>;   // GET <baseUrl>/models → data[].id; lmstudio: GET <origin>/api/v0/models → data[].id (all downloaded models, loaded or not)
export interface ModelDetails { window: number | null; trainedWindow: number | null; source: "ollama_num_ctx" | "ollama_default" | "lmstudio_loaded" | "lmstudio_max" | "unknown" }
export function modelDetails(provider: ResolvedProvider, model: string, opts: { timeoutMs: number; fetchImpl?: typeof fetch }): Promise<ModelDetails>;
  // ollama: POST <origin>/api/show { model }: window = num_ctx from `parameters` (the "num_ctx <n>" line), else OLLAMA_DEFAULT_CONTEXT (source ollama_default); trainedWindow = model_info["<arch>.context_length"].
  // lmstudio: /api/v0/models entry: loaded_context_length when state is "loaded", else max_context_length (lmstudio_max). openai: { window: null, trainedWindow: null, source: "unknown" }.
  // <origin> is the base URL without its trailing "/v1".

// scripted-chat.ts: production code (Task 6's end-to-end guard test runs OpenCode against it) and the base of the test fake
export type ScriptedReply = { text: string } | { toolCall: { name: string; arguments: Record<string, unknown> } } | { status: number; body: string } | { hang: true };
export interface ScriptedChatServerOptions { script: ScriptedReply[] | ((request: { messages: ChatMessage[]; tools: ChatTool[]; model: string }, index: number) => ScriptedReply); models: string[]; host?: "127.0.0.1" }
export class ScriptedChatServer {
  constructor(opts: ScriptedChatServerOptions);
  start(): Promise<{ baseUrl: string }>;   // binds 127.0.0.1:0 only; baseUrl ends in "/v1"
  readonly requests: Array<{ path: string; body: unknown }>;
  stop(): Promise<void>;
}
// tests/fixtures/fake-openai.ts
export function fakeOllama(opts?: { models?: string[]; numCtx?: number | null; script?: ScriptedChatServerOptions["script"] }): Promise<{ provider: ResolvedProvider; server: ScriptedChatServer; stop(): Promise<void> }>;   // adds /api/show from the fixtures
export function fakeLmStudio(opts?: { models?: Array<{ id: string; state: "loaded" | "not-loaded"; loaded?: number; max: number }>; script?: ScriptedChatServerOptions["script"] }): Promise<{ provider: ResolvedProvider; server: ScriptedChatServer; stop(): Promise<void> }>;
```

- [ ] **Step 1: Write the failing tests** (`openai-compatible.test.ts`, on `fakeOllama`/`fakeLmStudio`):
  - `chatCompletion` returns `{ text: "hello", toolCalls: [], usage: { input: <fixture>, output: <fixture> } }` for `chat-text.json`, and one `toolCalls` entry with `function.name` and the raw `arguments` string for `chat-tool-call.json`; the request body has `temperature: 0`, `stream: false` and no `Authorization` header.
  - A port nothing listens on → `LocalEndpointError` code `unreachable`, message `ollama at http://127.0.0.1:<port>/v1 did not answer`; a `{ hang: true }` reply with `timeoutMs: 200` → code `timeout`, `took longer than 0.2 s`; a `{ status: 404, body: "model not found" }` → code `http`; a body `{"foo":1}` → `malformed`.
  - `listModels` returns the fixture's ids for Ollama and every downloaded model for LM Studio.
  - `modelDetails`: `numCtx: 65536` → `{ window: 65536, source: "ollama_num_ctx", trainedWindow: <fixture> }`; `numCtx: null` → `{ window: OLLAMA_DEFAULT_CONTEXT, source: "ollama_default" }`; LM Studio loaded at 8,192 of 32,768 → `{ window: 8192, source: "lmstudio_loaded", trainedWindow: 32768 }`; not loaded → `lmstudio_max`; kind `openai` → `unknown` without a request.
  - Metrics on a strict `testRegistry` (rows from Task 16, declared there; until then this test uses `noopMetrics` and Task 16 adds the assertions).
  - `scripted-chat.test.ts`: binds only `127.0.0.1`; replays a list in order and then answers 500 `script exhausted`; records every request.
- [ ] **Step 2: Run them to see them fail.** `cd packages/worker-backends && npx vitest run tests/openai-compatible.test.ts tests/scripted-chat.test.ts`
- [ ] **Step 3: Implement.** Timeouts through `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`; `fetch` failures with `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH` causes are `unreachable`. Response bodies are read with a 4 MiB cap.
- [ ] **Step 4: Run them to see them pass**, then `cd packages/worker-backends && npx vitest run`.
- [ ] **Step 5: Commit**

```bash
git add packages/worker-backends/src/openai-compatible.ts packages/worker-backends/src/scripted-chat.ts packages/worker-backends/src/index.ts packages/worker-backends/tests
git -c commit.gpgsign=false commit -m "feat(worker-backends): an OpenAI-compatible client for local endpoints, and a scripted loopback server"
```

---

### Task 4: Small calls on a local model, and `OpenAIProvider` with a base URL

**Files:**
- Modify: `packages/worker-backends/src/small-model.ts`, `label-writer.ts`, `synopsis-writer.ts`
- Modify: `packages/core/src/executor/index.ts` (`OpenAIProvider`, `createProvider`)
- Modify: `packages/cli/src/cli/goal-labels.ts`, `packages/cli/src/cli/context-sections.ts`, `packages/cli/src/cli/run.ts` (the label writer, the synopsis writer, the oversight providers and the API worker's provider)
- Modify: `packages/types/src/goal-label.ts` (`validateLabelsConfig` accepts `provider/model`)
- Test: `packages/worker-backends/tests/small-model-local.test.ts`, `packages/core/tests/openai-compatible-provider.test.ts`, `packages/cli/tests/small-call-targets.test.ts`

**Interfaces:**
- Consumes: `ModelTarget`, `resolveModelTarget` (Task 2); `chatCompletion` (Task 3).
- Produces:
  - `SmallModelOptions.target?: ModelTarget`. Absent or `kind: "claude"`: today's Agent SDK path, byte for byte. `kind: "local"`: one `chatCompletion` with a single user message, `maxTokens: 1024`, `purpose` from the new `SmallModelOptions.purpose?: "label" | "synopsis" | "other"` (default `"other"`), the same `timeoutMs` and `signal`.
  - `ClaudeLabelWriterOptions.target?` and `ClaudeSynopsisWriterOptions.target?`, passed through; `LabelWriter.model` is the reference as written (`ollama/gpt-oss:20b-64k`).
  - `OpenAIProvider` constructor `(apiKey: string, opts?: { baseURL?: string; name?: ProviderName })`; `new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })` in both methods; `name` defaults to `"openai"`.
  - `createProvider(provider: ProviderName, apiKey: string, opts?: { baseURL?: string })`: `"openai-compatible"` requires `baseURL` (throws `createProvider("openai-compatible") needs a baseURL`) and builds `new OpenAIProvider(apiKey || "local", { baseURL, name: "openai-compatible" })`; the `openai` SDK requires a non-empty key, and no real key is ever sent to a local endpoint because run.ts passes `""` for it.
  - In run.ts: with `models.provider: "openai-compatible"`, each role's model must be `provider/model` (refused at start otherwise: `models.<role> must be provider/model when models.provider is "openai-compatible" (got "<model>")`); the API worker and the reviewer and arbiter fallbacks get `createProvider("openai-compatible", "", { baseURL: target.provider.baseUrl })` and the bare model name. The "fails closed without key" paths (reviewer refuses, arbiter escalates) do not apply to a local provider, which needs no key.
  - `context.sections.model` names the synopsis model (`DEFAULT_SYNOPSIS_MODEL` when absent); `taskBackendConfig.labels.model` and `context.sections.model` both go through `resolveModelTarget(model, projectConfig.local_models)`.

- [ ] **Step 1: Write the failing tests**
  - `small-model-local.test.ts`: with `target` local on `fakeOllama({ script: [{ text: "AUTH-12" }] })`, `createClaudeLabelWriter({ model: "ollama/gpt-oss:20b-64k", target }).write({ title: "AUTH-12 fix login", source: "trello" })` resolves `"AUTH-12"`, the fake saw one request with `model: "gpt-oss:20b-64k"` and the injected `query` was never called; `createClaudeSynopsisWriter({ target })` parses a JSON array reply; a `LocalEndpointError` from the call rejects (the caller's fallback stays as it is); without `target` the injected `query` is called exactly as before (snapshot of its options from the existing `label-writer.test.ts`).
  - `openai-compatible-provider.test.ts` (the `openai` module mocked): `createProvider("openai-compatible", "", { baseURL: "http://127.0.0.1:11434/v1" })` constructs `OpenAI` with `{ apiKey: "local", baseURL: "http://127.0.0.1:11434/v1" }` and reports `name: "openai-compatible"`; without `baseURL` it throws the message above; `createProvider("openai", "k")` constructs `{ apiKey: "k" }` only.
  - `small-call-targets.test.ts`: the label and synopsis wiring helpers (`labelWriterFor(projectConfig)`, `synopsisWriterFor(projectConfig)`, exported from `goal-labels.ts` and `context-sections.ts`) pick a local target for `ollama/x`, Claude for a bare model, `DEFAULT_SYNOPSIS_MODEL` when `context.sections.model` is absent, and throw `LocalModelsConfigError` for `nope/x`. `validateLabelsConfig({ model: "ollama/gpt-oss:20b-64k" })` is `[]`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** In run.ts, replace the two writer constructions with `labelWriterFor` and `synopsisWriterFor`, and the provider construction for API roles and oversight fallbacks with one helper `apiProviderFor(projectConfig, role)` in `role-models.ts`.
- [ ] **Step 4: Run** the three tests, then `pnpm turbo build --filter=@mnmal-ai/swarm-cli^...` and every touched package's suite and the CLI suite. Expected: PASS, and `label-writer.test.ts` / `synopsis-writer.test.ts` unchanged.
- [ ] **Step 5: Commit**

```bash
git add packages/worker-backends packages/core packages/types/src/goal-label.ts packages/cli/src/cli packages/cli/tests/small-call-targets.test.ts
git -c commit.gpgsign=false commit -m "feat: goal labels, section synopses and the API loop on a local model"
```

---

### Task 5: The session directory, the inline configuration and the isolated environment

**Settled here (the design leaves it to the builder):** each session defines exactly one agent, `swarm-<role>`, in its own inline config, and is started with `--agent swarm-<role>`. A session's config is built for one role anyway, so per-session permissions and a per-role agent are the same thing; naming the agent after the role makes the role visible in OpenCode's own events and logs, and the built-in agents are disabled so none can be switched to.

**Files:**
- Create: `packages/worker-backends/src/opencode-config.ts`, `packages/worker-backends/src/agent-env.ts`
- Modify: `packages/worker-backends/src/codex.ts` (`sessionEnv` calls `isolatedSessionEnv`; behaviour unchanged)
- Test: `packages/worker-backends/tests/opencode-config.test.ts`, `packages/worker-backends/tests/codex-backend.test.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: `opencode-contract.ts` (Task 1); `ModelTarget`, `ResolvedProvider` (Task 2); `McpServerEntry`, `BackendConfig`, `gitIdentityEnvVars`, `withoutGitHubAccess`, `defaultWorkerGhConfigDir`.
- Produces:

```ts
// agent-env.ts (moved out of codex.ts)
export const AGENT_ENV_BASE: readonly string[];   // ["PATH", "HOME", "USER", "LANG", "SHELL", "TERM", "NODE_ENV"]
export function isolatedSessionEnv(config: Pick<BackendConfig, "gitIdentity" | "ghConfigDir">, extraAllowed?: readonly string[]): Record<string, string>;
  // the allowlisted variables that are set, the git identity, no GitHub access, GIT_CONFIG_PARAMETERS "'credential.helper=' 'core.sshCommand=false'", GIT_SSH_COMMAND "false", GIT_TERMINAL_PROMPT "0"
// opencode-config.ts
export function openCodeSessionsRoot(env?: NodeJS.ProcessEnv): string;   // SWARM_OPENCODE_SESSIONS_DIR || ~/.swarm/opencode-sessions
export interface OpenCodeSessionDir { root: string; configDir: string; xdg: { config: string; data: string; state: string; cache: string }; contextFile: string; guardSocket: string; remove(): void }
export function newOpenCodeSessionDir(env?: NodeJS.ProcessEnv): OpenCodeSessionDir;   // mkdtemp "s-" under the root (0700, root 0700 too); configDir and the four XDG dirs created empty; contextFile "context.md"; guardSocket "guard.sock"
export type OpenCodeRole = "worker" | "reviewer" | "arbiter" | "cos";   // "cos": plan 06 Task 14; its tools must be empty, so every built-in is denied and only its MCP server is offered
export interface OpenCodeConfigInput {
  role: OpenCodeRole; target: Extract<ModelTarget, { kind: "local" }>; contextWindow: number | null;
  tools: readonly string[];          // swarm's names: Read, Edit, Write, Bash, Glob, Grep, LS
  deniedTools: readonly string[];    // BackendConfig.permissions.deniedTools, Claude Code rule syntax
  worktree: string; contextFile: string; pluginUrl: string;
  mcpServers: Record<string, McpServerEntry>;   // configured servers plus the session's (swarm-room)
  mcpTimeoutMs?: number;             // plan 01 ruling O4's value when a wait tool is present
}
export function buildOpenCodeConfig(input: OpenCodeConfigInput): Record<string, unknown>;
export function openCodeEnv(config: Pick<BackendConfig, "gitIdentity" | "ghConfigDir">, dir: OpenCodeSessionDir, inlineConfig: Record<string, unknown>): Record<string, string>;
export const SWARM_TO_OPENCODE_TOOL: Readonly<Record<string, string>>;   // Read→OPENCODE_TOOL_NAMES.read, Edit→edit, Write→write, Bash→bash, Glob→glob, Grep→grep, LS→list
export function bashDenyPatterns(deniedTools: readonly string[]): string[];   // "Bash(git push *)" → "git push *"; "Bash" alone → "*"; other rules are left to the guard (Task 6)
```

- `buildOpenCodeConfig` writes, with the key names `PROBE.md` confirmed: `model` and `small_model` both the target's `ref`; `provider` with exactly the target's provider (`npm` as the probe recorded, `options.baseURL`, `models` holding exactly the target's model with `tools: true` and, when `contextWindow` is known, `limit.context`); `enabled_providers: [<provider>]`; `share: "disabled"`; `autoupdate: false`; `instructions: []`; `plugin: [pluginUrl]`; `mcp`: each server as `{ type: "local", command: [command, ...args], environment: env, enabled: true, ...(mcpTimeoutMs ? { timeout: mcpTimeoutMs } : {}) }`; `agent`: `swarm-<role>` (`mode: "primary"`, `model: ref`, `prompt: "{file:<contextFile>}"`, its `tools` map) and every built-in agent the probe listed with `disable: true`; `tools`: each tool in `OPENCODE_DENIED_TOOLS` and each built-in the role lacks as `false`; `permission`: `edit` `"allow"` when the role has Edit or Write else `"deny"`, `bash` `{ "*": <"allow" when Bash else "deny">, ...each bashDenyPatterns entry: "deny" }`, `webfetch: "deny"`, the outside-the-worktree key `"deny"`.
- `openCodeEnv`: `isolatedSessionEnv(config)`; then `OPENCODE_CONFIG_CONTENT` (the JSON), the config-dir variable → `dir.configDir`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` → `dir.xdg.*`, and every switch in `OPENCODE_ENV` other than those set to the value the probe found (`"1"` or `"true"`); `OPENCODE_MODELS_PATH` to a `models.json` in the session directory when the probe found it needed to keep the catalogue offline. Nothing from `process.env` beyond the allowlist.
- If the probe showed `{file:…}` substitution does not work in an agent prompt, the context instead leads the task on stdin, inside `<swarm-context>…</swarm-context>`, as codex's `placeContext` does when it is large; `contextFile` is then unused. Record which in the commit message.

- [ ] **Step 1: Write the failing test**
  - `newOpenCodeSessionDir` with `SWARM_OPENCODE_SESSIONS_DIR` set to a temp dir: the root and the session are mode `0700`, the five subdirectories exist and are empty, `remove()` deletes the session and leaves the root.
  - `buildOpenCodeConfig` for a worker on `ollama/gpt-oss:20b-64k` (window 65,536; tools Read, Edit, Write, Bash, Glob, Grep; denied `Bash(git push *)`, `Read(/path/to/os-home/**)`; one MCP server `swarm-room`): `provider` has one key, `ollama`, and its `models` one key; `enabled_providers` is `["ollama"]`; `small_model` equals `model`; `share` is `"disabled"`; `autoupdate` is `false`; `plugin` is `[pluginUrl]`; `permission.bash` is `{ "*": "allow", "git push *": "deny" }`; `permission.webfetch` is `"deny"`; every `OPENCODE_DENIED_TOOLS` entry is `false` under `tools`; the agent `swarm-worker` exists and no built-in agent is enabled; `mcp["swarm-room"]` is `{ type: "local", command: [...], environment: {...}, enabled: true }`.
  - A reviewer (tools Read, Bash, Glob, Grep) gets `permission.edit: "deny"` and `edit`/`write` `false` under `tools`.
  - `openCodeEnv` with `process.env` holding `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and `XDG_CONFIG_HOME=/path/to/home/.config`: none of the secrets is present; `XDG_CONFIG_HOME` is the session's; `GH_CONFIG_DIR` is the empty per-run dir; `GIT_SSH_COMMAND` is `"false"`; `OPENCODE_CONFIG_CONTENT` parses to the input config.
  - `isolatedSessionEnv` with `extraAllowed: ["CODEX_HOME"]` equals what `CodexBackend.sessionEnv()` returned before the move (the existing codex tests pin it).
- [ ] **Step 2: Run it to see it fail.** `cd packages/worker-backends && npx vitest run tests/opencode-config.test.ts`
- [ ] **Step 3: Implement**, moving codex's env code into `agent-env.ts` (codex passes `["CODEX_HOME"]`).
- [ ] **Step 4: Run** `cd packages/worker-backends && npx vitest run`. Expected: PASS, codex suites unchanged.
- [ ] **Step 5: Commit**

```bash
git add packages/worker-backends/src/opencode-config.ts packages/worker-backends/src/agent-env.ts packages/worker-backends/src/codex.ts packages/worker-backends/tests/opencode-config.test.ts
git -c commit.gpgsign=false commit -m "feat(worker-backends): an OpenCode session's private directory, inline config and environment"
```

---

### Task 6: The guard: the plugin, the guard server, and the self-tests that fail closed

**Settled here:** the plugin holds no policy. It is a short file that sends every tool call to a guard server in swarm's own process over a Unix socket in the session directory, and acts on the answer. The policy (`matchDenied`, the doc guard, path rules, fnl) therefore runs as the same code claude-code and codex sessions use, keeps per-session state (document reads, fnl coverage) in swarm's memory where the agent cannot forge it, and needs no `swarm` subprocess per call. The plugin file is written once per content hash to `~/.swarm/opencode/plugin/swarm-guard-<sha256 first 12>.js` (dir `0700`, file `0400`; `SWARM_OPENCODE_PLUGIN_DIR` overrides it in tests), because a Bun-compiled swarm has no plugin file on disk for OpenCode to load; its hash is checked before every session and a file that does not match is rewritten.

**Files:**
- Create: `packages/worker-backends/src/opencode-guard-plugin.ts`, `packages/worker-backends/src/opencode-guard.ts`, `packages/worker-backends/src/path-rules.ts`
- Test: `packages/worker-backends/tests/opencode-guard.test.ts`, `packages/worker-backends/tests/path-rules.test.ts`, `packages/worker-backends/tests/opencode-guard-plugin.test.ts`

**Interfaces:**
- Consumes: `matchDenied`, `decideDocumentRead`, `DocumentReadCounter`, `runFnl`, `bashDenyRules`, `FnlCoverageCounter`, `selfTestProbes` (existing); `OPENCODE_TOOL_NAMES`, `OPENCODE_PLUGIN_HOOKS` (Task 1); `SessionMcp` (plan 01 Task 6).
- Produces:

```ts
// path-rules.ts
export function pathRuleDenied(tool: "Read" | "Edit" | "Write", absolutePath: string, deniedTools: readonly string[], cwd: string): DenyMatch;
  // rules Read(<glob>), Edit(<glob>), Write(<glob>); an Edit rule also covers Write; a glob starting "/" is absolute, "~/" is the home directory, anything else relative to cwd; matched with path.matchesGlob on the realpath (the path's nearest existing parent's realpath for a new file)
// opencode-guard-plugin.ts
export const GUARD_PLUGIN_SOURCE: string;     // ESM; exports a plugin whose OPENCODE_PLUGIN_HOOKS.before/after POST to $SWARM_OPENCODE_GUARD_SOCKET; throws `swarm guard: <reason>` on deny, on a 20 s timeout and on any unreadable answer
export function ensureGuardPlugin(env?: NodeJS.ProcessEnv): { path: string; url: string; sha256: string };
// opencode-guard.ts
export const GUARD_TIMEOUT_MS = 20_000;
export const GUARD_HANDSHAKE_MS = 15_000;
export interface GuardPolicy {
  cwd: string; deniedTools: readonly string[]; tools: readonly string[];
  mcpServers: readonly string[];                         // the configured and session servers whose tools are offered; any other MCP tool is denied
  documents?: WorkerTaskInput["documents"];              // the doc guard runs when present
  fnl?: FnlBackendConfig;                                // the rewrite runs for bash when present
  waitTools?: readonly string[];                         // OpenCode ids of SessionMcp.waitTools (the probe's MCP id form)
  onWait?: (callId: string, waiting: boolean) => void;
  selfTestMarker: string;                                // a nonce; any bash command containing it is denied
}
export type GuardAnswer = { action: "allow" } | { action: "deny"; reason: string } | { action: "rewrite"; args: Record<string, unknown> };
export interface GuardRecord { tool: string; answer: GuardAnswer["action"]; rule?: string; ms: number }
export class GuardServer {
  constructor(socketPath: string, policy: GuardPolicy, opts?: { metrics?: Metrics; metricsParent?: Span | string | null });
  start(): Promise<void>;                                // listens on the socket, mode 0600
  decide(call: { tool: string; callId: string; args: Record<string, unknown> }): Promise<GuardAnswer>;   // also what POST /before answers
  handshake(): Promise<void>;                            // resolves when the plugin said hello with the expected sha256 and its self-test passed; rejects OpenCodeGuardError after GUARD_HANDSHAKE_MS
  readonly records: readonly GuardRecord[];
  readonly fnlCoverage: FnlCoverage | undefined;
  stop(): Promise<void>;                                 // closes waits still open (onWait(id, false)) and the socket
}
export class OpenCodeGuardError extends Error {}
export function guardEndToEnd(opts: { opencode: string; cwd: string; env: Record<string, string>; dir: OpenCodeSessionDir; build: (target: Extract<ModelTarget, { kind: "local" }>) => Record<string, unknown> }): Promise<void>;
```

- **`decide`**, in order: a bash command containing `selfTestMarker` → deny `swarm guard self-test`; the call translated to Claude's names (`bash` → `Bash { command }`, `read` → `Read { file_path }`, `edit`/`write`/`patch` → `Edit`/`Write { file_path }`, `glob`/`grep`/`list` → `Glob`/`Grep`/`LS { path }`, an MCP tool → `mcp__<server>__<tool>`), then `matchDenied(name, input, deniedTools)`; for Read, Edit, Write, Glob, Grep and LS, a path outside `cwd` (after realpath) → deny `outside the worktree`, then `pathRuleDenied` (this enforces plan 01 ruling O1's `Read/Edit/Write(<osHome>/**)` rules); with `documents`, `decideDocumentRead` for Read and Bash (its deny reason and outline go back as the reason); with `fnl` and Bash, `runFnl` and a `rewrite` with the new command. Anything that throws → deny `swarm could not check this call, so it is denied`. A tool not in the role's `tools` and not an MCP tool of the session → deny.
- **Waits:** `POST /before` for a tool in `waitTools` calls `onWait(callId, true)` after allowing it; `POST /after` with the same id calls `onWait(callId, false)`.
- **Plugin self-test (every session):** on load the plugin posts `/hello { sha256 }`, then runs its own before-handler on the probes `selfTestProbes(policy)` gives plus the marker command, and posts `/selftest { results: [{ command, threw }] }`. `handshake()` resolves only when the hash matches `ensureGuardPlugin()`'s and every probe expected to be denied threw and every one expected to be allowed did not.
- **End-to-end self-test (once per run, from `OpenCodeBackend.preflight`, Task 8):** `guardEndToEnd` starts a `ScriptedChatServer` whose first reply is a tool call `bash { command: "touch <dir>/marker-<nonce> # <selfTestMarker>" }` and second is `{ text: "done" }`, runs one real OpenCode session against it with the guard, and passes only when the guard recorded a deny for that call and `<dir>/marker-<nonce>` does not exist afterwards. This proves the hook fires on a real tool dispatch, not only that the plugin loaded.

- [ ] **Step 1: Write the failing tests**
  - `path-rules.test.ts`: `Read(/path/to/os-home/**)` denies `Read` of `/path/to/os-home/host.secret` and allows `/path/to/project/a.ts`; `Edit(.github/**)` relative to cwd denies `Write` of `<cwd>/.github/workflows/x.yml`; a symlink inside cwd pointing into the denied tree is denied (realpath).
  - `opencode-guard.test.ts` (a real `GuardServer` on a temp socket, requests over `http.request({ socketPath })`):
    - `bash { command: "git push origin main" }` with `Bash(git push *)` → `{ action: "deny" }` whose reason contains no command text; `bash { command: "ls" }` → allow.
    - `read { filePath: "/path/to/os-home/os.json" }` with the O1 rules → deny; `edit` of a file outside cwd → deny `outside the worktree`.
    - `webfetch` (not in the role's tools) → deny.
    - With `documents` and a guarded document, a whole-document read beyond `maxReadTokens` → deny with the outline, as `documentGuardPreToolUse` would for claude-code (same fixture as `claude-code-doc-guard.test.ts`).
    - With `fnl` (the fake fnl the fnl tests use) → `{ action: "rewrite", args: { command: <wrapped> } }`.
    - A wait tool's before and after call `onWait("c1", true)` then `("c1", false)`; `stop()` closes a wait left open.
    - A `decide` whose policy check throws → deny.
    - `handshake()` rejects with `OpenCodeGuardError` after `GUARD_HANDSHAKE_MS` (fake timers) when no hello arrives, and when the hello's hash differs, and when one expected-deny probe did not throw.
  - `opencode-guard-plugin.test.ts`: import `GUARD_PLUGIN_SOURCE` from a temp file in node (it must not depend on Bun), point it at a guard server, and check its before-hook throws `swarm guard: …` on deny, mutates `output.args` on rewrite, throws after `GUARD_TIMEOUT_MS` when the server never answers, and throws when the socket does not exist; `ensureGuardPlugin` writes mode `0400`, returns the same path twice, and rewrites a file whose content was changed.
- [ ] **Step 2: Run them to see them fail.** `cd packages/worker-backends && npx vitest run tests/path-rules.test.ts tests/opencode-guard.test.ts tests/opencode-guard-plugin.test.ts`
- [ ] **Step 3: Implement.** The plugin source is plain JavaScript, uses `node:http` with `socketPath` (Bun supports it), reads the socket path from `process.env.SWARM_OPENCODE_GUARD_SOCKET`, and has no imports beyond node builtins. `guardEndToEnd` is not unit-tested with a live OpenCode; Task 8 tests it against a fake `opencode` script, and Task 17 runs it for real.
- [ ] **Step 4: Run them to see them pass**, then `cd packages/worker-backends && npx vitest run`.
- [ ] **Step 5: Commit**

```bash
git add packages/worker-backends/src/opencode-guard-plugin.ts packages/worker-backends/src/opencode-guard.ts packages/worker-backends/src/path-rules.ts packages/worker-backends/tests
git -c commit.gpgsign=false commit -m "feat(worker-backends): swarm's guard for OpenCode sessions, failing closed"
```

---

### Task 7: OpenCode's events as swarm's progress, tokens, files and model report

**Files:**
- Create: `packages/worker-backends/src/opencode-events.ts`
- Test: `packages/worker-backends/tests/opencode-events.test.ts`

**Interfaces:**
- Consumes: `OPENCODE_EVENTS`, `OPENCODE_TOOL_NAMES` (Task 1); the `opencode/*.jsonl` fixtures; `ProgressEvent`, `ModelReport`, `TokenUsage`; `CodexEventCollector` as the shape to follow.
- Produces:

```ts
export class OpenCodeEventCollector {
  constructor(cwd: string, onProgress?: (e: ProgressEvent) => void, opts?: { metrics?: Metrics; clock?: () => number });
  push(line: string): void;              // one stdout line; a line that is not JSON is ignored after one status_change "OpenCode wrote a line swarm could not read"
  finish(): void;                        // closes open tool calls (outcome "cancelled")
  readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };   // summed over step-finish events; reasoning tokens count as output
  readonly responses: number;            // step-finish events
  readonly lastMessage: string;          // the last text part's text
  readonly filesChanged: string[];       // relative to cwd, from completed edit/write/patch tools, de-duplicated, in order
  readonly failure: string | undefined;  // an error event's message (the first), redacted
  readonly sessionModel: string | undefined;   // the model the events name, when they name one
  readonly firstMessageMs: number | undefined;
  modelReport(requested: string): ModelReport;   // { requested, sessionModel?, responses: { <served>: n }, usage: { <served>: { input, output } } }
}
```

Mapping (event names from `OPENCODE_EVENTS`; each `ProgressEvent` has the shape `claude-code.ts`'s `toProgressEvent` and `codex-events.ts` emit, so the tool-wedge watcher, the dashboard and the session ledger need no change):

| OpenCode event | ProgressEvent |
|---|---|
| first event carrying a `sessionID` | `session_init`, `meta { sessionId, backend: "opencode" }` |
| `toolUse` with a running or pending state | `tool_call`, `meta { tools: [name], count: 1, inputs: [redacted input], toolUseIds: [callID] }` |
| `toolUse` completed or errored | `tool_summary`, `meta { tool, toolUseId, isError }`; an edit/write/patch adds its path to `filesChanged` |
| `text` | `model_response` with the text (first 2,000 characters as `detail`) |
| `stepFinish` | no event; adds tokens and one response |
| `error` | `status_change`, `meta { status: "error" }`; sets `failure` |
| a tool blocked by the guard or a permission rule | `tool_summary` with `isError: true` and `meta.blocked: "guard" \| "permission"` |

- [ ] **Step 1: Write the failing test**: each fixture replayed line by line. `hello.jsonl` gives `session_init` then `model_response`, `tokens` equal to the fixture's sums, `responses` its step count. `bash-tool.jsonl` gives `tool_call` then `tool_summary` with `toolUseIds` matching. `edit.jsonl` gives `filesChanged` holding the edited path relative to cwd. `plugin-blocked.jsonl` gives `meta.blocked: "guard"`, `bash-denied.jsonl` `meta.blocked: "permission"`. `endpoint-down.jsonl` and `model-missing.jsonl` set `failure` with the provider's message. `malformed-tool.jsonl` ends with no exception and a `status_change`. A non-JSON line emits one `status_change` and is otherwise ignored; a second one emits nothing more. `finish()` with a tool still running emits its `tool_summary` with `isError: true`. `modelReport("ollama/gpt-oss:20b-64k")` names the served model and the token sums. `swarm_agent_tool_seconds` is recorded at each tool's end with `outcome` `ok`, `error` or `cancelled` (strict `testRegistry` from Task 16's rows; until Task 16, `noopMetrics`).
- [ ] **Step 2: Run it to see it fail.** `cd packages/worker-backends && npx vitest run tests/opencode-events.test.ts`
- [ ] **Step 3: Implement.** Redact tool inputs with `redactSecrets` (`codex-redact.ts`), cut each to 2,000 characters.
- [ ] **Step 4: Run it to see it pass.**
- [ ] **Step 5: Commit**

```bash
git add packages/worker-backends/src/opencode-events.ts packages/worker-backends/tests/opencode-events.test.ts
git -c commit.gpgsign=false commit -m "feat(worker-backends): OpenCode's JSON events as swarm's progress, tokens and files"
```

---

### Task 8: `OpenCodeBackend`, and its place beside the other backends

**Files:**
- Create: `packages/worker-backends/src/opencode.ts`, `packages/worker-backends/src/agent-process.ts` (codex's process-group runner, moved: `runAgentProcess`, `trackGroup`, `killGroup`)
- Modify: `packages/worker-backends/src/codex.ts` (uses `runAgentProcess`), `packages/worker-backends/src/index.ts` (`instantiate`, `carriedToFallback`, `resolveWorkerBackend`'s MCP warning, `detectAvailableBackends`, exports)
- Create: `packages/worker-backends/tests/fixtures/fake-opencode.mjs`
- Test: `packages/worker-backends/tests/opencode-backend.test.ts`, `packages/worker-backends/tests/worker-backend.test.ts` (extended)

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 5, 6, 7; `startSuspendableTimer`, `BackendConfig.timersSuspended`, `BackendConfig.sessionMcp`, `SessionMcp` (plan 01 Tasks 5 and 6); `guardGitConfig` (`codex-git-guard.ts`); `FNL_INSTRUCTION`.
- Produces:

```ts
export const OPENCODE_DEFAULT_PATHS: readonly string[];   // ["~/.opencode/bin/opencode"], tried after PATH
export function findOpenCode(binaryPath?: string, env?: NodeJS.ProcessEnv): string | null;   // binaryPath when executable; else `which opencode`; else each default path, "~" expanded
export class OpenCodeVersionError extends Error {}
export function openCodeVersion(bin: string): Promise<string>;   // parses `opencode --version` as Task 1 recorded it
export function checkOpenCode(bin: string): Promise<{ version: string; warning: string | null }>;   // older than OPENCODE_MIN_VERSION, or any OPENCODE_RUN_FLAGS entry missing from `run --help`: OpenCodeVersionError naming the version and the missing flag; newer than OPENCODE_TESTED_VERSION: warning `opencode <v> is newer than the tested 2.1.4`
export interface OpenCodeSessionRun { bin: string; cwd: string; args: string[]; env: Record<string, string>; stdin: string; guard: GuardServer; timeoutMs: number; timersSuspended?: () => boolean; onLine: (line: string) => void }
export function runOpenCodeSession(run: OpenCodeSessionRun): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }>;
  // spawn in its own process group, wait for guard.handshake() before writing stdin (killing the group and rethrowing on failure), the timeout as below; OpenCodeBackend and plan 06 Task 14's OpenCodeFacade both use it
export class OpenCodeBackend implements IWorkerBackend {
  readonly type: "opencode"; readonly supportsDirectExecution: true; readonly model: string | undefined;
  constructor(config: BackendConfig);   // config.model must be provider/model with a provider in config.localProviders, else throws `the opencode backend needs a model as provider/model naming a provider in local_models.providers (got "<model>")`
  isAvailable(): Promise<boolean>;      // findOpenCode() !== null
  preflight(cwd: string): Promise<{ version: string; warning: string | null }>;   // checkOpenCode, ensureGuardPlugin, then guardEndToEnd once
  execute(input: WorkerTaskInput): Promise<WorkerTaskOutput>;
}
```

`execute`, in order: resolve the binary (missing → `opencode is not installed (no opencode on PATH or in ~/.opencode/bin)`); a new session directory; `await config.sessionMcp?.()` before any timer is armed (plan 01 ruling C18), its server names validated as claude-code's are; the swarm context (plus `FNL_INSTRUCTION` when fnl applies, plus the session's MCP instructions) written to `contextFile`; `ensureGuardPlugin()`; a `GuardServer` on the session's socket with the role's policy (`waitTools` mapped to OpenCode's MCP tool ids, `onWait` from the session); `buildOpenCodeConfig` with `mcpTimeoutMs` from plan 01 ruling O4 when the session has wait tools; `openCodeEnv` plus `SWARM_OPENCODE_GUARD_SOCKET`; `guardGitConfig(cwd)`; spawn `opencode run --standalone --format json --model <ref> --auto --agent swarm-<role>` in `cwd` in its own process group with stdin left open; `await guard.handshake()` (failure: kill the group, throw `OpenCodeGuardError("the swarm guard did not load in the OpenCode session, so it was stopped before its task: <why>")`); then write the task and end stdin; the timeout through `startSuspendableTimer` when `timersSuspended` is set, else one `setTimeout`, message `opencode timed out after <n> seconds.`; on exit, the collector's result; the git guard's restore (a change fails the session as codex's does, same message with `opencode`); in `finally`, `guard.stop()` and the session directory removed. The role is `input.role` when the orchestrator sets it, else inferred as today's backends do (`worker` unless the backend's tools lack Edit and Write, then `reviewer`).

Failure mapping: a collector `failure` or a non-zero exit whose text names the endpoint (connection refused, the provider's base URL) → `LocalEndpointError` code `unreachable`; a model the endpoint does not list → `Error("<ref> is not on <provider> at <baseUrl>: ollama pull <model> (or create it from its Modelfile)")` (LM Studio: `download and load <model> in LM Studio`); anything else `opencode run failed: <first five lines, redacted>`. No OpenCode failure is a `LoginExpiredError` or a `RateLimitError`, and none triggers the fallback (only `isAvailable` does, as for the other backends).

Output: `{ output: collector.lastMessage, latencyMs, tokensUsed: collector.tokens, filesChanged, exitCode, backendUsed: "opencode", modelReport: collector.modelReport(ref), firstMessageMs, fnlCoverage? }`.

Registry: `instantiate` builds it; `detectAvailableBackends` tries `"opencode"` last; `carriedToFallback` carries `permissions` and `localProviders` to an opencode fallback, as it carries `permissions` to codex; `resolveWorkerBackend` does not warn about MCP servers for `opencode`.

- [ ] **Step 1: Write the failing tests.** `fake-opencode.mjs` answers `--version` with the probe's line (or the version in `FAKE_OPENCODE_VERSION`), `run --help` with the probe's help text (minus a flag named in `FAKE_OPENCODE_DROP_FLAG`), and `run …`: it parses `OPENCODE_CONFIG_CONTENT`, imports the plugin file its `plugin` entry names and calls it as OpenCode does (so the hello and self-test happen), waits for stdin EOF, records argv, env and stdin to `FAKE_OPENCODE_RECORD`, then replays the fixture named by `FAKE_OPENCODE_FIXTURE`, calling the plugin's before-hook for each tool call and turning a throw into the blocked event. `opencode-backend.test.ts`:
  - `executes a session: argv, cwd, env, stdin after the handshake` — argv is `run --standalone --format json --model ollama/gpt-oss:20b-64k --auto --agent swarm-worker`; cwd is the worktree; the recorded env has no `ANTHROPIC_API_KEY`, `GH_TOKEN` or the caller's `XDG_CONFIG_HOME`; stdin is the task; output and tokens come from `hello.jsonl`; `backendUsed: "opencode"`.
  - `ignores the work repo's opencode.json and .opencode` — with both planted in the worktree, the recorded `OPENCODE_CONFIG_CONTENT` and env are identical to a run without them, and the project switch is set.
  - `stops before the task when the guard does not load` — with `FAKE_OPENCODE_SKIP_PLUGIN=1`, `execute` rejects with `OpenCodeGuardError`, the fake's record shows stdin empty, and the process group is gone.
  - `blocks a denied call through the plugin` — `bash-tool.jsonl` rewritten to call `git push origin main` with `Bash(git push *)` denied: the result's progress has `meta.blocked: "guard"`.
  - `gives the session its room tools and keeps the timeout suspended while a question waits` — with `sessionMcp` returning `swarm-room` and `waitTools: ["mcp__swarm-room__ask_human"]`, the config's `mcp` has `swarm-room` with the O4 timeout; with `timeout: 10` and `timersSuspended` true for 60 s (fake timers), the session is not aborted; then it times out 10 s after the gate closes with `opencode timed out after 10 seconds.`
  - `fails a session that changed git hooks` — the fake writes `.git/hooks/pre-commit`; `execute` rejects naming `hooks/pre-commit`, and the hook file is restored.
  - `fails a session whose endpoint stops answering with the provider's name` — `endpoint-down.jsonl` → `LocalEndpointError` whose message names `ollama` and the base URL.
  - `names the pull step for a missing model` — `model-missing.jsonl` → the `ollama pull` message.
  - `removes the session directory on every path` — after success and after each failure above, `SWARM_OPENCODE_SESSIONS_DIR` is empty.
  - `refuses an older OpenCode and one missing a flag` — `FAKE_OPENCODE_VERSION=2.1.3` and `FAKE_OPENCODE_DROP_FLAG=--standalone`: `preflight` rejects with `OpenCodeVersionError` naming each; `2.2.0` passes with the warning.
  - `finds OpenCode in ~/.opencode/bin when it is not on PATH` — `findOpenCode(undefined, { PATH: "/usr/bin", HOME: <temp> })` with `<temp>/.opencode/bin/opencode` executable.
  - `preflight's end-to-end self-test refuses a session whose tool ran` — the fake ignores the plugin's throw for the marker command and runs it: `preflight` rejects with `OpenCodeGuardError`.
  - `worker-backend.test.ts`: `instantiate({ type: "opencode", model: "ollama/x", localProviders })` is an `OpenCodeBackend`; `fallbackBackendConfig({ type: "claude-code", fallback: "opencode", permissions, localProviders })` carries both.
- [ ] **Step 2: Run them to see them fail.** `cd packages/worker-backends && npx vitest run tests/opencode-backend.test.ts tests/worker-backend.test.ts`
- [ ] **Step 3: Implement**, moving codex's runner into `agent-process.ts` unchanged first (the codex suites must stay green on that commit's tree).
- [ ] **Step 4: Run** `cd packages/worker-backends && npx vitest run`, then `pnpm turbo build --filter=@mnmal-ai/swarm-cli^...` and the CLI suite.
- [ ] **Step 5: Commit**

```bash
git add packages/worker-backends
git -c commit.gpgsign=false commit -m "feat(worker-backends): the opencode backend, isolated and guarded, with room tools and a suspendable timeout"
```

---

### Task 9: `swarm run` with OpenCode roles

**Files:**
- Modify: `packages/cli/src/cli/role-models.ts` (`roleBackendConfigs`), `packages/cli/src/cli/run.ts` (the credential preflight, the backend preflights, the banner), `packages/cli/src/external-deps.ts` (an `opencode` entry)
- Create: `packages/cli/src/cli/opencode-preflight.ts`
- Test: `packages/cli/tests/role-models-opencode.test.ts`, `packages/cli/tests/opencode-preflight.test.ts`

**Interfaces:**
- Consumes: `OpenCodeBackend`, `checkOpenCode` (Task 8); `localProviders`, `resolveModelTarget` (Task 2); plan 01's `withOsRoles` (every role already gets `sessionMcp` and `timersSuspended`; the OpenCode backend is the first non-claude-code backend to honour both) and ruling O1's OS-home rules.
- Produces:
  - `roleBackendConfigs(projectConfig, run)` — `projectConfig` now also picks `local_models`, `run` gains `osHome?: string`. A role whose backend or fallback is `opencode` gets the role's built-in tools (as claude-code and codex roles do), fnl as for claude-code, `localProviders: localProviders(projectConfig.local_models)`, and, when `run.osHome` is set, `Read(<osHome>/**)`, `Edit(<osHome>/**)` and `Write(<osHome>/**)` appended to `permissions.deniedTools` (ruling O1, which the guard enforces through `pathRuleDenied`). A role on any other backend gets exactly what it gets today.
  - `preflightOpenCodeRoles(configs: Record<AgentRole, BackendConfig>, cwd: string, deps?: { backend?: (c: BackendConfig) => Pick<OpenCodeBackend, "preflight"> }): Promise<{ lines: string[]; warnings: string[] }>` in `opencode-preflight.ts`: for the roles on `opencode` (primary or fallback), one `preflight(cwd)` per distinct binary (so the end-to-end guard test runs once per run); a rejection stops the run with `[swarm] <role>: <message>` and exit 1, before any goal, like `codex-preflight.ts`.
  - The credential preflight skips Claude and API-key checks for a role on `opencode` with no Claude fallback, and the banner's Credentials block shows `OpenCode    <version> ✓ <provider>/<model> (<role>, …)` for those roles.
  - `external-deps.ts`: `{ command: "opencode", versionArgs: ["--version"], tested major: 2, behaviours: the flags in OPENCODE_RUN_FLAGS, the switches in OPENCODE_ENV }`, warned on like gh when the installed major differs.

- [ ] **Step 1: Write the failing tests**
  - `role-models-opencode.test.ts`: a project with `backends.worker: { type: "opencode", model: "ollama/gpt-oss:20b-64k" }` and `run.osHome: "/path/to/os-home"` gives the worker `tools` equal to `DEFAULT_WORKER_TOOLS`, `localProviders.ollama.baseUrl` `http://127.0.0.1:11434/v1`, and the three O1 rules in `permissions.deniedTools`; a claude-code reviewer in the same project is byte-identical to `roleBackendConfigs` before this task (snapshot the existing test's expected object); a project with no `opencode` role yields exactly today's result (deep equal with the pre-change fixture).
  - `opencode-preflight.test.ts`: two roles on the same binary run one `preflight`; a rejection yields the `[swarm] reviewer: …` line; no opencode role → no call and no line.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement**, calling `preflightOpenCodeRoles` in run.ts next to the codex preflight, behind `anyRoleUses(configs, "opencode")`.
- [ ] **Step 4: Run** the two tests and the CLI suite.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/role-models.ts packages/cli/src/cli/opencode-preflight.ts packages/cli/src/cli/run.ts packages/cli/src/external-deps.ts packages/cli/tests
git -c commit.gpgsign=false commit -m "feat(cli): run roles on OpenCode, with the OS-home rule and a preflight"
```

---

### Task 10: The check before work

**Settled here (the design leaves the weighting to the builder):** a role's estimate assumes it pulls documents, because a warning that comes true costs a failed task and a warning that does not costs one acknowledgement. The numbers below are fixed per role and live in one table, so they can be tuned without touching the check.

**Files:**
- Create: `packages/cli/src/cli/local-models-check.ts`
- Modify: `packages/cli/src/cli/run.ts` (run the check once, before any goal; log and record the per-goal estimate)
- Test: `packages/cli/tests/local-models-check.test.ts`

**Interfaces:**
- Consumes: `listModels`, `modelDetails`, `chatCompletion`, `LocalEndpointError` (Task 3); `fakeOllama`, `fakeLmStudio` (Task 3's fixture, imported from the worker-backends test fixtures through a relative path, as the CLI tests already import shared fixtures); `OPENCODE_BASE_TOKENS` (Task 1); `ModelTarget` (Task 2); the swarm manifest's `context_budget`; `ContextConfig.pull`.
- Produces:

```ts
export const CHECK_LIMITS_MS: { endpoint: 5_000; list: 5_000; details: 10_000; toolRoundTrip: 180_000 };   // the round trip includes loading the model
export const LOAD_TABLE: {
  typicalCardTokens: 2_000; reviewPromptTokens: 4_000; typicalDiffTokens: 8_000; apiToolsTokens: 1_000; pullReads: 3;
  margin: { worker: 0.5; reviewer: 0.25; arbiter: 0.25; small: 0.1 };
  smallFixed: 500; smallPayload: { label: 200; synopsis: 6_000 };
};
export type LocalUse =
  | { kind: "role"; role: "worker" | "reviewer" | "arbiter"; target: Extract<ModelTarget, { kind: "local" }>; via: "opencode" | "api" }
  | { kind: "small"; purpose: "label" | "synopsis"; target: Extract<ModelTarget, { kind: "local" }> };
export interface RoleLoad { fixed: number; estimate: number }
export function roleLoad(use: LocalUse, ctx: { contextBudget: number; pull?: ContextConfig["pull"]; cardTokens?: number }): RoleLoad;
  // role: fixed = (via opencode ? OPENCODE_BASE_TOKENS : apiToolsTokens) + (worker ? contextBudget : reviewPromptTokens);
  //       estimate = ceil((fixed + (cardTokens ?? typicalCardTokens) + (pull?.enabled ? pullReads × (pull.maxReadTokens ?? 4000) : 0) + (worker ? 0 : typicalDiffTokens)) × (1 + margin[role]))
  // small: fixed = smallFixed; estimate = ceil((smallFixed + smallPayload[purpose]) × 1.1)
export function planLocalModels(input: { roles: Record<"worker" | "reviewer" | "arbiter", BackendConfig>; project: ProjectConfig; labels?: ModelTarget; synopsis?: ModelTarget }): LocalUse[];   // roles on opencode, roles on the API loop with openai-compatible, and local small calls; empty for a project with none
export type FindingCode = "endpoint_down" | "model_missing" | "window_below_system" | "tool_call_malformed" | "window_below_estimate" | "window_unknown";
export interface Finding { subject: string; ref: string; severity: "stop" | "warn"; code: FindingCode; message: string; window: number | null; load: RoleLoad }   // subject: the role, or "labels" / "synopses"
export interface LocalModelsReport { uses: LocalUse[]; findings: Finding[]; windows: Record<string, number | null>; stops: Finding[]; warnings: Finding[] }   // windows keyed by ref
export function checkLocalModels(uses: LocalUse[], ctx: { contextBudget: number; pull?: ContextConfig["pull"]; fetchImpl?: typeof fetch; metrics?: Metrics; metricsParent?: Span | string | null }): Promise<LocalModelsReport>;
export function formatLocalModelsReport(report: LocalModelsReport): string[];   // one line per use (`worker      ollama/gpt-oss:20b-64k  window 65,536  load ~38,000  ok`), then each stop, then each warning
export function goalLoadLine(use: LocalUse, cardTokens: number, window: number | null, ctx: { contextBudget: number; pull?: ContextConfig["pull"] }): string;   // `worker on ollama/gpt-oss:20b-64k: this card needs about 41,000 of 65,536 tokens`
```

Per distinct provider, the endpoint check once; per distinct `ref`, the listing, the details and (when any use of it is a role) one tool round trip: `chatCompletion` with one tool `swarm_probe { value: string }` and the user message `Call the swarm_probe tool once with value "ok". Do not answer in text.`; it passes when the reply's first tool call is `swarm_probe` and its `arguments` parse to an object with a string `value`. Tool-less uses skip it.

What stops and what warns, and the exact copy (numbers with thousands separators; loads rounded to the nearest 1,000):
- `endpoint_down` (stop): `<subject>: <provider> at <baseUrl> did not answer within 5 s. Start <Ollama | LM Studio | the server> on this machine, or fix local_models.providers.<provider>.base_url.`
- `model_missing` (stop): Ollama `<subject>: <model> is not on ollama at <baseUrl>. Run: ollama pull <model> (or ollama create <model> from its Modelfile). Swarm never downloads a model.`; LM Studio `… Download it in LM Studio (lms get <model>). Swarm never downloads a model.`; other `… Load it on that server.`
- `window_below_system` (stop): `<subject>: <ref>'s window is <w> tokens, smaller than the <subject>'s fixed context of about <fixed>, so no card could fit. Use a model with a larger window, or raise its context (Ollama: num_ctx in its Modelfile; LM Studio: the context length when loading).`
- `tool_call_malformed` (stop, roles only): `<subject>: <ref> did not answer a tool call in the shape tools need (<evidence: the reply's text or arguments, 200 characters>). The <subject> uses tools, so it cannot run on this model.`
- `window_below_estimate` (warn): `<subject>: <ref>'s window is <w> tokens and the <subject>'s context is about <estimate>.`
- `window_unknown` (warn): `<subject>: swarm could not read <ref>'s window from <provider>, which does not report it; the <subject>'s context is about <estimate>.`

In run.ts: when `planLocalModels` returns any use, the check runs once after the backend preflights and before goal discovery, printing `formatLocalModelsReport`. Any stop: the lines, then exit 1 (with `--os`, `exitRun(1, "failed", <the stop lines joined>)`). Warnings go to Task 11. Before each goal, for each role on a local model, `goalLoadLine` is logged dim (card tokens: the goal's description length / 4) and `swarm_agent_local_load_tokens` is observed (Task 16); this never stops or asks. A project with no local use prints and runs nothing new.

- [ ] **Step 1: Write the failing tests** (`local-models-check.test.ts`, on the fakes):
  - `passes a worker on a model with a large window` — `numCtx: 65536`, a tool-call reply: no findings; one tool round-trip request seen.
  - `stops when the endpoint does not answer` — a closed port: one `endpoint_down` with the copy above, checked once for two roles on the same provider.
  - `stops with the pull step for a missing model, and never pulls` — `models: []`: `model_missing`; the fake saw no request to any `/api/pull` path.
  - `stops a window smaller than the fixed context` — `numCtx: 4096` for a worker with `contextBudget: 8000`: `window_below_system`.
  - `warns, with the numbers, when the window is below the estimate` — `numCtx: 8192` for the reviewer with `contextBudget: 8000`, pull on: `window_below_estimate` reading `reviewer: ollama/x's window is 8,192 tokens and the reviewer's context is about 21,000.` (pin the fixture so the arithmetic lands there, and assert the number from `roleLoad`).
  - `stops a worker whose model answers the tool round trip with text` — `chat-tool-as-text.json`: `tool_call_malformed` quoting the text; the same model used only for labels gets no tool check and no finding.
  - `waits up to the round trip's own limit` — a reply that arrives after 100 s on fake timers passes; one that never arrives fails at 180 s as `tool_call_malformed` with evidence `no answer within 180 s`.
  - `warns when the window is unknown` — a provider of kind `openai`: `window_unknown`.
  - `planLocalModels` returns nothing for a project on claude-code with Claude small models, and the right uses for each local combination.
- [ ] **Step 2: Run it to see it fail.** `cd packages/cli && npx vitest run tests/local-models-check.test.ts`
- [ ] **Step 3: Implement**, then wire run.ts behind `uses.length > 0`.
- [ ] **Step 4: Run** the test and the CLI suite.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/local-models-check.ts packages/cli/src/cli/run.ts packages/cli/tests/local-models-check.test.ts
git -c commit.gpgsign=false commit -m "feat(cli): check every local model before work: endpoint, model, window and one tool call"
```

---

### Task 11: The acknowledgement, `swarm local-models check`, and the OS exit

**Files:**
- Create: `packages/cli/src/cli/local-models-ack.ts`, `packages/cli/src/cli/local-models-command.ts`
- Modify: `packages/cli/src/cli/run.ts` (after the check), `packages/cli/src/cli/main.ts` (a `local-models` early return beside `room-mcp`, inside `try` as the Bun rule requires), `packages/cli/src/scaffold/templates/index.ts` (`.gitignore` gains `state/`), the `.swarm/.gitignore` seeding that adds `metrics/` (adds `state/` the same way)
- Test: `packages/cli/tests/local-models-ack.test.ts`, `packages/cli/tests/local-models-command.test.ts`

**Interfaces:**
- Consumes: `LocalModelsReport`, `checkLocalModels`, `planLocalModels`, `formatLocalModelsReport` (Task 10); plan 01's `exitRun(code, reason, message?)` and `RunExitReason` (Task 2 added the value).
- Produces:

```ts
// local-models-ack.ts
export const ACK_FILE = "state/local-models-ack.json";   // under the swarm dir
export const ACK_PHRASE = "I understand";
export interface AckKey { subject: string; ref: string; kind: "uses_local_model" | "window_below_estimate" | "window_unknown" }
export function requiredAcks(report: LocalModelsReport): AckKey[];     // one uses_local_model per use, plus one per warning; never a number
export function readAcks(swarmDir: string): AckKey[];                  // missing or unreadable file → [] (an unreadable one logs one line)
export function missingAcks(required: AckKey[], stored: AckKey[]): AckKey[];
export function writeAcks(swarmDir: string, keys: AckKey[], now: Date): void;   // { version: 1, acknowledgedAt, keys }, mode 0600, replacing the file, through a temp file and rename
export function isAcknowledgement(line: string): boolean;              // trimmed, case-insensitive "i understand", an optional full stop
export function acknowledgementScreen(report: LocalModelsReport, missing: AckKey[]): string[];
export function promptAcknowledgement(io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTty: boolean }, report: LocalModelsReport, missing: AckKey[]): Promise<boolean>;   // false without a TTY, without asking
// local-models-command.ts
export function runLocalModelsCheck(flags: Record<string, string>, deps?: { io?: Parameters<typeof promptAcknowledgement>[0]; fetchImpl?: typeof fetch; now?: () => Date }): Promise<number>;   // `swarm local-models check [--swarm-path <dir>] [--project <name>] [--json]`
```

The screen (copy fixed here; it stays short so it never stands in front of a model that works):

```
Local models for project-a on this machine
  worker      ollama/gpt-oss:20b-64k   window 65,536   load ~38,000
  reviewer    ollama/gpt-oss:20b-64k   window 65,536   load ~21,000
  labels      ollama/gpt-oss:20b-64k   window 65,536
Warnings
  reviewer: ollama/qwen3:8b's window is 8,192 tokens and the reviewer's context is about 21,000.
These run on this machine's models; nothing is sent to a hosted model for these roles.
Type "I understand" to go on, or anything else to stop:
```

The `Warnings` block is left out when there are none.

Behaviour:
- `swarm run`, after a check with no stops: when `missingAcks` is empty, one dim line `Local models acknowledged on this host.` and the run goes on. Otherwise:
  - with a TTY: the screen; `I understand` writes the required keys and goes on; anything else exits 1 with `Stopped: the local models were not acknowledged.`;
  - with `--os`: `exitRun(2, "local_models_unacknowledged", <formatLocalModelsReport lines, then "Run on this host: swarm local-models check --swarm-path <swarm dir>">)` before any goal;
  - otherwise (no TTY, `--yes` or not): exit 1 with the report and `Run swarm local-models check in a terminal on this host to acknowledge these models.`. `--yes` never acknowledges.
- `swarm local-models check` runs the same plan and check without starting a run: prints the report; a stop exits 1; missing acknowledgements prompt as above (or, without a TTY, exit 1 naming the command); `--json` prints `{ report, missing }` and never prompts; exit 0 when nothing is missing after it.
- Acknowledgements are keyed by subject, model and warning kind, never by numbers: a window that changes from 8,192 to 16,384 while still below the estimate needs no new acknowledgement; a new model, a new role on a local model, or a new warning kind does. A key that is no longer required (a role moved back to Claude) does not ask.

- [ ] **Step 1: Write the failing tests**
  - `local-models-ack.test.ts`: `requiredAcks` for a report with two uses and one warning gives three keys and no numbers; `asks again only when the role, model or warning kind changes` — stored keys from a report at window 8,192; a report at 16,384 with the same warning → `missingAcks` empty; the reviewer on a different model → one `uses_local_model` and one warning missing; a new `window_unknown` → missing; a role removed → empty. `writeAcks` writes mode `0600` and `readAcks` reads it back; a corrupt file reads as `[]`. `isAcknowledgement` accepts `I understand`, ` i understand ` and `I understand.` (`/^i understand\.?$/i` after trim) and refuses `yes`, `understood` and an empty line. `promptAcknowledgement` with `isTty: false` resolves `false` without writing to `output`.
  - `local-models-command.test.ts` (fake endpoint, temp swarm dir with a project on `ollama/…`): a clean check with a piped `I understand` exits 0 and writes the file; the second run exits 0 without prompting; `--json` prints the report and never prompts; an endpoint that is down exits 1 with the stop line; run under plan 01's fake brain, `swarm run --os` with no acknowledgement reports `exit { reason: "local_models_unacknowledged", code: 2, message }` where `message` contains `swarm local-models check --swarm-path`, and no goal was started (the fake task source's `fetchItem` was never called).
  - The scaffold test: the `.gitignore` template lists `state/`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement**; the `local-models` early return in main.ts follows the `room-mcp` form (inside `try`, `isMissingModule` as the only test for absence).
- [ ] **Step 4: Run** the tests and the CLI suite; then, locally once, `scripts/compile-release-binaries.sh` for the host platform and confirm `swarm local-models check --help` runs from the binary (carry-forward Bun rule).
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/local-models-ack.ts packages/cli/src/cli/local-models-command.ts packages/cli/src/cli/run.ts packages/cli/src/cli/main.ts packages/cli/src/scaffold packages/cli/tests
git -c commit.gpgsign=false commit -m "feat(cli): acknowledge local models once per host, and swarm local-models check"
```

---

### Task 12: `privacy: "local"`, and `local_only` extended to the new URLs

**Files:**
- Create: `packages/cli/src/privacy.ts`
- Modify: `packages/cli/src/project-substrate.ts` (`readProjectSubstrateConfig` reads the privacy class; `prepareProjectSubstrate` enforces both rules), `packages/cli/src/cli/run.ts` (oversight API providers under `privacy: "local"`)
- Test: `packages/cli/tests/privacy.test.ts`, `packages/cli/tests/project-substrate.test.ts` (extended)

**Interfaces:**
- Consumes: `privacyClassOf`, `resolveModelTarget`, `isLocalEndpoint`, `localProviders`, `LocalModelsConfigError` (Task 2); `LocalOnlyViolation`, `assertLocalOnly` (existing).
- Produces:

```ts
export class PrivacyViolation extends Error { override readonly name = "PrivacyViolation"; constructor(readonly violations: readonly string[]) }
  // message: `privacy is "local" for this project, so swarm will not start:\n  - <violation>\n  - …`
export type PrivacyProject = Pick<ProjectConfig, "backends" | "models" | "taskBackendConfig" | "context" | "local_models">;
export function collectPrivacyViolations(project: PrivacyProject): string[];
export function collectLocalModelUrlViolations(project: Pick<ProjectConfig, "local_models" | "models" | "backends">): string[];   // the local_only extension
```
- `ProjectSubstrateConfig` gains `privacy: PrivacyClass` (from `privacyClassOf` over the same configs it already reads); `localOnly` is true when the class is `local` or `local_only`, so `privacy: "local"` carries every `local_only` refusal (Substrate endpoints, both Postgres URLs, the embedder URL, `telemetry_sharing.enabled`), with their existing loopback-only rule unchanged.
- `prepareProjectSubstrate`, after its existing checks: for `local_only` and `local`, `collectLocalModelUrlViolations` (each `local_models.providers.<name>.base_url` the project sets, and the provider URL of every `provider/model` an `openai-compatible` or `opencode` role names, must be local by `isLocalEndpoint(url, trusted_hosts)`), thrown as `LocalOnlyViolation`; for `local` only, also `collectPrivacyViolations`, thrown as `PrivacyViolation`. `main.ts`'s preamble already prints both kinds and exits 1 (it catches `LocalOnlyViolation`; it now catches `PrivacyViolation` too). Since the preamble runs for every command but `init`, `uninstall` and `upgrade`, `swarm sync` (which writes synopses) is covered as well as `swarm run`. A `local_only` project that runs Claude Code or codex roles keeps running unchanged.

`collectPrivacyViolations` reports, one line each, in this order:
- a role whose backend is `claude-code` or `codex`: `<role> runs on <type>, which sends its work to a hosted model`; whose fallback is: `<role>'s fallback <type> sends its work to a hosted model`;
- a role on `api` whose `models.provider` is not `openai-compatible`: `<role> runs on the <anthropic|openai> API`;
- a role on `opencode` or `openai-compatible` whose provider URL is not local: `<role>'s provider <name> at <url> is neither loopback nor in local_models.trusted_hosts`;
- the planner, decomposer and the other worker-backed calls run on the worker's backend and are covered by the worker's line;
- goal labels: `taskBackendConfig.labels.model` a Claude model: `goal labels run on <model>, a hosted model`;
- section synopses, when `context.sections.enabled`: `context.sections.model` absent or a Claude model: `section synopses run on <model>, a hosted model (set context.sections.model to a local model)`;
- a `provider/model` naming an unknown provider: the resolve error's message.

Under `privacy: "local"`, run.ts builds the reviewer's and arbiter's API fallback providers only from an `openai-compatible` local provider; otherwise it uses the null provider, whose existing behaviour (the reviewer refuses, the arbiter escalates) holds. The PR categorizer (`CategorizerSelection`) runs no model today; a project that names a hosted model for it is refused with `the PR categorizer runs on <model>, a hosted model`, so the promise holds when it is wired.

- [ ] **Step 1: Write the failing tests**
  - `privacy.test.ts`: a project with every role on `opencode` with `ollama/…`, labels and synopses on `ollama/…`: no violations. Each line above from a project that breaks exactly one rule, with its exact text. A trusted host (`studio.example` in `trusted_hosts`, provider `studio` at `http://studio.example:11434/v1`) is local; `http://192.0.2.10:11434/v1` without it is not.
  - `project-substrate.test.ts`: `privacy: "local"` in a domain config sets `localOnly: true` and `privacy: "local"`; with `telemetry_sharing.enabled` it throws the existing telemetry `LocalOnlyViolation`; with a claude-code worker it throws `PrivacyViolation` naming it; `substrate.local_only: true` with a claude-code worker and `local_models.providers.ollama.base_url: "http://192.0.2.10:11434/v1"` throws `LocalOnlyViolation` for the URL only, and with the URL fixed passes (today's `local_only` projects keep running). A project with neither key reads `privacy: "normal"` and behaves exactly as before.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both tests and the CLI suite.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/privacy.ts packages/cli/src/project-substrate.ts packages/cli/src/cli/main.ts packages/cli/src/cli/run.ts packages/cli/tests
git -c commit.gpgsign=false commit -m "feat(cli): privacy \"local\" refuses to start when anything would leave the machine"
```

---

### Task 13: The brain: `privacy: "local"` on registrations and rooms, and the host reports the project's setting

**Files:**
- Modify: `packages/substrate-plugin/src/types/os-types.ts` (`Registration.privacy` and `Room.privacy` gain `"local"`; `Instance` gains `remoteTokens: field.number({ nullable: true })`), `packages/os/src/store/rows.ts` (the row types follow)
- Modify: `packages/os/src/launcher/host-inspect.ts` (`PathReport.privacy`), `packages/os/src/launcher/host-protocol.ts` (`PathReport` schema, `NO_PATH`), `packages/cli/src/cli/os-host.ts` (`hostCheck`: a `privacy:<p>` item per path and an `opencode` item)
- Modify: plan 04's attach handling (`Dispatcher.onAttach` in `packages/os/src/dispatch/instances.ts`) and plan 01's `packages/cli/src/cli/os-attach.ts` (the attach body carries `privacy`)
- Test: `packages/os/tests/launcher/host-inspect-privacy.test.ts`, `packages/cli/tests/os-host.test.ts` (extended), `packages/os/tests/dispatch/attach-privacy.test.ts`, `packages/cli/src/cli/os-attach.test.ts` (extended), `tests/integration/os-store.test.ts` (the new value and field on a real stack, `SWARM_SDK_E2E=1`)

**Interfaces:**
- Consumes: `PrivacyClass`, `privacyClassOf` (Task 2); `AttachBody.privacy` (Task 2); plan 04's `inspectPath`, `hostCheck`, `HostCheckItem`, `Notice`; plan 01's `OsAttachment.attach`.
- Produces:
  - `PathReport { exists; directory; swarmDir; realPath; privacy: PrivacyClass | null }` (null when not a swarm dir or a config does not parse; `NO_PATH.privacy` is null). `inspectPath` reads `<path>/config.json` and every `<path>/domains/*/config.json` and applies `privacyClassOf`, the one rule `packages/cli` also applies.
  - `hostCheck` adds, per path, `privacy:<p>` (`ok`, detail `normal`, `local_only` or `local`; `unknown` when the report's privacy is null, fix `fix the project's config.json`), and one `opencode` item before the paths (`findOpenCode` then `opencode --version`: `ok` with the version; `missing` with fix `install OpenCode on this host (only needed for roles on opencode)`), so a person checking a host sees whether its runs can use local models.
  - Attach: plan 01's run sends `privacy` (its `ProjectSubstrateConfig.privacy`) in the attach body. `onAttach` compares it with the registration's `privacy`; when they differ, the brain still attaches the run (the run keeps its own promise, which it enforced at start) but patches the registration `paused: true` and posts the notice `privacy_mismatch` in the system and board rooms: `<project> now says privacy "<run's>" but is registered as "<registration's>". Its board is paused; /unregister <id> and register it again.` An attach without `privacy` (an older run) changes nothing.
  - `Notice` gains `privacy_mismatch` and `local_models_unacknowledged` (Task 14).
- Rulings this task carries for plans 05 to 09 (also in the overview's "Local models" block): wherever a plan treats `local_only` specially (push bodies, `register`'s `host_trust` rule, room privacy), `"local"` is treated at least as strictly; the test is `privacy !== "normal"`.

- [ ] **Step 1: Write the failing tests**
  - `host-inspect-privacy.test.ts`: a swarm dir whose domain config has `privacy: "local"` reports `privacy: "local"`; one with `substrate.local_only: true` reports `local_only`; none reports `normal`; broken JSON reports `null`; not a swarm dir reports `null`.
  - `os-host.test.ts`: `hostCheck({ paths: [p] })` includes `{ name: "privacy:<p>", status: "ok", detail: "local" }` and an `opencode` item (`missing` when the fake `exec` answers 127).
  - `attach-privacy.test.ts`: a registration with `privacy: "normal"` and an attach with `privacy: "local"` → the attach succeeds, the registration is paused, both rooms hold the notice text above; matching values change nothing; no `privacy` in the body changes nothing.
  - `os-attach.test.ts`: the attach body sent to the fake brain carries `privacy` when the run passes it.
  - The plugin's type test: `osTypes.Registration.fields.privacy` accepts `"local"`; `Instance.fields.remoteTokens` is nullable.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** Confirm that `ensureTypesRegistered` applies the new enum value and nullable field to an OS stack created before this change (run `SWARM_SDK_E2E=1 pnpm turbo test --filter=@mnmal-ai/swarm-integration-tests -- os-store`); if Substrate needs a migration step for an enum value, add it to `ensureOsStack` and say so in the commit.
- [ ] **Step 4: Run** `cd packages/os && npx vitest run`, the CLI suite, and the E2E store test above.
- [ ] **Step 5: Commit**

```bash
git add packages/substrate-plugin/src/types/os-types.ts packages/os packages/cli/src/cli/os-host.ts packages/cli/src/cli/os-attach.ts packages/cli/tests packages/cli/src/cli/os-attach.test.ts tests/integration/os-store.test.ts
git -c commit.gpgsign=false commit -m "feat(os): privacy \"local\" on registrations and rooms, reported by the host and checked at attach"
```

---

### Task 14: The brain: `local_models_unacknowledged`, limits on remote tokens, and OpenCode sessions in the resources

**Files:**
- Modify: `packages/os/src/dispatch/instances.ts` (`exitState`, `onExit`, `isBlockingEnd`, `settleEndedRuns`, `lifetimeOutcome`), `packages/os/src/dispatch/notices.ts` (the two notices' text), `packages/os/src/resources/usage.ts` (`computeUsage`), plan 04's `onHeartbeat` (stores `remoteTokens`), `packages/os/src/launcher/local.ts` (`countOpenCodeProcesses`, `machineSnapshot`), `packages/os/src/launcher/launcher.ts` and `host-protocol.ts` (`ResourceSnapshot.opencodeSessions`)
- Modify: `packages/cli/src/cli/role-models.ts` (`backendLocality`; `withModelReporting`'s `onSpend` gets the locality), `packages/cli/src/cli/run.ts` and `os-attach.ts` (the heartbeat carries `remoteTokens`)
- Test: `packages/os/tests/dispatch/local-models-exit.test.ts`, `packages/os/tests/resources/usage-remote.test.ts`, `packages/os/tests/launcher/opencode-processes.test.ts`, `packages/cli/tests/role-models-locality.test.ts`

**Interfaces:**
- Consumes: `RunExitReason`, `HeartbeatBody.remoteTokens` (Task 2); plan 04's `exitState`, `settleEndedRuns`, `computeUsage`, `machineSnapshot`, `countClaudeProcesses`, `ResourceSnapshot`.
- Produces:
  - `exitState(row, { reason: "local_models_unacknowledged" })` → `{ state: "paused", exitReason: "local_models_unacknowledged" }`; `isBlockingEnd` is false for it; `settleEndedRuns` holds the card with reason `<instance> ended local_models_unacknowledged; the card waits for /resume board <board>`; `onExit` patches `paused: true` on every registration with the same `projectName` (as for `login_expired`) and posts in the board room, and the system room, the notice `local_models_unacknowledged`:
    `Local models need an acknowledgement on <host> for <project> (<instance>):` then the exit `message` (the check's lines, already redacted by the run and passed through `redactSecrets` again, at most 4,000 characters), then `Run that command on <host>, type I understand, then /resume board <board>.` The brain moves no card. `lifetimeOutcome` maps it to `local_models_unacknowledged` (a new value of plan 04's `LifetimeOutcome`).
  - `backendLocality(config: BackendConfig, project: Pick<ProjectConfig, "models" | "local_models">): "local" | "remote"` (`role-models.ts`): `local` for `opencode`, and for `api` with `openai-compatible`, when the provider URL is local by `isLocalEndpoint`; `remote` otherwise. `withModelReporting`'s `onSpend(spent, locality)`; the run keeps `remoteTokensUsed`, and the attachment's heartbeat sends `remoteTokens` with `tokens`.
  - `Instance.remoteTokens` stored by `onHeartbeat` (and at exit) when the body carries it. `computeUsage` counts `remoteTokens ?? tokens` per instance for `tokensLastHour`, `tokensLastHourTotal` and `tokensLastDay`, so `limits.tokens_per_hour`, `limits.tokens_per_day` and a registration's `tokensPerHour` bound remote (paid) tokens only; the instance's `tokens` (everything) is still what the dashboard, `swarm top` and the run's own budget guard show and enforce. An instance from an older run (no `remoteTokens`) counts all its tokens, as today.
  - `ResourceSnapshot.opencodeSessions: number`; `countOpenCodeProcesses(psArgs: string): number` counts a `ps -o args=` line whose argv[0] basename is `opencode` and whose words include `run` and `--standalone` (swarm's sessions, not the owner's background service); `machineSnapshot` fills it; the host protocol's `ResourceSnapshotSchema` accepts it with default `0` so an older host's reply still parses.

- [ ] **Step 1: Write the failing tests**
  - `local-models-exit.test.ts` (plan 04's dispatcher harness): an exit `{ reason: "local_models_unacknowledged", code: 2, message: "worker  ollama/x …\nRun on this host: swarm local-models check --swarm-path /path/to/project/.swarm" }` leaves the instance `paused` with that `exitReason`, pauses both registrations of `project-a`, holds the card with the reason above, and posts the notice in the board room containing the message and `/resume board board-a`; after `/resume board board-a` the next re-evaluation dispatches the card again although its version never changed (as for `login_expired`).
  - `usage-remote.test.ts`: two instances in the last hour, one with `tokens: 900_000, remoteTokens: 0` (all local) and one with `tokens: 500, remoteTokens: null`: `tokensLastHourTotal` is 500, and `checkResources` with `tokens_per_hour: 1000` passes.
  - `opencode-processes.test.ts`: `countOpenCodeProcesses` over `opencode run --standalone --format json …` (counts), `/path/to/.opencode/bin/opencode serve` (does not), `node opencode-thing.js` (does not); `machineSnapshot` returns `opencodeSessions`; `ResourceSnapshotSchema.parse` of a snapshot without the field yields `0`.
  - `role-models-locality.test.ts`: `backendLocality` for opencode on loopback `local`, on `192.0.2.10` without trust `remote`, claude-code `remote`, api with `openai-compatible` on loopback `local`; `withModelReporting` passes the locality to `onSpend`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd packages/os && npx vitest run` and the CLI suite.
- [ ] **Step 5: Commit**

```bash
git add packages/os packages/cli/src/cli/role-models.ts packages/cli/src/cli/run.ts packages/cli/src/cli/os-attach.ts packages/cli/tests
git -c commit.gpgsign=false commit -m "feat(os): hold a card for a local-models acknowledgement, bound paid use by remote tokens, count OpenCode sessions"
```

---

### Task 15: Docs

**Files:**
- Create: `docs/local-models.md`
- Modify: `docs/project-structure.md` (the keys), `environment.md` (`SWARM_OPENCODE_SESSIONS_DIR`, `SWARM_OPENCODE_PLUGIN_DIR`, `SWARM_OPENCODE_GUARD_SOCKET` marked internal), `README.md` (one paragraph and a link under the backends), `CLAUDE.md` (one bullet under Key Design Decisions: local models through OpenCode, `privacy: "local"`), `docs/` known-limits page that plan 01 ruling O1 created (OpenCode sessions have no OS sandbox: shell commands are fenced only by patterns, as on Claude Code)
- Test: `packages/cli/tests/docs-local-models.test.ts`

`docs/local-models.md` covers, in this order: what runs where (the table of roles, small calls and chief-of-staff turns, and which go through OpenCode and which straight to the endpoint); installing OpenCode and pointing a role at `ollama/<model>` or `lmstudio/<model>` (a complete `config.json` example for `project-a` with every role, labels and synopses local); `local_models.providers` and `trusted_hosts` (with `studio.example` as the example host); the check before work, what stops and what warns, with the exact message forms from Task 10; the acknowledgement and `swarm local-models check`, including the Swarm OS case (`local_models_unacknowledged`, the board room notice, `/resume board`); `privacy: "local"`: what it refuses, what it covers (models, embeddings, the PR categorizer, telemetry, Substrate) and what it does not (boards, git hosting, the brain's room traffic), and how it differs from `substrate.local_only`; the chief of staff on a local model (`cos.harness`, `cos.model`, `swarm os cos selftest`, and that `swarm os register` refuses a private project otherwise); tokens and limits (`locality`, the brain's hourly and daily limits count only remote tokens, `max_instances` is the brake on local load); the isolation and guard summary; known limits (no OS sandbox, one tested OpenCode version, Ollama and LM Studio the only tested endpoints, the dispatcher does not know which host has which model).

- [ ] **Step 1: Write the failing test** `docs-local-models.test.ts`: the page exists; it names `I understand`, `local_models_unacknowledged`, `swarm local-models check`, `privacy: "local"`, `trusted_hosts`, `cos.harness`, `opencode run --standalone`; every config key it shows in a JSON block parses and passes `validateLocalModelsConfig`; it contains no IP other than `127.0.0.1`, `::1` or the 192.0.2.0/24 documentation range, and no home path other than `~`.
- [ ] **Step 2: Run it to see it fail; write the docs; run it to see it pass.**
- [ ] **Step 3: Commit**

```bash
git add docs/local-models.md docs/project-structure.md environment.md README.md CLAUDE.md docs packages/cli/tests/docs-local-models.test.ts
git -c commit.gpgsign=false commit -m "docs: local models through OpenCode, the check, the acknowledgement and privacy \"local\""
```

---

### Task 16: Metrics

**Files:**
- Modify: `packages/metrics/src/catalogue/run.ts` (the agent rows below; the help text's `backend` list gains `opencode`), `packages/metrics/src/catalogue/os.ts` (a `// plan 11` block, append-only)
- Modify: `packages/worker-backends/src/openai-compatible.ts`, `opencode-guard.ts`, `opencode-events.ts`, `opencode.ts`, `small-model.ts`; `packages/cli/src/cli/role-models.ts`, `local-models-check.ts`, `run.ts`; `packages/os/src/launcher/local.ts` (`ResourceMonitor.sample()`), `packages/os/src/resources/usage.ts`
- Test: `packages/worker-backends/tests/opencode.metrics.test.ts`, `packages/cli/tests/local-models.metrics.test.ts`, `packages/os/tests/resources/opencode.metrics.test.ts`, `tests/integration/metrics-coverage.test.ts` (unchanged; it must still pass with the new rows)

Rows (declared before any is recorded; the coverage test finds each name as a literal):

| name | kind | unit | labels | recorded by |
|---|---|---|---|---|
| `swarm_agent_tokens_total` (existing) | counter | tokens | adds `locality` | `withModelReporting`, from `backendLocality` |
| `swarm_agent_session_tokens` (existing) | histogram | tokens | adds `locality` | `withModelReporting` |
| `swarm_agent_small_model_seconds` (existing) | histogram | seconds | adds `locality` | `smallModel` (`local` for a local target) |
| `swarm_agent_small_model_tokens_total` | counter | tokens | `purpose`, `kind` (`input`, `output`), `locality` | `smallModel` on a local target (the reply's usage) |
| `swarm_agent_local_request_seconds` | histogram | seconds | `provider`, `op` (`models`, `details`, `chat`), `outcome` | `chatCompletion`, `listModels`, `modelDetails`: the endpoint's latency |
| `swarm_agent_local_check_seconds` | histogram | seconds | `check` (`endpoint`, `listed`, `window`, `tool_call`), `outcome` (`ok`, `stop`, `warn`, `error`) | `checkLocalModels`, one per check per model |
| `swarm_agent_local_check_findings_total` | counter | count | `code`, `severity` | `checkLocalModels` |
| `swarm_agent_local_window_tokens` | gauge | tokens | `role` | `checkLocalModels`: the window each role's model serves |
| `swarm_agent_local_load_tokens` | histogram | tokens | `role` | run.ts, before each goal: the card-specific estimate |
| `swarm_agent_local_ack_total` | counter | count | `outcome` (`already`, `acknowledged`, `refused`, `no_terminal`, `os_exit`) | run.ts and `swarm local-models check` |
| `swarm_agent_guard_seconds` | histogram | seconds | `decision` (`allow`, `deny`, `rewrite`), `outcome` | `GuardServer.decide` |
| `swarm_agent_guard_decisions_total` | counter | count | `tool`, `decision`, `reason` (`rule`, `path`, `outside`, `doc_guard`, `not_offered`, `self_test`, `error`, `none`) | `GuardServer.decide` |
| `swarm_agent_guard_selftest_seconds` | histogram | seconds | `kind` (`handshake`, `end_to_end`), `outcome` | `GuardServer.handshake`, `guardEndToEnd` |
| `swarm_os_launcher_opencode_sessions` | gauge | count | none | `ResourceMonitor.sample()` from `opencodeSessions` |
| `swarm_os_launcher_last_hour_remote_tokens` | gauge | tokens | none | `ResourceMonitor.sample()`: the remote-token sum `computeUsage` limits on |

The existing `swarm_agent_session_seconds`, `_api_seconds`, `_first_message_seconds`, `_tool_seconds` and `_turns` get `backend: "opencode"` from `withModelReporting` and the collector with no change to their defs. `provider` values are names from the project's `local_models.providers` (bounded by the config); model names never become label values, only span attributes. Spans from the guard server pass `metricsParent` (the run's root), since it is a server.

- [ ] **Step 1: Write the failing tests** on strict `testRegistry` registries with a fake clock:
  - `opencode.metrics.test.ts`: a fake-opencode session with one allowed and one denied bash call records `swarm_agent_guard_decisions_total{tool:"bash",decision:"allow",reason:"none"}` = 1 and `{decision:"deny",reason:"rule"}` = 1, one `swarm_agent_guard_selftest_seconds{kind:"handshake",outcome:"ok"}`, and the session rows with `backend:"opencode"`; `chatCompletion` against the fake records `swarm_agent_local_request_seconds{provider:"ollama",op:"chat",outcome:"ok"}`, and a closed port `outcome:"error"`; a guard span's `parent` is the given root.
  - `local-models.metrics.test.ts`: a check with one warning records four `swarm_agent_local_check_seconds` observations for a tool-using role, `swarm_agent_local_check_findings_total{code:"window_below_estimate",severity:"warn"}` = 1 and `swarm_agent_local_window_tokens{role:"reviewer"}` = 8192; `withModelReporting` for an opencode role on loopback records `swarm_agent_tokens_total{locality:"local"}` and for claude-code `locality:"remote"`; an OS exit records `swarm_agent_local_ack_total{outcome:"os_exit"}`.
  - `opencode.metrics.test.ts` (os): `ResourceMonitor.sample()` sets `swarm_os_launcher_opencode_sessions` = 2 and `swarm_os_launcher_last_hour_remote_tokens` from the usage fixture of Task 14.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Add the rows and record them;** replace the `noopMetrics` placeholders Tasks 3 and 7 left in their tests with these assertions.
- [ ] **Step 4: Run** every touched package's suite, the CLI suite, and `cd tests/integration && npx vitest run metrics-coverage.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add packages/metrics packages/worker-backends packages/cli packages/os
git -c commit.gpgsign=false commit -m "feat(metrics): local endpoints, the pre-run check, the guard, locality and OpenCode sessions"
```

---

### Task 17: The live proof, on this machine, loopback only (controller-run)

The design's "Accepted when". The controller runs it, never a subagent alone, on the owner's Mac, in a scratch repository under the scratchpad, never a client project, with the owner's Ollama and OpenCode binary but never the owner's OpenCode config. One model at a time: nothing else may hold the GPU, so the controller checks `ollama ps` first and stops only models it loaded itself.

**Files:**
- Create: `scripts/local-models-proof.sh` (the steps below, for a person to rerun)
- Modify: nothing else; results go into the plan's SDD ledger (`.superpowers/sdd/11-local-models-opencode/progress.md`)

- [ ] **Step 1: The scratch project.** `git init` a scratch repo with one small TypeScript file and a test; `swarm init` there; a dedicated Substrate stack on loopback ports (the CLAUDE.md `substrate` block with `local_only: true`, its own `compose_project`); task source `local` with one goal ("add a `sum(a, b)` function and its test"); `privacy: "local"`; every role `{ "type": "opencode", "model": "ollama/gpt-oss:20b-64k" }`; `taskBackendConfig.labels.model` and `context.sections.model` the same model with `context.sections.enabled: true`; `source_control.strategy: "local_branch"` with no remote (the goal's work is merged into the session branch in the scratch repo; nothing is pushed). `oversight.arbiter: "always"`, so the arbiter runs too.
- [ ] **Step 2: The check.** `swarm local-models check` in a terminal: no stop; type `I understand`; the file `.swarm/state/local-models-ack.json` exists and `git status` does not list it.
- [ ] **Step 3: The fence.** Run `swarm run --yes` under `sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))'`, so the run and every child can reach only loopback and Unix sockets (Docker's socket, the guard's socket). In a second terminal, record every connection of the run's process tree: `lsof -i -n -P` filtered to the tree's pids every 500 ms into `connections.log`, and `nettop -P -L 0 -J bytes_in,bytes_out -t external` for the duration.
- [ ] **Step 4: Expected, each recorded in the ledger:**
  - the run ends with the goal's commit merged into the session branch in the scratch repo (`git log <session branch>` shows it) and its test passing;
  - the worker, reviewer and arbiter each ran as an OpenCode session (`backend: "opencode"` in `swarm metrics --last --json`; the session ledger shows the three roles), on `ollama/gpt-oss:20b-64k` (the model report);
  - the goal's label and the section synopses came from the same model (`swarm_agent_small_model_seconds{locality:"local"}` for `label` and `synopsis`);
  - the guard's end-to-end self-test ran once and each session's handshake passed (`swarm_agent_guard_selftest_seconds`);
  - `connections.log` holds only `127.0.0.1`, `::1` and Unix sockets, and `nettop`'s external view lists nothing for the tree; no `claude` process ran (`countClaudeProcesses` over a `ps -A -o args=` sampled during the run is 0) and no request reached a hosted service;
  - the sandbox refused nothing the run needed (a refusal is a failure of the proof, investigated, not a pass);
  - the end-of-run block shows tokens by role with no currency.
- [ ] **Step 5: The negative proofs, quick:** with `backends.reviewer` set to `claude-code`, `swarm run` stops at start with the `PrivacyViolation` naming the reviewer; with the model renamed to one Ollama does not have, it stops with the `ollama pull` line and Ollama's model list is unchanged afterwards; with an extra role model the acknowledgement is asked again.
- [ ] **Step 6: Clean up** what the proof started: its dedicated stack (`swarm substrate stop` in the scratch project, then its compose `down -v`), the scratch directory, and `~/.swarm/opencode-sessions` holding no session left behind. Never stop a container, model or process the proof did not start.
- [ ] **Step 7: Commit the script**

```bash
git add scripts/local-models-proof.sh
git -c commit.gpgsign=false commit -m "test: the local-models proof, loopback only, for a person to rerun"
```
