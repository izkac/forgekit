#!/usr/bin/env node
/**
 * Product loop for analyze-coverage-honesty (F70) — three digest kinds must
 * land in distinct coverage buckets, and the status line names all three.
 *
 * Status line (exact): `COVERAGE measured=1 predates=1 failed=1`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAnalysis, formatAnalysis } from '../../packages/cli/src/analyze.mjs';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Ledger-only project: digests in sessions.jsonl, no live metrics.json. */
function plantProject(digests) {
  const cwd = tmp('forgekit-e2e-coverage-honesty-');
  const forge = path.join(cwd, '.forge');
  fs.mkdirSync(forge, { recursive: true });
  fs.writeFileSync(
    path.join(forge, 'sessions.jsonl'),
    digests.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
  return cwd;
}

function digest(sessionId, over = {}) {
  const metrics = over.metrics ?? null;
  return {
    sessionId,
    slug: sessionId,
    change: sessionId,
    phase: 'done',
    planType: 'specs',
    pace: 'standard',
    tasks: '5/5',
    subagentsDispatched: metrics?.subagents ?? null,
    dispatchesSkipped: null,
    metrics: metrics ?? { available: false },
    reviews: { total: 1, independent: 1, selfChecks: 0, rejections: 0, final: 'independent' },
    checkpoints: 1,
    health: 'done',
    healthReasons: [],
    score: 90,
    grade: 'A',
    incompleteReason: null,
    durationHours: 1,
    startedAt: '2026-07-20T09:00:00.000Z',
    endedAt: '2026-07-20T10:00:00.000Z',
    ...over,
  };
}

function compact(over = {}) {
  return {
    available: true,
    requests: 10,
    outputTokens: 100,
    totalTokens: 1000,
    models: ['claude-opus-5'],
    errorRate: 0,
    subagents: 1,
    ...over,
  };
}

const cwd = plantProject([
  digest('measured', {
    metrics: compact(),
    endedAt: '2026-07-21T10:00:00.000Z',
  }),
  digest('predates', {
    metrics: undefined,
    endedAt: '2026-07-22T10:00:00.000Z',
  }),
  digest('failed', {
    metrics: { available: false, reason: 'no transcript on disk' },
    endedAt: '2026-07-23T10:00:00.000Z',
  }),
]);

try {
  const analysis = buildAnalysis({ cwd });
  const c = analysis.coverage;
  if (
    c.sessionsTotal !== 3 ||
    c.measured !== 1 ||
    c.predatesTelemetry !== 1 ||
    c.collectionFailed !== 1 ||
    c.sessionsWithMetrics !== 1 ||
    c.ratio !== 1 / 3
  ) {
    fail(`buckets mismatch: ${JSON.stringify(c)}`);
  }
  if (c.measured + c.predatesTelemetry + c.collectionFailed !== c.sessionsTotal) {
    fail(`buckets do not sum to sessionsTotal: ${JSON.stringify(c)}`);
  }

  const lead = formatAnalysis(analysis).split('\n').find((l) => l.trim());
  if (
    !/Coverage:\s*1 measured,\s*1 predates telemetry,\s*1 collection failed \(of 3; measured 33\.3%\)/.test(
      lead,
    )
  ) {
    fail(`lead line mismatch: ${JSON.stringify(lead)}`);
  }

  process.stdout.write(`COVERAGE measured=${c.measured} predates=${c.predatesTelemetry} failed=${c.collectionFailed}\n`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
