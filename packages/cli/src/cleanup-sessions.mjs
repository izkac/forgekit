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
import { unregisterSession } from './lib/fleet.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeActive = args.has('--include-active');

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
  const isDone = session.phase === 'done' || session.phase === 'skipped';

  const shouldRemove =
    (tooOld || isDone) && (!isActive || includeActive);

  if (shouldRemove) {
    if (!dryRun) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (isActive) clearActive();
      unregisterSession(process.cwd(), sessionId);
    }
    removed.push({ sessionId, reason: tooOld ? 'retention' : 'finished' });
  } else {
    kept.push({ sessionId, phase: session.phase, ageDays: sessionAgeDays(session).toFixed(1) });
  }
}

process.stdout.write(JSON.stringify({ removed, kept, dryRun, retentionDays: RETENTION_DAYS }, null, 2));
process.stdout.write('\n');
