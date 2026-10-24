# Delta for Resource Leases

## ADDED Requirements

### Requirement: Named leases are exclusive across worktrees
The system SHALL provide named exclusive leases stored at `<git-common-dir>/forge/leases/<name>.lock`
(at `<project>/.forge/leases/<name>.lock` outside git), so every worktree of one repository shares
them. A lease name SHALL match `^[a-z0-9][a-z0-9-]*$`; names starting with `_` are internal and
`tier3` is reserved for `forge evidence`. While a live process holds a lease, an acquirer SHALL wait
and print the holder's session slug (or pid), pid and start time at most once per minute. A lease
whose holder pid is not running SHALL be taken over. When the lease file cannot be created, the
caller SHALL proceed unlocked with a warning. Releasing SHALL remove the file only when it still
names the releasing process.

#### Scenario: Two worktrees contend for one lease
- GIVEN process A holds lease `db` in worktree W1
- WHEN process B acquires lease `db` in worktree W2 of the same repository
- THEN B waits and prints A's slug and pid
- AND B acquires the lease only after A releases it

#### Scenario: Dead holder is taken over
- GIVEN `db.lock` names a pid that is not running
- WHEN a process acquires `db`
- THEN it acquires without waiting

#### Scenario: Invalid lease name
- GIVEN the name `../etc`
- WHEN `forge lease ../etc -- <cmd>` runs
- THEN it exits non-zero with a message naming the allowed pattern
- AND the command does not run

### Requirement: Bounded wait reports a busy lease
An acquirer given a `waitMs` SHALL stop waiting once that much time passes and fail with the
holder's identity. `forge lease` SHALL exit with code 75 in that case and SHALL NOT run the command.

#### Scenario: Wait expires
- GIVEN process A holds lease `db`
- WHEN `forge lease db --wait-ms 500 -- node -e "process.exit(0)"` runs
- THEN it exits 75 within a few seconds
- AND stderr names lease `db` and A's pid
- AND the command did not run

### Requirement: Lease CLI runs a command under a lease
`forge lease <name> [--wait-ms N] -- <cmd…>` SHALL acquire the lease, run the command with inherited
stdio **in the directory `forge lease` was invoked from** (argv on POSIX; a quoted cmd.exe string on
Windows so `.cmd` shims resolve), release the lease, and exit with the command's exit code.
Without `--wait-ms`, the wait SHALL be the configured `waitMs` for that lease, else 540000 ms. An
unconfigured name SHALL be accepted as an ad-hoc lease. `forge lease list [--json]` SHALL list every
lease file with its holder and whether the holder is alive.

#### Scenario: Exit code passthrough
- GIVEN no holder of lease `tests`
- WHEN `forge lease tests -- node -e "process.exit(3)"` runs
- THEN it exits 3
- AND `tests.lock` no longer exists

#### Scenario: Wrapped script in a workspace package
- GIVEN a repository with `.forge/` at its root and a package directory `packages/api`
- WHEN `forge lease db -- node -e "console.log(process.cwd())"` runs from `packages/api`
- THEN the command prints the `packages/api` path

#### Scenario: List shows the holder
- GIVEN process A holds lease `db`
- WHEN `forge lease list --json` runs
- THEN the output contains `db` with A's pid and `alive: true`

### Requirement: Nested acquisition by a descendant is re-entrant
While `forge lease <name>` or `forge evidence` runs its command, it SHALL export `FORGE_LEASES_HELD`
to the child, listing every lease that process holds (comma-separated `<name>:<pid>` entries,
appended to any inherited value). A `forge lease` or
`forge evidence` acquisition of a lease that appears in `FORGE_LEASES_HELD` SHALL proceed without
waiting and without taking or releasing the lease **only when** that lease's lock file currently
names the listed pid and that pid is alive; otherwise it SHALL acquire normally. Leases are a
coordination aid, not a security boundary, so a spoofed variable only affects the caller itself.

#### Scenario: Wrapped script matched by its own lease
- GIVEN `leases.db.match` matches `npm run db:migrate` and the `db:migrate` script is `forge lease db -- <cmd>`
- WHEN the agent runs `forge lease db -- npm run db:migrate`
- THEN the inner `forge lease db` runs `<cmd>` immediately
- AND `db.lock` still names the outer process until the outer command exits

#### Scenario: Stale variable does not bypass a real holder
- GIVEN `FORGE_LEASES_HELD=db:<pid of a dead process>` and process A holds `db`
- WHEN `forge lease db --wait-ms 500 -- <cmd>` runs
- THEN it exits 75 and `<cmd>` does not run

### Requirement: Opt-in lease configuration
`.forge/config.json` MAY contain `leases`, an object from lease name to `{ match?: string[], waitMs?: number }`.
Each `match` entry SHALL be a JavaScript regular-expression source tested against the whole command
string. An entry that fails to compile SHALL be skipped with a warning while the other entries still
apply. A `leases.tier3` entry or an invalid name SHALL be ignored with a warning. Without `leases`
the system SHALL take no leases except `tier3`.

#### Scenario: Invalid regex does not disable the lease
- GIVEN `leases.db.match` is `["(", "prisma migrate"]`
- WHEN `forge lease check --command "npx prisma migrate dev" --json` runs
- THEN the result is `deny` for lease `db`
- AND a warning names the invalid pattern

### Requirement: Lease check decides for the guard
`forge lease check --command <cmd> [--json]` SHALL return `{ "action": "deny", "lease", "pattern", "reason" }`
when a configured `match` pattern hits the command and the command does not contain `forge lease`
or `forge evidence`, and `{ "action": "none" }` otherwise. The deny reason SHALL tell the agent to
rerun the command as `forge lease <name> -- <cmd>` with a tool timeout of at least 10 minutes or in
the background. When the command contains a shell chain or pipe (`&&`, `||`, `;`, `|`), the reason
SHALL instead tell the agent to wrap only the part that needs the lease, or move the chain into a
project script and wrap that, since the shell would otherwise lease only the first command. When several leases match, it SHALL name the first in lease-name order.

#### Scenario: Unwrapped matching command
- GIVEN `leases.db.match` is `["prisma migrate"]`
- WHEN `forge lease check --command "npx prisma migrate dev" --json` runs
- THEN the action is `deny` with lease `db`
- AND the reason contains `forge lease db -- npx prisma migrate dev`

#### Scenario: Already wrapped command
- GIVEN the same configuration
- WHEN `forge lease check --command "forge lease db -- npx prisma migrate dev" --json` runs
- THEN the action is `none`

### Requirement: Guard hook only ever denies
The shipped `forge-lease-guard.mjs` hook SHALL run as a Claude Code PreToolUse hook (matcher
`Bash|PowerShell`) and a Cursor `preToolUse` hook (matcher `Shell`). When `.forge/config.json` has
no lease with `match` entries it SHALL pass the command through (see below) with no output and
without spawning `forge`. Otherwise
it SHALL run `forge lease check` and, on `deny`, emit the host's deny shape: Claude
`hookSpecificOutput.permissionDecision: "deny"` with the reason; Cursor `permission: "deny"` with
`agent_message`. It SHALL NEVER emit an allow decision, `updatedInput` or `updated_input`. On any
internal error it SHALL make no decision and write one stderr warning. Every non-deny outcome SHALL
let the command through without approving it: in Claude Code by exiting 0 with no output; in Cursor
by exiting 1 with no output, because Cursor treats exit 0 without valid JSON as a block and documents
other non-2 exit codes as fail-open. It SHALL apply whether or not a Forge session is active.

#### Scenario: Orchestrator permission mode is preserved
- GIVEN a configured lease that does not match `ls -la`
- WHEN the hook receives a Claude PreToolUse payload for `ls -la`
- THEN it prints nothing and exits 0
- AND the host's permission flow decides as if no hook ran

#### Scenario: Matching command is denied with instructions
- GIVEN `leases.db.match` is `["prisma migrate"]`
- WHEN the hook receives a Claude PreToolUse payload for `npx prisma migrate dev`
- THEN it outputs `permissionDecision: "deny"` with a reason naming `forge lease db --`
- AND the output contains no `allow` decision and no `updatedInput`

#### Scenario: Cursor payload
- GIVEN the same configuration
- WHEN the hook runs in Cursor format with a `Shell` payload for `npx prisma migrate dev`
- THEN it outputs `{"permission":"deny", "agent_message": …}`

#### Scenario: Broken input fails open
- GIVEN a project with at least one lease that has `match` entries, and unparseable stdin
- WHEN the hook runs in Claude Code format
- THEN it exits 0 with no output and one stderr warning line
- AND in Cursor format it exits 1 with no output and one stderr warning line

#### Scenario: Cursor pass-through approves nothing
- GIVEN a configured lease that does not match `ls -la`
- WHEN the hook runs in Cursor format with a `Shell` payload for `ls -la`
- THEN it exits 1 with no stdout
- AND it never prints `permission: "allow"`
