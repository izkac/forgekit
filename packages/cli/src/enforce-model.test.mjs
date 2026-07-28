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

/* ---------- the dispatch ledger ---------- */

/** Give a .forge dir an active session, and answer where its ledger will land. */
function withActiveSession(dir, sessionId = 'sess-1') {
  fs.mkdirSync(path.join(dir, 'sessions', sessionId), { recursive: true });
  fs.writeFileSync(path.join(dir, 'active.json'), `${JSON.stringify({ sessionId })}\n`, 'utf8');
  return path.join(dir, 'sessions', sessionId, 'dispatches.jsonl');
}

function ledgerRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** @param {string} dir @param {Record<string, unknown>} toolInput */
async function dispatchUnder(dir, toolInput, extra = {}) {
  const out = capture();
  const code = await runEnforceModel(['--forge-dir', dir, '--agent', 'claude-code'], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput, ...extra }),
    stdout: out.stream,
  });
  return { code, stdout: out.text() };
}

test('a rewritten dispatch is recorded, naming both the asked-for and the resolved model', async () => {
  const dir = forgeDir(pinnedOverlay('opus'));
  const file = withActiveSession(dir);

  await dispatchUnder(
    dir,
    { prompt: 'x', model: 'sonnet', subagent_type: 'general-purpose' },
    { tool_use_id: 'toolu_01ABC' },
  );

  const [row] = ledgerRows(file);
  assert.equal(row.decision, 'rewrite');
  assert.equal(row.modelRequested, 'sonnet');
  assert.equal(row.modelResolved, 'opus');
  assert.equal(row.agentType, 'general-purpose');
  assert.equal(row.tool, 'Agent');
  assert.equal(row.toolUseId, 'toolu_01ABC');
  assert.ok(!Number.isNaN(Date.parse(row.ts)));
  assert.equal(
    JSON.stringify(row).includes('x'.repeat(1)) && 'prompt' in row,
    false,
    'the ledger records counts and identifiers, never the dispatch prompt',
  );
});

test('a denied dispatch is recorded as denied', async () => {
  const dir = forgeDir({
    agents: {
      'claude-code': {
        included: { fast: 'haiku', standard: 'sonnet', capable: 'opus' },
        metered: { fast: 'haiku', standard: 'sonnet', capable: 'opus' },
      },
    },
  });
  const file = withActiveSession(dir);

  await dispatchUnder(dir, { prompt: 'x', model: 'gpt-5', subagent_type: 'Explore' });

  const [row] = ledgerRows(file);
  assert.equal(row.decision, 'deny');
  assert.equal(row.modelRequested, 'gpt-5');
  assert.equal(row.modelResolved, null, 'a refused dispatch resolved to nothing');
  assert.equal(row.reason, 'outside-resolved-set');
  assert.ok(
    JSON.stringify(row).length < 400,
    'the ledger carries a reason code, not the paragraph the coordinator is shown',
  );
});

test('a project with no models.local.json still records its dispatches', async () => {
  // The whole point is measuring how often the resolver is skipped, and a
  // project that has not opted into enforcement is exactly where that is worth
  // knowing. Logging must not be a side effect of having an overlay.
  const dir = forgeDir(null);
  const file = withActiveSession(dir);

  const { stdout } = await dispatchUnder(dir, { prompt: 'x', model: 'sonnet' });
  assert.equal(stdout, '', 'an un-overlaid project is still left completely alone');

  const [row] = ledgerRows(file);
  assert.equal(row.decision, 'allow');
  assert.equal(row.reason, 'no-overlay');
  assert.equal(row.modelResolved, 'sonnet', 'nothing was corrected, so the ask stands');
  assert.equal(row.agentType, null);
});

test('every dispatch appends — a session records its whole history', async () => {
  const dir = forgeDir(pinnedOverlay('opus'));
  const file = withActiveSession(dir);

  await dispatchUnder(dir, { model: 'sonnet' });
  await dispatchUnder(dir, { model: 'opus' });
  await dispatchUnder(dir, { model: 'haiku' });

  assert.deepEqual(
    ledgerRows(file).map((r) => r.decision),
    ['rewrite', 'allow', 'rewrite'],
  );
});

test('with no active Forge session the hook records nothing at all', async () => {
  const dir = forgeDir(pinnedOverlay('opus'));
  const { stdout } = await dispatchUnder(dir, { model: 'sonnet' });

  assert.equal(JSON.parse(stdout).hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(fs.existsSync(path.join(dir, 'sessions')), false);
});

test('a tool that is not a subagent dispatch is not a dispatch', async () => {
  const dir = forgeDir(pinnedOverlay('opus'));
  const file = withActiveSession(dir);

  const out = capture();
  await runEnforceModel(['--forge-dir', dir, '--agent', 'claude-code'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    stdout: out.stream,
  });
  await runEnforceModel(['--forge-dir', dir, '--agent', 'claude-code'], {
    input: 'not json at all',
    stdout: out.stream,
  });

  assert.deepEqual(ledgerRows(file), []);
});

test('a ledger write failure leaves the hook decision byte-identical', async () => {
  // The existing contract: this hook may cost a measurement, never a subagent.
  const good = forgeDir(pinnedOverlay('opus'));
  withActiveSession(good);
  const expected = await dispatchUnder(good, { prompt: 'x', model: 'sonnet' });

  const broken = forgeDir(pinnedOverlay('opus'));
  const file = withActiveSession(broken);
  fs.mkdirSync(file); // the one write failure a tolerant writer cannot dodge

  const actual = await dispatchUnder(broken, { prompt: 'x', model: 'sonnet' });

  assert.equal(actual.code, 0);
  assert.equal(actual.stdout, expected.stdout);
  assert.notEqual(expected.stdout, '', 'the comparison is worthless if both are empty');
});
