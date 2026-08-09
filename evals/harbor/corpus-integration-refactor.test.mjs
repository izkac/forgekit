import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const taskIds = ['audit-log-wiring', 'router-extraction'];
const rewards = {
  untouched: { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 },
  solved: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 },
  tampered: { functional: 1, regression: 1, tests_unchanged: 0, shippable: 0 },
};

function copyApp(task) {
  const directory = mkdtempSync(path.join(tmpdir(), `forgekit-${path.basename(task)}-`));
  const app = path.join(directory, 'app');
  cpSync(path.join(task, 'environment', 'app'), app, { recursive: true });
  return { directory, app };
}

function grade(task, directory, app) {
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

for (const taskId of taskIds) {
  const taskDirectory = path.join(here, 'tasks', taskId);

  test(`${taskId}: untouched, solution, and visible-test tamper rewards`, () => {
    const untouched = copyApp(taskDirectory);
    try {
      assert.deepEqual(grade(taskDirectory, untouched.directory, untouched.app), rewards.untouched);
    } finally {
      rmSync(untouched.directory, { recursive: true, force: true });
    }

    const solved = copyApp(taskDirectory);
    try {
      const result = spawnSync('sh', [path.join(taskDirectory, 'solution', 'solve.sh')], {
        cwd: solved.app,
        encoding: 'utf8',
        env: { ...process.env, HARBOR_APP_DIR: solved.app },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(grade(taskDirectory, solved.directory, solved.app), rewards.solved);
    } finally {
      rmSync(solved.directory, { recursive: true, force: true });
    }

    const tampered = copyApp(taskDirectory);
    try {
      const result = spawnSync('sh', [path.join(taskDirectory, 'solution', 'solve.sh')], {
        cwd: tampered.app,
        encoding: 'utf8',
        env: { ...process.env, HARBOR_APP_DIR: tampered.app },
      });
      assert.equal(result.status, 0, result.stderr);
      const visibleTest = path.join(tampered.app, 'src', 'server.test.mjs');
      writeFileSync(visibleTest, `${readFileSync(visibleTest, 'utf8')}
// agent-visible-test tamper
`);
      assert.deepEqual(grade(taskDirectory, tampered.directory, tampered.app), rewards.tampered);
    } finally {
      rmSync(tampered.directory, { recursive: true, force: true });
    }
  });
}
