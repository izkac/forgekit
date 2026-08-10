import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectPlanFacts, suggestPaceFromPlan } from './plan-facts.mjs';

const SET_PHASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Project with a specs-engine change the facts can be read from. */
function makeChange(root, { tasks = '', proposal = '# Why\nBecause.\n', spine = null, capabilities = [] } = {}) {
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), proposal, 'utf8');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), tasks, 'utf8');
  if (spine) fs.writeFileSync(path.join(changeDir, 'spine.json'), `${JSON.stringify(spine)}\n`, 'utf8');
  for (const cap of capabilities) {
    const dir = path.join(changeDir, 'specs', cap);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.md'), '## ADDED Requirements\n', 'utf8');
  }
  return changeDir;
}

const session = { planType: 'specs', openspecChange: 'my-change', slug: 'my-change' };

function tasksMd(groups) {
  return groups
    .map(
      ([title, n], idx) =>
        `## ${idx + 1}. ${title}\n${Array.from({ length: n }, (_, i) => `- [ ] ${i + 1}.1 do it`).join('\n')}`,
    )
    .join('\n\n');
}

test('facts come from the plan: tasks, groups, spine rows, capabilities', () => {
  const root = tmp('forge-facts-');
  makeChange(root, {
    tasks: tasksMd([['Model', 3], ['API', 2]]),
    spine: { rows: [{ capability: 'a' }, { capability: 'b' }], notApplicable: null },
    capabilities: ['billing', 'reporting'],
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.tasks, 5);
  assert.equal(facts.groups, 2);
  assert.equal(facts.spineRows, 2);
  assert.equal(facts.capabilities, 2);
});

test('a small single-surface change finally resolves to brisk', () => {
  // Five sessions in a row resolved `standard` — three of them via
  // "unrecognized scope — failing closed" — because the classifier read a
  // free-text slug. brisk and lite existed but were never selected.
  const root = tmp('forge-facts-small-');
  makeChange(root, {
    tasks: tasksMd([['Tweak', 3]]),
    spine: { rows: [], notApplicable: 'sync UI only — no producer/consumer loop' },
    capabilities: ['toolbar'],
  });

  const { pace, reason } = suggestPaceFromPlan(collectPlanFacts({ cwd: root, session }));
  assert.equal(pace, 'brisk');
  assert.match(reason, /3 tasks/);
});

test('task count alone escalates to standard', () => {
  const root = tmp('forge-facts-many-');
  makeChange(root, {
    tasks: tasksMd([['A', 8], ['B', 8], ['C', 4]]),
    spine: { rows: [], notApplicable: 'sync only' },
  });

  const { pace, reason } = suggestPaceFromPlan(collectPlanFacts({ cwd: root, session }));
  assert.equal(pace, 'standard');
  assert.match(reason, /20 tasks/);
});

test('a wired spine escalates to standard even when the task list is short', () => {
  const root = tmp('forge-facts-spine-');
  makeChange(root, {
    tasks: tasksMd([['Worker', 4]]),
    spine: { rows: [{ capability: 'ingest' }, { capability: 'notify' }, { capability: 'report' }], notApplicable: null },
  });

  const { pace, reason } = suggestPaceFromPlan(collectPlanFacts({ cwd: root, session }));
  assert.equal(pace, 'standard');
  assert.match(reason, /3 spine row/);
});

test('money/auth anywhere in the plan holds standard, not thorough', () => {
  // The per-task hard floor already reviews the risky tasks. Escalating the
  // whole session to thorough also bought a per-task reviewer for every
  // low-risk task sharing the change, which is where the cost went.
  const root = tmp('forge-facts-risk-');
  makeChange(root, {
    tasks: tasksMd([['Refund', 2]]),
    proposal: '# Why\n\nIssue partial refunds through the payment provider.\n',
    spine: { rows: [], notApplicable: 'sync only' },
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.highRisk, true);
  const { pace, reason } = suggestPaceFromPlan(facts);
  assert.equal(pace, 'standard');
  assert.match(reason, /money|auth|risk/i);
  assert.match(reason, /per-task/i);
});

test('a high-risk plan never resolves to brisk, however small it is', () => {
  // Two tasks, one capability, no spine rows — the brisk shape exactly. Risk
  // has to outrank it, or the floor is the only thing left standing.
  const root = tmp('forge-facts-risk-small-');
  makeChange(root, {
    tasks: tasksMd([['Rotate', 2]]),
    proposal: '# Why\n\nRotate the signing secret used by the webhook.\n',
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['webhook'],
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.highRisk, true);
  assert.equal(suggestPaceFromPlan(facts).pace, 'standard');
});

test('risk in the spine counts even when the proposal never says it', () => {
  const root = tmp('forge-facts-spinerisk-');
  makeChange(root, {
    tasks: tasksMd([['Export', 2]]),
    spine: { rows: [{ capability: 'export', runtimeOwner: 'authorization gate on GET /export' }], notApplicable: null },
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.highRisk, true);
  assert.equal(suggestPaceFromPlan(facts).pace, 'standard');
});

test('forge phase implement re-resolves auto pace from the plan', () => {
  // End-to-end through the CLI: this is the test that catches a missing
  // import, which a try/catch around the resolver would otherwise hide.
  const root = tmp('forge-facts-phase-');
  makeChange(root, {
    tasks: tasksMd([['Tweak', 3]]),
    spine: { rows: [], notApplicable: 'sync UI only' },
    capabilities: ['toolbar'],
  });
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'my-change',
      createdAt: now,
      updatedAt: now,
      phase: 'plan',
      planType: 'specs',
      openspecChange: 'my-change',
      tasksTotal: 3,
      tasksComplete: 0,
      pace: 'auto',
      resolvedPace: 'standard',
      paceReason: 'unrecognized scope — failing closed',
      pacePinned: false,
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );

  execFileSync(
    process.execPath,
    [SET_PHASE, 'implement', '--tasks-total', '3', '--allow-incomplete', 'brief not needed in test'],
    { cwd: root, env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('facts-fleet-'), 's') } },
  );

  const saved = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(saved.resolvedPace, 'brisk');
  assert.equal(saved.paceResolvedFrom, 'plan');
  assert.match(saved.paceReason, /^plan: /);
});

test('an unreadable plan fails closed to standard, never to brisk', () => {
  const root = tmp('forge-facts-none-');
  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.tasks, 0);
  assert.equal(facts.readable, false);
  const { pace, reason } = suggestPaceFromPlan(facts);
  assert.equal(pace, 'standard');
  assert.match(reason, /could not read|fail/i);
});

test('Notes and fenced headings do not inflate groups; numbered ## N. / ## N) do', () => {
  const root = tmp('forge-facts-groups-');
  makeChange(root, {
    tasks: [
      '## 1. Protect the denominator',
      '- [ ] 1.1 strip fences',
      '- [ ] 1.2 numbered GROUP_RE',
      '',
      '## Notes',
      '- leftover thoughts',
      '',
      '```md',
      '## 99. Fake group inside fence',
      '- [ ] should not count as a task either if fenced',
      '```',
      '',
      '## 2) Product loop',
      '- [ ] 2.1 e2e plant',
    ].join('\n'),
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.groups, 2);
  assert.equal(facts.tasks, 3);
});

test('headingless tasks.md with checkboxes reports groups: 0', () => {
  const root = tmp('forge-facts-headingless-');
  makeChange(root, {
    tasks: ['- [ ] do the thing', '- [ ] and another'].join('\n'),
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.tasks, 2);
  assert.equal(facts.groups, 0);
});
