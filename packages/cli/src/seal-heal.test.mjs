import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkIntegritySeal, refreshIntegritySeal } from './integrity-seal.mjs';
import { healSessionProgress } from './plan-progress.mjs';
import { writeSessionScorecard } from './score.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const CHANGE = 'demo';

/**
 * A sealed specs-engine session whose change has a tasks.md with `ticked` of
 * `total` boxes checked. Returns paths plus a helper that ticks one more box.
 *
 * @param {string} root
 * @param {{ total?: number, ticked?: number, phase?: string, session?: Record<string, unknown> }} [opts]
 */
function makeSealedSpecsSession(root, opts = {}) {
  const total = opts.total ?? 3;
  const ticked = opts.ticked ?? 0;
  const sessionId = 'sess-seal-heal';
  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const changeDir = path.join(root, 'specs', 'changes', CHANGE);
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksFile = path.join(changeDir, 'tasks.md');
  const writeTasks = (n) => {
    const lines = Array.from({ length: total }, (_, i) => `- [${i < n ? 'x' : ' '}] 1.${i + 1} task ${i + 1}`);
    fs.writeFileSync(tasksFile, `## Group\n${lines.join('\n')}\n`, 'utf8');
  };
  writeTasks(ticked);
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    slug: 'fixture',
    createdAt: now,
    updatedAt: now,
    phase: opts.phase ?? 'implement',
    planType: 'specs',
    openspecChange: CHANGE,
    tasksTotal: total,
    tasksComplete: ticked,
    pace: 'auto',
    resolvedPace: 'standard',
    pacePinned: false,
    ...opts.session,
  };
  const sessionFile = path.join(sessionDir, 'session.json');
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'seal-heal fixture' }, null, 2)}\n`,
    'utf8',
  );
  refreshIntegritySeal({ sessionDir, repoRoot: root });
  assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir }).problems, [], 'fixture starts sealed and clean');
  return { sessionDir, sessionFile, session, writeTasks, total };
}

test('healSessionProgress refreshes the seal after rewriting session.json', () => {
  const root = tmp('forge-seal-heal-progress-');
  try {
    const fx = makeSealedSpecsSession(root, { total: 3, ticked: 1 });
    fx.writeTasks(2);
    const onDiskBefore = fs.readFileSync(fx.sessionFile, 'utf8');

    const { changed, progress } = healSessionProgress({ cwd: root, sessionDir: fx.sessionDir, session: fx.session });

    assert.equal(changed, true);
    assert.equal(progress.complete, 2);
    assert.notEqual(fs.readFileSync(fx.sessionFile, 'utf8'), onDiskBefore, 'heal must have rewritten session.json');
    assert.equal(JSON.parse(fs.readFileSync(fx.sessionFile, 'utf8')).tasksComplete, progress.complete);
    assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir: fx.sessionDir }).problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('healSessionProgress with nothing to heal leaves the seal untouched', () => {
  const root = tmp('forge-seal-heal-noop-');
  try {
    const fx = makeSealedSpecsSession(root, { total: 3, ticked: 1 });
    const sealFile = path.join(fx.sessionDir, 'integrity-seal.json');
    const sealBefore = fs.readFileSync(sealFile, 'utf8');
    const { changed } = healSessionProgress({ cwd: root, sessionDir: fx.sessionDir, session: fx.session });
    assert.equal(changed, false);
    assert.equal(fs.readFileSync(sealFile, 'utf8'), sealBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeSessionScorecard heals the cached score and refreshes the seal', () => {
  const root = tmp('forge-seal-heal-score-');
  try {
    const fx = makeSealedSpecsSession(root, {
      total: 2,
      ticked: 2,
      phase: 'verify',
      session: { planType: null, openspecChange: null, tasksTotal: 2, tasksComplete: 2, score: 97, scoreGrade: 'A' },
    });
    fs.writeFileSync(path.join(fx.sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    refreshIntegritySeal({ sessionDir: fx.sessionDir, repoRoot: root });

    const { card } = writeSessionScorecard({ cwd: root, sessionDir: fx.sessionDir, session: fx.session });

    const after = JSON.parse(fs.readFileSync(fx.sessionFile, 'utf8'));
    assert.notEqual(after.score, 97, 'fixture must actually re-score differently, or the heal never writes');
    assert.equal(after.score, card.score);
    assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir: fx.sessionDir }).problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: ticked task, forge status heals, forge phase passes the seal check', () => {
  const root = tmp('forge-seal-heal-e2e-');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const fx = makeSealedSpecsSession(root, { total: 3, ticked: 1, phase: 'implement' });
    fx.writeTasks(2);

    const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(root, 'fleet') };
    delete env.CLAUDE_CODE_SESSION_ID;
    const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env });

    const status = run(['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(fx.sessionFile, 'utf8')).tasksComplete,
      2,
      'forge status must have healed the cached progress from tasks.md',
    );

    const phase = run(['phase', 'verify']);
    assert.doesNotMatch(phase.stderr, /untracked session artifact mutated|integrity failed/);
    assert.equal(phase.status, 0, phase.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
