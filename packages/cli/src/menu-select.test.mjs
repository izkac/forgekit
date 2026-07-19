import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMenuSelection } from './menu-select.mjs';

const map = { 1: 'forge', 2: 'review', 3: 'adr', 4: 'git' };
const allIds = ['forge', 'review', 'adr', 'git'];
const allNum = '5';

test('parseMenuSelection: single choice', () => {
  assert.deepEqual(parseMenuSelection('1', map, allIds, allNum), {
    ok: true,
    ids: ['forge'],
  });
});

test('parseMenuSelection: multiple comma-separated', () => {
  assert.deepEqual(parseMenuSelection('1,3', map, allIds, allNum), {
    ok: true,
    ids: ['forge', 'adr'],
  });
});

test('parseMenuSelection: multiple space-separated', () => {
  assert.deepEqual(parseMenuSelection('2 4', map, allIds, allNum), {
    ok: true,
    ids: ['review', 'git'],
  });
});

test('parseMenuSelection: all via number or word', () => {
  assert.deepEqual(parseMenuSelection('5', map, allIds, allNum), {
    ok: true,
    ids: [...allIds],
  });
  assert.deepEqual(parseMenuSelection('all', map, allIds, allNum), {
    ok: true,
    ids: [...allIds],
  });
});

test('parseMenuSelection: empty and unknown rejected', () => {
  assert.equal(parseMenuSelection('', map, allIds, allNum).ok, false);
  assert.equal(parseMenuSelection('9', map, allIds, allNum).ok, false);
  assert.equal(parseMenuSelection('1,9', map, allIds, allNum).ok, false);
});

test('parseMenuSelection: dedupes repeats', () => {
  assert.deepEqual(parseMenuSelection('1,1,2', map, allIds, allNum), {
    ok: true,
    ids: ['forge', 'review'],
  });
});
