import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const smoke = path.join(here, 'smoke.mjs');

function runSmoke(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smoke], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function resultFrom(stdout) {
  const line = stdout.trim().split('\n').find((entry) => entry.startsWith('SMOKE_RESULT '));
  assert.ok(line, `missing SMOKE_RESULT in:\n${stdout}`);
  return JSON.parse(line.slice('SMOKE_RESULT '.length));
}

test('smoke CLI validates locally without invoking Harbor or a model', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-smoke-tripwire-'));
  const harborCapture = path.join(bin, 'harbor-called');
  const harbor = path.join(bin, 'harbor');
  const docker = path.join(bin, 'docker');
  await writeFile(harbor, `#!/bin/sh
printf called > "$HARBOR_CAPTURE"
exit 99
`);
  await writeFile(docker, '#!/bin/sh\nexit 1\n');
  await Promise.all([chmod(harbor, 0o755), chmod(docker, 0o755)]);
  t.after(() => rm(bin, { recursive: true, force: true }));
  const result = await runSmoke({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HARBOR_CAPTURE: harborCapture,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS task metadata and required structure/);
  assert.match(result.stdout, /PASS baseline\/Forge staging and verifier isolation/);
  assert.match(result.stdout, /PASS hidden verifier: untouched fixture/);
  assert.match(result.stdout, /PASS hidden verifier: known-good fixture/);
  assert.match(result.stdout, /SKIP model\/Harbor execution: .*no model was invoked/i);

  const summary = resultFrom(result.stdout);
  assert.equal(summary.schemaVersion, 2);
  assert.equal(summary.corpusId, 'forgekit-held-out-v1');
  assert.deepEqual(Object.keys(summary.tasks).sort(), [
    'audit-log-wiring', 'csv-formula-regression', 'encoded-path-traversal',
    'node-health-endpoint', 'pagination-boundary', 'router-extraction',
  ]);
  assert.deepEqual(summary.arms, ['baseline', 'forge']);
  for (const task of Object.values(summary.tasks)) {
    assert.deepEqual(task.verifier.untouched, {
      functional: 0, regression: 1, tests_unchanged: 1, shippable: 0,
    });
    assert.deepEqual(task.verifier.knownGood, {
      functional: 1, regression: 1, tests_unchanged: 1, shippable: 1,
    });
  }
  assert.equal(summary.modelHarbor.status, 'skipped');
  assert.equal(summary.modelHarbor.modelExecuted, false);
  assert.equal(summary.docker.status, 'skipped');
  await assert.rejects(stat(harborCapture), { code: 'ENOENT' });
});

test('smoke CLI validates every corpus Docker build context when a daemon is available', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-smoke-docker-'));
  const capture = path.join(bin, 'docker-argv.jsonl');
  const docker = path.join(bin, 'docker');
  await writeFile(docker, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.DOCKER_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  await chmod(docker, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const result = await runSmoke({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DOCKER_CAPTURE: capture,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS Docker validation: 18 corpus build contexts/);
  const summary = resultFrom(result.stdout);
  assert.equal(summary.docker.status, 'validated');
  assert.equal(summary.docker.method, 'docker build --check');
  assert.equal(summary.docker.contexts.length, 18);
  assert.ok(summary.docker.contexts.includes('node-health-endpoint:baseline-agent'));
  assert.ok(summary.docker.contexts.includes('encoded-path-traversal:separate-verifier'));

  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['info', '--format', '{{.ServerVersion}}']);
  assert.equal(calls.length, 19);
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.slice(0, 2), ['build', '--check']);
    assert.ok(call.includes('--file'));
  }
});


test('smoke removes staged dry-run output when treatment validation fails', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-smoke-cleanup-'));
  const fakeRunner = path.join(bin, 'runner.mjs');
  const capture = path.join(bin, 'run-directory');
  await writeFile(fakeRunner, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const result = spawnSync(process.execPath, [process.env.REAL_RUNNER, ...process.argv.slice(2)], { encoding: 'utf8', env: process.env });
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status); }
const plan = JSON.parse(result.stdout);
const runDirectory = path.join(process.env.FORGEKIT_EVAL_RUNS_ROOT, plan.runId);
appendFileSync(path.join(runDirectory, 'arms', 'forge', 'solution', 'solve.sh'), '\\n# unexpected staging mutation\\n');
writeFileSync(process.env.RUN_DIRECTORY_CAPTURE, runDirectory);
process.stdout.write(result.stdout);
`);
  await chmod(fakeRunner, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));
  const result = await runSmoke({
    FORGEKIT_SMOKE_RUNNER: fakeRunner,
    REAL_RUNNER: path.join(here, 'run.mjs'),
    RUN_DIRECTORY_CAPTURE: capture,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /changed files outside/);
  const runDirectory = await readFile(capture, 'utf8');
  await assert.rejects(stat(runDirectory), { code: 'ENOENT' });
});


test('concurrent smoke CLIs isolate their dry-run staging', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => runSmoke()));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /PASS baseline\/Forge staging and verifier isolation/);
  }
});
