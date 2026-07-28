import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULTS_PATH,
  expandPace,
  isHighRiskText,
  parseAssignment,
  resolveEffectivePreferences,
  resolveSessionPaceFields,
  shouldRunFinalReview,
  shouldRunPerTaskReview,
  suggestPaceFromSignals,
  writeLocalPreferences,
} from './preferences.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

test('suggestPaceFromSignals: thorough for money/auth', () => {
  assert.equal(suggestPaceFromSignals('add stripe refund flow').pace, 'thorough');
  assert.equal(suggestPaceFromSignals('OIDC auth hardening').pace, 'thorough');
  assert.equal(suggestPaceFromSignals('mongo migration for orders').pace, 'thorough');
});

test('suggestPaceFromSignals: standard for ecosystem/api', () => {
  assert.equal(suggestPaceFromSignals('openapi route + ecosystem clients').pace, 'standard');
});

test('suggestPaceFromSignals: standard for worker/orchestration/openspec', () => {
  assert.equal(suggestPaceFromSignals('forge:apply etl-surveydb-harmonization-platform').pace, 'standard');
  assert.equal(suggestPaceFromSignals('wire worker job queue pipeline').pace, 'standard');
  assert.equal(suggestPaceFromSignals('openspec change for services platform').pace, 'standard');
});

test('suggestPaceFromSignals: lite for docs', () => {
  assert.equal(suggestPaceFromSignals('update README wording').pace, 'lite');
});

test('suggestPaceFromSignals: brisk only for explicit small work', () => {
  assert.equal(suggestPaceFromSignals('fix toolbar alignment').pace, 'brisk');
  assert.equal(suggestPaceFromSignals('tweak button padding').pace, 'brisk');
});

test('suggestPaceFromSignals: fail closed to standard for empty/unrecognized', () => {
  assert.equal(suggestPaceFromSignals('').pace, 'standard');
  assert.equal(suggestPaceFromSignals('etl-surveydb-harmonization-platform').pace, 'standard');
  assert.equal(suggestPaceFromSignals('mysterious-platform-change').pace, 'standard');
});

test('resolveEffectivePreferences surfaces integrity defaults', () => {
  const forgeDir = tmp('forge-prefs-integrity-');
  const eff = resolveEffectivePreferences({ forgeDir, defaultsPath: DEFAULTS_PATH });
  assert.equal(eff.integrity.forbidStubs, true);
  assert.equal(eff.integrity.specsBeatNarrowTasks, true);
  assert.equal(eff.integrity.requireE2E, 'when-jobs-or-workers');
});

test('expandPace brisk matrix', () => {
  const expanded = expandPace({ pace: 'brisk', defaults: JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')) });
  assert.equal(expanded.review.perTask, 'high-risk-only');
  assert.equal(expanded.verify.tier3, 'affected-only');
  assert.equal(expanded.models.bias, 'prefer-fast');
  assert.equal(expanded.brainstorm.depth, 'short');
});

test('expandPace standard uses per-group review', () => {
  const expanded = expandPace({
    pace: 'standard',
    defaults: JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')),
  });
  assert.equal(expanded.review.perTask, 'per-group');
  assert.equal(expanded.review.final, 'always');
  assert.equal(expanded.review.maxRounds, 2);
  assert.equal(expanded.verify.tier3, 'full-workspace');
});

test('per-group: review only at group boundary unless high-risk', () => {
  const expanded = expandPace({ pace: 'standard' });
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: false, groupComplete: false }), false);
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: false, groupComplete: true }), true);
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: true, groupComplete: false }), true);
});

test('expandPace thorough stays always per-task', () => {
  const expanded = expandPace({
    pace: 'thorough',
    defaults: JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')),
  });
  assert.equal(expanded.review.perTask, 'always');
  assert.equal(expanded.review.maxRounds, 3);
});

test('local override review.perTask on brisk', () => {
  const forgeDir = tmp('forge-prefs-');
  writeLocalPreferences({
    forgeDir,
    patch: { pace: 'brisk', review: { perTask: 'always' } },
  });
  const eff = resolveEffectivePreferences({ forgeDir, defaultsPath: DEFAULTS_PATH });
  assert.equal(eff.requestedPace, 'brisk');
  assert.equal(eff.resolvedPace, 'brisk');
  assert.equal(eff.effective.review.perTask, 'always');
  assert.equal(eff.effective.verify.tier3, 'affected-only');
});

test('default requested pace is auto', () => {
  const forgeDir = tmp('forge-prefs-empty-');
  const eff = resolveEffectivePreferences({ forgeDir, defaultsPath: DEFAULTS_PATH });
  assert.equal(eff.requestedPace, 'auto');
  assert.equal(eff.localExists, false);
});

test('auto uses session.resolvedPace when present', () => {
  const forgeDir = tmp('forge-prefs-session-');
  const eff = resolveEffectivePreferences({
    forgeDir,
    defaultsPath: DEFAULTS_PATH,
    session: { pace: 'auto', resolvedPace: 'lite', paceReason: 'cached' },
  });
  assert.equal(eff.resolvedPace, 'lite');
  assert.equal(eff.paceReason, 'cached');
});

test('session preferencesOverride wins without rewriting local', () => {
  const forgeDir = tmp('forge-prefs-override-');
  writeLocalPreferences({ forgeDir, patch: { pace: 'thorough' } });
  const before = fs.readFileSync(path.join(forgeDir, 'preferences.local.json'), 'utf8');
  const eff = resolveEffectivePreferences({
    forgeDir,
    defaultsPath: DEFAULTS_PATH,
    session: { preferencesOverride: { pace: 'lite' } },
  });
  assert.equal(eff.resolvedPace, 'lite');
  assert.equal(fs.readFileSync(path.join(forgeDir, 'preferences.local.json'), 'utf8'), before);
});

test('hard floor: lite still reviews high-risk tasks', () => {
  const expanded = expandPace({ pace: 'lite' });
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: true }), true);
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: false }), false);
  assert.equal(shouldRunFinalReview(expanded, { signalText: 'stripe webhook' }), true);
  assert.equal(shouldRunFinalReview(expanded, { signalText: 'readme typo' }), false);
});

test('isHighRiskText', () => {
  assert.equal(isHighRiskText('hmac secret rotation'), true);
  assert.equal(isHighRiskText('toolbar padding'), false);
});

test('isHighRiskText: bare "checkout" is git vocabulary, not a payment signal', () => {
  // "checkout" sat in the payment cluster next to stripe/billing/wallet, so
  // every change that mentioned a working copy read as high-risk and hit the
  // review floor. It blocked `forge phase done` on harness-setup-probe, whose
  // plan said "checkout" four times and touched no money surface at all.
  assert.equal(isHighRiskText('on the operator’s own checkout the probe failed'), false);
  assert.equal(isHighRiskText('run it once per checkout'), false);
  assert.equal(isHighRiskText('a fresh checkout of the repo'), false);
  assert.equal(isHighRiskText('git checkout -b feat/x'), false);

  // Real payment work still reads high-risk — either via a payment word it was
  // always going to carry, or via a qualified checkout phrase on its own.
  assert.equal(isHighRiskText('stripe checkout session'), true);
  assert.equal(isHighRiskText('rework the checkout flow'), true);
  assert.equal(isHighRiskText('checkout page validation'), true);
  assert.equal(isHighRiskText('guest checkout'), true);
  assert.equal(isHighRiskText('cart totals at checkout with billing address'), true);
});

test('isHighRiskText: bare "contract" is ordinary software English, not a risk signal', () => {
  // Third of the same family (after `auth` and `checkout`). "contract" is how
  // programmers describe any function's promise, so plan prose that discusses
  // interfaces escalated pace and hit the independent-review floor. The
  // session-telemetry change matched six times and touched no money, auth,
  // secrets or migration surface — every match was a sentence about a JS
  // function's calling convention.
  assert.equal(isHighRiskText('the same contract as readLedger'), false);
  assert.equal(isHighRiskText('the existing must-never-block-work contract'), false);
  assert.equal(isHighRiskText('Data contracts — additive only'), false);
  assert.equal(isHighRiskText('the transcript layout is not a public contract'), false);
  assert.equal(isHighRiskText('the contract already stated in ledger.mjs'), false);
  assert.equal(isHighRiskText('a tolerant read that honours the reader contract'), false);

  // The risk sense is qualified, exactly as STANDARD_RE already spells "wire
  // contract". Recall is unaffected for changes that really do break a
  // consumer or touch money.
  assert.equal(isHighRiskText('the API contract changes for every caller'), true);
  assert.equal(isHighRiskText('smart contract deployment'), true);
  assert.equal(isHighRiskText('update the wire contract'), true);
  assert.equal(isHighRiskText('schema contract for the events topic'), true);
  assert.equal(isHighRiskText('contract tests must be regenerated'), true);
  assert.equal(isHighRiskText('a breaking contract change'), true);

  // A genuinely risky change is still caught by its other words, so the
  // qualification costs nothing where it would matter.
  assert.equal(isHighRiskText('billing contract for invoiced customers'), true);
  assert.equal(isHighRiskText('migration contract between v1 and v2'), true);
});

test('parseAssignment', () => {
  assert.deepEqual(parseAssignment('review.perTask=always'), {
    key: 'review.perTask',
    value: 'always',
  });
  assert.deepEqual(parseAssignment('review.maxRounds=2'), {
    key: 'review.maxRounds',
    value: 2,
  });
});

test('resolveSessionPaceFields auto from slug', () => {
  const forgeDir = tmp('forge-prefs-sessfields-');
  const fields = resolveSessionPaceFields({
    forgeDir,
    defaultsPath: DEFAULTS_PATH,
    slug: 'docs-readme-cleanup',
  });
  assert.equal(fields.pace, 'auto');
  assert.equal(fields.resolvedPace, 'lite');
});
