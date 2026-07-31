# Tasks

## 1. Host bind (Cursor)

- [x] 1.1 RED: extend `packages/cli/src/metrics/host.test.mjs` — Cursor conversation id → `agent: cursor`; Claude wins when both set; blank ids ignored
- [x] 1.2 GREEN: update `detectHost` / `bindHost` in `packages/cli/src/metrics/host.mjs`; set `cursorChatId` from conversation id when unset (`new-session.mjs` or bindHost helper)
- [x] 1.3 Update `skills/forge/references/forge-layout.md` host field docs for Cursor

## 2. Fleet pending + register warning

- [x] 2.1 RED: `packages/cli/src/fleet.test.mjs` — register EACCES writes `fleet-pending.json` under session dir; success clears pending; warning mentions sandbox/`all`
- [x] 2.2 GREEN: implement pending write/clear + louder warning in `packages/cli/src/lib/fleet.mjs` (pass projectRoot + session so pending path is known)
- [x] 2.3 Adjust `saveSession` call site if registerSession signature needs session dir

## 3. Flush + sync

- [x] 3.1 RED: reminder flushes pending when registry writable; `forge fleet sync` registers all project sessions
- [x] 3.2 GREEN: `session-reminder.mjs` flush; `fleet.mjs` `sync` subcommand; wire help in `bin/forge.mjs` / usage
- [x] 3.3 Docs: `docs/usage.md` fleet section + troubleshooting row

## 4. Cursor hooks init + skill

- [x] 4.1 RED: `init.test.mjs` — `forge init --cursor` creates `.cursor/hooks.json`; merges without dropping other hooks
- [x] 4.2 GREEN: `ensureCursorHooks` in `init.mjs`
- [x] 4.3 Skill: Cursor sandbox note in `skills/forge/SKILL.md` (+ forge.md if needed)
- [x] 4.4 Product loop: `forge e2e` notApplicable (CLI library; covered by unit tests + optional sync smoke in harness if cheap) — author spine accordingly
- [x] 4.5 Operator wiring outside forgekit tree: write `/home/iztok/Projects/helm/.cursor/hooks.json`; `forgekit install --skills forge --agents cursor,claude --force` after green verify

## 5. Accept

- [x] 5.1 Tier-2 evidence for host + fleet + init tests; `forge e2e` / spine as planned
