# `.forge/` session layout

Gitignored scratch space. Only [`.forge/README.md`](../../../.forge/README.md) is committed.

## Per-checkout active session

`.forge/active.json`:

```json
{
  "sessionId": "2026-06-05T143022Z-my-feature-a3f9b2",
  "sessionPath": ".forge/sessions/2026-06-05T143022Z-my-feature-a3f9b2",
  "updatedAt": "2026-06-05T14:30:22.000Z"
}
```

One active session per checkout (same pattern as `.impeccable/active.json`).
Optional `cursorChatId` on `session.json` when available — not required.

## Session directory

```
.forge/
  active.json
  models.local.json            ← optional; after `forge:models -- <lane>` or a hand-written
                                 per-tier overlay (enforced by the PreToolUse hook if wired)
  preferences.local.json       ← optional; only after `forge:prefs -- <pace>`
  sessions.jsonl               ← one digest line per finished session; survives cleanup.
                                 `reviews` carries eight keys — `total`,
                                 `independent`, `selfChecks`, `rejections`,
                                 `final`, `evidence`,
                                 `stoppedByOperator` and `rule` — the grade says
                                 how the verdict was reached, and a line with no
                                 `evidence` predates the field and reads as
                                 unknown, never as a grade.
  scorecards.jsonl             ← one scorecard line per finished session
  deferrals.jsonl              ← unresolved deferrals, promoted out before deletion
  sessions/<session-id>/
    session.json
    status.json
    metrics.json               ← host telemetry; written at phase finish|done and by
                                 `forge metrics collect`. Counts only — never prompts,
                                 responses, command strings or file contents.
    dispatches.jsonl           ← one line per subagent dispatch the model policy saw,
                                 written by the `forge enforce-model` PreToolUse hook
    brainstorm/
      notes.md
      decisions.md
    plan.md                    ← throwaway plans only
    verify-evidence.md         ← tier 3 (scope from pace)
    spec-verify.md             ← specs leftover sweep (always on for planType: specs)
    openspec-verify.md         ← OpenSpec leftover sweep (when skill present)
    tasks/
      01-<slug>/
        brief.md
        test-evidence.md
        task-review.md
    reviews/
      final-review.md
```

Everything under `sessions/<session-id>/` dies with `forge cleanup`. The three
`*.jsonl` ledgers at the top are what survive, which is why `sessions.jsonl`
carries a compact `metrics` block and `dispatches` counts rather than only a
pointer to files that will be gone.

Bare `forge models` / `forge:prefs` **print** effective values from committed
defaults and do **not** create the `*.local.json` files. See [pace.md](./pace.md) and
[docs/forge.md](../docs/forge.md) § Checkout-local overrides.

## session.json fields

| Field | Description |
| ----- | ----------- |
| `id` | Session directory name |
| `slug` | Short kebab label |
| `phase` | Current Forge phase |
| `planType` | `openspec` (default for new work), or legacy `throwaway` / `direct` |
| `openspecChange` | Change folder name when `planType: openspec` |
| `forgeSkipped` | `true` if user invoked `/forge:skip` |
| `tasksTotal` / `tasksComplete` | Implementation progress (healed from linked `tasks.md` checkboxes on status/fleet/reminder) |
| `pace` | Requested pace (`auto` \| `thorough` \| `standard` \| `brisk` \| `lite`) |
| `resolvedPace` | Concrete pace after auto resolve or pin |
| `paceReason` | Why auto picked this pace |
| `paceSignal` | Text used for auto resolve |
| `pacePinned` | `true` when checkout/session set an explicit concrete pace |

Under `standard` (`review.perTask: per-group`), also write `group-review.md` when an OpenSpec `tasks.md` section completes (see [pace.md](./pace.md)).

| `preferencesOverride` | Optional session-only prefs patch |
| `reviewVerdict` | `{final, evidence, stoppedByOperator}` — frozen at `forge phase finish\|done`, before the money/auth gate reads it. `evidence` is `host` (decided from the host's record of a dispatch **this session labelled** — the description carries the Forge session id, so a neighbour sharing the conversation cannot be mistaken for it; note a `host` grade with no matching dispatch is the verdict that refuses), `inferred` (read from the review file's wording — either no host record survives, or none of this session's dispatches carries a label so the convention is not in use here), or `none` (there is no final review to judge). Frozen rather than recomputed because transcripts are pruned within days; a `host` verdict of `independent` is never later downgraded to a guess. |
| `host` | `{agent, sessionIds[], boundAt}` — which host agent sessions drove this one. Filled from `CLAUDE_CODE_SESSION_ID` (Claude → `claude-code`) or, when that is absent, `CURSOR_CONVERSATION_ID` / `CURSOR_TRACE_ID` (Cursor → `cursor`) on every `forge new` / `forge phase`, so no hook is needed. A Cursor conversation id also fills `cursorChatId` when unset. Ids accumulate: a session resumed tomorrow under a new host session appends rather than replaces, and a command run outside a host never erases an existing binding. This is what lets telemetry find the right transcripts (Claude paths today; Cursor harvest later). |
| `phaseHistory` | Chronological `[{phase, at}]` trail, appended on every real transition. Re-entering the same phase does not add a row (`forge phase implement --tasks-complete N` runs after every task). It is the join key that attributes host requests to the phase they were spent in. |
| `createdAt` / `updatedAt` | ISO timestamps |

## Retention

**14 days.** Run `forge cleanup` to prune old or finished sessions.

## Scripts

| Script | Purpose |
| ------ | ------- |
| `forge new <slug>` | Create session + set active (resolves pace; warn-only doctor) |
| `forge status` | Read active session (+ effective pace) |
| `forge prefs` | Get/set pace preferences |
| `forge doctor` | OpenSpec project + CLI check |
| `forge phase <phase>` | Update phase (also collects metrics on `finish`/`done`) |
| `forge metrics collect` | Harvest host transcripts → `metrics.json` for a session |
| `forge analyze [--json]` | Read the ledgers back as numbers (read-only) |
| `forge cleanup` | Prune stale sessions |

Pace matrix: [pace.md](./pace.md).
