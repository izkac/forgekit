import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { reviewLabel } from './review-label.mjs';
import { readStamps } from './review-stamp.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-label-cli.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A project with one active session, as `forge new` leaves it. */
function makeProject(sessionId) {
  const dir = tmp('forge-review-label-cli-');
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: sessionId, slug: 'demo', phase: 'implement' })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId })}\n`,
  );
  return { dir, sessionDir };
}

function run(dir, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

test('forge review-label final stamps the dispatch and stdout stays exactly the label', () => {
  const sessionId = '20260731T105409Z-stamp-demo-abc123';
  const { dir, sessionDir } = makeProject(sessionId);
  try {
    const r = run(dir, ['final']);
    assert.equal(r.status, 0, r.stderr);

    const expectedLabel = reviewLabel('final', sessionId);
    assert.equal(r.stdout, `${expectedLabel}\n`, 'stdout must be exactly the label plus newline');

    // The write->read round trip through the public reader, not a second copy
    // of the on-disk shape — that would drift with it.
    const stamps = readStamps(sessionDir);
    assert.equal(stamps.length, 1, `expected exactly one stamp, got ${JSON.stringify(stamps)}`);
    const [stamp] = stamps;
    assert.equal(stamp.unit, 'final');
    assert.equal(stamp.label, r.stdout.trim());
    assert.equal(stamp.sessionId, sessionId);
    assert.ok(!Number.isNaN(Date.parse(stamp.at)), `at was not parsable: ${stamp.at}`);
    assert.equal(stamp.model.tier, 'capable', 'default tier is capable');
    assert.ok(
      typeof stamp.model.agent === 'string' && stamp.model.agent.length > 0,
      'agent is env-dependent — assert only that it is a non-empty string',
    );

    assert.match(r.stderr, /stamped dispatch/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('combined ceremony: final label defaults to standard tier, refuses capable without --full-tail', () => {
  // Cohort 4: a session that resolved `combined` dispatched a capable-tier
  // final reviewer anyway — 90 tail requests on the trial marked for the
  // cheap path. The label command is the one surface that dispatch must
  // cross, so the rail lives here.
  const sessionId = '20260811T000000Z-combined-rail-abc123';
  const { dir, sessionDir } = makeProject(sessionId);
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    s.resolvedCeremony = 'combined';
    fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(s)}\n`);

    // No --tier → standard, not the usual capable default.
    const r1 = run(dir, ['final']);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stderr, /combined/i);
    let stamps = readStamps(sessionDir);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].model.tier, 'standard');

    // Explicit capable → refuse, name the override, write nothing.
    const r2 = run(dir, ['final', '--tier', 'capable']);
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /--full-tail/);
    assert.equal(readStamps(sessionDir).length, 1, 'refusal must not stamp');

    // Explicit capable + --full-tail → allowed, recorded.
    const r3 = run(dir, ['final', '--tier', 'capable', '--full-tail']);
    assert.equal(r3.status, 0, r3.stderr);
    stamps = readStamps(sessionDir);
    assert.equal(stamps.length, 2);
    assert.equal(stamps[1].model.tier, 'capable');

    // fast stays allowed without ceremony — cheaper than the default is never
    // the failure this rail exists for.
    const r4 = run(dir, ['final', '--tier', 'fast']);
    assert.equal(r4.status, 0, r4.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--tier standard overrides the default and lands in the stamp', () => {
  const sessionId = '20260731T105409Z-stamp-tier-abc123';
  const { dir, sessionDir } = makeProject(sessionId);
  try {
    const r = run(dir, ['final', '--tier', 'standard']);
    assert.equal(r.status, 0, r.stderr);

    const stamps = readStamps(sessionDir);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].model.tier, 'standard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--tier bogus refuses with a usage message and writes no stamp', () => {
  const sessionId = '20260731T105409Z-stamp-badtier-abc123';
  const { dir, sessionDir } = makeProject(sessionId);
  try {
    const r = run(dir, ['final', '--tier', 'bogus']);
    assert.notEqual(r.status, 0, 'an unknown tier must not be accepted');
    assert.equal(r.stdout, '', 'no label on an unusable tier');
    // Distinguishes a real tier-validation refusal from the pre-existing
    // "unknown option" refusal, which never mentions the offending value.
    assert.match(r.stderr, /bogus/i);
    assert.deepEqual(readStamps(sessionDir), [], 'a refused tier must not reach the stamp writer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reviews/ path that cannot be written does not block the label', () => {
  const sessionId = '20260731T105409Z-stamp-unwritable-abc123';
  const { dir, sessionDir } = makeProject(sessionId);
  const reviewsPath = path.join(sessionDir, 'reviews');
  // A plain file sitting where `reviews/` should be a directory: writeStamp's
  // mkdirSync fails, and the failure must not cost the label.
  fs.writeFileSync(reviewsPath, 'not a directory');
  const before = fs.readFileSync(reviewsPath, 'utf8');
  try {
    const r = run(dir, ['final']);
    const expectedLabel = reviewLabel('final', sessionId);
    assert.equal(r.stdout, `${expectedLabel}\n`, 'stdout must stay byte-identical to the label');
    assert.equal(r.status, 0, 'a stamp failure must not fail the command');
    assert.match(r.stderr, /Warning: could not write dispatch stamp/);
    assert.equal(fs.readFileSync(reviewsPath, 'utf8'), before, 'the unwritable path must be left untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('existing refusals still hold: no active session, and an unknown option', () => {
  const noSessionDir = tmp('forge-review-label-cli-nosession-');
  try {
    fs.mkdirSync(path.join(noSessionDir, '.forge'), { recursive: true });
    const r = run(noSessionDir, ['final']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No active session/);
  } finally {
    fs.rmSync(noSessionDir, { recursive: true, force: true });
  }

  const { dir } = makeProject('20260731T105409Z-stamp-unknownopt-abc123');
  try {
    const r = run(dir, ['--wat']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown option: --wat/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
