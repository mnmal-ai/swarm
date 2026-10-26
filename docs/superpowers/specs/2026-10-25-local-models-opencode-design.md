# Local models through OpenCode: design

Status: approved by the owner, 2026-10-25, with the recommendations below on the two questions left open.

## Intent

Swarm should be able to do real work on a model running on the owner's own machine (Ollama or LM Studio), for every role it runs, so a project's code, diffs and conversations need never leave that machine. The owner gave three reasons: privacy, offline use and cost. Of those, privacy decides the hard cases.

Swarm already runs roles through existing harnesses: Claude Code (through the Agent SDK) and codex. OpenCode joins them as a harness that drives a local model the same way. A plain API-with-tools loop stays as the fallback for anyone who wants no harness at all.

## Goals

1. **A fourth backend, `opencode`.** It can be picked per role (worker, reviewer, arbiter) exactly as `claude-code` and `codex` are today, with a model named `provider/model` (for example `ollama/gpt-oss:20b-64k`).
2. **Every role can run locally,** including the small one-shot calls (goal labels, section synopses) and, in Swarm OS, the chief of staff and its readiness check.
3. **A project can promise privacy.** `privacy: "local"` in a project's config refuses to start a run if any role, small call or embedder would reach a non-local endpoint. With it set, nothing from the project goes to Anthropic, OpenAI or any other remote service.
4. **The same guards on every backend.** The deny list, the doc guard, the git guard, no GitHub credentials, the OS-home rule, and the per-session `swarm-room` tools hold on an OpenCode session as they do on Claude Code.
5. **A check before work starts.** For each role on a local model, the run confirms the endpoint answers, the model is present (it never downloads one), its context window is big enough for what that role will send, and one tool call comes back well-formed.
6. **Honest warnings, acknowledged once.** When a model looks too small for a role's load, the run says so plainly. The first time a project runs a given set of local models on a host, the person types `I understand` before work starts. This stays secondary: it must never get in the way of a model that can do the work.
7. **Measured like everything else.** `opencode` is a value of every metric's `backend` label. The pre-run check, the endpoint's latency and tokens per role are recorded locally.
8. **It works wherever a run runs.** That covers a plain `swarm run`, a run the Swarm OS brain dispatches locally, and one it dispatches to another machine over the remote launcher. The local model is the run host's.

## Non-goals

- Downloading, converting or serving models. Ollama and LM Studio do that, and the owner picks the models.
- Scheduling GPUs or memory between concurrent runs. The owner's `max_instances` and the host's resources snapshot are the only controls this version.
- Choosing models automatically, or tuning prompts per model family.
- Replacing Claude Code or codex.
- Remote hosted model services reached through OpenCode (OpenRouter and similar). Nothing here prevents them, but this design neither builds nor tests them.

## Anti-goals

- **A role labelled local that still sends code elsewhere.** OpenCode's sharing, auto-update, model catalogue fetch, free-model offers and Claude Code compatibility features (reading `~/.claude`, its skills and `CLAUDE.md` files) must all be off. The owner's own OpenCode config and plugins must never load into a swarm session. Synoptic ships an OpenCode plugin that talks to the shared store; if it loaded into a client run, that would breach the NDA wall.
- **A session that a repository can reconfigure.** A work repo's `opencode.json` or `.opencode/` directory must never load, as codex ignores the user's config and Claude Code sessions run with no setting sources.
- **A warning screen in front of a model that works.** Warnings report evidence (the context window, a failed tool call), never a guess about a model's quality.
- **Weaker safety on a weaker model.** Nothing that keeps a session or the chief of staff safe may depend on the model behaving well.

## Decisions the owner made

- Local models cover every role, chief of staff included (2026-10-25).
- An existing harness is preferred, and the user can pick Claude Code, codex, OpenCode or another; a direct API-with-tools loop is the fallback (2026-10-09).
- Warn when a model is unlikely to handle the token load, and require an explicit acknowledgement such as "I understand" before running, as long as that stays secondary to doing real work on a local model (2026-10-09 and 10).

## How it works

### The backend

`WorkerBackendType` gains `"opencode"`. `OpenCodeBackend` implements `IWorkerBackend` with `supportsDirectExecution: true`, and `instantiate`, `detectAvailableBackends`, the fallback carry-over, the role defaults and the preflight learn its name. `binaryPath` finds the binary when it is not on `PATH`, as it is not on the owner's Mac, where it lives in `~/.opencode/bin`.

Each session runs a private server so it never touches the owner's background service:

```
opencode run --standalone --format json --model <provider/model> --auto [--agent swarm-<role>]
```

The command runs in the worktree with the task on stdin. Before work starts, the first task of the plan confirms each flag and switch below against the installed version (2.1.4 today), and the backend refuses to start on a version where any of them is missing.

### Isolation

Each session gets a directory under `~/.swarm/opencode-sessions/s-<id>` (mode 0700, removed afterwards, `SWARM_OPENCODE_SESSIONS_DIR` overrides it, outside the worktree so the agent cannot forge its logs), and an environment built from an allowlist like codex's:

- **Config:** the whole configuration is inline (`OPENCODE_CONFIG_CONTENT`), and the global config directory points at an empty directory in the session directory. The project-config switch is off, so the work repo's `opencode.json` and `.opencode/` never load. The XDG config, data, state and cache homes point into the session directory, so sessions, the database and snapshots never mix with the owner's.
- **Off:** sharing, auto-update, the model catalogue fetch (the run also works with no network at all), free models, Claude Code compatibility and its skills, the file watcher.
- **Credentials:** no API keys, no GitHub token, an empty `GH_CONFIG_DIR`, and git without credential helpers or SSH, as codex sessions get today.
- **Providers:** only those the project names. `local_models.providers` in the project config maps a name to an OpenAI-compatible base URL (defaults: `ollama` at `http://127.0.0.1:11434/v1`, `lmstudio` at `http://127.0.0.1:1234/v1`). The backend writes them into the inline config with the models the roles use and nothing else.
- **Plugins:** exactly one, swarm's guard plugin (below), loaded from a path inside swarm's own install.

### Guards

There are two layers, and both are swarm's:

- **Permission rules** in the inline config. The deny list's shell patterns become `bash` deny rules, edits outside the worktree are denied, and web fetch and every tool swarm does not use are denied. `--auto` approves only what is not denied.
- **The guard plugin.** Its `tool.execute.before` hook runs every tool call through the same `matchDenied` policy `swarm codex-hook` uses and throws to block. It also enforces the doc guard on reads, which codex cannot; path-scoped rules on its read and edit tools, including the OS-home rule; and the fnl rewrite. A self-test before each session proves the plugin loaded and blocks a denied call. If the self-test fails, the session does not start, so the guard fails closed.
- **No operating-system sandbox.** OpenCode has none, so shell commands are fenced only by patterns, as on Claude Code today. The git guard snapshots hooks and config and fails the session on a change, as codex's does.

### Room tools and waiting

Plan 01's per-session `swarm-room` MCP server goes into the inline config as a local stdio server, so OpenCode workers can `ask_human`, `send`, `read` and `who` like Claude Code workers. While a question waits, the session's timeout is suspended. The OpenCode backend joins the question gate from the start, which codex does not this version.

### Events, tokens and metrics

OpenCode's JSON events are mapped to the `ProgressEvent` shapes the other backends emit (session start, tool call, tool summary, model response, status change), so the tool-wedge watcher, the dashboard and the session ledger work unchanged. Tokens per step are summed into `tokensUsed` and the `ModelReport`. `opencode` becomes a value of the metrics `backend` label. The OS resources snapshot counts OpenCode sessions alongside Claude ones.

### Small calls and the API fallback

One-shot calls with no tools, such as goal labels, section synopses and the chief of staff's readiness and follow-up turns, don't need a harness. They go straight to the endpoint as an OpenAI-compatible chat completion:

- `smallModel` gains a target, `{ kind: "claude" | "local", model, provider? }`.
- `context.sections.model` replaces the synopsis writer's hard-coded model.
- `taskBackendConfig.labels.model` takes a local model the same way.

The same client gives `OpenAIProvider` a `baseURL`, so `models.provider: "openai-compatible"` with `local_models.providers` drives swarm's existing API worker loop (read, write, list, run) and the reviewer and arbiter fallbacks against a local model. That is the owner's fallback for anyone who wants no harness.

### The check before work

For every role, small call and chief-of-staff turn kind set to a local model, the run checks the following before any goal is touched, each with a time limit:

- **The endpoint answers.**
- **The model is listed.** If not, the run stops with the exact `ollama pull` or LM Studio step. Nothing is downloaded.
- **The context window is big enough.** It must be at least the role's estimated load, using Ollama's model details or LM Studio's model list. The estimate is the role's system context, the card and the documents it will pull, plus a margin for the conversation.
- **One tool call round trip works.** A tiny request asks for one call of a dummy tool and checks the reply parses.

What stops the run and what is a warning (my call):

- **Stops:** the endpoint does not answer; the model is not listed; the window is smaller than the role's fixed system context alone, so no card could fit; a role that uses tools (worker, reviewer, arbiter, the chief of staff's owner turn) gets a malformed reply to the tool round trip. The message names the role, the model and the fix.
- **Warnings, acknowledged once:** the window is smaller than the role's estimated load, but larger than its system context. Warnings say "this model's window is 8,192 tokens and the reviewer's context is about 21,000" rather than "this model may be weak". Tool-less calls skip the tool round trip.
- **When it runs:** once per run, before any goal. The estimate is fixed per role: its system context, a typical card, and the role's document budget (`context.pull`'s limit), plus a margin. Before each goal, the run logs the card-specific estimate and records it as a metric, but never stops or asks.

### The acknowledgement

The first time a project runs with any role on a local model on this host, and again whenever the set of local models or a warning changes, the run prints the check's results and waits for the person to type `I understand`. That acknowledgement is stored on the run host in `.swarm/state/local-models-ack.json` and is not committed. It is keyed by role, model and warning kind (`window_below_estimate`), never by the numbers, so a run the brain dispatches is not stopped again card after card (my call). A run the Swarm OS brain dispatches has no terminal: when no matching acknowledgement exists, it exits before work with the reason `local_models_unacknowledged`, and the brain posts the check's results in the board's room with the command to run on that host. `swarm local-models check` runs the check and takes the acknowledgement without starting a run.

### Privacy and the NDA wall

`privacy: "local"` makes start-up refuse if any of these is a remote service:

- a role's backend;
- a small call's target;
- the embedder;
- the Substrate endpoint, which `local_only` already guards.

**What counts as local (my call).** An endpoint is local when its host is loopback, or is listed in `local_models.trusted_hosts`. That list is for a machine the owner controls on the LAN or tailnet, such as a Mac Studio that serves Ollama to a laptop. Anything else is remote. `local_only` is extended to the URLs this design adds, `local_models.providers` and an `openai-compatible` provider, which must be local by that rule. It does not refuse Claude Code or codex roles, so today's `local_only` projects keep running unchanged. `privacy: "local"` is the stronger promise that adds that refusal. Telemetry stays opt-in, and under `privacy: "local"` it refuses to upload.

**Tokens (my call).** Local tokens are recorded and shown like any others, with a `locality` label (`local`, `remote`). A run's own token budget guard counts them, because it stops runaway sessions whatever they cost. The brain's `tokens_per_hour`, `tokens_per_day` and a registration's `tokensPerHour` count only remote tokens, since they exist to bound paid use. `max_instances` is the brake on local load.

### The chief of staff on OpenCode

`cos.harness` (`"agent-sdk"` by default, or `"opencode"`) and `cos.model` (`provider/model` for OpenCode) choose the chief of staff's harness.

- **Owner turns.** It runs as an OpenCode session with every built-in tool denied. It gets one MCP server, `swarm os cos-mcp`, a stdio helper the brain starts per turn with a token that is valid for that turn only and acts as `cos`. The helper relays the command tools, `read_store` and `remember` to the brain's API, where the executor re-validates every call exactly as it does for the Agent SDK. Safety still never depends on the model.
- **Readiness and follow-up turns** are tool-less and go to the endpoint directly.
- **The injection corpus** keeps running in the test suite against a scripted model. Against the configured harness and model it runs on demand, with `swarm os cos selftest` (my call). That costs minutes on a local model and subscription tokens on Claude, so it never runs on every start. A case fails when the model calls a tool, or proposes a command, that the injected text asked for. The stored result, with its date, model and pass count, is shown at `swarm os start` and in `/health`. It is reported, never refused, because the executor's limits hold whatever the model does.

This lives in plan 06 as one more task. The rest is a new plan, "local models via OpenCode", which runs after plan 04 and plan 10's remaining tasks and before plan 05 (my call, so the first hands-on test of Swarm OS is not delayed).

### Remote hosts

A run on another machine uses that machine's endpoint, and its check runs there, so nothing about local models crosses the network between the brain and the host. Telling the dispatcher which host has which model is left for later.

## Accepted when

The plan's last task is a proof the controller runs live, on this Mac, against a scratch repository, never a client project. A worker, reviewer and arbiter on `ollama/gpt-oss:20b-64k` through OpenCode carry one small card to a merged commit. The labels and synopses run on the same model. The run is fenced so it can reach only loopback: the proof records every outbound connection with the host's tools and shows none leaves the machine. Unit and integration tests use recorded OpenCode event fixtures that the first task's probe captures, and a fake OpenAI-compatible endpoint. Live-model tests stay out of the suites. The proof may use the owner's Ollama and OpenCode, which also serve the embedder, and runs one model at a time (my call).

## Decided with the owner's approval (2026-10-25)

The owner approved the design with these two recommendations as written.

1. **A private project and the chief of staff.** `swarm os register` refuses a project with `privacy: "local"` unless the brain's chief of staff, for every turn kind (`cos.model` and `cos.readiness_model`), runs on a local model. The other options were sending that project's turns to a local model, or keeping its content from a remote chief of staff. Both were rejected: the first splits its memory across two models, and the second leaves it deciding about cards it cannot read.
   - The registration's existing `privacy` field carries the promise: `"local"` joins `"normal"` and `"local_only"`. The host's `swarm os host check` reads the project's own setting, so the brain enforces it for a project on another machine. A registration whose field disagrees with the project's setting is refused.
   - Changing `cos.harness` or `cos.model` to a remote model while such a registration exists is refused at config load, naming the registrations.
2. **How far the promise reaches.** `privacy: "local"` covers model inference (every role, small call and chief-of-staff turn), embeddings, the PR categorizer, telemetry and Substrate. Boards (Trello, GitHub) and git hosting carry on as the project configured them, because the owner chose those services for the project's work. Room messages between a run and its brain are swarm's own traffic. They go only to the brain the owner runs, so they're outside the promise.

## Left to the builder

- The JSON event names and the exact config keys in OpenCode 2.1.4. The first task's probe settles them.
- How the token estimate weighs documents the role may or may not pull.
- Whether per-role OpenCode agents (`--agent swarm-<role>`) or one agent with per-session permissions reads more simply.
- Exact wording of the warnings and the acknowledgement screen, within the rules above.

## Calls I made

- **Small calls skip the harness.** One-shot calls with no tools go straight to the endpoint rather than through OpenCode, because a private OpenCode server per label would cost seconds each for nothing.
- **The fallback is the existing loop.** It is swarm's own API worker loop with a base URL added, rather than a new tool loop.
- **The acknowledgement is stored per host,** keyed by models and warnings. An OS-dispatched run without one exits and asks in the room instead of waiting at a prompt nobody sees.
- **`privacy: "local"` is a project setting that refuses to start,** rather than a warning.
- **The chief of staff's tools reach OpenCode** through a per-turn stdio helper, mirroring `swarm room-mcp`, rather than a network MCP endpoint on the brain.
- **Plan order:** the new plan runs after plan 04 and plan 10, and the chief-of-staff part joins plan 06.
- After the builder check: what stops a run and what warns; acknowledgements keyed by warning kind, not numbers; what counts as local, and `local_only` left unchanged for Claude Code and codex; local tokens outside the brain's hourly and daily limits; the injection corpus run on demand; the live proof on this Mac.
