import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_TIER,
  buildEvidence,
  parseArgs,
  runRecordEvidence,
} from './record-evidence.mjs';

const FIXED_NOW = () => new Date('2026-06-05T15:04:22.000Z');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Scratch forge layout: `<dir>/.forge/active.json` pointing at `sessionId`,
 * plus the session dir itself.
 *
 * @param {string} dir
 * @param {string} sessionId
 * @returns {string} the forge root
 */
function makeForgeFixture(dir, sessionId) {
  const forgeDir = path.join(dir, '.forge');
  fs.mkdirSync(path.join(forgeDir, 'sessions', sessionId, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(forgeDir, 'active.json'),
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    'utf8',
  );
  return forgeDir;
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {ReturnType<typeof parseArgs>}
 */
function makeOpts(overrides = {}) {
  return {
    task: '03-record-evidence',
    command: 'node --test "*.test.mjs"',
    exit: '0',
    summary: '6/6 pass',
    tier: null,
    session: null,
    allowFail: false,
    forgeDir: null,
    help: false,
    ...overrides,
  };
}

function evidencePath(forgeDir, sessionId, task) {
  return path.join(forgeDir, 'sessions', sessionId, 'tasks', task, 'test-evidence.md');
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs parses all flags', () => {
  const opts = parseArgs([
    '--task', '01-foo',
    '--command', 'npm test',
    '--exit', '0',
    '--summary', 'all pass',
    '--tier', '2 (full workspace — contract/integration)',
    '--session', 'sess-1',
    '--allow-fail',
    '--forge-dir', 'custom-forge',
  ]);
  assert.equal(opts.task, '01-foo');
  assert.equal(opts.command, 'npm test');
  assert.equal(opts.exit, '0');
  assert.equal(opts.summary, 'all pass');
  assert.equal(opts.tier, '2 (full workspace — contract/integration)');
  assert.equal(opts.session, 'sess-1');
  assert.equal(opts.allowFail, true);
  assert.equal(opts.forgeDir, 'custom-forge');
});

test('parseArgs defaults and unknown-arg rejection', () => {
  const opts = parseArgs(['--task', '01-foo']);
  assert.equal(opts.tier, null);
  assert.equal(opts.session, null);
  assert.equal(opts.allowFail, false);
  assert.equal(opts.forgeDir, null);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

// ---------------------------------------------------------------------------
// runRecordEvidence
// ---------------------------------------------------------------------------

test('writes the canonical template into the active session task dir', () => {
  const dir = tmp('forge-evidence-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(makeOpts(), dir, FIXED_NOW);
    assert.equal(result.exitCode, 0, result.message);

    const file = evidencePath(forgeDir, 'sess-a', '03-record-evidence');
    assert.ok(fs.existsSync(file));
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      [
        '# Test evidence — Task 03-record-evidence',
        '',
        `- **Tier:** ${DEFAULT_TIER}`,
        '- **Command:** `node --test "*.test.mjs"`',
        '- **Exit code:** 0',
        '- **Summary:** 6/6 pass',
        '- **Run at:** 2026-06-05T15:04:22.000Z',
        '- **Recorded by:** implementer subagent (coordinator transcript)',
        '',
      ].join('\n'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default tier label is the tier-2 task-scoped label', () => {
  assert.equal(DEFAULT_TIER, '2 (task-scoped — not full workspace unless noted)');
  const md = buildEvidence({
    task: '01-foo',
    tier: DEFAULT_TIER,
    command: 'npm test',
    exit: 0,
    summary: 'ok',
    runAt: '2026-06-05T15:04:22.000Z',
  });
  assert.ok(md.includes('- **Tier:** 2 (task-scoped — not full workspace unless noted)'));
});

test('refuses non-zero exit without --allow-fail and writes nothing', () => {
  const dir = tmp('forge-evidence-fail-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(makeOpts({ exit: '1' }), dir, FIXED_NOW);
    assert.equal(result.exitCode, 1);
    assert.ok(/allow-fail/.test(result.message));
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--allow-fail writes evidence for a non-zero exit', () => {
  const dir = tmp('forge-evidence-allow-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(makeOpts({ exit: '1', allowFail: true }), dir, FIXED_NOW);
    assert.equal(result.exitCode, 0, result.message);
    const content = fs.readFileSync(
      evidencePath(forgeDir, 'sess-a', '03-record-evidence'),
      'utf8',
    );
    assert.ok(content.includes('- **Exit code:** 1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('errors when there is no active session and no --session', () => {
  const dir = tmp('forge-evidence-noactive-');
  try {
    fs.mkdirSync(path.join(dir, '.forge', 'sessions'), { recursive: true });
    const result = runRecordEvidence(makeOpts(), dir, FIXED_NOW);
    assert.equal(result.exitCode, 1);
    assert.ok(/active session/i.test(result.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('errors when the session dir is missing', () => {
  const dir = tmp('forge-evidence-nodir-');
  try {
    makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(makeOpts({ session: 'sess-missing' }), dir, FIXED_NOW);
    assert.equal(result.exitCode, 1);
    assert.ok(/sess-missing/.test(result.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--session overrides the active.json session', () => {
  const dir = tmp('forge-evidence-session-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-active');
    fs.mkdirSync(path.join(forgeDir, 'sessions', 'sess-b', 'tasks'), { recursive: true });
    const result = runRecordEvidence(makeOpts({ session: 'sess-b' }), dir, FIXED_NOW);
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(fs.existsSync(evidencePath(forgeDir, 'sess-b', '03-record-evidence')));
    assert.equal(
      fs.existsSync(evidencePath(forgeDir, 'sess-active', '03-record-evidence')),
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overwrites an existing test-evidence.md (latest run wins)', () => {
  const dir = tmp('forge-evidence-overwrite-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const file = evidencePath(forgeDir, 'sess-a', '03-record-evidence');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'stale earlier run\n', 'utf8');
    const result = runRecordEvidence(makeOpts(), dir, FIXED_NOW);
    assert.equal(result.exitCode, 0, result.message);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes('stale earlier run'));
    assert.ok(content.includes('- **Summary:** 6/6 pass'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing required args and non-integer exit are rejected', () => {
  const dir = tmp('forge-evidence-required-');
  try {
    makeForgeFixture(dir, 'sess-a');
    for (const field of ['task', 'command', 'exit', 'summary']) {
      const result = runRecordEvidence(makeOpts({ [field]: null }), dir, FIXED_NOW);
      assert.equal(result.exitCode, 1, `expected failure when --${field} is missing`);
      assert.ok(new RegExp(`--${field}`).test(result.message));
    }
    const nonInt = runRecordEvidence(makeOpts({ exit: 'zero' }), dir, FIXED_NOW);
    assert.equal(nonInt.exitCode, 1);
    assert.ok(/integer/.test(nonInt.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--forge-dir overrides the .forge root', () => {
  const dir = tmp('forge-evidence-forgedir-');
  try {
    const customRoot = path.join(dir, 'custom-forge');
    fs.mkdirSync(path.join(customRoot, 'sessions', 'sess-c', 'tasks'), { recursive: true });
    fs.writeFileSync(
      path.join(customRoot, 'active.json'),
      `${JSON.stringify({ sessionId: 'sess-c' }, null, 2)}\n`,
      'utf8',
    );
    const result = runRecordEvidence(makeOpts({ forgeDir: 'custom-forge' }), dir, FIXED_NOW);
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(fs.existsSync(evidencePath(customRoot, 'sess-c', '03-record-evidence')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
