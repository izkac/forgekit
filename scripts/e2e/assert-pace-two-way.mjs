#!/usr/bin/env node
/**
 * Product loop for D4 (two-way pace resolution) and its suppression record.
 *
 * `maybeResolvePaceFromPlan` (packages/cli/src/set-phase.mjs), on the way into
 * `implement`, reads the plan (tasks.md, capabilities, spine rows, risk) and
 * resolves `auto` pace from it — in EITHER direction: a small, single-
 * capability, unwired plan lowers the pace as readily as a large one raises
 * it. A pinned pace never moves, but the plan is still evaluated against it so
 * a suppressed adjustment can be recorded (`session.paceSuppressed`) rather
 * than looking identical to "no signal ever fired" (D4's own framing).
 *
 * Drives the SHIPPED binary (packages/cli/bin/forge.mjs) — `forge new` to
 * create each session for real, `forge phase implement` to trigger the
 * resolver — against scratch sessions layered onto the same temp project
 * `scripts/e2e/harness-portability.mjs`'s `boot` phase builds (see its header
 * comment on this pattern), never against a real session in this checkout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
// Same path formula as harness-portability.mjs's SCRATCH — when this step
// runs after `boot-scratch-project` in the recorded e2e loop, it layers its
// own session fixtures onto that same project rather than building a second
// scaffolding rig. `ensureBootedProject` below makes this script runnable
// standalone (tier-2) too, before `boot` has ever run.
const SCRATCH = path.join(
  os.tmpdir(),
  `forgekit-e2e-harness-${createHash('sha256').update(REPO).digest('hex').slice(0, 10)}`,
);

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

/**
 * Run the real forge binary in `cwd`; never throws on a non-zero exit.
 * Mirrors harness-portability.mjs's own `forge()` helper.
 */
function forge(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', code: r.status };
}

/**
 * The minimal project shape harness-portability.mjs's own `makeProject`
 * builds, duplicated (not imported — that file is a standalone script, not a
 * library) so this loop stands up its own fixture when run before `boot`
 * ever has. Idempotent: leaves an already-booted project untouched.
 */
function ensureBootedProject(dir) {
  if (fs.existsSync(path.join(dir, '.forge', 'config.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'scratch', planType: 'specs', openspecChange: 'my-change' })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, 'specs', 'changes', 'my-change'), { recursive: true });
}
ensureBootedProject(SCRATCH);

/** Read a session.json back off disk. */
function readSession(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(SCRATCH, '.forge', 'sessions', sessionId, 'session.json'), 'utf8'));
}

/**
 * Build a real session (via `forge new`, never a hand-rolled session.json)
 * with its own tracked change dir, then patch the pace fields
 * `collectPlanFacts`/`maybeResolvePaceFromPlan` read — the same pattern
 * `review-coverage-cap.mjs` uses for its own session fixtures.
 *
 * @param {string} slug
 * @param {{ pace: string, resolvedPace: string, pacePinned: boolean, tasksBody: string }} opts
 */
function makePaceSession(slug, opts) {
  const created = forge(SCRATCH, ['new', slug, '--signal', 'bland internal pace fixture, nothing risky here']);
  if (created.code !== 0) fail(`forge new ${slug} exited ${created.code}`, created.out);
  let payload;
  try {
    payload = JSON.parse(created.stdout);
  } catch {
    fail(`forge new ${slug} stdout was not JSON`, created.out);
  }
  const sessionId = payload.sessionId;
  const sessionFile = path.join(SCRATCH, '.forge', 'sessions', sessionId, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.planType = 'specs';
  session.openspecChange = slug;
  session.pace = opts.pace;
  session.resolvedPace = opts.resolvedPace;
  session.pacePinned = opts.pacePinned === true;
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

  const changeDir = path.join(SCRATCH, 'specs', 'changes', slug);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), opts.tasksBody, 'utf8');
  fs.writeFileSync(
    path.join(changeDir, 'proposal.md'),
    '# Proposal\n\nBland internal pace fixture, nothing risky here.\n',
    'utf8',
  );
  return sessionId;
}

/** `n` checkbox tasks under one group heading — single capability, no spine rows. */
function tasksBody(n, groupLabel = 'group') {
  const lines = [`## 1. ${groupLabel}`, ''];
  for (let i = 1; i <= n; i += 1) lines.push(`- [ ] 1.${i} do thing ${i}`);
  return `${lines.join('\n')}\n`;
}

/** A large plan spread over four groups so `groups` also reads as multi-surface. */
function largeTasksBody(n) {
  const lines = [];
  const perGroup = Math.ceil(n / 4);
  let remaining = n;
  for (let g = 1; g <= 4 && remaining > 0; g += 1) {
    lines.push(`## ${g}. group ${g}`, '');
    const count = Math.min(perGroup, remaining);
    for (let i = 1; i <= count; i += 1) lines.push(`- [ ] ${g}.${i} do thing ${g}.${i}`);
    remaining -= count;
  }
  return `${lines.join('\n')}\n`;
}

const ALLOW_INCOMPLETE = 'pace e2e fixture — no operator brief needed for this scratch session';

/* ---------- 1. small plan de-escalates ---------- */

const smallId = makePaceSession('pace-small', {
  pace: 'auto',
  resolvedPace: 'standard',
  pacePinned: false,
  tasksBody: tasksBody(3),
});
const smallRun = forge(SCRATCH, [
  'phase',
  'implement',
  '--session',
  smallId,
  '--allow-incomplete',
  ALLOW_INCOMPLETE,
]);
if (smallRun.code !== 0) fail(`forge phase implement (small plan) exited ${smallRun.code}`, smallRun.out);
const smallAfter = readSession(smallId);
if (smallAfter.resolvedPace !== 'brisk') {
  fail(
    `small plan (3 tasks, 1 capability, no spine rows) did not de-escalate: resolvedPace is "${smallAfter.resolvedPace}", expected "brisk"`,
    JSON.stringify(smallAfter, null, 2),
  );
}
if (smallAfter.paceDeescalated !== true) {
  fail(
    'small plan lowered the pace but did not set paceDeescalated — the record D4 added is missing',
    JSON.stringify(smallAfter, null, 2),
  );
}

/* ---------- 2. large plan still escalates ---------- */

const largeId = makePaceSession('pace-large', {
  pace: 'auto',
  resolvedPace: 'brisk',
  pacePinned: false,
  tasksBody: largeTasksBody(20),
});
const largeRun = forge(SCRATCH, [
  'phase',
  'implement',
  '--session',
  largeId,
  '--allow-incomplete',
  ALLOW_INCOMPLETE,
]);
if (largeRun.code !== 0) fail(`forge phase implement (large plan) exited ${largeRun.code}`, largeRun.out);
const largeAfter = readSession(largeId);
if (largeAfter.resolvedPace !== 'standard') {
  fail(
    `large plan (20 tasks) did not escalate: resolvedPace is "${largeAfter.resolvedPace}", expected "standard"`,
    JSON.stringify(largeAfter, null, 2),
  );
}
if (largeAfter.paceDeescalated === true) {
  fail(
    'large plan raised the pace but is still marked paceDeescalated — the direction the record carries is wrong',
    JSON.stringify(largeAfter, null, 2),
  );
}

/* ---------- 3. pinned pace never moves, and the suppression is recorded ---------- */

const pinnedId = makePaceSession('pace-pinned', {
  pace: 'thorough',
  resolvedPace: 'thorough',
  pacePinned: true,
  // Same small-plan shape as case 1 — on an unpinned session this would have
  // de-escalated to "brisk". Pinned, it must not move, and the fact that it
  // WOULD have moved must be recorded, not silently dropped.
  tasksBody: tasksBody(3),
});
const pinnedRun = forge(SCRATCH, [
  'phase',
  'implement',
  '--session',
  pinnedId,
  '--allow-incomplete',
  ALLOW_INCOMPLETE,
]);
if (pinnedRun.code !== 0) fail(`forge phase implement (pinned) exited ${pinnedRun.code}`, pinnedRun.out);
const pinnedAfter = readSession(pinnedId);
if (pinnedAfter.resolvedPace !== 'thorough') {
  fail(
    `a pinned pace moved: resolvedPace is "${pinnedAfter.resolvedPace}", expected "thorough" (pinned, unchanged)`,
    JSON.stringify(pinnedAfter, null, 2),
  );
}
const suppressed = pinnedAfter.paceSuppressed?.plan;
if (!suppressed || suppressed.wouldHaveBeen !== 'brisk') {
  fail(
    'the pin held the pace, but session.paceSuppressed.plan does not record that the plan would have moved it to ' +
      '"brisk" — "the pin held" and "nothing was even considered" look identical without this record (D4)',
    JSON.stringify(pinnedAfter, null, 2),
  );
}

process.stdout.write(
  `de-escalated: standard->brisk on a 3-task single-capability plan (paceDeescalated=true); ` +
    `escalated: brisk->standard on a 20-task plan; ` +
    `pinned pace unchanged (thorough held, paceSuppressed.plan.wouldHaveBeen=brisk)\n`,
);
