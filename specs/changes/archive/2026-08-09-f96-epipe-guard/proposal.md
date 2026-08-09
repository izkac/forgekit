# Change: handle closed CLI output pipes

## Why
`forge prefs | head` crashes with an unhandled EPIPE stack trace when the reader closes stdout early.

## What Changes
- Install a Forge child-process stdout EPIPE guard for every routed command.
- Exit successfully on EPIPE while preserving non-EPIPE stream failures and avoiding option leakage to descendants.
