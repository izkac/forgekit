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
  models.local.json            ← optional; only after `forge:models -- <lane>`
  preferences.local.json       ← optional; only after `forge:prefs -- <pace>`
  sessions/<session-id>/
    session.json
    status.json
    brainstorm/
      notes.md
      decisions.md
    plan.md                    ← throwaway plans only
    verify-evidence.md         ← tier 3 (scope from pace)
    tasks/
      01-<slug>/
        brief.md
        test-evidence.md
        task-review.md
    reviews/
      final-review.md
```

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
| `tasksTotal` / `tasksComplete` | Implementation progress |
| `pace` | Requested pace (`auto` \| `thorough` \| `standard` \| `brisk` \| `lite`) |
| `resolvedPace` | Concrete pace after auto resolve or pin |
| `paceReason` | Why auto picked this pace |
| `paceSignal` | Text used for auto resolve |
| `pacePinned` | `true` when checkout/session set an explicit concrete pace |

Under `standard` (`review.perTask: per-group`), also write `group-review.md` when an OpenSpec `tasks.md` section completes (see [pace.md](./pace.md)).

| `preferencesOverride` | Optional session-only prefs patch |
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
| `forge phase <phase>` | Update phase |
| `forge cleanup` | Prune stale sessions |

Pace matrix: [pace.md](./pace.md).
