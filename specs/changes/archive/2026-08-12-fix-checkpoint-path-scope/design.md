# Design — checkpoint scopes to this session's work

## The rule, precisely

Let `ours` = `<plan.dir>/changes/<this session's openspecChange>/`. Let
`otherOpen` = every other session whose `session.json` phase is not `done` or
`skipped` and whose change directory exists on disk.

At staging time, classify each pending working-tree entry (from
`pendingEntries`, which already includes untracked):

- **mine** — path is under `ours`.
- **foreign-plan** — path is under some `otherOpen` session's change directory.
- **shared** — anything else (source files, docs, other change dirs not tied to
  an open session).

Then:

1. **`--path` given** → stage `mine` plus every entry under a named `--path`
   value. Leave the rest unstaged. **Refuse** if any named `--path` resolves
   under a `foreign-plan` directory (you cannot checkpoint another open session's
   plan, even explicitly).
2. **No `--path`, `otherOpen` non-empty** → **refuse** if any `foreign-plan` or
   `shared` entry exists. The message lists them, tags the `foreign-plan` ones
   with the owning session, and points at `--path` scoping or finishing/pausing
   the other session. If only `mine` entries are pending, proceed (stage `mine`).
3. **No `otherOpen`** → unchanged: `git add -A` excluding scratch, with the
   existing `foreignUntrackedChangePaths` backstop still refusing untracked files
   under any non-ours, non-archive change dir (catches a stray plan dir when no
   session record is open).

## Why this shape

- **The single-session fast path is untouched.** Most checkpoints have no second
  open session; they keep `git add -A` and pay nothing. The strict machinery only
  engages under overlap — the exact condition F111 is about.
- **Refuse beats guess.** A Forge session records its change directory but not
  which *source* files it touched, so A's own `src/foo.mjs` edit and B's
  `src/bar.mjs` edit are indistinguishable to the tool. Rather than guess an
  attribution and risk committing the wrong one, checkpoint refuses and hands the
  operator the `--path` scalpel. The user chose this trade explicitly.
- **`--path` is the escape hatch, not a foot-gun.** It stages an explicit subset,
  but a named path under another open session's change dir is still refused — the
  one thing you must never do is commit another session's plan.

## Detecting other open sessions

Enumerate `.forge/sessions/*/session.json`, parse each, keep those with
`phase ∉ {done, skipped}` and `id ≠ this session`. Resolve each one's change dir
as `<plan.dir>/changes/<openspecChange>` and keep the ones that exist on disk.
This mirrors how the fleet already reads sessions; a malformed or unreadable
session file is skipped (it cannot prove an overlap, and a crash here would block
an honest checkpoint).

`plan.dir` comes from `resolveProjectPlanEngine(cwd).dir`, as the existing gate
already does.

## Path matching

A pending entry matches a `--path` value, or a change directory, when its
repo-relative path equals the target or is under it as a directory prefix
(segment-aware, so `src/foo` does not match `src/foobar`). This is the same
prefix discipline `foreignUntrackedChangePaths` uses; reuse or factor a shared
helper rather than re-implementing it subtly differently.

## Alternatives considered

- **Auto-scope to the session's touched files** — rejected: Forge does not record
  touched source paths, so there is nothing to scope to without new tracking, and
  inferring it from the diff would re-introduce the guess this design avoids.
- **Exclude only other sessions' change dirs, keep `git add -A`** — rejected as a
  partial fix: it leaves shared-source foreign edits swept, which is the bigger
  hazard for concurrent code work.

## Risk

Moderate — this changes what a sanctioned commit stages. The mitigations: the
single-session path is provably unchanged (tests assert it), and the strict path
only ever *narrows* what is committed or refuses, so it can never commit *more*
than before. The sharp edge is a false refusal annoying a two-session operator;
`--path` is the immediate answer, and the message says so.
