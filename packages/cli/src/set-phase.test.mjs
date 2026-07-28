import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runE2eSteps, writeE2eResults } from './integrity.mjs';
import { readLedger } from './ledger.mjs';

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
 * @param {Record<string, string>} [env] extra environment for the child
 * @returns {string}
 */
function runSetPhase(cwd, args, env = {}) {
  // These tests may themselves run inside a host session, so drop the
  // inherited id and config dir: a test that means "no host" must get one
  // anywhere, including on a machine with a relocated ~/.claude.
  const base = { ...process.env };
  delete base.CLAUDE_CODE_SESSION_ID;
  delete base.CLAUDE_CONFIG_DIR;
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env },
  });
}

/** @param {string} sessionFile */
function phaseHistory(sessionFile) {
  return JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phaseHistory;
}

test('a phase transition appends {phase, at} to a session with no phaseHistory', () => {
  const dir = tmp('forge-phase-history-');
  try {
    // The fixture is the legacy shape: no phaseHistory field at all.
    const sessionFile = makeForgeFixture(dir, 'sess-hist');
    runSetPhase(dir, ['brainstorm']);

    const history = phaseHistory(sessionFile);
    assert.deepEqual(
      history.map((e) => e.phase),
      ['brainstorm'],
    );
    assert.ok(!Number.isNaN(Date.parse(history[0].at)), `not a timestamp: ${history[0].at}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phaseHistory is chronological and append-only, and skips a re-entered phase', () => {
  const dir = tmp('forge-phase-history-order-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-hist-order');

    runSetPhase(dir, ['implement', '--tasks-complete', '1']);
    const first = phaseHistory(sessionFile);

    // `forge phase implement --tasks-complete N` runs after every task; the
    // history must not fill with identical rows.
    runSetPhase(dir, ['implement', '--tasks-complete', '2']);
    assert.deepEqual(phaseHistory(sessionFile), first);

    // Returning to an earlier phase is a real transition and does append.
    runSetPhase(dir, ['verify']);
    runSetPhase(dir, ['implement']);

    const history = phaseHistory(sessionFile);
    assert.deepEqual(
      history.map((e) => e.phase),
      ['implement', 'verify', 'implement'],
    );
    assert.deepEqual(history[0], first[0], 'earlier entries must never be rewritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Let a `done` transition through: evidence, no open tasks, spine answered. */
function makeDoneable(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * A host transcript under a scratch CLAUDE_CONFIG_DIR, with every line stamped
 * at the session's own `createdAt` so it is inside the collector's window
 * however long the test takes.
 *
 * Two requests written across three lines: the host repeats the whole `usage`
 * object per content block, so a collector that counted lines would say 3.
 *
 * @param {string} configDir
 * @param {string} hostId
 * @param {string} at
 * @returns {number} how many distinct requests the fixture contains
 */
function writeHostTranscript(configDir, hostId, at) {
  const projectDir = path.join(configDir, 'projects', '-scratch');
  fs.mkdirSync(projectDir, { recursive: true });
  const line = (requestId, block) => ({
    type: 'assistant',
    requestId,
    timestamp: at,
    version: '2.1.220',
    message: {
      id: `msg_${requestId}`,
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: `toolu_${requestId}_${block}`, name: 'Bash' }],
      usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 7 },
    },
  });
  const lines = [line('req_1', 0), line('req_1', 1), line('req_2', 0)];
  fs.writeFileSync(
    path.join(projectDir, `${hostId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    'utf8',
  );
  return new Set(lines.map((l) => l.requestId)).size;
}

test('phase done collects metrics under a host id first seen on that very command', () => {
  // Two orderings in one assertion, and neither was observable before the
  // collector existed. bindHost must run before the collector, or a session
  // whose first `forge` command is `phase done` records available:false
  // permanently; and the collector must run before writeSessionScorecard,
  // which is what appends the digest that outlives the session directory.
  const dir = tmp('forge-metrics-done-');
  const configDir = tmp('forge-metrics-done-cfg-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-metrics-done');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const requests = writeHostTranscript(configDir, 'host-fresh', createdAt);

    runSetPhase(dir, ['done'], {
      CLAUDE_CODE_SESSION_ID: 'host-fresh',
      CLAUDE_CONFIG_DIR: configDir,
    });

    const doc = JSON.parse(fs.readFileSync(path.join(sessionDir, 'metrics.json'), 'utf8'));
    assert.equal(doc.available, true, doc.reason);
    assert.equal(doc.requests, requests, 'usage is per request, not per transcript line');

    const digest = readLedger(path.join(dir, '.forge', 'sessions.jsonl')).at(-1);
    assert.equal(digest.sessionId, 'sess-metrics-done');
    assert.equal(digest.metrics.available, true, 'the digest is written after the collector');
    assert.equal(digest.metrics.requests, requests);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('phase done carries the dispatch ledger into the digest that outlives the session', () => {
  // dispatches.jsonl lives in the session directory and dies with it. Without
  // the session directory reaching the collector these counts are silently zero
  // — and zero is indistinguishable from a policy nobody ever had to enforce.
  const dir = tmp('forge-metrics-dispatch-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-dispatch');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    const rows = [
      { ts: '2026-07-27T10:00:00.000Z', decision: 'allow' },
      { ts: '2026-07-27T10:01:00.000Z', decision: 'rewrite' },
      { ts: '2026-07-27T10:02:00.000Z', decision: 'deny' },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'dispatches.jsonl'),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
      'utf8',
    );

    runSetPhase(dir, ['done'], { CLAUDE_CODE_SESSION_ID: 'host-dispatch' });

    const doc = JSON.parse(fs.readFileSync(path.join(sessionDir, 'metrics.json'), 'utf8'));
    assert.equal(doc.dispatches.total, rows.length);
    assert.equal(doc.dispatches.skipped, 2, 'a rewrite and a denial both mean the resolver lost');

    const digest = readLedger(path.join(dir, '.forge', 'sessions.jsonl')).at(-1);
    assert.equal(digest.dispatchesSkipped, 2);
    assert.equal(digest.subagentsDispatched, 2, 'the denied dispatch never became a subagent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing metrics collection still finishes the transition, scorecard and digest', () => {
  const dir = tmp('forge-metrics-fail-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-metrics-fail');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    // A directory where the document goes: the write throws, which is the one
    // failure the collector itself cannot swallow.
    fs.mkdirSync(path.join(sessionDir, 'metrics.json'));

    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [SCRIPT, 'done'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...base, CLAUDE_CODE_SESSION_ID: 'host-fail' },
    });

    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stderr,
      /could not collect session metrics/,
      'a swallowed failure is indistinguishable from a collector that never ran',
    );
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'done');
    assert.ok(fs.existsSync(path.join(sessionDir, 'scorecard.md')), 'scorecard still written');
    const digest = readLedger(path.join(dir, '.forge', 'sessions.jsonl')).at(-1);
    assert.equal(digest.sessionId, 'sess-metrics-fail');
    assert.deepEqual(digest.metrics, { available: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done binds a host id first seen on that very command', () => {
  const dir = tmp('forge-host-done-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-done-bind');
    const sessionDir = path.dirname(sessionFile);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# ok\n', 'utf8');
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ rows: [], notApplicable: 'sync HTTP only' }, null, 2)}\n`,
      'utf8',
    );

    // Binding survives the whole gate + scorecard path, not just a plain hop.
    runSetPhase(dir, ['done'], { CLAUDE_CODE_SESSION_ID: 'host-done' });

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.deepEqual(session.host.sessionIds, ['host-done']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a phase transition binds the session to the host session driving it', () => {
  const dir = tmp('forge-host-bind-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-bind');
    runSetPhase(dir, ['brainstorm'], { CLAUDE_CODE_SESSION_ID: 'host-A' });

    const { host } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(host.agent, 'claude-code');
    assert.deepEqual(host.sessionIds, ['host-A']);
    assert.ok(!Number.isNaN(Date.parse(host.boundAt)), `not a timestamp: ${host.boundAt}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session resumed under a second host session records both ids, without duplicates', () => {
  const dir = tmp('forge-host-resume-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-resume');
    runSetPhase(dir, ['brainstorm'], { CLAUDE_CODE_SESSION_ID: 'host-A' });
    runSetPhase(dir, ['plan'], { CLAUDE_CODE_SESSION_ID: 'host-B' });
    runSetPhase(dir, ['implement'], { CLAUDE_CODE_SESSION_ID: 'host-A' });

    const { host } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.deepEqual(host.sessionIds, ['host-A', 'host-B']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a transition with no host env leaves an existing binding intact', () => {
  // Cursor, Codex and a plain shell all get here — and must not erase the
  // binding an earlier command made, nor print a warning about it.
  const dir = tmp('forge-host-none-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-nohost');
    runSetPhase(dir, ['brainstorm'], { CLAUDE_CODE_SESSION_ID: 'host-A' });
    runSetPhase(dir, ['plan']);

    const { host } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(host.agent, 'claude-code');
    assert.deepEqual(host.sessionIds, ['host-A']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
