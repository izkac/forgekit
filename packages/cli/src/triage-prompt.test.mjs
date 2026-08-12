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

// I1 (final review of recalibrate-triage-and-review): `changelog`,
// `docs-only`, `documentation-only` and `rename-only` were widened to bare
// substrings anywhere in the prompt, which silences real work that merely
// mentions one of those words while building something new — including a
// payments feature, where suppression means no session is ever created and
// the high-risk floor never gets a chance to engage. The shared shape: the
// marker sits inside a compound noun or a subordinate clause describing what
// is being BUILT, not the direct object of an edit to existing trivial
// content. `changelog` is the clearest case — unlike the other three markers
// it is a plain noun, not an assertion about the edit's nature.
test('a payments feature request is substantial even though it calls itself a rename-only change', () => {
  const prompt = 'Implement payment refunds — this is a rename-only change to the Stripe adapter';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('a changelog-generator feature request is substantial ("changelog" is an incidental noun, not the edit target)', () => {
  const prompt = 'Add a changelog generator that reads git history and writes CHANGELOG.md';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('a docs-only publishing pipeline is substantial ("docs-only" describes the pipeline\'s output, not the edit)', () => {
  const prompt = 'Build a docs-only publishing pipeline for the API reference';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

// Two more work requests in the same family (compound noun / new artifact),
// deliberately not lifted from the reviewer's four probes, so the fix is not
// tuned to exactly those phrasings.
test('a rename-only migration tool is substantial ("rename-only" describes the tool being built, not an edit)', () => {
  const prompt = 'Add a rename-only migration tool that renames legacy tables in bulk';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('a documentation-only site generator is substantial ("documentation-only" describes the generator\'s output, not the edit)', () => {
  const prompt = 'Build a documentation-only site generator for the API reference';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

// I1-R (round 3, final review round 2): the round-2 fix gated the four
// ambiguous markers on the ABSENCE of a creation verb (add/build/create/…).
// That is a verb-FAMILY allowlist — it covers only how people describe
// bringing something new into existence, not how they describe fixing,
// removing, refactoring, porting or migrating an existing one. A payments
// bug fix that happens to carry an incidental "rename-only" aside still
// suppressed under that gate: no session, no high-risk floor. The fixed rule
// does not look at the verb at all — it looks at whether the prompt names an
// artifact/mechanism (bug, adapter, guard, parser, script, refactor, tool,
// generator, pipeline, module, handler, job, …) alongside the marker. A
// marker with no such artifact nearby is describing an edit to existing text
// content (the changelog, the docs, a comment, a rename) and stays trivial;
// a marker sitting next to a named mechanism is describing work done TO or
// WITH that mechanism and must ask, regardless of which verb introduced it.
test('a payments bug fix is substantial even though it carries an incidental "rename-only" aside (verb: fix, not implement)', () => {
  const prompt =
    'Fix the double-charge bug in the Stripe adapter; this is a rename-only change to the refund handler';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('removing a documentation-only guard from a deploy job is substantial (verb: remove)', () => {
  const prompt = 'Remove the documentation-only guard from the deploy job';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('rewriting the changelog parser is substantial (verb: rewrite)', () => {
  const prompt = 'Rewrite the changelog parser to handle conventional commits';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('implementing a "no behaviour change" refactor across files is substantial — the unconditional tier regressed here too', () => {
  const prompt = 'Implement a no behaviour change refactor of the auth module into three files';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('a refactor whose purpose clause happens to mention "the changelog" is substantial (the object of Refactor is the script, not the changelog)', () => {
  const prompt = 'Refactor the release script so it stops writing the changelog by hand';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('a comment-only stripping tool is substantial — "comment-only" was in the unconditional tier and should not have been', () => {
  const prompt = 'Build a comment-only stripping tool for the vendored deps';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

// Two more, in verb families none of the acceptance list above uses (port,
// migrate, delete) — proof the rule does not special-case any particular
// verb, because it does not look at the verb at all.
test('porting the changelog renderer to a new templating engine is substantial (verb: port)', () => {
  const prompt = 'Port the changelog renderer to the new templating engine';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('migrating a comment-only stripping service to a new pipeline is substantial (verb: migrate)', () => {
  const prompt = 'Migrate the comment-only stripping service to the new pipeline';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

test('deleting a rename-only compatibility shim from a module is substantial (verb: delete)', () => {
  const prompt = 'Delete the rename-only compatibility shim from the auth module';
  assert.equal(hasWorkContent(prompt), true);
  assert.equal(shouldForgeTriage(prompt), true);
});

// Still suppressed: the marker IS the direct object of an edit verb, not a
// modifier inside something new being built.
test('"update the changelog" (the actual edit target) is still trivial', () => {
  assert.equal(hasWorkContent('update the changelog'), false);
  assert.equal(shouldForgeTriage('update the changelog'), false);
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
