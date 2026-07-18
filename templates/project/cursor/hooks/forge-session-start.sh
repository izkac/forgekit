#!/usr/bin/env bash
# Thin wrapper — prefer the Node implementation on Windows-friendly hosts.
exec node "$(dirname "$0")/forge-session-start.mjs" "$@"
