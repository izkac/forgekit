import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IDLE_HOURS, sessionHealth } from './health.mjs';
import { e2eStepsHash } from './integrity.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const HOUR = 3600 * 1000;
const NOW = new Date('2026-07-25T12:00:00.000Z').getTime();
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();

/** Project + session dir; session.json is passed separately. */
function makeProject(overrides = {}) {
  const cwd = tmp('forge-health-');
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = {
    id: 's1',
    slug: 'phase-1',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'phase-1',
    tasksTotal: 32,
    tasksComplete: 27,
    createdAt: ago(30),
    updatedAt: ago(1),
    ...overrides,
  };
  return { cwd, sessionDir, session };
}

/** e2e.json in the change dir + a results file in the session dir. */
function writeE2e({ cwd, sessionDir }, { ok, stale = false, ranAt = ago(2) } = {}) {
  const changeDir = path.join(cwd, 'specs', 'changes', 'phase-1');
  fs.mkdirSync(changeDir, { recursive: true });
  const steps = [{ name: 'bench-check-enforces-the-budget-gate', cmd: 'true' }];
  fs.writeFileSync(path.join(changeDir, 'e2e.json'), `${JSON.stringify({ steps })}\n`, 'utf8');
  // stepsHash is computed by integrity.e2eStepsHash; a wrong hash is what a
  // post-run edit of e2e.json looks like.
  const results = {
    ok,
    ranAt,
    stepsHash: stale ? 'deadbeef' : e2eStepsHash(steps),
    steps: [{ name: 'bench-check-enforces-the-budget-gate', ok, exitCode: ok ? 0 : 1 }],
  };
  fs.writeFileSync(
    path.join(sessionDir, 'e2e-results.json'),
    `${JSON.stringify(results)}\n`,
    'utf8',
  );
  return changeDir;
}

test('a session that ran recently and has no failing proof is healthy', () => {
  const p = makeProject();
  const health = sessionHealth({ ...p, now: NOW });
  assert.equal(health.state, 'healthy');
  assert.deepEqual(health.reasons, []);
  assert.match(health.line, /^HEALTHY/);
});

test('a failing e2e run is RED and names the failing step', () => {
  // helm phase-1: 27/32 with e2e red on the bench budget gate, and nothing
  // anywhere said so.
  const p = makeProject();
  writeE2e(p, { ok: false });
  const health = sessionHealth({ ...p, now: NOW });

  assert.equal(health.state, 'red');
  assert.equal(health.reasons.length, 1);
  assert.match(health.reasons[0], /e2e failing/);
  assert.match(health.reasons[0], /bench-check-enforces-the-budget-gate/);
  assert.match(health.line, /^RED —/);
});

test('e2e results that no longer match e2e.json are stale, not green', () => {
  const p = makeProject();
  writeE2e(p, { ok: true, stale: true });
  const health = sessionHealth({ ...p, now: NOW });

  assert.equal(health.state, 'stale');
  assert.match(health.reasons.join(' '), /e2e results.*stale|stale.*e2e/i);
});

test('a green current e2e run keeps the session healthy', () => {
  const p = makeProject();
  writeE2e(p, { ok: true });
  assert.equal(sessionHealth({ ...p, now: NOW }).state, 'healthy');
});

test('an idle session is STALE and says where it stopped', () => {
  const p = makeProject({ updatedAt: ago(14) });
  const health = sessionHealth({ ...p, now: NOW });

  assert.equal(health.state, 'stale');
  assert.match(health.reasons[0], /idle 14h/);
  assert.match(health.reasons[0], /implement 27\/32/);
});

test('idle threshold is configurable and defaults to DEFAULT_IDLE_HOURS', () => {
  const p = makeProject({ updatedAt: ago(DEFAULT_IDLE_HOURS + 1) });
  assert.equal(sessionHealth({ ...p, now: NOW }).state, 'stale');
  assert.equal(sessionHealth({ ...p, now: NOW, idleHours: 48 }).state, 'healthy');
});

test('BLOCKED verify evidence is RED', () => {
  const p = makeProject({ phase: 'verify' });
  fs.writeFileSync(
    path.join(p.sessionDir, 'verify-evidence.md'),
    '# Verify\n\n## Product loop\n\nBLOCKED — the queue worker has no runtime owner yet.\n',
    'utf8',
  );
  const health = sessionHealth({ ...p, now: NOW });
  assert.equal(health.state, 'red');
  assert.match(health.reasons.join(' '), /BLOCKED/);
});

test('a prose mention of BLOCKED mid-line is not a marker (F89)', () => {
  const p = makeProject({ phase: 'verify' });
  fs.writeFileSync(
    path.join(p.sessionDir, 'verify-evidence.md'),
    '# Verify\n\n## Product loop\n\nThe subagent reported BLOCKED in its status summary, then retried green.\n',
    'utf8',
  );
  const health = sessionHealth({ ...p, now: NOW });
  assert.notEqual(health.state, 'red');
  assert.doesNotMatch(health.reasons.join(' '), /BLOCKED/);
});

test('a finished session is neither stale nor red', () => {
  // Idle for a month and carrying an old failing run: done is done.
  const p = makeProject({ phase: 'done', updatedAt: ago(720), tasksComplete: 32 });
  writeE2e(p, { ok: false });
  const health = sessionHealth({ ...p, now: NOW });
  assert.equal(health.state, 'done');
  assert.match(health.line, /^DONE/);
});

test('red outranks stale when both fire', () => {
  const p = makeProject({ updatedAt: ago(14) });
  writeE2e(p, { ok: false });
  const health = sessionHealth({ ...p, now: NOW });
  assert.equal(health.state, 'red');
  assert.equal(health.reasons.length, 2, 'both reasons are reported, severity picks the state');
});

test('fresh tasks.md activity keeps an otherwise-idle session healthy', () => {
  const p = makeProject({ updatedAt: ago(14), tasksComplete: 0, tasksTotal: 46 });
  const changeDir = path.join(p.cwd, 'specs', 'changes', 'phase-1');
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksFile = path.join(changeDir, 'tasks.md');
  fs.writeFileSync(tasksFile, '- [x] 1.1\n- [x] 1.2\n- [ ] 1.3\n', 'utf8');
  // mtime within the idle window (1h ago)
  const fresh = (NOW - HOUR) / 1000;
  fs.utimesSync(tasksFile, fresh, fresh);

  const health = sessionHealth({ ...p, now: NOW });
  assert.equal(health.state, 'healthy');
});

test('idle reason prefers checkbox counts from tasks.md over session cache', () => {
  const p = makeProject({ updatedAt: ago(14), tasksComplete: 0, tasksTotal: 46 });
  const changeDir = path.join(p.cwd, 'specs', 'changes', 'phase-1');
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksFile = path.join(changeDir, 'tasks.md');
  fs.writeFileSync(tasksFile, '- [x] 1.1\n- [x] 1.2\n- [ ] 1.3\n', 'utf8');
  const old = (NOW - 14 * HOUR) / 1000;
  fs.utimesSync(tasksFile, old, old);

  const health = sessionHealth({ ...p, now: NOW });
  assert.equal(health.state, 'stale');
  assert.match(health.reasons[0], /implement 2\/3/);
});
