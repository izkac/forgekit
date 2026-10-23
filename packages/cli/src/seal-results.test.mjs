import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkIntegritySeal, refreshIntegritySeal } from './integrity-seal.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const CHANGE = 'demo';

/**
 * A sealed session in `implement`. With a change, e2e.json / gates.json live
 * beside it and the results land in the (sealed) session dir; without one the
 * scaffolds themselves live in the session dir. Gates are enabled in the
 * project config before sealing.
 *
 * @param {string} root
 * @param {{ withChange?: boolean }} [opts]
 */
function makeSealedSession(root, opts = {}) {
  const withChange = opts.withChange !== false;
  const sessionId = 'sess-seal-results';
  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const changeDir = path.join(root, 'specs', 'changes', CHANGE);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '## 1. Group\n- [x] 1.1 task\n', 'utf8');
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    slug: 'fixture',
    createdAt: now,
    updatedAt: now,
    phase: 'implement',
    planType: withChange ? 'specs' : null,
    openspecChange: withChange ? CHANGE : null,
    tasksTotal: 1,
    tasksComplete: 1,
    pace: 'auto',
    resolvedPace: 'standard',
    pacePinned: false,
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(root, '.forge', 'config.json'),
    `${JSON.stringify({ gates: { enabled: true } }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'seal-results fixture' }, null, 2)}\n`,
    'utf8',
  );
  const passing = 'node -e "process.exit(0)"';
  const e2eDoc = { change: CHANGE, steps: [{ name: 'loop', cmd: passing }] };
  const gatesDoc = { groups: [{ id: '1', title: 'Group', check: passing, expect: '', timeoutMs: 20000 }] };
  const docDir = withChange ? changeDir : sessionDir;
  fs.writeFileSync(path.join(docDir, 'e2e.json'), `${JSON.stringify(e2eDoc, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(docDir, 'gates.json'), `${JSON.stringify(gatesDoc, null, 2)}\n`, 'utf8');
  // Results from an earlier run are already sealed: a file that first appears
  // after the seal is accepted, so only an overwrite can read as tampering.
  fs.writeFileSync(path.join(sessionDir, 'e2e-results.json'), `${JSON.stringify({ ok: false, steps: [] })}
`, 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'gate-results.json'), `${JSON.stringify({ groups: [], ranAt: null })}
`, 'utf8');
  refreshIntegritySeal({ sessionDir, repoRoot: root });
  assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir }).problems, [], 'fixture starts sealed and clean');

  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(root, 'fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env });
  return { sessionDir, run };
}

test('forge e2e run writes e2e-results.json and leaves the seal clean', () => {
  const root = tmp('forge-seal-results-e2e-');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const fx = makeSealedSession(root);
    const resultsFile = path.join(fx.sessionDir, 'e2e-results.json');
    const before = fs.readFileSync(resultsFile, 'utf8');

    const e2e = fx.run(['e2e', 'run']);
    assert.equal(e2e.status, 0, e2e.stderr + e2e.stdout);
    assert.notEqual(fs.readFileSync(resultsFile, 'utf8'), before, 'the run must overwrite the sealed results');
    assert.equal(JSON.parse(fs.readFileSync(resultsFile, 'utf8')).ok, true);
    assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir: fx.sessionDir }).problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge gate check writes gate-results.json and leaves the seal clean', () => {
  const root = tmp('forge-seal-results-gate-');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const fx = makeSealedSession(root);
    const resultsFile = path.join(fx.sessionDir, 'gate-results.json');
    const before = fs.readFileSync(resultsFile, 'utf8');

    const gate = fx.run(['gate', 'check']);
    assert.equal(gate.status, 0, gate.stderr + gate.stdout);
    assert.notEqual(fs.readFileSync(resultsFile, 'utf8'), before, 'the check must overwrite the sealed results');
    assert.equal(JSON.parse(fs.readFileSync(resultsFile, 'utf8')).groups.length, 1);
    assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir: fx.sessionDir }).problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forge spine init --force / forge e2e init --force on session-dir copies keep the seal', () => {
  const root = tmp('forge-seal-results-init-');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const fx = makeSealedSession(root, { withChange: false });
    const spineFile = path.join(fx.sessionDir, 'spine.json');
    const e2eFile = path.join(fx.sessionDir, 'e2e.json');
    const spineBefore = fs.readFileSync(spineFile, 'utf8');
    const e2eBefore = fs.readFileSync(e2eFile, 'utf8');

    const spine = fx.run(['spine', 'init', '--force']);
    assert.equal(spine.status, 0, spine.stderr);
    assert.notEqual(fs.readFileSync(spineFile, 'utf8'), spineBefore, 'init --force must have overwritten the sealed file');
    assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir: fx.sessionDir }).problems, []);

    const e2e = fx.run(['e2e', 'init', '--force']);
    assert.equal(e2e.status, 0, e2e.stderr);
    assert.notEqual(fs.readFileSync(e2eFile, 'utf8'), e2eBefore);
    assert.deepEqual(checkIntegritySeal({ cwd: root, sessionDir: fx.sessionDir }).problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: sealed session, forge e2e run, forge phase <next> exits 0', () => {
  const root = tmp('forge-seal-results-phase-');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const fx = makeSealedSession(root);

    const e2e = fx.run(['e2e', 'run']);
    assert.equal(e2e.status, 0, e2e.stderr + e2e.stdout);

    const phase = fx.run(['phase', 'verify']);
    assert.doesNotMatch(phase.stderr, /untracked session artifact mutated|integrity failed/);
    assert.equal(phase.status, 0, phase.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
