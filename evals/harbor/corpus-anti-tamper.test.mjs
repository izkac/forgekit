import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.join(here, 'corpus.json'), 'utf8'));

function solvedFixture(taskId) {
  const task = path.join(here, 'tasks', taskId);
  const directory = mkdtempSync(path.join(tmpdir(), `forgekit-antitamper-${taskId}-`));
  const app = path.join(directory, 'app');
  cpSync(path.join(task, 'environment', 'app'), app, { recursive: true });
  const result = spawnSync('sh', [path.join(task, 'solution', 'solve.sh')], {
    cwd: app, encoding: 'utf8', env: { ...process.env, HARBOR_APP_DIR: app },
  });
  assert.equal(result.status, 0, result.stderr);
  return { task, directory, app };
}

function grade(fixture) {
  const reward = path.join(fixture.directory, 'reward.json');
  const result = spawnSync(process.execPath, [path.join(fixture.task, 'tests', 'grader.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, HARBOR_APP_DIR: fixture.app, HARBOR_REWARD_DIR: fixture.directory, HARBOR_REWARD_FILE: reward },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(reward, 'utf8'));
}

for (const { id } of corpus.tasks) {
  test(`${id}: changing the test command is detected before agent code runs`, () => {
    const fixture = solvedFixture(id);
    const packageFile = path.join(fixture.app, 'package.json');
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    pkg.scripts.test = 'node -e "process.exit(0)"';
    writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}
`);
    const reward = grade(fixture);
    assert.equal(reward.tests_unchanged, 0);
    assert.equal(reward.shippable, 0);
  });

  test(`${id}: comment-only added tests do not satisfy requested test coverage`, () => {
    const fixture = solvedFixture(id);
    const sourceDir = path.join(fixture.app, 'src');
    const additions = readdirSync(sourceDir).filter((name) => name.endsWith('.test.mjs') && name !== 'server.test.mjs');
    assert.ok(additions.length > 0, `${id} solution must add a separate test`);
    for (const name of additions) {
      const file = path.join(sourceDir, name);
      const source = readFileSync(file, 'utf8').replaceAll('*/', '* /');
      writeFileSync(file, `/* inert test preserved as comment only:
${source}
*/
`);
    }
    const reward = grade(fixture);
    assert.equal(reward.functional, 0);
    assert.equal(reward.shippable, 0);
  });
}
