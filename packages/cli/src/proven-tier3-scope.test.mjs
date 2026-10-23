import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { provenFacts, provenLine } from './proven.mjs';

/**
 * Session dir whose verify-runs.jsonl holds `stamps` in order (file order is
 * append order). Each stamp is { scope?, exit }; ok/command/startedAt derive
 * from its position and exit so every stamp differs from its neighbours.
 */
function fixture(stamps) {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'forge-proven-scope-'));
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const lines = stamps.map((s, i) =>
    JSON.stringify({
      ...(s.scope === undefined ? {} : { scope: s.scope }),
      command: `cmd-${i}-${s.scope ?? 'legacy'}`,
      exit: s.exit,
      ok: s.exit === 0,
      startedAt: `2026-06-05T00:00:0${i}.000Z`,
    }),
  );
  fs.writeFileSync(path.join(sessionDir, 'verify-runs.jsonl'), `${lines.join('\n')}\n`);
  return { cwd, sessionDir, session: { id: 's1', features: { tddEvidence: false } } };
}

test('red full, then green failed-only: tier 3 ok via failed-only', () => {
  const stamps = [
    { scope: 'full', exit: 1 },
    { scope: 'failed-only', exit: 0 },
  ];
  const p = provenFacts(fixture(stamps));
  assert.equal(p.tier3.ok, true);
  assert.equal(p.tier3.via, 'failed-only');
  assert.equal(p.tier3.exit, stamps[0].exit, 'the full run exit is kept, so the line can name it');
  assert.equal(p.tier3.command, `cmd-0-full`);
  assert.equal(p.tier3.rescue.command, `cmd-1-failed-only`);
  assert.equal(p.tier3.rescue.at, '2026-06-05T00:00:01.000Z');
  const line = provenLine(p);
  assert.match(line, /tier3 ok via failed-only re-run \(full run exit 1\)/);
  assert.doesNotMatch(line, /tier3 exit/);
});

test('red full, then green fix: tier 3 stays red', () => {
  const p = provenFacts(
    fixture([
      { scope: 'full', exit: 2 },
      { scope: 'fix', exit: 0 },
    ]),
  );
  assert.equal(p.tier3.ok, false);
  assert.equal(p.tier3.via, undefined);
  assert.equal(p.tier3.exit, 2);
  assert.match(provenLine(p), /tier3 exit 2/);
});

test('red full, then green group: tier 3 stays red', () => {
  const p = provenFacts(
    fixture([
      { scope: 'full', exit: 1 },
      { scope: 'group', exit: 0 },
    ]),
  );
  assert.equal(p.tier3.ok, false);
  assert.equal(p.tier3.via, undefined);
});

test('only a green group stamp: tier 3 is not stamped', () => {
  const p = provenFacts(fixture([{ scope: 'group', exit: 0 }]));
  assert.equal(p.tier3, null);
  assert.match(provenLine(p), /tier3 not stamped/);
});

test('legacy green stamp with no scope field is read as full: ok', () => {
  const p = provenFacts(fixture([{ exit: 0 }]));
  assert.equal(p.tier3.ok, true);
  assert.equal(p.tier3.via, undefined);
  assert.match(provenLine(p), /tier3 exit 0/);
});

test('red full then red failed-only stays red; a later green full wins outright', () => {
  const red = provenFacts(
    fixture([
      { scope: 'full', exit: 1 },
      { scope: 'failed-only', exit: 3 },
    ]),
  );
  assert.equal(red.tier3.ok, false);
  assert.equal(red.tier3.via, undefined);

  const green = provenFacts(
    fixture([
      { scope: 'full', exit: 1 },
      { scope: 'failed-only', exit: 3 },
      { scope: 'full', exit: 0 },
    ]),
  );
  assert.equal(green.tier3.ok, true);
  assert.equal(green.tier3.via, undefined);
});

test('a failed-only stamp from before the last full does not rescue it; the last failed-only after it decides', () => {
  const stale = provenFacts(
    fixture([
      { scope: 'failed-only', exit: 0 },
      { scope: 'full', exit: 1 },
    ]),
  );
  assert.equal(stale.tier3.ok, false);

  const lastWins = provenFacts(
    fixture([
      { scope: 'full', exit: 1 },
      { scope: 'failed-only', exit: 0 },
      { scope: 'failed-only', exit: 4 },
    ]),
  );
  assert.equal(lastWins.tier3.ok, false, 'the last failed-only after the red full is the one that counts');
});

test('per-scope counts cover every stamp, including legacy ones as full', () => {
  const stamps = [
    { exit: 1 },
    { scope: 'full', exit: 1 },
    { scope: 'failed-only', exit: 0 },
    { scope: 'fix', exit: 0 },
    { scope: 'fix', exit: 1 },
    { scope: 'fix', exit: 0 },
    { scope: 'group', exit: 0 },
  ];
  const expected = { full: 0, 'failed-only': 0, fix: 0, group: 0 };
  for (const s of stamps) expected[s.scope ?? 'full'] += 1;
  assert.deepEqual(provenFacts(fixture(stamps)).tier3.counts, expected);
});
