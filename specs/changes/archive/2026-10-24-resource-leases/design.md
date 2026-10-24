# Design — resource leases and worktree slots

## Context
`tier3-lock.mjs` already gives one exclusive, cross-worktree, fail-open lock around
`forge evidence --tier3` (scope full). The lock is held by the forge process around `spawnSync`.
A PreToolUse hook exits before the tool's command starts, so a hook cannot hold a lock: the lock
must live in a wrapper process (`forge lease`).

Orchestrators: T3 Code runs Claude through the Agent SDK with project settings loaded (Forge hooks
run) and enforces runtime modes through the SDK permission host (`canUseTool`). Cursor's SDK loads
project hooks too. Codex has no project hooks.

## Decisions

### D1 — Deny-only guard hook (ADR-candidate)
The hook either denies, with an instruction to rerun as `forge lease <name> -- <cmd>`, or prints
nothing. It never returns `allow` and never sets `updatedInput` / `updated_input`.
- *Rewrite + allow* was rejected: it skips the permission prompt, bypassing user prompts and T3's
  approval-required mode.
- *Rewrite + ask* was rejected: it forces a prompt even in auto mode.
- Both rewrites break the user's permission rules, because rules match the rewritten text.
Cost of D1: one retry (~200 tokens) per bypassing command; leased commands are rare.

### D2 — Script-wrapped leases are the primary path
`match` is optional. A project can wrap its own scripts (`"test": "forge lease tests -- vitest run"`),
which works the same on every host, including Codex and the terminal. The hook only catches agents
that run a contended tool directly.

### D3 — One lock implementation
`lib/lease.mjs` replaces `tier3-lock.mjs` and keeps its semantics: holder JSON, dead-pid takeover,
30 s stale-unparseable takeover, Windows `EPERM`/`EACCES` retries, fail-open with warning,
release-only-own-lock, exit backstop. Addition: `waitMs` (default ∞ for direct calls) →
`LeaseBusyError`. Lease names match `^[a-z0-9][a-z0-9-]*$`; `_`-prefixed names are internal
(`_slots`); `tier3` is reserved. Exclusive only — `max: N` is deferred.

### D4 — Lock order (revised after the final review)
`tier3` is always the outermost lease: `forge evidence` takes `tier3` first (full scope), then the
matching configured leases sorted by name. A full-scope `forge evidence --tier3` started while its
caller already holds another lease (`FORGE_LEASES_HELD`, live holder) refuses with exit 2 — that
nesting (`forge lease tests -- forge evidence --tier3 …`) was the one path that took a named lease
before `tier3` (final review, Important 3: a cycle with a full run whose script wraps
`forge lease tests`, broken only by `waitMs` and misread as a red full run). `tier3` therefore never
takes part in a cycle. Named leases acquired by nested scripts can still interleave in different
orders across sessions; such cycles are bounded by `waitMs` (exit 75), never permanent.
`forge lease` takes one lease.

### D5 — Hook fast path
The hook reads `.forge/config.json` directly and exits silently when no lease has `match` entries.
Only then does it spawn `node <forge.mjs> lease check --command <cmd> --json` (argv, `shell: false`,
per project-wiring's shell-safety requirement). Any error → silent allow-through + one stderr line.

### D6 — Slots
`<common>/forge/slots.json` maps absolute worktree path → integer. The main worktree (first entry of
`git worktree list --porcelain`) and non-git dirs are 0. Allocation runs under lease `_slots`: read,
prune paths not in `git worktree list`, reuse the existing entry or assign the lowest free ≥ 1, then
write atomically (temp + rename). A corrupt file is rebuilt with a warning.

### D7 — Slot env delivery
Templates in `slots.env` support only `{slot}` and `{N+slot}`; `FORGE_SLOT` is always present.
Delivery is a dotenv file `.forge/slot.env` (covered by `.forge/.gitignore`'s `*`), rewritten only
when its content changes, by `forge slot`, `forge new` and the SessionStart reminder. It is written
only when `slots.env` is configured. `CLAUDE_ENV_FILE` was rejected: on Windows PowerShell it drops
values containing `/` or `\`.

### D8 — `forge lease` execution
After the lease is taken: on POSIX `spawnSync(argv[0], argv.slice(1), { shell: false, stdio: 'inherit' })`
so the caller's argv is never re-parsed; on Windows a single quoted command string with `shell: true`
(cmd.exe) so `.cmd` shims such as `npm` resolve. The command is the caller's own, typed into the
host's shell tool and visible to its permission system, so it does not go through the exec gate.
Exit code passthrough; busy after the wait → exit 75 (`EX_TEMPFAIL`) with holder slug/pid/start time; the
command never ran.

## Risks
- Pid reuse makes a dead holder look alive → waiters wait up to `waitMs` (∞ for tier3). Carried-over
  ceiling; the notice names the lock file to delete by hand.
- Regex patterns written by users can over-match (e.g. `test`). Mitigation: docs recommend
  word-boundary patterns; the deny message names the matching lease and pattern.
- Nesting (`forge lease db -- forge evidence -- <db cmd>`, or a guard-wrapped `npm run db:migrate`
  whose script itself calls `forge lease db`) would make the inner acquisition wait on its own parent.
  D9 makes such nested acquisitions re-entrant.

### D9 — Re-entrant nested leases (added during implement, group-5 review)
`forge lease` exports `FORGE_LEASES_HELD=<name>:<pid>[,…]` to its child. A nested `forge lease` /
`forge evidence` acquisition of a listed lease proceeds without waiting only if the lock file
currently names that pid and the pid is alive — a stale or copied variable falls back to normal
acquisition. The nested call never releases the parent's lease. Alternatives rejected: documenting
"don't match your own wrapped scripts" (a trap the guard itself walks agents into), and exempting
`npm run` commands in the guard (too broad).
- "Already wrapped" detection is substring-based (`forge lease`, `forge evidence`); a chained command
  containing either is treated as wrapped as a whole. Accepted.
