import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertSafeTaskTree, parseCampaign } from './corpus-selection.mjs';
import { exportEscapeReplays } from './export-escape-replays.mjs';
import { scratchProject } from './escape-replays/fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const graderTemplate = path.join(here, 'escape-replays', 'grader.mjs');
const OPT_IN = { FORGEKIT_ALLOW_EXEC: '1' };
const HIDDEN = 'server/test/total.test.js';
const SMOKE = 'server/test/smoke.test.js';
const PINNED_NODE = 'node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a';

// The registry of running sessions is the operator's; keep the tests off it.
const fleetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-task-fleet-'));
process.env.FORGEKIT_FLEET_DIR = fleetDir;
test.after(() => fs.rmSync(fleetDir, { recursive: true, force: true }));

const nodeTest = (body) => `const test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const totalIs = (n) => nodeTest(`test('total is ${n}', () => assert.equal(require('../src/total').total(), ${n}));`);
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** An exported project with one kept task: the fix turns total() from 2 (escaped head) into 3. */
async function exported(t, { packageJson = '{}\n', lock = true } = {}) {
  const p = scratchProject(t, {
    baseFiles: {
      '.gitignore': '.env\nnode_modules/\n',
      'server/package.json': packageJson,
      ...(lock && { 'server/package-lock.json': '{}\n' }),
      'server/src/total.js': 'exports.total = () => 1;\n',
      [SMOKE]: nodeTest("test('total exists', () => assert.equal(typeof require('../src/total').total, 'function'));"),
    },
    sessionFiles: [{ 'server/src/total.js': 'exports.total = () => 2;\n' }],
    fixes: [{ files: { 'server/src/total.js': 'exports.total = () => 3;\n', [HIDDEN]: totalIs(3) }, test: HIDDEN }],
  });
  const result = await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  return { p, ...result, dir: path.join(p.out, 'tasks', p.slug) };
}

const read = (file) => fs.readFileSync(file, 'utf8');

/** Grade an app tree with the task's own grader, locally: no Docker, no untrusted user. */
function grade(t, taskDir, appDir) {
  const rewardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-reward-'));
  t.after(() => fs.rmSync(rewardDir, { recursive: true, force: true }));
  const env = { ...process.env, APP_DIR: appDir, TESTS_DIR: path.join(taskDir, 'tests'), HARBOR_REWARD_DIR: rewardDir };
  delete env.HARBOR_UNTRUSTED_UID;
  delete env.HARBOR_UNTRUSTED_GID;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(taskDir, 'tests', 'grader.mjs')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(read(path.join(rewardDir, 'reward.json')));
}

/** A scratch copy of the task's agent snapshot, as the agent's /app would start. */
function appCopy(t, taskDir) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-app-'));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  fs.cpSync(path.join(taskDir, 'environment', 'app'), app, { recursive: true });
  return app;
}

test('a kept task writes the files a Harbor task needs', async (t) => {
  const { dir, kept } = await exported(t);
  assert.equal(kept.length, 1);
  for (const rel of [
    'task.toml', 'instruction.md', 'environment/Dockerfile', 'environment/app/server/src/total.js',
    'tests/Dockerfile', 'tests/test.sh', 'tests/grader.mjs', 'tests/hidden.json',
    `tests/hidden/${HIDDEN}`, `tests/regression/${SMOKE}`, 'solution/solve.sh', 'solution/reference.patch',
  ]) assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
  assert.equal(read(path.join(dir, 'tests', 'grader.mjs')), read(graderTemplate), 'one grader template');
  assert.match(read(path.join(dir, 'instruction.md')), /PROPOSAL-MARKER[\s\S]*SPEC-MARKER/);
  assert.doesNotMatch(read(path.join(dir, 'instruction.md')), /DESIGN-MARKER/);
});

test('task.toml declares a separate no-network verifier and the source metadata', async (t) => {
  const { dir, p } = await exported(t);
  const toml = read(path.join(dir, 'task.toml'));
  assert.match(toml, /^schema_version = "1\.4"$/m);
  assert.match(toml, /^name = "forgekit-escape-replays-v1\/order-refunds"$/m);
  assert.match(toml, /^version = "1\.0\.0"$/m);
  assert.match(toml, /^\[agent\]\s*\ntimeout_sec = \d+\.0$/m);
  assert.match(toml, /^\[verifier\]\s*\ntimeout_sec = \d+\.0\s*\nenvironment_mode = "separate"$/m);
  assert.match(toml, /^\[verifier\.environment\][\s\S]*?network_mode = "no-network"/m);
  assert.match(toml, /^\[environment\][\s\S]*?network_mode = "public"/m);
  assert.match(toml, new RegExp(`^source_session = "sess-1"$`, 'm'));
  assert.match(toml, /^source_slug = "order-refunds"$/m);
  assert.match(toml, /^source_repo = "web"$/m);
  assert.match(toml, /^inferred = true$/m);
  assert.match(toml, new RegExp(`^base_commit = "${p.shas.base}"$`, 'm'));
  assert.match(toml, new RegExp(`^head_commit = "${p.shas.session[0]}"$`, 'm'));
  assert.match(toml, new RegExp(`^fix_commits = \\["${p.shas.fixes[0]}"\\]$`, 'm'));
});

test('the agent Dockerfile pins the node image, installs per rule cwd, and keeps the install marker', async (t) => {
  const { dir } = await exported(t);
  const docker = read(path.join(dir, 'environment', 'Dockerfile'));
  assert.ok(docker.startsWith(`FROM ${PINNED_NODE}\n`));
  assert.match(docker, /^COPY app\/ \/app\/$/m);
  assert.match(docker, /^WORKDIR \/app\/server\nRUN npm ci$/m);
  assert.match(docker, /^# FORGEKIT_INSTALL_MARKER: /m);
  assert.doesNotMatch(docker, /mongodb/i, 'no MongoDB prefetch without the dependency');
  assert.ok(docker.indexOf('npm ci') < docker.indexOf('FORGEKIT_INSTALL_MARKER'));
});

test('a project without a lockfile installs with npm install', async (t) => {
  const { dir } = await exported(t, { lock: false });
  assert.match(read(path.join(dir, 'environment', 'Dockerfile')), /^WORKDIR \/app\/server\nRUN npm install$/m);
});

test('a mongodb-memory-server dependency gets its binary pre-fetched at build time', async (t) => {
  const { dir } = await exported(t, { packageJson: '{"devDependencies":{"mongodb-memory-server":"^9.0.0"}}\n' });
  const docker = read(path.join(dir, 'environment', 'Dockerfile'));
  assert.match(docker, /^ENV MONGOMS_DOWNLOAD_DIR=\/app\/\.mongodb-binaries$/m);
  assert.match(docker, /MongoMemoryServer\.create\(\)\.then\(\(s\) => s\.stop\(\)\)/);
  assert.ok(docker.indexOf('ENV MONGOMS_DOWNLOAD_DIR') < docker.indexOf('npm ci'), 'postinstall downloads to the same folder');
  assert.match(read(path.join(dir, 'tests', 'Dockerfile')), /MONGOMS_DOWNLOAD_DIR=\/app\/\.mongodb-binaries/);
});

test('the verifier image runs as root, holds the hidden files, and knows the untrusted ids', async (t) => {
  const { dir } = await exported(t);
  const docker = read(path.join(dir, 'tests', 'Dockerfile'));
  assert.ok(docker.startsWith(`FROM ${PINNED_NODE}\n`));
  assert.match(docker, /HARBOR_UNTRUSTED_UID=65534/);
  assert.match(docker, /HARBOR_UNTRUSTED_GID=65534/);
  assert.match(docker, /^COPY hidden\/ \/tests\/hidden\/$/m);
  assert.match(docker, /^COPY regression\/ \/tests\/regression\/$/m);
  assert.doesNotMatch(docker, /^USER /m);
  assert.match(read(path.join(dir, 'tests', 'test.sh')), /fallback='\{"functional":0,"regression":0,"tests_unchanged":0,"shippable":0\}'/);
});

test('hidden.json lists the hidden and regression files with their hashes, commands and cwds', async (t) => {
  const { dir, report } = await exported(t);
  const spec = JSON.parse(read(path.join(dir, 'tests', 'hidden.json')));
  assert.deepEqual(spec.hidden, [{ path: HIDDEN, sha256: sha(totalIs(3)), argv: ['node', '--test', 'test/total.test.js'], cwd: 'server' }]);
  assert.equal(spec.regression.length, 1);
  assert.equal(spec.regression[0].path, SMOKE);
  assert.equal(spec.regression[0].sha256, sha(read(path.join(dir, 'tests', 'regression', SMOKE))));
  assert.equal(read(path.join(dir, 'tests', 'hidden', HIDDEN)), totalIs(3), 'the fix version');
  // The counts agree everywhere they are stated.
  assert.deepEqual(report.kept, [{ taskId: 'order-refunds', sessionId: 'sess-1', slug: 'order-refunds', repo: 'web', hidden: spec.hidden.length, regression: spec.regression.length }]);
  assert.deepEqual(JSON.parse(read(path.join(dir, '..', '..', 'export-report.json'))).kept, report.kept);
});

test('the agent snapshot holds neither the hidden test nor the regression set copy outside the app', async (t) => {
  const { dir } = await exported(t);
  assert.equal(fs.existsSync(path.join(dir, 'environment', 'app', HIDDEN)), false);
  assert.equal(fs.existsSync(path.join(dir, 'environment', 'tests')), false);
});

test('corpus.json lists the kept task like the other manifests, and the harness accepts the task tree', async (t) => {
  const { dir, p } = await exported(t);
  const manifest = JSON.parse(read(path.join(p.out, 'corpus.json')));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.corpus_id, 'forgekit-escape-replays-v1');
  assert.deepEqual(manifest.tasks, [{ id: 'order-refunds', version: '1.0.0', category: 'escape', difficulty: 'real', task_path: 'local/forgekit-escape-replays-v1/tasks/order-refunds' }]);
  assert.match(manifest.tasks[0].category, /^[a-z][a-z0-9-]*$/);

  const taskRoot = path.join(p.out, 'tasks');
  assert.equal(await assertSafeTaskTree(taskRoot, 'order-refunds'), dir);
  // Not a campaign: the selector's campaign parse reports no episodes.
  const selection = { id: manifest.corpus_id, manifestPath: path.join(p.out, 'corpus.json'), taskRoot, taskRootLocator: 'local/forgekit-escape-replays-v1/tasks' };
  assert.deepEqual(await parseCampaign(selection), { id: manifest.corpus_id, episodes: null });
  // The runner's other checks on a canonical task.
  for (const rel of ['task.toml', 'instruction.md', 'environment/Dockerfile', 'tests']) assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
});

test('re-exporting replaces the earlier generation instead of mixing with it', async (t) => {
  const { p, dir } = await exported(t);
  fs.mkdirSync(path.join(p.out, 'tasks', 'stale-task'));
  fs.writeFileSync(path.join(p.out, 'tasks', 'stale-task', 'task.toml'), '');
  await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  assert.equal(fs.existsSync(path.join(p.out, 'tasks', 'stale-task')), false);
  assert.equal(fs.existsSync(dir), true);
});

test('the grader scores the reference tree shippable', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(dir, 'solution', 'reference.patch')], { cwd: app, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(grade(t, dir, app), {
    functional: 1, regression: 1, tests_unchanged: 1, shippable: 1,
    requirements_met: 1, requirements_total: 1, regression_met: 1, regression_total: 1,
  });
});

test('solve.sh applies the reference patch to HARBOR_APP_DIR', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const r = spawnSync('sh', [path.join(dir, 'solution', 'solve.sh')], { env: { ...process.env, HARBOR_APP_DIR: app }, encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') return t.skip('no sh on this host');
  assert.equal(r.status, 0, r.stderr);
  // git apply may convert line endings on a host with core.autocrlf; the content is what counts here.
  assert.equal(read(path.join(app, 'server', 'src', 'total.js')).replace(/\r\n/g, '\n'), 'exports.total = () => 3;\n');
  assert.equal(fs.existsSync(path.join(app, HIDDEN)), false, 'the hidden test is not in the solution');
});

test('the grader scores the untouched base not functional', async (t) => {
  const { dir } = await exported(t);
  assert.deepEqual(grade(t, dir, appCopy(t, dir)), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0,
    requirements_met: 0, requirements_total: 1, regression_met: 1, regression_total: 1,
  });
});

test('the grader detects an edited regression file, and still runs the original', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(dir, 'solution', 'reference.patch')], { cwd: app, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  fs.appendFileSync(path.join(app, SMOKE), '// tampered\n');
  const reward = grade(t, dir, app);
  assert.equal(reward.tests_unchanged, 0);
  assert.equal(reward.shippable, 0);
  assert.equal(reward.functional, 1);
  assert.equal(read(path.join(app, SMOKE)), read(path.join(dir, 'tests', 'regression', SMOKE)), 'the verifier restored its copy');
});

test('the grader fails the regression metric when a regression test no longer passes', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  // The agent breaks total() for everyone; its own copy of the tests is irrelevant.
  fs.writeFileSync(path.join(app, 'server', 'src', 'total.js'), 'exports.total = 3;\n');
  const reward = grade(t, dir, app);
  assert.equal(reward.regression, 0);
  assert.equal(reward.regression_met, 0);
  assert.equal(reward.functional, 0);
  assert.equal(reward.shippable, 0);
});

test('the grader will not write through a symlink the agent put where a test folder should be', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(app, 'server', 'test'), { recursive: true, force: true });
  try {
    fs.symlinkSync(outside, path.join(app, 'server', 'test'), 'junction');
  } catch {
    return t.skip('cannot create a symlink on this host');
  }
  grade(t, dir, app);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the app');
});

test('the grader reports an infrastructure error with an all-zero reward and a nonzero exit', async (t) => {
  const { dir } = await exported(t);
  const rewardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-reward-'));
  t.after(() => fs.rmSync(rewardDir, { recursive: true, force: true }));
  const env = { ...process.env, APP_DIR: appCopy(t, dir), TESTS_DIR: path.join(os.tmpdir(), 'forgekit-no-such-tests'), HARBOR_REWARD_DIR: rewardDir };
  const r = spawnSync(process.execPath, [graderTemplate], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(JSON.parse(read(path.join(rewardDir, 'reward.json'))), {
    functional: 0, regression: 0, tests_unchanged: 0, shippable: 0,
    requirements_met: 0, requirements_total: 0, regression_met: 0, regression_total: 0,
  });
});
