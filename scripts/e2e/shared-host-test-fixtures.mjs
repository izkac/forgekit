#!/usr/bin/env node
/**
 * Product loop for shared-host-test-fixtures (F55) — import the shared host-tree
 * fixture module, plant once, assert the export surface.
 *
 * Status line (exact): `HOST-FIXTURE shared=1`
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HOST_ID,
  assistantLine,
  plantHost,
} from '../../packages/cli/src/metrics/test-host-tree.mjs';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const configDir = plantHost({
  sessionId: DEFAULT_HOST_ID,
  lines: [assistantLine({ requestId: 'req_1', at: '2026-07-28T10:00:00.000Z' })],
});

const transcript = path.join(
  configDir,
  'projects',
  '-home-iztok-Projects-forgekit',
  `${DEFAULT_HOST_ID}.jsonl`,
);
if (!fs.existsSync(transcript)) {
  fail(`expected planted transcript at ${transcript}`);
}

process.stdout.write('HOST-FIXTURE shared=1\n');
