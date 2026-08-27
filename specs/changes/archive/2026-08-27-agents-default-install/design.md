# Design — shared `.agents` default install, project copy retired

## Context

`agents-install-target` (archived 2026-08-27) added the `agents` environment in
two places: user-level (`forgekit install --agents agents` →
`~/.agents/skills/`) and project-level (`forge init --agents` →
`<project>/.agents/skills/forge/`). Post-release verification of host behavior
showed Cursor and Codex both read the shared root natively (Codex even
deprecates its vendor path), so the project-level copy is redundant and the
user-level shared root deserves default status.

## Decisions

### D1 — Default expression: pre-checked picker entry, not a silent install

`forgekit install` keeps its explicit contract (non-TTY still requires
`--agents`/flags). "Default" means: `agents` moves to the **front** of the
`AGENTS` map (picker order = insertion order) and `promptAgents` pre-checks it
even when nothing is installed yet. Remembered/installed environments stay
pre-checked as today. Alternative rejected: auto-installing to the shared root
on every run would write outside the user's selection and break the
reconcile-on-full-picker logic.

Note: the `AGENTS` map order changes a second time (it was deliberately moved
last in the previous change when it was a niche extra); first place now follows
from default status.

### D2 — `forge init --agents` errors instead of silently disappearing

Removing the flag from `parseArgs` would produce a bare `Unknown argument:
--agents`, indistinguishable from a typo, for anyone following 0.3.48 docs.
Instead `parseArgs` recognizes `--agents` and throws a targeted error: the
project-level target was removed, skills are user-global — run
`forgekit install` (shared `.agents` is the default there).

### D3 — Init retires only *stamped* project copies

`forge init` (any target selection) deletes `<project>/.agents/skills/forge/`
when it carries a `.forgekit.json` stamp — the same ownership rule
`updateOutdatedSkills` already uses for the shared root. An unstamped
directory at that path is foreign and is left byte-identical, as is everything
else under `.agents/`. The retirement is reported (`agentsSkillRetired` in the
JSON report + a human-readable line). This mirrors the retired-triage-hook
pattern: the tool cleans up what it previously wrote, exactly once identified
by its own marker.

### D4 — Doctor: legacy warning, ownership-gated

`checkAgentsSkill` keeps its warn-never-fail posture but changes meaning:
a **stamped** project copy is reported as a legacy leftover with the retirement
path named (`forge init`, or delete the directory). An **unstamped** directory
is ignored entirely — previously it warned as `unversioned`, but without a
stamp we cannot claim it; treating foreign content as ours was the exact bug
class fixed in `updateOutdatedSkills`. Absent directory: check skipped
(unchanged).

### D5 — Cursor/Codex per-tool installs stay available

Their user-level skill dirs (`~/.cursor/skills/`, `~/.codex/skills/`) still
work and remain selectable for users who want vendor-local copies; labels gain
a note that both tools also read the shared root. No removal, no migration:
`forgekit update` continues to refresh whatever is stamped wherever it is.

## Risks

- Users on 0.3.48 with a project `.agents/skills/forge` committed to git: the
  next `forge init` deletes the tree from the working copy; the diff makes the
  retirement visible and reviewable. Documented in the changelog.
- Claude Code remains vendor-path-only; nothing here reduces Claude coverage
  (its install target is untouched).
