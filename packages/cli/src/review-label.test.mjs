import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { reviewLabel } from './review-label.mjs';
import { readReviewerSidecars } from './metrics/review-evidence.mjs';
import { fsFaultEnv } from './test-support/fs-fault.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-label-cli.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A project with one active session, as `forge new` leaves it. */
function makeProject(sessionId) {
  const dir = tmp('forge-review-label-');
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: sessionId, slug: 'demo', createdAt: '2026-07-28T10:00:00.000Z' })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId })}\n`,
  );
  return dir;
}

function run(dir, args = [], { faults = [] } = {}) {
  const env = faults.length > 0 ? fsFaultEnv(faults) : process.env;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });
}

/** Plant one sidecar pair carrying `description`, and read it back. */
function recordFor(description) {
  const dir = tmp('forge-review-label-sidecar-');
  fs.writeFileSync(
    path.join(dir, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description, model: 'opus' }),
  );
  fs.writeFileSync(
    path.join(dir, 'agent-a1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      requestId: 'r1',
      timestamp: '2026-07-28T10:30:00.000Z',
      message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'text' }], usage: {} },
    })}\n`,
  );
  return readReviewerSidecars(dir)[0] ?? null;
}

test('what the command prints is what the matcher accepts', () => {
  // THE CONTRACT THIS FILE EXISTS FOR. The description is the join between a
  // review artifact and the host's record of the subagent that wrote it, and it
  // decides the money/auth gate. A drift between the string Forge tells the
  // coordinator to use and the string Forge later matches is silent: the
  // dispatch simply stops being found, and a change with a real independent
  // reviewer reads as self-reviewed.
  //
  // So this asserts the round trip through the *real* reader rather than
  // against a second copy of the pattern, which would drift with it.
  const sessionId = '20260728T192454Z-demo-abc123';
  const dir = makeProject(sessionId);

  for (const unit of ['final', 'group-03', 'group-03-collector', 'g1', 'a.b_c-d']) {
    const printed = run(dir, [unit]);
    assert.equal(printed.status, 0, printed.stderr);

    const label = printed.stdout.trim();
    assert.equal(label, reviewLabel(unit, sessionId));

    const record = recordFor(label);
    assert.ok(record, `the matcher found no review dispatch in ${JSON.stringify(label)}`);
    assert.equal(record.unit, unit.toLowerCase());
    assert.equal(
      record.forgeSessionId,
      sessionId,
      'the label must attribute the dispatch to the session that printed it',
    );
  }
});

test('the default unit is the one that decides the gate', () => {
  // `final` is the only unit the census reads. A coordinator who runs the
  // command with no argument is asking for the label that matters, and getting
  // a group label there would be a silent miss at the floor.
  const dir = makeProject('20260728T192454Z-demo-abc123');
  const bare = run(dir);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout.trim(), run(dir, ['final']).stdout.trim());
  assert.equal(recordFor(bare.stdout.trim()).unit, 'final');
});

test('a unit the matcher could not read is refused at the source', () => {
  // Failing here is a message; failing at the gate is a refused change with no
  // diagnosis, weeks later, on evidence that has since been pruned.
  const dir = makeProject('20260728T192454Z-demo-abc123');
  for (const bad of ['not a unit', '-leading-dash', '', '#nope']) {
    const r = run(dir, [bad]);
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a dangling pointer resolves to the one live session, and to nothing otherwise', () => {
  // `forge cleanup` deletes a finished session's directory and leaves
  // `active.json` naming it. With exactly one session still open there is no
  // ambiguity, so resolving to it is the useful answer.
  const dir = makeProject('20260728T192454Z-demo-abc123');
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'cleaned-away-abc999' })}\n`,
  );

  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), reviewLabel('final', '20260728T192454Z-demo-abc123'));

  // With nothing left to resolve to, it fails rather than inventing a label:
  // an unmatchable label reads as "no outside reader" at the gate.
  const empty = tmp('forge-review-label-empty-');
  fs.mkdirSync(path.join(empty, '.forge', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(empty, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'cleaned-away-abc999' })}\n`,
  );
  const none = run(empty);
  assert.notEqual(none.status, 0);
  assert.equal(none.stdout.trim(), '');
  assert.match(none.stderr, /cleaned-away-abc999/);
});

test('--session names a session other than the active one', () => {
  const dir = makeProject('20260728T192454Z-demo-abc123');
  const other = '20260727T090000Z-other-def456';
  const sessionDir = path.join(dir, '.forge', 'sessions', other);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify({ id: other })}\n`);

  const r = run(dir, ['final', '--session', other]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), reviewLabel('final', other));
});

test('the label module is importable in a project with no active session', () => {
  // Regression, found by the final review. `reviewLabel` and the CLI shared a
  // file, so importing the function ran `process.exit(1)` when `active.json`
  // was absent — and `active.json` is gitignored. Every test in this file died
  // on a clean checkout, including the one pinning the label↔matcher round
  // trip, while passing on the machine that wrote them.
  const dir = tmp('forge-review-label-noactive-');
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { reviewLabel, isReviewUnit } from ${JSON.stringify(
        pathToFileURL(path.join(path.dirname(SCRIPT), 'review-label.mjs')).href,
      )};
       process.stdout.write(reviewLabel('final', 's1') + '|' + isReviewUnit('final'));`,
    ],
    { cwd: dir, encoding: 'utf8' },
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, 'forge-review final s1|true');
});

test('two unfinished sessions are refused, not guessed between', () => {
  // C1 from the final review, reproduced twice through two mechanisms. The
  // label decides which session is credited with the reviewer, and guessing
  // wrong is silent *and* fails open: the dispatch record is filed against the
  // other session, which then passes the money/auth floor on a reviewer that
  // read someone else's change.
  //
  // A stderr warning was tried and is not enough — the consumer is an agent
  // following an instruction that tells it the string is its own.
  const dir = makeProject('20260728T192454Z-newer-bbb222');
  const older = '20260727T090000Z-older-aaa111';
  const olderDir = path.join(dir, '.forge', 'sessions', older);
  fs.mkdirSync(olderDir, { recursive: true });
  fs.writeFileSync(
    path.join(olderDir, 'session.json'),
    `${JSON.stringify({ id: older, slug: 'older', phase: 'review' })}\n`,
  );

  const r = run(dir);
  assert.notEqual(r.status, 0, 'a guess here is a silent fail-open');
  assert.equal(r.stdout.trim(), '', 'no label at all is better than the wrong one');
  assert.match(r.stderr, /Refusing to guess/i);
  // Both candidates named, each as the flag that resolves it.
  assert.match(r.stderr, new RegExp(`--session ${older}`));
  assert.match(r.stderr, /--session 20260728T192454Z-newer-bbb222/);

  // And naming one is accepted.
  const named = run(dir, ['final', '--session', older]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stdout.trim(), reviewLabel('final', older));
});

test('the resolved session is always announced, and never on stdout', () => {
  // The label is a bare string on stdout so it can be piped or copied whole;
  // the session it names goes to stderr, because the failure this guards is a
  // coordinator not noticing which session they just labelled.
  const dir = makeProject('20260728T192454Z-demo-abc123');
  const r = run(dir, ['group-02']);

  assert.equal(r.stdout, `${reviewLabel('group-02', '20260728T192454Z-demo-abc123')}\n`);
  assert.match(r.stderr, /labelling session 20260728T192454Z-demo-abc123 \(demo\)/);
  assert.match(r.stderr, /--session/, 'and how to label a different one');

  // Named explicitly, it must not claim to have read active.json.
  const explicit = run(dir, ['final', '--session', '20260728T192454Z-demo-abc123']);
  assert.match(explicit.stderr, /labelling session/);
  assert.equal(/active\.json/.test(explicit.stderr), false);
});

test('a session that cannot be read is a candidate, not a silent drop', () => {
  // The refusal restored round 5's C1 in miniature: an unreadable neighbour was
  // skipped, leaving exactly one candidate, so the command happily labelled the
  // other session — and the stderr line claimed it came from `active.json`.
  // "I could not read it" is not "it is finished"; only a *missing*
  // `session.json` means the directory is not a session at all.
  const dir = makeProject('20260728T192454Z-demo-abc123');
  const broken = path.join(dir, '.forge', 'sessions', '20260727T090000Z-broken-bbb222');
  fs.mkdirSync(broken, { recursive: true });

  const sessionFile = path.join(broken, 'session.json');
  for (const [label, prepare, faults = []] of [
    ['truncated', () => fs.writeFileSync(sessionFile, '{"id":"bro')],
    [
      'unreadable',
      () => fs.writeFileSync(sessionFile, '{}'),
      [{ method: 'readFileSync', path: sessionFile, code: 'EACCES' }],
    ],
  ]) {
    prepare();
    const r = run(dir, [], { faults });
    assert.notEqual(r.status, 0, `${label}: guessed instead of refusing`);
    assert.equal(r.stdout.trim(), '', label);
    assert.match(r.stderr, /Refusing to guess/i, label);
    assert.match(r.stderr, /unreadable/i, `${label}: and says why it cannot judge it`);
  }

  // A directory with no session.json at all is genuinely not a session, and
  // must not block an otherwise unambiguous project.
  fs.rmSync(path.join(broken, 'session.json'));
  const ok = run(dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), reviewLabel('final', '20260728T192454Z-demo-abc123'));
});

test('a sessions directory that cannot be enumerated refuses, it does not guess', () => {
  // Round 7. `unfinishedSessions` had a *second* bare catch — on the
  // `readdirSync` itself — identical to the one fixed a level down for
  // `session.json`, and missed because the reproduction that found the first
  // one never reached it. `chmod 111 .forge/sessions`, or plain fd exhaustion,
  // turned the entire ambiguity check off: exit 0, and a guess.
  //
  // Provoked with ENOTDIR rather than a permission bit, so it is deterministic
  // and does not silently pass when the suite runs as root.
  const dir = tmp('forge-review-label-unenumerable-');
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'sessions'), 'not a directory');
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: '20260728T192454Z-demo-abc123' })}\n`,
  );

  const r = run(dir);
  assert.notEqual(r.status, 0, 'could not look is not "only one session"');
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /could not read/i);
  assert.match(r.stderr, /--session/, 'and names the way out');

  // Discriminating control: an *empty* sessions directory is a measurement, not
  // a failure, so it must not produce this message. Without this the assertion
  // above passes against any refusal at all — the round-8 reviewer found the
  // original second assertion was a tautology for exactly that reason.
  const empty = tmp('forge-review-label-emptydir-');
  fs.mkdirSync(path.join(empty, '.forge', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(empty, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'nothing-here-abc123' })}\n`,
  );
  const none = run(empty);
  assert.notEqual(none.status, 0);
  assert.equal(
    /could not read .*sessions/i.test(none.stderr),
    false,
    'an empty directory was read successfully — it must not report a read failure',
  );
});

test('the provenance line distinguishes the pointer from the only open session', () => {
  // Round 7 fixed the line to stop claiming `.forge/active.json` when the
  // pointer had been overridden — and round 8 showed the fix was unpinned: the
  // mutant restoring the lie killed nothing, because no test read the string.
  // The line exists so a coordinator can see *which* session was labelled and
  // on what basis; a false basis is worse than none.
  const dir = makeProject('20260728T192454Z-live-aaa111');
  const finished = path.join(dir, '.forge', 'sessions', '20260729T090000Z-done-bbb222');
  fs.mkdirSync(finished, { recursive: true });
  fs.writeFileSync(
    path.join(finished, 'session.json'),
    `${JSON.stringify({ id: '20260729T090000Z-done-bbb222', slug: 'done', phase: 'done' })}\n`,
  );

  // Pointer names the live session: it came from the pointer.
  const viaPointer = run(dir);
  assert.match(viaPointer.stderr, /from \.forge\/active\.json/);

  // Pointer names the finished one: resolution came from "the only one open",
  // and saying "from active.json" here would be a lie.
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: '20260729T090000Z-done-bbb222' })}\n`,
  );
  const viaOnlyOpen = run(dir);
  assert.equal(viaOnlyOpen.stdout.trim(), reviewLabel('final', '20260728T192454Z-live-aaa111'));
  assert.match(viaOnlyOpen.stderr, /the only session still open here/);
  assert.equal(
    /from \.forge\/active\.json/.test(viaOnlyOpen.stderr),
    false,
    'the pointer named a finished session — it must not be credited',
  );
});

test('a missing sessions directory is a measurement; an unreadable one is not', () => {
  // Round 8: the mutant collapsing both into `return null` killed nothing,
  // because only the failure half was covered. ENOENT means the project has no
  // sessions yet — there is nothing to be ambiguous about, and refusing would
  // block a first run.
  const fresh = tmp('forge-review-label-nosessions-');
  fs.mkdirSync(path.join(fresh, '.forge'), { recursive: true });
  fs.writeFileSync(
    path.join(fresh, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'nothing-abc123' })}\n`,
  );

  const r = run(fresh);
  assert.notEqual(r.status, 0, 'there is still no session to label');
  assert.equal(
    /Refusing to guess/.test(r.stderr),
    false,
    'an absent sessions dir is not ambiguity — it is emptiness',
  );
  assert.match(r.stderr, /nothing-abc123/, 'it fails on the session, not on the directory');
});

test('session ids are matched case-sensitively', () => {
  // A mutant lower-casing the id on either side of the join survived five
  // review rounds. Real ids carry an upper-case `T` and `Z` in their timestamp,
  // so a case-folding join would let `…T192454Z-a` and `…t192454z-a` claim each
  // other's reviewers — the whole defect this change exists to close, wearing a
  // different hat.
  const sessionId = '20260728T192454Z-Demo-abc123';
  const dir = makeProject(sessionId);
  const label = run(dir).stdout.trim();
  assert.equal(label, reviewLabel('final', sessionId));

  assert.equal(recordFor(label).forgeSessionId, sessionId, 'carried through verbatim');
  assert.notEqual(
    recordFor(reviewLabel('final', sessionId.toLowerCase())).forgeSessionId,
    sessionId,
    'a case-folded id is a different session and must not match',
  );
});
