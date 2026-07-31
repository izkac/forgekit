# Tasks

## 1. Kind + severity (W2)

- [x] 1.1 `packages/cli/src/findings.mjs` + `findings.test.mjs` (test-first):
      export `KINDS`; `addFinding` requires `kind` ∈ KINDS and `severity` ∈
      SEVERITIES (no defaults); persist `kind` on the entry. Tests: missing
      kind throws naming the five; missing severity throws; valid add
      stores both; unknown kind/severity refuse.
- [x] 1.2 `packages/cli/src/findings-cli.mjs`: parse `--kind` and require
      `--severity` on `add`; `usage()` documents both; `list` shows kind,
      defaults to open bugs, supports `--all-kinds` and existing `--all` /
      `--json`; footer reports hidden non-bug open count. Tests via CLI
      spawn or library: list without flag omits debt/idea; `--all-kinds`
      shows them; JSON shape includes `kind`.
- [x] 1.3 `packages/cli/src/session-status.mjs` + existing
      `findings.test.mjs` status assertion: `openFindings.count` = open
      bugs only; add `openFindings.byKind` (`{ bug, debt, tradeoff, idea,
      process }` counts of open rows). Test: mixed kinds → count 1 when
      only one bug is open.

## 2. dependsOn (W3)

- [ ] 2.1 `findings.mjs` / `findings-cli.mjs` / tests: optional
      `dependsOn: string[]` on add (`--depends-on F12,F18`); `forge
      finding link <id> --depends-on <ids>` merges edges on an existing
      finding; unknown target id refuses. Test: add with dependsOn;
      link appends without duplicating.
- [ ] 2.2 On `resolveFinding` / CLI resolve: collect open findings whose
      `dependsOn` contains the resolved id; print heading `Re-check these
      — their root cause just closed:` with id + first line of text each;
      leave them `open`; exit 0. Test: resolve with dependents → listed
      and still open; resolve with none → no heading.

## 3. Reopen (W4)

- [ ] 3.1 `forge finding reopen <id> --from <oldId> --note "…"`: resolved
      → open, set `reopenedFrom`, increment `reopenCount` (from 0), keep
      history (`noteHistory` / prior resolve note). Refuse reopen of an
      already-open finding. Tests: reopen transition; reopenCount
      increments on second reopen; open finding refused.
- [ ] 3.2 `list` sorts any `reopenCount >= 1` first and marks them (e.g.
      `↻N`); `session-status` adds `reopenedFindings: [{ id, reopenCount,
      text }]` separate from `openFindings`. Tests cover sort order and
      status field.
- [ ] 3.3 `set-phase.mjs` `phase done`: if the session's change slug
      matches an open finding's `change` with `reopenCount >= 2`, refuse
      unless `--reopen-waived` (stderr names the findings). Test: blocked;
      waived passes; reopenCount 1 does not block.

## 4. Backfill + acceptance check

- [ ] 4.1 One-shot `scripts/backfill-finding-kinds.mjs`: read each row in
      `.forge/findings.jsonl`, assign `kind` (and F11/F13
      `reopenedFrom`/`reopenCount`), write back; print before/after open-
      by-kind counts. Run it, delete the script, leave the local ledger
      updated. Verification: `forge finding list` shows single-digit bugs
      (or documents the actual count); `forge status` `openFindings.count`
      matches bug count.
- [ ] 4.2 Backfill known `dependsOn`: F11 → `['F12']` (F18/F19 already
      resolved in W1; F51 residual does not depend on F12 for its remaining
      below-floor claim — leave unlinked or link only if text still cites
      F12 as fix). Spot-check with `forge finding resolve F12 --note` amend
      path listing F11 if still open.
