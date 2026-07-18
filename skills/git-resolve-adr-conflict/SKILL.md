---
name: git-resolve-adr-conflict
description: >-
  Git-scoped resolution of duplicate ADR number collisions after a coworker
  commits the same sequential number first. Renames the local ADR file to the
  next free number, updates its internal ADR-NNNN references, merges the ADR
  README by keeping all HEAD table rows, renumbering only the local row from the
  ======= side, and deleting every conflict marker, patches
  openspec/changes/archive/**/proposal.md backlinks that still point at the old
  ADR path, then git add to mark conflicts resolved. Git commands allowed are
  git mv and git add (ADR dir and touched archive proposal.md only). Use when
  the ADR README has merge conflict markers, two NNNN-*.md files share the same
  prefix, or the user says git resolve ADR conflict / duplicate ADR number.
disable-model-invocation: true
---

# Git: resolve ADR number conflict

When two authors pick the same ADR number almost simultaneously, the remote
commit wins the number. **Renumber yours** — never recycle or overwrite a
committed ADR.

## Project config

Read **`.forge/config.json`**:

```json
{ "adr": { "enabled": true, "dir": "docs/adr", "decisionsDoc": "docs/decisions.md" } }
```

Use **`{adrDir}`** = `adr.dir` (default `docs/adr`). If `adr.enabled` is `false`,
stop — this skill does not apply.

## Scope (strict)

| In scope | Out of scope |
| -------- | ------------ |
| Files under `{adrDir}/` | Implementation code, other docs |
| `openspec/changes/archive/**/proposal.md` — ADR backlink only | Other files under `openspec/` |
| `git mv` to rename the local ADR file | `git commit`, `git merge`, `git pull`, `git push` |
| `git add` on touched `{adrDir}/` and archive `proposal.md` paths | `git add` on any other path |
| Fix conflict markers in `{adrDir}/README.md` | Editing archive `design.md`, `tasks.md`, specs |

## When to run

- `{adrDir}/README.md` contains `<<<<<<<` / `=======` / `>>>>>>>` around table rows
- Two `{adrDir}/NNNN-*.md` files share the same four-digit prefix (different slugs)
- User reports "my ADR number was taken" after pulling or rebasing

## Workflow

```
Task progress:
- [ ] Detect collision and identify the local ADR
- [ ] Compute next free ADR number
- [ ] git mv rename local ADR file
- [ ] Update ADR body (title + ADR-NNNN references)
- [ ] Resolve {adrDir}/README.md — HEAD rows + your row renumbered; no markers left
- [ ] git add — mark README conflict resolved
- [ ] Patch archive proposal.md backlinks (old ADR number / path)
- [ ] git add — stage updated proposal.md files
- [ ] Verify
```

### 1. Detect collision and identify the local ADR

```bash
git status --porcelain {adrDir}/
git ls-files {adrDir}/
```

**Local ADR (yours)** — untracked (`??`) / added (`A`), or the `>>>>>>>` side of a
README conflict. **Committed ADR (coworker's)** — tracked and HEAD side.

Record **`old_padded`** (four-digit prefix) and **`slug`** (filename after `NNNN-`).

### 2. Compute next free ADR number

Use the **higher** of HEAD README table max and on-disk `NNNN-*.md` max, then +1.
Zero-pad to 4 digits. Never reuse a number that already exists.

### 3. Rename with git mv

```bash
git mv {adrDir}/<old_padded>-<slug>.md {adrDir}/<next_padded>-<slug>.md
```

### 4. Update the ADR file body

1. H1 `# NNNN.` → `# <next_padded>.`
2. Replace every `ADR-<old>` with `ADR-<next_padded>`
3. Do not change decision text unless it embeds the wrong number

### 5. Resolve `{adrDir}/README.md`

For each conflict block:

1. Keep every table row from the `<<<<<<< HEAD` side verbatim
2. Keep your row from the `=======` … `>>>>>>>` side, changing **only** the `#`
   column to `<next_padded>`
3. Delete every conflict marker
4. Order: HEAD rows first, then your renumbered row(s)

```bash
rg '<<<<<<<|=======|>>>>>>>' {adrDir}/README.md
```

Must print **no matches**.

### 6–8. Stage and patch backlinks

```bash
git add {adrDir}/README.md {adrDir}/<next_padded>-<slug>.md
rg -l "ADR-<old_padded>\\b|<old_padded>-<slug>\\.md" openspec/changes/archive/
```

In matching `proposal.md` files: update `ADR-NNNN` and filename segments only;
preserve the relative path prefix to `{adrDir}`. Then `git add` those proposals.

### 9. Verify

```bash
git status {adrDir}/ openspec/changes/archive/
```

Expect no unmerged README, no duplicate `NNNN-` prefixes, no stale
`ADR-<old_padded>` for your slug.

## Output

Report old → new path, new number, README merge summary, patched proposals.
Do **not** commit unless the user explicitly asks.
