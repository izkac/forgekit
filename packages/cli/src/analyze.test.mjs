import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildAnalysis, formatAnalysis } from './analyze.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** `byModel` / `byPhase` are prototype-less; deepEqual compares prototypes. */
function plain(table) {
  const out = {};
  for (const [key, value] of Object.entries(table)) out[key] = { ...value };
  return out;
}

/**
 * A project with ledgers and, optionally, surviving session directories.
 *
 * @param {{ digests?: Record<string, any>[], cards?: Record<string, any>[],
 *   docs?: Record<string, Record<string, any>> }} [opts]
 * @returns {string} cwd
 */
function project(opts = {}) {
  const cwd = tmp('forge-analyze-');
  const forge = path.join(cwd, '.forge');
  fs.mkdirSync(forge, { recursive: true });
  const write = (name, rows) => {
    if (!rows) return;
    fs.writeFileSync(
      path.join(forge, name),
      rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
      'utf8',
    );
  };
  write('sessions.jsonl', opts.digests);
  write('scorecards.jsonl', opts.cards);
  for (const [sessionId, doc] of Object.entries(opts.docs ?? {})) {
    const dir = path.join(forge, 'sessions', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metrics.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }
  return cwd;
}

/** A digest line as `appendSessionDigest` writes one. */
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

/** The compact `metrics` block a digest carries. */
function compact(over = {}) {
  return {
    available: true,
    requests: 100,
    outputTokens: 5000,
    totalTokens: 900000,
    models: ['claude-opus-5'],
    errorRate: 0.02,
    subagents: 2,
    ...over,
  };
}

/** A full on-disk metrics.json, the only source of per-model detail. */
function doc(over = {}) {
  return {
    available: true,
    collectedAt: '2026-07-20T10:00:00.000Z',
    source: { agent: 'claude-code', hostVersion: '2.1.220', transcripts: [], sidecars: 2 },
    window: { from: '2026-07-20T09:00:00.000Z', to: '2026-07-20T10:00:00.000Z' },
    requests: 100,
    tokens: { input: 100, output: 5000, cacheRead: 890000, cacheCreate: 4900 },
    byModel: {
      'claude-opus-5': { requests: 90, input: 90, output: 4500, cacheRead: 800000, cacheCreate: 4000 },
      'claude-fable-5': { requests: 10, input: 10, output: 500, cacheRead: 90000, cacheCreate: 900 },
    },
    byPhase: {
      implement: { requests: 80, input: 80, output: 4000, cacheRead: 700000, cacheCreate: 4000 },
      verify: { requests: 20, input: 20, output: 1000, cacheRead: 190000, cacheCreate: 900 },
    },
    tools: { Bash: { calls: 40, errors: 1 } },
    errors: { toolResults: 50, errorResults: 1, rate: 0.02 },
    dispatches: { total: 5, allowed: 3, rewritten: 1, denied: 1, skipped: 2 },
    subagents: [{ agentId: 'a1' }, { agentId: 'a2' }],
    breakdown: { parent: { requests: 40 }, subagents: { requests: 60 } },
    ...over,
  };
}

/** Empty / zero coverage shape after the honesty buckets landed. */
function emptyCoverage() {
  return {
    sessionsTotal: 0,
    measured: 0,
    predatesTelemetry: 0,
    collectionFailed: 0,
    sessionsWithMetrics: 0,
    ratio: 0,
  };
}

test('a fresh project analyses to an explicit nothing, not an error', () => {
  const analysis = buildAnalysis({ cwd: project() });

  assert.deepEqual(analysis.coverage, emptyCoverage());
  assert.deepEqual(analysis.sessions, []);
  assert.deepEqual(plain(analysis.byModel), {});
  assert.deepEqual(plain(analysis.byPhase), {});
  assert.equal(analysis.totals.requests, 0);
  assert.equal(analysis.dispatches.total, 0);

  const text = formatAnalysis(analysis);
  assert.match(text, /nothing to analyse/i);
});

test('coverage buckets split measured, predates-telemetry, and collection-failed', () => {
  // Three kinds on digests alone — no live metrics.json required (F70).
  const digests = [
    digest('measured', {
      metrics: compact({ requests: 10, outputTokens: 100, totalTokens: 1000 }),
      endedAt: '2026-07-21T10:00:00.000Z',
    }),
    // No metrics object → predates telemetry (spread undefined then JSON omit).
    digest('predates', { metrics: undefined, endedAt: '2026-07-22T10:00:00.000Z' }),
    digest('failed', {
      metrics: { available: false, reason: 'no transcript on disk' },
      endedAt: '2026-07-23T10:00:00.000Z',
    }),
  ];
  const analysis = buildAnalysis({ cwd: project({ digests }) });

  assert.deepEqual(analysis.coverage, {
    sessionsTotal: 3,
    measured: 1,
    predatesTelemetry: 1,
    collectionFailed: 1,
    sessionsWithMetrics: 1,
    ratio: 1 / 3,
  });
  assert.equal(
    analysis.coverage.measured +
      analysis.coverage.predatesTelemetry +
      analysis.coverage.collectionFailed,
    analysis.coverage.sessionsTotal,
  );
  assert.equal(analysis.coverage.sessionsWithMetrics, analysis.coverage.measured);

  const lead = formatAnalysis(analysis).split('\n').find((l) => l.trim());
  assert.match(
    lead,
    /Coverage:\s*1 measured,\s*1 predates telemetry,\s*1 collection failed \(of 3; measured 33\.3%\)/,
  );
});

test('coverage counts every session but token math counts only the measured ones', () => {
  // Nine sessions: six measured, three predates-telemetry — never read as complete.
  const digests = [];
  for (let i = 0; i < 9; i += 1) {
    digests.push(
      digest(`s${i}`, {
        metrics: i < 6 ? compact({ requests: 10, outputTokens: 100, totalTokens: 1000 }) : undefined,
        endedAt: `2026-07-2${i}T10:00:00.000Z`,
      }),
    );
  }
  const analysis = buildAnalysis({ cwd: project({ digests }) });

  assert.deepEqual(analysis.coverage, {
    sessionsTotal: 9,
    measured: 6,
    predatesTelemetry: 3,
    collectionFailed: 0,
    sessionsWithMetrics: 6,
    ratio: 6 / 9,
  });
  assert.equal(analysis.totals.requests, 60, 'six measured sessions at ten requests each');
  assert.equal(analysis.totals.outputTokens, 600);
  assert.equal(analysis.sessions.length, 9, 'unmeasured sessions are listed, not hidden');
  assert.equal(analysis.sessions.filter((s) => s.hasMetrics).length, 6);
});

test('byModel omits the host synthetic model named in a digest', () => {
  const d = doc({
    byModel: {
      '<synthetic>': { requests: 5, input: 5, output: 250, cacheRead: 50000, cacheCreate: 500 },
      'claude-opus-5': { requests: 90, input: 90, output: 4500, cacheRead: 800000, cacheCreate: 4000 },
    },
  });
  const analysis = buildAnalysis({
    cwd: project({
      digests: [
        digest('s1', {
          metrics: compact({ models: ['<synthetic>', 'claude-opus-5'] }),
        }),
      ],
      docs: { s1: d },
    }),
  });

  assert.equal(Object.hasOwn(analysis.byModel, '<synthetic>'), false);
  const opus = analysis.byModel['claude-opus-5'];
  assert.equal(opus.sessions, 1);
  assert.equal(opus.requests, d.byModel['claude-opus-5'].requests);
  assert.equal(opus.output, d.byModel['claude-opus-5'].output);
});

test('per-model rows come from the surviving documents, and grades from every session', () => {
  const d = doc();
  const analysis = buildAnalysis({
    cwd: project({
      digests: [
        digest('s-live', { metrics: compact({ models: Object.keys(d.byModel) }), grade: 'A' }),
        // Its directory is gone: the digest still knows which models ran and
        // what grade the session got, but not how the tokens split.
        digest('s-pruned', { metrics: compact({ models: ['claude-opus-5'] }), grade: 'C' }),
      ],
      docs: { 's-live': d },
    }),
  });

  const opus = analysis.byModel['claude-opus-5'];
  assert.equal(opus.sessions, 2, 'both sessions ran it');
  assert.equal(opus.detailed, 1, 'only one still has the per-model split on disk');
  assert.equal(opus.requests, d.byModel['claude-opus-5'].requests);
  assert.equal(opus.output, d.byModel['claude-opus-5'].output);
  assert.deepEqual(opus.grades.slice().sort(), ['A', 'C']);
  assert.equal(opus.sessionErrorRate, d.errors.rate);

  const fable = analysis.byModel['claude-fable-5'];
  assert.equal(fable.sessions, 1);
  assert.deepEqual(fable.grades, ['A']);
  assert.equal(fable.requests, d.byModel['claude-fable-5'].requests);
});

test('phase attribution is summed across the sessions that still have it', () => {
  const a = doc();
  const b = doc({
    byPhase: { implement: { requests: 5, input: 5, output: 50, cacheRead: 500, cacheCreate: 5 } },
  });
  const analysis = buildAnalysis({
    cwd: project({
      digests: [digest('s-a', { metrics: compact() }), digest('s-b', { metrics: compact() })],
      docs: { 's-a': a, 's-b': b },
    }),
  });

  assert.equal(
    analysis.byPhase.implement.requests,
    a.byPhase.implement.requests + b.byPhase.implement.requests,
  );
  assert.equal(analysis.byPhase.implement.sessions, 2);
  assert.equal(analysis.byPhase.verify.requests, a.byPhase.verify.requests);
  assert.equal(analysis.byPhase.verify.sessions, 1);
});

test('digest byModel/byPhase fill per-model rows when metrics.json is gone', () => {
  // After cleanup only the compact splits remain — they must not read as zeros.
  const byModel = {
    'claude-opus-5': { requests: 40, input: 40, output: 2000, cacheRead: 300000, cacheCreate: 1500 },
    'claude-fable-5': { requests: 7, input: 7, output: 350, cacheRead: 40000, cacheCreate: 200 },
  };
  const byPhase = {
    implement: { requests: 30, input: 30, output: 1500, cacheRead: 250000, cacheCreate: 1200 },
    verify: { requests: 17, input: 17, output: 850, cacheRead: 90000, cacheCreate: 500 },
  };
  const analysis = buildAnalysis({
    cwd: project({
      digests: [
        digest('s-pruned', {
          metrics: compact({
            models: Object.keys(byModel).sort(),
            byModel,
            byPhase,
          }),
        }),
      ],
    }),
  });

  const opus = analysis.byModel['claude-opus-5'];
  assert.equal(opus.sessions, 1);
  assert.equal(opus.detailed, 1, 'digest splits count as a detailed contribution');
  assert.equal(opus.requests, byModel['claude-opus-5'].requests);
  assert.equal(opus.output, byModel['claude-opus-5'].output);
  assert.equal(opus.input, byModel['claude-opus-5'].input);
  assert.equal(opus.cacheRead, byModel['claude-opus-5'].cacheRead);
  assert.equal(opus.cacheCreate, byModel['claude-opus-5'].cacheCreate);

  const fable = analysis.byModel['claude-fable-5'];
  assert.equal(fable.requests, byModel['claude-fable-5'].requests);
  assert.equal(fable.output, byModel['claude-fable-5'].output);

  assert.equal(analysis.byPhase.implement.requests, byPhase.implement.requests);
  assert.equal(analysis.byPhase.implement.output, byPhase.implement.output);
  assert.equal(analysis.byPhase.verify.requests, byPhase.verify.requests);
  assert.equal(analysis.byPhase.verify.sessions, 1);
});

test('live metrics.json wins over digest byModel/byPhase splits', () => {
  // Discriminating fixture: digest cells differ from the live doc so a wrong
  // preference would still produce non-zero numbers — and fail these asserts.
  const live = doc({
    byModel: {
      'claude-opus-5': { requests: 90, input: 90, output: 4500, cacheRead: 800000, cacheCreate: 4000 },
    },
    byPhase: {
      implement: { requests: 80, input: 80, output: 4000, cacheRead: 700000, cacheCreate: 4000 },
    },
  });
  const digestSplit = {
    byModel: {
      'claude-opus-5': { requests: 1, input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
    },
    byPhase: {
      implement: { requests: 2, input: 2, output: 2, cacheRead: 2, cacheCreate: 2 },
    },
  };
  const analysis = buildAnalysis({
    cwd: project({
      digests: [
        digest('s-both', {
          metrics: compact({
            models: ['claude-opus-5'],
            ...digestSplit,
          }),
        }),
      ],
      docs: { 's-both': live },
    }),
  });

  const opus = analysis.byModel['claude-opus-5'];
  assert.equal(opus.requests, live.byModel['claude-opus-5'].requests);
  assert.equal(opus.output, live.byModel['claude-opus-5'].output);
  assert.notEqual(opus.requests, digestSplit.byModel['claude-opus-5'].requests);
  assert.equal(analysis.byPhase.implement.requests, live.byPhase.implement.requests);
  assert.notEqual(analysis.byPhase.implement.requests, digestSplit.byPhase.implement.requests);
});

test('the skip rate answers how often forge resolve-model was bypassed', () => {
  const a = doc({ dispatches: { total: 5, allowed: 3, rewritten: 1, denied: 1, skipped: 2 } });
  const b = doc({ dispatches: { total: 3, allowed: 3, rewritten: 0, denied: 0, skipped: 0 } });
  const analysis = buildAnalysis({
    cwd: project({
      digests: [digest('s-a', { metrics: compact() }), digest('s-b', { metrics: compact() })],
      docs: { 's-a': a, 's-b': b },
    }),
  });

  assert.deepEqual(analysis.dispatches, {
    total: 8,
    allowed: 6,
    rewritten: 1,
    denied: 1,
    skipped: 2,
    skipRate: 2 / 8,
    sessions: 2,
  });
  assert.match(formatAnalysis(analysis), /25(\.0)?%/);
});

test('a pruned session still contributes its dispatch counts from the digest', () => {
  // The whole reason the digest carries them: the ledger dies with the dir.
  const analysis = buildAnalysis({
    cwd: project({
      digests: [
        digest('s-pruned', {
          metrics: compact(),
          dispatchesSkipped: 4,
          dispatches: { total: 10, allowed: 6, rewritten: 3, denied: 1, skipped: 4 },
        }),
      ],
    }),
  });

  assert.equal(analysis.dispatches.total, 10);
  assert.equal(analysis.dispatches.skipped, 4);
  assert.equal(analysis.dispatches.skipRate, 0.4);
});

test('--since and --limit narrow the history without reshaping the answer', () => {
  const digests = [
    digest('s-old', { endedAt: '2026-01-01T00:00:00.000Z', metrics: compact({ requests: 1 }) }),
    digest('s-mid', { endedAt: '2026-06-01T00:00:00.000Z', metrics: compact({ requests: 2 }) }),
    digest('s-new', { endedAt: '2026-07-01T00:00:00.000Z', metrics: compact({ requests: 4 }) }),
  ];
  const cwd = project({ digests });

  const since = buildAnalysis({ cwd, since: '2026-05-01' });
  assert.deepEqual(
    since.sessions.map((s) => s.sessionId),
    ['s-new', 's-mid'],
    'newest first, and the January session is out of range',
  );
  assert.equal(since.totals.requests, 6);
  assert.equal(since.coverage.sessionsTotal, 2, 'coverage describes what was analysed');

  const limited = buildAnalysis({ cwd, limit: 1 });
  assert.deepEqual(
    limited.sessions.map((s) => s.sessionId),
    ['s-new'],
  );
  assert.equal(limited.totals.requests, 4);

  const bad = buildAnalysis({ cwd, since: 'not-a-date', limit: 0 });
  assert.equal(bad.coverage.sessionsTotal, 3, 'an unusable filter is ignored, not fatal');
});

test('a grade missing from the digest is recovered from the scorecard ledger', () => {
  const analysis = buildAnalysis({
    cwd: project({
      digests: [digest('s1', { grade: null, score: null, metrics: compact() })],
      cards: [{ sessionId: 's1', score: 77, grade: 'C' }],
    }),
  });

  assert.equal(analysis.sessions[0].grade, 'C');
  assert.equal(analysis.sessions[0].score, 77);
  assert.deepEqual({ ...analysis.grades }, { C: 1 });
});

test('analysis is deterministic and writes nothing', () => {
  const cwd = project({
    digests: [digest('s1', { metrics: compact() }), digest('s2', { metrics: compact() })],
    cards: [{ sessionId: 's1', score: 90, grade: 'A' }],
    docs: { s1: doc() },
  });

  const snapshot = () => {
    /** @type {string[]} */
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${path.relative(cwd, p)}:${fs.readFileSync(p, 'utf8')}`);
      }
    };
    walk(cwd);
    return out.join('\n');
  };

  const before = snapshot();
  const first = buildAnalysis({ cwd });
  const second = buildAnalysis({ cwd });

  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(snapshot(), before, 'analysis is read-only');
  assert.equal(
    JSON.stringify(first).includes('collectedAt'),
    false,
    'a timestamp in the output would make two identical runs differ',
  );
});

test('a corrupt ledger line or metrics document costs that session, not the run', () => {
  const cwd = project({
    digests: [digest('s1', { metrics: compact() }), digest('s2', { metrics: compact() })],
  });
  fs.appendFileSync(path.join(cwd, '.forge', 'sessions.jsonl'), '{"sessionId": "s3", "met\n', 'utf8');
  const dir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metrics.json'), '{ not json', 'utf8');

  const analysis = buildAnalysis({ cwd });
  assert.equal(analysis.coverage.sessionsTotal, 2);
  assert.equal(analysis.sessions[0].hasMetrics, true, 'the digest totals still stand');
});

test('the rendered table leads with coverage and survives an empty history', () => {
  const full = formatAnalysis(
    buildAnalysis({
      cwd: project({
        digests: [digest('s1', { metrics: compact() })],
        docs: { s1: doc() },
      }),
    }),
  );
  const firstMeaningfulLine = full.split('\n').find((l) => l.trim());
  assert.match(firstMeaningfulLine, /coverage/i);
  assert.match(
    firstMeaningfulLine,
    /1 measured,\s*0 predates telemetry,\s*0 collection failed \(of 1; measured 100\.0%\)/,
  );
  assert.match(full, /claude-opus-5/);

  const empty = formatAnalysis(buildAnalysis({ cwd: project() }));
  assert.ok(empty.trim().length > 0, 'zero sessions still renders something readable');
  assert.doesNotThrow(() => formatAnalysis({}));
});

/** Minimal analysis object for `formatAnalysis` — coverage must be non-zero to reach later sections. */
function analysisStub(over = {}) {
  return {
    coverage: {
      sessionsTotal: 1,
      measured: 1,
      predatesTelemetry: 0,
      collectionFailed: 0,
      sessionsWithMetrics: 1,
      ratio: 1,
    },
    totals: { requests: 0, totalTokens: 0, outputTokens: 0, subagents: 0, errorRate: 0 },
    byModel: {},
    byPhase: {},
    dispatches: {
      total: 0,
      sessions: 0,
      allowed: 0,
      rewritten: 0,
      denied: 0,
      skipped: 0,
      skipRate: 0,
    },
    sessions: [],
    ...over,
  };
}

test('model policy: empty tables on sessions do not solely advise wiring the hook', () => {
  const sessions = 9;
  const text = formatAnalysis(
    analysisStub({
      dispatches: {
        total: 0,
        sessions,
        allowed: 0,
        rewritten: 0,
        denied: 0,
        skipped: 0,
        skipRate: 0,
      },
    }),
  );
  assert.match(text, new RegExp(`${sessions} sessions reported no dispatches`, 'i'));
  assert.doesNotMatch(text, /Wire the PreToolUse hook/);
});

test('model policy: zero dispatch sessions still advise wiring the hook', () => {
  const text = formatAnalysis(
    analysisStub({
      dispatches: {
        total: 0,
        sessions: 0,
        allowed: 0,
        rewritten: 0,
        denied: 0,
        skipped: 0,
        skipRate: 0,
      },
    }),
  );
  assert.match(text, /Wire the PreToolUse hook/);
});

test('by-model caption marks requests as detailed-only and header is sess err', () => {
  const text = formatAnalysis(
    analysisStub({
      byModel: {
        'claude-opus-5': {
          sessions: 2,
          detailed: 1,
          requests: 10,
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheCreate: 4,
          sessionErrorRate: 0.01,
          grades: ['A'],
        },
      },
    }),
  );
  const caption = text.split('\n').find((l) => /^By model/.test(l));
  assert.ok(caption, 'By model caption present');
  assert.match(caption, /request/i);
  assert.match(caption, /detailed/i);
  assert.doesNotMatch(caption, /tokens cover the sessions whose metrics\.json still exists/);

  const header = text
    .split('\n')
    .find((l) => /^model\b/.test(l.trim()) && /\bsessions\b/.test(l) && /\brequests\b/.test(l));
  assert.ok(header, 'By model header present');
  const cols = header.trim().split(/\s{2,}/);
  assert.ok(cols.includes('sess err'), `expected sess err in ${JSON.stringify(cols)}`);
  assert.ok(!cols.includes('err'), `bare err must not be a column: ${JSON.stringify(cols)}`);
});

/* ---------- the CLI ---------- */

test('forge analyze is registered, prints a table, and --json emits the object', () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
  const cwd = project({
    digests: [digest('s1', { metrics: compact() })],
    docs: { s1: doc() },
  });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"scratch"}\n', 'utf8');

  const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });

  const text = run(['analyze']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout.split('\n').find((l) => l.trim()), /coverage/i);
  assert.match(text.stdout, /claude-opus-5/);

  const json = run(['analyze', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.coverage.sessionsTotal, 1);
  assert.equal(parsed.byModel['claude-opus-5'].requests, doc().byModel['claude-opus-5'].requests);

  const bad = run(['analyze', '--wat']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--wat/);

  const help = run(['analyze', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /forge analyze/);

  assert.match(fs.readFileSync(bin, 'utf8'), /^ {2}analyze /m, 'listed in forge --help');
});
