# Design — shared-host-test-fixtures (F55)

## Module

`packages/cli/src/metrics/test-host-tree.mjs` exports:

- `DEFAULT_HOST_ID`
- `usage(tokens)`
- `assistantLine(opts)` — collect-shaped defaults (`isSidechain` optional)
- `jsonl(lines)`
- `meta({ description, stoppedByUser })`
- `plantSidecars(agents, dir)`
- `plantHost({ sessionId, lines, subagents, configDir })`

API matches what `review-evidence.test.mjs` / `collect.test.mjs` already use
so call sites are import swaps.

`review-census.test.mjs` drops its local `hostAssistantLine` /
`plantHostSession` wrappers and uses the shared helpers.

## Out of scope

`transcript.test.mjs` assistantLine (richer API for transcript unit tests).
Cursor-specific plants in collect.test.mjs.
