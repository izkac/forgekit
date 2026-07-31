import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { readStamps, writeStamp } from './review-stamp.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function readRaw(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'reviews', 'dispatches.json'), 'utf8'));
}

test('readStamps returns [] for a session directory with no stamp file at all', () => {
  const sessionDir = tmp('review-stamp-missing-');
  assert.deepEqual(readStamps(sessionDir), []);
});

test('writeStamp creates reviews/dispatches.json with the one stamp, on disk', () => {
  const sessionDir = tmp('review-stamp-first-');
  const model = { tier: 'capable', model: 'opus', omitModel: false, billing: 'included', agent: 'claude-code' };
  const before = Date.now();

  const result = writeStamp(sessionDir, {
    unit: 'final',
    label: 'forge-review final s1',
    sessionId: 's1',
    model,
  });
  const after = Date.now();

  const expectedPath = path.join(sessionDir, 'reviews', 'dispatches.json');
  assert.deepEqual(result, { ok: true, path: expectedPath });

  // Assert against the file on disk, not the return value: a writeStamp that
  // returned { ok: true } without writing anything would still pass an
  // assertion that only inspects `result`.
  const doc = readRaw(sessionDir);
  assert.equal(doc.version, 1);
  assert.equal(doc.stamps.length, 1);
  const [stamp] = doc.stamps;
  assert.equal(stamp.unit, 'final');
  assert.equal(stamp.label, 'forge-review final s1');
  assert.equal(stamp.sessionId, 's1');
  assert.deepEqual(stamp.model, model);

  const stampMs = Date.parse(stamp.at);
  assert.ok(!Number.isNaN(stampMs), `at was not a parsable timestamp: ${stamp.at}`);
  assert.ok(stampMs >= before && stampMs <= after, `at ${stamp.at} was not set during the call`);
});

test('writeStamp is append-only: a second stamp joins the first rather than replacing it', () => {
  const sessionDir = tmp('review-stamp-append-');

  const first = writeStamp(sessionDir, { unit: 'group-01', label: 'forge-review group-01 s1', sessionId: 's1' });
  assert.equal(first.ok, true, first.reason);
  const second = writeStamp(sessionDir, { unit: 'final', label: 'forge-review final s1', sessionId: 's1' });
  assert.equal(second.ok, true, second.reason);

  const doc = readRaw(sessionDir);
  assert.equal(doc.stamps.length, 2, 'both stamps must be on disk');
  // Units differ so this proves order and survival, not just count: a bug
  // that overwrote the first stamp instead of appending would still leave
  // length 1, but a bug that appended in the wrong order would pass a
  // length-only assertion.
  assert.equal(doc.stamps[0].unit, 'group-01', 'the earlier stamp must still be first');
  assert.equal(doc.stamps[1].unit, 'final', 'the newer stamp must be last');
});

test('model is stored as given when a plain object, and null for anything else', () => {
  for (const model of ['opus', 42, ['opus'], undefined, null]) {
    const sessionDir = tmp('review-stamp-model-bad-');
    const result = writeStamp(sessionDir, { unit: 'final', label: 'l', sessionId: 's1', model });
    assert.equal(result.ok, true, result.reason);
    assert.equal(
      readRaw(sessionDir).stamps[0].model,
      null,
      `model ${JSON.stringify(model)} must not be stored verbatim`,
    );
  }

  const sessionDir = tmp('review-stamp-model-good-');
  const model = { tier: 'capable', model: 'opus', omitModel: false, billing: 'included', agent: 'claude-code' };
  const result = writeStamp(sessionDir, { unit: 'final', label: 'l', sessionId: 's1', model });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(readRaw(sessionDir).stamps[0].model, model);
});

function writeRaw(sessionDir, doc) {
  const dir = path.join(sessionDir, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dispatches.json'), JSON.stringify(doc));
}

test('readStamps drops structurally invalid entries and keeps their valid neighbours', () => {
  const sessionDir = tmp('review-stamp-mixed-');
  // Each invalid entry is missing a different required field, and each one's
  // `label` differs from the keeper's — a filter that kept everything, or
  // dropped the wrong entry, would still leave a result distinguishable from
  // "only the keeper survived".
  writeRaw(sessionDir, {
    version: 1,
    stamps: [
      { unit: 'final', label: 'missing-at', sessionId: 's1' }, // no `at`
      { unit: '', label: 'empty-unit', sessionId: 's1', at: '2026-07-31T00:00:00.000Z' }, // empty `unit`
      { unit: 'final', label: 'not-a-string', sessionId: 42, at: '2026-07-31T00:00:00.000Z' }, // wrong type
      'not even an object',
      { unit: 'group-01', label: 'the-keeper', sessionId: 's1', at: '2026-07-31T00:00:00.000Z' },
    ],
  });

  const stamps = readStamps(sessionDir);
  assert.equal(stamps.length, 1, `expected exactly the keeper, got ${JSON.stringify(stamps)}`);
  assert.equal(stamps[0].label, 'the-keeper');
});

test('readStamps returns [] for a malformed or wrongly-shaped file, and never throws', () => {
  const dir = path.join(tmp('review-stamp-shapes-'), 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'dispatches.json');
  const sessionDir = path.dirname(dir);

  for (const raw of [
    '{ this is not json',
    JSON.stringify(['a', 'plain', 'array']), // root is not an object
    JSON.stringify({ version: 1, stamps: 'not-an-array' }), // stamps not an array
    JSON.stringify(null), // valid JSON, but not an object
    '',
  ]) {
    fs.writeFileSync(file, raw);
    assert.deepEqual(readStamps(sessionDir), [], `expected [] for raw content ${JSON.stringify(raw)}`);
  }
});

test('readStamps returns [] rather than throwing when the file cannot be opened at all', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores the permission bit
  const sessionDir = tmp('review-stamp-unreadable-');
  const dir = path.join(sessionDir, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'dispatches.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, stamps: [] }));
  fs.chmodSync(file, 0o000);
  try {
    assert.deepEqual(readStamps(sessionDir), []);
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('readStamps does not validate model — it is carried through as-is', () => {
  const sessionDir = tmp('review-stamp-model-passthrough-');
  writeRaw(sessionDir, {
    version: 1,
    stamps: [
      {
        unit: 'final',
        label: 'l',
        sessionId: 's1',
        at: '2026-07-31T00:00:00.000Z',
        model: 'not even the right shape',
      },
    ],
  });
  assert.equal(readStamps(sessionDir)[0].model, 'not even the right shape');
});

test('writeStamp refuses rather than destroying a malformed or wrongly-shaped existing file', () => {
  for (const raw of [
    '{ not json at all',
    JSON.stringify(['a', 'plain', 'array']), // root is not an object
    JSON.stringify({ version: 1, stamps: 'not-an-array' }), // stamps not an array
  ]) {
    const sessionDir = tmp('review-stamp-refuse-');
    const dir = path.join(sessionDir, 'reviews');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'dispatches.json');
    fs.writeFileSync(file, raw);

    const result = writeStamp(sessionDir, { unit: 'final', label: 'l', sessionId: 's1' });
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
    assert.ok(isNonEmptyString(result.reason), 'a refusal must say why');

    // Evidence must not be destroyed: the file on disk is byte-identical to
    // what was there before the refused write.
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'the malformed file must be left untouched');
  }
});

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

test('writeStamp preserves valid stamps from an existing file while dropping invalid ones', () => {
  const sessionDir = tmp('review-stamp-mixed-append-');
  writeRaw(sessionDir, {
    version: 1,
    stamps: [
      { unit: 'group-01', label: 'the-survivor', sessionId: 's1', at: '2026-07-31T00:00:00.000Z' },
      { unit: 'group-02', label: 'the-casualty', sessionId: 's1' }, // no `at`
    ],
  });

  const result = writeStamp(sessionDir, { unit: 'final', label: 'the-new-one', sessionId: 's1' });
  assert.equal(result.ok, true, result.reason);

  const labels = readRaw(sessionDir).stamps.map((s) => s.label);
  assert.deepEqual(labels, ['the-survivor', 'the-new-one'], 'the casualty must be dropped, not carried forward');
});

test('writeStamp never throws when reading the existing file fails for a reason other than "missing"', () => {
  const sessionDir = tmp('review-stamp-unwritable-');
  // A plain file sitting where `reviews/` should be a directory: reading
  // `reviews/dispatches.json` fails with ENOTDIR, not ENOENT, so it is
  // rejected as an unreadable existing file rather than treated as a fresh
  // start.
  fs.writeFileSync(path.join(sessionDir, 'reviews'), 'not a directory');

  const result = writeStamp(sessionDir, { unit: 'final', label: 'l', sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.ok(isNonEmptyString(result.reason));
});

test('writeStamp never throws when the reviews directory cannot be created', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores the permission bit
  const sessionDir = tmp('review-stamp-nowrite-');
  fs.chmodSync(sessionDir, 0o555); // readable/traversable, not writable
  try {
    const result = writeStamp(sessionDir, { unit: 'final', label: 'l', sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.ok(isNonEmptyString(result.reason));
  } finally {
    fs.chmodSync(sessionDir, 0o755);
  }
});
