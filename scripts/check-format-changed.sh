#!/usr/bin/env bash
# Ratchet variant of `npm run format:check`: run `prettier --check` only on the
# files that differ from a base revision (working tree included, untracked
# files included). Lets formatting gate new work without a repo-wide reformat.
#
#   bash scripts/check-format-changed.sh            # vs merge-base with origin/main
#   bash scripts/check-format-changed.sh HEAD^1     # CI: the PR's own changes
#
# Same globs as the root `format` script. The generated snapshots are skipped:
# their own gates compare them byte-for-byte.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base="${1:-$(git merge-base origin/main HEAD)}"

files=()
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] && files+=("$f")
done < <(
  {
    git diff --name-only --diff-filter=ACMR "$base" -- \
      '*.ts' '*.tsx' '*.dart' '*.json' '*.md' \
      ':!apps/api/etc/public-api.snapshot.d.ts' \
      ':!apps/api/openapi.snapshot.json' \
      ':!packages/extension-api/etc/public-api.snapshot.d.ts'
    git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.dart' '*.json' '*.md'
  } | sort -u
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "format-check-changed: no changed files to check (base: $base)"
  exit 0
fi

echo "format-check-changed: checking ${#files[@]} changed file(s) against base $base"
exec npx prettier --check --ignore-unknown --ignore-path .gitignore "${files[@]}"
