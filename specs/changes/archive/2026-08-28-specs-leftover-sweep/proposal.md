# Specs leftover sweep before final review

## Why

OpenSpec sessions already run a repo-wide leftover sweep at the end of verify
(`openspec-verify-change`, then `openspec-verify.md` with `Remaining: none`)
before the final reviewer. Specs-engine sessions skip that gate on purpose:
there is no vendor CLI, and the final reviewer is forbidden from grepping the
tree. Implementers stay inside `tasks.md`. Leftover docs, imports, fixtures,
and files nobody listed therefore survive a green verify — the same hole the
OpenSpec sweep was added to close.

## What Changes

- Specs sessions (`planType: specs`) always run a leftover sweep during verify,
  before the final reviewer (and before the combined closer).
- The coordinator follows a Forge-owned skill (no OpenSpec CLI). It checks
  tasks, delta requirements, design decisions, **and** leftover uses of names
  the change is retiring, including files `tasks.md` never listed.
- Every finding is fixed (CRITICAL, WARNING, SUGGESTION) unless it is an
  explicit no-action or a recorded design decision.
- The report is `.forge/sessions/<id>/spec-verify.md` with a `Remaining: none`
  line. `forge phase review` and `forge phase done|finish` refuse without it.
- Specs sessions still do **not** need `openspec-verify.md`. OpenSpec sessions
  still use the vendor skill and `openspec-verify.md` when that skill is present.

## Capabilities

- `session-lifecycle`: specs leftover sweep is a verify/review/done gate
- `test-guard`: `spec-verify.md` is an integrity artifact with the same freeze
  window as `openspec-verify.md` (editable through verify, frozen from review)

## Impact

CLI gate (`set-phase`, leftover-verify helpers), test-tamper guard, Forge
verify/close/apply copy, a bundled skill. Operators on specs-engine projects
see a new verify announcement and a new session file. OpenSpec behaviour is
unchanged. Combined close still sweeps before the closer.
