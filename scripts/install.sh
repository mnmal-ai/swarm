#!/usr/bin/env bash
# Install (or uninstall) the swarm CLI from GitHub releases.
# Downloads a pre-compiled binary — no Node.js or npm required.
#
# Needs bash, curl, and sha256sum or shasum (the binary is checked against the
# release's .sha256). The release is downloaded from github.com without
# credentials; gh, logged in, is used only when github.com refuses that
# (HTTP 404/403, as it answers for a private repository).
#
# Install:
#   curl -fsSL https://mnmal-ai.github.io/swarm/install.sh | bash
#
# Install a specific version:
#   curl -fsSL https://mnmal-ai.github.io/swarm/install.sh | bash -s -- --version v1.0.0-alpha.0
#
# Uninstall:
#   curl -fsSL https://mnmal-ai.github.io/swarm/install.sh | bash -s -- --uninstall

set -euo pipefail

REPO="mnmal-ai/swarm"
INSTALL_DIR="${SWARM_INSTALL_DIR:-/usr/local/bin}"
CLEANUP_DIR=""

# ── Colors ────────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED="\033[0;31m"
  GREEN="\033[0;32m"
  YELLOW="\033[0;33m"
  CYAN="\033[0;36m"
  BOLD="\033[1m"
  DIM="\033[2m"
  RESET="\033[0m"
else
  RED="" GREEN="" YELLOW="" CYAN="" BOLD="" DIM="" RESET=""
fi

info()    { printf "  ${CYAN}%b${RESET}\n" "$*"; }
success() { printf "  ${GREEN}[OK]${RESET} %b\n" "$*"; }
warn()    { printf "  ${YELLOW}[!!]${RESET} %b\n" "$*"; }
fail()    { printf "  ${RED}[FAIL]${RESET} %b\n" "$*"; }
step()    { printf "\n${BOLD}%b${RESET}\n" "$*"; }

# ── Checksums ─────────────────────────────────────────────────────────────────

# SHA-256 of a file, lowercase hex, from sha256sum or shasum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  else
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  fi
}

# verify_checksum <binary> <checksum file>: the checksum file is the release's
# `<asset>.sha256` (`<hex digest>  <asset>`). Fails, naming both digests, when
# they differ, and when the file holds no digest at all.
verify_checksum() {
  local expected actual
  expected=$(awk 'NR == 1 {print tolower($1)}' "$2")
  actual=$(sha256_of "$1")
  if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
    fail "$(basename "$2") does not hold a SHA-256 digest; refusing to install."
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    fail "Checksum mismatch for $(basename "$1"): the download is corrupt or was tampered with."
    info "  expected:   $expected ($(basename "$2"))"
    info "  downloaded: $actual"
    return 1
  fi
  return 0
}

# ── Cleanup trap ──────────────────────────────────────────────────────────────

cleanup() {
  if [ -n "$CLEANUP_DIR" ] && [ -d "$CLEANUP_DIR" ]; then
    rm -rf "$CLEANUP_DIR"
  fi
}
trap cleanup EXIT

# ── Parse arguments ───────────────────────────────────────────────────────────

ACTION="install"
VERSION_TAG=""
TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --version)
      if [ -z "${2:-}" ]; then
        echo "Error: --version requires a value (e.g. --version v1.0.0-alpha.0)" >&2
        exit 1
      fi
      VERSION_TAG="$2"
      shift 2
      ;;
    --install-dir)
      if [ -z "${2:-}" ]; then
        echo "Error: --install-dir requires a path" >&2
        exit 1
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --help|-h)
      echo "swarm installer"
      echo ""
      echo "Usage:"
      echo "  curl -fsSL https://mnmal-ai.github.io/swarm/install.sh | bash"
      echo ""
      echo "Flags:"
      echo "  --uninstall          Remove the swarm binary"
      echo "  --version <tag>      Install a specific release (e.g. v1.0.0-alpha.0)"
      echo "  --install-dir <path> Install location (default: /usr/local/bin)"
      echo "  --help               Show this help"
      echo ""
      echo "Needs bash, curl, and sha256sum or shasum. gh (logged in) is needed only"
      echo "while the repository is private."
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

# ── Uninstall ─────────────────────────────────────────────────────────────────

if [ "$ACTION" = "uninstall" ]; then
  step "Uninstalling swarm..."

  FOUND=false
  for dir in "$INSTALL_DIR" "/usr/local/bin" "$HOME/.local/bin"; do
    if [ -f "$dir/swarm" ]; then
      rm -f "$dir/swarm" 2>/dev/null || sudo rm -f "$dir/swarm"
      success "Removed $dir/swarm"
      FOUND=true
    fi
  done

  if [ "$FOUND" = false ]; then
    if command -v swarm &>/dev/null; then
      FOUND_SWARM=$(command -v swarm)
      warn "swarm found at $FOUND_SWARM but not in expected locations."
      info "Remove it manually: ${BOLD}rm $FOUND_SWARM${RESET}"
    else
      success "swarm is not installed."
    fi
  fi

  echo ""
  info "To remove swarm from a project, run ${BOLD}swarm uninstall${RESET} in the project directory."
  exit 0
fi

# ── Detect platform ──────────────────────────────────────────────────────────

step "Detecting platform..."

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *)
    fail "Unsupported OS: $OS"
    info "swarm supports macOS (darwin) and Linux."
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *)
    fail "Unsupported architecture: $ARCH"
    info "swarm supports arm64 and x86_64."
    exit 1
    ;;
esac

BINARY_NAME="swarm-${OS}-${ARCH}"
success "$OS-$ARCH"

# Bun's bun-linux-x64 runtime requires AVX2. Older Intel (pre-Haswell, ~2013),
# older AMD (pre-Excavator, ~2015), and some VMs/embedded hosts lack it and
# would SIGILL on the standard binary. Fall back to the baseline build when
# AVX2 is missing — or when /proc/cpuinfo is unreadable (safer default for a CLI).
if [ "$OS" = "linux" ] && [ "$ARCH" = "x64" ]; then
  if ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
    BINARY_NAME="swarm-${OS}-${ARCH}-baseline"
    info "AVX2 not detected — using baseline build"
  fi
fi

# ── Check dependencies ───────────────────────────────────────────────────────

step "Checking dependencies..."

DEPS_OK=true

if command -v curl &>/dev/null; then
  success "curl"
else
  fail "curl not found; it downloads the release."
  DEPS_OK=false
fi

# sha256sum or shasum: the binary is checked against the release's .sha256.
if command -v sha256sum &>/dev/null || command -v shasum &>/dev/null; then
  success "sha256sum/shasum"
else
  fail "Neither sha256sum nor shasum found; one is needed to verify the download."
  DEPS_OK=false
fi

if [ "$DEPS_OK" = false ]; then
  echo ""
  fail "Missing dependencies. Fix the issues above and re-run."
  exit 1
fi

# ── Detect existing install ──────────────────────────────────────────────────

EXISTING_VERSION=""
if command -v swarm &>/dev/null; then
  EXISTING_VERSION=$(swarm --version 2>/dev/null || echo "")
fi

# ── Download ─────────────────────────────────────────────────────────────────
#
# Everything comes from github.com without credentials first. Only when
# github.com refuses (HTTP 404 or 403, which is how it answers an anonymous
# caller for a private repository) does the installer switch to gh, and only
# if gh is installed and logged in. Any other failure stops the install.

step "Downloading swarm..."

CLEANUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/swarm-install-XXXXXX")
chmod 700 "$CLEANUP_DIR"

GITHUB_API="https://api.github.com/repos/$REPO"
GITHUB_DOWNLOAD="https://github.com/$REPO/releases/download"
USE_GH=false
FETCH_CODE=""

LAST_HEADERS="$CLEANUP_DIR/last-response.headers"

# http_get <url> <out file> [request header]: prints the HTTP status (000 when
# no answer came); the response headers land in $LAST_HEADERS.
http_get() {
  local code
  if [ -n "${3:-}" ]; then
    code=$(curl -sSL -D "$LAST_HEADERS" -H "$3" -o "$2" -w '%{http_code}' "$1" 2>/dev/null || true)
  else
    code=$(curl -sSL -D "$LAST_HEADERS" -o "$2" -w '%{http_code}' "$1" 2>/dev/null || true)
  fi
  printf '%s' "${code:-000}"
}

# header_value <name>: the last response's value for header <name> (any case).
header_value() {
  [ -f "$LAST_HEADERS" ] || return 0
  awk -v want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    { sub(/\r$/, "") }
    { i = index($0, ":"); if (i > 0 && tolower(substr($0, 1, i - 1)) == want) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); val = v } }
    END { if (val != "") print val }' "$LAST_HEADERS"
}

# exit_if_rate_limited <http status>: a 429, or a 403 with no requests left
# (x-ratelimit-remaining: 0), is GitHub's rate limit, not a private
# repository. Say how long to wait (x-ratelimit-reset, else retry-after) and
# stop; gh is not the fix, so it is not suggested.
exit_if_rate_limited() {
  local remaining reset after wait mins unit
  case "$1" in
    429) ;;
    403)
      remaining=$(header_value x-ratelimit-remaining)
      [ "$remaining" = 0 ] || return 0
      ;;
    *) return 0 ;;
  esac
  reset=$(header_value x-ratelimit-reset)
  after=$(header_value retry-after)
  wait=""
  if printf '%s' "$reset" | grep -Eq '^[0-9]+$'; then
    wait=$((reset - $(date +%s)))
  elif printf '%s' "$after" | grep -Eq '^[0-9]+$'; then
    wait=$after
  fi
  echo ""
  if [ -n "$wait" ]; then
    mins=$(((wait + 59) / 60))
    [ "$mins" -ge 1 ] || mins=1
    unit=minutes
    [ "$mins" -eq 1 ] && unit=minute
    fail "GitHub API rate limit reached: retry in $mins $unit, or set GH_TOKEN."
  else
    fail "GitHub API rate limit reached: retry later, or set GH_TOKEN."
  fi
  exit 1
}

# use_gh_or_exit <http status> <what>: github.com refused an anonymous
# download. Continue through gh when it is installed and logged in; otherwise
# stop and say what to do.
use_gh_or_exit() {
  if command -v gh &>/dev/null && gh auth status &>/dev/null; then
    info "github.com answered HTTP $1 for $2 without credentials; using your gh login."
    USE_GH=true
    return 0
  fi
  echo ""
  fail "Could not download $2 from github.com (HTTP $1)."
  info "Check that the release exists: ${BOLD}https://github.com/$REPO/releases${RESET}"
  info "If the repository is private, install gh (https://cli.github.com), run ${BOLD}gh auth login${RESET}, and re-run."
  exit 1
}

# fetch_asset <name> <dir>: download asset <name> of release $TAG into <dir>.
# Returns 0 when downloaded, 4 when the release has no such asset, 1 on any
# other failure; FETCH_CODE holds the HTTP status of an anonymous download.
fetch_asset() {
  local name="$1" dir="$2" assets
  if [ "$USE_GH" = true ]; then
    assets=$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null) || return 1
    printf '%s\n' "$assets" | grep -Fxq "$name" || return 4
    gh release download --repo "$REPO" --tag "$TAG" -p "$name" -D "$dir" --clobber >/dev/null 2>&1 || return 1
    [ -f "$dir/$name" ] || return 1
    return 0
  fi
  FETCH_CODE=$(http_get "$GITHUB_DOWNLOAD/$TAG/$name" "$dir/$name.part")
  exit_if_rate_limited "$FETCH_CODE"
  if [ "$FETCH_CODE" = 200 ]; then
    mv "$dir/$name.part" "$dir/$name"
    return 0
  fi
  rm -f "$dir/$name.part"
  if [ "$FETCH_CODE" = 404 ]; then return 4; fi
  return 1
}

if [ -n "$VERSION_TAG" ]; then
  TAG="$VERSION_TAG"
  info "Version: $TAG"
else
  # Releases are prereleases (1.0.0-alpha.N), which GitHub's releases/latest
  # ignores. The releases list is newest-first, never shows an anonymous caller
  # a draft, and with per_page=1 holds a single tag_name.
  # GH_TOKEN, when set, goes to the API only (it lifts the anonymous rate limit).
  CODE=$(http_get "$GITHUB_API/releases?per_page=1" "$CLEANUP_DIR/releases.json" ${GH_TOKEN:+"Authorization: Bearer $GH_TOKEN"})
  exit_if_rate_limited "$CODE"
  case "$CODE" in
    200)
      TAG=$(awk -F'"' '/"tag_name"/ { for (i = 1; i < NF; i++) if ($i == "tag_name") { print $(i + 2); exit } }' \
        "$CLEANUP_DIR/releases.json")
      ;;
    403|404)
      use_gh_or_exit "$CODE" "the release list"
      TAG=$(gh release list --repo "$REPO" --limit 20 --json tagName,isDraft \
        --jq '[.[] | select(.isDraft | not)][0].tagName // empty' 2>/dev/null) || TAG=""
      ;;
    *)
      fail "Could not read the release list from the GitHub API (HTTP $CODE)."
      info "Check your network and re-run, or pass ${BOLD}--version <tag>${RESET}."
      exit 1
      ;;
  esac
  if [ -z "$TAG" ]; then
    fail "No swarm releases found in ${BOLD}$REPO${RESET}."
    info "See ${BOLD}https://github.com/$REPO/releases${RESET}"
    exit 1
  fi
  info "Version: $TAG (latest)"
fi

info "Downloading $BINARY_NAME..."
RC=0
fetch_asset "$BINARY_NAME" "$CLEANUP_DIR" || RC=$?
if [ "$RC" -ne 0 ] && [ "$USE_GH" = false ] && { [ "$FETCH_CODE" = 404 ] || [ "$FETCH_CODE" = 403 ]; }; then
  use_gh_or_exit "$FETCH_CODE" "$BINARY_NAME ($TAG)"
  RC=0
  fetch_asset "$BINARY_NAME" "$CLEANUP_DIR" || RC=$?
fi
if [ "$RC" -ne 0 ]; then
  echo ""
  if [ "$RC" -eq 4 ]; then
    fail "Release $TAG has no $BINARY_NAME."
  elif [ "$USE_GH" = true ]; then
    fail "Could not download the release asset $BINARY_NAME ($TAG) through gh."
    info "Check ${BOLD}gh auth status${RESET} and that the release exists."
  else
    fail "Could not download $BINARY_NAME ($TAG) from github.com (HTTP $FETCH_CODE)."
  fi
  info "Releases: ${BOLD}https://github.com/$REPO/releases${RESET}"
  exit 1
fi

BINARY="$CLEANUP_DIR/$BINARY_NAME"
BINARY_SIZE=$(du -h "$BINARY" | cut -f1)
success "Downloaded $BINARY_NAME ($BINARY_SIZE)"

# Verify the binary against the release's .sha256. Every release the pipeline
# publishes carries one, so when it exists the check is mandatory: a checksum
# that cannot be fetched, or does not match, stops the install. Only a release
# with no .sha256 at all (an older one) installs unverified, with a warning.
# The checksum goes into its own directory, so nothing already downloaded
# stands in its way.
CHECKSUM_NAME="${BINARY_NAME}.sha256"
CHECKSUM_DIR="$CLEANUP_DIR/checksum"
mkdir -p "$CHECKSUM_DIR"
RC=0
fetch_asset "$CHECKSUM_NAME" "$CHECKSUM_DIR" || RC=$?
case "$RC" in
  0)
    verify_checksum "$BINARY" "$CHECKSUM_DIR/$CHECKSUM_NAME" || exit 1
    success "Checksum verified"
    ;;
  4)
    warn "Release $TAG has no $CHECKSUM_NAME; installing without verifying the download."
    ;;
  *)
    fail "Could not download $CHECKSUM_NAME ($TAG); the binary cannot be verified."
    if [ "$USE_GH" = true ]; then
      info "Check ${BOLD}gh auth status${RESET} and that the release exists, then re-run."
    else
      info "github.com answered HTTP $FETCH_CODE. Re-run in a moment."
    fi
    exit 1
    ;;
esac

# ── Install ──────────────────────────────────────────────────────────────────

step "Installing..."

# Ensure install directory exists
if [ ! -d "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR" 2>/dev/null || {
    fail "Cannot create $INSTALL_DIR. Try:"
    info "  sudo mkdir -p $INSTALL_DIR"
    info "  Or use: ${BOLD}--install-dir ~/.local/bin${RESET}"
    exit 1
  }
fi

# Copy binary — try without sudo first, then with sudo + explanation
if cp "$BINARY" "$INSTALL_DIR/swarm" 2>/dev/null; then
  chmod +x "$INSTALL_DIR/swarm"
else
  info "Writing to ${BOLD}$INSTALL_DIR${RESET} requires admin access."
  info "Enter your system password if prompted."
  echo ""
  if sudo cp "$BINARY" "$INSTALL_DIR/swarm" && sudo chmod +x "$INSTALL_DIR/swarm"; then
    : # success
  else
    echo ""
    fail "Cannot write to $INSTALL_DIR."
    info "Install without sudo: ${BOLD}curl ... | bash -s -- --install-dir ~/.local/bin${RESET}"
    exit 1
  fi
fi

# On macOS, clear quarantine/provenance attributes so the unsigned binary can run
if [ "$OS" = "darwin" ]; then
  for attr in com.apple.quarantine com.apple.provenance; do
    xattr -d "$attr" "$INSTALL_DIR/swarm" 2>/dev/null || sudo xattr -d "$attr" "$INSTALL_DIR/swarm" 2>/dev/null || true
  done
fi

# ── Verify ───────────────────────────────────────────────────────────────────

step "Verifying..."

if command -v swarm &>/dev/null; then
  NEW_VERSION=$(swarm --version 2>/dev/null || echo "unknown")
  if [ -n "$EXISTING_VERSION" ] && [ "$EXISTING_VERSION" != "$NEW_VERSION" ]; then
    success "Upgraded: $EXISTING_VERSION -> $NEW_VERSION"
  elif [ -n "$EXISTING_VERSION" ]; then
    success "$NEW_VERSION (already up to date)"
  else
    success "$NEW_VERSION installed to $INSTALL_DIR/swarm"
  fi
else
  warn "Installed to $INSTALL_DIR/swarm but 'swarm' is not on PATH."
  info "Add to your shell profile: ${BOLD}export PATH=\"$INSTALL_DIR:\$PATH\"${RESET}"
fi

echo ""
if [ -z "$EXISTING_VERSION" ]; then
  info "Run ${BOLD}swarm init${RESET} in your project to get started."
fi
info "Run ${BOLD}swarm --help${RESET} for all commands."
echo ""
