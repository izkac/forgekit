#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const corpus = JSON.parse(await readFile(path.join(here, 'corpus.json'), 'utf8'));
const corpusTasks = corpus.tasks;
const runner = process.env.FORGEKIT_SMOKE_RUNNER || path.join(here, 'run.mjs');
const forgekitVersion = '0.3.37';
const rewardKeys = ['functional', 'regression', 'tests_unchanged', 'shippable'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr, error: null }));
  });
}

async function requireFiles(root, relatives) {
  for (const relative of relatives) {
    const target = path.join(root, relative);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`task is missing required file: ${relative}`);
      throw error;
    }
    requireCondition(info.isFile(), `required task path is not a file: ${relative}`);
  }
}

function tomlSection(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'));
  requireCondition(match, `task.toml is missing [${name}]`);
  return match[1];
}

function quotedValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  requireCondition(match, `task.toml is missing ${key}`);
  return match[1];
}

function numericValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'm'));
  requireCondition(match, `task.toml is missing numeric ${key}`);
  return Number(match[1]);
}

async function validateTaskContract(taskId, taskRoot) {
  await requireFiles(taskRoot, [
    'task.toml',
    'instruction.md',
    'environment/Dockerfile',
    'environment/app/package.json',
    'environment/app/src/server.mjs',
    'environment/app/src/server.test.mjs',
    'tests/Dockerfile',
    'tests/grader.mjs',
    'tests/test.sh',
    'solution/solve.sh',
  ]);

  const source = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  requireCondition(/^schema_version\s*=\s*"1\.4"\s*$/m.test(source), 'task.toml must declare Harbor schema 1.4');
  const task = tomlSection(source, 'task');
  requireCondition(quotedValue(task, 'name') === `forgekit/${taskId}`, 'task.toml task name does not match the task id');
  requireCondition(/^\d+\.\d+\.\d+$/.test(quotedValue(task, 'version')), 'task.toml task version must be semantic');
  requireCondition(quotedValue(task, 'description').length > 0, 'task.toml task description must not be empty');
  requireCondition(/^keywords\s*=\s*\[[^\]]+\]\s*$/m.test(task), 'task.toml must include task keywords');

  const metadata = tomlSection(source, 'metadata');
  for (const key of ['difficulty', 'category', 'difficulty_explanation']) {
    requireCondition(quotedValue(metadata, key).length > 0, `task.toml metadata ${key} must not be empty`);
  }
  requireCondition(/^tags\s*=\s*\[[^\]]+\]\s*$/m.test(metadata), 'task.toml must include metadata tags');

  requireCondition(numericValue(tomlSection(source, 'agent'), 'timeout_sec') > 0, 'agent timeout must be positive');
  const verifier = tomlSection(source, 'verifier');
  requireCondition(numericValue(verifier, 'timeout_sec') > 0, 'verifier timeout must be positive');
  requireCondition(quotedValue(verifier, 'environment_mode') === 'separate', 'verifier must use a separate environment');
  requireCondition(quotedValue(tomlSection(source, 'verifier.environment'), 'network_mode') === 'no-network', 'verifier network must be disabled');
  requireCondition(quotedValue(tomlSection(source, 'environment'), 'network_mode') === 'public', 'agent environment must permit setup and model API egress');

  const artifactsMatch = source.match(/^artifacts\s*=\s*\[([\s\S]*?)^\]\s*$/m);
  requireCondition(artifactsMatch, 'task.toml must declare artifact paths');
  const artifacts = [...artifactsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  requireCondition(artifacts.length > 0 && artifacts.every((entry) => entry.startsWith('/app/')), 'only /app fixture files may cross into the verifier');
  requireCondition(artifacts.every((entry) => !entry.includes('/tests/')), 'hidden verifier files must not be task artifacts');

  const verifierDockerfile = await readFile(path.join(taskRoot, 'tests', 'Dockerfile'), 'utf8');
  requireCondition(/HARBOR_UNTRUSTED_UID=65534/.test(verifierDockerfile), 'verifier must drop privileges for agent-controlled code');
  requireCondition(/chmod -R 700 \/tests/.test(verifierDockerfile) && /chmod 700 \/logs\/verifier/.test(verifierDockerfile), 'verifier sources and rewards must remain root-only');

  const environmentFiles = await directoryMap(path.join(taskRoot, 'environment'));
  requireCondition(
    ![...environmentFiles.keys()].some((name) => ['grader.mjs', 'test.sh'].includes(path.posix.basename(name))),
    'hidden verifier sources leaked into the agent environment',
  );
}

async function directoryMap(directory) {
  const files = new Map();
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        const digest = createHash('sha256').update(await readFile(child)).digest('hex');
        files.set(childRelative, digest);
      } else throw new Error(`unsupported task entry: ${childRelative}`);
    }
  }
  await visit(directory);
  return files;
}

function changedFiles(canonical, staged) {
  const names = new Set([...canonical.keys(), ...staged.keys()]);
  return [...names].filter((name) => canonical.get(name) !== staged.get(name)).sort();
}

async function stageAndValidate(workDirectory, taskId, taskRoot) {
  const result = await run(process.execPath, [
    runner,
    '--task', taskId,
    '--arm', 'both',
    '--repetitions', '1',
    '--concurrency', '1',
    '--seed', 'smoke-corpus-v1',
    '--agent', 'smoke-local',
    '--model', 'local/not-executed',
    '--forgekit-version', forgekitVersion,
    '--dry-run',
  ], { env: { FORGEKIT_EVAL_RUNS_ROOT: path.join(workDirectory, 'runs') } });
  if (result.code !== 0) throw new Error(`runner dry-run failed: ${result.stderr.trim() || result.stdout.trim()}`);

  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    throw new Error('runner dry-run did not emit a JSON plan');
  }
  try {
    Object.defineProperty(plan, 'runDirectory', {
      value: path.join(workDirectory, 'runs', plan.runId), enumerable: false,
    });
    requireCondition(plan.dryRun === true, 'runner smoke staging must be a dry run');
  requireCondition(plan.settings?.arm === 'both', 'runner did not stage both arms');
  requireCondition(plan.trials?.every((trial) => trial.status === 'dry-run'), 'runner attempted a non-dry trial');

  const stagedByArm = Object.fromEntries(plan.arms.map(({ arm, stagedTask }) => [arm, path.join(plan.runDirectory, stagedTask)]));
  requireCondition(stagedByArm.baseline && stagedByArm.forge, 'runner plan is missing a staged arm');
  const [canonicalMap, baselineMap, forgeMap] = await Promise.all([
    directoryMap(taskRoot),
    directoryMap(stagedByArm.baseline),
    directoryMap(stagedByArm.forge),
  ]);
  requireCondition(
    JSON.stringify(changedFiles(canonicalMap, baselineMap)) === JSON.stringify(['instruction.md']),
    'baseline staging changed files outside its arm instruction',
  );
  requireCondition(
    JSON.stringify(changedFiles(canonicalMap, forgeMap)) === JSON.stringify(['environment/Dockerfile', 'instruction.md']),
    'Forge staging changed files outside its instruction/install treatment',
  );

  const [baselineDockerfile, forgeDockerfile, baselineInstruction, forgeInstruction] = await Promise.all([
    readFile(path.join(stagedByArm.baseline, 'environment', 'Dockerfile'), 'utf8'),
    readFile(path.join(stagedByArm.forge, 'environment', 'Dockerfile'), 'utf8'),
    readFile(path.join(stagedByArm.baseline, 'instruction.md'), 'utf8'),
    readFile(path.join(stagedByArm.forge, 'instruction.md'), 'utf8'),
  ]);
  requireCondition(!baselineDockerfile.includes('@izkac/forgekit'), 'baseline arm installs Forgekit');
  requireCondition(!baselineDockerfile.includes('RUN npm install --global'), 'baseline arm contains a treatment install');
  requireCondition(forgeDockerfile.includes(`RUN npm install --global @izkac/forgekit@${forgekitVersion}`), 'Forge arm is missing its pinned Forgekit install');
  requireCondition(!forgeDockerfile.includes('FORGEKIT_INSTALL_MARKER'), 'Forge arm retained its install marker');
  requireCondition(/Evaluation arm: baseline/.test(baselineInstruction), 'baseline instruction is not arm-specific');
  requireCondition(!/Forge workflow/i.test(baselineInstruction), 'baseline instruction contains Forge treatment');
  requireCondition(!/unattended/i.test(baselineInstruction), 'baseline instruction contains unattended rule');
  requireCondition(!/no human operator/i.test(baselineInstruction), 'baseline instruction contains unattended operator rule');
  requireCondition(!/never end (?:a |your )turn with a clarifying question/i.test(baselineInstruction), 'baseline instruction contains unattended clarifying-question rule');
  requireCondition(/Evaluation arm: forge/.test(forgeInstruction) && /Forge workflow/.test(forgeInstruction), 'Forge instruction is missing its treatment');
  requireCondition(/unattended/i.test(forgeInstruction), 'Forge instruction is missing unattended rule');
  requireCondition(/no human operator/i.test(forgeInstruction), 'Forge instruction is missing no-human-operator rule');
  requireCondition(/never end (?:a |your )turn with a clarifying question/i.test(forgeInstruction), 'Forge instruction is missing clarifying-question rule');

  for (const arm of ['baseline', 'forge']) {
    const environmentMap = await directoryMap(path.join(stagedByArm[arm], 'environment'));
    requireCondition(
      ![...environmentMap.keys()].some((name) => ['grader.mjs', 'test.sh'].includes(path.posix.basename(name))),
      `${arm} agent environment contains hidden verifier code`,
    );
    const testsMap = await directoryMap(path.join(stagedByArm[arm], 'tests'));
    const canonicalTests = await directoryMap(path.join(taskRoot, 'tests'));
    requireCondition(JSON.stringify([...testsMap]) === JSON.stringify([...canonicalTests]), `${arm} staging changed hidden verifier files`);
  }

    return { plan, stagedByArm };
  } catch (error) {
    if (plan?.runDirectory) await rm(plan.runDirectory, { recursive: true, force: true });
    throw error;
  }
}

function validateReward(value, label) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), `${label} reward is not an object`);
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...rewardKeys].sort()), `${label} reward has the wrong metric keys`);
  for (const key of rewardKeys) {
    requireCondition(typeof value[key] === 'number' && Number.isFinite(value[key]), `${label}.${key} must be numeric`);
    requireCondition(value[key] === 0 || value[key] === 1, `${label}.${key} must be binary`);
  }
}

async function gradeFixture(appDirectory, rewardDirectory, taskRoot) {
  const rewardFile = path.join(rewardDirectory, 'reward.json');
  const result = await run(process.execPath, [path.join(taskRoot, 'tests', 'grader.mjs')], {
    env: {
      HARBOR_APP_DIR: appDirectory,
      HARBOR_REWARD_DIR: rewardDirectory,
      HARBOR_REWARD_FILE: rewardFile,
    },
  });
  if (result.code !== 0) throw new Error(`hidden verifier failed locally: ${result.stderr.trim() || result.stdout.trim()}`);
  let reward;
  try {
    reward = JSON.parse(await readFile(rewardFile, 'utf8'));
  } catch (error) {
    throw new Error(`hidden verifier did not write valid reward JSON: ${error.message}`);
  }
  validateReward(reward, path.basename(appDirectory));
  return reward;
}

async function validateVerifier(workDirectory, taskRoot) {
  const fixture = path.join(taskRoot, 'environment', 'app');
  const untouchedApp = path.join(workDirectory, 'untouched', 'app');
  const knownGoodApp = path.join(workDirectory, 'known-good', 'app');
  await Promise.all([
    cp(fixture, untouchedApp, { recursive: true }),
    cp(fixture, knownGoodApp, { recursive: true }),
  ]);

  const untouched = await gradeFixture(untouchedApp, path.join(workDirectory, 'untouched', 'reward'), taskRoot);
  const expectedUntouched = { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 };
  requireCondition(JSON.stringify(untouched) === JSON.stringify(expectedUntouched), `untouched verifier reward was ${JSON.stringify(untouched)}`);
  process.stdout.write('PASS hidden verifier: untouched fixture\n');

  const solve = await run('/bin/sh', [path.join(taskRoot, 'solution', 'solve.sh')], {
    env: { HARBOR_APP_DIR: knownGoodApp },
  });
  if (solve.code !== 0) throw new Error(`known-good solution failed: ${solve.stderr.trim() || solve.stdout.trim()}`);
  const knownGood = await gradeFixture(knownGoodApp, path.join(workDirectory, 'known-good', 'reward'), taskRoot);
  const expectedKnownGood = { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 };
  requireCondition(JSON.stringify(knownGood) === JSON.stringify(expectedKnownGood), `known-good verifier reward was ${JSON.stringify(knownGood)}`);
  process.stdout.write('PASS hidden verifier: known-good fixture\n');

  return { untouched, knownGood };
}

async function validateBuildContext(label, dockerfile, context) {
  const source = await readFile(dockerfile, 'utf8');
  requireCondition(/^FROM\s+\S+/m.test(source), `${label} Dockerfile has no FROM instruction`);
  const copyLines = source.split('\n').map((line) => line.trim()).filter((line) => /^COPY\s+/i.test(line));
  requireCondition(copyLines.length > 0, `${label} Dockerfile has no COPY instruction`);
  for (const line of copyLines) {
    const fields = line.split(/\s+/).slice(1).filter((field) => !field.startsWith('--'));
    requireCondition(fields.length >= 2, `${label} has an invalid COPY instruction`);
    for (const sourcePath of fields.slice(0, -1)) {
      requireCondition(!path.isAbsolute(sourcePath) && !sourcePath.split(/[\\/]/).includes('..'), `${label} COPY escapes its build context`);
      try {
        await stat(path.join(context, sourcePath));
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`${label} COPY source does not exist: ${sourcePath}`);
        throw error;
      }
    }
  }
}

function dockerContexts(taskId, stagedByArm) {
  return [
    {
      label: `${taskId}:baseline-agent`,
      context: path.join(stagedByArm.baseline, 'environment'),
      dockerfile: path.join(stagedByArm.baseline, 'environment', 'Dockerfile'),
    },
    {
      label: `${taskId}:forge-agent`,
      context: path.join(stagedByArm.forge, 'environment'),
      dockerfile: path.join(stagedByArm.forge, 'environment', 'Dockerfile'),
    },
    {
      label: `${taskId}:separate-verifier`,
      context: path.join(stagedByArm.baseline, 'tests'),
      dockerfile: path.join(stagedByArm.baseline, 'tests', 'Dockerfile'),
    },
  ];
}

async function validateDocker(contexts) {

  for (const item of contexts) {
    await validateBuildContext(item.label, item.dockerfile, item.context);
  }

  const probe = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (probe.error || probe.code !== 0) {
    const detail = probe.error?.code === 'ENOENT'
      ? 'Docker CLI is unavailable'
      : 'Docker daemon is unavailable';
    process.stdout.write(`SKIP Docker validation: ${detail}\n`);
    return { status: 'skipped', reason: detail };
  }

  for (const item of contexts) {
    const checked = await run('docker', ['build', '--check', '--file', item.dockerfile, item.context]);
    if (checked.code !== 0) {
      throw new Error(`Docker validation failed for ${item.label}: ${checked.stderr.trim() || checked.stdout.trim() || checked.error?.message || `exit ${checked.code}`}`);
    }
  }

  process.stdout.write(`PASS Docker validation: ${contexts.length} corpus build contexts\n`);
  return {
    status: 'validated',
    method: 'docker build --check',
    contexts: contexts.map(({ label }) => label),
  };
}

async function main() {
  const plans = [];
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-smoke-'));
  try {
    const taskSummaries = {};
    const contexts = [];
    for (const entry of corpusTasks) {
      const taskId = entry.id;
      const taskRoot = path.join(here, 'tasks', taskId);
      const taskWork = path.join(workDirectory, taskId);
      await validateTaskContract(taskId, taskRoot);
      process.stdout.write(`PASS task metadata and required structure: ${taskId}\n`);

      const staged = await stageAndValidate(taskWork, taskId, taskRoot);
      plans.push(staged.plan);
      process.stdout.write(`PASS baseline/Forge staging and verifier isolation: ${taskId}\n`);

      const verifier = await validateVerifier(taskWork, taskRoot);
      taskSummaries[taskId] = { category: entry.category, verifier };
      contexts.push(...dockerContexts(taskId, staged.stagedByArm));
    }

    const docker = await validateDocker(contexts);
    const modelHarbor = {
      status: 'skipped',
      modelExecuted: false,
      reason: 'local smoke validation never invokes Harbor or a model',
    };
    process.stdout.write('SKIP model/Harbor execution: local smoke validation only; no model was invoked\n');

    const summary = {
      schemaVersion: 2,
      corpusId: corpus.corpus_id,
      arms: ['baseline', 'forge'],
      tasks: taskSummaries,
      docker,
      modelHarbor,
    };
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify(summary)}\n`);
  } finally {
    await Promise.all([
      rm(workDirectory, { recursive: true, force: true }),
      ...plans.map((plan) => rm(plan.runDirectory, { recursive: true, force: true })),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write(`smoke.mjs: ${error.message}\n`);
  process.exitCode = 1;
});
