#!/usr/bin/env node
/**
 * Print the active Forge session or a specific session by id.
 *
 * Usage:
 *   forge status
 *   forge status [--session <id>]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  FORGE_DIR,
  loadSession,
  resolveSessionId,
  REPO_ROOT,
} from './lib.mjs';
import { resolveEffectivePreferences } from './preferences.mjs';
import { sessionHealth } from './health.mjs';
import { openFindings } from './findings.mjs';
import { healSessionProgress } from './plan-progress.mjs';

const args = process.argv.slice(2);
let sessionId = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  }
}

// Resolved the same way `forge phase` resolves it. This is what an operator
// reads to find out which session they are on, so agreeing with a pointer the
// gate would refuse is the failure — before this, `status` and `phase done`
// could name different sessions and nothing on screen said so.
const resolvedSession = resolveSessionId(sessionId);
/** Reported alongside the answer, never instead of it. */
const ambiguity = resolvedSession.ambiguous
  ? {
      ambiguous: true,
      reason: `${resolvedSession.candidates?.length ?? 0} sessions are unfinished; this is the one .forge/active.json names`,
      candidates: (resolvedSession.candidates ?? []).map((c) => ({
        sessionId: c.id,
        slug: c.slug ?? null,
        phase: c.phase ?? null,
        unreadable: c.unreadable === true,
      })),
      note: 'forge phase done|finish will refuse until you pass --session',
    }
  : null;
if (!resolvedSession.id) {
  process.stdout.write(
    JSON.stringify(
      resolvedSession.problem
        ? { status: 'ambiguous', message: resolvedSession.problem, ...(ambiguity ?? {}) }
        : { status: 'none', message: 'No active Forge session.' },
      null,
      2,
    ),
  );
  process.stdout.write('\n');
  process.exit(0);
}
sessionId = resolvedSession.id;

const { dir, session } = loadSession(sessionId);
healSessionProgress({ cwd: REPO_ROOT, sessionDir: dir, session });
const statusPath = path.join(dir, 'status.json');
const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;

const pace = resolveEffectivePreferences({
  forgeDir: FORGE_DIR,
  session,
  signalText: session.paceSignal || session.slug || '',
});

const health = sessionHealth({ cwd: REPO_ROOT, sessionDir: dir, session });

// Open findings are project-level, not session-level: they outlive the session
// that raised them, which is the entire point of the ledger.
const findings = openFindings(FORGE_DIR);

process.stdout.write(
  JSON.stringify(
    {
      status: 'ok',
      sessionId,
      // Reported alongside the answer, never instead of it: the operator gets a
      // session *and* is told it was a pointer's guess between several.
      ...(ambiguity ? { sessionAmbiguity: ambiguity } : {}),
      sessionPath: path.relative(REPO_ROOT, dir).replace(/\\/g, '/'),
      // Verdict first: a status dump that never says "this session is red and
      // nobody has touched it since yesterday" makes the operator derive it.
      health,
      openFindings: {
        count: findings.length,
        latest: findings.slice(-5).map((f) => ({ id: f.id, severity: f.severity, text: f.text, change: f.change })),
      },
      session,
      progress: status,
      pace: {
        requested: pace.requestedPace,
        resolved: pace.resolvedPace,
        reason: pace.paceReason,
        source: pace.source,
        effective: pace.effective,
      },
      integrity: pace.integrity,
    },
    null,
    2,
  ),
);
process.stdout.write('\n');
