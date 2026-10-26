import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReplay, ENVIRONMENT_SIGNATURES } from './escapes-replay.mjs';

/**
 * Replay hardening (escape-gaps 3.0): more ecosystems' "the test needs code the
 * fix brought" failures, the Go `undefined:` form anchored to Go's own shape,
 * and a Windows NTSTATUS crash code treated like a missing exit code.
 */

const ok = { exit: 0, output: 'pass', timedOut: false };
const failing = (output) => ({ exit: 1, output, timedOut: false });

const NEW_FORMS = {
  'typescript cannot find name': "src/a.test.ts(3,9): error TS2304: Cannot find name 'helper'.",
  'typescript cannot find module': "src/a.test.ts(1,20): error TS2307: Cannot find module './helper' or its corresponding type declarations.",
  'rust unresolved import': 'error[E0432]: unresolved import `crate::helper`',
  'java cannot find symbol': 'A.java:7: error: cannot find symbol\n  symbol:   method helper()',
  'ruby load error': "LoadError: cannot load such file -- helper",
  'go missing module package': 'a_test.go:4:2: no required module provides package example.com/helper; to add it:',
};
for (const [name, message] of Object.entries(NEW_FORMS)) {
  test(`classifyReplay: ${name} on the old run -> environment, never confirmed`, () => {
    assert.ok(ENVIRONMENT_SIGNATURES.test(message), message);
    assert.deepEqual(classifyReplay({ old: failing(message), fix: ok }), { outcome: 'environment' });
  });
}

test('classifyReplay: Go undefined: still matches its own file:line:col shape', () => {
  const message = './a_test.go:12:9: undefined: helper';
  assert.deepEqual(classifyReplay({ old: failing(message), fix: ok }), { outcome: 'environment' });
});

test('classifyReplay: JS assertion text "expected undefined: 5" is no longer an environment failure', () => {
  const message = 'AssertionError: expected undefined: 5';
  assert.equal(ENVIRONMENT_SIGNATURES.test(message), false);
  assert.deepEqual(classifyReplay({ old: failing(message), fix: ok }), { outcome: 'confirmed' });
});

test('classifyReplay: an old run that exits with a Windows NTSTATUS crash code is undecided (no-exit), never confirmed', () => {
  const ACCESS_VIOLATION = 0xc0000005;
  const FIRST_NTSTATUS = 0xc0000000;
  assert.equal(ACCESS_VIOLATION, 3221225477);
  for (const exit of [ACCESS_VIOLATION, FIRST_NTSTATUS, 0xffffffff]) {
    assert.deepEqual(
      classifyReplay({ old: { exit, output: 'AssertionError: boom', timedOut: false }, fix: ok }),
      { outcome: 'undecided', reason: 'no-exit' },
      String(exit),
    );
  }
  // Just below the NTSTATUS range, and the ordinary failure codes, are real failures.
  for (const exit of [FIRST_NTSTATUS - 1, 255, 1]) {
    assert.deepEqual(
      classifyReplay({ old: { exit, output: 'AssertionError: boom', timedOut: false }, fix: ok }),
      { outcome: 'confirmed' },
      String(exit),
    );
  }
});
