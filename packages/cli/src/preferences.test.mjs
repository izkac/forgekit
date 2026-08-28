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

test('suggestPaceFromSignals: money/auth holds standard, and never falls to brisk', () => {
  // Matches suggestPaceFromPlan: risk raises the floor to standard and the
  // per-task hard floor reviews the risky tasks themselves. Two resolvers
  // disagreeing about the same signal would be the bug.
  assert.equal(suggestPaceFromSignals('add stripe refund flow').pace, 'standard');
  assert.equal(suggestPaceFromSignals('OIDC auth hardening').pace, 'standard');
  assert.equal(suggestPaceFromSignals('mongo migration for orders').pace, 'standard');
  // "tweak" alone is brisk; the secret in the same breath outranks it.
  assert.equal(suggestPaceFromSignals('tweak the hmac secret rotation').pace, 'standard');
  assert.match(suggestPaceFromSignals('add stripe refund flow').reason, /task lines/i);
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
  assert.equal(expanded.review.perTask, 'never');
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

test('expandPace thorough uses per-group cadence, deeper rounds', () => {
  const expanded = expandPace({
    pace: 'thorough',
    defaults: JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')),
  });
  assert.equal(expanded.review.perTask, 'per-group');
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

test('hard floor: shouldRunPerTaskReview forces an immediate per-task review under lite on high risk', () => {
  const expanded = expandPace({ pace: 'lite' });
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: true }), true);
  assert.equal(shouldRunPerTaskReview(expanded, { highRisk: false }), false);
});

// lite.review.final is now unconditionally "always" (D3), and after this
// group no shipped preset sets `final` to anything but "always" — so the
// hard floor inside shouldRunFinalReview is no longer observable through any
// preset. It is still reachable: REVIEW_FINAL keeps `never` and
// `high-risk-only` as values a user can pin or overlay. Exercise the floor
// directly through those, not through a preset, so this guard would still
// fail if the floor logic itself were deleted.
test('hard floor: shouldRunFinalReview still forces a final review when final is pinned away from "always"', () => {
  const finalNever = { review: { final: 'never' } };
  assert.equal(shouldRunFinalReview(finalNever, { signalText: 'stripe webhook' }), true);
  assert.equal(shouldRunFinalReview(finalNever, { signalText: 'readme typo' }), false);

  const finalHighRiskOnly = { review: { final: 'high-risk-only' } };
  assert.equal(shouldRunFinalReview(finalHighRiskOnly, { signalText: 'stripe webhook' }), true);
  assert.equal(shouldRunFinalReview(finalHighRiskOnly, { signalText: 'readme typo' }), false);
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

test('isHighRiskText: qualified contract / F11 narrowing — qualifier+\\s+ only', () => {
  // F11 policy: contract risk requires a qualifier with \\s+. Bare "contract"
  // no longer escalates; hard-wrapped qualifier+newline+contract still does.
  assert.equal(isHighRiskText('alters the public contract of the /v1/orders endpoint'), true);
  assert.equal(isHighRiskText('breaking change to the data contract on the events topic'), true);
  assert.equal(isHighRiskText('the OpenAPI contract gains two required fields'), true);
  assert.equal(isHighRiskText('update the wire\ncontract for consumers'), true);
  assert.equal(isHighRiskText('alters the public\ncontract of the /v1/orders endpoint'), true);

  assert.equal(isHighRiskText('the same contract as readLedger'), false);
  assert.equal(
    isHighRiskText('byte-identical (the existing "must never block work" contract)'),
    false,
  );
  assert.equal(isHighRiskText('renegotiate the contract between scheduler and executor'), false);
  assert.equal(isHighRiskText('toolbar padding'), false);
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

test('no shipped preset uses review.perTask "always" (frequency is capped at per-group)', () => {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  const presets = defaults.presets;
  for (const [name, preset] of Object.entries(presets)) {
    assert.notEqual(
      preset.review.perTask,
      'always',
      `preset "${name}" uses review.perTask "always", but no shipped preset may — always stays valid only as a user pin`,
    );
  }
});

test('every preset ends with a final review and allows at least one fix round', () => {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  const presets = defaults.presets;
  for (const [name, preset] of Object.entries(presets)) {
    assert.equal(
      preset.review.final,
      'always',
      `preset "${name}" must always run a final review of the whole change`,
    );
    assert.ok(
      preset.review.maxRounds >= 1,
      `preset "${name}" must allow at least one fix round (maxRounds >= 1), got ${preset.review.maxRounds}`,
    );
  }
});

test('standard and thorough: identical cadence, differing maxRounds', () => {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  const { standard, thorough } = defaults.presets;
  // Cadence — the review-frequency knobs — must match.
  assert.equal(standard.review.perTask, thorough.review.perTask);
  assert.equal(standard.review.final, thorough.review.final);
  // Depth/rounds is the axis presets are still allowed to differ on.
  assert.notEqual(
    standard.review.maxRounds,
    thorough.review.maxRounds,
    'standard and thorough must differ in maxRounds, or the presets carry no distinct meaning',
  );
});

test('high-risk floor: a task touching payment logic gets an immediate per-task review under lite', () => {
  const expanded = expandPace({ pace: 'lite' });
  // Sanity: lite's ordinary cadence does not review every task.
  assert.equal(expanded.review.perTask, 'never');
  // The hard floor still fires immediately — not deferred to a group boundary —
  // for a task whose own text reads as high-risk (money/auth/contracts/etc.).
  assert.equal(
    shouldRunPerTaskReview(expanded, {
      signalText: 'wire the stripe payment refund flow',
      groupComplete: false,
    }),
    true,
  );
});

test('high-risk floor: a kebab slug is not a task line — migrate in the change name does not review every task', () => {
  const expanded = expandPace({ pace: 'standard' });
  assert.equal(
    shouldRunPerTaskReview(expanded, {
      signalText: 'shared-migrate-valicon-platform-http',
      groupComplete: false,
    }),
    false,
  );
  assert.equal(
    shouldRunPerTaskReview(expanded, {
      signalText: 'Add HMAC canonicalization for the request body',
      groupComplete: false,
    }),
    true,
  );
  assert.equal(
    shouldRunPerTaskReview(expanded, {
      signalText: 'Retarget Mercury fixture paths to consumer-owned vectors',
      groupComplete: false,
    }),
    false,
  );
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
