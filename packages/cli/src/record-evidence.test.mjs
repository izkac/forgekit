import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_TIER,
  NO_TDD_MARKER,
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
    noTdd: false,
    reason: null,
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
  assert.equal(opts.noTdd, false);
  assert.equal(opts.reason, null);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('parseArgs parses --no-tdd and --reason', () => {
  const opts = parseArgs([
    '--task', '01-docs',
    '--no-tdd',
    '--reason', 'documentation only, no behavior change',
  ]);
  assert.equal(opts.task, '01-docs');
  assert.equal(opts.noTdd, true);
  assert.equal(opts.reason, 'documentation only, no behavior change');
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
        // Which session recorded it, so a re-run can tell its own earlier
        // evidence from a neighbour's rather than refusing every overwrite.
        '- **Session:** sess-a',
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

test('a guessed session cannot replace evidence another run produced', () => {
  // ROUND 4, and the reason it survived mutation: the previous guard compared a
  // `- **Session:** <id>` header against the session it had resolved to, but
  // the header is written from `sessionId` and the path is
  // `sessions/<sessionId>/tasks/…` — the same variable. It could only ever
  // agree with itself. The tests passed because they hand-planted a header
  // naming a *different* session inside a session's own directory, a state no
  // code path produces.
  //
  // So this drives the product end to end and never writes an evidence file by
  // hand: session B records, then a run that resolves to B *by guess* must not
  // be able to replace it.
  const dir = tmp('forge-evidence-clobber-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-b');
    for (const id of ['sess-a', 'sess-b']) {
      fs.mkdirSync(path.join(forgeDir, 'sessions', id, 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(forgeDir, 'sessions', id, 'session.json'),
        `${JSON.stringify({ id, slug: id, phase: 'implement' })}\n`,
      );
    }

    const mine = runRecordEvidence(makeOpts({ summary: "B's real run" }), dir, FIXED_NOW);
    assert.equal(mine.exitCode, 0, mine.message);
    const file = evidencePath(forgeDir, 'sess-b', '03-record-evidence');
    assert.match(fs.readFileSync(file, 'utf8'), /B's real run/);

    // The bare command again — resolves to B from the pointer, which is a guess.
    const guessed = runRecordEvidence(
      makeOpts({ summary: "A's failing run", exit: 1, allowFail: true }),
      dir,
      FIXED_NOW,
    );
    assert.equal(guessed.exitCode, 1, 'a guessed session must not replace existing evidence');
    assert.match(fs.readFileSync(file, 'utf8'), /B's real run/, 'and must not have replaced it');
    assert.match(guessed.message, /--session/, 'and must name the way through');

    // Naming the session makes the resolution certain, and then it overwrites.
    const named = runRecordEvidence(
      makeOpts({ summary: 'B, named', session: 'sess-b' }),
      dir,
      FIXED_NOW,
    );
    assert.equal(named.exitCode, 0, `naming the session must unblock the re-run:\n${named.message}`);
    assert.match(fs.readFileSync(file, 'utf8'), /B, named/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the evidence header records how the session was decided, not who ran the test', () => {
  // The id alone is written from the same variable as the path, so it can only
  // agree with itself and tells a reader nothing. What it can honestly say is
  // whether the session was named or guessed from the pointer.
  const dir = tmp('forge-evidence-provenance-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-b');
    for (const id of ['sess-a', 'sess-b']) {
      fs.mkdirSync(path.join(forgeDir, 'sessions', id, 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(forgeDir, 'sessions', id, 'session.json'),
        `${JSON.stringify({ id, slug: id, phase: 'implement' })}\n`,
      );
    }

    runRecordEvidence(makeOpts({ session: 'sess-a' }), dir, FIXED_NOW);
    assert.match(
      fs.readFileSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence'), 'utf8'),
      /- \*\*Session:\*\* sess-a \(named with --session\)/,
    );

    runRecordEvidence(makeOpts(), dir, FIXED_NOW);
    assert.match(
      fs.readFileSync(evidencePath(forgeDir, 'sess-b', '03-record-evidence'), 'utf8'),
      /- \*\*Session:\*\* sess-b \(resolved from \.forge\/active\.json while several sessions were open\)/,
      'a guessed session must say so in the file it writes',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --no-tdd / --reason (Gap A: tasks with no applicable test cycle)
// ---------------------------------------------------------------------------

test('--no-tdd without --reason refuses and writes nothing', () => {
  const dir = tmp('forge-evidence-notdd-noreason-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({ command: null, exit: null, summary: null, noTdd: true }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/--reason/.test(result.message), result.message);
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-tdd with a blank --reason refuses and writes nothing', () => {
  const dir = tmp('forge-evidence-notdd-blankreason-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({ command: null, exit: null, summary: null, noTdd: true, reason: '   ' }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/--reason/.test(result.message), result.message);
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-tdd --reason declares the task exempt without requiring --command/--exit/--summary', () => {
  const dir = tmp('forge-evidence-notdd-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({
        task: '01-docs',
        command: null,
        exit: null,
        summary: null,
        noTdd: true,
        reason: 'documentation only, no behavior change',
      }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 0, result.message);
    const content = fs.readFileSync(evidencePath(forgeDir, 'sess-a', '01-docs'), 'utf8');
    assert.ok(content.includes(NO_TDD_MARKER), 'evidence file must carry the durable declaration marker');
    assert.match(content, /documentation only, no behavior change/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-tdd can be combined with --command/--exit/--summary and records both', () => {
  const dir = tmp('forge-evidence-notdd-combo-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({
        task: '02-docs-lint',
        noTdd: true,
        reason: 'docs only; ran lint as a sanity check',
        command: 'npm run lint:docs',
        exit: '0',
        summary: 'lint clean',
      }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 0, result.message);
    const content = fs.readFileSync(evidencePath(forgeDir, 'sess-a', '02-docs-lint'), 'utf8');
    assert.ok(content.includes(NO_TDD_MARKER));
    assert.match(content, /docs only; ran lint as a sanity check/);
    assert.match(content, /npm run lint:docs/);
    assert.match(content, /lint clean/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-tdd with a partial --command/--exit/--summary trio still requires the missing ones', () => {
  const dir = tmp('forge-evidence-notdd-partial-');
  try {
    makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({
        command: 'npm run lint:docs',
        exit: null,
        summary: null,
        noTdd: true,
        reason: 'docs only',
      }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/--exit/.test(result.message), result.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The marker must be CLI-authored only — reviewer-found smuggle (F1a):
// `--summary`/`--command`/`--tier`/`--task` interpolate caller text straight
// into the same file the marker lives in, with no check that the text
// itself quotes the marker. Without --no-tdd/--reason at all, an implementer
// describing "notes on <!-- forge:no-tdd-declared -->" in a summary cleared
// the pairing gate for its own task.
// ---------------------------------------------------------------------------

test('a --summary quoting the no-tdd marker is refused, even without --no-tdd (reviewer repro)', () => {
  const dir = tmp('forge-evidence-smuggle-summary-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({
        summary: `green — see notes on ${NO_TDD_MARKER}`,
      }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/marker/i.test(result.message), result.message);
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a --command quoting the no-tdd marker is refused', () => {
  const dir = tmp('forge-evidence-smuggle-command-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({ command: `npm test # ${NO_TDD_MARKER}` }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/marker/i.test(result.message), result.message);
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a --tier quoting the no-tdd marker is refused', () => {
  const dir = tmp('forge-evidence-smuggle-tier-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({ tier: `2 ${NO_TDD_MARKER}` }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/marker/i.test(result.message), result.message);
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a --task quoting the no-tdd marker is refused', () => {
  const dir = tmp('forge-evidence-smuggle-task-');
  try {
    makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({ task: `01-sneaky-${NO_TDD_MARKER}` }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/marker/i.test(result.message), result.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a --summary quoting the marker is still refused when combined with a legitimate --no-tdd --reason', () => {
  // The write-time check is unconditional — --no-tdd does not create an
  // exception for smuggling a second, free-text copy of the marker in.
  const dir = tmp('forge-evidence-smuggle-notdd-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(
      makeOpts({
        command: null,
        exit: null,
        summary: `docs only ${NO_TDD_MARKER}`,
        noTdd: true,
        reason: 'documentation only',
      }),
      dir,
      FIXED_NOW,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(/marker/i.test(result.message), result.message);
    assert.equal(fs.existsSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain --command/--exit/--summary run (no --no-tdd) never writes the no-tdd marker', () => {
  const dir = tmp('forge-evidence-notdd-absent-');
  try {
    const forgeDir = makeForgeFixture(dir, 'sess-a');
    const result = runRecordEvidence(makeOpts(), dir, FIXED_NOW);
    assert.equal(result.exitCode, 0, result.message);
    const content = fs.readFileSync(evidencePath(forgeDir, 'sess-a', '03-record-evidence'), 'utf8');
    assert.ok(!content.includes(NO_TDD_MARKER));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
