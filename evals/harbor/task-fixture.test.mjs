import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const task = path.join(here, 'tasks', 'node-health-endpoint');

function copyApp() {
  const directory = mkdtempSync(path.join(tmpdir(), 'forgekit-fixture-test-'));
  const app = path.join(directory, 'app');
  cpSync(path.join(task, 'environment', 'app'), app, { recursive: true });
  return { directory, app };
}

function grade(directory, app) {
  const reward = path.join(directory, 'reward.json');
  const result = spawnSync(process.execPath, [path.join(task, 'tests', 'grader.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HARBOR_APP_DIR: app,
      HARBOR_REWARD_DIR: directory,
      HARBOR_REWARD_FILE: reward,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(reward, 'utf8'));
}

test('hidden grader rejects disabling the preserved visible regression test', () => {
  const { directory, app } = copyApp();
  const solved = spawnSync('sh', [path.join(task, 'solution', 'solve.sh')], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, HARBOR_APP_DIR: app },
  });
  assert.equal(solved.status, 0, solved.stderr);

  const testFile = path.join(app, 'src', 'server.test.mjs');
  const source = readFileSync(testFile, 'utf8');
  writeFileSync(testFile, source
    .replace('/* BEGIN PRE-EXISTING VISIBLE TEST */', '/*\n/* BEGIN PRE-EXISTING VISIBLE TEST */')
    .replace('/* END PRE-EXISTING VISIBLE TEST */', '/* END PRE-EXISTING VISIBLE TEST */\n*/'));

  assert.deepEqual(grade(directory, app), {
    functional: 1,
    regression: 0,
    tests_unchanged: 0,
    shippable: 0,
  });
});


test('hidden grader rejects appended early exit that disables the preserved test', () => {
  const { directory, app } = copyApp();
  const solved = spawnSync('sh', [path.join(task, 'solution', 'solve.sh')], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, HARBOR_APP_DIR: app },
  });
  assert.equal(solved.status, 0, solved.stderr);
  const testFile = path.join(app, 'src', 'server.test.mjs');
  writeFileSync(testFile, `${readFileSync(testFile, 'utf8')}\nprocess.exit(0);\n`);
  assert.deepEqual(grade(directory, app), {
    functional: 1,
    regression: 1,
    tests_unchanged: 0,
    shippable: 0,
  });
});


test('hidden grader records tampering before executing self-restoring test code', () => {
  const { directory, app } = copyApp();
  const canonical = readFileSync(path.join(task, 'environment', 'app', 'src', 'server.test.mjs'));
  const testFile = path.join(app, 'src', 'server.test.mjs');
  const restore = `import { writeFileSync as restoreFile } from "node:fs";\nrestoreFile(new URL(import.meta.url), Buffer.from("${canonical.toString('base64')}", "base64"));\n`;
  writeFileSync(testFile, restore + canonical);
  assert.deepEqual(grade(directory, app), {
    functional: 0,
    regression: 0,
    tests_unchanged: 0,
    shippable: 0,
  });
});


test('server-only implementation is not functional without the requested automated test', () => {
  const { directory, app } = copyApp();
  const solved = spawnSync('sh', [path.join(task, 'solution', 'solve.sh')], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, HARBOR_APP_DIR: app },
  });
  assert.equal(solved.status, 0, solved.stderr);
  rmSync(path.join(app, 'src', 'health.test.mjs'));
  assert.deepEqual(grade(directory, app), {
    functional: 0,
    regression: 1,
    tests_unchanged: 1,
    shippable: 0,
  });
});
