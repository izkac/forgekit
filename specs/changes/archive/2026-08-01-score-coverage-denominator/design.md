# Design — score-coverage-denominator

## Context

`GROUP_RE = /^##\s+\S/` counts every ATX h2 in tasks.md. Fenced samples and
non-group sections (`## Notes`) inflate `planFacts.groups`, which feeds the
2-point review-depth coverage note in `score.mjs`. Caps are plain strings;
fleet cannot tell applied from noted.

## Decisions

1. **Fence strip first.** Remove fenced code blocks (including the fence
   lines) from tasks.md before any heading scan. Nested fences are out of
   scope; standard markdown fences are enough.
2. **Numbered group headings only.** After strip, count lines matching
   `/^##\s+\d+[.)]\s+\S/` (e.g. `## 1. Protect…`, `## 2) Product loop`).
   Unnumbered `## Notes` / `## Appendix` do not count.
3. **Headingless stays 0 from the parser.** Scorer already uses
   `Math.max(planFacts.groups, 1)` when the plan is readable — do not change
   that contract here.
4. **Structured caps.** New shape:
   `{ id: string, applied: boolean, before: number | null, after: number | null, text: string }`.
   Writers always set `applied`. When `applied` is false, `before`/`after`
   may equal the unchanged score (or null). Fleet: `capped` iff any entry has
   `applied === true`; `capReasons` push `text` (or string for legacy lines).
   Legacy string caps in old ledgers: treat as `applied: true` (fail closed —
   historical lines meant a real cap almost always).
5. **Bundle F14 with F16** — same scorecard surface, one change.

## Alternatives rejected

- Denylist of heading titles — brittle across languages/projects.
- Fix only score.mjs — pace suggestion also reads `groups`.
- Separate F14 change — unnecessary ceremony for a one-file contract tweak
  once score.mjs is open.

## Risks

- Plans that used unnumbered `## Group name` under-count to 0 → scorer
  treats as one group (Math.max). Acceptable; templates already number groups.
- Consumers printing `caps.join` without handling objects — grep and update
  render paths in score/fleet.
