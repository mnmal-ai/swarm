#!/usr/bin/env bash
# Build the Substrate plugin and pack it into packages/cli/assets so the CLI
# (and the compiled Bun binary) can embed it. Runs as the cli `prebuild`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ASSETS="packages/cli/assets"
PLUGIN="@mnmal-ai/swarm-substrate-plugin"
mkdir -p "$ASSETS"

VERSION="$(node -p "require('./packages/substrate-plugin/package.json').version")"
PACKED="$ASSETS/mnmal-ai-swarm-substrate-plugin-$VERSION.tgz"

rm -f "$ASSETS"/*.tgz
pnpm --filter "$PLUGIN" build
pnpm --filter "$PLUGIN" pack --pack-destination "$ROOT/$ASSETS"
mv "$PACKED" "$ASSETS/swarm-substrate-plugin.tgz"
echo "Packed $ASSETS/swarm-substrate-plugin.tgz ($VERSION)"
