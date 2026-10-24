# Environment Variables

## Substrate / meta store

These point swarm at its Substrate sidecars and backing Postgres. They follow the
`env ?? default` pattern: when unset, swarm uses its **shared default stack on
32337-32341**, which every project without a dedicated stack shares. The sidecars
run from `~/.swarm/substrate/runtime` (Node 26.2 or newer is required; `SWARM_NODE`
names an absolute path to one).

| Variable | Default | Purpose |
|---|---|---|
| `SWARM_SUBSTRATE_ENDPOINT` | `http://localhost:32338` | Cold sidecar URL the client dials; ranks above a saved `substrate_url` and `SWARM_SUBSTRATE_PORT` |
| `SWARM_SUBSTRATE_PORT` | `32338` | Cold sidecar port |
| `SWARM_SUBSTRATE_POSTGRES_URL` | `postgres_url` in `~/.swarm/config.json` when its `db_mode` is `connection_string` (saved by `swarm db setup` for a Postgres you bring), else `postgresql://swarm:swarm@localhost:32337/swarm` | Cold-store Postgres (`memory` selects an in-memory store). A project's `substrate.postgres_url` is applied through it; either outranks the saved `postgres_url` |
| `SWARM_META_ENDPOINT` | `http://localhost:32341` | Meta sidecar URL |
| `SWARM_META_PORT` | `32341` | Meta sidecar port |
| `SWARM_META_POSTGRES_URL` | `postgresql://swarm:swarm@localhost:32340/swarm_meta` | Meta-store Postgres |
| `SWARM_SUBSTRATE_LOCAL_ONLY` | unset | `1` makes swarm and the sidecars refuse any non-loopback endpoint, Postgres or embedder URL |
| `SWARM_SUBSTRATE_DEDICATED` | unset | Set by swarm for a project with its own stack; the machine-wide `swarm db` commands refuse to run |
| `SWARM_NODE` | `node` on PATH | Absolute path to the Node (26.2 or newer) that runs the sidecars |

> Default ports: cold-store PG **32337**, cold sidecar **32338**, meta-store
> PG **32340**, meta sidecar **32341**. Tests never use them: they run on ephemeral
> ports or the 42337-42341 test stack (below).

## Semantic recall (embedder)

The cold sidecar loads Substrate's recall plugin, which embeds the `SwarmContent`
corpus into pgvector and lets `classifyIntent` / `loadContext` augment their
keyword/path baselines with embedding similarity. Embeddings are **local-first via
Ollama**: no external embedding API. The default model is `nomic-embed-text` at 768
dimensions; another model needs `SWARM_EMBEDDER_DIMENSION`.

| Variable | Default | Purpose |
|---|---|---|
| `SWARM_EMBEDDER_KIND` | `ollama` | `ollama` or `none` (no embedder, no recall config) |
| `SWARM_EMBEDDER_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server the embedder calls |
| `SWARM_EMBEDDER_MODEL` | `nomic-embed-text` | Embedding model |
| `SWARM_EMBEDDER_DIMENSION` | the model's known size, else 768 | Vector size |
| `SWARM_EMBEDDER_TIMEOUT_MS` | `15000` | Per-embed timeout for ranking queries |
| `SWARM_EMBED_ON_WRITE` | unset | `1` embeds stored rows when they are written (set by `context.ranking`) |

swarm writes these into the stack's `substrate-recall.config.json` when it starts a
sidecar. If Ollama is unreachable, recall **degrades gracefully** to the keyword/path
baseline. Pull the model with `ollama pull nomic-embed-text` to enable semantic recall.

## Testing against an isolated Substrate

Swarm's own test runs never touch the default-port store. Unit and integration
tests use a mocked client; any test that needs a **real** sidecar runs against a
private one, never the default ports (32337-32341).

The vitest `globalSetup` at `tests/setup/isolated-substrate.ts` does nothing unless
`SWARM_SDK_E2E=1`. Then it spawns two `substrate serve` processes from the
workspace's own `@mnmal-ai/substrate`, with the built swarm plugin (and cortext) in a
temp `SUBSTRATE_PLUGIN_DIR` each: the cold sidecar (`swarm`, `swarm-docs`, `cortext`)
and the meta sidecar (`swarm_meta`), on the memory store, on ephemeral loopback ports,
with HOME pointed at the run's temp directory. It sets `SWARM_SUBSTRATE_ENDPOINT`,
`SWARM_SUBSTRATE_PORT`, `SWARM_META_ENDPOINT` and `SWARM_META_PORT` for the test
process only — never in the orchestrator shell. Recall is wired to local Ollama
(`nomic-embed-text`) when it answers; otherwise recall-dependent suites skip with
"recall suites need Ollama". With `SWARM_SDK_PG=1` the sidecars run on the alt-port
docker stack instead (`docker-compose.test.yml`, Postgres on 42337/42340; only
`SWARM_TEST_POSTGRES_URL` / `SWARM_TEST_META_POSTGRES_URL` override it, and only with
a loopback URL on those ports). Suites that need an empty store spawn their own
sidecar through the same helper (`startTestSubstrate()`), also only under
`SWARM_SDK_E2E=1`: a plain run starts no process. The paid suites (the `claude` CLI,
the Anthropic API) need the separate opt-in `SWARM_SDK_CLAUDE=1`.

When no env is set, the defaults remain intact (the `env ?? default` pattern), so a
test run leaves a stack on the default ports alone. Cold tests run through
`scripts/cold-test-env.sh` (or `pnpm cold-test:env`), which brings up
`docker-compose.test.yml` and scopes the alt-port vars (sidecars 42338/42341,
Postgres 42337/42340) to the invoked command only — see the Cold-Test Runbook in
`CLAUDE.md`.
