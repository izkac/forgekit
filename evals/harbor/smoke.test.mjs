import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const smoke = path.join(here, 'smoke.mjs');
const hardSmoke = path.join(here, 'smoke-hard-v2.mjs');

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

function runHardSmoke(env = {}, executable = hardSmoke) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable], {
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


test('hard-v2 smoke validates its selected tasks and host suites without Harbor or a provider', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-hard-smoke-tripwire-'));
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

  const result = await runHardSmoke({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HARBOR_CAPTURE: harborCapture,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS hard-v2 manifest and task metadata: reservation-confirmation-race/);
  assert.match(result.stdout, /PASS hard-v2 manifest and task metadata: tenant-signed-downloads/);
  assert.match(result.stdout, /PASS hard-v2 manifest and task metadata: partial-refund-ledger-invariants/);
  assert.match(result.stdout, /PASS hard-v2 manifest and task metadata: carrier-event-reconciliation/);
  assert.match(result.stdout, /PASS hard-v2 baseline\/Forge staging and verifier isolation: reservation-confirmation-race/);
  assert.match(result.stdout, /PASS hard-v2 baseline\/Forge staging and verifier isolation: tenant-signed-downloads/);
  assert.match(result.stdout, /PASS hard-v2 baseline\/Forge staging and verifier isolation: partial-refund-ledger-invariants/);
  assert.match(result.stdout, /PASS hard-v2 baseline\/Forge staging and verifier isolation: carrier-event-reconciliation/);
  assert.match(result.stdout, /PASS hard-v2 task-specific host suite: reservation-confirmation-race \(untouched.*oracle.*alternate.*tamper.*no-added-test.*mutant\)/i);
  assert.match(result.stdout, /PASS hard-v2 task-specific host suite: tenant-signed-downloads \(untouched.*oracle.*alternate.*tamper.*no-added-test.*mutant\)/i);
  assert.match(result.stdout, /PASS hard-v2 task-specific host suite: partial-refund-ledger-invariants \(untouched.*oracle.*alternate.*tamper.*no-added-test.*mutant\)/i);
  assert.match(result.stdout, /PASS hard-v2 task-specific host suite: carrier-event-reconciliation \(untouched.*oracle.*alternate.*tamper.*no-added-test.*mutant\)/i);
  assert.match(result.stdout, /SKIP model\/Harbor execution: .*no model was invoked/i);
  const summary = resultFrom(result.stdout);
  assert.equal(summary.schemaVersion, 2);
  assert.equal(summary.corpusId, 'forgekit-hard-v2');

  assert.deepEqual(Object.keys(summary.tasks), [
    'reservation-confirmation-race',
    'tenant-signed-downloads',
    'partial-refund-ledger-invariants',
    'carrier-event-reconciliation',
  ]);
  assert.equal(Object.keys(summary.tasks).length, 4);
  const expectedTasks = {
    'reservation-confirmation-race': { category: 'bug', difficulty: 'hard' },
    'tenant-signed-downloads': { category: 'security', difficulty: 'hard' },
    'partial-refund-ledger-invariants': { category: 'tests', difficulty: 'hard' },
    'carrier-event-reconciliation': { category: 'integration', difficulty: 'hard' },
  };
  for (const taskId of Object.keys(summary.tasks)) {
    assert.deepEqual(
      { category: summary.tasks[taskId].category, difficulty: summary.tasks[taskId].difficulty },
      expectedTasks[taskId],
    );
    assert.equal(summary.tasks[taskId].hostSuite.status, 'passed');
    assert.deepEqual(summary.tasks[taskId].hostSuite.coverage, [
      'untouched-negative', 'oracle-positive', 'alternate-positive',
      'tamper-negative', 'no-added-test-negative', 'mutant-negative',
    ]);
  }
  assert.equal(summary.modelHarbor.modelExecuted, false);
  assert.equal(summary.docker.status, 'skipped');
  assert.deepEqual(summary.docker.contexts, [
    'reservation-confirmation-race:baseline-agent',
    'reservation-confirmation-race:forge-agent',
    'reservation-confirmation-race:separate-verifier',
    'tenant-signed-downloads:baseline-agent',
    'tenant-signed-downloads:forge-agent',
    'tenant-signed-downloads:separate-verifier',
    'partial-refund-ledger-invariants:baseline-agent',
    'partial-refund-ledger-invariants:forge-agent',
    'partial-refund-ledger-invariants:separate-verifier',
    'carrier-event-reconciliation:baseline-agent',
    'carrier-event-reconciliation:forge-agent',
    'carrier-event-reconciliation:separate-verifier',
  ]);
  await assert.rejects(stat(harborCapture), { code: 'ENOENT' });
});

test('hard-v2 smoke discovers verifier-required semantic mutants without task-specific filenames', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'forgekit-hard-smoke-mutant-'));
  const fixtureHere = path.join(fixtureRoot, 'evals', 'harbor');
  const taskId = 'reservation-confirmation-race';
  const taskRoot = path.join(fixtureHere, 'tasks', 'forgekit-hard-v2', taskId);
  const mutantName = 'semantic-mutant.mjs';
  const sourceTaskRoot = path.join(here, 'tasks', 'forgekit-hard-v2', taskId);
  await Promise.all([
    mkdir(path.join(fixtureHere, 'corpora'), { recursive: true }),
    mkdir(path.dirname(taskRoot), { recursive: true }),
  ]);
  await cp(sourceTaskRoot, taskRoot, { recursive: true });
  await Promise.all([
    cp(hardSmoke, path.join(fixtureHere, 'smoke-hard-v2.mjs')),
    cp(
      path.join(here, 'corpora', 'forgekit-hard-v2.json'),
      path.join(fixtureHere, 'corpora', 'forgekit-hard-v2.json'),
    ),
    writeFile(
      path.join(fixtureHere, 'corpus-hard-v2-reservation-confirmation-race.test.mjs'),
      "import test from 'node:test';\ntest('fixture host suite', () => {});\n",
    ),
  ]);
  const fixtureManifestPath = path.join(fixtureHere, 'corpora', 'forgekit-hard-v2.json');
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
  fixtureManifest.tasks = fixtureManifest.tasks.filter(({ id }) => id === taskId);
  await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifest)}\n`);
  const originalMutant = path.join(taskRoot, 'tests', 'mutants', 'confirmation-service.mjs');
  const semanticMutant = path.join(taskRoot, 'tests', 'mutants', mutantName);
  await rename(originalMutant, semanticMutant);
  const graderPath = path.join(taskRoot, 'tests', 'grader.mjs');
  await writeFile(
    graderPath,
    (await readFile(graderPath, 'utf8'))
      .replace(
        'readFileSync(`${TESTS_DIR}/mutants/confirmation-service.mjs`)',
        `readFileSync(join(TESTS_DIR, "mutants", "${mutantName}"))`,
      )
      .concat(`\n// mutants/${mutantName} is documented here but task metadata is authoritative.\n`),
  );
  const taskTomlPath = path.join(taskRoot, 'task.toml');
  const originalTaskToml = await readFile(taskTomlPath, 'utf8');
  const semanticMutantMetadata = `semantic_mutants = ["tests/mutants/${mutantName}"]`;
  const validTaskToml = /^semantic_mutants\s*=/m.test(originalTaskToml)
    ? originalTaskToml.replace(/^semantic_mutants.*$/m, semanticMutantMetadata)
    : originalTaskToml.replace(
      'environment_mode = "separate"',
      `environment_mode = "separate"\n${semanticMutantMetadata}`,
    );
  await writeFile(taskTomlPath, validTaskToml);

  const bin = path.join(fixtureRoot, 'bin');
  await mkdir(bin);
  const fakeRunner = path.join(bin, 'runner.mjs');
  const docker = path.join(bin, 'docker');
  await writeFile(fakeRunner, `#!/usr/bin/env node
import { copyFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const result = spawnSync(process.execPath, [process.env.REAL_RUNNER, ...process.argv.slice(2)], {
  encoding: 'utf8',
  env: process.env,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status);
}
const plan = JSON.parse(result.stdout);
const runDirectory = path.join(process.env.FORGEKIT_EVAL_RUNS_ROOT, plan.runId);
for (const arm of plan.arms) {
  const taskRoot = path.join(runDirectory, arm.stagedTask);
  renameSync(
    path.join(taskRoot, 'tests', 'mutants', 'confirmation-service.mjs'),
    path.join(taskRoot, 'tests', 'mutants', '${mutantName}'),
  );
  copyFileSync(
    path.join(process.env.FIXTURE_TASK_ROOT, 'tests', 'grader.mjs'),
    path.join(taskRoot, 'tests', 'grader.mjs'),
  );
  copyFileSync(
    path.join(process.env.FIXTURE_TASK_ROOT, 'task.toml'),
    path.join(taskRoot, 'task.toml'),
  );
}
process.stdout.write(result.stdout);
`);
  await writeFile(docker, '#!/bin/sh\nexit 1\n');
  await Promise.all([chmod(fakeRunner, 0o755), chmod(docker, 0o755)]);
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FORGEKIT_SMOKE_RUNNER: fakeRunner,
    REAL_RUNNER: path.join(here, 'run.mjs'),
    FIXTURE_TASK_ROOT: taskRoot,
  };
  const fixtureSmoke = path.join(fixtureHere, 'smoke-hard-v2.mjs');
  const result = await runHardSmoke(env, fixtureSmoke);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`PASS hard-v2 manifest and task metadata: ${taskId}`));

  const invalidMetadata = [
    {
      source: validTaskToml.replace(
        /^semantic_mutants.*$/m,
        `# semantic_mutants = ["tests/mutants/${mutantName}"]`,
      ),
      error: /must declare non-empty verifier semantic_mutants/,
    },
    {
      source: validTaskToml.replace(/^semantic_mutants.*$/m, 'semantic_mutants = []'),
      error: /must declare non-empty verifier semantic_mutants/,
    },
    {
      source: validTaskToml.replace(/^semantic_mutants.*$/m, 'semantic_mutants = ["/tmp/mutant.mjs"]'),
      error: /semantic mutant path must stay within tests\/mutants/,
    },
    {
      source: validTaskToml.replace(
        /^semantic_mutants.*$/m,
        'semantic_mutants = ["tests/mutants/../semantic-mutant.mjs"]',
      ),
      error: /semantic mutant path must stay within tests\/mutants/,
    },
    {
      source: validTaskToml.replace(
        /^semantic_mutants.*$/m,
        'semantic_mutants = ["tests/mutants/semantic-mutant.txt"]',
      ),
      error: /semantic mutant path must end in \.mjs/,
    },
    {
      source: validTaskToml.replace(
        /^semantic_mutants.*$/m,
        'semantic_mutants = ["tests/mutants/missing-semantic-mutant.mjs"]',
      ),
      error: /missing required file: tests\/mutants\/missing-semantic-mutant\.mjs/,
    },
  ];
  for (const fixture of invalidMetadata) {
    await writeFile(taskTomlPath, fixture.source);
    const invalid = await runHardSmoke(env, fixtureSmoke);
    assert.notEqual(invalid.code, 0, invalid.stdout);
    assert.match(invalid.stderr, fixture.error);
  }
});

test('hard-v2 smoke checks three isolated Docker contexts per selected task', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-hard-smoke-docker-'));
  const capture = path.join(bin, 'docker-argv.jsonl');
  const docker = path.join(bin, 'docker');
  await writeFile(docker, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.DOCKER_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  await chmod(docker, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const result = await runHardSmoke({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DOCKER_CAPTURE: capture,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(await readFile(path.join(here, 'corpora', 'forgekit-hard-v2.json'), 'utf8'));
  const expectedContextCount = manifest.tasks.length * 3;
  assert.match(result.stdout, new RegExp(`PASS Docker validation: ${expectedContextCount} hard-v2 build contexts`));
  const summary = resultFrom(result.stdout);
  assert.equal(summary.docker.status, 'validated');
  assert.equal(summary.docker.method, 'docker build --check');
  const expectedContexts = manifest.tasks.flatMap(({ id }) => [
    `${id}:baseline-agent`,
    `${id}:forge-agent`,
    `${id}:separate-verifier`,
  ]);
  assert.deepEqual(summary.docker.contexts, expectedContexts);

  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['info', '--format', '{{.ServerVersion}}']);
  assert.equal(calls.length, expectedContextCount + 1);
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.slice(0, 2), ['build', '--check']);
    assert.ok(call.includes('--file'));
  }
});

test('package exposes hard-v2 smoke separately from the legacy v1 smoke command', async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['smoke:evals'], 'node evals/harbor/smoke.mjs');
  assert.equal(packageJson.scripts['smoke:evals:hard-v2'], 'node evals/harbor/smoke-hard-v2.mjs');
});
