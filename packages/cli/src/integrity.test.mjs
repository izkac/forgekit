import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  JOBS_SIGNAL_RE,
  addDeferral,
  checkE2eGate,
  e2ePath,
  e2eStepsHash,
  e2eTemplate,
  initE2e,
  initSpine,
  loadDeferrals,
  openDeferrals,
  resolveChangeDir,
  resolveDeferral,
  runE2eSteps,
  runIntegrityChecks,
  sessionJobsSignalText,
  spinePath,
  spineTemplate,
  validateE2e,
  validateSpine,
  writeE2eResults,
} from './integrity.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function validRow(overrides = {}) {
  return {
    capability: 'REQ-GOV-01 matching',
    library: 'services/etl-core/matcher.py',
    runtimeOwner: 'worker job analyze_study',
    writes: 'study_proposals',
    reads: 'N/A',
    uiConsumer: 'Proposals page',
    evidence: 'tasks/12-analyze/test-evidence.md',
    ...overrides,
  };
}

test('validateSpine: filled rows pass', () => {
  const result = validateSpine({ change: 'x', notApplicable: null, rows: [validRow()] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('validateSpine: library-only row fails (missing runtimeOwner/writes/evidence)', () => {
  const result = validateSpine({
    rows: [validRow({ runtimeOwner: '', writes: '', evidence: '' })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.match(result.problems.join('\n'), /runtimeOwner/);
  assert.match(result.problems.join('\n'), /writes/);
  assert.match(result.problems.join('\n'), /evidence/);
});

test('validateSpine: scaffold placeholders are rejected', () => {
  const result = validateSpine(spineTemplate({ change: 'x' }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /scaffold placeholder/);
});

test('validateSpine: empty rows fail; notApplicable opt-out passes', () => {
  assert.equal(validateSpine({ rows: [] }).ok, false);
  assert.equal(validateSpine({ rows: [], notApplicable: 'docs-only change' }).ok, true);
});

test('spine init writes template and refuses overwrite without force', () => {
  const dir = tmp('forge-spine-');
  try {
    const file = path.join(dir, 'spine.json');
    initSpine({ file, change: 'my-change' });
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.change, 'my-change');
    assert.throws(() => initSpine({ file, change: 'my-change' }), /already exists/);
    initSpine({ file, change: 'other', force: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).change, 'other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveChangeDir: openspec plan type and session-dir fallback', () => {
  const cwd = tmp('forge-changedir-');
  try {
    const dir = resolveChangeDir({
      cwd,
      session: { planType: 'openspec', openspecChange: 'my-change' },
    });
    assert.equal(dir, path.join(cwd, 'openspec', 'changes', 'my-change'));
    assert.equal(resolveChangeDir({ cwd, session: { openspecChange: null } }), null);
    const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
    assert.equal(
      spinePath({ cwd, session: { openspecChange: null }, sessionDir }),
      path.join(sessionDir, 'spine.json'),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveChangeDir: falls back to the archived copy after archive', () => {
  for (const [planType, root] of [
    ['openspec', ['openspec', 'changes']],
    ['specs', ['specs', 'changes']],
  ]) {
    const cwd = tmp('forge-changedir-arch-');
    try {
      const changesDir = path.join(cwd, ...root);
      const liveDir = path.join(changesDir, 'add-customer-registry');
      fs.mkdirSync(liveDir, { recursive: true });
      const session = { planType, openspecChange: 'add-customer-registry' };

      // Live dir present → live path.
      assert.equal(resolveChangeDir({ cwd, session }), liveDir);

      // Archive moves it → resolve follows into changes/archive/<date>-<name>.
      const archived = path.join(changesDir, 'archive', '2026-07-20-add-customer-registry');
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      fs.renameSync(liveDir, archived);
      assert.equal(resolveChangeDir({ cwd, session }), archived);

      // Newest archive wins when a change name recurs.
      const older = path.join(changesDir, 'archive', '2025-01-01-add-customer-registry');
      fs.mkdirSync(older, { recursive: true });
      assert.equal(resolveChangeDir({ cwd, session }), archived);

      // No false match on a different change that ends with the same words.
      fs.mkdirSync(path.join(changesDir, 'archive', '2026-07-20-extra-add-customer-registry'), {
        recursive: true,
      });
      assert.equal(resolveChangeDir({ cwd, session }), archived);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('runIntegrityChecks: passes after archive (spine resolves in archive dir)', () => {
  const cwd = tmp('forge-int-archived-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const session = { planType: 'openspec', openspecChange: 'add-customer-registry', slug: 'add-customer-registry' };

    // Green while live: spine in the change dir (sync-only notApplicable).
    const liveDir = path.join(cwd, 'openspec', 'changes', 'add-customer-registry');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(
      path.join(liveDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    assert.equal(runIntegrityChecks({ cwd, sessionDir, session }).ok, true);

    // Archive the change — the mechanical gate must STILL pass (the bug: it
    // used to look only at the vanished live path and fail).
    const archived = path.join(cwd, 'openspec', 'changes', 'archive', '2026-07-20-add-customer-registry');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(liveDir, archived);
    assert.equal(runIntegrityChecks({ cwd, sessionDir, session }).ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('deferrals: add, list, resolve lifecycle', () => {
  const dir = tmp('forge-defer-');
  try {
    addDeferral(dir, { task: '9.2', reason: 'wiring lands in 9.7' });
    assert.equal(openDeferrals(dir).length, 1);
    assert.throws(() => addDeferral(dir, { task: '9.2', reason: 'dup' }), /already open/);
    resolveDeferral(dir, '9.2');
    assert.equal(openDeferrals(dir).length, 0);
    assert.equal(loadDeferrals(dir).deferrals.length, 1);
    assert.throws(() => resolveDeferral(dir, '9.2'), /No open deferral/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deferrals: add requires task and reason', () => {
  const dir = tmp('forge-defer-req-');
  try {
    assert.throws(() => addDeferral(dir, { task: '', reason: 'x' }), /--task/);
    assert.throws(() => addDeferral(dir, { task: '1.1', reason: '' }), /--reason/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JOBS_SIGNAL_RE + sessionJobsSignalText', () => {
  assert.equal(JOBS_SIGNAL_RE.test('etl-surveydb-harmonization-platform worker'), true);
  assert.equal(JOBS_SIGNAL_RE.test('fix toolbar padding'), false);
  assert.equal(
    sessionJobsSignalText({ paceSignal: null, slug: 'my-slug', openspecChange: 'chg' }),
    'my-slug chg',
  );
});

function makeSessionDir(root) {
  const dir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('runIntegrityChecks: missing spine always fails (not keyword-gated)', () => {
  const cwd = tmp('forge-int-clean-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'fix-toolbar', openspecChange: null },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /spine\.json required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: notApplicable spine allows sync-only without product-loop', () => {
  const cwd = tmp('forge-int-na-sync-');
  try {
    const sessionDir = makeSessionDir(cwd);
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(
        { rows: [], notApplicable: 'sync HTTP only — no async producer/consumer' },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'fix-toolbar', openspecChange: null },
    });
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: unresolved deferral fails', () => {
  const cwd = tmp('forge-int-defer-');
  try {
    const sessionDir = makeSessionDir(cwd);
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync only' }, null, 2)}\n`,
      'utf8',
    );
    addDeferral(sessionDir, { task: '9.2', reason: 'later' });
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'fix-toolbar', openspecChange: null },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /unresolved deferrals: 9\.2/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: empty slug without spine still fails', () => {
  const cwd = tmp('forge-int-jobs-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'add-harmonization-platform', openspecChange: null },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /spine\.json required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function greenStep(overrides = {}) {
  return {
    name: 'produce',
    cmd: 'node -e "console.log(\'proposals: 3\')"',
    ...overrides,
  };
}

function writeSpineWithRows(sessionDir) {
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ change: null, notApplicable: null, rows: [validRow()] }, null, 2)}\n`,
    'utf8',
  );
}

function writeE2eDoc(sessionDir, doc) {
  fs.writeFileSync(path.join(sessionDir, 'e2e.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

test('validateE2e: filled steps pass; template placeholders rejected', () => {
  assert.equal(validateE2e({ notApplicable: null, steps: [greenStep()] }).ok, true);
  const scaffold = validateE2e(e2eTemplate({ change: 'x' }));
  assert.equal(scaffold.ok, false);
  assert.match(scaffold.problems.join('\n'), /scaffold placeholder/);
});

test('validateE2e: missing cmd, bad regex, bad timeout, empty steps', () => {
  assert.match(
    validateE2e({ steps: [{ name: 'x', cmd: '' }] }).problems.join('\n'),
    /missing cmd/,
  );
  assert.match(
    validateE2e({ steps: [greenStep({ expect: '(' })] }).problems.join('\n'),
    /not a valid regex/,
  );
  assert.match(
    validateE2e({ steps: [greenStep({ timeoutMs: -5 })] }).problems.join('\n'),
    /timeoutMs/,
  );
  assert.match(validateE2e({ steps: [] }).problems.join('\n'), /steps is empty/);
  assert.equal(validateE2e({ steps: [], notApplicable: 'no headless env — manual device loop' }).ok, true);
});

test('e2e init writes template and refuses overwrite without force', () => {
  const dir = tmp('forge-e2e-init-');
  try {
    const file = path.join(dir, 'e2e.json');
    initE2e({ file, change: 'my-change' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).change, 'my-change');
    assert.throws(() => initE2e({ file, change: 'my-change' }), /already exists/);
    initE2e({ file, change: 'other', force: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).change, 'other');
    assert.equal(
      e2ePath({ cwd: dir, session: { openspecChange: null }, sessionDir: dir }),
      file,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runE2eSteps: green run with expect match', () => {
  const results = runE2eSteps({ steps: [greenStep({ expect: 'proposals: \\d+' })] });
  assert.equal(results.ok, true);
  assert.equal(results.steps[0].exitCode, 0);
  assert.equal(results.steps[0].expectMatched, true);
  assert.equal(results.stepsHash, e2eStepsHash([greenStep({ expect: 'proposals: \\d+' })]));
});

test('runE2eSteps: non-zero exit fails and skips later steps', () => {
  const results = runE2eSteps({
    steps: [
      { name: 'boom', cmd: 'node -e "process.exit(3)"' },
      greenStep({ name: 'never' }),
    ],
  });
  assert.equal(results.ok, false);
  assert.equal(results.steps[0].exitCode, 3);
  assert.equal(results.steps[1].skipped, true);
});

test('runE2eSteps: exit 0 but expect mismatch fails', () => {
  const results = runE2eSteps({ steps: [greenStep({ expect: 'ratified: \\d+' })] });
  assert.equal(results.ok, false);
  assert.equal(results.steps[0].expectMatched, false);
});

test('checkE2eGate: missing file, missing results, stale hash, failed run, green, notApplicable', () => {
  const dir = tmp('forge-e2e-gate-');
  try {
    const e2eFile = path.join(dir, 'e2e.json');

    let gate = checkE2eGate({ e2eFile, sessionDir: dir });
    assert.match(gate.problems.join('\n'), /e2e\.json required/);

    writeE2eDoc(dir, { notApplicable: null, steps: [greenStep()] });
    gate = checkE2eGate({ e2eFile, sessionDir: dir });
    assert.match(gate.problems.join('\n'), /e2e-results\.json missing/);

    const results = runE2eSteps({ steps: [greenStep()] });
    writeE2eResults(dir, results);
    gate = checkE2eGate({ e2eFile, sessionDir: dir });
    assert.deepEqual(gate.problems, []);

    writeE2eDoc(dir, { notApplicable: null, steps: [greenStep({ name: 'edited' })] });
    gate = checkE2eGate({ e2eFile, sessionDir: dir });
    assert.match(gate.problems.join('\n'), /stale/);

    writeE2eDoc(dir, { notApplicable: null, steps: [{ name: 'boom', cmd: 'node -e "process.exit(1)"' }] });
    writeE2eResults(dir, runE2eSteps({ steps: [{ name: 'boom', cmd: 'node -e "process.exit(1)"' }] }));
    gate = checkE2eGate({ e2eFile, sessionDir: dir });
    assert.match(gate.problems.join('\n'), /failed at step "boom"/);

    writeE2eDoc(dir, { notApplicable: 'loop needs a physical device', steps: [] });
    gate = checkE2eGate({ e2eFile, sessionDir: dir });
    assert.deepEqual(gate.problems, []);
    assert.equal(gate.notApplicable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: spine rows demand an executed green e2e run', () => {
  const cwd = tmp('forge-int-loop-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeSpineWithRows(sessionDir);
    const session = { slug: 'wire-worker-jobs', openspecChange: null };

    let result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /e2e\.json required/);

    writeE2eDoc(sessionDir, { notApplicable: null, steps: [greenStep()] });
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /e2e-results\.json missing/);

    writeE2eResults(sessionDir, runE2eSteps({ steps: [greenStep()] }));
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, true);
    assert.equal(result.e2eFile, path.join(sessionDir, 'e2e.json'));

    // prose "## Product loop" alone no longer satisfies the gate
    fs.rmSync(path.join(sessionDir, 'e2e-results.json'));
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## Product loop\n\ningest -> analyze -> ratify: output differs\n',
      'utf8',
    );
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /e2e-results\.json missing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: BLOCKED in verify-evidence blocks even with green e2e', () => {
  const cwd = tmp('forge-int-blocked-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeSpineWithRows(sessionDir);
    writeE2eDoc(sessionDir, { notApplicable: null, steps: [greenStep()] });
    writeE2eResults(sessionDir, runE2eSteps({ steps: [greenStep()] }));
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\nBLOCKED: ratify UI unreachable in CI\n',
      'utf8',
    );
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'wire-worker-jobs', openspecChange: null },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /BLOCKED/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: invalid spine fails even without jobs signal', () => {
  const cwd = tmp('forge-int-badspine-');
  try {
    const sessionDir = makeSessionDir(cwd);
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [validRow({ runtimeOwner: '' })] }, null, 2)}\n`,
      'utf8',
    );
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'fix-toolbar', openspecChange: null },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /spine: .*runtimeOwner/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: notApplicable spine passes without evidence demands', () => {
  const cwd = tmp('forge-int-na-');
  try {
    const sessionDir = makeSessionDir(cwd);
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'docs-only change' }, null, 2)}\n`,
      'utf8',
    );
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'wire-worker-jobs', openspecChange: null },
    });
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
