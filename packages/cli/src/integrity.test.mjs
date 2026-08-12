import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  JOBS_SIGNAL_RE,
  addDeferral,
  checkE2eGate,
  checkTddEvidence,
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
import { NO_TDD_MARKER, NO_TDD_REASON_LABEL, runRecordEvidence } from './record-evidence.mjs';
import { addAllowance } from './guard.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/** A scratch git repo the guarded-files backstop can diff against. */
function gitRepo(prefix) {
  const dir = tmp(prefix);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'forge-test'], { cwd: dir });
  return dir;
}

function gitCommitAll(dir, message) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  const result = spawnSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  if (result.status !== 0) {
    throw new Error(`git commit failed in ${dir}: ${result.stderr}`);
  }
}

function gitHead(dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
}

/** Writes a minimal, always-valid spine.json so only the guardedFiles check can fail. */
function writeNaSpine(sessionDir, reason = 'sync only — guardedFiles fixture') {
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: reason }, null, 2)}\n`,
    'utf8',
  );
}

/** Captures stderr writes made during `fn`, restoring the real stream after. */
function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
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

      // forWrite (spine/e2e init) never follows into the archive — writes must
      // target the live change dir so scaffolding can't corrupt frozen history.
      assert.equal(resolveChangeDir({ cwd, session, forWrite: true }), liveDir);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('resolveChangeDir: a specs session never falls back to the openspec dir', () => {
  // Regression: resolveProjectPlanEngine's last-resort default is
  // {engine:'openspec', dir:'openspec'}, so a specs-engine session in a
  // project whose .forge/config.json has no `plan` block (ADR-only config,
  // pre-engine config, hand-written) resolved into openspec/changes/<name> —
  // which made `forge phase implement` refuse a brief that was right there.
  const cwd = tmp('forge-specs-dir-');
  try {
    const session = { planType: 'specs', openspecChange: 'my-change' };
    fs.mkdirSync(path.join(cwd, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      `${JSON.stringify({ adr: { enabled: true, dir: 'docs/adr' } })}\n`,
      'utf8',
    );
    const specsChange = path.join(cwd, 'specs', 'changes', 'my-change');
    fs.mkdirSync(specsChange, { recursive: true });

    assert.equal(resolveChangeDir({ cwd, session }), specsChange);
    assert.equal(resolveChangeDir({ cwd, session, forWrite: true }), specsChange);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveChangeDir: specs engine honors a configured plan.dir', () => {
  // `forge init --no-openspec --plan-dir openspec` — specs engine reusing an
  // existing OpenSpec tree without moving files.
  const cwd = tmp('forge-specs-plandir-');
  try {
    const session = { planType: 'specs', openspecChange: 'my-change' };
    fs.mkdirSync(path.join(cwd, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      `${JSON.stringify({ plan: { engine: 'specs', dir: 'openspec' } })}\n`,
      'utf8',
    );
    const changeDir = path.join(cwd, 'openspec', 'changes', 'my-change');
    fs.mkdirSync(changeDir, { recursive: true });

    assert.equal(resolveChangeDir({ cwd, session }), changeDir);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('spinePath/e2ePath forWrite target the live dir even after archive', () => {
  const cwd = tmp('forge-write-guard-');
  try {
    const session = { planType: 'openspec', openspecChange: 'add-customer-registry' };
    const changesDir = path.join(cwd, 'openspec', 'changes');
    // Only the archived copy exists — mimics running init after archive.
    const archived = path.join(changesDir, 'archive', '2026-07-20-add-customer-registry');
    fs.mkdirSync(archived, { recursive: true });
    const liveDir = path.join(changesDir, 'add-customer-registry');

    // Read path resolves the archive; write path stays on the (absent) live dir.
    assert.equal(spinePath({ cwd, session }), path.join(archived, 'spine.json'));
    assert.equal(spinePath({ cwd, session, forWrite: true }), path.join(liveDir, 'spine.json'));
    assert.equal(e2ePath({ cwd, session }), path.join(archived, 'e2e.json'));
    assert.equal(e2ePath({ cwd, session, forWrite: true }), path.join(liveDir, 'e2e.json'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
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

test('runIntegrityChecks: mid-flight session with a live change dir reports no archive problem (gate is done-only)', () => {
  // Mirror image of the "passes after archive" test above: the change stays
  // live (never archived) and the session is not at done/finish. The archive
  // gate lives only in set-phase.mjs's enforceDoneGate — runIntegrityChecks
  // must stay quiet about the unarchived change so `forge integrity-check`
  // and `forge score` don't demand an archive before finish.md's documented
  // sequence has run it.
  const cwd = tmp('forge-int-midflight-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const session = {
      phase: 'implement',
      planType: 'openspec',
      openspecChange: 'add-customer-registry',
      slug: 'add-customer-registry',
    };

    const liveDir = path.join(cwd, 'openspec', 'changes', 'add-customer-registry');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(
      path.join(liveDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );

    const result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(fs.existsSync(liveDir), true, 'fixture keeps the change live, not archived');
    assert.equal(result.ok, true);
    assert.equal(
      result.problems.some((p) => /archiv/i.test(p)),
      false,
      `runIntegrityChecks must not report an archive problem for a mid-flight session; got: ${JSON.stringify(result.problems)}`,
    );
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

test('runIntegrityChecks: project-level e2e disable skips the executed-run demand', () => {
  const cwd = tmp('forge-int-e2eoff-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeSpineWithRows(sessionDir);
    const session = { slug: 'wire-worker-jobs', openspecChange: null };

    let result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /e2e\.json required/);

    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      `${JSON.stringify({ e2e: { disabled: 'operator accepts manual verification' } }, null, 2)}\n`,
      'utf8',
    );
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, true);
    assert.equal(result.e2eDisabled, 'operator accepts manual verification');

    // BLOCKED evidence still blocks — the off switch only drops the run demand.
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), 'BLOCKED: cannot verify\n', 'utf8');
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /BLOCKED/);
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

test('runIntegrityChecks: a prose mention of BLOCKED mid-line is not a block marker (F89)', () => {
  const cwd = tmp('forge-int-blocked-prose-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeSpineWithRows(sessionDir);
    writeE2eDoc(sessionDir, { notApplicable: null, steps: [greenStep()] });
    writeE2eResults(sessionDir, runE2eSteps({ steps: [greenStep()] }));
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\nThe review subagent reported BLOCKED in its status summary, then retried green.\n',
      'utf8',
    );
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'wire-worker-jobs', openspecChange: null },
    });
    assert.equal(result.ok, true, result.problems.join('\n'));
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

/* ------------------------------------------------------------------ */
/* Guarded-files integrity backstop (task 4.1)                         */
/* ------------------------------------------------------------------ */

test('runIntegrityChecks: guardedFiles — clean session with no changes passes', () => {
  const cwd = gitRepo('forge-guard-clean-');
  try {
    fs.writeFileSync(path.join(cwd, 'a.test.mjs'), 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);
    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — modified baseline test refuses, names the file and the escape', () => {
  const cwd = gitRepo('forge-guard-mod-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.writeFileSync(testFile, 'one-modified\n', 'utf8'); // unstaged tamper

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
    assert.match(result.problems.join('\n'), /forge test-allow a\.test\.mjs --reason/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — deleted baseline test refuses (the failure mode this exists for)', () => {
  const cwd = gitRepo('forge-guard-del-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.rmSync(testFile); // unstaged delete — the test never fires again

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — staged-only modification is caught (the git invocation sees the index)', () => {
  const cwd = gitRepo('forge-guard-staged-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.writeFileSync(testFile, 'staged-tamper\n', 'utf8');
    spawnSync('git', ['add', testFile], { cwd }); // staged, not committed

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — allowance clears both the modify and the delete case', () => {
  for (const mutate of [
    (f) => fs.writeFileSync(f, 'modified\n', 'utf8'),
    (f) => fs.rmSync(f),
  ]) {
    const cwd = gitRepo('forge-guard-allow-');
    try {
      const testFile = path.join(cwd, 'a.test.mjs');
      fs.writeFileSync(testFile, 'one\n', 'utf8');
      gitCommitAll(cwd, 'base');
      const baseCommit = gitHead(cwd);

      mutate(testFile);

      const sessionDir = makeSessionDir(cwd);
      writeNaSpine(sessionDir);
      addAllowance(sessionDir, { path: 'a.test.mjs', reason: 'intentional fixture update' });
      const result = runIntegrityChecks({
        cwd,
        sessionDir,
        session: { slug: 'x', openspecChange: null, baseCommit },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.problems, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('runIntegrityChecks: guardedFiles — a test file created and staged this session passes (untracked at baseCommit)', () => {
  const cwd = gitRepo('forge-guard-new-');
  try {
    fs.writeFileSync(path.join(cwd, 'existing.txt'), 'x\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const newTestFile = path.join(cwd, 'new.test.mjs');
    fs.writeFileSync(newTestFile, 'brand new during this session\n', 'utf8');
    spawnSync('git', ['add', newTestFile], { cwd }); // staged addition, not tracked at baseCommit

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — integrity artifact (spine.json) modified without allowance refuses', () => {
  const cwd = gitRepo('forge-guard-artifact-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir, 'sync only — original');
    gitCommitAll(cwd, 'base'); // spine.json itself is tracked at baseCommit
    const baseCommit = gitHead(cwd);

    // Direct tamper of the evidence artifact — never legitimate, per guard.mjs.
    writeNaSpine(sessionDir, 'sync only — tampered directly');

    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /spine\.json/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — archiving a pre-baseCommit change is a move, not a tamper (F130)', () => {
  // The change dir was committed before the session started, so archiving it
  // reports `D openspec/changes/<change>/spine.json` against baseCommit — and
  // spine.json is a guarded integrity artifact regardless of age. The 0.3.40
  // archive gate made archive-before-done the normal path, so this refusal
  // fired on every compliant run. A byte-identical copy at the archived path
  // makes the deletion a move.
  const cwd = gitRepo('forge-guard-archive-');
  try {
    const liveDir = path.join(cwd, 'openspec', 'changes', 'add-customer-registry');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(
      path.join(liveDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(liveDir, 'proposal.md'), '# Why\n\nBecause.\n', 'utf8');
    gitCommitAll(cwd, 'base'); // the change predates the session
    const baseCommit = gitHead(cwd);

    const sessionDir = makeSessionDir(cwd);
    const session = {
      slug: 'x',
      planType: 'openspec',
      openspecChange: 'add-customer-registry',
      baseCommit,
    };

    // `forge change archive` / `openspec archive`: a plain rename of the dir.
    const archived = path.join(cwd, 'openspec', 'changes', 'archive', '2026-08-12-add-customer-registry');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(liveDir, archived);

    const result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — editing spine.json and THEN archiving is still a tamper (F130)', () => {
  // The exemption compares the archived copy against baseCommit, so a modify
  // laundered through the archive move must still refuse.
  const cwd = gitRepo('forge-guard-archive-tamper-');
  try {
    const liveDir = path.join(cwd, 'openspec', 'changes', 'add-customer-registry');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(
      path.join(liveDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const sessionDir = makeSessionDir(cwd);
    const session = {
      slug: 'x',
      planType: 'openspec',
      openspecChange: 'add-customer-registry',
      baseCommit,
    };

    // Tamper first, archive second.
    fs.writeFileSync(
      path.join(liveDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only — weakened' }, null, 2)}\n`,
      'utf8',
    );
    const archived = path.join(cwd, 'openspec', 'changes', 'archive', '2026-08-12-add-customer-registry');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(liveDir, archived);

    const result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /guarded file deleted without allowance/);
    assert.match(result.problems.join('\n'), /spine\.json/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — C1: a tracked .forge/config.json rewritten to guard.testGlobs: [] is itself caught by the backstop', () => {
  const cwd = gitRepo('forge-guard-config-');
  try {
    const configFile = path.join(cwd, '.forge', 'config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify({ guard: { testGlobs: ['**/*.test.*'] } }, null, 2)}\n`, 'utf8');
    gitCommitAll(cwd, 'base'); // config.json tracked, like a real project's
    const baseCommit = gitHead(cwd);

    // The C1 tamper itself: try to turn the guard off project-wide.
    fs.writeFileSync(configFile, `${JSON.stringify({ guard: { testGlobs: [] } }, null, 2)}\n`, 'utf8');

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /\.forge\/config\.json/);
    assert.match(result.problems.join('\n'), /forge-control:config\.json/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — C2 acknowledged scope gap: a tampered session.json is invisible to the git-diff backstop (never tracked)', () => {
  // Documents the same SCOPE NOTE class of limitation `checkGuardedFiles`
  // already states for session-dir integrity artifacts: `.forge/sessions/`
  // is gitignored in real projects and this fixture's session.json is never
  // git-added either way, so a rewrite is invisible to `git diff` regardless
  // of what it deletes (baseCommit, features.tddEvidence, …). The hook
  // (guard-cli.mjs, C2 fix) is the real defense against this tamper; this
  // test exists so a future change to the backstop's scope does not
  // silently start relying on git-diff coverage that was never there.
  const cwd = gitRepo('forge-guard-sessionjson-scope-');
  try {
    fs.writeFileSync(path.join(cwd, 'a.test.mjs'), 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'session.json'), '{}\n', 'utf8'); // the C2 tamper itself

    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(
      result.problems.some((p) => p.includes('session.json')),
      false,
      'this fixture is the documented gap, not a regression: session.json was never tracked, so git diff cannot see it',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — missing baseCommit skips with a warning, not a false pass/fail on the rest', () => {
  const cwd = gitRepo('forge-guard-nobase-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    // Note: no baseCommit recorded on the session below, even though the file
    // is tampered — this must degrade to a skip, not a false pass or fail.
    fs.writeFileSync(testFile, 'tampered-but-unmeasurable\n', 'utf8');

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const { result, stderr } = captureStderr(() =>
      runIntegrityChecks({
        cwd,
        sessionDir,
        session: { slug: 'x', openspecChange: null },
      }),
    );
    assert.equal(result.ok, true, 'no baseCommit means the check must skip, not refuse');
    assert.match(stderr, /baseCommit/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — a bad baseCommit (git failure) skips with a warning, not a hard fail', () => {
  const cwd = gitRepo('forge-guard-badbase-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    fs.writeFileSync(testFile, 'tampered\n', 'utf8');

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const { result, stderr } = captureStderr(() =>
      runIntegrityChecks({
        cwd,
        sessionDir,
        session: {
          slug: 'x',
          openspecChange: null,
          baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
      }),
    );
    assert.equal(result.ok, true, 'an unmeasurable baseline must skip, not fail');
    assert.match(stderr, /guarded-files|git diff/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — non-ASCII guarded filename is caught (NUL-split path)', () => {
  const cwd = gitRepo('forge-guard-nonascii-');
  try {
    const testFile = path.join(cwd, 'café.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.rmSync(testFile);

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /café\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks wiring: forge phase done refuses through set-phase.mjs when a guarded test is tampered', () => {
  const cwd = gitRepo('forge-guard-wire-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');

    const sessionId = 'sess-wire';
    const sessionDir = path.join(cwd, '.forge', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeNaSpine(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      `${JSON.stringify(
        {
          id: sessionId,
          slug: 'wire-fixture',
          createdAt: now,
          updatedAt: now,
          phase: 'verify',
          planType: null,
          openspecChange: null,
          forgeSkipped: false,
          cursorChatId: null,
          tasksTotal: 0,
          tasksComplete: 0,
          baseCommit,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.forge', 'active.json'),
      `${JSON.stringify({ sessionId }, null, 2)}\n`,
      'utf8',
    );

    // Tamper the guarded baseline test after the session's baseline commit —
    // exactly the failure mode the backstop exists for, exercised through the
    // real production caller: `forge phase done` (set-phase.mjs's enforceDoneGate).
    fs.writeFileSync(testFile, 'tampered\n', 'utf8');

    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');
    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const result = spawnSync(process.execPath, [scriptPath, 'done'], {
      cwd,
      encoding: 'utf8',
      env: base,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a\.test\.mjs/);

    const after = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(after.phase, 'verify', 'the tampered session must not reach done');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Review round 2 fixes: subdirectory cwd, rename/typechange escapes,   */
/* corrupt ledger (findings Critical 1-3, Important 4)                  */
/* ------------------------------------------------------------------ */

test('runIntegrityChecks: guardedFiles — cwd inside a subdirectory still catches a tampered baseline test', () => {
  // git diff --name-status always reports repo-root-relative paths, but
  // makeGitLsTree's `git ls-tree` reports paths relative to whatever cwd it
  // is given. Running the two from different directories makes every lookup
  // miss silently. Production callers (set-phase.mjs, integrity-check.mjs)
  // never pass an explicit cwd, so this is exactly `cd packages/cli && forge
  // phase done`.
  const cwd = gitRepo('forge-guard-subdir-');
  try {
    const subDir = path.join(cwd, 'packages', 'cli');
    fs.mkdirSync(subDir, { recursive: true });
    const testFile = path.join(subDir, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.writeFileSync(testFile, 'tampered\n', 'utf8');

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd: subDir,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false, 'a subdirectory cwd must not silently disable the backstop');
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks wiring: forge phase done from a subdirectory still refuses a tampered baseline test', () => {
  const cwd = gitRepo('forge-guard-wire-subdir-');
  try {
    const subDir = path.join(cwd, 'packages', 'cli');
    fs.mkdirSync(subDir, { recursive: true });
    const testFile = path.join(subDir, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');

    const sessionId = 'sess-wire-subdir';
    const sessionDir = path.join(cwd, '.forge', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeNaSpine(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      `${JSON.stringify(
        {
          id: sessionId,
          slug: 'wire-fixture-subdir',
          createdAt: now,
          updatedAt: now,
          phase: 'verify',
          planType: null,
          openspecChange: null,
          forgeSkipped: false,
          cursorChatId: null,
          tasksTotal: 0,
          tasksComplete: 0,
          baseCommit,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(cwd, '.forge', 'active.json'),
      `${JSON.stringify({ sessionId }, null, 2)}\n`,
      'utf8',
    );

    // Tamper after baseline. `.forge` lives at `cwd`, so findRepoRoot still
    // resolves REPO_ROOT correctly by walking up from subDir — the bug is
    // purely in the internal git cwd used for the guarded-files diff/ls-tree,
    // which defaults to process.cwd() (subDir here), not REPO_ROOT.
    fs.writeFileSync(testFile, 'tampered\n', 'utf8');

    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');
    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const result = spawnSync(process.execPath, [scriptPath, 'done'], {
      cwd: subDir,
      encoding: 'utf8',
      env: base,
    });

    assert.equal(result.status, 1, 'a subdirectory invocation must still refuse the tamper');
    assert.match(result.stderr, /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — git mv out of the test glob is caught (a bare rename escapes --diff-filter=MD)', () => {
  const cwd = gitRepo('forge-guard-rename-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const mv = spawnSync('git', ['mv', 'a.test.mjs', 'a.disabled.mjs'], { cwd });
    assert.equal(mv.status, 0);

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false, 'renaming a guarded test out of its glob must not clear it silently');
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — rename-with-weakening (high-similarity git mv) is caught', () => {
  const cwd = gitRepo('forge-guard-rename-weaken-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const mv = spawnSync('git', ['mv', 'a.test.mjs', 'b.test.mjs'], { cwd });
    assert.equal(mv.status, 0);
    // Weaken the test (drop an assertion line) while keeping similarity high
    // enough that git's default rename detection would still call this R.
    fs.writeFileSync(path.join(cwd, 'b.test.mjs'), 'line1\nline2\nline3\nline4\n', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd });

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(
      result.ok,
      false,
      "git's rename heuristic must not hide a weakened, renamed guarded test",
    );
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — typechange (file replaced by a symlink) is caught', () => {
  const cwd = gitRepo('forge-guard-typechange-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.rmSync(testFile);
    fs.symlinkSync('/dev/null', testFile);
    spawnSync('git', ['add', '-A'], { cwd });

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false, 'a typechange to symlink must not silently satisfy the guard');
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — a well-formed ledger that does not cover the tamper still refuses', () => {
  const cwd = gitRepo('forge-guard-ledger-healthy-');
  try {
    const testFile = path.join(cwd, 'a.test.mjs');
    fs.writeFileSync(testFile, 'one\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'b.test.mjs'), 'two\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    fs.writeFileSync(testFile, 'tampered\n', 'utf8');

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    addAllowance(sessionDir, { path: 'b.test.mjs', reason: 'unrelated allowance' });

    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /a\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: guardedFiles — a corrupt allowance ledger is itself an integrity problem, not a silent skip', () => {
  const cwd = gitRepo('forge-guard-ledger-corrupt-');
  try {
    fs.writeFileSync(path.join(cwd, 'a.test.mjs'), 'one\n', 'utf8');
    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);
    // No guarded changes at all in the worktree — the corrupt ledger alone
    // must still fail the check; it is a measurable, attributable fault
    // (an agent-writable, unguarded file), not an unmeasurable baseline.

    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'guard-allowances.json'), '{not valid json', 'utf8');

    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'x', openspecChange: null, baseCommit },
    });
    assert.equal(result.ok, false, 'a corrupt ledger must fail closed, not skip silently');
    assert.match(result.problems.join('\n'), /guard-allowances\.json/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Red-before-green pairing gate (task 5.2, design D6)                  */
/*                                                                      */
/* "Completed task dir" mapping: `tasks.md` (ADR-0002 /                 */
/* plan-progress.mjs) is read only for aggregate checkbox COUNTS — there */
/* is no code-enforced, stable mapping from a `- [ ] N.M` id to a        */
/* specific `tasks/<nn-slug>/` directory name (this very session proves  */
/* it: task 5.2's tasks.md id maps to directory `07-pairing-gate`, not   */
/* `05-2` or any derivable transform). Per the brief's own fallback,     */
/* "completed" is instead read off directory evidence — presence of      */
/* `test-evidence.md`, mirroring score.mjs's own listTaskEvidence         */
/* precedent for "this task has completion evidence" — never off         */
/* tasks.md at all, so an unreadable/missing tasks.md has nothing to      */
/* skip here (see report for the deviation from the brief's literal test  */
/* -guidance line).                                                       */
/* ------------------------------------------------------------------ */

/** Marks a task dir "completed" per checkTddEvidence's chosen signal. */
function markTaskComplete(sessionDir, task) {
  const dir = path.join(sessionDir, 'tasks', task);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test-evidence.md'), '# evidence\n', 'utf8');
  return dir;
}

/** @param {Record<string, unknown>[]} stamps */
function writeStamps(sessionDir, task, stamps) {
  const dir = path.join(sessionDir, 'tasks', task);
  fs.mkdirSync(dir, { recursive: true });
  const body = stamps.map((s) => JSON.stringify(s)).join('\n') + (stamps.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'tdd-runs.jsonl'), body, 'utf8');
}

function redStamp(overrides = {}) {
  return {
    cmd: 'node',
    args: ['--test', 'x.test.mjs'],
    expect: 'fail',
    exit: 1,
    ok: true,
    startedAt: '2026-08-08T00:00:00.000Z',
    durationMs: 10,
    ...overrides,
  };
}

function greenStamp(overrides = {}) {
  return {
    cmd: 'node',
    args: ['--test', 'x.test.mjs'],
    expect: 'pass',
    exit: 0,
    ok: true,
    startedAt: '2026-08-08T00:05:00.000Z',
    durationMs: 10,
    ...overrides,
  };
}

function flaggedSession(overrides = {}) {
  return { slug: 'x', openspecChange: null, features: { tddEvidence: true }, ...overrides };
}

/**
 * Declares a task exempt via the real `forge evidence --no-tdd --reason`
 * runtime path (record-evidence.mjs) — not a hand-planted marker string —
 * against a session `checkTddEvidence` will read (`.forge/sessions/<id>`
 * under `cwd`, matching `makeSessionDir(cwd)`).
 */
function declareNoTdd(cwd, sessionId, task, reason, extra = {}) {
  fs.writeFileSync(
    path.join(cwd, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    'utf8',
  );
  const result = runRecordEvidence(
    {
      task,
      command: null,
      exit: null,
      summary: null,
      tier: null,
      session: sessionId,
      allowFail: false,
      forgeDir: null,
      noTdd: true,
      reason,
      help: false,
      ...extra,
    },
    cwd,
  );
  if (result.exitCode !== 0) throw new Error(`declareNoTdd failed: ${result.message}`);
}

/** Records plain (non-declaring) evidence via the real `forge evidence` path. */
function recordPlainEvidence(cwd, sessionId, task, opts = {}) {
  fs.writeFileSync(
    path.join(cwd, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    'utf8',
  );
  const result = runRecordEvidence(
    {
      task,
      command: 'echo ok',
      exit: '0',
      summary: 'docs only',
      tier: null,
      session: sessionId,
      allowFail: false,
      forgeDir: null,
      noTdd: false,
      reason: null,
      help: false,
      ...opts,
    },
    cwd,
  );
  if (result.exitCode !== 0) throw new Error(`recordPlainEvidence failed: ${result.message}`);
}

test('checkTddEvidence: unflagged session skips entirely, even with a pass-only ledger', () => {
  const cwd = tmp('forge-tdd-unflagged-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [greenStamp()]);
    const result = checkTddEvidence({
      sessionDir,
      session: { slug: 'x', openspecChange: null },
    });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: flagged session, valid red-before-green pair passes', () => {
  const cwd = tmp('forge-tdd-valid-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [redStamp(), greenStamp()]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: pass-only ledger refuses and names the task', () => {
  const cwd = tmp('forge-tdd-passonly-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [greenStamp()]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: reversed order (pass before fail) refuses', () => {
  const cwd = tmp('forge-tdd-reversed-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [
      greenStamp({ startedAt: '2026-08-08T00:00:00.000Z' }),
      redStamp({ startedAt: '2026-08-08T00:05:00.000Z' }),
    ]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: ok:false red stamp does not satisfy the red requirement', () => {
  const cwd = tmp('forge-tdd-okfalse-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    // A contradicted --expect fail run (command unexpectedly passed): ok:false.
    writeStamps(sessionDir, '01-thing', [redStamp({ ok: false, exit: 0 }), greenStamp()]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: exit:null red stamp (signal-killed / spawn-failure ambiguity) does not satisfy the red requirement', () => {
  const cwd = tmp('forge-tdd-exitnull-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [redStamp({ ok: true, exit: null }), greenStamp()]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/*
 * Final-review I2: reviewer reproduced `forge tdd run --expect fail -- false`
 * then `forge tdd run --expect pass -- true` satisfying the gate, though
 * `false` and `true` are unrelated commands — no forgery was involved, just
 * two genuine, unrelated CLI-authored stamps. The gate must require the
 * qualifying red and green stamps to name the SAME command (`cmd` + `args`),
 * not merely any red anywhere before any green anywhere in the task dir.
 */
test('checkTddEvidence: I2 reproduction — a red for one command and a green for an unrelated command does not satisfy pairing', () => {
  const cwd = tmp('forge-tdd-cmdmismatch-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [
      redStamp({ cmd: 'false', args: [] }),
      greenStamp({ cmd: 'true', args: [] }),
    ]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a matching red-before-green pair for the same command still passes when an unrelated mismatched pair is also present', () => {
  const cwd = tmp('forge-tdd-cmdmatch-plus-noise-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [
      // Unrelated, mismatched noise: must not be enough on its own, and must
      // not prevent the genuine pair below from clearing the gate either.
      redStamp({ cmd: 'false', args: [] }),
      greenStamp({ cmd: 'true', args: [] }),
      // The genuine pair, same cmd+args, red before green.
      redStamp({ cmd: 'node', args: ['--test', 'a.test.mjs'], startedAt: '2026-08-08T00:10:00.000Z' }),
      greenStamp({ cmd: 'node', args: ['--test', 'a.test.mjs'], startedAt: '2026-08-08T00:15:00.000Z' }),
    ]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: pairing-failure message names the mismatched commands found (actionable, not generic)', () => {
  const cwd = tmp('forge-tdd-cmdmismatch-msg-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [
      redStamp({ cmd: 'false', args: [] }),
      greenStamp({ cmd: 'true', args: [] }),
    ]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /false/);
    assert.match(result.problems[0], /true/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: incomplete task (no test-evidence.md) is not required to carry any stamps', () => {
  const cwd = tmp('forge-tdd-incomplete-');
  try {
    const sessionDir = makeSessionDir(cwd);
    // Task dir exists (brief.md only — implementer still working) but has no
    // test-evidence.md and no tdd-runs.jsonl either, so it is not "completed"
    // and must not be gated.
    fs.mkdirSync(path.join(sessionDir, 'tasks', '02-inflight'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'tasks', '02-inflight', 'brief.md'), '# brief\n', 'utf8');
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/*
 * Review round 2, item 1 (Important): a task dir that has `tdd-runs.jsonl`
 * but no `test-evidence.md` was previously invisible to `completedTddTaskDirs`
 * — an implementer who ran `forge tdd run` and recorded a pass-only ledger
 * (never a red one) got a free pass on the pairing gate simply by skipping
 * `forge evidence`, whose only other cost is a soft scorer deduction. The
 * completeness signal must be "this task dir has *any* evidence of work
 * done" (test-evidence.md OR tdd-runs.jsonl), not test-evidence.md alone.
 */

test('checkTddEvidence: a task dir with only a pass-only tdd-runs.jsonl (no test-evidence.md) now refuses — closes the opt-out-by-omission', () => {
  const cwd = tmp('forge-tdd-proxy-passonly-');
  try {
    const sessionDir = makeSessionDir(cwd);
    // No test-evidence.md anywhere — only tdd-runs.jsonl exists.
    writeStamps(sessionDir, '04-no-evidence-md', [greenStamp()]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /04-no-evidence-md/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a task dir with a valid red-before-green pair and no test-evidence.md still passes', () => {
  const cwd = tmp('forge-tdd-proxy-validpair-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeStamps(sessionDir, '05-no-evidence-md', [redStamp(), greenStamp()]);
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: missing tdd-runs.jsonl entirely for a completed task refuses', () => {
  // Note: the tmp() prefix deliberately avoids the word "missing" — an
  // earlier draft used a prefix containing it, which leaked into the ENOENT
  // path string inside the *sibling* "unreadable" branch's message and made
  // the pin below pass for the wrong reason when that branch was neutralized
  // (mutation-tested — see report).
  const cwd = tmp('forge-tdd-nostamps-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '03-nostamps');
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /03-nostamps/);
    // Pins the *missing* branch specifically (review round 2, item 3): without
    // this, neutralizing the `!fs.existsSync` check leaves all tests green
    // because the fallback (attempting to read a nonexistent file) also
    // produces one problem — just a differently worded one (unreadable, not
    // missing) — so the tailored "run forge tdd run" message was untested.
    // Matched as one word-boundaried phrase, not a bare /missing/ substring,
    // so this can never accidentally match a path fragment instead.
    assert.match(result.problems[0], /tdd-runs\.jsonl missing\b/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: an unreadable tdd-runs.jsonl (e.g. a directory at that path) is named, not silently read as an empty ledger', () => {
  const cwd = tmp('forge-tdd-unreadable-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    const dir = path.join(sessionDir, 'tasks', '01-thing');
    // A directory where a file is expected — readFileSync throws EISDIR.
    // Before the fix this was swallowed into an empty stamp list, producing
    // the generic "lacks a fail-stamp before a pass-stamp" message — true,
    // but pointing the operator at the wrong problem entirely.
    fs.mkdirSync(path.join(dir, 'tdd-runs.jsonl'));
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
    assert.match(result.problems[0], /tdd-runs\.jsonl/);
    assert.match(result.problems[0], /unreadable/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: equal startedAt timestamps fall back to file order', () => {
  const cwd = tmp('forge-tdd-tiebreak-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    const t = '2026-08-08T00:00:00.000Z';
    // Same instant, red written first in the file — must still count as valid.
    writeStamps(sessionDir, '01-thing', [redStamp({ startedAt: t }), greenStamp({ startedAt: t })]);
    let result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);

    // Same instant, but green written first in the file — the tie-break must
    // now report the file order as pass-before-fail.
    writeStamps(sessionDir, '01-thing', [greenStamp({ startedAt: t }), redStamp({ startedAt: t })]);
    result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: malformed lines are skipped and counted in a stderr warning', () => {
  const cwd = tmp('forge-tdd-malformed-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    const dir = path.join(sessionDir, 'tasks', '01-thing');
    fs.mkdirSync(dir, { recursive: true });
    const body =
      `${JSON.stringify(redStamp())}\n` +
      'not valid json at all\n' +
      `${JSON.stringify(greenStamp())}\n`;
    fs.writeFileSync(path.join(dir, 'tdd-runs.jsonl'), body, 'utf8');

    const { result, stderr } = captureStderr(() =>
      checkTddEvidence({ sessionDir, session: flaggedSession() }),
    );
    assert.deepEqual(result.problems, []);
    assert.match(stderr, /1 malformed/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a malformed line that would be the only red evidence fails closed (not a silent pass)', () => {
  const cwd = tmp('forge-tdd-malformed-failclosed-');
  try {
    const sessionDir = makeSessionDir(cwd);
    markTaskComplete(sessionDir, '01-thing');
    const dir = path.join(sessionDir, 'tasks', '01-thing');
    fs.mkdirSync(dir, { recursive: true });
    // The only "red" line is malformed (missing closing brace) — must not be
    // silently treated as satisfying the requirement.
    const body =
      '{"cmd":"node","expect":"fail","ok":true,"exit":1,"startedAt":"2026-08-08T00:00:00.000Z"\n' +
      `${JSON.stringify(greenStamp())}\n`;
    fs.writeFileSync(path.join(dir, 'tdd-runs.jsonl'), body, 'utf8');

    const { result } = captureStderr(() => checkTddEvidence({ sessionDir, session: flaggedSession() }));
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/*
 * --no-tdd declaration (Gap A): a task with no applicable test cycle
 * (docs/config-only) has no red→green pair to record. `forge evidence
 * --no-tdd --reason "<text>"` marks the task dir exempt; `checkTddEvidence`
 * must honor it. Evidence recorded WITHOUT the declaration must stay gated —
 * this is exactly the reviewer's reproduction (`forge evidence --task
 * 01-docs --command "echo ok" --exit 0 --summary "docs only"` then
 * `forge integrity-check` failing with "tdd-runs.jsonl missing", with no
 * escape).
 */

test('checkTddEvidence: Gap A reproduction — plain evidence (no --no-tdd) for a docs-only task still deadlocks the gate', () => {
  const cwd = tmp('forge-tdd-gapa-');
  try {
    const sessionDir = makeSessionDir(cwd);
    recordPlainEvidence(cwd, 's1', '01-docs');
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-docs/);
    assert.match(result.problems[0], /tdd-runs\.jsonl missing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a --no-tdd declaration (forge evidence --no-tdd --reason) clears the gate', () => {
  const cwd = tmp('forge-tdd-notdd-declared-');
  try {
    const sessionDir = makeSessionDir(cwd);
    declareNoTdd(cwd, 's1', '01-docs', 'documentation only, no behavior change');
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: the recorded reason is readable in the task evidence file', () => {
  const cwd = tmp('forge-tdd-notdd-reason-visible-');
  try {
    const sessionDir = makeSessionDir(cwd);
    declareNoTdd(cwd, 's1', '01-docs', 'documentation only, no behavior change');
    const content = fs.readFileSync(
      path.join(sessionDir, 'tasks', '01-docs', 'test-evidence.md'),
      'utf8',
    );
    assert.match(content, /documentation only, no behavior change/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a --no-tdd declaration combined with --command details still clears the gate', () => {
  const cwd = tmp('forge-tdd-notdd-combo-');
  try {
    const sessionDir = makeSessionDir(cwd);
    declareNoTdd(cwd, 's1', '01-docs-lint', 'docs only; ran lint as a sanity check', {
      command: 'npm run lint:docs',
      exit: '0',
      summary: 'lint clean',
    });
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: an unreadable test-evidence.md (e.g. a directory at that path) is never read as a --no-tdd declaration', () => {
  const cwd = tmp('forge-tdd-evidence-unreadable-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = path.join(sessionDir, 'tasks', '01-thing');
    // A directory sitting where the file is expected — reading it throws
    // EISDIR. Must fail closed (not exempt), same discipline as the sibling
    // unreadable-tdd-runs.jsonl check.
    fs.mkdirSync(path.join(dir, 'test-evidence.md'), { recursive: true });
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
    assert.match(result.problems[0], /tdd-runs\.jsonl missing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: prose that merely mentions "no tdd" without the exact marker is not a declaration', () => {
  const cwd = tmp('forge-tdd-prose-not-marker-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '01-thing');
    fs.writeFileSync(
      path.join(dir, 'test-evidence.md'),
      '# Test evidence\n\nNo TDD applicable here, this is docs only.\n',
      'utf8',
    );
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/*
 * Reviewer's Critical rejection of the first cut of task 5.3: the marker was
 * matched as a bare substring anywhere in the file, and `runRecordEvidence`
 * never checked caller-supplied text for it. A `--summary` quoting the exact
 * token — the kind of thing an implementer describing this very feature would
 * write — cleared the pairing gate with no --no-tdd, no --reason, and no
 * stamps (F1a: write-side). Separately, a marker appended by hand (or any
 * writer other than the CLI) with no accompanying reason line also read as a
 * declaration (F1b: read-side) — the spec's "no declaration ⇒ still gated"
 * promise was enforced nowhere. Both closed: `runRecordEvidence` refuses
 * caller text quoting the marker (record-evidence.test.mjs), and
 * `hasNoTddDeclaration` here now requires the marker as its own whole line
 * *and* a non-empty `- **No-TDD reason:**` line — so text embedding the
 * token inside a labelled line (`- **Summary:** … <marker>`) can never match,
 * and a bare marker with no reason line never exempts either.
 */

test('checkTddEvidence: a marker embedded inside a --summary line (not its own line) is not a declaration — reviewer repro, read side', () => {
  const cwd = tmp('forge-tdd-f1a-readside-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '02-sneak');
    // Simulates what the pre-fix write path would have produced: the marker
    // sits mid-line inside the Summary field, never on a line by itself.
    fs.writeFileSync(
      path.join(dir, 'test-evidence.md'),
      [
        '# Test evidence — Task 02-sneak',
        '',
        '- **Tier:** 2',
        '- **Command:** `npm test`',
        '- **Exit code:** 0',
        `- **Summary:** green — see notes on ${NO_TDD_MARKER}`,
        '- **Run at:** 2026-08-08T00:00:00.000Z',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /02-sneak/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a bare marker line with no reason line is not a declaration (F1b)', () => {
  const cwd = tmp('forge-tdd-f1b-bare-marker-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '01-thing');
    // Simulates the marker being appended by something other than the CLI
    // (e.g. a hand/Bash edit) with no reason line at all.
    fs.appendFileSync(path.join(dir, 'test-evidence.md'), `${NO_TDD_MARKER}\n`, 'utf8');
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a file whose entire content is the bare marker is not a declaration (F1b)', () => {
  const cwd = tmp('forge-tdd-f1b-marker-only-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = path.join(sessionDir, 'tasks', '03-marker-only');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-evidence.md'), `${NO_TDD_MARKER}\n`, 'utf8');
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /03-marker-only/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a marker line with an empty reason line is not a declaration', () => {
  const cwd = tmp('forge-tdd-f1b-empty-reason-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '01-thing');
    fs.writeFileSync(
      path.join(dir, 'test-evidence.md'),
      ['# Test evidence', '', NO_TDD_MARKER, '- **No-TDD reason:**   ', ''].join('\n'),
      'utf8',
    );
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkTddEvidence: a marker on its own line with a genuine reason line still clears the gate (legitimate shape, read side)', () => {
  const cwd = tmp('forge-tdd-f1b-legit-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '01-thing');
    fs.writeFileSync(
      path.join(dir, 'test-evidence.md'),
      ['# Test evidence', '', NO_TDD_MARKER, '- **No-TDD reason:** documentation only', ''].join('\n'),
      'utf8',
    );
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.deepEqual(result.problems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

/*
 * I3 (final review): a 24-mutation battery on `hasNoTddDeclaration` caught 21
 * of 22 applicable mutants, with two survivors — both mean the marker
 * requirement is unpinned, i.e. the two tests above ("embedded inside a
 * --summary line" and "bare marker with no reason line") each toggle only
 * ONE of the two required conditions at a time, so a mutant that breaks just
 * the OTHER condition slips through:
 *
 *  - `line === NO_TDD_MARKER` → `line.includes(NO_TDD_MARKER)`: every
 *    existing "embedded, not its own line" fixture also has no reason line,
 *    so the reason-line check alone already fails the mutant closed — the
 *    substring-vs-exact distinction itself was never exercised.
 *  - `if (!hasMarkerLine) return false` → `if (false)` (dropping the marker
 *    requirement entirely): every existing "no marker" fixture also has no
 *    reason line, so again the reason-line check alone masks the mutant.
 *
 * Each test below holds the OTHER condition satisfied so only the mutated
 * one can flip the outcome, and was confirmed to fail on its named mutation
 * before this fix (see report).
 */

test('I3: a marker embedded mid-line (not its own line) is not a declaration even with a well-formed reason line — pins `===`, not `.includes`', () => {
  const cwd = tmp('forge-tdd-i3-includes-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '02-sneak');
    fs.writeFileSync(
      path.join(dir, 'test-evidence.md'),
      [
        '# Test evidence — Task 02-sneak',
        '',
        `- **Summary:** green — see notes on ${NO_TDD_MARKER}`,
        `${NO_TDD_REASON_LABEL} documentation only`,
        '',
      ].join('\n'),
      'utf8',
    );
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1, 'a mid-line marker must not exempt the task even with a real reason line');
    assert.match(result.problems[0], /02-sneak/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('I3: a well-formed reason line with no marker anywhere is not a declaration — pins the marker as required, not optional', () => {
  const cwd = tmp('forge-tdd-i3-no-marker-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const dir = markTaskComplete(sessionDir, '01-thing');
    fs.writeFileSync(
      path.join(dir, 'test-evidence.md'),
      ['# Test evidence', '', `${NO_TDD_REASON_LABEL} documentation only`, ''].join('\n'),
      'utf8',
    );
    const result = checkTddEvidence({ sessionDir, session: flaggedSession() });
    assert.equal(result.problems.length, 1, 'a reason line alone (no marker) must never exempt the task');
    assert.match(result.problems[0], /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: a --no-tdd declared task passes the aggregate gate alongside spine', () => {
  const cwd = tmp('forge-tdd-notdd-wired-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    declareNoTdd(cwd, 's1', '01-docs', 'documentation only, no behavior change');
    const result = runIntegrityChecks({ cwd, sessionDir, session: flaggedSession() });
    assert.equal(result.ok, true, result.problems.join('\n'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: tdd-evidence problems surface through the aggregate gate alongside spine', () => {
  const cwd = tmp('forge-tdd-wired-');
  try {
    const sessionDir = makeSessionDir(cwd);
    writeNaSpine(sessionDir);
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [greenStamp()]);
    const result = runIntegrityChecks({ cwd, sessionDir, session: flaggedSession() });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /01-thing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks wiring: forge phase done refuses through set-phase.mjs when a completed task lacks a red stamp', () => {
  const cwd = gitRepo('forge-tdd-wire-');
  try {
    const sessionId = 'sess-tdd-wire';
    const sessionDir = path.join(cwd, '.forge', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeNaSpine(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    markTaskComplete(sessionDir, '01-thing');
    writeStamps(sessionDir, '01-thing', [greenStamp()]); // green with no preceding red

    gitCommitAll(cwd, 'base');
    const baseCommit = gitHead(cwd);

    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      `${JSON.stringify(
        {
          id: sessionId,
          slug: 'wire-tdd-fixture',
          createdAt: now,
          updatedAt: now,
          phase: 'verify',
          planType: null,
          openspecChange: null,
          forgeSkipped: false,
          cursorChatId: null,
          tasksTotal: 0,
          tasksComplete: 0,
          baseCommit,
          features: { tddEvidence: true },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.forge', 'active.json'),
      `${JSON.stringify({ sessionId }, null, 2)}\n`,
      'utf8',
    );

    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');
    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const result = spawnSync(process.execPath, [scriptPath, 'done'], {
      cwd,
      encoding: 'utf8',
      env: base,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /01-thing/);

    const after = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(after.phase, 'verify', 'the ungated session must not reach done');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
