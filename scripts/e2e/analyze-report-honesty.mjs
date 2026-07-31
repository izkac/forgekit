#!/usr/bin/env node
/**
 * Product loop for analyze-report-honesty — pin digest-backed byModel splits,
 * zero-dispatch policy copy, synthetic omission, sess-err header, and in-repo
 * Claude PreToolUse hook wiring.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnalysis, formatAnalysis } from '../../packages/cli/src/analyze.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Ledger-only project: digests in sessions.jsonl, no live metrics.json. */
function plantProject(digests) {
  const cwd = tmp('forgekit-e2e-honesty-');
  const forge = path.join(cwd, '.forge');
  fs.mkdirSync(forge, { recursive: true });
  fs.writeFileSync(
    path.join(forge, 'sessions.jsonl'),
    digests.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
  return cwd;
}

function digest(sessionId, over = {}) {
  const metrics = over.metrics ?? null;
  return {
    sessionId,
    slug: sessionId,
    change: sessionId,
    phase: 'done',
    planType: 'specs',
    pace: 'standard',
    tasks: '5/5',
    subagentsDispatched: metrics?.subagents ?? null,
    dispatchesSkipped: null,
    metrics: metrics ?? { available: false },
    reviews: { total: 1, independent: 1, selfChecks: 0, rejections: 0, final: 'independent' },
    checkpoints: 1,
    health: 'done',
    healthReasons: [],
    score: 90,
    grade: 'A',
    incompleteReason: null,
    durationHours: 1,
    startedAt: '2026-07-20T09:00:00.000Z',
    endedAt: '2026-07-20T10:00:00.000Z',
    ...over,
  };
}

function compact(over = {}) {
  return {
    available: true,
    requests: 47,
    outputTokens: 2350,
    totalTokens: 341700,
    models: ['claude-opus-5', 'claude-fable-5'],
    errorRate: 0,
    subagents: 1,
    ...over,
  };
}

const byModel = {
  '<synthetic>': { requests: 5, input: 5, output: 250, cacheRead: 50000, cacheCreate: 500 },
  'claude-opus-5': { requests: 40, input: 40, output: 2000, cacheRead: 300000, cacheCreate: 1500 },
  'claude-fable-5': { requests: 7, input: 7, output: 350, cacheRead: 40000, cacheCreate: 200 },
};
const byPhase = {
  implement: { requests: 30, input: 30, output: 1500, cacheRead: 250000, cacheCreate: 1200 },
  verify: { requests: 17, input: 17, output: 850, cacheRead: 90000, cacheCreate: 500 },
};

const cwd = plantProject([
  digest('s-honesty', {
    metrics: compact({
      models: ['<synthetic>', 'claude-opus-5', 'claude-fable-5'],
      byModel,
      byPhase,
    }),
    dispatches: { total: 0, allowed: 0, rewritten: 0, denied: 0, skipped: 0 },
  }),
]);

try {
  const analysis = buildAnalysis({ cwd });
  const text = formatAnalysis(analysis);

  // --- digest-split: compact byModel/byPhase fill non-zero rows without metrics.json ---
  const opus = analysis.byModel['claude-opus-5'];
  const fable = analysis.byModel['claude-fable-5'];
  if (!opus || opus.requests !== byModel['claude-opus-5'].requests) {
    fail(
      `digest-split: opus requests want ${byModel['claude-opus-5'].requests}, got ${opus?.requests}`,
    );
  }
  if (opus.output !== byModel['claude-opus-5'].output) {
    fail(`digest-split: opus output want ${byModel['claude-opus-5'].output}, got ${opus.output}`);
  }
  if (!fable || fable.requests !== byModel['claude-fable-5'].requests) {
    fail(
      `digest-split: fable requests want ${byModel['claude-fable-5'].requests}, got ${fable?.requests}`,
    );
  }
  if (analysis.byPhase?.implement?.requests !== byPhase.implement.requests) {
    fail(
      `digest-split: implement phase want ${byPhase.implement.requests}, got ${analysis.byPhase?.implement?.requests}`,
    );
  }
  if (!/claude-opus-5/.test(text) || !/\b40\b/.test(text)) {
    fail('digest-split: formatAnalysis missing digest-backed opus row');
  }
  const digestSplit = 'ok';

  // --- policy-zero: sessions>0 && total===0 → no "wire the hook"; sessions reported none ---
  if (analysis.dispatches.sessions < 1 || analysis.dispatches.total !== 0) {
    fail(
      `policy-zero: expected sessions>0 total===0, got ${JSON.stringify(analysis.dispatches)}`,
    );
  }
  if (!new RegExp(`${analysis.dispatches.sessions} sessions reported no dispatches`, 'i').test(text)) {
    fail('policy-zero: missing "sessions reported no dispatches" copy');
  }
  if (/Wire the PreToolUse hook/i.test(text)) {
    fail('policy-zero: must not advise wiring the hook when sessions reported zero');
  }
  const policyZero = 'ok';

  // --- no-synthetic: digest naming <synthetic> must not produce a byModel row ---
  if (Object.hasOwn(analysis.byModel, '<synthetic>')) {
    fail('no-synthetic: byModel still has <synthetic>');
  }
  if (/<synthetic>/.test(text)) {
    fail('no-synthetic: formatAnalysis still mentions <synthetic>');
  }
  const noSynthetic = 'ok';

  // --- sess-err: By-model header column is "sess err", not bare "err" ---
  const header = text
    .split('\n')
    .find((line) => /^model\b/.test(line.trim()) && /\bsessions\b/.test(line) && /\brequests\b/.test(line));
  if (!header) fail('sess-err: By-model header missing');
  const cols = header.trim().split(/\s{2,}/);
  if (!cols.includes('sess err')) {
    fail(`sess-err: expected "sess err" in ${JSON.stringify(cols)}`);
  }
  if (cols.includes('err')) {
    fail(`sess-err: bare "err" must not be a column: ${JSON.stringify(cols)}`);
  }
  const sessErr = 'ok';

  // --- hooks: repo ships forge-model-hook + PreToolUse registration ---
  const hookPath = path.join(REPO, '.claude', 'hooks', 'forge-model-hook.mjs');
  if (!fs.existsSync(hookPath)) fail(`hooks: missing ${hookPath}`);
  const settingsPath = path.join(REPO, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) fail(`hooks: missing ${settingsPath}`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const pre = settings.hooks?.PreToolUse;
  if (!Array.isArray(pre) || pre.length === 0) fail('hooks: settings.hooks.PreToolUse missing');
  const commands = pre.flatMap((entry) => (entry.hooks ?? []).map((h) => String(h.command ?? '')));
  if (!commands.some((c) => c.includes('forge-model-hook.mjs'))) {
    fail(`hooks: PreToolUse must reference forge-model-hook.mjs; got ${JSON.stringify(commands)}`);
  }
  const hooks = 'ok';

  process.stdout.write(
    `HONESTY digest-split=${digestSplit} policy-zero=${policyZero} no-synthetic=${noSynthetic} sess-err=${sessErr} hooks=${hooks}\n`,
  );
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
