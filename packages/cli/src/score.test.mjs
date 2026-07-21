import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatScorecardMarkdown,
  gradeForScore,
  scoreSession,
  writeSessionScorecard,
} from './score.mjs';
import { e2eStepsHash } from './integrity.mjs';

const PHASE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');
const SCORE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'score-cli.mjs');
const CLEANUP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cleanup-sessions.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSession(root, overrides = {}) {
  const sessionDir = path.join(root, '.forge', 'sessions', 'sess-score');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const session = {
    id: 'sess-score',
    slug: 'fixture',
    createdAt: now,
    updatedAt: now,
    phase: 'verify',
    planType: null,
    openspecChange: null,
    tasksTotal: 2,
    tasksComplete: 2,
    pace: 'auto',
    resolvedPace: 'standard',
    pacePinned: false,
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'sess-score' }, null, 2)}\n`,
    'utf8',
  );
  return { sessionDir, session };
}

function validSpine(rows) {
  return {
    change: null,
    notApplicable: null,
    rows,
  };
}

function validRow() {
  return {
    capability: 'REQ-GOV-01 matching',
    library: 'etl_core/matcher.py',
    runtimeOwner: 'worker job analyze_study',
    writes: 'study_proposals',
    reads: 'N/A',
    uiConsumer: 'Proposals',
    evidence: 'tasks/12/test-evidence.md',
  };
}

test('gradeForScore bands', () => {
  assert.equal(gradeForScore(95), 'A');
  assert.equal(gradeForScore(80), 'B');
  assert.equal(gradeForScore(60), 'C');
  assert.equal(gradeForScore(40), 'D');
  assert.equal(gradeForScore(10), 'F');
});

test('scoreSession: strong sync-only session scores high', () => {
  const root = tmp('forge-score-strong-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'add-health' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nExit 0\n', 'utf8');
    const taskDir = path.join(sessionDir, 'tasks', '01-health');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, 'test-evidence.md'),
      '# Test evidence\n\n- **Exit code:** 0\n- **Summary:** assert response.ok === true\n',
      'utf8',
    );

    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score >= 80, `expected >=80, got ${card.score}`);
    assert.ok(['A', 'B'].includes(card.grade));
    assert.equal(card.integrityOk, true);
    assert.match(formatScorecardMarkdown(card), /Grade: [AB]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: missing spine scores poorly', () => {
  const root = tmp('forge-score-weak-');
  try {
    const { sessionDir, session } = makeSession(root);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score < 60, `expected weak score, got ${card.score}`);
    assert.equal(card.integrityOk, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: incompleteReason caps score at 59', () => {
  const root = tmp('forge-score-cap-');
  try {
    const { sessionDir, session } = makeSession(root, {
      incompleteReason: 'E2E blocked',
      slug: 'add-health',
    });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const card = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(card.score <= 59);
    assert.ok(card.caps.some((c) => /incompleteReason/.test(c)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: product-loop with baseline-diff scores higher than bare section', () => {
  const root = tmp('forge-score-loop-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'wire-worker-jobs' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(validSpine([validRow()]), null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## Product loop\n\nJust a heading\n',
      'utf8',
    );
    const weak = scoreSession({ cwd: root, sessionDir, session });

    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      `# Verify

## Product loop

Fixture: OP1086

1. ingest
2. analyze
3. ratify
4. run @R — output differs from baseline
`,
      'utf8',
    );
    const strong = scoreSession({ cwd: root, sessionDir, session });
    assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
    const loop = strong.checks.find((c) => c.id === 'product_loop');
    assert.ok(loop.points >= 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: product-loop bonuses match inflected forms (asserts, fixtures, ratify)', () => {
  const root = tmp('forge-score-inflect-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'jobs-loop' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(validSpine([validRow()]), null, 2)}\n`,
      'utf8',
    );
    // Every keyword deliberately inflected — a trailing \b used to reject all of these.
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## Product loop\n\n1. seed fixtures\n2. run the loop\n3. asserts the ratify output differs from stored baselines\n',
      'utf8',
    );
    const card = scoreSession({ cwd: root, sessionDir, session });
    const loop = card.checks.find((c) => c.id === 'product_loop');
    const notes = loop.notes.join('\n');
    assert.match(notes, /names a fixture/);
    assert.match(notes, /asserts decision\/output change/);
    assert.equal(loop.points, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreSession: green e2e run proves the loop even without the phrase', () => {
  const root = tmp('forge-score-e2e-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'jobs-loop' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(validSpine([validRow()]), null, 2)}\n`,
      'utf8',
    );
    // Evidence deliberately avoids the words "product loop" — before the fix
    // this session scored 0/20 despite an executed green run.
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## What the evidence actually proves\n\nReverted the fix, reproduced the broken row, re-applied, ran the loop green.\n',
      'utf8',
    );
    const steps = [{ name: 'probe', cmd: 'node -e "console.log(1)"' }];
    fs.writeFileSync(
      path.join(sessionDir, 'e2e.json'),
      `${JSON.stringify({ change: null, notApplicable: null, steps }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'e2e-results.json'),
      `${JSON.stringify({ ok: true, stepsHash: e2eStepsHash(steps), steps: [{ name: 'probe', ok: true, exitCode: 0 }] }, null, 2)}\n`,
      'utf8',
    );
    const card = scoreSession({ cwd: root, sessionDir, session });
    const loop = card.checks.find((c) => c.id === 'product_loop');
    assert.ok(loop.points >= 8, `expected >= 8 loop points, got ${loop.points}`);
    assert.match(loop.notes.join('\n'), /proven by execution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge cleanup harvests scorecard.json into the ledger before pruning', () => {
  const root = tmp('forge-cleanup-harvest-');
  try {
    const { sessionDir, session } = makeSession(root, { phase: 'done' });
    // A scorecard as an older (pre-ledger) forgekit would have written it.
    fs.writeFileSync(
      path.join(sessionDir, 'scorecard.json'),
      `${JSON.stringify({
        scoredAt: '2026-06-01T00:00:00.000Z',
        sessionId: session.id,
        slug: session.slug,
        openspecChange: null,
        score: 83,
        maxScore: 100,
        grade: 'B',
        integrityOk: true,
        caps: [],
        checks: [{ id: 'spine', label: 'Spine matrix quality', points: 20, max: 25, notes: ['one row thin'] }],
      }, null, 2)}\n`,
      'utf8',
    );
    execFileSync(process.execPath, [CLEANUP_SCRIPT, '--include-active'], {
      cwd: root,
      env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(root, 'fleet') },
    });
    assert.equal(fs.existsSync(sessionDir), false);
    const ledger = path.join(root, '.forge', 'scorecards.jsonl');
    const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.sessionId, session.id);
    assert.equal(entry.grade, 'B');
    assert.equal(entry.deductions[0].id, 'spine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeSessionScorecard writes json and md', () => {
  const root = tmp('forge-score-write-');
  try {
    const { sessionDir, session } = makeSession(root, { slug: 'docs-only' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'docs-only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const { jsonPath, mdPath, card } = writeSessionScorecard({ cwd: root, sessionDir, session });
    assert.equal(fs.existsSync(jsonPath), true);
    assert.equal(fs.existsSync(mdPath), true);
    assert.equal(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).grade, card.grade);

    // Durable ledger: one line per session, re-scoring replaces (not appends).
    const ledger = path.join(root, '.forge', 'scorecards.jsonl');
    assert.equal(fs.existsSync(ledger), true);
    writeSessionScorecard({ cwd: root, sessionDir, session });
    const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.sessionId, session.id);
    assert.equal(entry.grade, card.grade);
    assert.ok(Array.isArray(entry.deductions));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge phase done writes scorecard and stamps session.scoreGrade', () => {
  const root = tmp('forge-score-phase-');
  try {
    const { sessionDir } = makeSession(root, {
      slug: 'add-health',
      phase: 'verify',
      tasksTotal: 1,
      tasksComplete: 1,
    });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

    execFileSync(process.execPath, [PHASE_SCRIPT, 'done'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(fs.existsSync(path.join(sessionDir, 'scorecard.md')), true);
    assert.equal(fs.existsSync(path.join(sessionDir, 'scorecard.json')), true);
    const session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(session.phase, 'done');
    assert.ok(typeof session.score === 'number');
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(session.scoreGrade));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge score CLI prints JSON', () => {
  const root = tmp('forge-score-cli-');
  try {
    const { sessionDir } = makeSession(root, { slug: 'add-health' });
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    const out = execFileSync(process.execPath, [SCORE_SCRIPT], {
      cwd: root,
      encoding: 'utf8',
    });
    const card = JSON.parse(out);
    assert.ok(card.grade);
    assert.ok(Array.isArray(card.humanPrompts));
    assert.equal(card.humanPrompts.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
