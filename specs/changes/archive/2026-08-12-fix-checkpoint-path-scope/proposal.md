# Fix: checkpoint refuses to sweep another open session's work

## Why

`forge checkpoint` stages with `git add -A` (excluding only `.forge/` scratch,
`checkpoint.mjs:378`). Its one guard, `foreignUntrackedChangePaths`, filters to
**untracked** entries under a foreign change directory (`checkpoint.mjs:116`) —
so it catches another session's untracked plan files but lets everything else
through. That leaves two holes when two sessions share a working tree (which
`forge new`'s overlap prompt explicitly permits):

- **Foreign tracked modifications.** If session B has edited a shared source
  file, session A's checkpoint sweeps that edit into A's commit. Nothing looks
  at tracked foreign changes.
- **Foreign untracked files outside a change dir.** Anything not under
  `<plan.dir>/changes/<other>/` is staged.

The sanctioned per-group checkpoint is supposed to commit *this group's* work.
Under fleet overlap it silently commits another agent's in-progress work instead,
with the stray sha recorded on the wrong session (F111). This bit this very
project twice this month: with `enforce-archive-before-done` and
`add-campaign-benchmark` both open, checkpoint could not run cleanly and every
group was committed by hand.

Confirmed by reading: `git add -A` at line 378 stages all tracked modifications
regardless of which session touched them, and the only gate is the
untracked-only filter at line 116. The e2e case in this change proves it
end-to-end.

## What Changes

When a **second unfinished session** shares the working tree, `forge checkpoint`
stops sweeping. Its staging becomes:

- **`--path <p>` (repeatable)** — stage only the named paths plus this session's
  own change directory, leaving everything else untouched. This is how a
  coordinator commits its own group while another session is open.
- **Without `--path`, with another open session** — refuse when any pending
  change lies outside this session's change directory, naming the offending
  paths and pointing at `--path` or finishing/pausing the other session. A
  checkpoint whose only pending changes are this session's own still proceeds.
- **No other open session** — unchanged. `git add -A` (excluding scratch) stays
  the fast path for the common single-session case, and the existing
  foreign-untracked-change-dir backstop is preserved.

A named `--path` may never resolve under another *open* session's change
directory — that is always refused, so `--path` cannot be used to grab another
session's plan.

## Capabilities

- `checkpoint-safety`: checkpoint scopes to this session's work under fleet
  overlap — delta at `specs/checkpoint-safety/spec.md`

## Impact

Affected code: `packages/cli/src/checkpoint.mjs` (foreign-session enumeration,
pending classification, the refusal gate, `--path` staging, flag parsing). Reads
other sessions via the same `.forge/sessions/*/session.json` the fleet already
uses. No change to the commit/push rules (still never pushes, still refuses on
the default branch).

Behavior change: a checkpoint that previously swept a second session's work now
refuses or requires `--path`. This is the fix. The single-session path — the vast
majority of checkpoints — is unchanged, so there is no cost when only one session
is open.
