import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const expected = {
  untouched: { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 },
  solution: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 },
  tampered: { functional: 1, regression: 1, tests_unchanged: 0, shippable: 0 },
};

function copyFixture(taskName) {
  const task = path.join(here, "tasks", taskName);
  const directory = mkdtempSync(path.join(tmpdir(), `forgekit-${taskName}-`));
  const app = path.join(directory, "app");
  cpSync(path.join(task, "environment", "app"), app, { recursive: true });
  return { task, directory, app };
}

function grade({ task, directory, app }) {
  const reward = path.join(directory, "reward.json");
  const result = spawnSync(process.execPath, [path.join(task, "tests", "grader.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARBOR_APP_DIR: app,
      HARBOR_REWARD_DIR: directory,
      HARBOR_REWARD_FILE: reward,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(reward, "utf8"));
}

for (const taskName of ["pagination-boundary", "csv-formula-regression"]) {
  test(`${taskName} verifier distinguishes untouched, solved, and visible-test tampering`, () => {
    const untouched = copyFixture(taskName);
    assert.deepEqual(grade(untouched), expected.untouched);

    const solved = copyFixture(taskName);
    const solution = spawnSync("sh", [path.join(solved.task, "solution", "solve.sh")], {
      cwd: solved.app,
      encoding: "utf8",
      env: { ...process.env, HARBOR_APP_DIR: solved.app },
    });
    assert.equal(solution.status, 0, solution.stderr);
    assert.deepEqual(grade(solved), expected.solution);

    const visibleTest = path.join(solved.app, "src", "server.test.mjs");
    writeFileSync(visibleTest, `${readFileSync(visibleTest, "utf8")}
// agent-visible tamper
`);
    assert.deepEqual(grade(solved), expected.tampered);
  });
}
