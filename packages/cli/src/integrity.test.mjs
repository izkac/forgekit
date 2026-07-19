import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  JOBS_SIGNAL_RE,
  addDeferral,
  initSpine,
  loadDeferrals,
  openDeferrals,
  resolveChangeDir,
  resolveDeferral,
  runIntegrityChecks,
  sessionJobsSignalText,
  spinePath,
  spineTemplate,
  validateSpine,
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

test('runIntegrityChecks: clean non-jobs session passes', () => {
  const cwd = tmp('forge-int-clean-');
  try {
    const sessionDir = makeSessionDir(cwd);
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

test('runIntegrityChecks: jobs signal without spine fails', () => {
  const cwd = tmp('forge-int-jobs-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const result = runIntegrityChecks({
      cwd,
      sessionDir,
      session: { slug: 'wire-worker-jobs', openspecChange: null },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /spine\.json required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runIntegrityChecks: spine rows demand product-loop evidence', () => {
  const cwd = tmp('forge-int-loop-');
  try {
    const sessionDir = makeSessionDir(cwd);
    const spineFile = path.join(sessionDir, 'spine.json');
    fs.writeFileSync(
      spineFile,
      `${JSON.stringify({ change: null, notApplicable: null, rows: [validRow()] }, null, 2)}\n`,
      'utf8',
    );
    const session = { slug: 'wire-worker-jobs', openspecChange: null };

    let result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /verify-evidence\.md missing/);

    const evidenceFile = path.join(sessionDir, 'verify-evidence.md');
    fs.writeFileSync(evidenceFile, '# Verify\n\ntier 3 green\n', 'utf8');
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /no "Product loop" section/);

    fs.writeFileSync(evidenceFile, '# Verify\n\n## Product loop\n\nBLOCKED: no compose here\n', 'utf8');
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /BLOCKED/);

    fs.writeFileSync(
      evidenceFile,
      '# Verify\n\n## Product loop\n\ningest x3 -> analyze -> ratify -> run@R: output differs from baseline\n',
      'utf8',
    );
    result = runIntegrityChecks({ cwd, sessionDir, session });
    assert.equal(result.ok, true);
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
