import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { addRefutation, knownFalsePath, listRefutations, parseArgs, renderKnownFalseMd } from './refute.mjs';

const NOW = () => new Date('2026-09-10T12:00:00.000Z');

test('addRefutation appends KF ids in order and list filters by task', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-refute-'));
  const a = addRefutation(dir, { task: '01-a', claim: 'returns 200 on empty body', actual: 'returns 500' }, NOW);
  const b = addRefutation(dir, { task: '02-b', claim: 'x', actual: 'y', source: 'gate' }, NOW);
  assert.equal(a.id, 'KF1');
  assert.equal(b.id, 'KF2');
  assert.equal(a.source, 'reviewer');
  assert.equal(fs.readFileSync(knownFalsePath(dir), 'utf8').trim().split('\n').length, 2);
  assert.deepEqual(listRefutations(dir, { task: '02-b' }).map((r) => r.id), ['KF2']);
  assert.equal(listRefutations(dir).length, 2);
});

test('addRefutation refuses empty fields and unknown sources', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-refute-bad-'));
  assert.throws(() => addRefutation(dir, { task: '01-a', claim: ' ', actual: 'y' }, NOW), /--claim is required/);
  assert.throws(() => addRefutation(dir, { task: '01-a', claim: 'c', actual: 'y', source: 'vibes' }, NOW), /--source/);
  assert.equal(fs.existsSync(knownFalsePath(dir)), false);
});

test('renderKnownFalseMd is a brief-ready block, or "none recorded"', () => {
  assert.equal(renderKnownFalseMd([]), 'none recorded');
  const md = renderKnownFalseMd([{ id: 'KF1', task: '01-a', source: 'reviewer', claim: 'c', actual: 'a' }]);
  assert.equal(md, '- KF1 [reviewer, 01-a]: c → **actual:** a');
});

test('parseArgs reads add/list flags', () => {
  const o = parseArgs(['add', '--task', '01-a', '--claim', 'c', '--actual', 'a', '--source', 'e2e']);
  assert.deepEqual([o.sub, o.task, o.claim, o.actual, o.source], ['add', '01-a', 'c', 'a', 'e2e']);
  assert.throws(() => parseArgs(['list', '--bogus']), /unknown argument/);
});
