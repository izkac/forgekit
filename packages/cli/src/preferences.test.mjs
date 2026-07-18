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
