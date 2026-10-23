# Design — smarter test runs

## Lock (`tier3-lock.mjs`)
- Path: `git rev-parse --git-common-dir` (from cwd) → `<common>/forge/tier3.lock`.
  No git → `<cwd>/.forge/tier3.lock`. Worktrees of one repo share the common dir,
  which fleet's project-path key would miss.
- Acquire: `fs.openSync(lock, 'wx')`, write `{ pid, sessionId, slug, cwd, startedAt }`.
  EEXIST → read holder:
  - holder pid dead (`process.kill(pid, 0)` throws ESRCH) → rename lock aside, retry;
  - holder file unparseable and mtime older than 30 s → stale, same as dead;
  - otherwise wait: print `[forge] tier-3 lock held by <slug> (pid N, since T) — waiting`
    once, then every 60 s; poll every 5 s (injectable for tests).
  Any other create error (EPERM/EACCES/ENOENT on mkdir) → stderr warning, return
  a no-op release (fail open — the lock saves time, it guards nothing).
- Release: unlink if the file still names our pid; registered on `exit`,
  `SIGINT`, `SIGTERM` while held.
- Ceiling: two waiters that both see the same dead holder can both run once.
  Acceptable (perf only); upgrade path is rename-and-verify ownership.
- Alternatives rejected: `proper-lockfile` (new dependency for ~60 lines);
  fleet registry (`~/.forgekit/fleet`, project-path key misses worktrees and sits
  outside Cursor's sandbox).

## Stamp scope
- `--scope <full|failed-only|fix|group>`, only valid with `--tier3`; default `full`.
- Stamp gains `scope`. Only `full` acquires the lock.
- Verdict (`proven.tier3`): find the last `full` stamp (missing scope = full).
  - none → null (`tier3 not stamped`, unchanged);
  - green → ok;
  - red, and a later `failed-only` stamp is green → `ok: true, via: 'failed-only'`;
  - red otherwise → not ok.
  `fix` / `group` stamps never change the verdict; `proven.tier3.counts` reports
  stamps per scope.
- The CLI does not check that `failed-only` covered the failing files; the final
  reviewer compares it with the red run's stamped tail.

## Base commits
- `forge new` already records the outer HEAD as `session.baseCommit`. It now also
  sets `session.nestedBaseCommits`: each nested repo (directory with a `.git`
  entry, depth ≤ 2, skipping `node_modules` and dot-directories) → its HEAD,
  keyed by posix relative path. Git failure or an unborn HEAD omits that key;
  no nested repos → field omitted.
- `forge status` prints `nestedBaseCommits` when present.

## Seal refresh
- Write seal via tmp + rename. Retry compute+write up to 3 times on EBUSY / EPERM /
  EACCES with a sync backoff (`Atomics.wait`, 50/100/200 ms). Final failure keeps
  the existing warning.

## Docs (run-count rules)
Group tier → verify sweep → one full run per workspace → failed-only on red →
fix-scoped after fixes. Never a second full run unless a fix touches harness,
setup, config, package.json or lockfiles.
