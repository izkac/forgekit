import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isForgeSkip,
  isForgeInvocation,
  isReadOnlyQuestion,
  hasWorkContent,
  shouldForgeTriage,
  buildForgeTriageMessage,
  buildTriageHelpText,
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
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('implementation prompts triage', () => {
  assert.equal(shouldForgeTriage('Add login to mercury console'), true);
  assert.equal(shouldForgeTriage('Fix the bug in callback verification'), true);
});

test('explicit /forge handled by prompt hook not triage hook', () => {
  assert.equal(shouldForgeTriage('/forge:brainstorm'), false);
  assert.equal(hasWorkContent('/forge:brainstorm'), true);
});

test('/forge:skip is not substantial', () => {
  assert.equal(hasWorkContent('/forge:skip rename variable'), false);
});

test('trivial edits skip', () => {
  assert.equal(hasWorkContent('Fix the typo in README'), false);
});

// Each fixture below pairs a trivial marker with an implement verb
// (`fix`/`update`) that `hasWorkContent`'s patterns would otherwise
// match, so the assertion only passes if `isTrivialEdit` intercepts the
// prompt before the patterns list is reached — not because the prompt
// happened to match nothing.
test('changelog edits are trivial even though "update" is an implement verb', () => {
  assert.equal(hasWorkContent('Update the changelog for this release'), false);
  assert.equal(shouldForgeTriage('Update the changelog for this release'), false);
});

test('formatting-only edits are trivial even though "fix" is an implement verb', () => {
  assert.equal(hasWorkContent('Fix formatting-only issues in the linter output'), false);
  assert.equal(shouldForgeTriage('Fix formatting-only issues in the linter output'), false);
});

test('comment-only edits are trivial even though "update" is an implement verb', () => {
  assert.equal(hasWorkContent('Update comment-only sections of the file'), false);
  assert.equal(shouldForgeTriage('Update comment-only sections of the file'), false);
});

test('rename with no behaviour change is trivial (British spelling)', () => {
  assert.equal(hasWorkContent('Fix the rename; no behaviour change'), false);
  assert.equal(shouldForgeTriage('Fix the rename; no behaviour change'), false);
});

test('docs-only edits are trivial even though "fix" is an implement verb', () => {
  assert.equal(hasWorkContent('Fix docs-only sections of the guide'), false);
  assert.equal(shouldForgeTriage('Fix docs-only sections of the guide'), false);
});

test('a new payment endpoint is substantial', () => {
  assert.equal(hasWorkContent('add a new payment endpoint'), true);
});

// This prompt has no trivial marker, no read-only question shape, and no
// verb the "enter Forge" pattern list happens to enumerate — it must not
// fall through to "not substantial" by default.
test('unclear scope with no trivial marker and no clear skip condition still errs toward Forge', () => {
  const prompt = 'Please handle the onboarding thing';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

// The fail-closed default must not fire on bare conversational turns in a
// live session — only on prompts that could plausibly be a work request.
test('bare conversational replies are not substantial', () => {
  const replies = ['continue', 'thanks!', 'yes', 'ok go ahead', 'hmm'];
  for (const prompt of replies) {
    assert.equal(hasWorkContent(prompt), false, `expected not substantial: ${prompt}`);
    assert.equal(shouldForgeTriage(prompt), false, `expected no triage: ${prompt}`);
  }
});

// "run the tests" invokes existing tooling and requests no code change —
// procedural, like a read-only ask, not a work request. A prompt that adds
// a change on top ("run the tests and fix what's failing") is longer than
// this exact-match gate and falls through to the fail-closed default
// untouched, so this does not broaden the exclusion beyond the bare command.
test('"run the tests" is procedural, not substantial', () => {
  assert.equal(hasWorkContent('run the tests'), false);
  assert.equal(shouldForgeTriage('run the tests'), false);
});

// The reminder must ask the agent to decide, not hand it a conclusion the
// prompt-time filter has no context to reach. A message pinned to the old
// "Substantial work detected" wording would fail this guard.
test('triage reminder asks the agent to decide, and does not claim substantial work was detected', () => {
  const msg = buildForgeTriageMessage({});
  assert.match(msg, /\bdecide\b/i);
  assert.doesNotMatch(msg, /substantial work detected/i);
  assert.doesNotMatch(msg, /\bdetected\b/i);
});

// The active-session block and the /forge:skip escape hatch must survive the
// reframing — this task changes the framing, not the structure.
test('triage reminder keeps the active-session block and the /forge:skip escape hatch', () => {
  const withSession = buildForgeTriageMessage({
    hasActiveSession: true,
    sessionLines: ['Session: demo-123'],
  });
  assert.match(withSession, /Session: demo-123/);
  assert.match(withSession, /\/forge:skip/);

  const withoutSession = buildForgeTriageMessage({});
  assert.match(withoutSession, /forge new <slug>/);
  assert.match(withoutSession, /\/forge:skip/);
});

// `forge triage --check` help text must state what its exit codes mean now
// that exit 0 asks the agent rather than asserting substantiality — a help
// text that only shows the usage lines would fail this guard.
test('triage help text states the suppression semantics of --check exit codes', () => {
  const help = buildTriageHelpText();
  assert.match(help, /forge triage --check/);
  assert.match(help, /0.*ask the agent/i);
  assert.match(help, /1.*suppress/i);
});
