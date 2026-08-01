#!/usr/bin/env node
/**
 * Remove Forge sessions older than RETENTION_DAYS (default 14).
 * Skips the active session unless --include-active is passed.
 *
 * Usage:
 *   forge cleanup
 *   forge cleanup-sessions [--dry-run] [--include-active]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  clearActive,
  loadSession,
  readActive,
  RETENTION_DAYS,
  SESSIONS_DIR,
  sessionAgeDays,
} from './lib.mjs';
import { isTerminalPhase, unregisterSession } from './lib/fleet.mjs';
import { resolveProjectPlanEngine } from './plan-engine.mjs';
import { appendScorecardLedger } from './score.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeActive = args.has('--include-active');
/**
 * Age alone never deletes work in progress; this is how you say you mean it —
 * and it must name the session, because a project-wide sweep of unfinished work
 * is protected only by `active.json`, which is the pointer this whole change
 * exists because you cannot trust. Reproduced: a bare
 * `--include-unfinished` deleted a twenty-day live session and kept a
 * ninety-day abandoned one, purely because the pointer named the abandoned one.
 */
const includeUnfinished = args.has('--include-unfinished');
/**
 * `--session <id>` scopes the whole run to one session — in every other Forge
 * command that flag selects what to act *on*, and it meant nothing here, so
 * `forge cleanup --session A` happily deleted an unrelated finished session the
 * operator never named. It also gates `--include-unfinished`.
 */
const argv = process.argv.slice(2);
const onlySession = argv.includes('--session') ? (argv[argv.indexOf('--session') + 1] ?? null) : null;
if (argv.includes('--session') && !onlySession) {
  // `--session` with nothing after it crashed with an uncaught
  // ERR_INVALID_ARG_TYPE out of path.join — introduced by the validation below.
  process.stderr.write('--session needs a session id.\n');
  process.exit(1);
}
if (onlySession !== null && !fs.existsSync(path.join(SESSIONS_DIR, onlySession, 'session.json'))) {
  // A typo used to be a silent no-op: exit 0, nothing removed, no message.
  process.stderr.write(`No such session: ${onlySession}\n`);
  process.exit(1);
}
if (includeUnfinished && !onlySession) {
  process.stderr.write(
    'Refusing to sweep unfinished sessions across the whole project.\n' +
      '--include-unfinished deletes work, and the only thing that would stand between it\n' +
      'and the wrong session is .forge/active.json — the pointer this cannot trust.\n\n' +
      'Name the one you mean: forge cleanup --include-unfinished --session <id>\n',
  );
  process.exit(1);
}

// Read to know which session must NOT be deleted, not to pick one to act on —
// so this stays on the pointer deliberately. It is a floor, not a resolution:
// protecting one session too many is harmless, protecting one too few is data
// loss.
const active = readActive();
const activeId = active?.sessionId ?? null;
const removed = [];
const kept = [];

if (!fs.existsSync(SESSIONS_DIR)) {
  process.stdout.write(JSON.stringify({ removed, kept, dryRun }, null, 2));
  process.stdout.write('\n');
  process.exit(0);
}

for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const sessionId = entry.name;
  const dir = path.join(SESSIONS_DIR, sessionId);
  const sessionFile = path.join(dir, 'session.json');
  if (!fs.existsSync(sessionFile)) continue;

  let session;
  try {
    ({ session } = loadSession(sessionId));
  } catch {
    continue;
  }

  const isActive = sessionId === activeId;
  const tooOld = sessionAgeDays(session) > RETENTION_DAYS;
  const isDone = isTerminalPhase(session.phase);

  // AGE ALONE MUST NOT DELETE WORK IN PROGRESS. `(tooOld || isDone)` deleted a
  // twenty-day session sitting at `implement` — with its verify evidence and
  // its final review inside — while keeping the *finished* session the pointer
  // named. `finish.md` runs `forge cleanup` on the line after
  // `forge phase done`, and the pointer never moves onto a finished session, so
  // the one thing between a long-running change and deletion was whether it
  // happened to be named in `active.json`.
  //
  // The line is not finished-versus-unfinished — retention exists precisely to
  // clear *abandoned* sessions, and those are unfinished by definition. It is
  // whether the directory holds anything but its own `session.json`: evidence,
  // reviews, task output, a scorecard. An empty shell is scratch and ages out
  // as before; a directory with work in it is somebody's week, and needs
  // `--include-unfinished` to be said out loud.
  // WORK MEANS SOMETHING SOMEBODY PRODUCED, not the scaffolding `forge new`
  // lays down. The first version asked whether the directory held anything
  // besides `session.json` — but every new session ships `status.json` and
  // empty `brainstorm/`, `reviews/` and `tasks/` directories, so `hasWork` was
  // true from birth and retention could never clear an abandoned session at
  // all. That re-created the failure it was written to prevent, one level over:
  // an abandoned session keeps the project ambiguous, and the gate then refuses
  // forever.
  //
  // So: any *file* anywhere under the session dir that is not one of Forge's
  // own bookkeeping records. Empty scaffold directories contain none.
  const SCAFFOLD = new Set(['session.json', 'status.json']);
  // `forge new` plants a fleet note in every *other* open session, so an
  // `inbox/` is something another session did to this one — not work anybody
  // did in it. Counting it made an abandoned session permanently unclearable,
  // which is the "gate refuses forever" failure restored through a side door.
  const SCAFFOLD_DIRS = new Set(['inbox']);
  const holdsWork = (root) => {
    /** @type {string[]} */
    const stack = [root];
    while (stack.length) {
      const at = stack.pop();
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try {
        entries = fs.readdirSync(at, { withFileTypes: true });
      } catch {
        return true; // cannot tell what is inside — do not delete it
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!(at === root && SCAFFOLD_DIRS.has(e.name))) stack.push(path.join(at, e.name));
        }
        else if (!(at === root && SCAFFOLD.has(e.name))) return true;
      }
    }
    return false;
  };
  // Plan-phase work lives under <plan.dir>/changes/<name>/, not the session
  // dir. A live change dir (not under changes/archive/) is held work even
  // when the session only has Forge scaffold files (F48).
  const hasLiveChangeDir = (change) => {
    if (typeof change !== 'string' || !change || change.includes('/') || change.includes('\\')) {
      return false;
    }
    const planDir = resolveProjectPlanEngine(process.cwd(), { useUserDefault: false }).dir;
    const live = path.join(process.cwd(), planDir, 'changes', change);
    try {
      return fs.statSync(live).isDirectory();
    } catch {
      return false;
    }
  };
  const hasWork = !isDone && (holdsWork(dir) || hasLiveChangeDir(session.openspecChange));
  // Named explicitly, `--include-unfinished` means it: the operator typed this
  // session's id after a flag that says it deletes work. Before, the pointer's
  // own protection still applied — so the printed remedy silently no-opped on
  // exactly the session it exists for, exit 0 and an empty `removed` list.
  const namedForRemoval = includeUnfinished && sessionId === onlySession;
  const unfinishedAndProtected = hasWork && !namedForRemoval;
  const shouldRemove =
    (onlySession === null || sessionId === onlySession) &&
    (tooOld || isDone) &&
    !unfinishedAndProtected &&
    (!isActive || includeActive || namedForRemoval);

  if (shouldRemove) {
    if (!dryRun) {
      // Harvest the scorecard into the durable ledger before the session dir
      // (and its scoring history) is erased. Covers sessions scored before
      // the ledger existed; a no-op when the ledger already has the line.
      try {
        const cardFile = path.join(dir, 'scorecard.json');
        if (fs.existsSync(cardFile)) {
          appendScorecardLedger(dir, JSON.parse(fs.readFileSync(cardFile, 'utf8')), session);
        }
      } catch {
        /* ledger is advisory — never block cleanup */
      }
      fs.rmSync(dir, { recursive: true, force: true });
      if (isActive) clearActive();
      unregisterSession(process.cwd(), sessionId);
    }
    removed.push({ sessionId, reason: tooOld ? 'retention' : 'finished' });
  } else {
    kept.push({ sessionId, phase: session.phase, ageDays: sessionAgeDays(session).toFixed(1) });
  }
}

// A NAMED SESSION THAT SURVIVES MUST SAY WHY. `--session <id>` is a request
// about one session, so answering it with an empty `removed` list and exit 0 is
// the same silence the typo check above was written to end — and it fires on
// the ordinary cases: a session younger than the retention window, which is the
// remedy this tool itself prints, or one whose `session.json` could not be read.
if (onlySession && !removed.some((r) => r.sessionId === onlySession)) {
  const why = kept.find((k) => k.sessionId === onlySession);
  process.stderr.write(
    why
      ? `Kept ${onlySession}: phase ${why.phase ?? 'unknown'}, ${why.ageDays} days old — ` +
          `retention is ${RETENTION_DAYS} days. Nothing removes a session before its ` +
          `retention window, whatever flags you pass.\n`
      : `Kept ${onlySession}: it was not considered at all — its directory has no readable ` +
          `session.json.\n`,
  );
}
process.stdout.write(JSON.stringify({ removed, kept, dryRun, retentionDays: RETENTION_DAYS }, null, 2));
process.stdout.write('\n');
