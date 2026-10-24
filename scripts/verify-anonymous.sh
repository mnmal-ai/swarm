#!/usr/bin/env bash
# Verify the tracked tree carries no trace of the previous maintainer's identity.
#
# Usage: scripts/verify-anonymous.sh [--generic-only] [--only <group>]
#
# Generic groups live here: paths (home directories, hostnames), hydra, history.
# The identity-bearing groups (identity, nda, infra, people) are NOT in this
# repository on purpose: spelling the patterns out in a public tree would
# publish exactly what the check exists to remove. They are loaded from a
# private file, one "group<TAB>extended-regex" per line, "#" comments allowed,
# matched case-insensitively:
#   ${SWARM_ANONYMITY_PATTERNS:-$HOME/.config/swarm/anonymity-patterns}
# If that file is missing the script exits 2 unless --generic-only is given.
#
# Exit 0 when every selected group has zero hits, 1 on any hit, 2 on misuse.
#
# The script never reports 0 for a group it did not actually search. Exit 2
# (with a message on stderr) for each of these failure modes:
#   1. a group's regex is invalid (checked for every group before searching),
#      or grep reports any error while searching;
#   2. a private line has an empty regex, or a private group's pattern is
#      empty (an empty alternative would match everything);
#   3. a private group is named paths, hydra or history (it would shadow, or
#      be shadowed by, the generic group of that name).
set -u

PRIVATE_FILE="${SWARM_ANONYMITY_PATTERNS:-$HOME/.config/swarm/anonymity-patterns}"
MAX_PRINT=200
GENERIC_GROUPS="paths hydra history"

usage() { echo "usage: $0 [--generic-only] [--only <group>]" >&2; exit 2; }

only=""; generic_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --generic-only) generic_only=1; shift ;;
    --only) [ $# -ge 2 ] || usage; only="$2"; shift 2 ;;
    *) usage ;;
  esac
done

# generic_pattern <group> <-> "case-flag<TAB>regex" (flag: i or s)
generic_pattern() {
  case "$1" in
    paths)   printf 's\t/[U]sers/|-[M]acBook' ;;
    hydra)   printf 'i\t[h]ydra' ;;
    history) printf 'i\tclaude\\.ai/[c]ode/session|Claude-[S]ession' ;;
    *) return 1 ;;
  esac
}

# Private groups: names in file order. Malformed lines are fatal.
private_groups=""
if [ "$generic_only" -eq 0 ]; then
  if [ ! -f "$PRIVATE_FILE" ]; then
    echo "private pattern file not found: $PRIVATE_FILE" >&2
    exit 2
  fi
  bad="$(awk -F'\t' -v generic="$GENERIC_GROUPS" '
    BEGIN { n = split(generic, g, " "); for (i = 1; i <= n; i++) isgen[g[i]] = 1 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF < 2 || $1 == "" || $2 == "" { printf "line %d: needs group<TAB>regex with both non-empty\n", NR; next }
    ($1 in isgen) { printf "line %d: group name %s collides with a generic group\n", NR, $1 }
  ' "$PRIVATE_FILE")"
  if [ -n "$bad" ]; then
    echo "invalid private pattern file $PRIVATE_FILE:" >&2
    echo "$bad" >&2
    exit 2
  fi
  private_groups="$(awk -F'\t' '/^[[:space:]]*#/ || /^[[:space:]]*$/ {next} !seen[$1]++ {printf "%s ", $1}' "$PRIVATE_FILE")"
fi

all_groups="$GENERIC_GROUPS $private_groups"
if [ -n "$only" ]; then
  case " $all_groups " in
    *" $only "*) ;;
    *) echo "unknown group: $only" >&2; exit 2 ;;
  esac
fi

cd "$(git rev-parse --show-toplevel)" || exit 2

tracked() {
  if [ "$1" = "hydra" ]; then
    git ls-files -z | tr '\0' '\n' | grep -vxe 'pnpm-lock.yaml' -e 'scripts/verify-anonymous.sh' | grep -v '^docs/superpowers/' | tr '\n' '\0'
  else
    git ls-files -z
  fi
}

# group_spec <group> -> "flag<TAB>regex" on stdout
group_spec() {
  if generic_pattern "$1"; then return 0; fi
  printf 'i\t'
  awk -F'\t' -v g="$1" '$1 == g && !/^[[:space:]]*#/ {printf "%s%s", (n++ ? "|" : ""), $2}' "$PRIVATE_FILE"
}

# Validate every group's regex before searching anything.
for group in $all_groups; do
  spec="$(group_spec "$group")"
  pat="${spec#*$'\t'}"
  if [ -z "$pat" ]; then
    echo "empty pattern in group $group" >&2; exit 2
  fi
  printf '' | grep -E -e "$pat" >/dev/null 2>&1
  [ $? -le 1 ] || { echo "invalid pattern in group $group" >&2; exit 2; }
done

errfile="$(mktemp)"; trap 'rm -f "$errfile"' EXIT

raw_hits() {
  local group="$1" spec flag pat
  spec="$(group_spec "$group")"
  flag="${spec%%$'\t'*}"; pat="${spec#*$'\t'}"
  # grep exits 1 on "no match", which is fine; any stderr output is fatal.
  if [ "$flag" = "i" ]; then
    tracked "$group" | xargs -0 grep -IHniE -e "$pat" 2>>"$errfile"
  else
    tracked "$group" | xargs -0 grep -IHnE -e "$pat" 2>>"$errfile"
  fi
  return 0
}

status=0
for group in $all_groups; do
  [ -z "$only" ] || [ "$only" = "$group" ] || continue
  hits="$(raw_hits "$group" | sort -t: -k1,1 -k2,2n -u)"
  if [ -s "$errfile" ]; then
    echo "search error in group $group:" >&2; head -n 5 "$errfile" >&2; exit 2
  fi
  if [ -z "$hits" ]; then count=0; else count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"; fi
  echo "$group: $count hit(s)"
  if [ "$count" -gt 0 ]; then
    status=1
    printf '%s\n' "$hits" | sed -n "1,${MAX_PRINT}p" | sed -E 's/^([^:]+):([0-9]+):/\1:\2: /'
    [ "$count" -le "$MAX_PRINT" ] || echo "… and $((count - MAX_PRINT)) more"
  fi
done
exit $status
