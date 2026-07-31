# Plan — make the findings ledger converge

**Status:** W1–W5 shipped 2026-07-31. Remaining: W6 routing, W7 docs.
  W5: thorough-re-corpus (F11 corpus pin; F11 stays open until measured narrowing).
**Created:** 2026-07-31
**Owner:** whoever picks it up next — this document is the brief; follow it in order.

---

## Why this exists

On 2026-07-31 the ledger read **26 open / 45 resolved** and the open count had
never gone down for more than a day. Read as a bug count, that says the workflow
produces more defects than it fixes. Measured, it says something different — and
the gap between those two readings is itself the defect this plan fixes.

What the data actually showed (all reproducible from `.forge/findings.jsonl`):

| Measurement | Value |
| --- | --- |
| Resolutions that were real fixes | 33 of 45 (12 were superseded / wrong / duplicate) |
| Net findings per fix session, 07-30 → 07-31 | +2, −2, +3, +1, +1 — **+5 over five sessions** |
| New defects in newly-written code over those two days | ~4 (F60–F63), **all** found by the workflow's own reviewers, none shipped |
| Open findings found *by* a review or implementer | 9 of 26 |
| Open findings that state they are **not** regressions | 6 ("pre-dates", "not a regression", "latent rather than live") |
| Open findings that are recorded **deliberate trade-offs** | 3 |
| Open findings that are process notes or ideas, not defects | 4 (F46 opens with *"Process, for me:"*) |
| Open findings marked `major` | **24 of 26** |

Three structural causes, and every one is cheap to fix:

1. **One queue, many kinds.** Bugs, tech debt, accepted trade-offs, improvement
   ideas and personal process notes all land in the same list under one count.
   That count then gets read as a bug count. It is not one.
2. **`major` is a default, not a judgment.** `addFinding` at
   `packages/cli/src/findings.mjs:66` does `opts.severity ?? 'major'`. The scale
   (`blocker | major | minor | note`, line 19) is fine; nobody passes `--severity`,
   so 24 of 26 say `major` because the default said so.
3. **Findings cannot reference each other.** The record is
   `{id, text, severity, status, change, sessionId, slug, createdAt, note, resolvedAt}`.
   No `supersededBy`, no `dependsOn`. So closing a root cause cannot close — or
   even flag — its dependents. This has already cost us: **F12 shipped on
   2026-07-31** (`review-stamp-at-dispatch`), and F11, F18, F19 and F51 all name
   F12's dispatch-time stamp as their real fix in their own text. Four findings
   sat open past their root cause because nothing linked them to it.

**The invariant to restore:** *the headline number must be countable defects that
are still true.* Everything below serves that.

### What is genuinely broken, and is not a measurement artifact

Do not let the analysis above talk you out of these. They are real.

- **F11 and F13 are REOPENED** — fixed, shipped, regressed, caught later by an
  independent review. Twice. F11 says why: the 0.3.24 narrowing was measured
  against real sentences only *after* shipping, and was losing 8 of 12 genuinely
  risky ones. A green suite is not evidence that a heuristic still discriminates.
- **F46** — a `git checkout --` in another repo destroyed an uncommitted user
  change, on an inference drawn from a diff.
- **Nothing routes the ledger into what gets worked on next.** `forge finding add`
  is write-only: no priority, no age, no blocking flag, no surfacing at
  `forge new`. The workflow executes a chosen change well and has no mechanism for
  choosing the right one.

---

## Rules of engagement (read before touching anything)

1. **Fix beats file.** If the fix is smaller than the finding text would be, make
   the fix. On 2026-07-31 eight findings were filed in one batch and four of them
   (a caption, a column name, an `if` branch, a one-string filter) were smaller
   than their own write-ups. That is finding-dumping and it is what the ledger
   exists to prevent, not to enable.
2. **Never narrow a heuristic without a corpus.** F11 regressed exactly this way.
   Measure against real risky *and* benign sentences **before** shipping. See W5.
3. **A finding is not automatically a bug.** When you file, pass `--kind` and
   `--severity` deliberately (after W2 lands, `--kind` is required).
4. **Resolving a root cause obliges you to re-check its dependents.** After W3
   that is mechanical; until then, do it by hand.
5. **Do not re-litigate the analysis above.** It is measured, and the queries are
   reproducible. Extend it if you find it wrong; do not redo it from scratch.

---

## W1 — Re-audit F11 / F18 / F19 / F51 against the shipped stamp

**Do this first. It is free, the engineering is already done, and it sizes the rest
of the work.**

F12 shipped `forge review-label` writing a dispatch stamp to the session's
`reviews/dispatches.json`; `packages/cli/src/review-census.mjs` reads it via
`readStamps` (`review-stamp.mjs`) at a precedence rank **above** the prose rules
(see the precedence commentary at `review-census.mjs:23-57` and rule 5 at ~`:203`).

Four open findings describe weaknesses in the prose layer that the stamp now
outranks:

| Finding | Claim | Question to answer |
| --- | --- | --- |
| F11 | bare `contract` in `THOROUGH_RE` over-escalates | Does the stamp path bypass `THOROUGH_RE` for stamped dispatches? What share of traffic still reaches it? |
| F18 | a review body with no blank lines keeps its whole text in the attribution region | Can that shape still decide the gate when a stamp exists? |
| F19 | a leading blockquote or fence consumes a paragraph slot | Same question |
| F51 | every sub-floor dispatch now lands on the prose rules | Explicitly written as an argument *for* F12; F12 has shipped |

**Method.** For each: read the finding, read the current `review-census.mjs`
precedence order, and determine whether the described failure can still decide a
gate. Do not guess from the module docstring — trace the code path.

**Outcome, per finding, one of:**
- `forge finding resolve <id> --note "Superseded by F12's dispatch stamp (shipped 2026-07-31, review-stamp-at-dispatch): <the traced path that makes it unreachable>"`
- keep open, and **amend the text** to state precisely what residual exposure
  survives the stamp (e.g. "only on the un-stamped fallback path, which is …")

**Acceptance:** all four have been individually traced and either closed with a
named code path or amended with their residual scope. No finding is left saying
"the real fix is a dispatch-time stamp" when that stamp exists.

**Out of scope:** changing `review-census.mjs`. This is an audit.

---

## W2 — Give findings a `kind`, and stop defaulting severity

**Goal:** the headline number becomes *open bugs*, and severity becomes a judgment.

**Files:**
- `packages/cli/src/findings.mjs` — add `KINDS`, thread `kind` through `addFinding`
- `packages/cli/src/findings-cli.mjs` — parse `--kind` (arg loop ~`:67`), render it
  in `list` (~`:93`), document it in `usage()` (~`:14`)
- `packages/cli/src/findings.test.mjs` — new cases
- `.forge/findings.jsonl` — backfill (see below)

**Design:**

```
KINDS = ['bug', 'debt', 'tradeoff', 'idea', 'process']
```

- `bug` — a defect that is true right now and would be wrong if a user hit it
- `debt` — works, but costs more to maintain than it should (F55: duplicated fixtures)
- `tradeoff` — a deliberate decision recorded so it is not rediscovered as a bug
  (F19, F51 both say "deliberately" in their own text)
- `idea` — an improvement worth doing that fixes nothing broken (F36)
- `process` — a lesson about how to work, not about the code (F46)

**`kind` is required on new findings.** No default — a default is what produced
"24 of 26 major". For the same reason, drop the `?? 'major'` at `findings.mjs:66`
and require `--severity` too, **or** default to `minor` so the cost of not
thinking is understatement rather than alarm. Prefer required; the CLI is only
ever driven by an agent that can read the error.

**Backfill.** Classify all 71 existing rows. The 26 open ones have strong textual
signals already — "pre-dates", "not a regression", "deliberately", "Consider a",
"Process, for me:". Do not batch-guess with a regex: read each one. Write the
backfill as a one-shot script under `scripts/`, run it, delete the script, and
commit the rewritten `findings.jsonl` — *except* that `.forge/` is gitignored
(`.forge/.gitignore` is `*`), so the ledger itself is local-only. Record the
before/after counts in the commit message so the next reader can see the shift.

**Acceptance:**
- `forge finding add` refuses without `--kind`, with an error naming the five kinds
- `forge finding list` shows kind, and defaults to `--kind bug` (with a footer line
  stating how many non-bug findings are hidden and how to see them)
- `forge finding list --all-kinds` shows everything
- all 71 rows carry a `kind`
- `forge status`'s `openFindings.count` counts **bugs only**, and the JSON gains
  `openFindings.byKind`

**Expected result:** open *bugs* lands in single digits. Whatever it is, it is the
first honest number this project has had.

---

## W3 — Let findings reference each other

**Goal:** closing a root cause surfaces its dependents. The absence of this is what
made W1 necessary.

**Files:** `packages/cli/src/findings.mjs` (`addFinding`, `resolveFinding` at `:88`),
`packages/cli/src/findings-cli.mjs`, `packages/cli/src/findings.test.mjs`

**Design:**
- new optional field `dependsOn: string[]` — ids whose fix would change this finding
- `forge finding add … --depends-on F12,F18`
- `forge finding link <id> --depends-on <ids>` to add the edge after the fact
- on `forge finding resolve <id>`, print every open finding with `<id>` in its
  `dependsOn` under a heading: `Re-check these — their root cause just closed:`
  and **exit non-zero-free but loud**; do not auto-resolve them. A dependent may
  survive its root cause with reduced scope (that is exactly the F11 case).

**Acceptance:**
- resolving a finding with open dependents lists them by id and first line
- a test covers: resolve with dependents → they are listed and remain `open`
- backfill the known edges: F11, F18, F19, F51 → `dependsOn: ['F12']`

---

## W4 — Make a reopened finding the loudest object in the ledger

**Goal:** a fix that did not hold must not render like an idea.

Today "REOPENED" is a convention *inside the text* — F11 opens `"REOPENED (was F3,
reverted in 0.3.26)"`, F13 `"REOPENED (was F10, …)"`. Two entries in the whole
ledger prove a shipped fix regressed, and they are typographically identical to
"Consider a doc-contract test".

**Design:**
- structured field `reopenedFrom: string | null` and `reopenCount: number`
- `forge finding reopen <id> --from <oldId> --note "<why the fix did not hold>"`
  moves a resolved finding back to `open`, increments `reopenCount`, keeps history
- `forge finding list` marks them (e.g. `F11  bug  major  ↻2`) and sorts them first
- `forge status` names any finding with `reopenCount >= 1` in its own field —
  separate from `openFindings`, because the count is not the point, the identity is
- **a finding with `reopenCount >= 2` blocks `forge phase done` on any change that
  touches its subject**, unless explicitly waived like the final-review waiver
  (`--final-review-waived` is the precedent to copy)

**Acceptance:** F11 and F13 carry `reopenedFrom: 'F3' / 'F10'` and `reopenCount: 1`;
`forge status` names them; tests cover the reopen transition and the sort order.

---

## W5 — Build the corpus fixture F11 has been demanding since 07-28

**This is the one item that would have prevented an actual escape.** Both reopens
happened because a heuristic was narrowed and measured afterwards.

F11's own text is the spec: *"Any future narrowing must be measured against a real
corpus of both risky and benign sentences BEFORE shipping, and must tolerate
arbitrary whitespace between qualifier and noun."*

**Build:**
- a fixture file of real sentences — **risky** ("alters the public contract of the
  /v1/orders endpoint", "breaking change to the data contract", "the OpenAPI
  contract gains two required fields") and **benign** (ordinary software English
  about a function's promise, the `harness-setup-probe` comment from F1)
- source them from this repo's own archived `proposal.md` / `design.md` /
  `tasks.md` files under `specs/changes/archive/` — that is a real corpus, already
  on disk, and it is the exact population the detector runs against
- include the 80-column hard-wrapped forms: F11 records that qualifiers requiring a
  single space or hyphen were disarmed by a line break
- a test asserting the current detector's classification of every sentence, so any
  future change to `THOROUGH_RE` shows up as an explicit diff of which sentences
  changed side

**Acceptance:** the test exists, passes against today's behaviour, and its failure
output names the individual sentences that changed classification. Nobody should
ever again be able to narrow that regex without seeing exactly what they lost.

**Note:** the fixture-duplication problem in F55 is adjacent — three near-copies of
the host-tree helpers across test files. If you are already in the test tree,
consider doing both; if that widens the change too far, file it as `debt` and move
on.

---

## W6 — Route the ledger into what gets worked on next

**Goal:** close the loop that makes the residue the hard core. Easy findings get
picked because nothing surfaces the important ones at the moment work is chosen.

**Files:** `packages/cli/src/new-session.mjs`, `packages/cli/src/session-status.mjs`

**Design:**
- `forge new <slug>` prints open **bugs** whose `change` or text matches the new
  slug's subject, before the session starts. Informational, not blocking.
- `forge status` gains `staleFindings`: open bugs older than 7 days, by id and age.
- both stay advisory. Do **not** add a blocking gate here — W4's reopen gate is the
  only new refusal this plan introduces, and one is enough to evaluate.

**Acceptance:** starting a session on a subject with open bugs shows them; a
7-day-old open bug appears in `forge status`.

---

## W7 — Write the rules down where agents read them

`skills/forge/SKILL.md` already says findings exist so an observation does not go
"into a report the next session will not read". Twenty-six open findings *is* that
report. Add to the Guardrails section:

- **fix beats file** — if the fix is smaller than the write-up, make the fix
- `--kind` and `--severity` are deliberate choices, not defaults
- resolving a root cause obliges re-checking its dependents
- never narrow a heuristic without a corpus measured first

Mirror into `docs/usage.md` and `skills/forge/docs/forge.md` wherever
`forge finding` is documented.

---

## Order, and why

```
W1  audit  ──────────────► free, sizes everything else, may close 4
W2  kind + severity ─────► makes the number mean something
W3  links ───────────────► stops W1 from being needed again
W4  reopen ──────────────► surfaces the only proven escapes
W5  corpus ──────────────► prevents the next escape
W6  routing ─────────────► stops the residue from calcifying
W7  docs ────────────────► stops the behaviour from recurring
```

W1 before W2 because the audit may close four findings and change what the
backfill is classifying. W3 before W4 only by convenience — both touch
`findings.mjs`; consider one change covering W2+W3+W4 if the reviewer is
comfortable with the size. W5 is independent and can run in parallel.

## How we will know it worked

Re-run these after the work lands. They are the same queries that produced the
table at the top, so the comparison is exact.

```bash
# open by kind — the headline number
forge finding list --json | jq -r '.[] | select(.status=="open") | .kind' | sort | uniq -c

# open-count trend, end of each day
node -e '…'   # the event-replay over createdAt/resolvedAt used on 2026-07-31

# per-session net: created minus resolved inside each session window
```

**Success is not "open bugs is zero."** It is:

1. **open `bug` count is a single digit and falls week over week**
2. **no finding stays open past the fix of its root cause** — W3 makes this
   mechanical
3. **reopen count stops growing** — W5 is the test of that; a third reopen after
   the corpus lands means the corpus is wrong, and that is a real signal rather
   than another entry on a list

If after all seven items the open bug count still climbs, the problem is not
bookkeeping and this plan was wrong. Say so in a report and reopen the question —
but say it with the queries above, not with the raw ledger count, which is what
sent us down this path in the first place.
