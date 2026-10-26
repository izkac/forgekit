#!/usr/bin/env node
/**
 * Smoke for the escape-replay corpus (specs/changes/escape-replays): the product loop, end to end,
 * on a scratch project, with no Docker, no network and no agent.
 *
 * It builds a project with a nested repository, an archived change, a done session, a confirmed
 * escape and a `node --test {file}` replay rule; runs the exporter CLI as a child process into a
 * temporary `--out`; and grades two trees with the exported task's own grader: the reference
 * (the base snapshot with `solution/reference.patch` applied) must be shippable, and the untouched
 * base must not be functional. A second project whose server has no lockfile must be dropped as
 * `unpinned-deps` instead.
 *
 * The fixture has no dependencies, so the grader's verifier-deps step runs against an empty
 * dependency folder and nothing is installed.
 *
 * Usage: node evals/harbor/smoke-escape-replays.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchProject } from './escape-replays/fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = path.join(here, 'export-escape-replays.mjs');

const nodeTest = (body) => `const test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const HIDDEN = 'server/test/total.test.js';

/** @type {Array<() => void>} */
const cleanups = [];
const temp = (/** @type {string} */ prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function fail(/** @type {string} */ message) {
  throw new Error(message);
}

function expect(/** @type {unknown} */ actual, /** @type {unknown} */ wanted, /** @type {string} */ what) {
  if (actual !== wanted) fail(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

/**
 * The exported task graded in place of Docker: the grader reads these folders instead of /app and
 * /tests, runs as the current user, and takes its (empty) verifier dependencies from `depsDir`.
 */
function grade(/** @type {string} */ taskDir, /** @type {string} */ app, /** @type {string} */ depsDir) {
  const rewardDir = temp('forgekit-smoke-reward-');
  const env = { ...process.env, APP_DIR: app, TESTS_DIR: path.join(taskDir, 'tests'), HARBOR_REWARD_DIR: rewardDir, HARBOR_DEPS_DIR: depsDir };
  delete env.HARBOR_UNTRUSTED_UID;
  delete env.HARBOR_UNTRUSTED_GID;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(taskDir, 'tests', 'grader.mjs')], { env, encoding: 'utf8' });
  if (r.status !== 0) fail(`the grader exited ${r.status}\n${r.stderr}${r.stdout}`);
  return JSON.parse(fs.readFileSync(path.join(rewardDir, 'reward.json'), 'utf8'));
}

/**
 * A scratch project exported by the CLI into a fresh temp folder.
 *
 * @param {{ lockfile: boolean }} o a server without a lockfile cannot be pinned, so its session is dropped
 */
function exportScratch({ lockfile }) {
  // The registry of running sessions is the operator's; keep the smoke off it.
  const fleetDir = temp('forgekit-smoke-fleet-');
  const cleanup = { after: (/** @type {() => void} */ fn) => cleanups.push(fn) };

  // The nested repo: a base, one session commit that ships total() = 2, and a fix to 3 with its test.
  const project = scratchProject(/** @type {any} */ (cleanup), {
    slug: 'order-totals',
    baseFiles: {
      '.gitignore': 'node_modules/\n',
      'server/package.json': '{"name":"smoke-server","version":"1.0.0"}\n',
      ...(lockfile && {
        'server/package-lock.json': '{"name":"smoke-server","lockfileVersion":3,"requires":true,"packages":{"":{"name":"smoke-server","version":"1.0.0"}}}\n',
      }),
      'server/src/total.js': 'exports.total = () => 1;\n',
      'server/test/smoke.test.js': nodeTest("test('total exists', () => assert.equal(typeof require('../src/total').total, 'function'));"),
    },
    sessionFiles: [{ 'server/src/total.js': 'exports.total = () => 2;\n' }],
    fixes: [
      {
        files: {
          'server/src/total.js': 'exports.total = () => 3;\n',
          [HIDDEN]: nodeTest("test('total is 3', () => assert.equal(require('../src/total').total(), 3));"),
        },
        test: HIDDEN,
      },
    ],
    rules: [{ match: 'web/server/test/**', cwd: 'web/server', command: 'node --test {file}' }],
  });

  const out = temp('forgekit-smoke-out-');
  const run = spawnSync(process.execPath, [exporter, '--project', project.root, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_ALLOW_EXEC: '1', FORGEKIT_FLEET_DIR: fleetDir },
  });
  if (run.status !== 0) fail(`the export exited ${run.status}\n${run.stderr}${run.stdout}`);
  return { out, report: JSON.parse(fs.readFileSync(path.join(out, 'export-report.json'), 'utf8')) };
}

function main() {
  // A server whose dependencies are not pinned by a lockfile is not a task.
  const unpinned = exportScratch({ lockfile: false });
  expect(unpinned.report.kept.length, 0, 'tasks kept without a lockfile');
  expect(JSON.stringify(unpinned.report.drops.map((d) => d.reason)), '["unpinned-deps"]', 'drop reasons without a lockfile');
  if (fs.existsSync(path.join(unpinned.out, 'corpus.json'))) fail('a manifest was written for an export that kept nothing');

  const { out, report } = exportScratch({ lockfile: true });
  expect(report.kept.length, 1, `kept tasks (drops: ${JSON.stringify(report.drops)})`);
  expect(report.drops.length, 0, 'dropped sessions');
  const taskDir = path.join(out, 'tasks', report.kept[0].taskId);
  const instruction = fs.readFileSync(path.join(taskDir, 'instruction.md'), 'utf8');
  if (!/PROPOSAL-MARKER[\s\S]*SPEC-MARKER/.test(instruction) || /DESIGN-MARKER/.test(instruction)) fail('instruction.md is not the proposal and specs alone');
  if (fs.existsSync(path.join(taskDir, 'environment', 'app', HIDDEN))) fail('the hidden test is in the agent environment');

  const depsDir = temp('forgekit-smoke-deps-');
  const snapshot = path.join(taskDir, 'environment', 'app');
  const appCopy = () => {
    const app = temp('forgekit-smoke-app-');
    fs.cpSync(snapshot, app, { recursive: true });
    return app;
  };

  const reference = appCopy();
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(taskDir, 'solution', 'reference.patch')], { cwd: reference, encoding: 'utf8' });
  if (applied.status !== 0) fail(`git apply of the reference patch failed\n${applied.stderr}`);
  const shippable = grade(taskDir, reference, depsDir);
  expect(shippable.functional, 1, 'reference functional');
  expect(shippable.regression, 1, 'reference regression');
  expect(shippable.tests_unchanged, 1, 'reference tests_unchanged');
  expect(shippable.shippable, 1, 'reference shippable');

  const base = grade(taskDir, appCopy(), depsDir);
  expect(base.functional, 0, 'base functional');
  expect(base.shippable, 0, 'base shippable');

  process.stdout.write('reference shippable\n');
}

let code = 0;
try {
  main();
} catch (error) {
  process.stderr.write(`smoke-escape-replays failed: ${error.message}\n`);
  code = 1;
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
}
process.exit(code);
