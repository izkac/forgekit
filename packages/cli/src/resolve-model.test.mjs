import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import {
  DEFAULTS_PATH,
  deepMerge,
  detectAgent,
  parseArgs,
  resolveFromConfig,
  resolveModel,
  runResolveModel,
} from './resolve-model.mjs';
import { getEffectiveBilling, runSetModels, writeLocalBilling } from './set-models.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return {
    stream,
    text: () => text,
  };
}

test('parseArgs requires known flags', () => {
  const opts = parseArgs(['--tier', 'fast', '--billing', 'included', '--agent', 'cursor']);
  assert.equal(opts.tier, 'fast');
  assert.equal(opts.billing, 'included');
  assert.equal(opts.agent, 'cursor');
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('detectAgent prefers explicit host env', () => {
  assert.equal(detectAgent({ CURSOR_AGENT: '1' }).agent, 'cursor');
  assert.equal(detectAgent({ CLAUDE_CODE: '1' }).agent, 'claude-code');
  assert.equal(detectAgent({ CODEX_HOME: '/tmp/codex' }).agent, 'codex');
  assert.equal(detectAgent({}).detected, false);
  assert.equal(detectAgent({}).agent, 'cursor');
});

test('deepMerge overlays nested agent maps', () => {
  const merged = deepMerge(
    { billing: 'included', agents: { cursor: { included: { fast: 'inherit' } } } },
    { billing: 'metered', agents: { cursor: { included: { standard: 'inherit' } } } },
  );
  assert.equal(merged.billing, 'metered');
  assert.deepEqual(merged.agents.cursor.included, {
    fast: 'inherit',
    standard: 'inherit',
  });
});

test('cursor included resolves to omitModel', () => {
  const result = resolveModel({
    tier: 'standard',
    agent: 'cursor',
    billing: 'included',
    defaultsPath: DEFAULTS_PATH,
    env: {},
  });
  assert.equal(result.omitModel, true);
  assert.equal(result.model, null);
  assert.equal(result.billing, 'included');
});

test('cursor metered capable returns explicit slug', () => {
  const result = resolveModel({
    tier: 'capable',
    agent: 'cursor',
    billing: 'metered',
    defaultsPath: DEFAULTS_PATH,
    env: {},
  });
  assert.equal(result.omitModel, false);
  assert.equal(result.model, 'claude-opus-4-8-thinking-high');
});

test('claude-code included fast uses haiku', () => {
  const result = resolveModel({
    tier: 'fast',
    agent: 'claude-code',
    billing: 'included',
    defaultsPath: DEFAULTS_PATH,
    env: {},
  });
  assert.equal(result.model, 'haiku');
  assert.equal(result.omitModel, false);
});

test('local billing override changes default lane', () => {
  const dir = tmp('forge-models-');
  const forgeDir = path.join(dir, '.forge');
  writeLocalBilling({ forgeDir, billing: 'metered' });

  const result = resolveModel({
    tier: 'standard',
    agent: 'cursor',
    defaultsPath: DEFAULTS_PATH,
    forgeDir,
    cwd: dir,
    env: {},
  });
  assert.equal(result.billing, 'metered');
  assert.equal(result.omitModel, false);
  assert.equal(result.model, 'claude-sonnet-5-thinking-high');
});

test('missing cell fails clearly', () => {
  assert.throws(
    () =>
      resolveFromConfig(
        { agents: { cursor: { included: {} } } },
        { agent: 'cursor', billing: 'included', tier: 'fast' },
      ),
    /Missing cell for \(cursor, included, fast\)/,
  );
});

test('runResolveModel prints JSON', () => {
  const out = capture();
  const err = capture();
  const code = runResolveModel(
    ['--tier', 'fast', '--agent', 'codex', '--billing', 'included'],
    { stdout: out.stream, stderr: err.stream },
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text());
  assert.equal(parsed.agent, 'codex');
  assert.equal(parsed.omitModel, true);
});

test('set-models writes and getEffectiveBilling reads', () => {
  const dir = tmp('forge-set-models-');
  const forgeDir = path.join(dir, '.forge');
  const out = capture();
  const err = capture();
  const code = runSetModels(['metered', '--forge-dir', forgeDir], {
    cwd: dir,
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(code, 0);
  assert.match(out.text(), /billing=metered/);

  const effective = getEffectiveBilling({
    forgeDir,
    defaultsPath: DEFAULTS_PATH,
    cwd: dir,
  });
  assert.equal(effective.billing, 'metered');
  assert.equal(effective.localExists, true);
});

test('getEffectiveBilling defaults to included without local file', () => {
  const dir = tmp('forge-get-billing-');
  const forgeDir = path.join(dir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const effective = getEffectiveBilling({
    forgeDir,
    defaultsPath: DEFAULTS_PATH,
    cwd: dir,
  });
  assert.equal(effective.billing, 'included');
  assert.equal(effective.localExists, false);
});

test('forge:models get without local file explains no write', () => {
  const dir = tmp('forge-models-get-');
  const forgeDir = path.join(dir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const out = capture();
  const err = capture();
  const code = runSetModels(['--forge-dir', forgeDir], {
    cwd: dir,
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(code, 0);
  assert.match(out.text(), /billing=included/);
  assert.match(out.text(), /local=\(none/);
  assert.match(out.text(), /writes \.forge\/models\.local\.json/);
  assert.equal(fs.existsSync(path.join(forgeDir, 'models.local.json')), false);
});
