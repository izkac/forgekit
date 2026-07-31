# Tasks

## 1. Matching + stale helpers

- [x] 1.1 `findings.mjs` + tests: export `matchingOpenBugs(forgeDir, slug)` and
      `staleOpenBugs(forgeDir, { now, maxAgeDays: 7 })`. Test: exact change
      match; token-in-text match; non-bugs ignored; stale age boundary.

## 2. Surfaces

- [x] 2.1 `new-session.mjs`: after session create, attach `relatedFindings`
      (id, severity, text, change) for matching open bugs; stderr notice when
      non-empty. Test via spawning new-session or library coverage of helper
      already in 1.1 plus a thin CLI test if one exists.
- [x] 2.2 `session-status.mjs`: add `staleFindings`. Extend findings.test.mjs
      status assertion with a backdated bug.

## 3. Docs (W7)

- [x] 3.1 Update Guardrails in `skills/forge/SKILL.md` with the four rules.
- [x] 3.2 Update `docs/usage.md` and `skills/forge/docs/forge.md` finding
      sections for `--kind`/`--severity`, list defaults, link/reopen, and the
      same guardrails where findings are documented.
