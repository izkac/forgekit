# Tasks

## 1. Lease core
- [x] 1.1 Create `packages/cli/src/lib/lease.mjs` from `tier3-lock.mjs`: `leasePathFor(cwd, name)` → `<common>/forge/leases/<name>.lock`, name validation (`^[a-z0-9][a-z0-9-]*$`, `_` internal), `acquireLease({ cwd, name, sessionId, slug, waitMs, pollMs, notify })` throwing `LeaseBusyError` after `waitMs`. Move `tier3-lock.test.mjs` cases to `lease.test.mjs` and add waitMs-expiry, named-path and invalid-name cases. Verify: `node --test packages/cli/src/lease.test.mjs`
- [x] 1.2 Add `listLeases(cwd)`; switch `record-evidence.mjs` to `acquireLease({ name: 'tier3' })` (wait unbounded); delete `tier3-lock.mjs`; update `record-evidence-lock.test.mjs` / `tier3`-path tests to the new path. Verify: `node --test packages/cli/src/lease.test.mjs packages/cli/src/record-evidence-lock.test.mjs`
- [x] 1.3 Create `packages/cli/src/lib/lease-config.mjs`: `readLeaseConfig(cwd)` → `{ leases, warnings }` (invalid regex skipped, `tier3`/invalid names ignored, default `waitMs` 540000) and `matchLease(command, config)` with already-wrapped detection (`forge lease`, `forge evidence`) and lease-name order. Verify: `node --test packages/cli/src/lease-config.test.mjs`

## 2. Lease CLI and evidence integration
- [x] 2.1 `packages/cli/src/lease-cli.mjs` + `bin/forge.mjs` wiring: `forge lease <name> [--wait-ms N] -- <cmd…>` (shell spawn, stdio inherit, exit passthrough, 75 on busy, invalid name refused) and `forge lease list [--json]`. Verify: `node --test packages/cli/src/lease-cli.test.mjs`
- [x] 2.2 `forge lease check --command <cmd> [--json]` returning `{action, lease, pattern, reason}` with the rerun instruction. Verify: `node --test packages/cli/src/lease-cli.test.mjs`
- [x] 2.3 `record-evidence.mjs` takes matching configured leases in name order before `tier3`; on busy it fails without stamping. Verify: `node --test packages/cli/src/record-evidence-lease.test.mjs`

## 3. Guard hook and wiring
- [ ] 3.1 `templates/project/claude/hooks/forge-lease-guard.mjs` (+ byte-identical `.claude/hooks/` copy): config fast path, `node <forge.mjs> lease check` via `resolve-forge.mjs` with `shell: false`, Claude deny JSON, never allow/updatedInput, fail open. Verify: `node --test packages/cli/src/lease-guard-hook.test.mjs`
- [ ] 3.2 Cursor support in the same script (`--format cursor` → `{permission:"deny", agent_message}`) and `templates/project/cursor/hooks/forge-lease-guard.mjs` copy. Verify: `node --test packages/cli/src/lease-guard-hook.test.mjs`
- [ ] 3.3 `init.mjs`: register the guard (Claude PreToolUse `Bash|PowerShell`; Cursor `preToolUse` `Shell`), install hook files, add no allow rule; extend the hooks snippet comment. Verify: `node --test packages/cli/src/init.test.mjs`
- [ ] 3.4 `forge doctor` (`doctor.mjs`): check the hook resolver finds `forge.mjs`; report inert hooks plus the PATH fix for service-hosted orchestrators. Verify: `node --test packages/cli/src/doctor.test.mjs`

## 4. Worktree slots
- [ ] 4.1 `packages/cli/src/lib/slots.mjs`: `slotFor(cwd)` (main/non-git = 0, lowest free ≥ 1, under lease `_slots`, prune via `git worktree list --porcelain`, atomic write, rebuild on corrupt). Verify: `node --test packages/cli/src/slots.test.mjs` (real temp repo + worktrees)
- [ ] 4.2 `renderSlotEnv(config, slot)` (`{slot}`, `{N+slot}`, others verbatim with warning; `FORGE_SLOT` always) and `forge slot` / `forge slot env [--shell dotenv|bash|powershell]` in `slot-cli.mjs` + `bin/forge.mjs`. Verify: `node --test packages/cli/src/slot-cli.test.mjs`
- [ ] 4.3 Write `.forge/slot.env` on change only, when `slots.env` is configured, from `forge slot`, `forge new` and the SessionStart reminder. Verify: `node --test packages/cli/src/slot-env-file.test.mjs` (drives `forge slot`, `forge new` and `forge reminder` in a temp project)

## 5. Docs and product loop
- [ ] 5.1 `docs/usage.md`: leases + slots section (config example, script-wrapping recipe, word-boundary regex advice, an "Orchestrators (T3 Code, …)" note); `skills/forge/references/test-strategy.md`: `forge evidence` takes leases. Verify: docs drift tests `node --test packages/cli/src/pace-doc-drift.test.mjs`
- [ ] 5.2 Product-loop acceptance: new `resource-leases` subcommand in `scripts/e2e/harness-portability.mjs` (prints `RESOURCE LEASES GREEN`) driving the shipped binary in a scratch project (config `db` lease → `lease check` denies → `forge lease db -- …` exits 0 → concurrent `--wait-ms 500` exits 75 → `forge slot` in a linked worktree prints 1 → guard hook payload denies); green `forge e2e run`.
