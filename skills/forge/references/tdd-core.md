# TDD core (condensed — inject into implementer briefs)

Full skill: [skills/test-driven-development/SKILL.md](../skills/test-driven-development/SKILL.md) — read it only when stuck (hard-to-test design, mock-heavy setup, unclear failures). Anti-patterns for mocks/test utilities: [testing-anti-patterns.md](../skills/test-driven-development/testing-anti-patterns.md).

## Iron Law

**No production code without a failing test first.** Wrote code before the test? Delete it and start over — don't keep it as "reference".

## The loop

1. **RED** — write one minimal test for one behavior. Clear name, real code (mocks only if unavoidable).
2. **Verify RED (mandatory)** — run the scoped test; confirm it *fails* for the right reason (feature missing, not a typo/error). Passes immediately? You're testing existing behavior — fix the test.
3. **GREEN** — simplest code that passes. No extra features, options, or "improvements" beyond the test (YAGNI).
4. **Verify GREEN (mandatory)** — re-run the same scoped file/pattern; output pristine. Test fails? Fix code, not test.
5. **REFACTOR** — dedupe, rename, extract; stay green; no new behavior.
6. Repeat with the next failing test.

## Test tiers (Forge)

- **Tier 1 (each red/green cycle):** single test file or pattern — never the full workspace suite.
- **Tier 2 (task done):** narrowest command proving this task — changed tests + directly related tests. Full workspace runs **once at verify (tier 3)**, not per task. Report command + exit code + pass/fail summary.

## Tier 2 evidence is executed, not transcribed

Tier 2 evidence for this task is produced by running the command through the
CLI itself, not by you reporting a command and exit code for the coordinator
to write down:

```bash
forge tdd run --task <nn-slug> --expect fail -- <tier-2 cmd>   # RED, before you write production code
# … write the simplest code that passes …
forge tdd run --task <nn-slug> --expect pass -- <tier-2 cmd>   # GREEN, once it's green
```

Each call runs the command itself and appends a stamp to
`tasks/<nn-slug>/tdd-runs.jsonl` — a stamp the CLI never observed running is
not evidence, no matter how confidently it's described in your report. `forge
score` reads these stamps directly (an ok pass-stamp counts as tier-2
coverage even with no `test-evidence.md`), so recording only through `forge
tdd run` costs nothing on the scorecard.

A task with no applicable red→green cycle (docs-only, config, no behavior
changed) is not "just run `forge evidence` instead" — declare it:

```bash
forge evidence --task <nn-slug> --no-tdd --reason "<why no test cycle applies>"
```

`--no-tdd` writes a durable, reviewer-visible marker that exempts this task
from the pairing gate. Evidence recorded the old way (`--command --exit
--summary`, no `--no-tdd`) does **not** exempt it — a task with neither a
red→green stamp pair nor a `--no-tdd` declaration refuses at `forge phase
done`, with no way through except going back and producing one or the other.

## Expected values come from the fixture, never from the brief

**Compute every expected number in code from the fixture you built.** A figure
typed into a brief is a claim, not a measurement, and when it is wrong the test
still passes — it just stops testing anything. Three such numbers reached one
change's briefs; each would have produced an assertion that passed against buggy
code while reading as coverage.

Worst case is the negative assertion (`notEqual` / `notDeepEqual` / "must not
be N"). A wrong expected value there fails silently and forever.

**Every guard must be shown to fire.** If a test passes the moment you write it,
temporarily reintroduce the bug it guards, watch it go red for the right reason,
then revert by hand. A guard never observed failing is decoration. Say in your
report which guards you proved this way.

## Selection rules need a discriminating fixture

When the behavior is *which of several candidates wins* — dedupe by key, first
vs last, max, precedence, merge order — the fixture must make the losers
**differ from the winner**. Otherwise the test only proves the rule ran, not
that it picked correctly.

A real case: a rule collapsed repeated transcript lines to one entry per
request, and every fixture put identical token counts on all lines of a request.
The tests could detect over-counting but were structurally incapable of
detecting that the *wrong line* was kept — which is what shipped, costing 28.6%
of all output tokens. Vary the discarded candidates, and assert on the value
that only the correct choice produces.

## Red flags — stop and start over

Code before test · test passes immediately · can't explain the failure · "I'll test after" · "already manually tested" · "too simple to test" · "keep as reference / adapt existing code" · "deleting X hours is wasteful" (sunk cost) · "run full workspace to be safe" (tier 3 belongs at verify) · "just this once" · copying an expected number out of the brief · a fixture whose discarded candidates are identical to the winner · a red or green stamp `forge tdd run` never observed (transcribed into your report instead of executed).

## Bugs

Reproduce with a failing test first, then fix. Never fix a bug without a test.
