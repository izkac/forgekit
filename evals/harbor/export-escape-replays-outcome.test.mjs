import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, namesKnownRunner, parseSummary } from './escape-replays/outcome.mjs';

const NODE_SPEC = ['✔ adds (1.2ms)', 'ℹ tests 3', 'ℹ suites 0', 'ℹ pass 3', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0'].join('\n');
const NODE_TAP = ['TAP version 13', 'ok 1 - adds', '1..1', '# tests 3', '# pass 3', '# fail 0', '# cancelled 0'].join('\n');
const NODE_ARGV = ['node', '--test', 'test/a.test.js'];

test('parseSummary reads Jest, Vitest and node --test summaries', () => {
  assert.deepEqual(parseSummary('Tests:       1 failed, 2 passed, 3 total'), { recognised: true, passed: 2, failed: 1 });
  assert.deepEqual(parseSummary('Tests:       2 skipped, 1 todo, 4 passed, 7 total'), { recognised: true, passed: 4, failed: 0 });
  assert.deepEqual(parseSummary('\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m | \u001b[32m2 passed\u001b[39m (3)'), { recognised: true, passed: 2, failed: 1 });
  assert.deepEqual(parseSummary(' Test Files  1 passed (1)\n      Tests  2 passed | 1 skipped (3)'), { recognised: true, passed: 2, failed: 0 });
  assert.deepEqual(parseSummary(NODE_SPEC), { recognised: true, passed: 3, failed: 0 });
  assert.deepEqual(parseSummary(NODE_TAP), { recognised: true, passed: 3, failed: 0 });
  assert.deepEqual(parseSummary('ℹ pass 1\nℹ fail 2\nℹ cancelled 1'), { recognised: true, passed: 1, failed: 3 });
  assert.deepEqual(parseSummary('everything is fine\n'), { recognised: false, passed: 0, failed: 0 });
});

test('a node --test file that ran no test is a file-level pass, not a passing test', () => {
  // What node prints when the code under test calls process.exit(0) before any test ran.
  const early = ['✔ test/total.test.js (565ms)', 'ℹ tests 1', 'ℹ pass 1', 'ℹ fail 0'].join('\n');
  assert.deepEqual(parseSummary(early), { recognised: true, passed: 0, failed: 0 });
  const tap = ['TAP version 13', 'ok 1 - test\\\\total.test.js', '# tests 1', '# pass 1', '# fail 0'].join('\n');
  assert.equal(parseSummary(tap).passed, 0);
  // A real test next to it still counts.
  assert.equal(parseSummary(['✔ test/a.test.js (5ms)', '✔ adds (1ms)', 'ℹ pass 2', 'ℹ fail 0'].join('\n')).passed, 1);
});

test('judge: exit 0 with a passing summary is a pass', () => {
  assert.deepEqual(judge({ argv: NODE_ARGV, exit: 0, output: NODE_SPEC }), { ok: true, note: 'passed' });
  assert.equal(judge({ argv: ['npx', 'jest', 'a'], exit: 0, output: 'Tests:       2 passed, 2 total' }).ok, true);
  assert.equal(judge({ argv: ['npx', 'vitest', 'run', 'a'], exit: 0, output: '      Tests  2 passed (2)' }).ok, true);
});

test('judge: a nonzero exit, a failing count or no passing test is a fail', () => {
  assert.equal(judge({ argv: NODE_ARGV, exit: 1, output: NODE_SPEC }).ok, false);
  assert.equal(judge({ argv: NODE_ARGV, exit: null, output: NODE_SPEC }).ok, false);
  assert.match(judge({ argv: NODE_ARGV, exit: 0, output: 'ℹ pass 2\nℹ fail 1' }).note, /failing/);
  assert.match(judge({ argv: NODE_ARGV, exit: 0, output: 'Tests:       0 passed, 0 total' }).note, /no passing test/);
  assert.equal(judge({ argv: ['npx', 'jest', 'a'], exit: 0, output: 'Tests:       1 failed, 2 passed, 3 total' }).ok, false);
});

test('judge: Jest, Vitest and node --test must print a summary; an unknown runner is judged by its exit code', () => {
  // Jest ends a run with no summary when the code under test exits the process.
  assert.match(judge({ argv: ['npx', 'jest', 'a'], exit: 0, output: 'process.exit called with "0"' }).note, /no test summary/);
  assert.equal(judge({ argv: ['node', 'node_modules/jest/bin/jest.js', 'a'], exit: 0, output: '' }).ok, false);
  assert.equal(judge({ argv: ['vitest', 'run'], exit: 0, output: '' }).ok, false);
  assert.equal(judge({ argv: NODE_ARGV, exit: 0, output: '' }).ok, false);
  assert.equal(judge({ argv: ['python', '-m', 'pytest', 'a'], exit: 0, output: '1 passed in 0.1s' }).ok, true);
  assert.equal(judge({ argv: ['go', 'test', './...'], exit: 0, output: '' }).ok, true);
});

test('namesKnownRunner', () => {
  assert.equal(namesKnownRunner(['node', '--test', 'x']), true);
  assert.equal(namesKnownRunner(['node', 'x.js']), false);
  assert.equal(namesKnownRunner(['./node_modules/.bin/jest', 'x']), true);
  assert.equal(namesKnownRunner(['npm', 'test']), false);
});
