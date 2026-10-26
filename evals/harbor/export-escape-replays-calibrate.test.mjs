import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig } from '../../packages/cli/src/config.mjs';
import { calibrateCandidate } from './escape-replays/calibrate.mjs';
import { exportEscapeReplays, collectSessions } from './export-escape-replays.mjs';
import { scratchProject } from './escape-replays/fixture.mjs';

// The registry of running sessions is the operator's; keep the tests off it.
const fleetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-calibrate-fleet-'));
process.env.FORGEKIT_FLEET_DIR = fleetDir;
test.after(() => fs.rmSync(fleetDir, { recursive: true, force: true }));

const OPT_IN = { FORGEKIT_ALLOW_EXEC: '1' };
const HIDDEN = 'server/test/total.test.js';
const nodeTest = (body) => `const test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const totalIs = (n) => nodeTest(`test('total is ${n}', () => assert.equal(require('../src/total').total(), ${n}));`);

const BASE = {
  '.gitignore': '.env\nnode_modules/\n',
  'server/package.json': '{}\n',
  'server/src/total.js': 'exports.total = () => 1;\n',
  // Passes on the base and on the reference: part of the regression set.
  'server/test/smoke.test.js': nodeTest("test('total exists', () => assert.equal(typeof require('../src/total').total, 'function'));"),
};
const SESSION = [{ 'server/src/total.js': 'exports.total = () => 2;\n' }];
const REPLAY_RULE = [{ match: 'web/server/test/**', cwd: 'web/server', command: 'node --test {file}', copy: ['.env'] }];

/** Scratch project where the fix changes total() to 3 and adds a test for it, unless overridden. */
function build(t, { baseFiles = {}, fixes, sessionFiles = SESSION } = {}) {
  return scratchProject(t, {
    baseFiles: { ...BASE, ...baseFiles },
    sessionFiles,
    fixes: fixes ?? [{ files: { 'server/src/total.js': 'exports.total = () => 3;\n', [HIDDEN]: totalIs(3) }, test: HIDDEN }],
    rules: REPLAY_RULE,
  });
}

/** The single candidate of a scratch project, calibrated. */
async function calibrate(p, opts = {}) {
  const { kept, drops } = collectSessions({ project: p.root });
  assert.deepEqual(drops, []);
  assert.equal(kept.length, 1);
  return calibrateCandidate(kept[0], { projectRoot: p.root, config: loadProjectConfig(p.root), timeoutSec: 60, ...opts });
}

const siblingReplayDir = (p) => path.join(path.dirname(p.root), `forge-replay-${path.basename(p.root)}`);

test('a fix that turns a failing hidden test green calibrates, with a reference patch that excludes the hidden test', async (t) => {
  const p = build(t);
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.hidden.map((h) => ({ path: h.path, cwd: h.cwd, argv: h.argv })), [{ path: HIDDEN, cwd: 'server', argv: ['node', '--test', 'test/total.test.js'] }]);
  assert.equal(r.hidden[0].sha256, createHash('sha256').update(totalIs(3)).digest('hex'));
  assert.equal(r.hidden[0].bytes.toString('utf8'), totalIs(3));

  const patch = r.patch.toString('utf8');
  assert.match(patch, /^diff --git a\/server\/src\/total\.js b\/server\/src\/total\.js$/m);
  assert.match(patch, /^\+exports\.total = \(\) => 3;$/m);
  assert.doesNotMatch(patch, /total\.test\.js/, 'the hidden test is not part of the reference');
  assert.equal(patch.includes('\r'), false, 'the patch is LF');
});

test('the regression set is the base test files beside the hidden tests that pass on base and reference', async (t) => {
  const p = build(t, {
    baseFiles: {
      // Fails on the base already.
      'server/test/broken.test.js': nodeTest("test('broken', () => assert.fail('always'));"),
      // Passes on the base, but the session's change (total 2) breaks it.
      'server/test/old-total.test.js': totalIs(1),
      // Not a test file: a helper in the same folder.
      'server/test/helper.js': 'exports.x = 1;\n',
    },
  });
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.regression.map((x) => x.path), ['server/test/smoke.test.js']);
  assert.deepEqual(r.regression[0].argv, ['node', '--test', 'test/smoke.test.js']);
  assert.equal(r.regression[0].cwd, 'server');
  assert.equal(r.regression[0].bytes.toString('utf8'), BASE['server/test/smoke.test.js'], 'base version');
});

test('the regression set is capped', async (t) => {
  const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`server/test/${n}.test.js`, nodeTest(`test('${n}', () => {});`)]));
  const p = build(t, { baseFiles: many });
  const r = await calibrate(p, { regressionCap: 3 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.regression.map((x) => x.path), ['server/test/a.test.js', 'server/test/b.test.js', 'server/test/c.test.js']);
});

test('a hidden test that already passes on the base is dropped as passes-on-base', async (t) => {
  const p = build(t, { fixes: [{ files: { [HIDDEN]: nodeTest("test('exists', () => assert.equal(typeof require('../src/total').total, 'function'));") }, test: HIDDEN }] });
  const r = await calibrate(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'passes-on-base');
  assert.deepEqual(r.detail.tests, [HIDDEN]);
});

test('a hidden test that passes on the escaped head is dropped as not-failing-on-head', async (t) => {
  // total() is 1 on the base and 2 on the head: a test of 2 fails only on the base.
  const p = build(t, { fixes: [{ files: { [HIDDEN]: totalIs(2) }, test: HIDDEN }] });
  const r = await calibrate(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-failing-on-head');
  assert.deepEqual(r.detail.tests, [HIDDEN]);
});

test('a hidden test the fix does not turn green is dropped as not-passing-on-reference, with the failure classified', async (t) => {
  const p = build(t, { fixes: [{ files: { [HIDDEN]: totalIs(3) }, test: HIDDEN }] });
  const r = await calibrate(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-passing-on-reference');
  assert.equal(r.detail.tests[0].path, HIDDEN);
  assert.equal(r.detail.tests[0].classification, 'failure');
  assert.match(r.detail.tests[0].output, /total is 3/);
});

test('a hidden test that fails on the reference for a missing module is classified as environment', async (t) => {
  const p = build(t, { fixes: [{ files: { [HIDDEN]: nodeTest("test('x', () => require('../src/not-there'));") }, test: HIDDEN }] });
  const r = await calibrate(p);
  assert.equal(r.reason, 'not-passing-on-reference');
  assert.equal(r.detail.tests[0].classification, 'environment');
});

test('a test that never finishes counts as failing on base and head, and a timeout on the reference is reported', async (t) => {
  const p = build(t, { fixes: [{ files: { [HIDDEN]: nodeTest("test('hangs', () => new Promise(() => setTimeout(() => {}, 600000)));") }, test: HIDDEN }] });
  const r = await calibrate(p, { timeoutSec: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-passing-on-reference');
  assert.equal(r.detail.tests[0].classification, 'timeout');
});

test('fixes that do not apply on the escaped head are dropped as reference-conflict', async (t) => {
  const p = build(t, {
    baseFiles: { 'server/src/x.js': 'a\nb\nc\n' },
    fixes: [
      // An ordinary later commit rewrites the line the fix then edits.
      { files: { 'server/src/x.js': 'a\nB\nc\n' } },
      { files: { 'server/src/x.js': 'a\nZ\nc\n', [HIDDEN]: totalIs(3) }, test: HIDDEN },
    ],
  });
  const r = await calibrate(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'reference-conflict');
  assert.equal(r.detail.commit, p.shas.fixes[1]);
});

test('calibration leaves no worktree, replay folder or change in the operator checkout', async (t) => {
  const p = build(t);
  await calibrate(p);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: p.web, encoding: 'utf8' }).trim(), '');
  assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: p.web, encoding: 'utf8' }).match(/^worktree /gm).length, 1);
  assert.equal(fs.existsSync(siblingReplayDir(p)), false);
});

test('export records each drop with its reason and detail, removes its partial task folder, and lists skipped escapes', async (t) => {
  const p = build(t, { fixes: [{ files: { [HIDDEN]: totalIs(2) }, test: HIDDEN }] });
  const ledger = path.join(p.root, '.forge', 'escapes.jsonl');
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows.push({ ...rows[0], commit: 'e'.repeat(40), repo: 'mobile', replayTest: 'src/a.test.ts' });
  fs.writeFileSync(ledger, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const { kept, drops, report } = await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  assert.deepEqual(kept, []);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, 'not-failing-on-head');
  assert.equal(drops[0].sessionId, 'sess-1');
  assert.deepEqual(drops[0].detail.tests, [HIDDEN]);
  assert.equal(fs.existsSync(path.join(p.out, 'tasks', p.slug)), false, 'no partially written task');

  const written = JSON.parse(fs.readFileSync(path.join(p.out, 'export-report.json'), 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(report)));
  assert.equal(written.corpus_id, 'forgekit-escape-replays-v1');
  assert.deepEqual(written.kept, []);
  assert.deepEqual(written.skippedEscapes, [{ sessionId: 'sess-1', commit: 'e'.repeat(40), reason: 'unsupported-runner' }]);
});

test('a nested repo that converts line endings (core.autocrlf=true) still yields an LF patch and calibrates', async (t) => {
  const p = build(t);
  p.repo.git(['config', 'core.autocrlf', 'true']);
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.patch.toString('utf8'), /^\+exports\.total = \(\) => 3;$/m);
  assert.equal(r.patch.includes(0x0d), false, 'no CR in the patch');
  assert.equal(r.regression[0].bytes.includes(0x0d), false, 'regression file bytes are the committed ones');
});

test('a nested repo with autocrlf=true and a fix that needs a three-way merge still yields an LF patch, cut from objects', async (t) => {
  const p = build(t, {
    baseFiles: { 'server/src/x.js': 'a\nb\nc\n' },
    fixes: [
      // An ordinary commit between the session and the fix: cherry-picking the fix merges for real.
      { files: { 'server/src/x.js': 'A\nb\nc\n' } },
      { files: { 'server/src/x.js': 'A\nb\nZ\n', 'server/src/total.js': 'exports.total = () => 3;\n', [HIDDEN]: totalIs(3) }, test: HIDDEN },
    ],
  });
  p.repo.git(['config', 'core.autocrlf', 'true']);
  p.repo.git(['config', 'core.eol', 'crlf']);
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  const patch = r.patch.toString('utf8');
  assert.match(patch, /^-c$/m);
  assert.match(patch, /^\+Z$/m);
  assert.equal(patch.includes('\r'), false, 'no CR in the patch');
});

test('a regression file that differs between the base and the reference is left out of the regression set', async (t) => {
  const p = build(t, {
    baseFiles: { 'server/test/old.test.js': totalIs(1) },
    // The session's head and the fix each update this test to the code of their day.
    sessionFiles: [{ 'server/src/total.js': 'exports.total = () => 2;\n', 'server/test/old.test.js': totalIs(2) }],
    fixes: [{ files: { 'server/src/total.js': 'exports.total = () => 3;\n', 'server/test/old.test.js': totalIs(3), [HIDDEN]: totalIs(3) }, test: HIDDEN }],
  });
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  // It passes on the base (1) and on the reference worktree (3), but not with the same bytes.
  assert.deepEqual(r.regression.map((x) => x.path), ['server/test/smoke.test.js']);
});

test('a reference that changes a manifest, lockfile or runner configuration is dropped as dependency-change', async (t) => {
  const cases = [
    { file: 'server/package.json', text: '{"name":"changed"}\n' },
    { file: 'server/package-lock.json', text: '{"lockfileVersion":3}\n' },
    { file: 'server/jest.config.js', text: 'module.exports = {};\n' },
    { file: 'server/tsconfig.build.json', text: '{}\n' },
  ];
  for (const { file, text } of cases) {
    const p = build(t, { fixes: [{ files: { 'server/src/total.js': 'exports.total = () => 3;\n', [HIDDEN]: totalIs(3), [file]: text }, test: HIDDEN }] });
    const r = await calibrate(p);
    assert.equal(r.ok, false, file);
    assert.equal(r.reason, 'dependency-change', file);
    assert.deepEqual(r.detail.files, [file]);
  }
});

test('a session that changes a file of another folder is not a dependency change', async (t) => {
  const p = build(t, { sessionFiles: [{ 'server/src/total.js': 'exports.total = () => 2;\n', 'client/package.json': '{"name":"client"}\n' }] });
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('a run that exits 0 without a passing test does not count as a pass, so such a hidden test is not passes-on-base', async (t) => {
  // Under node --test, a file that exits 0 before any test ran is one "passing" file-level entry.
  const early = "process.exit(0);\ntest('never reached', () => {});";
  const p = build(t, { fixes: [{ files: { [HIDDEN]: nodeTest(early) }, test: HIDDEN }] });
  const r = await calibrate(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-passing-on-reference', 'not passes-on-base: the early exit is not a pass');
});

test('calibration reports the base protected files for the rule cwd', async (t) => {
  const p = build(t, { baseFiles: { 'server/package.json': '{"name":"s"}\n', 'server/package-lock.json': '{}\n', 'server/tsconfig.json': '{}\n', 'server/notes.md': 'x\n' } });
  const r = await calibrate(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.protectedFiles.map((f) => [f.path, f.cwd]), [
    ['server/package-lock.json', 'server'],
    ['server/package.json', 'server'],
    ['server/tsconfig.json', 'server'],
  ]);
  assert.equal(r.protectedFiles[1].bytes.toString('utf8'), '{"name":"s"}\n');
  assert.equal(r.protectedFiles[1].sha256, createHash('sha256').update('{"name":"s"}\n').digest('hex'));
});

/** An ignored file the replay rule copies into every worktree, present in the operator's checkout. */
const withEnv = (p) => fs.writeFileSync(path.join(p.web, 'server', '.env'), 'SECRET=1\n');

test('the report warns when a rule copies an ignored file that --include does not cover', async (t) => {
  const p = build(t);
  withEnv(p);
  const { kept, report } = await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  assert.equal(kept.length, 1);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /web\/server\/\.env/);
  assert.match(report.warnings[0], /--include/);
  assert.match(report.warnings[0], /cannot be graded without/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.out, 'export-report.json'), 'utf8')).warnings, report.warnings);
});

test('no warning when --include covers the copied file, or the file does not exist', async (t) => {
  const p = build(t);
  const bare = await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  assert.deepEqual(bare.report.warnings, [], 'nothing to copy, nothing lost');
  withEnv(p);
  const covered = await exportEscapeReplays({ project: p.root, out: p.out, include: ['server/.env'], env: OPT_IN, timeoutSec: 60 });
  assert.deepEqual(covered.report.warnings, []);
  const folder = await exportEscapeReplays({ project: p.root, out: p.out, include: ['server'], env: OPT_IN, timeoutSec: 60 });
  assert.deepEqual(folder.report.warnings, [], 'a folder covers the files under it');
});

test('the command line prints the report warnings on stderr', async (t) => {
  const p = build(t);
  withEnv(p);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-escape-replays.mjs');
  const r = spawnSync(process.execPath, [script, '--project', p.root, '--out', p.out], { encoding: 'utf8', env: { ...process.env, ...OPT_IN } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: .*web\/server\/\.env.*cannot be graded without/);
});
