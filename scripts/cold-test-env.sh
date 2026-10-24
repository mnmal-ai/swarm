#!/usr/bin/env bash
# Run a cold-test `swarm run` against the ISOLATED alt-port Substrate/Postgres stack.
#
# Cold tests MUST use the test stack ports, never the live defaults:
#   cold-test Substrate sidecar : 42338  (SWARM_SUBSTRATE_PORT)
#   cold-test Postgres          : 42337  (SWARM_SUBSTRATE_POSTGRES_URL)
#   meta-test sidecar           : 42341  (SWARM_META_PORT)
#   meta-test Postgres          : 42340  (SWARM_META_POSTGRES_URL)
# NEVER 32337/32338 (or 32340/32341) — those are the live orchestrator's own
# telemetry/oversight Substrate stack. A self-modifying swarm-on-swarm run that
# touched them would pollute or corrupt the runtime store.
#
# This wrapper scopes the alt-port env vars to the invoked command ONLY (it
# exports them in its own process, then execs the command), so the
# orchestrator shell's SWARM_SUBSTRATE_*/SWARM_META_* stay
# untouched and its sidecars keep running on the defaults.
#
# Usage:
#   scripts/cold-test-env.sh swarm run --cold-test ...
#   scripts/cold-test-env.sh <any command that should see the test stack>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.test.yml"

if [ "$#" -eq 0 ]; then
  echo "Error: no command given. Usage: scripts/cold-test-env.sh <command> [args...]" >&2
  exit 64
fi

# (a) Bring up the isolated stack if it isn't already running. Idempotent:
# `up -d` is a no-op on already-running containers, so we can always call it,
# but we probe first to avoid noisy output on the common warm path.
if ! docker compose -f "$COMPOSE_FILE" ps --status running --quiet | grep -q .; then
  echo "Cold-test stack not running — bringing up docker-compose.test.yml..." >&2
  docker compose -f "$COMPOSE_FILE" up -d --wait
fi

# (b)+(c) Scope the alt-port overrides to the command ONLY, then exec it.
# This script is its own process: exporting here changes this process and the
# command it execs, never the shell that invoked the script. (Not `env VAR=...
# -- "$@"`: every `env` - BSD, GNU, busybox - reads options only before the
# first assignment, so it ran `--` as the command and exited 127.)
# `exec "$@"` runs the first argument as the command even when it looks like
# `KEY=value`, so no argument is ever taken as an assignment.
#
# Note on the URLs: `swarm:swarm` is the docker-compose.test.yml test-only
# credential pair. These are NOT production secrets — the alt-port stack is
# isolated, never receives real traffic, and the same credentials are
# hardcoded in the compose file. If you reuse these elsewhere, keep them
# scoped to test infrastructure.
#
# SWARM_SUBSTRATE_ENDPOINT is load-bearing: resolveSubstrateEndpoint ranks
# the saved ~/.swarm/config.json substrate_url ABOVE SWARM_SUBSTRATE_PORT, so
# on a machine that has run `swarm` normally, that saved value (the LIVE
# sidecar) would silently win over SWARM_SUBSTRATE_PORT=42338. Setting the
# explicit endpoint closes that bypass; SWARM_META_ENDPOINT does the same for
# meta. (The *_POSTGRES_URL variables win unconditionally, so Postgres needs
# no endpoint twin.)
export SWARM_SUBSTRATE_ENDPOINT=http://127.0.0.1:42338
export SWARM_SUBSTRATE_PORT=42338
export SWARM_SUBSTRATE_POSTGRES_URL=postgresql://swarm:swarm@localhost:42337/swarm
export SWARM_META_ENDPOINT=http://127.0.0.1:42341
export SWARM_META_PORT=42341
export SWARM_META_POSTGRES_URL=postgresql://swarm:swarm@localhost:42340/swarm_meta
exec "$@"
