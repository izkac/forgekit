import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runE2eSteps, writeE2eResults } from './integrity.mjs';

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

test('phase done accepts with verify-evidence, complete tasks, and notApplicable spine', () => {
  const dir = tmp('forge-set-phase-done-ok-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-done-ok');
    const sessionDir = path.dirname(sessionFile);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.tasksTotal = 2;
    raw.tasksComplete = 2;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );

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
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync only' }, null, 2)}\n`,
      'utf8',
    );
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

test('phase done refuses any session without spine.json', () => {
  const dir = tmp('forge-set-phase-spine-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-spine');
    const sessionDir = path.dirname(sessionFile);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.slug = 'add-feature-x';
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

test('phase done accepts jobs-scoped session with wired spine + green e2e run', () => {
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
    const e2eSteps = [{ name: 'loop', cmd: 'node -e "console.log(\'ratified: 1\')"' }];
    fs.writeFileSync(
      path.join(sessionDir, 'e2e.json'),
      `${JSON.stringify({ change: null, notApplicable: null, steps: e2eSteps }, null, 2)}\n`,
      'utf8',
    );
    writeE2eResults(sessionDir, runE2eSteps({ steps: e2eSteps }));

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

/** High-risk change (specs engine) with a done-ready session. */
function makeHighRiskFixture(dir, sessionId) {
  const sessionFile = makeForgeFixture(dir, sessionId);
  const sessionDir = path.dirname(sessionFile);
  const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  raw.tasksTotal = 2;
  raw.tasksComplete = 2;
  raw.planType = 'specs';
  raw.openspecChange = 'add-refunds';
  fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');

  const changeDir = path.join(dir, 'specs', 'changes', 'add-refunds');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(
    path.join(changeDir, 'proposal.md'),
    '# Why\n\nIssue partial refunds through the payment provider.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '## Work\n- [x] 1.1 do it\n- [x] 1.2 do it\n', 'utf8');
  fs.writeFileSync(
    path.join(changeDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
    'utf8',
  );
  return { sessionFile, sessionDir };
}

test('phase done refuses a high-risk change whose final review is missing or self-authored', () => {
  // The rule existed as a paragraph in the skill and a line in three analysis
  // reports, and was skipped anyway: the session that most needed it recorded
  // "dispatch was declined twice" in prose no gate could see.
  const dir = tmp('forge-review-floor-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-floor');

    assert.throws(() => runSetPhase(dir, ['done']), /final review is missing or self-authored/);

    fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      '# Final review\n\nReviewer: the coordinator — a self-review, dispatch was declined.\n',
      'utf8',
    );
    assert.throws(() => runSetPhase(dir, ['done']), /self-authored/);

    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n',
      'utf8',
    );
    runSetPhase(dir, ['done']);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the review floor can be waived explicitly, and the waiver is recorded', () => {
  const dir = tmp('forge-review-waive-');
  try {
    const { sessionFile } = makeHighRiskFixture(dir, 'sess-waive');
    runSetPhase(dir, ['done', '--final-review-waived', 'operator declined dispatch — cost']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.match(session.finalReviewWaived, /declined dispatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a low-risk change is not asked for an independent final review', () => {
  const dir = tmp('forge-review-lowrisk-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-lowrisk');
    const sessionDir = path.dirname(sessionFile);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.tasksTotal = 1;
    raw.tasksComplete = 1;
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );

    runSetPhase(dir, ['done']);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
