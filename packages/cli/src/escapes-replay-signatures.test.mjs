import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReplay } from './escapes-replay.mjs';

/**
 * An old run that fails because the fix brought code the test calls, not
 * because of the bug, must never auto-confirm. Each signature below blocks one.
 */

const pass = { exit: 0, output: '', timedOut: false, error: null };
const failing = (output) => ({ exit: 1, output, timedOut: false, error: null });
const outcome = (output) => classifyReplay({ old: failing(output), fix: pass }).outcome;

test('an old run that fails with ENOENT is environment, not a confirm', () => {
  assert.equal(outcome("Error: spawn tsx ENOENT\n    at ChildProcess._handle.onexit"), 'environment');
});

test('an old run that fails with "is not a function" is environment, not a confirm', () => {
  assert.equal(outcome('TypeError: helpers.buildFixture is not a function'), 'environment');
});

test('an old run that fails with TS2339 is environment, not a confirm', () => {
  assert.equal(outcome("src/a.test.ts(4,9): error TS2339: Property 'added' does not exist on type 'Foo'."), 'environment');
});

test('an old run that fails with TS2554 is environment, not a confirm', () => {
  assert.equal(outcome('src/a.test.ts(7,3): error TS2554: Expected 2 arguments, but got 1.'), 'environment');
});

test('the TS codes are word-bounded, and an ordinary assertion failure still confirms', () => {
  assert.equal(outcome('error TS23391: unrelated'), 'confirmed');
  assert.equal(outcome('AssertionError: expected 3 to equal 4'), 'confirmed');
});
