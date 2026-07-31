#!/usr/bin/env node
/**
 * Create a new Forge session under .forge/sessions/ and set it active.
 *
 * Usage:
 *   forge new mercury-console-validation
 *   forge new <slug> [--chat-id <id>] [--signal <text>]
 */

import { spawnSync } from 'node:child_process';
import {
  appendPhaseHistory,
  defaultSession,
  defaultStatus,
  ensureForgeLayout,
  FORGE_DIR,
  makeSessionId,
  REPO_ROOT,
  saveSession,
  scaffoldSessionDirs,
  sessionPath,
  writeActive,
} from './lib.mjs';
import { bindHost } from './metrics/host.mjs';
import { resolveSessionPaceFields } from './preferences.mjs';
import { warnIfDoctorFails } from './doctor.mjs';
import { liveOverlaps, queueMessage, sessionDirFor } from './lib/fleet.mjs';
import { matchingOpenBugs } from './findings.mjs';

function usage() {
  process.stderr.write(
    'Usage: forge new <slug> [--chat-id <id>] [--signal <text>]\n',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') usage();

const slug = args[0];
let cursorChatId = null;
let signalText = null;
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === '--chat-id' && args[i + 1]) {
    cursorChatId = args[i + 1];
    i += 1;
  } else if (args[i] === '--signal' && args[i + 1]) {
    signalText = args[i + 1];
    i += 1;
  }
}

ensureForgeLayout();
warnIfDoctorFails({ cwd: process.cwd() });

const sessionId = makeSessionId(slug);
const dir = sessionPath(sessionId);
scaffoldSessionDirs(dir);

const session = defaultSession(sessionId, slug);
// Start the timeline where the session starts — `createdAt`, not "now" — so
// no work falls into a gap before the first `forge phase` transition.
appendPhaseHistory(session, session.phase, session.createdAt);
if (cursorChatId) session.cursorChatId = cursorChatId;

// Where this session started, so reviewers have a diff range even when the
// project never enables checkpoints (and `forge checkpoint --range` has a
// base from commit one).
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
if (head.status === 0) {
  session.baseCommit = head.stdout.trim();
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (branch.status === 0) session.branch = branch.stdout.trim();
}

const paceFields = resolveSessionPaceFields({
  forgeDir: FORGE_DIR,
  slug: session.slug,
  signalText: signalText || session.slug,
});
Object.assign(session, paceFields);

// Record which host session is creating this one, so telemetry can find its
// transcripts later. Silent on failure: sessions are routinely created outside
// a host (Cursor, Codex, a plain shell), and creation must never depend on it.
try {
  bindHost(session, process.env);
} catch {
  // advisory — a missing binding must never break session creation
}

saveSession(dir, session);
writeActive(sessionId);

// Fleet coordination: another live session in this working tree risks
// conflicting edits — surface it here and notify the other sessions' inboxes.
const overlaps = liveOverlaps(process.cwd(), sessionId);
for (const o of overlaps) {
  queueMessage(
    sessionDirFor(o),
    `Fleet overlap: session "${session.slug}" (${sessionId}) just started in this project. Coordinate with the user to avoid conflicting edits.`,
  );
}

const out = {
  sessionId,
  dir,
  session: defaultStatus(session),
  pace: {
    requested: session.pace,
    resolved: session.resolvedPace,
    reason: session.paceReason,
  },
};
if (overlaps.length > 0) {
  out.overlaps = overlaps.map((o) => ({
    sessionId: o.sessionId,
    slug: o.slug,
    phase: o.phase,
    engine: o.engine,
    lastSeen: o.lastSeen ?? o.updatedAt,
  }));
  out.overlapAdvice =
    'Other live sessions are working in this project. Tell the user and ask: continue anyway, use a git worktree, or pause one session.';
}

const relatedFindings = matchingOpenBugs(FORGE_DIR, slug);
if (relatedFindings.length > 0) {
  out.relatedFindings = relatedFindings;
  process.stderr.write(
    `[forge] ${relatedFindings.length} open bug(s) look related to "${slug}": ${relatedFindings
      .map((f) => f.id)
      .join(', ')} — advisory only.\n`,
  );
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
