#!/usr/bin/env node
/**
 * Create a new Forge session under .forge/sessions/ and set it active.
 *
 * Usage:
 *   forge new mercury-console-validation
 *   forge new <slug> [--chat-id <id>] [--signal <text>]
 */

import {
  defaultSession,
  defaultStatus,
  ensureForgeLayout,
  FORGE_DIR,
  makeSessionId,
  saveSession,
  scaffoldSessionDirs,
  sessionPath,
  writeActive,
} from './lib.mjs';
import { resolveSessionPaceFields } from './preferences.mjs';
import { warnIfDoctorFails } from './doctor.mjs';

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
if (cursorChatId) session.cursorChatId = cursorChatId;

const paceFields = resolveSessionPaceFields({
  forgeDir: FORGE_DIR,
  slug: session.slug,
  signalText: signalText || session.slug,
});
Object.assign(session, paceFields);

saveSession(dir, session);
writeActive(sessionId);

process.stdout.write(
  `${JSON.stringify(
    {
      sessionId,
      dir,
      session: defaultStatus(session),
      pace: {
        requested: session.pace,
        resolved: session.resolvedPace,
        reason: session.paceReason,
      },
    },
    null,
    2,
  )}\n`,
);
