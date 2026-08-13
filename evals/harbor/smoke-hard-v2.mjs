#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const corpusId = 'forgekit-hard-v2';
const manifestPath = path.join(here, 'corpora', `${corpusId}.json`);
const runner = process.env.FORGEKIT_SMOKE_RUNNER || path.join(here, 'run.mjs');
const hostSuites = {
  'reservation-confirmation-race': path.join(here, 'corpus-hard-v2-reservation-confirmation-race.test.mjs'),
  'tenant-signed-downloads': path.join(here, 'corpus-hard-v2-tenant-signed-downloads.test.mjs'),
  'partial-refund-ledger-invariants': path.join(here, 'corpus-hard-v2-partial-refund-ledger-invariants.test.mjs'),
  'carrier-event-reconciliation': path.join(here, 'corpus-hard-v2-carrier-event-reconciliation.test.mjs'),
};
const hostSuiteCoverage = [
  'untouched-negative',
  'oracle-positive',
  'alternate-positive',
  'tamper-negative',
  'no-added-test-negative',
  'mutant-negative',
];
const fakeTarballBytes = Buffer.from('forgekit hard-v2 smoke only; never installed\n');

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
      if (error.code === 'ENOENT') throw new Error(`hard-v2 task is missing required file: ${relative}`);
      throw error;
    }
    requireCondition(info.isFile(), `hard-v2 required path is not a file: ${relative}`);
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
function quotedArray(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, 'm'));
  requireCondition(match, `task.toml must declare non-empty verifier ${key}`);
  const values = [];
  const remainder = match[1].replace(/"([^"\\\r\n]+)"/g, (_quoted, value) => {
    values.push(value);
    return '""';
  });
  requireCondition(
    values.length > 0 && /^\s*(?:""\s*,\s*)*""\s*,?\s*$/.test(remainder),
    `task.toml must declare non-empty verifier ${key} as a quoted array`,
  );
  return values;
}


function numericValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'm'));
  requireCondition(match, `task.toml is missing numeric ${key}`);
  return Number(match[1]);
}

async function loadAndValidateManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  requireCondition(manifest.schema_version === 1, 'hard-v2 manifest schema_version must be 1');
  requireCondition(manifest.corpus_id === corpusId, `hard-v2 manifest corpus_id must be ${corpusId}`);
  requireCondition(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'hard-v2 manifest must select at least one task');
  const ids = new Set();
  for (const entry of manifest.tasks) {
    requireCondition(entry && typeof entry === 'object' && !Array.isArray(entry), 'hard-v2 manifest task must be an object');
    requireCondition(/^[a-z0-9][a-z0-9-]*$/.test(entry.id), 'hard-v2 manifest task id must be safe');
    requireCondition(!ids.has(entry.id), `hard-v2 manifest task is duplicated: ${entry.id}`);
    ids.add(entry.id);
    requireCondition(/^\d+\.\d+\.\d+$/.test(entry.version), `hard-v2 task version must be semantic: ${entry.id}`);
    requireCondition(entry.difficulty === 'hard', `hard-v2 task difficulty must be hard: ${entry.id}`);
    requireCondition(/^[a-z][a-z0-9-]*$/.test(entry.category), `hard-v2 task category must be safe: ${entry.id}`);
    requireCondition(entry.task_path === `tasks/${corpusId}/${entry.id}`, `hard-v2 task_path is not bound to its selected task: ${entry.id}`);
    requireCondition(/^src\/[a-z0-9-]+\.mjs$/.test(entry.entrypoint), `hard-v2 task entrypoint must be a safe src module: ${entry.id}`);
    requireCondition(Array.isArray(entry.visible_tests) && entry.visible_tests.length > 0, `hard-v2 task must declare visible_tests: ${entry.id}`);
    requireCondition(hostSuites[entry.id], `hard-v2 selected task has no task-specific host suite: ${entry.id}`);
  }
  return manifest;
}

async function validateTaskMetadata(entry, taskRoot) {
  const source = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  requireCondition(/^schema_version\s*=\s*"1\.4"\s*$/m.test(source), 'hard-v2 task must declare Harbor schema 1.4');
  const verifier = tomlSection(source, 'verifier');
  const semanticMutants = quotedArray(verifier, 'semantic_mutants');
  for (const relative of semanticMutants) {
    const segments = relative.split('/');
    requireCondition(
      relative.startsWith('tests/mutants/')
        && !path.posix.isAbsolute(relative)
        && /^[A-Za-z0-9._/-]+$/.test(relative)
        && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      `hard-v2 semantic mutant path must stay within tests/mutants: ${entry.id}`,
    );
    requireCondition(
      relative.endsWith('.mjs'),
      `hard-v2 semantic mutant path must end in .mjs: ${entry.id}`,
    );
  }
  await requireFiles(taskRoot, [
    'task.toml',
    'instruction.md',
    'environment/Dockerfile',
    'environment/app/package.json',
    `environment/app/${entry.entrypoint}`,
    ...entry.visible_tests.map((name) => `environment/app/${name}`),
    'tests/Dockerfile',
    'tests/grader.mjs',
    'tests/test.sh',
    'solution/solve.sh',
    'fixtures/alternate-positive/solve.sh',
    ...semanticMutants,
  ]);
  const task = tomlSection(source, 'task');
  requireCondition(quotedValue(task, 'name') === `${corpusId}/${entry.id}`, 'hard-v2 task.toml name does not match selected task');
  requireCondition(quotedValue(task, 'version') === entry.version, 'hard-v2 manifest and task.toml versions differ');
  requireCondition(quotedValue(task, 'description').length > 0, 'hard-v2 task description must not be empty');
  const metadata = tomlSection(source, 'metadata');
  requireCondition(quotedValue(metadata, 'difficulty') === entry.difficulty, 'hard-v2 manifest and task difficulty differ');
  requireCondition(quotedValue(metadata, 'benchmark_category') === entry.category, 'hard-v2 manifest and benchmark category differ');
  requireCondition(quotedValue(metadata, 'difficulty_explanation').length > 0, 'hard-v2 difficulty explanation must not be empty');
  requireCondition(numericValue(tomlSection(source, 'agent'), 'timeout_sec') > 0, 'hard-v2 agent timeout must be positive');
  requireCondition(numericValue(verifier, 'timeout_sec') > 0, 'hard-v2 verifier timeout must be positive');
  requireCondition(quotedValue(verifier, 'environment_mode') === 'separate', 'hard-v2 verifier must use a separate environment');
  requireCondition(quotedValue(tomlSection(source, 'verifier.environment'), 'network_mode') === 'no-network', 'hard-v2 verifier network must be disabled');
  requireCondition(quotedValue(tomlSection(source, 'environment'), 'network_mode') === 'public', 'hard-v2 agent environment must permit setup egress');

  const verifierDockerfile = await readFile(path.join(taskRoot, 'tests', 'Dockerfile'), 'utf8');
  requireCondition(/HARBOR_UNTRUSTED_UID=65534/.test(verifierDockerfile), 'hard-v2 verifier must drop privileges for agent-controlled code');
  requireCondition(/chmod -R 700 \/tests/.test(verifierDockerfile), 'hard-v2 verifier sources must remain root-only');
  const environmentFiles = await directoryMap(path.join(taskRoot, 'environment'));
  requireCondition(
    ![...environmentFiles.keys()].some((name) => ['grader.mjs', 'test.sh', 'hidden-probe.mjs'].includes(path.posix.basename(name))),
    'hard-v2 hidden verifier sources leaked into the agent environment',
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
        files.set(childRelative, createHash('sha256').update(await readFile(child)).digest('hex'));
      } else throw new Error(`unsupported hard-v2 task entry: ${childRelative}`);
    }
  }
  await visit(directory);
  return files;
}

function changedFiles(canonical, staged) {
  const names = new Set([...canonical.keys(), ...staged.keys()]);
  return [...names].filter((name) => canonical.get(name) !== staged.get(name)).sort();
}

async function stageAndValidate(workDirectory, entry, taskRoot, fakeTarball) {
  const result = await run(process.execPath, [
    runner,
    '--corpus', corpusId,
    '--task', entry.id,
    '--arm', 'both',
    '--repetitions', '1',
    '--concurrency', '1',
    '--seed', 'smoke-hard-v2',
    '--agent', 'smoke-local',
    '--model', 'local/not-executed',
    '--forgekit-tarball', fakeTarball,
    '--dry-run',
  ], { env: { FORGEKIT_EVAL_RUNS_ROOT: path.join(workDirectory, 'runs') } });
  if (result.code !== 0) throw new Error(`hard-v2 runner dry-run failed: ${result.stderr.trim() || result.stdout.trim()}`);
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    throw new Error('hard-v2 runner dry-run did not emit a JSON plan');
  }
  const runDirectory = path.join(workDirectory, 'runs', plan.runId);
  try {
    requireCondition(plan.dryRun === true, 'hard-v2 staging must be a dry run');
    requireCondition(plan.corpus?.id === corpusId, 'runner did not select the hard-v2 corpus');
    requireCondition(plan.task === entry.id && plan.taskVersion === entry.version, 'runner plan task identity differs from hard-v2 manifest');
    requireCondition(plan.settings?.arm === 'both', 'runner did not stage both hard-v2 arms');
    requireCondition(plan.settings?.forgekitTreatment?.kind === 'local-tarball', 'hard-v2 Forge arm did not use the harmless local tarball');
    requireCondition(plan.trials?.every((trial) => trial.status === 'dry-run'), 'runner attempted a non-dry hard-v2 trial');

    const stagedByArm = Object.fromEntries(plan.arms.map(({ arm, stagedTask }) => [arm, path.join(runDirectory, stagedTask)]));
    requireCondition(stagedByArm.baseline && stagedByArm.forge, 'hard-v2 runner plan is missing a staged arm');
    const [canonicalMap, baselineMap, forgeMap] = await Promise.all([
      directoryMap(taskRoot),
      directoryMap(stagedByArm.baseline),
      directoryMap(stagedByArm.forge),
    ]);
    requireCondition(
      JSON.stringify(changedFiles(canonicalMap, baselineMap)) === JSON.stringify(['instruction.md']),
      'hard-v2 baseline staging changed files outside its arm instruction',
    );
    const stagedFilename = plan.settings.forgekitTreatment.stagedFilename;
    requireCondition(
      JSON.stringify(changedFiles(canonicalMap, forgeMap)) === JSON.stringify([
        'environment/Dockerfile', `environment/${stagedFilename}`, 'instruction.md',
      ].sort()),
      'hard-v2 Forge staging changed files outside its instruction/local install treatment',
    );
    requireCondition(
      (await readFile(path.join(stagedByArm.forge, 'environment', stagedFilename))).equals(fakeTarballBytes),
      'hard-v2 Forge staging changed the harmless local tarball',
    );

    const [baselineDockerfile, forgeDockerfile, baselineInstruction, forgeInstruction] = await Promise.all([
      readFile(path.join(stagedByArm.baseline, 'environment', 'Dockerfile'), 'utf8'),
      readFile(path.join(stagedByArm.forge, 'environment', 'Dockerfile'), 'utf8'),
      readFile(path.join(stagedByArm.baseline, 'instruction.md'), 'utf8'),
      readFile(path.join(stagedByArm.forge, 'instruction.md'), 'utf8'),
    ]);
    requireCondition(!baselineDockerfile.includes('forgekit-treatment'), 'hard-v2 baseline arm installs Forgekit');
    requireCondition(forgeDockerfile.includes(`COPY ${stagedFilename} /tmp/forgekit-treatment.tgz`), 'hard-v2 Forge arm is missing its staged local treatment');
    requireCondition(!forgeDockerfile.includes('@izkac/forgekit@'), 'hard-v2 Forge smoke would install a registry package');
    requireCondition(/Evaluation arm: baseline/.test(baselineInstruction) && !/Forge workflow/i.test(baselineInstruction), 'hard-v2 baseline instruction contains Forge treatment');
    requireCondition(!/unattended/i.test(baselineInstruction), 'hard-v2 baseline instruction contains unattended rule');
    requireCondition(!/no human operator/i.test(baselineInstruction), 'hard-v2 baseline instruction contains unattended operator rule');
    requireCondition(!/never end (?:a |your )turn with a clarifying question/i.test(baselineInstruction), 'hard-v2 baseline instruction contains unattended clarifying-question rule');
    requireCondition(/Evaluation arm: forge/.test(forgeInstruction) && /Forge workflow/.test(forgeInstruction), 'hard-v2 Forge instruction is missing its treatment');
    requireCondition(/unattended/i.test(forgeInstruction), 'hard-v2 Forge instruction is missing unattended rule');
    requireCondition(/no human operator/i.test(forgeInstruction), 'hard-v2 Forge instruction is missing no-human-operator rule');
    requireCondition(/never end (?:a |your )turn with a clarifying question/i.test(forgeInstruction), 'hard-v2 Forge instruction is missing clarifying-question rule');

    const canonicalTests = await directoryMap(path.join(taskRoot, 'tests'));
    for (const arm of ['baseline', 'forge']) {
      const stagedTests = await directoryMap(path.join(stagedByArm[arm], 'tests'));
      requireCondition(JSON.stringify([...stagedTests]) === JSON.stringify([...canonicalTests]), `${arm} hard-v2 staging changed hidden verifier files`);
      const environmentMap = await directoryMap(path.join(stagedByArm[arm], 'environment'));
      requireCondition(
        ![...environmentMap.keys()].some((name) => ['grader.mjs', 'test.sh', 'hidden-probe.mjs'].includes(path.posix.basename(name))),
        `${arm} hard-v2 agent environment contains hidden verifier code`,
      );
    }
    return { runDirectory, stagedByArm };
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function runHostSuite(entry) {
  const suite = hostSuites[entry.id];
  const result = await run(process.execPath, ['--test', suite]);
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(`hard-v2 task-specific host suite failed for ${entry.id}: ${detail}`);
  }
  process.stdout.write(`PASS hard-v2 task-specific host suite: ${entry.id} (untouched, oracle, alternate, tamper, no-added-test, mutant)\n`);
  return { status: 'passed', coverage: hostSuiteCoverage };
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

function dockerContexts(entry, stagedByArm) {
  return [
    {
      label: `${entry.id}:baseline-agent`,
      context: path.join(stagedByArm.baseline, 'environment'),
      dockerfile: path.join(stagedByArm.baseline, 'environment', 'Dockerfile'),
    },
    {
      label: `${entry.id}:forge-agent`,
      context: path.join(stagedByArm.forge, 'environment'),
      dockerfile: path.join(stagedByArm.forge, 'environment', 'Dockerfile'),
    },
    {
      label: `${entry.id}:separate-verifier`,
      context: path.join(stagedByArm.baseline, 'tests'),
      dockerfile: path.join(stagedByArm.baseline, 'tests', 'Dockerfile'),
    },
  ];
}

async function validateDocker(contexts) {
  for (const item of contexts) await validateBuildContext(item.label, item.dockerfile, item.context);
  const probe = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (probe.error || probe.code !== 0) {
    const detail = probe.error?.code === 'ENOENT' ? 'Docker CLI is unavailable' : 'Docker daemon is unavailable';
    process.stdout.write(`SKIP Docker validation: ${detail}\n`);
    return { status: 'skipped', reason: detail, contexts: contexts.map(({ label }) => label) };
  }
  for (const item of contexts) {
    const checked = await run('docker', ['build', '--check', '--file', item.dockerfile, item.context]);
    if (checked.code !== 0) {
      throw new Error(`Docker validation failed for ${item.label}: ${checked.stderr.trim() || checked.stdout.trim() || checked.error?.message || `exit ${checked.code}`}`);
    }
  }
  process.stdout.write(`PASS Docker validation: ${contexts.length} hard-v2 build contexts\n`);
  return { status: 'validated', method: 'docker build --check', contexts: contexts.map(({ label }) => label) };
}

async function main() {
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-hard-v2-smoke-'));
  const runDirectories = [];
  try {
    const fakeTarball = path.join(workDirectory, 'forgekit-smoke-treatment.tgz');
    await writeFile(fakeTarball, fakeTarballBytes);
    const manifest = await loadAndValidateManifest();
    const tasks = {};
    const contexts = [];
    for (const entry of manifest.tasks) {
      const taskRoot = path.join(here, entry.task_path);
      await validateTaskMetadata(entry, taskRoot);
      process.stdout.write(`PASS hard-v2 manifest and task metadata: ${entry.id}\n`);
      const staged = await stageAndValidate(path.join(workDirectory, entry.id), entry, taskRoot, fakeTarball);
      runDirectories.push(staged.runDirectory);
      process.stdout.write(`PASS hard-v2 baseline/Forge staging and verifier isolation: ${entry.id}\n`);
      const hostSuite = await runHostSuite(entry);
      tasks[entry.id] = { category: entry.category, difficulty: entry.difficulty, hostSuite };
      contexts.push(...dockerContexts(entry, staged.stagedByArm));
    }
    const docker = await validateDocker(contexts);
    const modelHarbor = { status: 'skipped', modelExecuted: false, reason: 'hard-v2 local smoke never invokes Harbor or a model' };
    process.stdout.write('SKIP model/Harbor execution: hard-v2 local smoke validation only; no model was invoked\n');
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify({
      schemaVersion: 2,
      corpusId: manifest.corpus_id,
      arms: ['baseline', 'forge'],
      tasks,
      docker,
      modelHarbor,
    })}\n`);
  } finally {
    await Promise.all([
      rm(workDirectory, { recursive: true, force: true }),
      ...runDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write(`smoke-hard-v2.mjs: ${error.message}\n`);
  process.exitCode = 1;
});
