import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isForgeSkip,
  isForgeInvocation,
  isReadOnlyQuestion,
  isSubstantialWork,
  shouldForgeTriage,
} from './triage-prompt.mjs';

test('isForgeSkip matches /forge:skip', () => {
  assert.equal(isForgeSkip('/forge:skip fix typo'), true);
  assert.equal(isForgeSkip('  /forge:skip'), true);
});

test('isForgeInvocation matches forge commands', () => {
  assert.equal(isForgeInvocation('/forge'), true);
  assert.equal(isForgeInvocation('/forge:brainstorm'), true);
});

test('read-only questions skip triage', () => {
  assert.equal(isReadOnlyQuestion('How does auth work?'), true);
  assert.equal(isReadOnlyQuestion('What is forge?'), true);
});

test('diagnostic fix requests are substantial', () => {
  const prompt =
    'Check if Claude is wired correctly. It does not seem to fire the forge flow automatically';
  assert.equal(isReadOnlyQuestion(prompt), false);
  assert.equal(isSubstantialWork(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('implementation prompts triage', () => {
  assert.equal(shouldForgeTriage('Add login to mercury console'), true);
  assert.equal(shouldForgeTriage('Fix the bug in callback verification'), true);
});

test('explicit /forge handled by prompt hook not triage hook', () => {
  assert.equal(shouldForgeTriage('/forge:brainstorm'), false);
  assert.equal(isSubstantialWork('/forge:brainstorm'), true);
});

test('/forge:skip is not substantial', () => {
  assert.equal(isSubstantialWork('/forge:skip rename variable'), false);
});

test('trivial edits skip', () => {
  assert.equal(isSubstantialWork('Fix the typo in README'), false);
});
