#!/usr/bin/env bash
# Smoke the Substrate sidecars from the compiled swarm binary.
#
# Usage: bash scripts/smoke-substrate-sidecar.sh [path-to-swarm-binary]   (default ./swarm)
#
# Runs entirely against the isolated test stack (docker-compose.test.yml, ports
# 42337/42338/42340/42341) with HOME pointed at a temp dir, from a scratch CWD
# with no node_modules and no .swarm/, so it never touches ~/.swarm or the
# default ports (32337-32341). Needs docker, node 26.2+, curl, jq. The first run installs
# the Substrate runtime from npmjs into the temp HOME (a minute or two).
# Idempotent; tears the compose stack down and stops the sidecars on exit.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-$REPO/swarm}"
case "$BIN" in /*) ;; *) BIN="$(pwd)/$BIN" ;; esac
[ -x "$BIN" ] || { echo "binary not found or not executable: $BIN" >&2; exit 2; }
COMPOSE=(docker compose -f "$REPO/docker-compose.test.yml")

# Docker finds its config, contexts and compose plugin under $HOME: pin them before HOME moves.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/swarm-smoke.XXXXXX")"
# lsof reports resolved paths (/private/var/... on macOS): resolve ours the same way.
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
export HOME="$SCRATCH/home"
mkdir -p "$HOME" "$SCRATCH/cwd"
STACKS="$HOME/.swarm/substrate/stacks"

export SWARM_SUBSTRATE_PORT=42338
export SWARM_SUBSTRATE_POSTGRES_URL=postgresql://swarm:swarm@127.0.0.1:42337/swarm
export SWARM_META_PORT=42341
export SWARM_META_POSTGRES_URL=postgresql://swarm:swarm@127.0.0.1:42340/swarm_meta
unset ANTHROPIC_API_KEY SWARM_SUBSTRATE_ENDPOINT SWARM_SUBSTRATE_DEDICATED

# Sidecars of THIS run only: substrate.js serve processes started from our stack dirs.
sidecar_pids() {
  local pid
  for pid in $(pgrep -f 'substrate.js serve' || true); do
    if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qF "n$STACKS/"; then echo "$pid"; fi
  done
}

cleanup() {
  local rc=$?
  set +e
  (cd "$SCRATCH/cwd" && "$BIN" substrate stop >/dev/null 2>&1)
  for pid in $(sidecar_pids); do kill "$pid" 2>/dev/null; done
  "${COMPOSE[@]}" down -v >/dev/null 2>&1
  if [ -n "$(sidecar_pids)" ]; then
    echo "sidecar still running; leaving $STACKS in place" >&2
    [ $rc -ne 0 ] || rc=1
  else
    rm -rf "$SCRATCH"
  fi
  [ $rc -eq 0 ] && echo "SMOKE PASS" || echo "SMOKE FAIL (exit $rc)" >&2
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
now() { date +%s; }

echo "== binary: $BIN ($(du -h "$BIN" | cut -f1)), version: $("$BIN" --version)"
echo "== scratch: $SCRATCH (HOME=$HOME)"
[ -z "$(sidecar_pids)" ] || fail "sidecars already running from $STACKS"

echo "== test stack up"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait

cd "$SCRATCH/cwd"
[ ! -e node_modules ] || fail "scratch cwd has node_modules"

echo "== swarm substrate start (first run installs the runtime from npmjs)"
T0=$(now)
"$BIN" substrate start
echo "== start took $(( $(now) - T0 ))s"

PIDS="$(sidecar_pids | tr '\n' ' ')"
[ "$(echo "$PIDS" | wc -w | tr -d ' ')" = 2 ] || fail "expected exactly 2 sidecar pids under $STACKS after start, got: '$PIDS'"
echo "== sidecar pids after start: $PIDS"

echo "== cold schema"
COLD="$(curl -sf localhost:42338/substrate/v1/schema/swarm)" || fail "cold schema not served"
# The custom ops are published as entries of .types (Substrate lists custom queries there).
KEYS="$(echo "$COLD" | jq -c '[(.queries // {}), .types] | add | keys')"
echo "$KEYS"
for op in classifyIntent loadContext prepareTask; do
  echo "$COLD" | jq -e --arg op "$op" '((.queries // {}) + .types) | has($op)' >/dev/null || fail "cold schema lacks $op"
done
echo "== meta schema"
curl -sf localhost:42341/substrate/v1/schema/swarm_meta | jq -c '.types | keys' || fail "meta schema not served"
# The binary extracted its embedded plugin tarball into the cache.
ls "$HOME"/.swarm/substrate/cache/swarm-substrate-plugin-*.tgz >/dev/null || fail "embedded plugin tarball was not extracted"

echo "== swarm substrate status"
"$BIN" substrate status
echo "== swarm doctor"
"$BIN" doctor || true

echo "== swarm substrate stop"
"$BIN" substrate stop
sleep 1
LEFT="$(sidecar_pids)"
[ -z "$LEFT" ] || fail "sidecar still running after stop: $LEFT"
curl -sf --max-time 2 localhost:42338/health >/dev/null 2>&1 && fail "cold sidecar still answers" || true
curl -sf --max-time 2 localhost:42341/health >/dev/null 2>&1 && fail "meta sidecar still answers" || true
echo "== sidecar pids after stop: $(sidecar_pids | wc -w | tr -d ' ') (none remain under $STACKS)"
