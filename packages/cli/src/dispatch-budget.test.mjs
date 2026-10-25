/**
 * Dispatch budget (cost-levers group 1): the plan-time projection, the
 * `forge phase implement` warning, and the running `dispatches n/budget` count
 * shown by `forge status`, the session reminder and the sessions.jsonl digest.
 *
 * Warn, never block: nothing here may change an exit code or refuse a phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectPlanFacts, projectDispatches } from './plan-facts.mjs';
import { isHighRiskText } from './preferences.mjs';
import { readLedger, appendSessionDigest } from './ledger.mjs';
import {
  DEFAULT_DISPATCH_BUDGET,
  dispatchBudgetState,
  readDispatches,
  readDispatchesChecked,
  resolveDispatchBudget,
} from './metrics/dispatches.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SET_PHASE = path.join(SRC, 'set-phase.mjs');
const SESSION_STATUS = path.join(SRC, 'session-status.mjs');
const SESSION_REMINDER = path.join(SRC, 'session-reminder.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Project with a specs-engine change the facts can be read from. */
function makeChange(root, tasks) {
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Why\nBecause.\n', 'utf8');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), tasks, 'utf8');
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

/** tasks.md text from [title, [task text, …]] groups — each task is its own line. */
function tasksFromLines(groups) {
  return groups
    .map(
      ([title, lines], idx) =>
        `## ${idx + 1}. ${title}\n${lines.map((t, i) => `- [ ] ${idx + 1}.${i + 1} ${t}`).join('\n')}`,
    )
    .join('\n\n');
}

function factsFor(prefix, tasks) {
  const root = tmp(prefix);
  makeChange(root, tasks);
  return collectPlanFacts({ cwd: root, session });
}

test('projectDispatches: 6 groups of 5 tasks on standard projects units, group reviewers and the final review', () => {
  const groupCount = 6;
  const perGroup = 5;
  const facts = factsFor(
    'forge-proj-over-',
    tasksMd(Array.from({ length: groupCount }, (_, i) => [`Group ${i}`, perGroup])),
  );

  const p = projectDispatches(facts, 'standard');

  const unitsPerGroup = Math.ceil(perGroup / 4); // ≤4 tasks per unit
  assert.equal(p.implementers, groupCount * unitsPerGroup);
  assert.equal(p.reviewers, groupCount); // per-group review on standard
  assert.equal(p.final, 1);
  assert.equal(p.total, p.implementers + p.reviewers + p.final);
  assert.equal(p.groups.length, groupCount);
  for (const g of p.groups) assert.equal(g.total, unitsPerGroup + 1);
  assert.equal(
    p.groups.reduce((sum, g) => sum + g.total, 0) + p.final,
    p.total,
    'per-group contributions plus the final review add up to the total',
  );
});

test('projectDispatches: 2 groups of 3 tasks is one unit and one reviewer per group', () => {
  const facts = factsFor('forge-proj-within-', tasksMd([['A', 3], ['B', 3]]));
  const p = projectDispatches(facts, 'standard');
  assert.equal(p.implementers, 2);
  assert.equal(p.reviewers, 2);
  assert.equal(p.total, 2 + 2 + 1);
});

test('projectDispatches: a plan with no ## groups is one implementer plus the final review', () => {
  const facts = factsFor('forge-proj-direct-', '- [ ] one thing\n- [ ] another thing\n- [ ] third thing\n');
  assert.equal(facts.groups, 0);
  assert.ok(facts.tasks > 0, 'fixture has tasks but no groups');
  const p = projectDispatches(facts, 'standard');
  assert.deepEqual(
    { implementers: p.implementers, reviewers: p.reviewers, final: p.final, total: p.total },
    { implementers: 1, reviewers: 0, final: 1, total: 2 },
  );
  assert.deepEqual(p.groups, []);
});

test('projectDispatches: a high-risk task line is its own unit and is not counted in the chunk', () => {
  // 4 tasks, one of them money: 1 (the refund task) + ceil(3/4) = 2 units.
  // A projection that chunked all 4 together would say 1 — this fixture is the
  // one that tells the two apart.
  const lines = ['Add the model', 'Add refund endpoint', 'Add the list view', 'Add the docs page'];
  const facts = factsFor('forge-proj-risk-', tasksFromLines([['Refunds', lines]]));
  const riskyCount = lines.filter((t) => isHighRiskText(t)).length;
  assert.equal(riskyCount, 1, 'fixture sanity: exactly one task line reads as high-risk');

  const p = projectDispatches(facts, 'standard');

  assert.equal(p.implementers, riskyCount + Math.ceil((lines.length - riskyCount) / 4));
  assert.notEqual(p.implementers, Math.ceil(lines.length / 4));
});

test('projectDispatches: never/high-risk-only paces review only a group holding a high-risk task line', () => {
  const facts = factsFor(
    'forge-proj-brisk-',
    tasksFromLines([
      ['Plain', ['Add the model', 'Add the list view']],
      ['Risky', ['Add refund endpoint', 'Add the docs page']],
    ]),
  );

  const brisk = projectDispatches(facts, 'brisk');
  const standard = projectDispatches(facts, 'standard');

  assert.equal(brisk.reviewers, 1, 'only the group with the refund task');
  assert.equal(brisk.groups.find((g) => g.title === 'Plain').reviewers, 0);
  assert.equal(brisk.groups.find((g) => g.title === 'Risky').reviewers, 1);
  assert.equal(standard.reviewers, 2);
  assert.equal(standard.total - brisk.total, 1);
});

test('projectDispatches: accepts expanded preferences, so a review.perTask override is honoured', () => {
  const facts = factsFor('forge-proj-eff-', tasksMd([['A', 2], ['B', 2]]));
  const never = projectDispatches(facts, { review: { perTask: 'never' } });
  const perGroup = projectDispatches(facts, { review: { perTask: 'per-group' } });
  assert.equal(never.reviewers, 0);
  assert.equal(perGroup.reviewers, 2);
});

test('projectDispatches: an unreadable plan still projects the floor, never a smaller number', () => {
  const p = projectDispatches({ readable: false, tasks: 0, groups: 0, taskGroups: [] }, 'standard');
  assert.equal(p.total, 2);
});

test('projectDispatches: tasks ahead of the first ## group are projected, not dropped', () => {
  const facts = factsFor(
    'forge-proj-lead-',
    `- [ ] loose setup task\n\n${tasksMd([['A', 2]])}\n`,
  );
  assert.equal(facts.groups, 1);
  const grouped = facts.taskGroups.reduce((n, g) => n + g.tasks, 0);
  assert.equal(grouped, facts.tasks, 'every task line lands in some unit');
  assert.equal(projectDispatches(facts, 'standard').implementers, facts.taskGroups.length);
});

// --- dispatch budget warning on `forge phase implement` -------------------

const SCRIPT = SET_PHASE;

/**
 * Scratch forge layout under `dir`: active.json + a session at `plan`.
 * set-phase.mjs resolves `.forge` from cwd, so tests run it as a child process.
 */
function makeForgeFixture(dir, sessionId) {
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const sessionFile = path.join(sessionDir, 'session.json');
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify(
      {
        id: sessionId,
        slug: 'fixture',
        createdAt: now,
        updatedAt: now,
        phase: 'plan',
        planType: null,
        openspecChange: null,
        forgeSkipped: false,
        cursorChatId: null,
        tasksTotal: 0,
        tasksComplete: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId })}\n`, 'utf8');
  return sessionFile;
}

/**
 * A specs-engine project at `plan` with a tracked change whose tasks.md has the
 * given group sizes ([title, taskCount]). `config` is written to
 * .forge/config.json when given. Returns { root, sessionFile }.
 */
function makeBudgetProject(groups, { config, resolvedPace = 'standard' } = {}) {
  const root = fs.realpathSync(tmp('forge-budget-'));
  const sessionFile = makeForgeFixture(root, 'budget-sess');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  Object.assign(session, {
    slug: 'budget-change',
    planType: 'specs',
    openspecChange: 'budget-change',
    pace: 'auto',
    resolvedPace,
    paceReason: 'test',
    pacePinned: false,
  });
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
  const changeDir = path.join(root, 'specs', 'changes', 'budget-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Why\nBecause.\n');
  const body = groups
    .map(
      ([title, n], g) =>
        `## ${g + 1}. ${title}\n${Array.from({ length: n }, (_, i) => `- [ ] ${g + 1}.${i + 1} do the thing`).join('\n')}`,
    )
    .join('\n\n');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), `${body}\n`);
  if (config) fs.writeFileSync(path.join(root, '.forge', 'config.json'), JSON.stringify(config));
  return { root, sessionFile };
}

function implementFrom(root) {
  return spawnSync(
    process.execPath,
    [SCRIPT, 'implement', '--allow-incomplete', 'no brief in test'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('budget-fleet-'), 's') } },
  );
}

test('phase implement warns when the plan projects more dispatches than budget.subagents, and still transitions', () => {
  // Unequal groups, so "the largest contributors" is a real selection: a flat
  // 6x5 plan would make every group a tie and pass for any ordering.
  const groups = [['Bulk', 9], ['Mid', 5], ['Third', 5], ['Wee', 1], ['Tiny', 1], ['Mini', 1]];
  const { root, sessionFile } = makeBudgetProject(groups);

  const r = implementFrom(root);

  assert.equal(r.status, 0, r.stderr);
  const contributions = groups.map(([title, n]) => ({ title, total: Math.ceil(n / 4) + 1 }));
  const projected = contributions.reduce((s, g) => s + g.total, 0) + 1;
  assert.ok(projected > 15, 'fixture must exceed the default budget');
  assert.match(r.stderr, new RegExp(`projects ${projected} subagent dispatches`));
  assert.match(r.stderr, /budget 15/);
  const ranked = [...contributions].sort((a, b) => b.total - a.total);
  assert.ok(ranked[2].total > ranked[3].total, 'fixture: the top three are separated from the rest');
  for (const g of ranked.slice(0, 3)) assert.match(r.stderr, new RegExp('"' + g.title + '"'));
  for (const g of ranked.slice(3)) assert.doesNotMatch(r.stderr, new RegExp('"' + g.title + '"'), 'only the largest contributors are named');
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(saved.phase, 'implement');
  assert.equal(saved.dispatchProjected, projected, 'the projection is kept on the session for status and the digest');
});

test('phase implement is silent about the budget when the projection fits', () => {
  const groups = [['A', 3], ['B', 3]];
  const { root, sessionFile } = makeBudgetProject(groups);

  const r = implementFrom(root);

  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /dispatch/i);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).dispatchProjected, groups.length * 2 + 1);
});

test('phase implement reads budget.subagents from .forge/config.json', () => {
  const groups = [['A', 3], ['B', 3]];
  const projected = groups.length * 2 + 1;
  const tight = makeBudgetProject(groups, { config: { budget: { subagents: projected - 1 } } });
  const exact = makeBudgetProject(groups, { config: { budget: { subagents: projected } } });

  const over = implementFrom(tight.root);
  const at = implementFrom(exact.root);

  assert.equal(over.status, 0, over.stderr);
  assert.match(over.stderr, new RegExp('budget ' + (projected - 1) + '[.]'));
  assert.equal(at.status, 0, at.stderr);
  assert.doesNotMatch(at.stderr, /dispatch/i, 'at the budget is within it');
});

test('phase implement falls back to the default budget on an invalid budget.subagents', () => {
  const groups = [['G1', 8], ['G2', 8], ['G3', 8], ['G4', 8], ['G5', 8]];
  const projected = groups.length * (Math.ceil(8 / 4) + 1) + 1;
  assert.ok(projected > 15, 'fixture must exceed the default budget');
  for (const bad of [0, -4, 'lots', null, 2.5]) {
    const { root } = makeBudgetProject(groups, { config: { budget: { subagents: bad } } });
    const r = implementFrom(root);
    assert.equal(r.status, 0, `${JSON.stringify(bad)}: ${r.stderr}`);
    assert.match(r.stderr, /budget 15\b/, `${JSON.stringify(bad)} falls back to 15`);
  }
});

test('phase implement on a direct plan (no groups) projects one implementer plus the final review, silently', () => {
  const { root, sessionFile } = makeBudgetProject([]);
  const changeDir = path.join(root, 'specs', 'changes', 'budget-change');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [ ] one\n- [ ] two\n');

  const r = implementFrom(root);

  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /dispatch/i);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).dispatchProjected, 2);
});


// --- running count: readable vs missing, status, reminder, digest ---------

/** A session dir with an optional dispatches.jsonl. */
function dispatchSession(rows) {
  const sessionDir = path.join(tmp('forge-dispatch-'), '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'dispatches.jsonl');
  if (rows) fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
  return { sessionDir, file, root: path.resolve(sessionDir, '..', '..', '..') };
}

const ROW = { tool: 'Agent', agentType: 'general-purpose', modelRequested: 'sonnet', modelResolved: 'sonnet', reason: null };

/** `allowed` allow rows mixed with rows that must not count (rewrite, deny, unclassified). */
function mixedRows(allowed) {
  return [
    ...Array.from({ length: allowed }, () => ({ ...ROW, decision: 'allow' })),
    { ...ROW, decision: 'rewrite' },
    { ...ROW, decision: 'rewrite' },
    { ...ROW, decision: 'deny' },
    { ...ROW, decision: null },
  ];
}


test('readDispatchesChecked: a session that never dispatched is readable with no rows', () => {
  const { sessionDir } = dispatchSession(null);
  assert.deepEqual(readDispatchesChecked(sessionDir), { rows: [], readable: true });
});

test('readDispatchesChecked: a log that cannot be read, or holds a line that is not JSON, is not readable', () => {
  const dirAsLog = dispatchSession(null);
  fs.mkdirSync(dirAsLog.file); // reading a directory fails with something other than ENOENT
  assert.equal(readDispatchesChecked(dirAsLog.sessionDir).readable, false);

  const torn = dispatchSession(null);
  fs.writeFileSync(torn.file, `${JSON.stringify({ ...ROW, decision: 'allow' })}\n{"decision":"all`, 'utf8');
  const result = readDispatchesChecked(torn.sessionDir);
  assert.equal(result.readable, false);
  assert.equal(result.rows.length, 1, 'the rows that did parse are still returned');
  assert.equal(
    readDispatches(torn.sessionDir).length,
    1,
    'readDispatches keeps skipping a torn line, so metrics collection is unchanged',
  );

  assert.equal(readDispatchesChecked(null).readable, false);
});

test('resolveDispatchBudget: config value, else the default for anything that is not a positive integer', () => {
  const withConfig = (config) => {
    const root = tmp('forge-budget-cfg-');
    if (config !== undefined) {
      fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.forge', 'config.json'),
        typeof config === 'string' ? config : JSON.stringify(config),
      );
    }
    return resolveDispatchBudget(root);
  };
  assert.equal(withConfig({ budget: { subagents: DEFAULT_DISPATCH_BUDGET + 4 } }), DEFAULT_DISPATCH_BUDGET + 4);
  assert.equal(withConfig(undefined), DEFAULT_DISPATCH_BUDGET);
  assert.equal(withConfig('{ not json'), DEFAULT_DISPATCH_BUDGET);
  for (const bad of [0, -1, 1.5, '9', null]) {
    assert.equal(withConfig({ budget: { subagents: bad } }), DEFAULT_DISPATCH_BUDGET, JSON.stringify(bad));
  }
});

test('dispatchBudgetState: counts only decision "allow" lines and warns once past the budget', () => {
  const allowed = DEFAULT_DISPATCH_BUDGET + 2;
  const { sessionDir, root } = dispatchSession(mixedRows(allowed));

  const state = dispatchBudgetState({ sessionDir, cwd: root });

  assert.equal(state.n, allowed, 'rewrite, deny and unclassified rows are not allow lines');
  assert.equal(state.budget, DEFAULT_DISPATCH_BUDGET);
  assert.equal(state.line, `dispatches ${allowed}/${DEFAULT_DISPATCH_BUDGET}`);
  assert.equal(typeof state.warning, 'string');
  assert.ok(!state.warning.includes('\n'), 'one warning line');
  assert.match(state.warning, new RegExp(String(allowed)));
});

test('dispatchBudgetState: at the budget there is no warning; a missing log is a genuine 0', () => {
  const full = dispatchSession(mixedRows(DEFAULT_DISPATCH_BUDGET));
  const atBudget = dispatchBudgetState({ sessionDir: full.sessionDir, cwd: full.root });
  assert.equal(atBudget.line, `dispatches ${DEFAULT_DISPATCH_BUDGET}/${DEFAULT_DISPATCH_BUDGET}`);
  assert.equal(atBudget.warning, null);

  const missing = dispatchSession(null);
  const none = dispatchBudgetState({ sessionDir: missing.sessionDir, cwd: missing.root });
  assert.equal(none.n, 0);
  assert.equal(none.line, `dispatches 0/${DEFAULT_DISPATCH_BUDGET}`);
  assert.equal(none.warning, null);
});

test('dispatchBudgetState: an unreadable log reads "?", never 0, and raises no warning', () => {
  const broken = dispatchSession(null);
  fs.mkdirSync(broken.file);
  const state = dispatchBudgetState({ sessionDir: broken.sessionDir, cwd: broken.root });
  assert.equal(state.n, null);
  assert.equal(state.line, `dispatches ?/${DEFAULT_DISPATCH_BUDGET}`);
  assert.equal(state.warning, null);
});

test('dispatchBudgetState: the budget comes from .forge/config.json', () => {
  const allowed = 3;
  const { sessionDir, root } = dispatchSession(mixedRows(allowed));
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.json'), JSON.stringify({ budget: { subagents: allowed - 1 } }));
  const state = dispatchBudgetState({ sessionDir, cwd: root });
  assert.equal(state.line, `dispatches ${allowed}/${allowed - 1}`);
  assert.notEqual(state.warning, null);
});

/** A project at `implement` with an active session and the given dispatches.jsonl rows (or raw text). */
function makeRunningProject({ rows, raw, projected, config } = {}) {
  const { root, sessionDir } = dispatchSession(rows ?? null);
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'fixture',
      createdAt: now,
      updatedAt: now,
      phase: 'implement',
      planType: 'specs',
      openspecChange: 'my-change',
      tasksTotal: 3,
      tasksComplete: 1,
      ...(projected === undefined ? {} : { dispatchProjected: projected }),
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  if (raw !== undefined) fs.writeFileSync(path.join(sessionDir, 'dispatches.jsonl'), raw, 'utf8');
  if (config) fs.writeFileSync(path.join(root, '.forge', 'config.json'), JSON.stringify(config));
  return { root, sessionDir };
}

function runScript(script, root, args = []) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-budget-fleet-'), 's') };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env });
}

test('forge status shows dispatches n/budget and one warning past the budget', () => {
  const allowed = DEFAULT_DISPATCH_BUDGET + 2;
  const projected = DEFAULT_DISPATCH_BUDGET - 6;
  const { root } = makeRunningProject({ rows: mixedRows(allowed), projected });

  const r = runScript(SESSION_STATUS, root);

  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dispatches.line, `dispatches ${allowed}/${DEFAULT_DISPATCH_BUDGET}`);
  assert.equal(out.dispatches.n, allowed);
  assert.equal(out.dispatches.projected, projected, 'the projection stored at the implement transition');
  assert.equal(typeof out.dispatches.warning, 'string');
});

test('forge status shows ? for an unreadable log and 0 for a missing one', () => {
  const broken = makeRunningProject({ raw: '{"decision":"all' });
  const missing = makeRunningProject({});

  const a = JSON.parse(runScript(SESSION_STATUS, broken.root).stdout);
  const b = JSON.parse(runScript(SESSION_STATUS, missing.root).stdout);

  assert.equal(a.dispatches.line, `dispatches ?/${DEFAULT_DISPATCH_BUDGET}`);
  assert.equal(a.dispatches.n, null);
  assert.equal(b.dispatches.line, `dispatches 0/${DEFAULT_DISPATCH_BUDGET}`);
});

test('the session reminder carries dispatches n/budget and the over-budget warning', () => {
  const allowed = DEFAULT_DISPATCH_BUDGET + 2;
  const fewer = 2;
  const over = makeRunningProject({ rows: mixedRows(allowed) });
  const fine = makeRunningProject({ rows: mixedRows(fewer) });
  const broken = makeRunningProject({ raw: 'not json at all\n' });

  const overOut = runScript(SESSION_REMINDER, over.root, ['--format', 'plain']);
  const fineOut = runScript(SESSION_REMINDER, fine.root, ['--format', 'plain']);
  const brokenOut = runScript(SESSION_REMINDER, broken.root, ['--format', 'plain']);

  assert.equal(overOut.status, 0, overOut.stderr);
  assert.match(overOut.stdout, new RegExp(`dispatches ${allowed}/${DEFAULT_DISPATCH_BUDGET}`));
  assert.match(overOut.stdout, /Dispatch budget exceeded/);
  assert.match(fineOut.stdout, new RegExp(`dispatches ${fewer}/${DEFAULT_DISPATCH_BUDGET}`));
  assert.doesNotMatch(fineOut.stdout, /Dispatch budget exceeded/);
  assert.match(brokenOut.stdout, new RegExp(`dispatches \\?/${DEFAULT_DISPATCH_BUDGET}`));
  assert.doesNotMatch(brokenOut.stdout, /dispatches 0\//);
});

function digestFor({ rows, raw, projected, config }) {
  const { root, sessionDir } = makeRunningProject({ rows, raw, projected, config });
  const stored = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  appendSessionDigest({ cwd: root, sessionDir, session: stored, card: { score: 90, grade: 'A' } });
  return readLedger(path.join(root, '.forge', 'sessions.jsonl'))[0];
}

test('the sessions.jsonl digest records projected, actual and budget', () => {
  const allowed = 4;
  const budget = 8;
  const projected = 11;
  const entry = digestFor({ rows: mixedRows(allowed), projected, config: { budget: { subagents: budget } } });
  assert.deepEqual(entry.dispatchBudget, { projected, actual: allowed, budget });
});

test('the digest keeps unknowns as null: no stored projection, unreadable log', () => {
  const entry = digestFor({ raw: '{"decision":"all' });
  assert.deepEqual(entry.dispatchBudget, { projected: null, actual: null, budget: DEFAULT_DISPATCH_BUDGET });
});
