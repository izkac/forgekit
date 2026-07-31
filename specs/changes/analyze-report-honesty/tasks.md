# Tasks

## 1. Filter `<synthetic>` at collection + analyze read (F69)

- [x] 1.1 RED: add failing tests in `packages/cli/src/metrics/` (transcript
      and/or collect) that a request with model `<synthetic>` does not create
      a `byModel['<synthetic>']` bucket; and in `analyze.test.mjs` that a
      digest naming `<synthetic>` does not produce a by-model row for it.
      Verify RED:
      `env -u CURSOR_CONVERSATION_ID -u CURSOR_TRACE_ID -u CLAUDE_CODE_SESSION_ID node --test packages/cli/src/metrics/transcript.test.mjs packages/cli/src/analyze.test.mjs`
      (or the narrowest files that hold the new cases).

- [x] 1.2 GREEN: skip `<synthetic>` in transcript/collect bucketing; skip it
      when `buildAnalysis` names models from digests/docs. Same tests green.
      Resolve F69 with a short note.

## 2. Durable byModel / byPhase in digest (F66)

- [x] 2.1 RED: `compactMetrics` / ledger tests expect `byModel`/`byPhase`
      compact maps when `metrics.json` is available; `buildAnalysis` with
      digest splits and **no** live `metrics.json` fills per-model requests
      and tokens from the digest (not zeros). Verify RED on
      `ledger` + `analyze` tests.

- [x] 2.2 GREEN: extend `compactMetrics` in `packages/cli/src/ledger.mjs`;
      ensure phase-done digest path uses it; update `buildAnalysis` to prefer
      live doc then digest splits. Resolve F66.

## 3. Model policy copy + renderer honesty (F65, F67, F68)

- [ ] 3.1 RED: `formatAnalysis` / analyze tests — `sessions>0 && total===0`
      does not tell the operator to wire the hook; By-model caption marks
      detailed-only columns; column header is `sess err` not `err`.

- [ ] 3.2 GREEN: implement in `packages/cli/src/analyze.mjs`. Resolve
      F65, F67, F68.

## 4. Dogfood Claude hooks in forgekit (F64)

- [ ] 4.1 Run `forge init --claude` (or copy templates), commit
      `.claude/hooks/*` and a merged `.claude/settings.json` so PreToolUse
      runs `forge-model-hook.mjs`. Add a small pin (test or e2e) that the
      repo tree contains the hook path + settings matcher. Resolve F64.

## 5. Product-loop e2e

- [ ] 5.1 Author `scripts/e2e/analyze-report-honesty.mjs` + `e2e.json` steps:
      digest with compact splits + zero-dispatch tables → analyze text shows
      digest-backed model tokens, “sessions reported no dispatches”, no
      `<synthetic>` row, `sess err` header. `forge e2e run` green.
