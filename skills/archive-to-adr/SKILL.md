---
name: archive-to-adr
description: >-
  Create or update Architecture Decision Records (ADRs) from an archived OpenSpec
  change. Fire after archive-shaped Bash completes (hooks wrap `openspec archive`
  plus `mv` into dated `openspec/changes/archive/…`). Also use when sessionStart
  reports pending archives, the user says `/archive-to-adr`, or they ask to
  generate ADRs from an archive. Skip entirely when the project has ADRs disabled
  (`.forge/config.json` → `adr.enabled: false`).
disable-model-invocation: false
---

# Archive to ADR

Turn a **completed and archived** OpenSpec change into one or more ADRs, following
the project's decisions doc (scaffolded as `docs/decisions.md` by default via
`forge init --adr`).

This skill is **decoupled** from OpenSpec itself: archive hooks inject a reminder
after successful archive-shaped shells; you judge whether an ADR is warranted.

## Project config

Read **`.forge/config.json`** at the repo root (written by `forge init` / optional
`forgekit install` project scaffold):

```json
{
  "adr": {
    "enabled": true,
    "dir": "docs/adr",
    "decisionsDoc": "docs/decisions.md"
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `adr.enabled` | `true` if file missing and `docs/adr/` exists; else follow install | When `false`, do **not** run this skill — no ADR, no "No ADR" stamp |
| `adr.dir` | `docs/adr` | Directory for `NNNN-short-topic.md` + status `README.md` |
| `adr.decisionsDoc` | sibling `decisions.md` of `adr.dir` | Process / template (when to write, format, hooks) |

Below, **`{adrDir}`** and **`{decisionsDoc}`** mean those configured paths.

If `adr.enabled` is `false`, stop and tell the user ADRs are disabled for this project.

## When to skip entirely (ADRs enabled)

If the change is a bug fix, copy tweak, docs-only edit, or refactor with no
architectural choice, **do not** create an ADR. Instead add this **single line**
to the archived `proposal.md`:

```text
No ADR — non-architectural change
```

That silences the session-start pending-ADR backstop.

## Input

**Required:** the archive directory path, e.g.
`openspec/changes/archive/2026-05-15-payment-add-service/`.

If the user only gives the change name, resolve it: list `openspec/changes/archive/`
and pick the matching dated folder.

## Steps

1. **Confirm ADRs are enabled** — read `.forge/config.json` as above.

2. **Read the archived artifacts**
   - `proposal.md` — Why, What Changes, Capabilities, Impact
   - `design.md` — Context, Decisions, Risks, Migration
   - `specs/**/*.md` in the archive (capability deltas)

3. **Apply the ADR gate** (`{decisionsDoc}` § "When to write an ADR")
   - Write an ADR when the change establishes/revises a **boundary**, picks one
     approach over a **real** alternative, introduces a **constraint** future code
     must respect, picks a **vendor/protocol/library** that is expensive to swap,
     or codifies a **repo-wide** convention.
   - Skip when it's purely implementation detail inside an existing decision.

4. **Pick the next ADR number**
   - List `{adrDir}/*.md` (four-digit prefix pattern `NNNN-*.md`).
   - Use **the next sequential integer**; never reuse a number.
   - If multiple distinct architectural decisions warrant separate ADRs in one
     archive, create multiple files (`NNNN-…`, `NNNN+1-…`), each with one sharp decision.

5. **Author the ADR file** at `{adrDir}/NNNN-short-topic.md` using the **exact
   section structure** from `{decisionsDoc}`:
   - Title: `# NNNN. <Short, decision-shaped title>`
   - Frontmatter lines: **Status**, **Date**, **Area**, **Related** (link the
     archive path, sibling ADRs)
   - Body: Context, Decision, Alternatives considered, Consequences
     (Positive / Negative / Neutral), References

   Keep it terse (target ~80–200 lines total across all new ADRs for the change).
   Link to the archive for forensic detail; don't paste the whole design.

6. **Update the status index** `{adrDir}/README.md` — add or amend the table
   row(s). If `README.md` is missing, create it with the table scaffold from
   `{decisionsDoc}`.

7. **Cross-reference from the archive**
   - In `openspec/changes/archive/<dated-change>/proposal.md`, add (or extend):

   ```markdown
   ## Decision record

   This change is recorded as ADR-NNNN ({adrDir}/NNNN-short-topic.md).
   ```

   Use `ADR-NNNN` text so pending-ADR hooks (`grep 'ADR-[0-9]'`) recognize the link.

8. **If capability specs were promoted** during archive: consider a one-line
   pointer in the ADR **References** to `openspec/specs/<capability>/spec.md`
   (optional but valuable).

## Output

- Paths of created/updated `{adrDir}/*.md`
- Confirmation `{adrDir}/README.md` was updated
- Confirmation the archived `proposal.md` now references `ADR-NNNN`
- One-sentence summary per ADR written

## Guardrails

- Naming: **`NNNN-short-topic.md`**, not date-only filenames.
- **Never** add `{adrDir}/` to `.cursorindexignore` (or equivalent ignore that
  blocks agent retrieval).
- Don't duplicate content that belongs only in OpenSpec — the archive remains
  the verbose record; the ADR is the distilled "why."
- If unsure whether to write an ADR, re-read the decisions gate; when still
  ambiguous, ask the user once rather than inventing ceremony.

## Relationship to hooks

Project hooks (from `forge init --adr`) may:

- Remind agents to run **archive-to-adr** after `openspec archive` / archive `mv`
- At session start, list archives whose `proposal.md` lacks `ADR-*` **and** lacks
  the `No ADR — non-architectural change` stamp

Neither hook writes ADR files; **this skill** does.
