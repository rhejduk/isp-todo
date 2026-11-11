#!/usr/bin/env bash
# Read-only print of synced task priorities and notes. See SYNC.md.
set -euo pipefail
cd "$(dirname "$0")"
exec node read_notes.js "$@"
