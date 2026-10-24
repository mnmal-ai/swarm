#!/usr/bin/env bash
# Compile the swarm CLI into a standalone binary using Bun.
#
# Usage:
#   bash scripts/compile.sh                           # native platform
#   bash scripts/compile.sh bun-darwin-arm64 swarm     # cross-compile
#
# Targets: bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64

set -euo pipefail

TARGET="${1:-native}"
OUTFILE="${2:-swarm}"

if ! command -v bun &>/dev/null; then
  echo "Error: bun is required. Install from https://bun.sh" >&2
  exit 1
fi

ARGS=(build --compile --outfile "$OUTFILE" packages/cli/src/cli/main.ts)

if [ "$TARGET" != "native" ]; then
  ARGS+=(--target "$TARGET")
fi

# Generate version info from git tags before compiling
(cd packages/cli && node ../../scripts/generate-version.mjs) 2>/dev/null || true

echo "Compiling swarm CLI..."
echo "  Target: $TARGET"
echo "  Output: $OUTFILE"

bun "${ARGS[@]}"

echo "  Size: $(du -h "$OUTFILE" | cut -f1)"
echo "Done."
