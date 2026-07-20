#!/usr/bin/env node
/**
 * Operator-brief CLI (core in brief.mjs).
 *
 * Usage:
 *   forge brief stamp [--session <id>] [--no-open]   stamp freshness hash + open in browser
 *   forge brief check [--session <id>]               exit 1 when missing/stale/unstamped
 *   forge brief open  [--session <id>]               open in default browser
 */

import fs from 'node:fs';
import { loadSession, readActive } from './lib.mjs';
import { resolveChangeDir } from './integrity.mjs';
import { BRIEF_FILE, briefPath, checkBrief, openInBrowser, stampBrief } from './brief.mjs';

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !['stamp', 'check', 'open'].includes(cmd)) {
  process.stderr.write(
    'Usage: forge brief stamp [--session <id>] [--no-open] | check [--session <id>] | open [--session <id>]\n',
  );
  process.exit(1);
}

let sessionId = null;
const si = rest.indexOf('--session');
if (si >= 0 && rest[si + 1]) sessionId = rest[si + 1];
if (!sessionId) sessionId = readActive()?.sessionId ?? null;
if (!sessionId) {
  process.stderr.write('No active session. Run forge new first.\n');
  process.exit(1);
}

const { session } = loadSession(sessionId);
const changeDir = resolveChangeDir({ session });

if (cmd === 'check') {
  const result = checkBrief({ session });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (!changeDir) {
  process.stderr.write('Session has no tracked change — nothing to brief.\n');
  process.exit(1);
}

if (cmd === 'stamp') {
  const hash = stampBrief(changeDir);
  process.stdout.write(`Stamped ${briefPath(changeDir)} (specs hash ${hash})\n`);
  if (!rest.includes('--no-open')) {
    openInBrowser(briefPath(changeDir));
    process.stdout.write('Opened in default browser.\n');
  }
} else {
  const file = briefPath(changeDir);
  if (!fs.existsSync(file)) {
    process.stderr.write(`No ${BRIEF_FILE} in ${changeDir}.\n`);
    process.exit(1);
  }
  openInBrowser(file);
  process.stdout.write(`Opened ${file}\n`);
}
