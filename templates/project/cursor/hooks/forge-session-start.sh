#!/usr/bin/env bash
# Session start: remind when a Forge session is active (.forge/active.json).
# See docs/forge.md

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  exit 0
fi
cd "$repo_root"

if [[ ! -f .forge/active.json ]]; then
  exit 0
fi

forge reminder --format cursor 2>/dev/null || exit 0
