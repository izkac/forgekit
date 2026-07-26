import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import {
  decide,
  enforceModel,
  hookOutput,
  parseArgs,
  readStdin,
  runEnforceModel,
  tierCells,
} from './enforce-model.mjs';

const CLAUDE_ENV = { CLAUDE_CODE: '1' };

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * A .forge dir, with an optional models.local.json overlay.
 * @param {Record<string, unknown> | null} overlay
 */
function forgeDir(overlay) {
  const dir = path.join(tmp('forge-enforce-'), '.forge');
  fs.mkdirSync(dir, { recursive: true });
  if (overlay) {
    fs.writeFileSync(path.join(dir, 'models.local.json'), JSON.stringify(overlay), 'utf8');
  }
  return dir;
}

/** All three claude-code tiers pinned to one model, both lanes. */
function pinnedOverlay(model) {
  const lane = { fast: model, standard: model, capable: model };
  return { agents: { 'claude-code': { included: { ...lane }, metered: { ...lane } } } };
}

function payload(toolInput, toolName = 'Agent') {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput });
}

function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, text: () => text };
}

test('parseArgs reads the resolve-model flag set', () => {
  const opts = parseArgs(['--agent', 'claude-code', '--billing', 'metered', '--forge-dir', '/x']);
  assert.equal(opts.agent, 'claude-code');
  assert.equal(opts.billing, 'metered');
  assert.equal(opts.forgeDir, '/x');
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('tierCells returns the lane in tier order, or null when unanswerable', () => {
  const config = {
    agents: { 'claude-code': { included: { fast: 'haiku', standard: 'sonnet', capable: 'opus' } } },
  };
  assert.deepEqual(tierCells(config, { agent: 'claude-code', billing: 'included' }), [
    'haiku',
    'sonnet',
    'opus',
  ]);
  assert.equal(tierCells(config, { agent: 'claude-code', billing: 'metered' }), null);
  assert.equal(tierCells(config, { agent: 'cursor', billing: 'included' }), null);
  assert.equal(tierCells({}, { agent: 'claude-code', billing: 'included' }), null);
  assert.equal(
    tierCells(
      { agents: { 'claude-code': { included: { fast: 'haiku', standard: 'sonnet' } } } },
      { agent: 'claude-code', billing: 'included' },
    ),
    null,
    'a missing tier makes the lane unanswerable rather than partially enforced',
  );
});

test('decide is inert without an overlay, whatever the model', () => {
  for (const model of ['sonnet', 'fable', 'something-invented', null]) {
    const d = decide({ cells: ['haiku', 'sonnet', 'opus'], hasOverlay: false, model });
    assert.equal(d.action, 'allow', `expected allow for ${model}`);
  }
});

test('decide pins when every tier resolves to the same model', () => {
  const cells = ['opus', 'opus', 'opus'];
  assert.deepEqual(decide({ cells, hasOverlay: true, model: 'sonnet' }), {
    action: 'pin',
    model: 'opus',
  });
  assert.deepEqual(decide({ cells, hasOverlay: true, model: null }), {
    action: 'pin',
    model: 'opus',
  });
  assert.equal(decide({ cells, hasOverlay: true, model: 'opus' }).action, 'allow');
});

test('decide pins a flattened `inherit` lane to no model at all', () => {
  const cells = ['inherit', 'inherit', 'inherit'];
  assert.deepEqual(decide({ cells, hasOverlay: true, model: 'sonnet' }), {
    action: 'pin',
    model: null,
  });
  assert.equal(decide({ cells, hasOverlay: true, model: null }).action, 'allow');
});

test('decide only validates when tiers differ — it cannot know the tier', () => {
  const cells = ['haiku', 'sonnet', 'opus'];
  assert.equal(decide({ cells, hasOverlay: true, model: 'haiku' }).action, 'allow');
  assert.equal(decide({ cells, hasOverlay: true, model: 'opus' }).action, 'allow');
  assert.equal(
    decide({ cells, hasOverlay: true, model: null }).action,
    'allow',
    'no model named is indistinguishable from a resolved `inherit`',
  );

  const denied = decide({
    cells,
    hasOverlay: true,
    model: 'fable',
    agent: 'claude-code',
    billing: 'included',
  });
  assert.equal(denied.action, 'deny');
  assert.match(denied.reason, /fast=haiku, standard=sonnet, capable=opus/);
  assert.match(denied.reason, /\(claude-code, included\)/);
  assert.match(denied.reason, /forge resolve-model/);
});

test('decide allows when the config cannot be read as three tiers', () => {
  assert.equal(decide({ cells: null, hasOverlay: true, model: 'sonnet' }).action, 'allow');
  assert.equal(decide({ cells: ['opus'], hasOverlay: true, model: 'sonnet' }).action, 'allow');
});

test('hookOutput rewrites the whole input, keeping the rest of the dispatch', () => {
  const input = { description: 'Implement X', prompt: 'do it', subagent_type: 'general-purpose', model: 'sonnet' };
  const out = hookOutput({ action: 'pin', model: 'opus' }, input);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { ...input, model: 'opus' });
  assert.equal(input.model, 'sonnet', 'the caller\'s object is not mutated');
});

test('hookOutput drops the model key when pinning to inherit', () => {
  const out = hookOutput({ action: 'pin', model: null }, { prompt: 'x', model: 'sonnet' });
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { prompt: 'x' });
  assert.equal('model' in out.hookSpecificOutput.updatedInput, false);
});

test('hookOutput emits a deny decision, and nothing for allow', () => {
  const out = hookOutput({ action: 'deny', reason: 'because' }, { prompt: 'x' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'because');
  assert.equal(hookOutput({ action: 'allow' }, { prompt: 'x' }), null);
});

test('enforceModel pins a sonnet dispatch when the overlay flattens to opus', () => {
  const { decision } = enforceModel(
    payload({ prompt: 'x', subagent_type: 'general-purpose', model: 'sonnet' }),
    { forgeDir: forgeDir(pinnedOverlay('opus')), env: CLAUDE_ENV },
  );
  assert.deepEqual(decision, { action: 'pin', model: 'opus' });
});

test('enforceModel leaves an un-overlaid project completely alone', () => {
  const { decision } = enforceModel(payload({ prompt: 'x', model: 'sonnet' }), {
    forgeDir: forgeDir(null),
    env: CLAUDE_ENV,
  });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'no-overlay');
});

test('enforceModel follows the billing lane the overlay selects', () => {
  const overlay = {
    billing: 'metered',
    agents: {
      'claude-code': {
        included: { fast: 'haiku', standard: 'sonnet', capable: 'opus' },
        metered: { fast: 'opus', standard: 'opus', capable: 'opus' },
      },
    },
  };
  const dir = forgeDir(overlay);
  assert.deepEqual(
    enforceModel(payload({ model: 'sonnet' }), { forgeDir: dir, env: CLAUDE_ENV }).decision,
    { action: 'pin', model: 'opus' },
    'metered lane is flattened, so it pins',
  );
  assert.equal(
    enforceModel(payload({ model: 'sonnet' }), {
      forgeDir: dir,
      billing: 'included',
      env: CLAUDE_ENV,
    }).decision.action,
    'allow',
    'included lane still tiers, and sonnet is in its set',
  );
});

test('enforceModel ignores tools that are not subagent dispatches', () => {
  const { decision } = enforceModel(payload({ model: 'sonnet' }, 'Bash'), {
    forgeDir: forgeDir(pinnedOverlay('opus')),
    env: CLAUDE_ENV,
  });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'other-tool');
});

test('enforceModel allows on any malformed payload', () => {
  const dir = forgeDir(pinnedOverlay('opus'));
  for (const raw of ['', 'not json', '[]', 'null', '{}', '{"tool_input":"nope"}']) {
    const { decision } = enforceModel(raw, { forgeDir: dir, env: CLAUDE_ENV });
    assert.equal(decision.action, 'allow', `expected allow for ${JSON.stringify(raw)}`);
  }
});

test('enforceModel allows when the overlay itself is corrupt', () => {
  const dir = path.join(tmp('forge-enforce-'), '.forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models.local.json'), '{ not json', 'utf8');
  const { decision } = enforceModel(payload({ model: 'sonnet' }), {
    forgeDir: dir,
    env: CLAUDE_ENV,
  });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'unreadable-config');
});

test('runEnforceModel writes hook JSON for a rewrite', async () => {
  const out = capture();
  const code = await runEnforceModel([`--forge-dir`, forgeDir(pinnedOverlay('opus')), '--agent', 'claude-code'], {
    input: payload({ prompt: 'x', model: 'sonnet' }),
    stdout: out.stream,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text());
  assert.equal(parsed.suppressOutput, true);
  assert.deepEqual(parsed.hookSpecificOutput.updatedInput, { prompt: 'x', model: 'opus' });
});

test('runEnforceModel stays silent when the dispatch stands', async () => {
  const out = capture();
  const code = await runEnforceModel(['--forge-dir', forgeDir(null), '--agent', 'claude-code'], {
    input: payload({ prompt: 'x', model: 'sonnet' }),
    stdout: out.stream,
  });
  assert.equal(code, 0);
  assert.equal(out.text(), '');
});

test('runEnforceModel swallows a malformed hook registration', async () => {
  const out = capture();
  const code = await runEnforceModel(['--bogus'], { input: payload({ model: 'sonnet' }), stdout: out.stream });
  assert.equal(code, 0);
  assert.equal(out.text(), '');
});

test('runEnforceModel reads the payload from stdin', async () => {
  const out = capture();
  const code = await runEnforceModel(
    ['--forge-dir', forgeDir(pinnedOverlay('opus')), '--agent', 'claude-code'],
    { stdin: Readable.from([payload({ prompt: 'x', model: 'sonnet' })]), stdout: out.stream },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.text()).hookSpecificOutput.updatedInput.model, 'opus');
});

test('readStdin gives up rather than holding a dispatch open', async () => {
  const stalled = new Readable({ read() {} });
  assert.equal(await readStdin(stalled, 10), '');
});
