#!/usr/bin/env bash
# Commit a folder one item at a time: every file directly inside it gets its own commit, and every subfolder
# gets ONE commit for everything in it (files inside a subfolder are not committed one by one).
#   ./commit-each.sh              # folder = src
#   ./commit-each.sh test         # another folder
#   ./commit-each.sh src --dry    # show what would be committed, change nothing
# Messages follow the repo's style: "add: <name>" for new items, "update: <name>" for changed ones.
# Items with no changes are skipped. Nothing is pushed — run `git push` yourself.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DIR=${1:-src}; DRY=${2:-}
[ -d "$DIR" ] || { echo "no such folder: $DIR"; exit 1; }

n=0
for item in "$DIR"/*; do
  [ -e "$item" ] || continue
  name=$(basename "$item")
  [ -n "$(git status --porcelain -- "$item")" ] || continue          # nothing new or changed here
  # "add" if git has never tracked anything at this path, else "update"
  if [ -z "$(git ls-files -- "$item")" ]; then verb=add; else verb=update; fi
  if [ "$DRY" = --dry ]; then echo "would commit  $verb: $name"; n=$((n + 1)); continue; fi
  git add -A -- "$item"
  git commit -q -m "$verb: $name" -- "$item"
  echo "committed  $verb: $name"; n=$((n + 1))
done
[ "$n" -gt 0 ] && echo "$n commit(s)$([ "$DRY" = --dry ] && echo ' (dry run)')" || echo "nothing to commit in $DIR/"
