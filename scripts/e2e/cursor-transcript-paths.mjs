#!/usr/bin/env node
/**
 * Product loop for cursor-transcript-paths (F71) — locate Cursor
 * agent-transcripts and degrade honestly when the format lacks token usage.
 *
 * Status line (exact): `CURSOR-TRANSCRIPT found=1 prune-wording=0`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectMetrics } from '../../packages/cli/src/metrics/collect.mjs';
import { findTranscripts } from '../../packages/cli/src/metrics/host.mjs';

const HOST_ID = 'f8447a2f-eb56-41b8-8cc1-16606b862780';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function plantCursor({
  sessionId = HOST_ID,
  slug = 'home-iztok-Projects-forgekit',
  cursorProjectsDir = tmp('forgekit-e2e-cursor-transcript-'),
} = {}) {
  const dir = path.join(cursorProjectsDir, slug, 'agent-transcripts', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ].join('\n') + '\n',
    'utf8',
  );
  return { cursorProjectsDir, transcript };
}

const configDir = tmp('forgekit-e2e-cursor-claude-');
fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
const { cursorProjectsDir, transcript } = plantCursor();

const located = findTranscripts([HOST_ID], { configDir, cursorProjectsDir });
const found = located.found.length === 1 && located.found[0].transcript === transcript ? 1 : 0;
if (found !== 1) {
  fail(
    `expected findTranscripts to locate Cursor transcript at ${transcript}, got ${JSON.stringify(located)}`,
  );
}

const doc = collectMetrics({
  session: {
    id: '20260727T100000Z-demo-abc123',
    createdAt: '2026-07-27T10:00:00.000Z',
    host: { agent: 'cursor', sessionIds: [HOST_ID], boundAt: '2026-07-27T10:00:00.000Z' },
    phaseHistory: [],
  },
  now: () => new Date('2026-07-27T11:00:00.000Z'),
  configDir,
  cursorProjectsDir,
});

if (doc.available !== false) {
  fail(`expected available=false, got ${JSON.stringify(doc)}`);
}
if (!doc.reason || !doc.reason.includes(transcript)) {
  fail(`expected reason to name ${transcript}, got: ${doc.reason}`);
}
if (!/token usage|lacks .*usage|host format/i.test(doc.reason)) {
  fail(`expected reason to mention missing token usage, got: ${doc.reason}`);
}

const pruneWording = /pruned or written elsewhere/i.test(doc.reason) ? 1 : 0;
if (pruneWording !== 0) {
  fail(`expected no prune wording, got: ${doc.reason}`);
}

process.stdout.write(`CURSOR-TRANSCRIPT found=${found} prune-wording=${pruneWording}\n`);
