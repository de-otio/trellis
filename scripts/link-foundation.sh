#!/usr/bin/env bash
#
# link-foundation.sh — link the locally-developed @de-otio/saas-foundation and
# @de-otio/vestibulum packages into this repo for co-development.
#
# Why: those packages are in active development in the saas-foundation monorepo.
# Linking makes trellis resolve them from local source (their built dist/) so
# changes can be debugged here without a publish→bump→install cycle.
#
# Fragility: `npm install` / `npm ci` replace the symlinks with the registry
# versions. Re-run this script after any install to restore the links. CI and
# `npm publish` deliberately use the registry versions (this is dev-only).
#
# After editing the foundation source, rebuild its dist so trellis sees it:
#   ( cd "$FOUNDATION_REPO" && npm run build )
# or run a watch build there.
#
# Usage:  bash scripts/link-foundation.sh           # link
#         bash scripts/link-foundation.sh --status   # show current resolution
#         bash scripts/link-foundation.sh --unlink    # restore registry versions

set -euo pipefail

FOUNDATION_REPO="${SAAS_FOUNDATION_REPO:-$HOME/repos/dot/saas-foundation}"
PKGS=(@de-otio/saas-foundation @de-otio/vestibulum)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status() {
  for p in "${PKGS[@]}"; do
    target="$ROOT/node_modules/$p"
    if [ -L "$target" ]; then
      echo "  $p -> $(readlink "$target")  [linked]"
    elif [ -d "$target" ]; then
      ver="$(node -e "console.log(require('$target/package.json').version)" 2>/dev/null || echo '?')"
      echo "  $p @ $ver  [registry install]"
    else
      echo "  $p  [missing]"
    fi
  done
}

case "${1:-}" in
  --status)
    echo "Resolution of foundation packages in $ROOT:"
    status
    exit 0
    ;;
  --unlink)
    cd "$ROOT"
    npm unlink "${PKGS[@]}" >/dev/null 2>&1 || true
    echo "Unlinked. Run 'npm install' to restore registry versions."
    exit 0
    ;;
esac

if [ ! -d "$FOUNDATION_REPO" ]; then
  echo "error: saas-foundation repo not found at $FOUNDATION_REPO" >&2
  echo "       set SAAS_FOUNDATION_REPO to its path and retry." >&2
  exit 1
fi

echo "Creating global links from $FOUNDATION_REPO ..."
( cd "$FOUNDATION_REPO/packages/foundation" && npm link >/dev/null )
( cd "$FOUNDATION_REPO/packages/vestibulum" && npm link >/dev/null )

echo "Linking into $ROOT ..."
cd "$ROOT"
npm link "${PKGS[@]}" >/dev/null

echo "Done. Current resolution:"
status
