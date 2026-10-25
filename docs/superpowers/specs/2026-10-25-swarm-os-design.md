# Swarm OS: a daemon that dispatches runs and talks

**Status:** design, awaiting approval. **Date:** 2026-10-25.

## Intent

Today a person starts every run: a card lands on a board, someone notices, goes to a terminal, and types `swarm run`. The run is a foreground process, the dashboard dies with it, and a worker that needs a human waits on a terminal nobody is watching.

Swarm OS turns that around. A long-lived process, the **brain**, is the thing that is always up. Boards tell it when work arrives, it decides whether to act, and it starts today's `swarm run` as a short-lived **instance** for one ticket. Its face is the **chief of staff**: one dedicated agent the owner talks to in plain language, in a chat window at the centre of the dashboard and the TUI, which dispatches, holds and explains on the owner's behalf. Everything that happens, between the brain and its instances, between workers, and between the system and its humans, is a message in a shared space the humans are part of. A question from a worker at 2am reaches a phone and gets answered there, and the answer reaches the worker.

The run itself does not change. `swarm run` is what the brain dispatches.

## Goals

1. **It stays up.** The brain survives a crash of itself, of an instance, of Substrate, of the network, and of the machine, and comes back knowing what was in flight.
2. **Work arrives on its own.** A card appearing on a registered board results in a dispatched run without anyone touching a terminal, when the dispatch policy says yes.
3. **One place to talk.** Humans, the chief of staff, and every agent in every run share one messaging space, with real push to a phone. Anything the CLI or TUI can do can be done from the chat, by asking the chief of staff or by typing the command.
4. **Runs on this machine or deployed.** The brain can run on a Mac with instances as local processes, or on a server with instances elsewhere, without a different design.
5. **The same picture everywhere.** Chat, TUI and the existing per-run dashboard show the same state, from the same source.

## Non-goals

- Replacing `swarm run`, the orchestrator, oversight, the merge queue or the Substrate plugin. They are dispatched, not redesigned.
- Multi-tenant hosting. One brain serves one organisation's humans.
- A native mobile app in the first version. The chat is a web app that installs to the home screen and receives Web Push.
- Scheduling across a fleet with placement decisions. The remote launcher in this design starts an instance on a named host; it does not pick hosts.

## Anti-goals

- **A brain that spends tokens on its own.** Dispatch decisions use a small model once per card; the brain never runs a worker itself.
- **A chat that can do less than the terminal.** If a command exists in the CLI and not in the chat, that is a bug, not a scope cut.
- **Silent drops.** A card the brain will not take, a board it does not know, a run that died: each becomes a message to a human, never a log line only.
- **An instance that outlives the brain's knowledge of it.** A run the brain cannot see is a run nobody can stop from a phone.

## Vocabulary

- **Brain**: the daemon. `swarm os`. One per deployment.
- **Chief of staff**: the brain's agent. One per deployment, the owner's own. It is the participant that talks, decides and commands; the brain is the process it runs in.
- **Instance**: one `swarm run` process, started by the brain for one ticket. Has a run id, a room, a launcher handle.
- **Board**: a task source (Trello board, GitHub repository) the brain watches.
- **Registration**: the binding of a board to a project: its swarm directory, its work repo, its Substrate stack, its limits, its minimum queue depth.
- **Room**: a channel in the messaging space. One per instance, one per board, one for the brain itself ("system"), and direct rooms between any two participants.
- **Participant**: a human or an agent with a name, a kind and a set of permissions. Workers, reviewers, arbiters, the chief of staff and humans are all participants.
- **Launcher**: the interface the brain uses to start, watch and stop instances. Local first, remote later.

## Architecture

```
  board webhooks ──┐                                  ┌── chat (web app, push)
  board polling ───┤                                  ├── TUI (swarm top)
                   ▼                                  ├── CLI (swarm os …)
            ┌─────────────┐   HTTP + WebSocket API    │
            │    brain    │◄─────────────────────────┘
            │  swarm os   │
            └──┬──────┬───┘
   launcher ───┘      └─── OS Substrate (registry, rooms, messages, instances)
      │
      ├── instance: swarm run --card <id> (project A, its own Substrate stack)
      ├── instance: swarm run --card <id> (project B)
      └── …   each instance: heartbeat + events + messages → brain
```

**One API.** The brain exposes one HTTP and WebSocket API. The chat, the TUI and the `swarm os` CLI subcommands are three clients of it and have no other way in. An instance also talks to the brain only through this API (a token per instance), so a remote instance is no different from a local one.

**One store.** The brain's own state lives in Substrate, in a dedicated stack the brain owns (the "OS stack"), in new types under a `swarm-os` namespace: `Board`, `Registration`, `Instance`, `Room`, `Participant`, `Message`, `Decision`, `Resource`. Per-project stacks are untouched and stay `local_only` where they are today. Nothing the brain stores is needed to re-derive a run; a run's own record stays in its project's stack as it does now.

**Processes.** The brain is one Node process built from swarm's existing packages, run under a supervisor (launchd on a Mac, systemd or a container restart policy on a server). Instances are child processes of the local launcher or remote processes of the remote launcher. The chat is static files served by the brain plus a service worker for push. The TUI is `swarm top`, a terminal client of the same WebSocket.

## The chief of staff

The chief of staff is a long-lived agent session the brain owns, with a model of its own (configured; a capable one, since it decides what spends money), memory in the OS stack, and the command set below as its tools. It is the only agent with command authority.

**It talks.** Its room is the chat window on the dashboard's and the TUI's main screen. "What's running?", "why didn't you take BUG-12?", "take it anyway", "pause the backend board until tomorrow", "register this board to that project" are all things said to it in prose; it answers from the same state the TUI shows and acts through the same commands the CLI calls. Slash commands still work in every room, for people who prefer them and for the CLI and TUI acting without it.

**It acts by default.** When a card arrives and the standing orders (the policy chain below) say dispatch, the chief of staff dispatches and tells the owner what it did. A registration can set `ask_first: true`, and then it proposes in the board's room and waits for a yes; nothing else makes it wait. The "ask the owner" outcome of the readiness check is the chief of staff raising the card in the chat with its reasoning already in hand.

**It remembers.** Standing decisions ("never take cards labelled `design` on that board", "overnight means 22:00 to 07:00 for me"), the owner's answers to past questions, and what it did and why are rows in the OS stack it reads before every decision, so the owner says things once. It also holds the full log of every room the brain owns, for every project, and the chat shows those rooms as channels, so a worker's back-and-forth from last week can be opened and scrolled like a Slack channel.

## Ingress: how work arrives

1. **Webhooks first.** Trello and GitHub both call out. The brain exposes `/hooks/trello/<board>` and `/hooks/github/<repo>`, verifies the signature, and turns the payload into one `card.arrived` or `card.changed` event. Webhook delivery is at-least-once and sometimes never, so:
2. **Polling is the backstop, always on.** Every registration is polled on an interval (default 2 minutes) through today's task sources (`TrelloExternalSource`, `GitHubExternalSource`), and the brain reconciles what it sees with what it knows. A webhook makes the brain react in seconds; polling makes it correct within minutes. A board that cannot call out just has polling.
3. **Every card has one identity.** `board + card id`. Arrivals are idempotent: a second webhook, a poll after a webhook, a restart mid-poll, all converge on one `Decision` per card per state.

## Registry and the dispatch policy

A `Registration` says: board, queue column, project (swarm directory, project name, work repo, Substrate stack, and the launcher host they live on), limits (max instances at once, tokens per hour), `min_cards`, `privacy` (below), and `notify` (which humans own this board).

**`min_cards` is a threshold to start draining, not a gate on every card.** When the project has no instance running, the brain dispatches only if the queue holds at least `min_cards` (default 3; cards in flight count). Once draining has started it continues card by card until the queue is empty, so a batch's last cards never sit stuck. A human override (`/override min_cards board:<name>`) starts draining whatever the depth, lasts until the queue is empty or it is revoked, and is recorded as a `Decision`.

When a card arrives or changes, the brain runs the policy chain in order. Each step is a named check with a result the `Decision` records, so a human can ask "why not?" and get the list:

1. **Known board.** No registration: message the OS owners in the system room with the card and a drafted registration (project, repo and stack inferred from existing swarm directories on the machine, if any). A "yes" from an owner creates it; nothing is created silently.
2. **Taken column and labels.** The card is in the registration's queue column, and carries no label the project's config lists as "not for swarm".
3. **Not already in flight.** No live instance on this card, and no instance on this project beyond the registration's `max_instances` (default 1, because one work repo and one merge queue per project is what the orchestrator assumes today).
4. **Queue depth.** The project is already draining, or the queue holds at least `min_cards`, or an override is active.
5. **Room on the machine.** The launcher reports resources (below) and the brain refuses when adding an instance would exceed them.
6. **Ready to work.** The chief of staff reads the card against the registration's description of the project and its own memory, and answers one of `dispatch`, `hold` with a reason, or `ask` with a question for the board's owners. `ask` posts the question in the chat and waits; the card stays held until a human answers, and the answer becomes part of the dispatch (as added context on the goal). Steps 1 to 5 are deterministic and run before any model is consulted, so a card that fails them costs nothing.

The outcome is one of: an `Instance` started, and told to the owner; a `hold` recorded with its reason and a message in the board's room; an `ask` in the chat; or a notification to OS owners for an unknown board. With `ask_first` on the registration, a would-be dispatch is an `ask` too. Holds are re-evaluated on every later event for the card and on every poll.

## Dispatching an instance

An instance is `swarm run --card <id> --yes --no-tree --os <brain-url> --os-token <token>` run in the project's swarm directory. Two additions to `swarm run` make this possible:

- **`--card <id>`** pins the run to one goal from its task source instead of taking the top of the queue. The source fetches that card and nothing else. (`--goal <id>` for the local backend, `--issue <n>` for GitHub, with one implementation.)
- **`--os <url>` with `--os-token`** registers the run with a brain: the run heartbeats every 15 seconds, streams its event bus to the brain (the same events the dashboard shows), joins its room as a participant, and takes commands from the room (pause, stop, answer to a question). Without `--os` nothing changes; a plain `swarm run` is still a plain `swarm run`.

The **launcher** interface is small: `start(spec) → handle`, `status(handle)`, `stop(handle, mode)`, `resources()`. The local launcher spawns the process, captures its exit, and reports the machine's resources. A remote launcher does the same over SSH or a container API on a named host; it is the second implementation, not the first, and the brain never assumes it shares a filesystem with an instance.

**Checkpoints are per card.** A run started with `--card` keeps its checkpoint under the card's id, not the project's, so one card's unfinished state never resumes into another card's run. `/retry run-x` dispatches a new instance that resumes that checkpoint; `/retry run-x --fresh` discards it. The run's own terminal prompts (resume or fresh, a token overrun's increase/skip/abort) are posted to the room as questions when a brain is attached, with the non-interactive default taken after `ask_timeout` (below).

**Pause means two things, named apart.** `/pause board:<name>` stops the brain dispatching from that board and holds nothing else. `/pause run-x` is today's graceful pause: the instance finishes its task, checkpoints and exits, and is marked `paused`; `/resume run-x` dispatches a new instance that resumes the card. There is no pause that keeps a process alive and idle.

**Dead instances.** A missed heartbeat for 90 seconds marks the instance `unresponsive` and messages its room and the board's owners; the launcher's `status` decides whether the process is actually gone. A gone instance's card goes back to the policy chain, which holds it: a crashed run on a card is a reason to ask a human before trying again. A run that exits because a login expired puts its card back in the queue column today; with a brain attached it reports `login_expired` instead, the brain holds every board that project serves, and the OS owners are told.

## Messaging

The messaging space is the operating system's bus, not an add-on.

**Model.** `Room { id, kind: system | board | instance | direct, members }`, `Participant { id, kind: human | brain | worker | reviewer | arbiter | instance, name, permissions }`, `Message { id, room, from, at, kind: text | command | question | answer | event | file, body, reply_to, visibility }`. Messages are rows in the OS stack; delivery is over the brain's WebSocket to connected clients and over Web Push to phones.

**Rooms are created with their subject.** An instance's room opens when it is dispatched and holds every participant of that run: the instance itself (for commands), each worker, reviewer and arbiter session as it starts, and any human who joins. A board's room holds the brain and the board's owners. The system room holds the brain and the OS owners. Direct rooms open on first message.

**Agents speak through tools.** Each session in an instance gets an MCP server from the instance (`swarm-room`, registered the way `swarm mcp` registers servers today) with four tools: `send` (post to the run's room or a direct room), `read` (recent messages, filtered by room or sender), `ask_human` (post a `question` and wait for the `answer`; this is how `onClarifyingQuestion` is served when a brain is attached), and `who` (participants and what they are doing). Two workers coordinating on a shared file, a reviewer asking a worker why, a worker asking a human: all four are `send` or `ask_human`. The session's own instructions tell it when to use them.

**Waiting for a human.** A worker that has asked blocks and waits; the run stays alive and keeps its slot, and the three timers that would otherwise end the session (the tool-wedge watcher, the Agent SDK query timeout, the orchestrator's worker heartbeat) are suspended while a question is open. How long it waits is config on the registration, with brain-wide defaults: `ask.min_wait` (30 minutes; a question is never given up on sooner), and `ask.quiet_windows` (for example 22:00 to 07:00 in the owner's time zone; a question still open when a window starts waits until it ends). When the wait runs out, the worker does not simply guess. It asks the OS stack first: how the same question, or one like it, was answered before on this project or by this owner, and what the project's context and standing decisions say. With a confident match it proceeds on that answer and says so in the room, naming its source; without one it proceeds on its best reading and says that instead. Either way the open question stays in the chat, and a late answer that contradicts what the worker did is raised by the chief of staff as a follow-up card. Parking the task and resuming it in a fresh session when the answer comes is the second iteration; it needs the orchestrator to checkpoint mid-task and is out of this design's scope.

**Commands are messages.** A `command` message is the CLI's argument vector with a target: `/pause board:<name>`, `/stop run-x gracefully`, `/dispatch board:<name> card:42`, `/override min_cards board:<name>`, `/register …`, `/top`. The brain executes the same code the `swarm os` subcommands call, replies in the room, and records the command as a `Message` so the room is the audit log. **Every CLI and TUI capability is reachable this way**, the OS commands and the whole `swarm` CLI alike (`merge`, `sync`, `db`, `substrate`, `skill`, `mcp`, `logs`, `upgrade`). The cost is known: those commands print, prompt and `process.exit` today, so each becomes a function that returns its output and asks its questions through the room before the brain can run it; that refactor is part of this work, done command by command, with the OS commands and run controls first. A command that destroys or spends (`db reset`, `substrate stop`, `merge`, `upgrade`) asks for a confirming reply in the room before it runs, from a phone as from a terminal.

**Authority.** Humans have everything. The chief of staff has everything, within the standing orders and `ask_first`. Workers, reviewers and arbiters can `send`, `read`, `who` and `ask_human`; they cannot issue commands that start, stop or configure anything. A worker that wants a run paused asks a human, or the chief of staff, who decides as a human would.

**Push.** The chat is a web app with a service worker; the brain holds a VAPID key pair and sends Web Push for messages addressed to a human (questions, holds, unknown boards, dead instances, direct messages), with per-human quiet hours and per-room mute. Push carries the room and a one-line summary; the message body is fetched when the app opens.

**Visibility.** Every participant sees the rooms it is a member of. Humans and the chief of staff see all rooms, live and historic. An agent sees its run's room and its direct rooms; a worker cannot read another instance's room.

**Private projects.** The OS stack is the owner's and counts as local: a `local_only` project's rooms are stored in it with full content, including workers' messages, like every other project's. The wall is where the brain runs: a brain serving a `local_only` project runs on the owner's machine or on infrastructure the owner controls, and `swarm os register` refuses a `local_only` project when the OS stack is not on such a host. Push notifications for a private project carry the room and kind only ("a question from a run on board X"), never card text, since they cross Apple's and Google's servers; the body is fetched when the app opens.

## Resources

The launcher reports a `Resource` snapshot every heartbeat: CPU and memory in use and free, open Claude Code sessions, instances running, tokens spent this hour per project, Substrate connection pools per stack, dashboard ports in use. The brain keeps the latest and a short history. Limits live in the registration (per project) and in the brain's config (per machine). The TUI's top panel and the chat's `/top` reply are this snapshot, plus each instance's line: card, project, phase, current task, tokens, elapsed, last heartbeat.

## Clients

- **Dashboard (web app).** The chief of staff's chat in the middle, the resource line and active instances at the top, every room down the side as channels (boards, live instances, past instances, direct), a command bar at the bottom with completion for the command set. Installs to a phone's home screen, receives push. Passkey login for humans; one owner is bootstrapped on first `swarm os init`.
- **TUI (`swarm top`).** The same WebSocket, rendered in the terminal with the same layout: the chief of staff's chat in the main pane, resources and instances above, rooms in a side list, a command line. The existing per-run dashboard stays as it is and is linked from the instance's line, since an instance still serves it on its own port.
- **CLI.** `swarm os init | start | stop | status | register | unregister | dispatch | hold | override | top | say`. Each is a command message sent to the brain's API and the reply printed.

## Reliability: it does not go down

- **Supervised.** `swarm os install` writes a launchd agent on a Mac (and a systemd unit elsewhere) that restarts the brain on exit and starts it at login.
- **Nothing only in memory.** Registrations, instances, decisions, rooms and messages are in the OS stack before the brain acts on them. On start the brain reads instances marked live, asks the launcher which are still running, and reconciles: running ones are re-attached (the instance reconnects with its token), gone ones are marked and their cards re-decided.
- **Webhooks are never the only signal.** Polling catches what a down brain missed.
- **Substrate down.** The brain brings its OS stack up itself at start, as `swarm run` brings a project's stack up. While the stack is unreachable the brain keeps serving reads from its last snapshot, refuses new dispatches, and messages the OS owners; commands and messages that must not be lost (a stop, an answer to a worker's question) are appended to a journal on local disk, acted on, and replayed into Substrate when it returns. The journal is a write-ahead log for the OS stack, not a second store: nothing is read from it except on replay.
- **Watched.** `/health` says what the brain can and cannot reach. The supervisor's restart is the last resort, not the first.
- **Tested for it.** The acceptance test for goal 1 kills the brain, Substrate and an instance in turn during a dispatched run and checks the chat still shows the truth afterwards.

## Security

- Webhooks are verified (Trello's signature on the callback URL, GitHub's HMAC). Unverified calls are dropped and counted.
- Instances authenticate to the brain with a per-instance token issued at dispatch and revoked at exit.
- Humans authenticate with passkeys; the API is HTTPS when deployed and loopback-only on a Mac unless configured otherwise.
- `local_only` projects stay local-only: the brain never proxies a project stack. The dashboard's existing network warning applies to the chat's `--lan` equivalent.
- Message bodies never contain tokens or keys; the room tools strip anything matching the existing secret patterns before posting.

## Deployment

One config file, `~/.swarm/os.json`: API bind address, public URL (for webhooks, push and passkeys), launcher (`local` or `remote` with hosts), OS stack location, VAPID keys, owners, machine limits, poll interval, and the brain's own board credentials. `swarm os init` writes it with the local launcher and creates the OS stack the way `swarm init` creates a project stack. A container image with the same config runs it on a server; the remote launcher is the only piece that differs.

**Reaching the brain from a phone.** Passkeys and Web Push both need a stable HTTPS origin, and an IP address is not one. On a Mac the brain binds to loopback and `swarm os init` sets it up behind Tailscale Serve, which gives the machine a stable name with a certificate and keeps the chat inside the owner's tailnet; the public URL in the config is that name, chosen once, because changing it invalidates every enrolled passkey. Deployed, the brain sits behind the owner's own domain and TLS. Webhooks need an inbound public URL, which Tailscale Funnel or the deployed domain provides; until then polling carries ingress.

**Board credentials belong to the brain.** Polling and webhooks use tokens the brain holds in its config (a Trello key and token, a GitHub token or app), through the same task-source clients `swarm run` uses but without a work repo or a project directory, so the brain works the same whether or not a project's files are on its disk. An instance still uses the project's own credentials and account for its work, as today. The readiness check reads the card and the registration's description of the project, not the project's repo. Unknown boards are seen only through organisation-level webhooks (a GitHub organisation hook, a Trello webhook on the member) or a list of boards the brain's credentials can see; a card on a board outside both is invisible, by design.

## The first proof

Goal 1 and goal 2 end to end, and nothing else:

1. `swarm os init`, `swarm os register` for one board with `min_cards: 3`, `swarm os start` under launchd.
2. The owner's phone has the dashboard installed, receives a test push, and the chief of staff answers "what's running?" in the chat.
3. A card is created on the board. Within the poll interval (no webhook yet), the chief of staff decides, dispatches `swarm run --card`, tells the owner, and the instance's room shows its events.
4. A worker calls `ask_human`; the question arrives as a push; the answer sent from the phone reaches the worker; the run completes and the PR opens. A second question is left unanswered past `ask.min_wait` and the worker proceeds on what the OS stack says, saying so.
5. During a second run the brain is killed; it comes back, re-attaches the instance, and the chat shows it running.
6. A board with two cards is not dispatched; "take them anyway", said to the chief of staff from the phone, makes it run.

Webhooks, the remote launcher, worker-to-worker messaging, the TUI beyond a status screen and `/top`, and quiet hours come after that proof, in that order.

## Left to the builder

- The WebSocket protocol between clients and brain, and between instance and brain, as long as both are one protocol.
- The journal's format.
- How `--card` is threaded through the task sources (one method on `ExternalTaskSource`).
- The chat's visual design, beyond the layout above.
- Which model the chief of staff runs on, as long as it is configured and never a worker's session.
- How the three session timers are suspended while a question is open.
- Retention of messages and resource history.
- How the launchd and systemd files are generated.

## Calls I made

Marked as mine, for the owner to check:

- The brain's own state goes in a dedicated Substrate stack rather than in a project stack or SQLite, so the brain and a deployed brain store the same way and the OS's rooms are queryable like everything else in swarm.
- `max_instances` per project defaults to 1 because today's orchestrator assumes one work repo and one merge queue per project; raising it is a later change in the orchestrator, not in the brain.
- Only the chief of staff among agents can issue commands. A worker that wants something started or stopped asks.
- Slash commands remain alongside the chief of staff rather than it being the only way in, so the CLI and TUI can act without a model in the loop.
- The chief of staff's memory and the room logs live in the OS stack as Substrate rows, so they are queryable and recalled like everything else in swarm.
- Web Push through an installable web app rather than a native app, so the first version needs no app store and one codebase serves phone and desktop.
- Polling stays on even when webhooks work.
- The per-run dashboard is kept as it is and linked from the instance, rather than merged into the chat in the first version.
- Checkpoints become per card when `--card` is given; this is the third change to `swarm run`, alongside the two flags.
- `min_cards` is a start-draining threshold, with cards in flight counting toward depth.
- Tailscale Serve is the default way a phone reaches a brain on a Mac; a deployed brain uses the owner's domain.
- The brain holds its own board credentials and polls without a project directory; instances keep using the project's.
- A local write-ahead journal covers the OS stack being down; it is replayed, never read.
