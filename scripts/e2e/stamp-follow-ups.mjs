#!/usr/bin/env node
/**
 * Product loop for stamp-follow-ups — exercise atomic writeStamp, sessionIds
 * dedupe, and named readdir-blocked reasons against production modules.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStamp } from '../../packages/cli/src/review-stamp.mjs';
import { reviewEvidence } from '../../packages/cli/src/metrics/review-evidence.mjs';

const DEMO_ID = '20260728T100000Z-demo-abc123';
const HOST_ID = 'f8447a2f-eb56-41b8-8cc1-16606b862780';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
  };
}

function assistantLine({ requestId, at, model = 'claude-opus-5', tokens = {} } = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: at,
    isSidechain: true,
    message: { id: `msg_${requestId}`, model, content: [{ type: 'text' }], usage: usage(tokens) },
  };
}

function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

function meta({ description, stoppedByUser } = {}) {
  const out = {
    agentType: 'general-purpose',
    description,
    toolUseId: 'toolu_017uFdNuuRF9FFhJk8oz15Gr',
    spawnDepth: 1,
    model: 'opus',
  };
  if (stoppedByUser !== undefined) out.stoppedByUser = stoppedByUser;
  return out;
}

function plantSidecars(agents, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [agentId, { meta: agentMeta, lines }] of Object.entries(agents)) {
    if (agentMeta !== undefined) {
      fs.writeFileSync(
        path.join(dir, `agent-${agentId}.meta.json`),
        typeof agentMeta === 'string' ? agentMeta : JSON.stringify(agentMeta),
      );
    }
    if (lines !== undefined) {
      fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), jsonl(lines));
    }
  }
  return dir;
}

function plantHost({
  sessionId = HOST_ID,
  lines = null,
  subagents = null,
  configDir = tmp('forgekit-e2e-stamp-follow-ups-host-'),
} = {}) {
  const project = path.join(configDir, 'projects', '-home-iztok-Projects-forgekit');
  fs.mkdirSync(project, { recursive: true });
  if (lines !== null) fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), jsonl(lines));
  if (subagents !== null) plantSidecars(subagents, path.join(project, sessionId, 'subagents'));
  return configDir;
}

function boundSession({ createdAt = '2026-07-28T10:00:00.000Z', sessionIds = [HOST_ID] } = {}) {
  return {
    id: DEMO_ID,
    createdAt,
    host: { agent: 'claude-code', sessionIds, boundAt: createdAt },
  };
}

const PARENT = [assistantLine({ requestId: 'parent_1', at: '2026-07-28T10:00:00.000Z' })];

// --- 1. atomic: writeStamp twice; live file valid with 2 stamps; orphan .tmp ok ---
const sessionDir = tmp('forgekit-e2e-stamp-follow-ups-atomic-');
const first = writeStamp(sessionDir, {
  unit: 'group-01',
  label: 'forge-review group-01 e2e',
  sessionId: 'e2e-s1',
});
if (!first.ok) fail(`first writeStamp failed: ${first.reason}`);

const reviewsDir = path.join(sessionDir, 'reviews');
const liveFile = path.join(reviewsDir, 'dispatches.json');
const temporaryFile = `${liveFile}.tmp`;
fs.writeFileSync(temporaryFile, '{ "version": 1, "stamps": [');

const second = writeStamp(sessionDir, {
  unit: 'final',
  label: 'forge-review final e2e',
  sessionId: 'e2e-s1',
});
if (!second.ok) fail(`second writeStamp failed: ${second.reason}`);

let liveDoc;
try {
  liveDoc = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
} catch (error) {
  fail(`live dispatches.json is not valid JSON: ${error.message}`);
}
if (!Array.isArray(liveDoc.stamps) || liveDoc.stamps.length !== 2) {
  fail(`expected 2 live stamps, got ${JSON.stringify(liveDoc)}`);
}
if (liveDoc.stamps[0].unit !== 'group-01' || liveDoc.stamps[1].unit !== 'final') {
  fail(`stamp units wrong: ${JSON.stringify(liveDoc.stamps.map((s) => s.unit))}`);
}
const atomic = 'ok';

// --- 2. dedupe: duplicate sessionIds → one planted dispatch counted once ---
const plantedDispatches = 1;
const configDir = plantHost({
  lines: PARENT,
  subagents: {
    a1: {
      meta: meta({ description: `forge-review final ${DEMO_ID}` }),
      lines: [assistantLine({ requestId: 'rev_1', at: '2026-07-28T10:30:00.000Z' })],
    },
  },
});

const dedupeResult = reviewEvidence({
  session: boundSession({ sessionIds: [HOST_ID, HOST_ID] }),
  now: () => new Date('2026-07-28T12:00:00.000Z'),
  configDir,
});
if (dedupeResult.available !== true) fail(`dedupe unavailable: ${dedupeResult.reason}`);
if (dedupeResult.units.final?.dispatched !== plantedDispatches) {
  fail(
    `dedupe expected dispatched=${plantedDispatches}, got ${JSON.stringify(dedupeResult.units.final)}`,
  );
}
const dedupe = 'ok';

// --- 3. named: chmod subagents → reason names host id and sidecar path ---
const namedDir = path.join(
  configDir,
  'projects',
  '-home-iztok-Projects-forgekit',
  HOST_ID,
  'subagents',
);
fs.chmodSync(namedDir, 0o000);
let named = 'fail';
try {
  assert.throws(() => fs.readdirSync(namedDir), /EACCES/);
  const namedResult = reviewEvidence({
    session: boundSession(),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });
  if (namedResult.available !== false) fail(`named expected unavailable, got ${JSON.stringify(namedResult)}`);
  if (!new RegExp(HOST_ID).test(namedResult.reason)) {
    fail(`named reason missing host id: ${namedResult.reason}`);
  }
  const escaped = namedDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(escaped).test(namedResult.reason)) {
    fail(`named reason missing sidecar path: ${namedResult.reason}`);
  }
  named = 'ok';
} finally {
  fs.chmodSync(namedDir, 0o755);
}

process.stdout.write(`FOLLOW-UPS atomic=${atomic} dedupe=${dedupe} named=${named}\n`);

fs.rmSync(sessionDir, { recursive: true, force: true });
fs.rmSync(configDir, { recursive: true, force: true });
