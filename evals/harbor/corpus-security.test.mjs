import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const task = path.join(here, "tasks", "encoded-path-traversal");

function copyApp() {
  const directory = mkdtempSync(path.join(tmpdir(), "forgekit-security-corpus-"));
  const app = path.join(directory, "app");
  cpSync(path.join(task, "environment", "app"), app, { recursive: true });
  return { directory, app };
}

function grade(directory, app) {
  const reward = path.join(directory, "reward.json");
  const env = { ...process.env };
  delete env.HARBOR_UNTRUSTED_UID;
  delete env.HARBOR_UNTRUSTED_GID;
  Object.assign(env, {
    HARBOR_APP_DIR: app,
    HARBOR_REWARD_DIR: directory,
    HARBOR_REWARD_FILE: reward
  });
  const result = spawnSync(process.execPath, [path.join(task, "tests", "grader.mjs")], {
    encoding: "utf8",
    env
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(reward, "utf8"));
}

function solve(app) {
  const result = spawnSync("sh", [path.join(task, "solution", "solve.sh")], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, HARBOR_APP_DIR: app }
  });
  assert.equal(result.status, 0, result.stderr);
}

function withApp(run) {
  const fixture = copyApp();
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

test("untouched traversal fixture preserves regressions but is not secure", () => withApp(({ directory, app }) => {
  assert.deepEqual(grade(directory, app), {
    functional: 0,
    regression: 1,
    tests_unchanged: 1,
    shippable: 0
  });
}));

test("known-good traversal hardening and its added security test are shippable", () => withApp(({ directory, app }) => {
  solve(app);
  assert.deepEqual(grade(directory, app), {
    functional: 1,
    regression: 1,
    tests_unchanged: 1,
    shippable: 1
  });
}));

test("visible-test tampering remains unshippable after a correct solution", () => withApp(({ directory, app }) => {
  solve(app);
  appendFileSync(path.join(app, "src", "server.test.mjs"), "\n// tampered after solving\n");
  assert.deepEqual(grade(directory, app), {
    functional: 1,
    regression: 1,
    tests_unchanged: 0,
    shippable: 0
  });
}));
