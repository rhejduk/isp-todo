#!/usr/bin/env bash
# Rebuild the encrypted page from data/*.json and publish it.
# Usage: ./build.sh            build, commit, push
#        ./build.sh --no-push  build only (for local checks)
#        ./build.sh -m "msg"   custom commit message
set -euo pipefail
cd "$(dirname "$0")"
PUSH=1; MSG="Refresh $(TZ=America/New_York date '+%a %b %-d %Y %-I:%M %p ET')"
while [ $# -gt 0 ]; do case "$1" in --no-push) PUSH=0;; -m) MSG="$2"; shift;; esac; shift; done
node build.js
[ "$PUSH" = 1 ] || { echo "Built only (no push)."; exit 0; }
# Only publish the encrypted build plus code. data/ and source/ are gitignored.
git add index.html src/template.html build.js build.sh salt.txt .gitignore README.md 2>/dev/null || true
if git ls-files --cached | grep -E '^(data|source)/'; then echo "Refusing: plaintext data is staged" >&2; exit 1; fi
if git diff --cached --quiet; then echo "Nothing changed."; exit 0; fi
git commit -q -m "$MSG"
git push -q origin main
echo "Pushed: $MSG"
