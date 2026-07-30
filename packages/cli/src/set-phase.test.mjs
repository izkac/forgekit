import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runE2eSteps, writeE2eResults } from './integrity.mjs';
import { readLedger } from './ledger.mjs';
import { FINAL_REVIEW_REQUEST_FLOOR, reviewCensus } from './review-census.mjs';

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

/**
 * Reviewer sidecars beside a host transcript, in the host's own layout: an
 * `agent-<id>.meta.json` naming the dispatch and an `agent-<id>.jsonl` placing
 * it in time. `at` has to sit inside `[session.createdAt, now]`, or the
 * dispatch belongs to some other Forge session sharing the host session.
 *
 * EVERY DISPATCH PLANTED HERE MADE `FINAL_REVIEW_REQUEST_FLOOR` REQUESTS —
 * imported, never typed as a number, so a fixture cannot drift below a floor
 * that moves. One line per dispatch was the earlier shape, and it describes a
 * subagent that was spawned and did nothing: `review-census.mjs` now reads such
 * a dispatch as no answer at all, which is the right reading of it and the
 * wrong scenario for a test named for a reviewer that ran.
 *
 * The count is the floor exactly, not a comfortable multiple of it, so these
 * fixtures sit on the boundary and any tightening of the floor turns them red
 * rather than passing unnoticed. Stopped dispatches get the same count as
 * unstopped ones: `maxRequests` ignores them by design, and a fixture that gave
 * the stopped dispatch the bigger number would quietly describe an
 * operator-killed run vouching for a token one beside it — a different scenario
 * from any of the ones these tests are named for.
 *
 * @param {string} configDir
 * @param {string} hostId
 * @param {string} at
 * @param {Record<string, { description: string, stoppedByUser?: boolean }>} agents
 * @param {string} [forgeSessionId] completes a bare `forge-review <unit>` into
 *   the prescribed `forge-review <unit> <forge-session-id>`, which is what makes
 *   a dispatch record attributable to one Forge session rather than to whatever
 *   else shared the conversation.
 * @returns {string} the sidecar directory
 */
function writeReviewerSidecars(configDir, hostId, at, agents, forgeSessionId) {
  const dir = path.join(configDir, 'projects', '-scratch', hostId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [agentId, { description, stoppedByUser }] of Object.entries(agents)) {
    const named =
      forgeSessionId && /^forge-review\s+\S+$/.test(description)
        ? `${description} ${forgeSessionId}`
        : description;
    const meta = { agentType: 'general-purpose', description: named, model: 'opus' };
    if (stoppedByUser !== undefined) meta.stoppedByUser = stoppedByUser;
    fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf8');
    const lines = Array.from({ length: FINAL_REVIEW_REQUEST_FLOOR }, (_, i) => ({
      type: 'assistant',
      requestId: `req_${agentId}_${i}`,
      timestamp: at,
      message: {
        id: `msg_${agentId}_${i}`,
        model: 'claude-opus-5',
        content: [{ type: 'text' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    }));
    fs.writeFileSync(
      path.join(dir, `agent-${agentId}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );
  }
  return dir;
}

/** A final review whose prose declares the coordinator wrote it. */
const SELF_PROSE = '# Final review\n\nReviewer: the coordinator — a self-check of the diff.\n';
/** A final review whose prose names an outside reader. */
const INDEPENDENT_PROSE =
  '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n';

/** @param {string} sessionDir @param {string} body */
function writeFinalReview(sessionDir, body) {
  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'reviews', 'final-review.md'), body, 'utf8');
}

test('phase done freezes the verdict host evidence produces, not the one the prose claims', () => {
  const dir = tmp('forge-verdict-freeze-');
  const configDir = tmp('forge-verdict-freeze-cfg-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-verdict');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-verdict', createdAt);
    writeReviewerSidecars(configDir, 'host-verdict', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-verdict');
    writeFinalReview(sessionDir, SELF_PROSE);

    // The fixture only discriminates because the prose says the opposite of the
    // evidence. Were they to agree, a verdict read off the file under suspicion
    // would pass this test unnoticed.
    assert.equal(reviewCensus(sessionDir).finalReview, 'self', 'fixture: prose alone says self');

    runSetPhase(dir, ['done'], {
      CLAUDE_CODE_SESSION_ID: 'host-verdict',
      CLAUDE_CONFIG_DIR: configDir,
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('the frozen verdict and its digest line survive the host pruning the transcript', () => {
  // The spec requirement this change is named for: the verdict outlives its
  // evidence. Measured — a one-day-old session on this machine already has no
  // surviving host transcript, and `finish` then `done` a day apart is
  // ordinary. A second pass that re-measured would find nothing, fall back to
  // the prose, and hand the verdict back to the party being judged; on a
  // high-risk change it would then refuse work that was genuinely reviewed.
  const dir = tmp('forge-verdict-prune-');
  const configDir = tmp('forge-verdict-prune-cfg-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-prune');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-prune', createdAt);
    writeReviewerSidecars(configDir, 'host-prune', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-prune');
    writeFinalReview(sessionDir, SELF_PROSE);
    assert.equal(reviewCensus(sessionDir).finalReview, 'self', 'fixture: prose alone says self');

    const env = { CLAUDE_CODE_SESSION_ID: 'host-prune', CLAUDE_CONFIG_DIR: configDir };
    const ledger = path.join(dir, '.forge', 'sessions.jsonl');
    runSetPhase(dir, ['finish'], env);
    const measured = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict;
    assert.deepEqual(measured, { final: 'independent', evidence: 'host', stoppedByOperator: false });
    const recorded = readLedger(ledger).at(-1).reviews;
    assert.equal(recorded.final, 'independent');
    assert.equal(recorded.evidence, 'host');

    fs.rmSync(configDir, { recursive: true, force: true });
    runSetPhase(dir, ['done'], env);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict,
      measured,
      'a measurement that can no longer be taken must not be replaced by a guess',
    );
    assert.deepEqual(readLedger(ledger).at(-1).reviews, recorded);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a stale self verdict never survives to refuse a session that was then reviewed', () => {
  // The keep rule is asymmetric because the two verdicts are not symmetric in
  // consequence. Losing a measured `independent` costs a correct verdict;
  // keeping a stale `self` REFUSES WORK, and refusing work is the failure this
  // whole change exists to stop. Reproduced end to end:
  //
  //   1. high-risk session, convention in use, no final reviewer yet → self/host
  //   2. operator proceeds with --final-review-waived, the escape the gate's
  //      own message tells them to use
  //   3. a genuine prescribed reviewer is then dispatched and writes its report
  //   4. the host prunes the transcript overnight — the premise of the freeze
  //   5. `forge phase done` must pass: the remedy it would print has been done
  //
  // Only a frozen `independent` on `host` grade is preserved — precisely the
  // GIVEN of the spec's "verdict outlives its evidence" scenario, and nothing
  // wider.
  const dir = tmp('forge-verdict-stale-self-');
  const configDir = tmp('forge-verdict-stale-self-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-stale-self');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-stale', createdAt);
    writeReviewerSidecars(configDir, 'host-stale', createdAt, {
      g1: { description: 'forge-review group-01' },
    }, 'sess-stale-self');
    writeFinalReview(sessionDir, SELF_PROSE);
    const env = { CLAUDE_CODE_SESSION_ID: 'host-stale', CLAUDE_CONFIG_DIR: configDir };

    runSetPhase(dir, ['finish', '--final-review-waived', 'reviewer declined — cost'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'self',
      evidence: 'host',
      stoppedByOperator: false,
    });

    // The reviewer that was declined at step 1 is now dispatched for real, and
    // writes the report the gate asked for.
    writeReviewerSidecars(configDir, 'host-stale', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-stale-self');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    fs.rmSync(configDir, { recursive: true, force: true });

    runSetPhase(dir, ['done'], env);

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.deepEqual(session.reviewVerdict, {
      final: 'independent',
      evidence: 'inferred',
      stoppedByOperator: false,
    });
    assert.equal(session.finalReviewWaived, undefined, 'a real review retires the waiver');
    const { reviews } = readLedger(path.join(dir, '.forge', 'sessions.jsonl')).at(-1);
    assert.equal(reviews.final, 'independent');
    assert.equal(reviews.evidence, 'inferred', 'and the durable record does not claim it was measured');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a frozen verdict inferred from prose is never protected — only a measured one is', () => {
  // The first conjunct of the keep rule. `evidence === 'host'` is what makes
  // the rule "a measurement is not replaced by a guess"; drop it and a *guess*
  // is protected too, which is worse than the defect it was written to stop —
  // the stale prose reading then outranks a fresher prose reading of the very
  // same file.
  //
  // Discriminator: no host evidence anywhere, so both passes are `inferred`.
  // The review file is independent at `finish` and a self-check by `done`.
  const dir = tmp('forge-verdict-keep-inferred-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-keep-inferred');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);

    runSetPhase(dir, ['finish']);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'inferred',
      stoppedByOperator: false,
    });

    writeFinalReview(sessionDir, SELF_PROSE);
    assert.throws(
      () => runSetPhase(dir, ['done']),
      /self-authored/,
      'a stale guess must not stand in for a fresh reading of the same file',
    );
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'finish');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a measured independent verdict survives its dispatch record being pruned', () => {
  // I1, from the final review. The keep rule used to be `next.evidence !==
  // 'host'`, and the reading that defeated it needs no adversary: an emptied
  // `subagents/` directory scans clean and yields `seen === 0`, which is graded
  // `host` — "nothing was dispatched" — so it overwrote the measurement taken
  // at `finish` and `done` then refused the session as self-reviewed.
  //
  // Permanently, which is what made it a blocker: `saveSession` runs last, so
  // the refused pass never writes the downgraded verdict, and every retry
  // repeats the same downgrade. The only escape was `--final-review-waived`,
  // for a reviewer that really did run.
  const dir = tmp('forge-verdict-pruned-');
  const configDir = tmp('forge-verdict-pruned-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-pruned');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-pruned', createdAt);
    writeReviewerSidecars(configDir, 'host-pruned', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-pruned');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    const env = { CLAUDE_CODE_SESSION_ID: 'host-pruned', CLAUDE_CONFIG_DIR: configDir };

    runSetPhase(dir, ['finish'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
    });

    // The host prunes the sidecars. The directory still exists and reads
    // cleanly; it is simply empty, which is exactly `seen === 0`.
    const sidecars = path.join(configDir, 'projects', '-scratch', 'host-pruned', 'subagents');
    for (const name of fs.readdirSync(sidecars)) fs.rmSync(path.join(sidecars, name));

    runSetPhase(dir, ['done'], env);
    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(after.phase, 'done', 'the transition must not be refused on vanished evidence');
    assert.deepEqual(after.reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a surviving group label does not overwrite a measured final verdict', () => {
  // K3. The `seen === 0` rule this replaced was *narrower* than the one before
  // it, not wider: any surviving dispatch made `seen > 0` and let a reading
  // with no `final` unit overwrite the measurement. A `forge-review group-01`
  // sidecar outliving the `final` one is the ordinary shape — and it refused
  // the session even though the review file itself reads independent.
  //
  // The axis is whether this pass saw *the unit that decides*.
  const dir = tmp('forge-verdict-group-');
  const configDir = tmp('forge-verdict-group-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-group');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-group', createdAt);
    writeReviewerSidecars(configDir, 'host-group', createdAt, {
      r1: { description: 'forge-review final' },
      g1: { description: 'forge-review group-01' },
    }, 'sess-group');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    const env = { CLAUDE_CODE_SESSION_ID: 'host-group', CLAUDE_CONFIG_DIR: configDir };

    runSetPhase(dir, ['finish'], env);
    assert.equal(
      JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict.final,
      'independent',
    );

    // The final reviewer's sidecar is pruned; the group one survives.
    const sidecars = path.join(configDir, 'projects', '-scratch', 'host-group', 'subagents');
    for (const name of fs.readdirSync(sidecars)) {
      if (name.includes('r1')) fs.rmSync(path.join(sidecars, name));
    }

    runSetPhase(dir, ['done'], env);
    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(after.phase, 'done', 'a surviving group label must not refuse the session');
    assert.equal(after.reviewVerdict.final, 'independent');
    assert.equal(after.reviewVerdict.evidence, 'host');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a fresh host reading always wins over a stale one, including when it is worse', () => {
  // The third conjunct of the keep rule. When this pass can measure on `host`
  // grade too it is strictly better informed, so it must refresh — and the case
  // that matters is the one where the newer answer is *less* flattering.
  //
  // The mechanism is real, not contrived: the host writes the meta when the
  // subagent spawns and adds `stoppedByUser` when the operator stops it. A
  // `finish` taken while the reviewer is still running measures a completed
  // dispatch; by `done` the same meta says the operator stopped it. Keeping the
  // stale verdict would erase the operator's refusal and let the gate pass a
  // session whose reviewer was declined — the 0.3.26 escape this change exists
  // to close.
  const dir = tmp('forge-verdict-keep-fresh-');
  const configDir = tmp('forge-verdict-keep-fresh-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-keep-fresh');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-keep', createdAt);
    writeReviewerSidecars(configDir, 'host-keep', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-keep-fresh');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    const env = { CLAUDE_CODE_SESSION_ID: 'host-keep', CLAUDE_CONFIG_DIR: configDir };

    runSetPhase(dir, ['finish'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
    });

    // The operator stops that same dispatch; the host stamps the meta it wrote.
    writeReviewerSidecars(configDir, 'host-keep', createdAt, {
      r1: { description: 'forge-review final', stoppedByUser: true },
    }, 'sess-keep-fresh');

    assert.throws(() => runSetPhase(dir, ['done'], env), /self-authored/);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'finish');

    // And the refreshed verdict is what gets recorded once the operator owns
    // the decision themselves.
    runSetPhase(dir, ['done', '--final-review-waived', 'I stopped the reviewer'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'self',
      evidence: 'host',
      stoppedByOperator: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a reviewer dispatched between finish and done still reaches the frozen verdict', () => {
  // Freezing is not write-once, and the difference matters at the gate: the
  // first pass measures `self` on host evidence because nobody has been
  // dispatched yet, and a verdict pinned there would refuse the session at
  // `done` after its reviewer had genuinely run. Only a measurement that can no
  // longer be repeated is protected — see the pruning test above.
  const dir = tmp('forge-verdict-refresh-');
  const configDir = tmp('forge-verdict-refresh-cfg-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-refresh');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-refresh', createdAt);
    // An empty sidecar directory: the host looked and this session dispatched
    // nothing. That is a measurement, not an absence of one.
    writeReviewerSidecars(configDir, 'host-refresh', createdAt, {}, 'sess-refresh');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    assert.equal(
      reviewCensus(sessionDir).finalReview,
      'independent',
      'fixture: prose alone says independent, so the host reading is visible either way',
    );

    const env = { CLAUDE_CODE_SESSION_ID: 'host-refresh', CLAUDE_CONFIG_DIR: configDir };
    runSetPhase(dir, ['finish'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'self',
      evidence: 'host',
      stoppedByOperator: false,
    });

    writeReviewerSidecars(configDir, 'host-refresh', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-refresh');
    runSetPhase(dir, ['done'], env);

    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('an operator declining the final reviewer is measured, frozen and recorded', () => {
  // The spec's own scenario end to end. The host records `stoppedByUser` on a
  // prescribed final-review dispatch: the reviewer did not finish, so the
  // verdict is `self` on `host` grade, and the stop is reported as a fact
  // rather than treated as either a completed review or an automatic waiver.
  // Without this the freeze could hard-code the flag and no test would notice —
  // the ledger tests set the verdict directly and never run the measurement.
  const dir = tmp('forge-verdict-stopped-');
  const configDir = tmp('forge-verdict-stopped-cfg-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-stopped');
    const sessionDir = path.dirname(sessionFile);
    makeDoneable(sessionDir);
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-stopped', createdAt);
    writeReviewerSidecars(configDir, 'host-stopped', createdAt, {
      r1: { description: 'forge-review final', stoppedByUser: true },
    }, 'sess-stopped');
    // The prose claims an outside reader; the host recorded the operator
    // stopping that very dispatch.
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    assert.equal(
      reviewCensus(sessionDir).finalReview,
      'independent',
      'fixture: prose alone says independent',
    );

    runSetPhase(dir, ['done'], {
      CLAUDE_CODE_SESSION_ID: 'host-stopped',
      CLAUDE_CONFIG_DIR: configDir,
    });

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.deepEqual(session.reviewVerdict, {
      final: 'self',
      evidence: 'host',
      stoppedByOperator: true,
    });
    assert.equal(
      session.finalReviewWaived,
      undefined,
      'declining a reviewer is the operator’s to record — no waiver is applied for them',
    );
    const { reviews } = readLedger(path.join(dir, '.forge', 'sessions.jsonl')).at(-1);
    assert.equal(reviews.final, 'self');
    assert.equal(reviews.stoppedByOperator, true, 'and it outlives the session directory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a failing review measurement warns, invents no verdict, and still finishes the transition', () => {
  // Telemetry may cost a session its measurement, never its transition — the
  // rule the metrics block beneath the gate already follows.
  //
  // THE FIXTURE IS HIGH-RISK ON PURPOSE. An earlier version was not, so
  // `enforceFinalReviewFloor` returned at `!facts.highRisk` and never reached
  // the verdict at all: the test claimed a property in the one case the gate
  // does not run. On a high-risk session the gate does run, finds no frozen
  // verdict because the measurement it depends on just failed, and must not
  // invent a refusal out of that — the same rule `collectPlanFacts` above it
  // already follows.
  //
  // The injected failure is `tasks` as a *file*: `reviewCensus` sees it exists
  // and `readdirSync` raises ENOTDIR, the one failure that census does not
  // swallow. It is also the only one reachable from outside, and it therefore
  // costs the scorecard too — `scoreSession` reads the same census. So this
  // asserts both guards fire independently and the transition survives both;
  // the scorecard and digest under a *successful* measurement are asserted by
  // the metrics and digest tests either side of this one.
  const dir = tmp('forge-verdict-throw-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-verdict-throw');
    fs.writeFileSync(path.join(sessionDir, 'tasks'), 'not a directory\n', 'utf8');

    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [SCRIPT, 'done'], { cwd: dir, encoding: 'utf8', env: base });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not measure review authorship/);
    assert.match(r.stderr, /could not write scorecard/, 'a second, separate guard');
    // Failing open is deliberate; failing open in silence is not. This session
    // ends up with no verdict, no scorecard and no durable line at all, so the
    // one thing stderr must say is that the floor did not run.
    assert.match(
      r.stderr,
      /final-review floor could not be evaluated/,
      'a high-risk change passing unjudged has to be announced, not inferred from telemetry warnings',
    );
    assert.equal(
      fs.existsSync(path.join(dir, '.forge', 'sessions.jsonl')),
      false,
      'fixture: nothing was recorded anywhere — which is why the notice above is the only trace',
    );
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.equal(
      session.reviewVerdict,
      undefined,
      'a measurement that failed must leave no verdict — an invented one would go on to decide a gate',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('the done gate reads the frozen verdict, so host evidence outranks the review prose', () => {
  // THIS IS THE ORDERING TEST. The verdict is measured before
  // `enforceFinalReviewFloor()`; move that computation below the gate — where
  // the metrics block and the scorecard live — and the gate falls back to a
  // live prose census, reads `self`, and refuses this session.
  const dir = tmp('forge-review-floor-evidence-');
  const configDir = tmp('forge-review-floor-evidence-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-floor-evidence');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-floor', createdAt);
    writeReviewerSidecars(configDir, 'host-floor', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-floor-evidence');
    writeFinalReview(sessionDir, SELF_PROSE);
    assert.equal(reviewCensus(sessionDir).finalReview, 'self', 'fixture: prose alone says self');

    runSetPhase(dir, ['done'], {
      CLAUDE_CODE_SESSION_ID: 'host-floor',
      CLAUDE_CONFIG_DIR: configDir,
    });

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.equal(session.reviewVerdict.evidence, 'host', 'the gate judged on measurement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('the done gate does not refuse a high-risk change when host evidence is unavailable', () => {
  // The single most important test in this group. 0.3.24 shipped a gate that
  // refused unless independence was positively claimed, and it blocked correct
  // work on sessions whose independent reviewer had genuinely run. A host that
  // writes no sidecars — Cursor, Codex, a plain shell, a pruned transcript —
  // must land on exactly the behaviour of the release before this change.
  const dir = tmp('forge-review-floor-blind-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-floor-blind');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);

    // runSetPhase strips CLAUDE_CODE_SESSION_ID and CLAUDE_CONFIG_DIR, so this
    // child genuinely has no host to read, on any machine.
    runSetPhase(dir, ['done']);

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.equal(
      session.reviewVerdict.evidence,
      'inferred',
      'nothing could be measured — so this proves the *fallback* did not refuse',
    );
    assert.equal(session.reviewVerdict.final, 'independent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the done gate refuses a high-risk change the host records no final reviewer for', () => {
  const dir = tmp('forge-review-floor-self-');
  const configDir = tmp('forge-review-floor-self-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-floor-self');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-floor-self', createdAt);
    // The convention is in use here — a prescribed dispatch exists — and none
    // of them is the final reviewer. That is the host's one genuine negative.
    writeReviewerSidecars(configDir, 'host-floor-self', createdAt, {
      g1: { description: 'forge-review group-01' },
    }, 'sess-floor-self');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    assert.equal(
      reviewCensus(sessionDir).finalReview,
      'independent',
      'fixture: prose alone says independent',
    );

    const env = { CLAUDE_CODE_SESSION_ID: 'host-floor-self', CLAUDE_CONFIG_DIR: configDir };
    assert.throws(() => runSetPhase(dir, ['done'], env), /self-authored/);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'plan');

    // The recorded refusal is still the operator's escape hatch, and it is not
    // applied on their behalf by a stopped or missing dispatch.
    runSetPhase(dir, ['done', '--final-review-waived', 'reviewer declined — cost'], env);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.equal(session.reviewVerdict.final, 'self');
    assert.equal(session.reviewVerdict.evidence, 'host');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a refused transition persists nothing — not the phase, and not the verdict it measured', () => {
  // Two properties in one, both load-bearing and neither previously named.
  //
  // THE COMMONEST FROZEN SHAPE. `{final: null, evidence: 'none'}` is what a
  // session with no final review measures at the transition — 12 of the 20
  // real sessions behind this change — and it must refuse a high-risk change
  // even when the host positively recorded a reviewer dispatch, because the
  // report it was supposed to produce is not on disk. Evidence of a dispatch
  // is not a review.
  //
  // NOTHING IS WRITTEN ON A REFUSAL, because the gate exits before
  // `saveSession`. That is what keeps F27 — a verdict built on a partially
  // readable binding — from being pinned to the session for good: a refused
  // pass leaves the session exactly as it was, so the next one measures again.
  // Move `saveSession` above the gates and that wrong positive becomes
  // permanent.
  const dir = tmp('forge-refuse-nosave-');
  const configDir = tmp('forge-refuse-nosave-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-refuse-nosave');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-refuse', createdAt);
    writeReviewerSidecars(configDir, 'host-refuse', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-refuse-nosave');
    assert.equal(
      reviewCensus(sessionDir).finalReview,
      null,
      'fixture: a dispatch was recorded but no review file exists to judge',
    );

    assert.throws(
      () =>
        runSetPhase(dir, ['done'], {
          CLAUDE_CODE_SESSION_ID: 'host-refuse',
          CLAUDE_CONFIG_DIR: configDir,
        }),
      /final review is missing or self-authored/,
    );

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'plan', 'the transition did not happen');
    assert.equal(session.reviewVerdict, undefined, 'and nothing it measured was written down');
    assert.equal(
      fs.existsSync(path.join(dir, '.forge', 'sessions.jsonl')),
      false,
      'no durable line either — a refused session has no verdict to record',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a stopped dispatch is reported at the gate, never turned into a refusal', () => {
  // The spec's "no waiver is applied on the session's behalf" has a mirror the
  // census, the freeze and the digest cannot pin: the *gate* must not read
  // `stoppedByOperator` either. A stop is a fact the host recorded, not the
  // verdict's cause — and the measured case is a stopped run followed by a
  // completed re-run of the same work, where a reviewer did finish.
  const dir = tmp('forge-floor-stopped-');
  const configDir = tmp('forge-floor-stopped-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-floor-stopped');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-floor-stop', createdAt);
    writeReviewerSidecars(configDir, 'host-floor-stop', createdAt, {
      r1: { description: 'forge-review final', stoppedByUser: true },
      r2: { description: 'forge-review final' },
    }, 'sess-floor-stopped');
    // Prose deliberately says the coordinator wrote it: the verdict must come
    // from the two dispatches, one stopped and one completed.
    writeFinalReview(sessionDir, SELF_PROSE);

    runSetPhase(dir, ['done'], {
      CLAUDE_CODE_SESSION_ID: 'host-floor-stop',
      CLAUDE_CONFIG_DIR: configDir,
    });

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done', 'a reviewer did finish — the stop is not a refusal');
    assert.deepEqual(session.reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: true,
    });
    assert.equal(session.finalReviewWaived, undefined, 'and no waiver was applied for them');
    const { reviews } = readLedger(path.join(dir, '.forge', 'sessions.jsonl')).at(-1);
    assert.equal(reviews.final, 'independent');
    assert.equal(reviews.stoppedByOperator, true, 'the fact is still reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
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

test('done and finish refuse an ambiguous session; reversible phases warn and proceed', () => {
  // The operator's call, and it is the difference between a guard and an
  // obstruction. `done` and `finish` write the scorecard, the durable
  // `sessions.jsonl` line and the money/auth verdict — acting on the wrong
  // session there cannot be undone by re-running, and the right change never
  // reaches the final-review floor at all. Reproduced before this change:
  // with two sessions open and `.forge/active.json` naming the neighbour,
  // `forge phase done` scored the neighbour and left the high-risk change at
  // `implement` with no verdict and no ledger line.
  //
  // Everywhere else a wrong guess costs a re-run, so everywhere else says which
  // session it chose and carries on.
  const dir = tmp('forge-phase-severity-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-live');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    const neighbour = path.join(dir, '.forge', 'sessions', 'sess-neighbour');
    fs.mkdirSync(neighbour, { recursive: true });
    fs.writeFileSync(
      path.join(neighbour, 'session.json'),
      `${JSON.stringify({ id: 'sess-neighbour', slug: 'neighbour', phase: 'implement' })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, '.forge', 'active.json'),
      `${JSON.stringify({ sessionId: 'sess-live' })}\n`,
      'utf8',
    );

    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const run = (...args) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: base });

    // A reversible phase: warns, names the alternative, and transitions.
    const soft = run('verify');
    assert.equal(soft.status, 0, soft.stderr);
    assert.match(soft.stderr, /Warning: 2 sessions are unfinished/);
    assert.match(soft.stderr, /acting on sess-live/);
    assert.match(soft.stderr, /--session sess-neighbour/, 'and how to act on the other');
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'verify');

    // The two that write a permanent record refuse, and change nothing.
    for (const phase of ['finish', 'done']) {
      const hard = run(phase);
      assert.notEqual(hard.status, 0, `${phase} must not pick a session for you`);
      assert.match(hard.stderr, /Refusing to guess/i, phase);
      assert.match(hard.stderr, /--session sess-live/, phase);
      assert.match(hard.stderr, /--session sess-neighbour/, phase);
      assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'verify', phase);
      assert.equal(fs.existsSync(path.join(dir, '.forge', 'sessions.jsonl')), false, phase);
      assert.equal(fs.existsSync(path.join(sessionDir, 'scorecard.json')), false, phase);
    }

    // Named explicitly, the gate proceeds.
    const named = run('done', '--session', 'sess-live');
    assert.equal(named.status, 0, named.stderr);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the active pointer follows the transition, but not past a gate or into a finished session', () => {
  const dir = tmp('forge-phase-pointer-');
  try {
    makeForgeFixture(dir, 'sess-a');
    const other = path.join(dir, '.forge', 'sessions', 'sess-b');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      path.join(other, 'session.json'),
      `${JSON.stringify({ id: 'sess-b', slug: 'b', phase: 'implement' })}\n`,
      'utf8',
    );
    const pointer = () =>
      JSON.parse(fs.readFileSync(path.join(dir, '.forge', 'active.json'), 'utf8')).sessionId;
    fs.writeFileSync(
      path.join(dir, '.forge', 'active.json'),
      `${JSON.stringify({ sessionId: 'sess-a' })}\n`,
      'utf8',
    );
    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    const run = (...args) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: base });

    // An ordinary transition moves it.
    assert.equal(run('implement', '--session', 'sess-b').status, 0);
    assert.equal(pointer(), 'sess-b', 'the session being driven becomes the active one');

    // A REFUSED transition must not: the phase never changed, so saying that
    // session is now the one being driven is a lie the next command repeats.
    const refused = run('done', '--session', 'sess-a');
    assert.notEqual(refused.status, 0, 'fixture: this must be refused for the test to mean anything');
    assert.equal(pointer(), 'sess-b', 'a refused transition leaves the pointer alone');

    // And a terminal phase must not capture it — `forge status` and the resume
    // hook would then point the next agent at work that is over, hiding the
    // session with tasks still in flight.
    assert.equal(run('skipped', '--session', 'sess-a').status, 0);
    assert.equal(pointer(), 'sess-b', 'finished work does not take the pointer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed pointer write warns instead of being swallowed', () => {
  // Task 2.2, and it was unpinned: the final review reverted this guard to the
  // exact pre-change silent swallow and the whole suite stayed green. The
  // pointer stopped being "a convenience" the moment commands began resolving
  // through it — a failed write leaves the next one acting on a different
  // session, so the transition succeeds and the operator is told.
  const dir = tmp('forge-pointer-warn-');
  try {
    makeForgeFixture(dir, 'sess-a');
    const forgeDir = path.join(dir, '.forge');
    fs.writeFileSync(path.join(forgeDir, 'active.json'), `${JSON.stringify({ sessionId: 'other' })}\n`);
    // A directory where the pointer file belongs: the write fails, the
    // transition must not.
    fs.rmSync(path.join(forgeDir, 'active.json'));
    fs.mkdirSync(path.join(forgeDir, 'active.json'));

    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [SCRIPT, 'implement', '--session', 'sess-a', '--allow-incomplete', 'fixture'], {
      cwd: dir,
      encoding: 'utf8',
      env: base,
    });

    assert.equal(r.status, 0, 'the transition must survive a failed pointer write');
    assert.match(r.stderr, /could not mark sess-a as the active session/);
    assert.match(r.stderr, /--session/, 'and name the remedy');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, '.forge', 'sessions', 'sess-a', 'session.json'), 'utf8')).phase,
      'implement',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
