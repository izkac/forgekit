---
name: specs-verify-change
description: Forge — leftover sweep for specs-engine changes. Coordinator-only; run during verify before the final reviewer.
---

# Specs leftover sweep (`specs-verify-change`)

Verify that a **specs-engine** change (`planType: specs`) is complete, correct,
and coherent, then search the tree for leftover uses of names the change is
retiring. The coordinator runs this — **not the final reviewer**, who is
forbidden from directory sweeps.

There is no `forge spec-verify` CLI and no vendor OpenSpec command. Read
`<plan.dir>/changes/<name>/` directly (default `specs/changes/<name>/`;
`plan.dir` comes from `.forge/config.json`).

**When:** end of Forge verify, before dispatching the final reviewer (or the
combined closer). Always on for specs sessions.

## Input

Optionally a change name. If omitted, infer from the active Forge session
(`openspecChange` / `forge status`) or conversation context. If vague, list
live folders under `<plan.dir>/changes/` (skip `archive/`) and ask.

Always announce: "Using change: \<name\>".

## Steps

1. **Select the change**

   Use `<plan.dir>/changes/<name>/`. Confirm `proposal.md` and `tasks.md`
   exist. Mark incomplete checkboxes as in-progress when announcing.

2. **Load artifacts**

   Read, from that folder:

   | Artifact | Role |
   | -------- | ---- |
   | `proposal.md` | Why / what; names being introduced or retired |
   | `design.md` | Decisions (if present) |
   | `tasks.md` | Implementation checklist |
   | `specs/<cap>/spec.md` | Delta requirements (`ADDED` / `MODIFIED` / `REMOVED`) |

   Do not call a planning-engine CLI. The files are the source.

3. **Initialize the report**

   Four dimensions, each of which can raise CRITICAL, WARNING, or SUGGESTION:

   - **Completeness** — tasks and delta requirements
   - **Correctness** — requirement and scenario mapping
   - **Coherence** — `design.md` adherence and pattern consistency
   - **Leftover-name search** — retired names still living in the tree

4. **Verify Completeness**

   **Tasks:** parse `- [ ]` vs `- [x]`. Each incomplete task is CRITICAL
   ("Complete task: …" or "Mark as done if already implemented").

   **Delta requirements:** extract every `### Requirement:` from
   `specs/**/spec.md`. For each ADDED or MODIFIED requirement, search the
   codebase for implementation. Unimplemented → CRITICAL.

   If only `tasks.md` exists, skip spec checks and say so.

5. **Verify Correctness**

   **Requirement mapping:** for each requirement, note implementing files and
   line ranges. Divergence from intent → WARNING.

   **Scenario coverage:** for each `#### Scenario:`, check the condition is
   handled and a test exists. Uncovered → WARNING.

6. **Verify Coherence**

   If `design.md` exists, extract decisions (`Decision:`, `Approach:`,
   `Architecture:`) and check the implementation follows them. Contradiction →
   WARNING. No `design.md` → skip and note it.

   New code that fights project patterns → SUGGESTION, with an example of the
   local pattern.

7. **Leftover-name search** (required, not a suggestion)

   Collect **retired names** from:

   - `proposal.md` (what the change is replacing or deleting)
   - `design.md` (old names called out as going away)
   - delta specs under **REMOVED** (and MODIFIED requirements that rename
     something)

   Search the tree for those names, including files `tasks.md` never listed
   (docs, CI, Docker, fixtures, imports, comments that instruct current
   behaviour).

   **Skip:**

   - `<plan.dir>/changes/archive/` (historical changes)
   - changelog entries that only record past behaviour and do not instruct
     current behaviour
   - this change's own proposal/design/delta that *describe* the retirement

   A leftover that still tells an agent or operator to use the old name is a
   finding (CRITICAL if it would ship wrong behaviour; otherwise WARNING or
   SUGGESTION by blast radius). Every finding needs a file path and a
   concrete fix.

8. **Fix every finding**

   Fix CRITICAL, WARNING, **and SUGGESTION**. Skip only an explicit no-action
   or a recorded design decision that fixing would contradict. Record those
   under **Skipped** with the reason. Do not skip "nice to have" leftovers.
   Dispatch a fix subagent for anything non-trivial.

   If you edited code after `verify-evidence.md` was recorded, re-run tier 3,
   then re-run this sweep. Cap at two extra passes. Still dirty → stop and
   ask the user.

9. **Save the report**

   Write `.forge/sessions/<id>/spec-verify.md`. Include a scorecard and
   issues by priority, then end with:

   ```markdown
   ## Forge disposition

   - Fixed: …
   - Skipped: … — …
   - Remaining: none
   ```

   `Remaining: none` is required. "Ready for archive (with noted
   improvements)" is **not** enough — `forge phase review` and
   `forge phase done` refuse without the line.

## Heuristics

- Completeness is checklist-shaped (checkboxes, requirement list).
- Correctness uses keyword search and reasonable inference — not certainty.
- Coherence catches contradictions, not style nits.
- When uncertain, prefer SUGGESTION over WARNING, WARNING over CRITICAL.
- Every issue needs a specific recommendation (`file.ts:123` where possible).

## Output

Clear markdown: summary table, issues grouped by CRITICAL / WARNING /
SUGGESTION, then the Forge disposition block. No vague "consider reviewing".
