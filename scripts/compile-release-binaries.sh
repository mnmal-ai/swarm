#!/usr/bin/env bash
# Compile the swarm CLI into standalone Bun binaries for every shipped platform
# and emit .sha256 checksums alongside. Invoked by @semantic-release/exec during
# the `prepare` lifecycle, after @semantic-release/npm has bumped package.json
# to the incoming release version. The resulting files are picked up by
# @semantic-release/github's `assets` config and attached atomically when the
# release is created — required by GitHub's immutable-releases policy, which
# rejects late asset uploads with HTTP 422.
#
# Usage: scripts/compile-release-binaries.sh <version>
#
# The <version> arg is informational only; the actual version baked into the
# binary comes from packages/cli/src/version.ts, which is regenerated here via
# the CLI package's `prebuild` hook so the bumped package.json is picked up.
set -euo pipefail

VERSION="${1:-$(node -p "require('./package.json').version")}"
echo "Compiling swarm CLI binaries for v${VERSION}"

# Pass the incoming release version explicitly to generate-version.mjs.
# The git tag doesn't exist yet at this point in semantic-release's prepare
# phase, and workspace package.json versions aren't bumped — so git describe
# and pkg.version would both report the PREVIOUS release. The env var short-
# circuits both and bakes the correct version into the binary.
export SWARM_VERSION_OVERRIDE="${VERSION}"
pnpm turbo build --filter=@mnmal-ai/swarm-cli

# The Substrate coordinator plugin ships inside the binary as the tarball packed
# into packages/cli/assets by scripts/pack-substrate-plugin.sh (the CLI build runs
# it). At runtime the CLI unpacks it into ~/.swarm/substrate/cache.
#
# bun-linux-x64 requires AVX2; bun-linux-x64-baseline runs on older CPUs that lack it.
# install.sh picks between them per host based on /proc/cpuinfo.
for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-x64-baseline bun-linux-arm64; do
  suffix="${target#bun-}"
  outfile="swarm-${suffix}"
  echo "  → ${outfile}"
  bun build --compile --target="${target}" \
    --outfile "${outfile}" \
    packages/cli/src/cli/main.ts
  sha256sum "${outfile}" > "${outfile}.sha256"
done

echo "Done. Artifacts:"
ls -lh swarm-darwin-arm64 swarm-darwin-x64 swarm-linux-x64 swarm-linux-x64-baseline swarm-linux-arm64 \
       swarm-darwin-arm64.sha256 swarm-darwin-x64.sha256 \
       swarm-linux-x64.sha256 swarm-linux-x64-baseline.sha256 swarm-linux-arm64.sha256
