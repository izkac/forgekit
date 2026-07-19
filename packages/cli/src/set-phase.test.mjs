import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Scratch forge layout under `dir`: active.json + a session with session.json.
 * set-phase.mjs resolves `.forge` from cwd, so tests run it as a child
 * process with cwd set here.
 *
 * @param {string} dir
 * @param {string} sessionId
 * @returns {string} the session.json path
 */
function makeForgeFixture(dir, sessionId) {
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const sessionFile = path.join(sessionDir, 'session.json');
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify(
      {
        id: sessionId,
        slug: 'fixture',
        createdAt: now,
        updatedAt: now,
        phase: 'plan',
        planType: null,
        openspecChange: null,
        forgeSkipped: false,
        cursorChatId: null,
        tasksTotal: 0,
        tasksComplete: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    'utf8',
  );
  return sessionFile;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function runSetPhase(cwd, args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('--subagents stores subagentsDispatched on the session', () => {
  const dir = tmp('forge-set-phase-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-a');
    const stdout = runSetPhase(dir, ['implement', '--subagents', '3']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'implement');
    assert.equal(session.subagentsDispatched, 3);
    assert.equal(JSON.parse(stdout).session.subagentsDispatched, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--subagents is absolute — a later value replaces the earlier one', () => {
  const dir = tmp('forge-set-phase-abs-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-a');
    runSetPhase(dir, ['implement', '--subagents', '2']);
    runSetPhase(dir, ['implement', '--subagents', '5']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.subagentsDispatched, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omitting --subagents leaves subagentsDispatched untouched', () => {
  const dir = tmp('forge-set-phase-omit-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-a');
    runSetPhase(dir, ['implement', '--subagents', '4']);
    runSetPhase(dir, ['verify', '--tasks-complete', '4']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'verify');
    assert.equal(session.tasksComplete, 4);
    assert.equal(session.subagentsDispatched, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--tasks-total >= 15 escalates brisk/lite to standard when not pinned', () => {
  const dir = tmp('forge-set-phase-escalate-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-esc');
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.pace = 'auto';
    raw.resolvedPace = 'brisk';
    raw.paceReason = 'localized change';
    raw.pacePinned = false;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    runSetPhase(dir, ['implement', '--tasks-total', '57']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.tasksTotal, 57);
    assert.equal(session.resolvedPace, 'standard');
    assert.equal(session.paceReason, 'escalated: 57 tasks');
    assert.equal(session.paceEscalated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--tasks-total escalation skips when pace is user-pinned', () => {
  const dir = tmp('forge-set-phase-pinned-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-pin');
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.pace = 'brisk';
    raw.resolvedPace = 'brisk';
    raw.pacePinned = true;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    runSetPhase(dir, ['implement', '--tasks-total', '20']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.resolvedPace, 'brisk');
    assert.notEqual(session.paceEscalated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done refuses without verify-evidence and incomplete tasks', () => {
  const dir = tmp('forge-set-phase-done-refuse-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-done');
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.tasksTotal = 3;
    raw.tasksComplete = 1;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    assert.throws(
      () => runSetPhase(dir, ['done']),
      (err) => {
        assert.match(String(err.stderr || err.message), /Cannot enter phase "done"/);
        return true;
      },
    );
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'plan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done accepts with verify-evidence and complete tasks', () => {
  const dir = tmp('forge-set-phase-done-ok-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-done-ok');
    const sessionDir = path.dirname(sessionFile);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.tasksTotal = 2;
    raw.tasksComplete = 2;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

    runSetPhase(dir, ['done']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done refuses with an unresolved deferral', () => {
  const dir = tmp('forge-set-phase-defer-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-defer');
    const sessionDir = path.dirname(sessionFile);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    fs.writeFileSync(
      path.join(sessionDir, 'deferrals.json'),
      `${JSON.stringify(
        {
          deferrals: [
            { task: '9.2', reason: 'wiring later', createdAt: new Date().toISOString(), resolvedAt: null },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    assert.throws(
      () => runSetPhase(dir, ['done']),
      (err) => {
        assert.match(String(err.stderr || err.message), /unresolved deferrals: 9\.2/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done refuses jobs-scoped session without spine.json', () => {
  const dir = tmp('forge-set-phase-spine-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-spine');
    const sessionDir = path.dirname(sessionFile);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.slug = 'wire-worker-jobs';
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

    assert.throws(
      () => runSetPhase(dir, ['done']),
      (err) => {
        assert.match(String(err.stderr || err.message), /spine\.json required/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done accepts jobs-scoped session with wired spine + product-loop evidence', () => {
  const dir = tmp('forge-set-phase-spine-ok-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-spine-ok');
    const sessionDir = path.dirname(sessionFile);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.slug = 'wire-worker-jobs';
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify(
        {
          change: null,
          notApplicable: null,
          rows: [
            {
              capability: 'REQ-GOV-01 matching',
              library: 'etl_core/matcher.py',
              runtimeOwner: 'worker job analyze_study',
              writes: 'study_proposals',
              reads: 'N/A',
              uiConsumer: 'Proposals page',
              evidence: 'tasks/12-analyze/test-evidence.md',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'verify-evidence.md'),
      '# Verify\n\n## Product loop\n\ningest -> analyze -> ratify -> run: output differs\n',
      'utf8',
    );

    runSetPhase(dir, ['done']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase finish allows incomplete with --allow-incomplete', () => {
  const dir = tmp('forge-set-phase-allow-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-allow');
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.tasksTotal = 5;
    raw.tasksComplete = 2;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    runSetPhase(dir, ['finish', '--allow-incomplete', 'E2E blocked in CI sandbox']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'finish');
    assert.equal(session.incompleteReason, 'E2E blocked in CI sandbox');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
