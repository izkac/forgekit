import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMBINED_TASKS,
  collectPlanFacts,
  suggestCeremonyFromPlan,
  suggestExitFromPlan,
  suggestPaceFromPlan,
} from './plan-facts.mjs';
import { createSpecsChange } from './change.mjs';
import { writeProjectPlanConfig } from './plan-engine.mjs';

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

test('the >=15-tasks branch itself fires, not just the same-pace default fallback', () => {
  // The test above only asserts pace==='standard' and reason matches /20
  // tasks/ — both of which the *default* fallback branch (reached when no
  // other rule matches) also satisfies for any tasks>=6, since it too is
  // 'standard' and its reason also interpolates facts.tasks. Disabling the
  // `facts.tasks >= STANDARD_TASKS` branch by hand left that test green,
  // proving it discriminates nothing about this specific rule. Assert the
  // exact reason template the task-count branch alone produces (it names
  // "across N group(s)"; the default fallback names "spine row(s) —
  // default") so a disabled branch is caught here even though the resolved
  // pace does not change.
  const root = tmp('forge-facts-many-exact-');
  makeChange(root, {
    tasks: tasksMd([['A', 5], ['B', 5], ['C', 5]]),
    spine: { rows: [], notApplicable: 'sync only' },
  });

  const facts = collectPlanFacts({ cwd: root, session });
  const { pace, reason } = suggestPaceFromPlan(facts);
  assert.equal(pace, 'standard');
  assert.equal(reason, `${facts.tasks} tasks across ${facts.groups} group(s)`);
  assert.doesNotMatch(reason, /default/);
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

test('the spineRows>=2 branch itself fires, not just the same-pace default fallback', () => {
  // Same non-discriminating shape as the >=15-tasks case above: disabling
  // `facts.spineRows >= 2` by hand leaves the test above green, because the
  // default fallback also returns 'standard' and its reason also
  // interpolates `${facts.spineRows} spine row(s)` — /3 spine row/ matches
  // whichever branch produced it. Assert the exact reason template only the
  // spineRows branch emits ("spine rows —", not "spine row(s) — default").
  const root = tmp('forge-facts-spine-exact-');
  makeChange(root, {
    tasks: tasksMd([['Worker', 4]]),
    spine: { rows: [{ capability: 'ingest' }, { capability: 'notify' }, { capability: 'report' }], notApplicable: null },
  });

  const facts = collectPlanFacts({ cwd: root, session });
  const { pace, reason } = suggestPaceFromPlan(facts);
  assert.equal(pace, 'standard');
  assert.equal(reason, `${facts.spineRows} spine rows — wired capabilities need per-group review`);
  assert.doesNotMatch(reason, /default/);
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
  assert.match(reason, /task lines/i);
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

test('ceremony: a small clean change resolves to combined', () => {
  // Measured on sonnet-hard-v2: verify+review+done cost 2-4M tokens per trial
  // against 0.4-0.9M for implement. On a small change the tail IS the bill.
  const root = tmp('forge-ceremony-small-');
  makeChange(root, {
    tasks: tasksMd([['Fix', 2]]),
    spine: { rows: [], notApplicable: 'sync-only bugfix' },
    capabilities: ['pagination'],
  });

  const { ceremony, reason } = suggestCeremonyFromPlan(collectPlanFacts({ cwd: root, session }));
  assert.equal(ceremony, 'combined');
  assert.match(reason, /2 task/);
});

test('ceremony: agents split small fixes into micro-tasks — 4-5 tasks still combine', () => {
  // Cohort 3 measured the gate misfiring: every direct session declared 3-5
  // tasks for a one-file bugfix (red, green, full-suite as separate ticks),
  // so a <=2 threshold never fired at all. Task count is granularity, not
  // size; capabilities and spine rows carry the size signal.
  const root = tmp('forge-ceremony-micro-');
  makeChange(root, {
    tasks: tasksMd([['Fix', 5]]),
    spine: { rows: [], notApplicable: 'sync-only bugfix' },
    capabilities: ['reconciliation'],
  });

  assert.equal(suggestCeremonyFromPlan(collectPlanFacts({ cwd: root, session })).ceremony, 'combined');
});

test('risk read ignores negated mentions: "no money/auth impact" is not a money change', () => {
  // Cohort 3, carrier task: the proposal said "Risk: low — no persistence
  // migration, no API shape change" and "design.md skipped: ... no money/auth"
  // — wording our own plan-phase rule suggests — and the keyword regex forced
  // the full tail. Negation lines must not count; affirmative lines must.
  const root = tmp('forge-ceremony-negation-');
  makeChange(root, {
    tasks: tasksMd([['Fix', 3]]),
    proposal: [
      '# Repair reconciliation',
      '',
      '## Impact',
      '- Risk: low — in-memory stores only, no persistence migration, no API shape change.',
      '- `design.md` skipped: single capability, under 6 tasks, no money/auth surface.',
      '',
    ].join('\n'),
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['reconciliation'],
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.highRisk, false);
  assert.equal(suggestCeremonyFromPlan(facts).ceremony, 'combined');
});

test('an untouched `forge change new` scaffold is not high-risk (F129)', () => {
  // The proposal template's Impact placeholder says "risks, migration notes"
  // and a `--capability auth` bullet names auth verbatim — the risk read took
  // the CLI's own boilerplate as a money/auth/migration signal and forced the
  // full tail on every freshly scaffolded change.
  for (const capabilities of [[], ['toolbar'], ['auth']]) {
    const root = tmp('forge-facts-scaffold-');
    writeProjectPlanConfig(root, { engine: 'specs' });
    createSpecsChange(root, 'my-change', { capabilities });

    const facts = collectPlanFacts({ cwd: root, session });
    assert.equal(
      facts.highRisk,
      false,
      `scaffold with capabilities ${JSON.stringify(capabilities)} must not classify high-risk`,
    );
  }
});

test('scaffold stripping still hears a real risk the user wrote (F129)', () => {
  // Line-level, not file-level: a proposal the user edited keeps only their
  // lines in the risk read, and an affirmative migration mention in them must
  // still classify — the strip protects placeholders, not risk words.
  const root = tmp('forge-facts-scaffold-real-');
  writeProjectPlanConfig(root, { engine: 'specs' });
  createSpecsChange(root, 'my-change');
  fs.appendFileSync(
    path.join(root, 'specs', 'changes', 'my-change', 'proposal.md'),
    '\nWe must migrate the sessions table to the new schema.\n',
    'utf8',
  );

  assert.equal(collectPlanFacts({ cwd: root, session }).highRisk, true);
});

test('ceremony: high-risk always gets the full tail', () => {
  const root = tmp('forge-ceremony-risk-');
  makeChange(root, {
    tasks: tasksMd([['Refund', 2]]),
    proposal: '# Why\n\nIssue partial refunds through the payment provider.\n',
    spine: { rows: [], notApplicable: 'sync only' },
  });

  assert.equal(suggestCeremonyFromPlan(collectPlanFacts({ cwd: root, session })).ceremony, 'full');
});

test('ceremony: wired spine rows keep the full tail (product loop needs verify)', () => {
  const root = tmp('forge-ceremony-spine-');
  makeChange(root, {
    tasks: tasksMd([['Worker', 2]]),
    spine: { rows: [{ capability: 'ingest' }], notApplicable: null },
  });

  assert.equal(suggestCeremonyFromPlan(collectPlanFacts({ cwd: root, session })).ceremony, 'full');
});

test('ceremony: more tasks or capabilities keep the full tail; unreadable fails closed', () => {
  const root = tmp('forge-ceremony-big-');
  makeChange(root, {
    tasks: tasksMd([['Model', 3], ['API', 2]]),
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['billing', 'reporting'],
  });

  assert.equal(suggestCeremonyFromPlan(collectPlanFacts({ cwd: root, session })).ceremony, 'full');
  assert.equal(suggestCeremonyFromPlan(collectPlanFacts({ cwd: tmp('forge-ceremony-none-'), session })).ceremony, 'full');
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
  // 3 tasks, single capability, spine notApplicable, no risk — combines.
  assert.equal(saved.resolvedCeremony, 'combined');
  assert.ok(saved.ceremonyReason);
});

test('ceremony fallback: a small direct session combines; a risky slug never does', () => {
  // The eval cohorts ran mostly `direct` sessions with 0-1 tasks and no change
  // dir — exactly the sessions whose tail dominates the bill. The fallback
  // reads the session's own declared facts.
  for (const [slug, tasksTotal, expected] of [
    ['fix-pagination-boundary', 2, 'combined'],
    ['fix-pagination-boundary', 5, 'combined'],
    ['rotate-webhook-secret', 2, 'full'],
    ['fix-pagination-boundary', 6, 'full'],
  ]) {
    const root = tmp('forge-ceremony-direct-');
    const sessionDir = path.join(root, '.forge', 'sessions', 's1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      `${JSON.stringify({
        id: 's1', slug, createdAt: now, updatedAt: now, phase: 'plan',
        planType: 'direct', openspecChange: null, tasksTotal, tasksComplete: 0,
        pace: 'auto', resolvedPace: 'standard', paceReason: 'test', paceSignal: slug, pacePinned: false,
      })}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');

    execFileSync(
      process.execPath,
      [SET_PHASE, 'implement', '--tasks-total', String(tasksTotal), '--allow-incomplete', 'no brief in test'],
      { cwd: root, env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('facts-fleet-'), 's') } },
    );

    const saved = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(saved.resolvedCeremony, expected, `${slug} tasksTotal=${tasksTotal}`);
  }
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

// --- 4.1: plan-time exit-condition resolution -----------------------------
//
// D2: the exit ramp offers to leave Forge entirely for a shape that already
// earns the combined tail — few tasks, single capability, no wired spine
// rows, no high-risk surface. `suggestExitFromPlan` reuses COMBINED_TASKS
// (the ceremony resolver's "few tasks") rather than a third threshold; see
// the function's own doc comment for why that one and not BRISK_TASKS.

test('exit ramp: a small single-capability change with no spine rows qualifies', () => {
  const root = tmp('forge-exit-small-');
  makeChange(root, {
    tasks: tasksMd([['Fix', 2]]),
    spine: { rows: [], notApplicable: 'sync-only bugfix' },
    capabilities: ['pagination'],
  });

  const facts = collectPlanFacts({ cwd: root, session });
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, true);
  // Exact template, not a substring match — every branch in this resolver
  // interpolates the same facts, so a loose match cannot tell them apart.
  assert.equal(
    reason,
    `${facts.tasks} task(s), single capability, no spine rows — small enough to leave Forge`,
  );
});

test('exit ramp: high-risk work never qualifies, however small', () => {
  // Two tasks, one capability, no spine rows — the qualifying shape exactly.
  // Risk has to outrank it, the same discipline the pace resolver's own
  // "however small" test uses.
  const root = tmp('forge-exit-risk-');
  makeChange(root, {
    tasks: tasksMd([['Rotate', 2]]),
    proposal: '# Why\n\nRotate the signing secret used by the webhook.\n',
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['webhook'],
  });

  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.highRisk, true);
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, false);
  assert.equal(reason, 'high-risk change — no exit offered, however small');
});

test('exit ramp: a wired spine row never qualifies, however small the task list', () => {
  const root = tmp('forge-exit-spine-');
  makeChange(root, {
    tasks: tasksMd([['Worker', 1]]),
    spine: { rows: [{ capability: 'ingest' }], notApplicable: null },
  });

  const facts = collectPlanFacts({ cwd: root, session });
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, false);
  assert.equal(reason, `${facts.spineRows} spine row(s) — a wired capability needs a tracked change`);
});

test('exit ramp: more tasks or more than one capability does not qualify', () => {
  const root = tmp('forge-exit-big-');
  makeChange(root, {
    tasks: tasksMd([['Model', 3], ['API', 2]]),
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['billing', 'reporting'],
  });

  const facts = collectPlanFacts({ cwd: root, session });
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, false);
  assert.equal(
    reason,
    `${facts.tasks} tasks, ${facts.capabilities} capability dir(s) — too large to leave Forge`,
  );
});

test('exit ramp: an unreadable plan fails closed — no exit offered', () => {
  const root = tmp('forge-exit-none-');
  const facts = collectPlanFacts({ cwd: root, session });
  assert.equal(facts.readable, false);
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, false);
  assert.equal(reason, 'could not read the plan — failing closed, no exit offered');
});

test('exit ramp: reuses the ceremony resolver’s COMBINED_TASKS boundary, not a new number', () => {
  // At the boundary: qualifies. One past it: does not — proving the
  // resolver reads COMBINED_TASKS itself rather than a hand-typed literal
  // that happens to agree with it today.
  const atBoundary = tmp('forge-exit-boundary-at-');
  makeChange(atBoundary, {
    tasks: tasksMd([['Fix', COMBINED_TASKS]]),
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['pagination'],
  });
  const overBoundary = tmp('forge-exit-boundary-over-');
  makeChange(overBoundary, {
    tasks: tasksMd([['Fix', COMBINED_TASKS + 1]]),
    spine: { rows: [], notApplicable: 'sync only' },
    capabilities: ['pagination'],
  });

  assert.equal(suggestExitFromPlan(collectPlanFacts({ cwd: atBoundary, session })).qualifies, true);
  assert.equal(suggestExitFromPlan(collectPlanFacts({ cwd: overBoundary, session })).qualifies, false);
});

test('exit ramp: zero tasks does not qualify — unshaped, not small', () => {
  // Fix round, group review item 5. Reused COMBINED_TASKS's own doc comment
  // argued from `collectPlanFacts` reading a real tasks.md, where tasks===0
  // is a *measured* fact about an (unusually) empty plan. Under `forge
  // exit-check` (4.5) tasks is instead *asserted* by the agent before
  // anything is scaffolded — "0 tasks" there means nothing has been shaped
  // yet, not that a shaped change happens to be trivially small. Zero is
  // excluded explicitly rather than left to fall through to the qualifying
  // branch's `<= COMBINED_TASKS` check.
  const facts = { readable: true, tasks: 0, capabilities: 1, spineRows: 0, highRisk: false };
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, false);
  assert.equal(reason, 'zero tasks — nothing shaped yet, not a small change, no exit offered');
});

test('exit ramp: a high-risk shape with zero tasks reports the high-risk reason, not the zero-tasks one', () => {
  // Branch order: risk and wired-spine facts are meaningful regardless of
  // task count, so they must still win over the (new) zero-tasks guard —
  // "high-risk, however small" outranks "nothing shaped yet".
  const facts = { readable: true, tasks: 0, capabilities: 1, spineRows: 0, highRisk: true };
  const { qualifies, reason } = suggestExitFromPlan(facts);
  assert.equal(qualifies, false);
  assert.equal(reason, 'high-risk change — no exit offered, however small');
});
