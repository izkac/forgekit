# Resource leases and worktree slots

## Why
Several agent sessions often work on one repository at once, in the same checkout or in separate
git worktrees. Worktrees stop file clashes, but shared resources (a database, a full test run,
dev-server ports) are still contended. Today only full tier-3 runs are serialized
(`tier3-lock.mjs`), and nothing gives a worktree its own DB name or port. Forge also has to keep
working unchanged under orchestrator layers such as T3 Code, which enforce their own permission
modes on agent tool calls.

## What Changes
- Generalize the tier-3 lock into **named leases** at `<git-common-dir>/forge/leases/<name>.lock`,
  with an optional bounded wait. `tier3` becomes a built-in lease.
- New CLI: `forge lease <name> [--wait-ms N] -- <cmd…>`, `forge lease list`, `forge lease check`.
- New opt-in config `.forge/config.json → leases`, mapping a lease name to optional `match` regexes
  and `waitMs`.
- New **deny-only** guard hook `forge-lease-guard.mjs` (Claude Code `Bash|PowerShell`, Cursor
  `Shell`). It blocks an unwrapped command that matches a lease and tells the agent the wrapped
  form. It never rewrites and never approves.
- `forge evidence` takes the configured leases that match its command.
- New **worktree slots**: main checkout = 0, linked worktrees get the lowest free integer;
  `slots.env` templates (`{slot}`, `{N+slot}`); `forge slot`, `forge slot env`, and a
  gitignored `.forge/slot.env`.
- `forge init` wires the guard hook (no permission allow rule); `forge doctor` checks that hooks
  can resolve `forge`.

## Capabilities
- `resource-leases`: named leases, CLI, config, guard hook — delta at `specs/resource-leases/spec.md`
- `worktree-slots`: slot allocation, env templates, slot env file — delta at `specs/worktree-slots/spec.md`
- `test-runs`: tier-3 lock moves onto leases; evidence takes matching leases — delta at `specs/test-runs/spec.md`
- `project-wiring`: init wires the guard hook; doctor checks forge resolvability — delta at `specs/project-wiring/spec.md`

## Impact
- Code: `packages/cli/src/lib/lease.mjs` (new; replaces `tier3-lock.mjs`), `lib/lease-config.mjs`,
  `lib/slots.mjs`, `lease-cli.mjs`, `slot-cli.mjs`, `record-evidence.mjs`, `init.mjs`, `health.mjs`
  (doctor), `session-reminder.mjs`, `new-session.mjs`, `bin/forge.mjs`; hook templates under
  `templates/project/{claude,cursor}/hooks/` and this repo's `.claude/hooks/` copy.
- Upgrade: the tier-3 lock path moves from `<common>/forge/tier3.lock` to
  `<common>/forge/leases/tier3.lock`; old- and new-version sessions running at once won't wait for
  each other. The lock is perf-only, so this is accepted.
- Orchestrators: no host permission decision is ever made by Forge; Codex (no project hooks) relies
  on script-wrapped leases.
- Out of scope: agent-to-agent messaging, per-slot DB creation, multi-holder leases.
