# Tasks

Every task is test-first: write the failing test, then the code that passes it.
Unit tests use `node:test` alongside the existing `packages/cli/src/*.test.mjs`
suite; verify each task with `npm test` unless stated otherwise.

## 1. Host binding and phase history

- [x] 1.1 `packages/cli/src/metrics/host.mjs` — `detectHost(env)` returns
      `{agent, sessionId}` from `CLAUDE_CODE_SESSION_ID`, and
      `{agent: 'unknown', sessionId: null}` when absent. `bindHost(session, env,
      now)` appends-if-new to `session.host.sessionIds` and stamps `boundAt`.
      Tests: fresh bind; repeat bind adds no duplicate; a second host session is
      appended; no env → `unknown` and no ids.
- [x] 1.2 `findTranscripts(sessionIds, {configDir, homedir})` in the same module
      scans `<configDir>/projects/*/<sessionId>.jsonl` and returns absolute
      paths plus the sidecar directory when present. Tests against a temp
      fixture tree: found, missing id, `CLAUDE_CONFIG_DIR` honoured, unreadable
      directory tolerated.
- [x] 1.3 Call `bindHost` from `packages/cli/src/new-session.mjs` and
      `set-phase.mjs` so a session created before or resumed after a host
      restart still binds. Tests: `forge new` records the id; a later phase
      change on an unbound session heals it.
- [x] 1.4 `set-phase.mjs` appends `{phase, at}` to `session.phaseHistory` on
      every transition (idempotent when the phase is unchanged). Tests:
      transitions accumulate in order; re-entering the same phase does not
      duplicate the last entry; legacy sessions without the field gain one.

## 2. Transcript reader

- [x] 2.1 `packages/cli/src/metrics/transcript.mjs` — `readJsonl(path)` yields
      parsed lines and skips corrupt ones without throwing (same contract as
      `readLedger`). `usageByRequest(lines)` collapses assistant lines to one
      entry per `requestId`, falling back to `message.id`, then to per-line.
      Tests: **a fixture with 39 assistant lines across 12 requests must report
      12 requests and un-inflated tokens** — this is the regression test for
      per-content-block duplication; plus corrupt line, empty file, missing
      `usage`.
- [x] 2.2 `aggregateTokens(entries)` totals `input`/`output`/`cacheRead`/
      `cacheCreate` overall and per `message.model`, and records the observed
      host `version` and `effort`. Tests: multi-model split, absent cache
      fields treated as zero.
- [x] 2.3 `aggregateTools(lines)` counts `tool_use` blocks by tool name and
      `tool_result` blocks with `is_error: true`, returning
      `{tools, errors:{toolResults, errorResults, rate}}`. Tests: mixed
      success/failure, `is_error` absent or `false` counted as success (only an
      explicit `true` is a failure; measured across 479 transcripts the field is
      absent 22,870 times and literally `null` zero times), zero-division guard
      when there are no tool results.
- [x] 2.4 `readSubagents(sidecarDir)` pairs `agent-<id>.meta.json` with
      `agent-<id>.jsonl` and returns one record per subagent —
      `{agentId, agentType, modelDispatched, modelResolved, requests, tokens,
      errors}`. `description` is **not** carried through. Tests: pair found;
      meta without transcript; transcript without meta; malformed meta skipped.

## 3. Collector

- [x] 3.1 `packages/cli/src/metrics/collect.mjs` — `collectMetrics({sessionDir,
      session, env, now})` resolves transcripts, filters lines to
      `[session.createdAt, now]`, and assembles the `metrics.json` document
      described in `design.md`. Every failure returns
      `{available: false, reason}` and never throws. Tests: happy path; no
      binding; transcript missing; unparseable transcript.
- [x] 3.2 `byPhase` attribution joins request timestamps against
      `session.phaseHistory`. Tests: requests land in the phase active at their
      timestamp; requests before the first transition fall into the first
      phase; a session with no history yields an empty `byPhase` rather than an
      error.
- [x] 3.3 `packages/cli/src/metrics-cli.mjs` implementing `forge metrics
      collect [--session <id>]`, registered in `packages/cli/bin/forge.mjs`.
      Writes `metrics.json` into the session directory and prints the summary as
      JSON. Test: CLI smoke against a temp session.
- [x] 3.4 `set-phase.mjs` runs the collector on `finish`/`done` **before**
      `writeSessionScorecard`, and `ledger.mjs` carries the compact `metrics`
      block (plus `subagentsDispatched`) into the `sessions.jsonl` digest.
      Tests: digest contains totals; a collector failure still writes the digest
      and still allows the transition. Also **replace** the temporary
      source-order test added in group 1 (`binding runs before the scorecard
      block, not after it` in `set-phase.test.mjs`) with the behavioural
      equivalent: a host id first seen on the `done` command must still yield
      `available: true`. That invariant is only observable once the collector
      exists, which is why group 1 could not test it directly.

## 4. Dispatch ledger

- [x] 4.1 `enforce-model.mjs` appends one line per decision to
      `<activeSession>/dispatches.jsonl` — `{ts, tool, agentType,
      modelRequested, modelResolved, decision, reason, toolUseId?}` — only when
      a Forge session is active, and regardless of whether
      `models.local.json` exists. Tests: allow / rewrite / deny each logged; no
      active session logs nothing; **a write failure leaves the hook decision
      byte-identical** (the existing "must never block work" contract).
- [x] 4.2 The collector folds `dispatches.jsonl` into
      `metrics.dispatches = {total, allowed, rewritten, denied, skipped}` where
      `skipped = rewritten + denied`, and the digest carries
      `dispatchesSkipped` and a non-null `subagentsDispatched`. Tests: counts;
      missing file yields zeros, not `available: false`.

## 5. Read side

- [x] 5.1 `packages/cli/src/analyze.mjs` — `buildAnalysis({cwd, limit, since})`
      reads `sessions.jsonl`, `scorecards.jsonl` and any on-disk `metrics.json`,
      and returns coverage (`sessionsWithMetrics / sessionsTotal`), the
      per-session rows, `byModel`, `byPhase`, and enforcement totals. Tests:
      empty ledgers; sessions without metrics counted in coverage but excluded
      from token math; `--since` / `--limit` filtering.
- [x] 5.2 Render to stdout as a readable table, `--json` for the raw object;
      register `analyze` in `packages/cli/bin/forge.mjs`. Coverage is printed
      first so a partial history is never read as complete. Tests: JSON shape
      stable; table renders with zero sessions.
- [x] 5.3 Update `templates/project/claude/commands/forge-analyze.md` so its
      Gather step runs `forge analyze --json` as the quantitative source, with
      the session directories as narrative context only. Verify by reading the
      rendered command file.

## 6. Product loop and docs

- [x] 6.1 Add e2e steps to `scripts/e2e/harness-portability.mjs` and
      `specs/changes/session-telemetry/e2e.json`: build a scratch project with a
      synthetic transcript, run `forge metrics collect`, then `forge analyze
      --json`, asserting deduped request counts and non-empty coverage. Verify
      with a green `forge e2e run`.
- [x] 6.2 Document the new surface: `session.json` fields (`host`,
      `phaseHistory`) and the new session files in
      `skills/forge/references/forge-layout.md`, the two commands in
      `docs/forge.md` and `docs/usage.md`, and a `CHANGELOG.md` entry. Verify by
      re-reading the layout table against the shipped `metrics.json`.
