# Design — checkpoint-scoped-staging (F72)

## Guard

After `pendingFiles`, before `git add`:

```js
foreignUntrackedChangePaths(pending, planDir, openspecChange)
```

A path is foreign when it is untracked and matches
`<planDir>/changes/<segment>/…` where `segment` ∉ { openspecChange, `archive` }.

If any: `fail` with message listing paths (and the current change name).

`planDir` from `resolveProjectPlanEngine(cwd).dir` (default `specs`).
If session has no `openspecChange`, treat every untracked under
`<planDir>/changes/<segment>/` (except archive) as foreign — cannot claim a
home change.

## Staging

Unchanged: `git add -A` with `:(exclude).forge` when the guard passes.
