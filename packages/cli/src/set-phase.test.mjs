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
import { writeStamp } from './review-stamp.mjs';

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

test('phase verify announces the combined-close path imperatively on stderr', () => {
  // Cohort 4 measured the failure this rail closes: 3 sessions resolved
  // `combined` and 0 followed close.md — one ran a capable final reviewer
  // anyway, two skipped the final review entirely. Prose routing at the top
  // of verify.md is advisory; an instruction at the moment of transition is
  // the surface the agent actually hits.
  const dir = tmp('forge-verify-combined-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-comb-announce');
    const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    s.resolvedCeremony = 'combined';
    fs.writeFileSync(sessionFile, `${JSON.stringify(s, null, 2)}\n`);

    const r = spawnSync(process.execPath, [SCRIPT, 'verify'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /combined/i);
    assert.match(r.stderr, /close\.md/);
    assert.match(r.stderr, /do not run the full/i);

    // A full-ceremony session gets no such instruction.
    const dir2 = tmp('forge-verify-full-');
    try {
      makeForgeFixture(dir2, 'sess-full-quiet');
      const r2 = spawnSync(process.execPath, [SCRIPT, 'verify'], { cwd: dir2, encoding: 'utf8' });
      assert.equal(r2.status, 0, r2.stderr);
      assert.doesNotMatch(r2.stderr, /close\.md/);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done refuses a combined session with no final review on file', () => {
  // The other half of the cohort-4 failure: two combined sessions reached
  // done with empty reviews/ directories. The closer IS the final reviewer;
  // a combined session with no reviews/final-review.md has skipped it.
  const dir = tmp('forge-done-combined-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-comb-done');
    const sessionDir = path.dirname(sessionFile);
    const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    s.resolvedCeremony = 'combined';
    s.tasksTotal = 2;
    s.tasksComplete = 2;
    fs.writeFileSync(sessionFile, `${JSON.stringify(s, null, 2)}\n`);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify evidence\nok\n');
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ notApplicable: 'test fixture', rows: [] })}\n`,
    );

    const refused = spawnSync(process.execPath, [SCRIPT, 'done'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(refused.status, 0, 'must refuse without reviews/final-review.md');
    assert.match(refused.stderr, /final-review\.md/);
    assert.match(refused.stderr, /combined/i);

    fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'reviews', 'final-review.md'),
      'Reviewer: test-model (closer)\n\nREADY\n',
    );
    const ok = spawnSync(process.execPath, [SCRIPT, 'done'], { cwd: dir, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ceremony missing at done fails closed to full and is recorded — skipping implement earns no cheap tail', () => {
  // Cohort 5 observed the hole: a session that never ran `forge phase
  // implement` never resolved ceremony, and the combined final-review gate
  // keys on `combined` — so MISSING was indistinguishable from full while
  // having followed neither path. Late resolution records `full` (never
  // `combined` — the cheap tail is granted from plan facts at implement, not
  // retroactively at the gate), so the session is governed by the full-tail
  // rules it de facto ran under, and the ledgers stop carrying MISSING.
  const dir = tmp('forge-done-lateresolve-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-late-full');
    const sessionDir = path.dirname(sessionFile);
    const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    s.planType = 'direct';
    s.slug = 'fix-pagination-boundary';
    s.paceSignal = 'fix-pagination-boundary';
    s.tasksTotal = 2;
    s.tasksComplete = 2;
    fs.writeFileSync(sessionFile, `${JSON.stringify(s, null, 2)}\n`);
    fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify evidence\nok\n');
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      `${JSON.stringify({ notApplicable: 'test fixture', rows: [] })}\n`,
    );

    const r = spawnSync(process.execPath, [SCRIPT, 'done'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(after.resolvedCeremony, 'full', 'missing ceremony must resolve full at the gate');
    assert.match(after.ceremonyReason || '', /unresolved|fail/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
 * EVERY DISPATCH PLANTED HERE MADE `FINAL_REVIEW_REQUEST_FLOOR` REQUESTS BY
 * DEFAULT — imported, never typed as a number, so a fixture cannot drift below
 * a floor that moves. One line per dispatch was the earlier shape, and it
 * describes a subagent that was spawned and did nothing: `review-census.mjs`
 * now reads such a dispatch as no answer at all, which is the right reading of
 * it and the wrong scenario for a test named for a reviewer that ran.
 *
 * The default count is the floor exactly, not a comfortable multiple of it, so
 * these fixtures sit on the boundary and any tightening of the floor turns them
 * red rather than passing unnoticed. Stopped dispatches get the same count as
 * unstopped ones by default: `maxRequests` ignores them by design, and a
 * fixture that gave the stopped dispatch the bigger number would quietly
 * describe an operator-killed run vouching for a token one beside it — a
 * different scenario from any of the ones these tests are named for.
 *
 * `requests` is the one escape from the default, for a fixture that needs a
 * dispatch *below* the floor — the "on record but not substantial enough to
 * certify" scenario. It is still never a typed literal at the call site: a
 * caller passes `FINAL_REVIEW_REQUEST_FLOOR - 1` (or some other expression
 * relative to the imported constant), the same discipline the default enforces
 * here, so a below-floor fixture stays below floor if the floor is ever moved.
 *
 * @param {string} configDir
 * @param {string} hostId
 * @param {string} at
 * @param {Record<string, { description: string, stoppedByUser?: boolean, requests?: number }>} agents
 * @param {string} [forgeSessionId] completes a bare `forge-review <unit>` into
 *   the prescribed `forge-review <unit> <forge-session-id>`, which is what makes
 *   a dispatch record attributable to one Forge session rather than to whatever
 *   else shared the conversation.
 * @returns {string} the sidecar directory
 */
function writeReviewerSidecars(configDir, hostId, at, agents, forgeSessionId) {
  const dir = path.join(configDir, 'projects', '-scratch', hostId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [agentId, { description, stoppedByUser, requests }] of Object.entries(agents)) {
    const named =
      forgeSessionId && /^forge-review\s+\S+$/.test(description)
        ? `${description} ${forgeSessionId}`
        : description;
    const meta = { agentType: 'general-purpose', description: named, model: 'opus' };
    if (stoppedByUser !== undefined) meta.stoppedByUser = stoppedByUser;
    fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf8');
    const count = requests ?? FINAL_REVIEW_REQUEST_FLOOR;
    const lines = Array.from({ length: count }, (_, i) => ({
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
      // r1's `forge-review final` sidecar is on record for this session, so
      // this pass saw the deciding unit.
      unitOnRecord: true,
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
    assert.deepEqual(measured, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
      // r1's `forge-review final` sidecar is on record at `finish`.
      unitOnRecord: true,
    });
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
      // Only `group-01` was dispatched — no unit keyed `final` is on record.
      unitOnRecord: false,
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
      // configDir was removed before this pass — the host is entirely
      // unavailable, so nothing could have been on record.
      unitOnRecord: false,
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
      // No host is bound at all in this fixture — nothing could be on record.
      unitOnRecord: false,
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
      // r1's `forge-review final` sidecar is on record at `finish`.
      unitOnRecord: true,
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
      // The `done` pass itself sees no `final` unit (sidecars pruned) — this
      // stays `true` only because the keep rule preserves the verdict frozen
      // at `finish` untouched; it is not remeasured this pass.
      unitOnRecord: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a frozen verdict with no unit ever on record still refreshes and refuses — the discriminator', () => {
  // F49/F52. This is what separates "read `unitOnRecord`" from the simpler,
  // wrong fix this design rejected: "protect every frozen `independent`". The
  // two rules agree on every other test in this file and disagree only here.
  //
  // `finish` freezes `independent`/`inferred` with NO host bound at all, so
  // `unitOnRecord` freezes `false` — there was never a unit on record to see,
  // not merely one that later went missing. `done` then binds a host that
  // genuinely dispatched nothing (`seen === 0`), which grades `self`/`host` —
  // the one genuine negative `hostFinalReview` produces. Absence where an
  // earlier pass had no record either is a real finding, not a pruned one, and
  // the verdict MUST be replaced and the gate MUST refuse.
  //
  // Under the correct rule, `frozen.unitOnRecord` is `false`, so `measured` is
  // `false` and the fresh `self`/`host` negative overwrites — refuses, as
  // required. Under "protect every frozen independent", `measured` would be
  // `true` from `frozen.final === 'independent'` alone, `sawTheUnit` at `done`
  // is `false` (nothing dispatched), and the stale `independent` would be kept
  // — silently passing a session with no independent review at all. Twin of
  // "a below-floor final dispatch on record survives its sidecar being pruned"
  // below: same shape, and the only fixture difference is whether a `final`
  // unit was ever on record at `finish`.
  const dir = tmp('forge-verdict-discriminator-');
  const configDir = tmp('forge-verdict-discriminator-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-discriminator');
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);

    // No host env at all: nothing is bound, so nothing could have been on
    // record, and the prose alone decides `independent`/`inferred`.
    runSetPhase(dir, ['finish']);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'inferred',
      stoppedByOperator: false,
      unitOnRecord: false,
    });

    // A host is bound for the first time at `done`, and it genuinely
    // dispatched nothing: the sidecar directory exists and scans clean.
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-discriminator', createdAt);
    writeReviewerSidecars(configDir, 'host-discriminator', createdAt, {});
    const env = { CLAUDE_CODE_SESSION_ID: 'host-discriminator', CLAUDE_CONFIG_DIR: configDir };

    assert.throws(
      () => runSetPhase(dir, ['done'], env),
      /self-authored/,
      'no unit was ever on record — a fresh nothing-dispatched reading must still refuse',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase,
      'finish',
      'the refused transition must not persist',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a below-floor final dispatch on record survives its sidecar being pruned — F49/F52', () => {
  // F49/F52, the reproduction. `finish` grades `independent`/`inferred` here
  // for a different reason than the discriminator above: a genuine, unstopped
  // `final` dispatch IS on record, but it made fewer than
  // `FINAL_REVIEW_REQUEST_FLOOR` requests, so `hostFinalReview` answers `null`
  // — "the host cannot certify this" — and the census falls back to the review
  // file's prose. `unitOnRecord` freezes `true` regardless: the dispatch is in
  // `evidence.units.final`, it simply did not carry enough substance to
  // certify the review on its own. `inferred`-with-the-unit-on-record and "no
  // unit was ever on record" (the discriminator above) are different facts,
  // and the old rule — `frozen?.evidence === 'host'` — conflated them by
  // protecting neither.
  //
  // The host then prunes the sidecar directory overnight — files gone, the
  // directory itself left behind, which is what real pruning looks like and
  // what makes `seen === 0` at `done`. `seen === 0` grades `self`/`host` —
  // "nothing was dispatched" — the one genuine negative `hostFinalReview`
  // produces. Today the frozen verdict is graded `inferred`, so the old
  // `measured` conjunct is false, the negative overwrites it, and
  // `enforceFinalReviewFloor` refuses `done` on a change that was
  // independently reviewed — permanently, because `saveSession` runs after the
  // gate's `process.exit(1)` and every retry repeats the same refusal.
  const dir = tmp('forge-verdict-below-floor-');
  const configDir = tmp('forge-verdict-below-floor-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-below-floor');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-below-floor', createdAt);
    writeReviewerSidecars(
      configDir,
      'host-below-floor',
      createdAt,
      { r1: { description: 'forge-review final', requests: FINAL_REVIEW_REQUEST_FLOOR - 1 } },
      'sess-below-floor',
    );
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    const env = { CLAUDE_CODE_SESSION_ID: 'host-below-floor', CLAUDE_CONFIG_DIR: configDir };

    runSetPhase(dir, ['finish'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'inferred',
      stoppedByOperator: false,
      // r1's `forge-review final` dispatch is on record at `finish` — just
      // below the floor, so the host cannot certify it and the prose decides.
      unitOnRecord: true,
    });

    // The host prunes the sidecars: the directory survives, reads cleanly,
    // and is simply empty — exactly `seen === 0`.
    const sidecars = path.join(configDir, 'projects', '-scratch', 'host-below-floor', 'subagents');
    for (const name of fs.readdirSync(sidecars)) fs.rmSync(path.join(sidecars, name));

    runSetPhase(dir, ['done'], env);
    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(
      after.phase,
      'done',
      'the transition must not be refused on a review that really happened',
    );
    assert.deepEqual(after.reviewVerdict, {
      final: 'independent',
      evidence: 'inferred',
      stoppedByOperator: false,
      unitOnRecord: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a pre-existing independent/host verdict with no unitOnRecord key is still protected — the compatibility arm', () => {
  // The `??` fallback exists for exactly one population: verdicts frozen before
  // this field existed, which have no `unitOnRecord` key at all. Since 1.3
  // `set-phase.mjs` always writes the key, so nothing in this suite freezes
  // that shape by running the binary — this test hand-writes it directly onto
  // `session.json`, the only way a pre-existing verdict actually looks, and
  // proves the fallback keeps behaving exactly as `frozen.evidence === 'host'`
  // did before this change.
  const dir = tmp('forge-verdict-legacy-host-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-legacy-host');
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.reviewVerdict = { final: 'independent', evidence: 'host', stoppedByOperator: false };
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    // No host is bound this pass, so an unprotected reading falls back to the
    // review file's prose alone — and that prose reads self.
    writeFinalReview(sessionDir, SELF_PROSE);

    runSetPhase(dir, ['done']);

    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(
      after.phase,
      'done',
      'a legacy host-graded verdict must protect the transition exactly as it did before this field existed',
    );
    assert.deepEqual(after.reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-existing independent/inferred verdict with no unitOnRecord key still refreshes — the compatibility arm', () => {
  // Twin of the test above: the same legacy shape, but `evidence: 'inferred'`,
  // which the fallback must still fail to protect — precisely because
  // `frozen.evidence === 'host'` was false for this grade before this field
  // existed, and absent `unitOnRecord` must fall back to that same answer, not
  // to "protect it anyway".
  const dir = tmp('forge-verdict-legacy-inferred-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-legacy-inferred');
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    raw.reviewVerdict = { final: 'independent', evidence: 'inferred', stoppedByOperator: false };
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    writeFinalReview(sessionDir, SELF_PROSE);

    assert.throws(
      () => runSetPhase(dir, ['done']),
      /self-authored/,
      'a legacy inferred verdict must refresh, exactly as it did before this field existed',
    );
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'plan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
      // r1's `forge-review final` sidecar is on record at `finish`.
      unitOnRecord: true,
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
      // r1's unit is still `final` even though this dispatch was stopped — the
      // unit is on record, it simply did not finish.
      unitOnRecord: true,
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
      // The sidecar directory is empty at `finish` — no `final` unit yet.
      unitOnRecord: false,
    });

    writeReviewerSidecars(configDir, 'host-refresh', createdAt, {
      r1: { description: 'forge-review final' },
    }, 'sess-refresh');
    runSetPhase(dir, ['done'], env);

    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
      // r1's `forge-review final` sidecar was added before this pass.
      unitOnRecord: true,
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
      // r1's unit is `final`, on record, even though it was stopped.
      unitOnRecord: true,
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

// ---------------------------------------------------------------------------
// The dispatch stamp, at the gate. `forge review-label` writes one stamp into
// `reviews/dispatches.json` when it prints the label a reviewer subagent is
// dispatched with; `review-census.mjs` reads it back as `finalReviewEvidence:
// 'recorded'` when the host cannot answer and no stamp-eligible `final` bucket
// was measured. `review-census.test.mjs` pins the census function directly;
// these three pin the same grade through the real gate — `set-phase.mjs` →
// `reviewEvidence` → `reviewCensus` → `readStamps` — with the real `writeStamp`
// from `review-stamp.mjs`, never hand-rolled JSON.
// ---------------------------------------------------------------------------

test('phase done freezes independent/recorded from a dispatch stamp when host evidence cannot answer — and the same fixture refuses without it', () => {
  // THE DISCRIMINATING CONTROL is built into this one test rather than left to
  // a neighbour: the fixture's prose is a self-declaration (`self-check` in
  // the attribution region), so a census that merely read the file and agreed
  // with it would grade `inferred`, not `recorded` — the A/B below pins that
  // the grade the stamped pass reaches is not that one. And without the
  // stamp, this exact fixture — high-risk, no host, self-declaring prose —
  // refuses, which is what makes the stamped pass a measurement rather than a
  // gate that would have passed regardless. What this test does NOT pin is
  // that the prose goes entirely unread on the stamped path: a mutant that
  // uses the stamp as a tiebreak alongside the prose, rather than letting it
  // decide outright, still passes this exact test — this fixture's
  // self-declaring prose happens to land the tiebreak branch on the same
  // verdict the real one reaches. `review-census.test.mjs`'s "the stamp
  // DECIDES — it is not a tiebreak applied to the prose" pins that stronger
  // property directly, with a fixture built to tell the two apart.
  const dir = tmp('forge-verdict-recorded-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-recorded');
    writeFinalReview(sessionDir, SELF_PROSE);
    assert.equal(reviewCensus(sessionDir).finalReview, 'self', 'fixture: prose alone says self');

    // No host bound (runSetPhase strips it) and no stamp yet: the census falls
    // straight to the self-declaring prose, and the floor refuses.
    assert.throws(() => runSetPhase(dir, ['done']), /self-authored/);
    assert.equal(
      JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase,
      'plan',
      'the refused control must not have transitioned',
    );

    // The real writer: `forge review-label` calls this at dispatch time, before
    // any subagent exists.
    writeStamp(sessionDir, {
      unit: 'final',
      label: 'forge-review final sess-recorded',
      sessionId: 'sess-recorded',
    });

    runSetPhase(dir, ['done']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.deepEqual(session.reviewVerdict, {
      final: 'independent',
      evidence: 'recorded',
      stoppedByOperator: false,
      // Host evidence was never available on either pass, so no `final` unit
      // was ever on record to see — the stamp answered instead.
      unitOnRecord: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a frozen recorded verdict refreshes when a later pass sees the host record an all-stopped final dispatch', () => {
  // "The host's answer outranks the stamp" surviving the freeze. Derived from
  // the code, not asserted from the brief: the keep rule is `measured &&
  // !remeasured && !sawTheUnit`, and `sawTheUnit` is this pass's own reading —
  // whether the host's record has a `final` unit at all, independent of
  // `measured` or of what froze earlier. The second pass here binds a host
  // whose `final` dispatch was stopped, so `sawTheUnit` is true and
  // `!sawTheUnit` alone sinks the keep condition: a pass that sees the
  // deciding unit on the host's own record always refreshes, because seeing
  // it is new information about the thing being judged, regardless of what
  // `measured` would have evaluated to. The frozen verdict here does carry
  // `unitOnRecord: false` — true of the shape a stamp-only freeze leaves,
  // since there was no unit on record for that earlier pass to see — but it
  // is description, not the operative cause of this refresh: `sawTheUnit`
  // decides it on this pass alone. A `recorded` grade fits the same asymmetry
  // `freezeReviewVerdict`'s own comment draws between a stale negative (never
  // protected) and a stale positive measured on `host` (protected) — it
  // substituted for a record the host had not yet answered, not for one it
  // measured.
  const dir = tmp('forge-verdict-recorded-refresh-');
  const configDir = tmp('forge-verdict-recorded-refresh-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-recorded-refresh');
    writeFinalReview(sessionDir, SELF_PROSE);
    writeStamp(sessionDir, {
      unit: 'final',
      label: 'forge-review final sess-recorded-refresh',
      sessionId: 'sess-recorded-refresh',
    });

    // No host bound at `finish`: the stamp is the only evidence, and the
    // self-declaring prose is never read.
    runSetPhase(dir, ['finish']);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'recorded',
      stoppedByOperator: false,
      unitOnRecord: false,
    });

    // A host is now bound, and its record shows the final reviewer's only
    // dispatch was stopped by the operator — `hostFinalReview`'s one genuine
    // negative, reached by measurement rather than absence.
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-recorded-refresh', createdAt);
    writeReviewerSidecars(
      configDir,
      'host-recorded-refresh',
      createdAt,
      { r1: { description: 'forge-review final', stoppedByUser: true } },
      'sess-recorded-refresh',
    );
    const env = { CLAUDE_CODE_SESSION_ID: 'host-recorded-refresh', CLAUDE_CONFIG_DIR: configDir };

    assert.throws(() => runSetPhase(dir, ['done'], env), /self-authored/);
    assert.equal(
      JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase,
      'finish',
      'the refusal did not persist',
    );

    // The operator owns the decision themselves; what gets recorded is the
    // re-frozen verdict — host, not the stamp's recorded grade.
    runSetPhase(
      dir,
      ['done', '--final-review-waived', 'host now shows the reviewer was stopped'],
      env,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'self',
      evidence: 'host',
      stoppedByOperator: true,
      // r1's unit is `final`, on record, even though it was stopped.
      unitOnRecord: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a frozen host independent verdict is kept — not downgraded to recorded — when the host fixture is gone but the stamp survives', () => {
  // The mirror of the two tests above: a verdict measured on `host` grade must
  // stay `host`, never quietly re-graded `recorded` because a stamp happens to
  // be sitting on disk too — the ordinary case, since `forge review-label`
  // writes the stamp before the subagent it names ever runs. The keep rule
  // fires here (`measured && !remeasured && !sawTheUnit`) precisely because
  // this frozen verdict has `unitOnRecord: true`, unlike the `recorded`-frozen
  // shape above.
  const dir = tmp('forge-verdict-host-keep-stamp-');
  const configDir = tmp('forge-verdict-host-keep-stamp-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, 'sess-host-keep-stamp');
    const { createdAt } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    writeHostTranscript(configDir, 'host-keep-stamp', createdAt);
    writeReviewerSidecars(
      configDir,
      'host-keep-stamp',
      createdAt,
      { r1: { description: 'forge-review final' } },
      'sess-host-keep-stamp',
    );
    writeFinalReview(sessionDir, INDEPENDENT_PROSE);
    // The same dispatch was stamped too, as `forge review-label` would.
    writeStamp(sessionDir, {
      unit: 'final',
      label: 'forge-review final sess-host-keep-stamp',
      sessionId: 'sess-host-keep-stamp',
    });
    const env = { CLAUDE_CODE_SESSION_ID: 'host-keep-stamp', CLAUDE_CONFIG_DIR: configDir };

    runSetPhase(dir, ['finish'], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).reviewVerdict, {
      final: 'independent',
      evidence: 'host',
      stoppedByOperator: false,
      unitOnRecord: true,
    });

    // The host fixture is gone entirely at `done` — pruned exactly as in "the
    // frozen verdict … survive the host pruning the transcript" above — but
    // the stamp lives under the session directory and survives it.
    fs.rmSync(configDir, { recursive: true, force: true });

    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    delete base.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [SCRIPT, 'done'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...base, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Kept the review verdict/);

    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(after.phase, 'done');
    assert.deepEqual(
      after.reviewVerdict,
      {
        final: 'independent',
        evidence: 'host',
        stoppedByOperator: false,
        unitOnRecord: true,
      },
      'a still-surviving stamp answering `recorded` must never replace a verdict already measured on `host`',
    );
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

test('phase done refuses a double-reopened finding for the session change', () => {
  const dir = tmp('forge-reopen-gate-refuse-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-reopen-refuse');
    const sessionDir = path.dirname(sessionFile);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    session.openspecChange = 'fix-parser';
    fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    makeDoneable(sessionDir);
    fs.writeFileSync(
      path.join(dir, '.forge', 'findings.jsonl'),
      `${JSON.stringify({
        id: 'F11',
        status: 'open',
        change: 'fix-parser',
        reopenCount: 2,
        text: 'parser regression returned',
      })}\n`,
      'utf8',
    );

    assert.throws(() => runSetPhase(dir, ['done']), /F11/);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'plan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done records a reopen waiver for a double-reopened finding', () => {
  const dir = tmp('forge-reopen-gate-waive-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-reopen-waive');
    const sessionDir = path.dirname(sessionFile);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    session.openspecChange = 'fix-parser';
    fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    makeDoneable(sessionDir);
    fs.writeFileSync(
      path.join(dir, '.forge', 'findings.jsonl'),
      `${JSON.stringify({
        id: 'F11',
        status: 'open',
        change: 'fix-parser',
        reopenCount: 2,
        text: 'parser regression returned',
      })}\n`,
      'utf8',
    );

    runSetPhase(dir, ['done', '--reopen-waived', 'root cause accepted for follow-up']);
    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(after.phase, 'done');
    assert.equal(after.reopenWaived, 'root cause accepted for follow-up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase done ignores findings reopened only once or without a change', () => {
  const dir = tmp('forge-reopen-gate-narrow-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-reopen-narrow');
    const sessionDir = path.dirname(sessionFile);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    session.slug = 'fix-parser';
    fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    makeDoneable(sessionDir);
    fs.writeFileSync(
      path.join(dir, '.forge', 'findings.jsonl'),
      `${[
        {
          id: 'F11',
          status: 'open',
          change: 'fix-parser',
          reopenCount: 1,
          text: 'parser regression returned once',
        },
        {
          id: 'F12',
          status: 'open',
          change: null,
          reopenCount: 2,
          text: 'unscoped regression',
        },
      ]
        .map((finding) => JSON.stringify(finding))
        .join('\n')}\n`,
      'utf8',
    );

    runSetPhase(dir, ['done']);
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).phase, 'done');
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
  // `saveSession`. That is what keeps a wrong positive from being pinned to
  // the session for good — for example a verdict `reviewEvidence` still
  // answers confidently from a partial binding, such as a session bound to two
  // host sessions whose older transcript has been pruned (an *unreadable*
  // binding is F27, owned by `host.mjs`, and is refused rather than answered;
  // a genuinely pruned one answers `available: true` with the `final` unit
  // simply missing, and F12's dispatch stamp, where a valid one exists,
  // overrides that absence-negative one layer up in `review-census.mjs` (D4),
  // grading `recorded` — see "the done gate does not refuse a stamped session
  // whose absence-negative came from half a binding" below): a refused pass
  // leaves the session exactly as it was, so the next one measures again.
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
      // Both r1 and r2 are keyed `final` — the unit is on record regardless
      // of r1's stop.
      unitOnRecord: true,
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

test('the done gate does not refuse a stamped session whose absence-negative came from half a binding', () => {
  // D4, end to end, and the only test that proves `partial` reaches the census
  // at all: `freezeReviewVerdict()` builds the evidence object and hands it
  // straight to `reviewCensus` by reference, so the flag `reviewEvidence` added
  // arrives with no wiring of its own — this is what shows it actually does.
  //
  // The reproduced F58 residual: the session is bound to two host sessions (the
  // ordinary shape — `bindHost` appends an id every time the work is resumed)
  // and the older transcript has been pruned. The surviving half answers
  // `available: true`, carries a prescribed `group-01` dispatch so the adoption
  // gate is defeated and the convention reads as in use, and has no `final`
  // unit — because the final reviewer ran in the pruned half. Before this
  // change that read as `hostFinalReview`'s one genuine negative, the gate
  // refused, and the remedy it printed had already been followed.
  //
  // The prose is a self-check on purpose. It makes the fixture discriminate in
  // both wrong directions: falling through to the file answers `self`/`inferred`
  // and still refuses, so only the stamp deciding gets this session through.
  const SESSION_ID = 'sess-partial-stamp';
  const LIVE_HOST_ID = 'host-partial-live';
  const PRUNED_HOST_ID = 'host-partial-pruned';
  const dir = tmp('forge-partial-stamp-');
  const configDir = tmp('forge-partial-stamp-cfg-');
  try {
    const { sessionFile, sessionDir } = makeHighRiskFixture(dir, SESSION_ID);
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    // Bound to both, oldest first — `bindHost` will find the live id already
    // present and leave the binding alone.
    raw.host = {
      agent: 'claude-code',
      sessionIds: [PRUNED_HOST_ID, LIVE_HOST_ID],
      boundAt: raw.createdAt,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    // Only the newer transcript is on disk. PRUNED_HOST_ID is never written
    // anywhere under `projects/` — pruned, not blocked, which is the case
    // `reviewEvidence` answers from the surviving half rather than refusing.
    writeHostTranscript(configDir, LIVE_HOST_ID, raw.createdAt);
    writeReviewerSidecars(
      configDir,
      LIVE_HOST_ID,
      raw.createdAt,
      { g1: { description: 'forge-review group-01' } },
      SESSION_ID,
    );
    assert.equal(
      fs.existsSync(path.join(configDir, 'projects', '-scratch', `${PRUNED_HOST_ID}.jsonl`)),
      false,
      'fixture: the older half really is gone',
    );

    writeFinalReview(sessionDir, SELF_PROSE);
    assert.equal(reviewCensus(sessionDir).finalReview, 'self', 'fixture: prose alone says self');

    // The real writer, at the time `forge review-label` printed the label —
    // in the half of the conversation that has since been pruned.
    writeStamp(sessionDir, {
      unit: 'final',
      label: `forge-review final ${SESSION_ID}`,
      sessionId: SESSION_ID,
    });

    runSetPhase(dir, ['done'], {
      CLAUDE_CODE_SESSION_ID: LIVE_HOST_ID,
      CLAUDE_CONFIG_DIR: configDir,
    });

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'done');
    assert.deepEqual(session.reviewVerdict, {
      final: 'independent',
      evidence: 'recorded',
      stoppedByOperator: false,
      // The surviving half's record has no `final` unit in it — that absence
      // IS the negative this override answered over, so nothing was on record
      // for this pass to see.
      unitOnRecord: false,
    });
    assert.equal(session.finalReviewWaived, undefined, 'and no waiver was applied for it');
    assert.deepEqual(
      session.host.sessionIds,
      [PRUNED_HOST_ID, LIVE_HOST_ID],
      'fixture: the binding really was partial at the moment of measurement',
    );
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
