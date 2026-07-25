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
  readActive,
  REPO_ROOT,
} from './lib.mjs';
import { resolveEffectivePreferences } from './preferences.mjs';
import { sessionHealth } from './health.mjs';
import { openFindings } from './findings.mjs';

const args = process.argv.slice(2);
let sessionId = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  }
}

if (!sessionId) {
  const active = readActive();
  if (!active?.sessionId) {
    process.stdout.write(JSON.stringify({ status: 'none', message: 'No active Forge session.' }, null, 2));
    process.stdout.write('\n');
    process.exit(0);
  }
  sessionId = active.sessionId;
}

const { dir, session } = loadSession(sessionId);
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
