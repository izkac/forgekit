# Tasks

## 1. Corpus fixture

- [x] 1.1 Create `packages/cli/src/fixtures/thorough-re-corpus.json` with
      at least: F11's three risky sentences; those three hard-wrapped at
      ~80 cols (newline between qualifier and `contract` where applicable);
      ≥3 benign ordinary-English / promise / harness-setup-probe shapes;
      ≥5 sentences mined from `specs/changes/archive/**/{proposal,design,tasks}.md`
      that mention contract/auth/money/migration or benign lookalikes.
      Each row: `{ id, expect: "risky"|"benign", source, text }`. Set
      `expect` by running `isHighRiskText` once while authoring (pin
      today, do not invent desired policy).

## 2. Classification test

- [x] 2.1 Add `packages/cli/src/thorough-re-corpus.test.mjs` (test-first):
      load the fixture; for each row assert
      `isHighRiskText(text) === (expect === 'risky')`; on failure, message
      lists every mismatched `id` with expect vs actual. Also assert the
      fixture has both sides and meets the minimum counts from 1.1.
      Verification: `node --test packages/cli/src/thorough-re-corpus.test.mjs`.

## 3. Finding note

- [x] 3.1 `forge finding resolve F11` is **wrong** (narrowing not done).
      Instead amend via resolve-note on a related path or leave open and
      `forge finding resolve` is N/A — use a one-line ledger note by
      re-resolving nothing: append via reading ledger is local. Prefer:
      document in tasks evidence that F11 stays open; optionally
      `forge finding add` is wrong. Practical: leave F11 open; write in
      session notes that W5 corpus shipped as the prerequisite F11 demanded.
      If the findings CLI gains no "annotate open" command, skip code —
      just record in verify-evidence / this task checkbox that F11 remains
      open with corpus now on disk under `fixtures/thorough-re-corpus.json`.
