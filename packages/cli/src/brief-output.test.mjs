/**
 * `--brief` on `forge status` and `forge phase` (cost-levers task 3.3): a few
 * human lines instead of the full JSON, with the default output untouched.
 *
 * The brief's values are compared against the default JSON the same command
 * prints for the same project, so a brief that reads the wrong field fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DISPATCH_BUDGET } from './metrics/dispatches.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const ROW = { tool: 'Agent', agentType: 'general-purpose', modelRequested: 'sonnet', modelResolved: 'sonnet', reason: null };

/** A project with one session at `phase` and `ran` dispatches that ran, plus one denied one that did not. */
function makeProject({ phase = 'implement', ran = 0, budget } = {}) {
  const root = tmp('forge-brief-');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'fixture',
      createdAt: now,
      updatedAt: now,
      phase,
      planType: 'specs',
      openspecChange: 'my-change',
      tasksTotal: 3,
      tasksComplete: 1,
      pace: 'standard',
      resolvedPace: 'standard',
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  const rows = [
    ...Array.from({ length: ran }, (_, i) => ({ ...ROW, decision: i % 2 ? 'rewrite' : 'allow' })),
    { ...ROW, decision: 'deny' },
  ];
  fs.writeFileSync(path.join(sessionDir, 'dispatches.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
  if (budget !== undefined) {
    fs.writeFileSync(path.join(root, '.forge', 'config.json'), JSON.stringify({ budget: { subagents: budget } }));
  }
  return { root, sessionDir };
}

function forge(root, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-brief-fleet-'), 's') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lines = (text) => text.split('\n').filter(Boolean);
const isJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

test('forge status --brief prints health, phase, tasks, pace and dispatches in a few lines', () => {
  const { root } = makeProject({ ran: 3 });
  const full = JSON.parse(forge(root, ['status']).stdout);

  const r = forge(root, ['status', '--brief']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(isJson(r.stdout), false, 'not the JSON object');
  assert.ok(lines(r.stdout).length <= 6, `a few lines, got ${lines(r.stdout).length}`);
  assert.match(r.stdout, new RegExp(`^health: ${full.health.state}\\b`, 'm'));
  assert.match(r.stdout, new RegExp(`^phase: ${full.session.phase}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^tasks: ${full.session.tasksComplete}/${full.session.tasksTotal}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^pace: ${full.pace.resolved}$`, 'm'));
  assert.ok(lines(r.stdout).includes(full.dispatches.line), `carries "${full.dispatches.line}"`);
  assert.equal(full.dispatches.n, 3, 'allow and rewrite count, the denied row does not');
});

test('forge status --brief adds the warning line only when over the dispatch budget', () => {
  const over = makeProject({ ran: DEFAULT_DISPATCH_BUDGET + 1 });
  const within = makeProject({ ran: DEFAULT_DISPATCH_BUDGET });

  const overFull = JSON.parse(forge(over.root, ['status']).stdout);
  const overBrief = forge(over.root, ['status', '--brief']);
  const withinBrief = forge(within.root, ['status', '--brief']);

  assert.equal(typeof overFull.dispatches.warning, 'string');
  assert.ok(lines(overBrief.stdout).includes(overFull.dispatches.warning), 'the warning line is printed verbatim');
  assert.doesNotMatch(withinBrief.stdout, /budget exceeded/i);
});

test('forge status --brief shows ? for an unreadable dispatch log, never 0', () => {
  const { root, sessionDir } = makeProject();
  fs.writeFileSync(path.join(sessionDir, 'dispatches.jsonl'), '{"decision":"all', 'utf8');

  const r = forge(root, ['status', '--brief']);

  assert.match(r.stdout, new RegExp(`^dispatches \\?/${DEFAULT_DISPATCH_BUDGET}$`, 'm'));
});

test('forge status without --brief still prints the JSON object', () => {
  const { root } = makeProject({ ran: 2 });

  const r = forge(root, ['status']);

  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'ok');
  assert.equal(out.sessionId, 's1');
  assert.equal(out.session.phase, 'implement');
  assert.equal(out.dispatches.n, 2);
  assert.ok('health' in out && 'progress' in out && 'pace' in out);
});

test('forge status --brief with no session says so in one line', () => {
  const root = tmp('forge-brief-none-');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });

  const r = forge(root, ['status', '--brief']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(isJson(r.stdout), false);
  assert.equal(lines(r.stdout).length, 1);
  assert.match(r.stdout, /No active Forge session/);
});

test('forge phase --brief records the transition and prints the short summary', () => {
  const { root, sessionDir } = makeProject({ phase: 'triage', ran: 2 });

  const r = forge(root, ['phase', 'plan', '--brief']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(isJson(r.stdout), false);
  assert.ok(lines(r.stdout).length <= 6);
  assert.match(r.stdout, /^phase: plan$/m);
  assert.match(r.stdout, /^tasks: 1\/3$/m);
  assert.match(r.stdout, /^pace: standard$/m);
  assert.match(r.stdout, new RegExp(`^dispatches 2/${DEFAULT_DISPATCH_BUDGET}$`, 'm'));
  assert.match(r.stdout, /^health: /m);
  const saved = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(saved.phase, 'plan', '--brief changes the output only, not what is recorded');
});

test('forge phase without --brief still prints { sessionId, phase, session }', () => {
  const { root } = makeProject({ phase: 'triage' });

  const r = forge(root, ['phase', 'plan']);

  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['sessionId', 'phase', 'session']);
  assert.equal(out.phase, 'plan');
});

test('forge status --brief still flags that it picked one of several open sessions', () => {
  const { root } = makeProject({ ran: 1 });
  const other = path.join(root, '.forge', 'sessions', 's2');
  fs.mkdirSync(other, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(other, 'session.json'),
    `${JSON.stringify({ id: 's2', slug: 'other', createdAt: now, updatedAt: now, phase: 'implement', tasksTotal: 1, tasksComplete: 0 })}\n`,
    'utf8',
  );
  const full = JSON.parse(forge(root, ['status']).stdout);
  assert.ok(full.sessionAmbiguity, 'fixture: the default JSON reports the ambiguity');

  const brief = forge(root, ['status', '--brief']);

  assert.equal(brief.status, 0, brief.stderr);
  const flag = lines(brief.stdout).find((l) => /pass --session/.test(l));
  assert.ok(flag, `an ambiguity line is printed:\n${brief.stdout}`);
  assert.match(flag, new RegExp(`1 of ${full.sessionAmbiguity.candidates.length}`));
  assert.ok(lines(brief.stdout).length <= 7, 'still a few lines');

  const alone = forge(makeProject({ ran: 1 }).root, ['status', '--brief']);
  assert.doesNotMatch(alone.stdout, /pass --session/, 'no ambiguity, no line');
});
