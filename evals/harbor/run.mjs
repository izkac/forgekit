#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalsRoot = path.resolve(here, '..');
const canonicalRoot = path.join(here, 'tasks');
const runsRoot = process.env.FORGEKIT_EVAL_RUNS_ROOT
  ? path.resolve(process.env.FORGEKIT_EVAL_RUNS_ROOT)
  : path.join(evalsRoot, '.runs');
const normalizer = path.join(here, 'normalize-results.mjs');
const installMarker = '# FORGEKIT_INSTALL_MARKER: the Forge arm may replace this line with its pinned Forgekit install command.';
const valueOptions = new Set([
  '--task', '--arm', '--repetitions', '--concurrency', '--agent', '--model', '--forgekit-version',
]);

function usage() {
  return `Usage: node evals/harbor/run.mjs --task <id> --arm <baseline|forge|both>\n  --repetitions <positive-int> --concurrency <positive-int>\n  --agent <agent> --model <model-id> --forgekit-version <published-version> [--dry-run]\n`;
}

function parseArgs(argv) {
  const raw = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') return { help: true };
    if (option === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may only be supplied once');
      dryRun = true;
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`unknown option: ${option}`);
    if (Object.hasOwn(raw, option)) throw new Error(`${option} may only be supplied once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    raw[option] = value;
    index += 1;
  }

  const required = ['--task', '--agent', '--model', '--forgekit-version'];
  for (const option of required) {
    if (!Object.hasOwn(raw, option)) throw new Error(`${option} is required`);
  }

  const config = {
    task: raw['--task'],
    arm: raw['--arm'] ?? 'both',
    repetitions: parsePositiveInteger(raw['--repetitions'] ?? '1', 'repetitions'),
    concurrency: parsePositiveInteger(raw['--concurrency'] ?? '1', 'concurrency'),
    agent: raw['--agent'],
    model: raw['--model'],
    forgekitVersion: raw['--forgekit-version'],
    dryRun,
  };
  validate(config);
  return config;
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function validate(config) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.task)) {
    throw new Error('task must be a safe task id containing lowercase letters, digits, and hyphens');
  }
  if (!['baseline', 'forge', 'both'].includes(config.arm)) {
    throw new Error('arm must be one of: baseline, forge, both');
  }
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._@/:+-]*$/;
  if (!identifier.test(config.agent)) throw new Error('agent must be a non-empty identifier');
  if (!identifier.test(config.model)) throw new Error('model must be a non-empty identifier');
  const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!semver.test(config.forgekitVersion)) {
    throw new Error('forgekit-version must be a published semantic version (for example, 0.3.37)');
  }
}

async function assertCanonicalTask(taskDirectory) {
  let info;
  try {
    info = await stat(taskDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`unknown task: ${path.basename(taskDirectory)}`);
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`task is not a directory: ${path.basename(taskDirectory)}`);
  for (const relative of ['task.toml', 'instruction.md', 'environment/Dockerfile', 'tests']) {
    try {
      await stat(path.join(taskDirectory, relative));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`canonical task is missing ${relative}`);
      throw error;
    }
  }
}

async function hashDirectory(directory) {
  const hash = createHash('sha256');
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(current, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${childRelative}\0`);
      if (entry.isDirectory()) await visit(child, childRelative);
      else hash.update(await readFile(child));
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function hashHarness() {
  const hash = createHash('sha256');
  for (const file of [fileURLToPath(import.meta.url), normalizer]) {
    hash.update(path.basename(file));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

async function baseImageFrom(dockerfile) {
  const source = await readFile(dockerfile, 'utf8');
  const match = source.match(/^FROM\s+(\S+)/m);
  if (!match) throw new Error(`Dockerfile has no FROM instruction: ${dockerfile}`);
  return match[1];
}

function selectedArms(arm) {
  return arm === 'both' ? ['baseline', 'forge'] : [arm];
}

function runIdFor(config) {
  if (config.dryRun) {
    const digest = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
    return `dry-run-${digest}`;
  }
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function stageArm(canonicalTask, stagedTask, arm, version) {
  await cp(canonicalTask, stagedTask, { recursive: true, force: true });
  const instructionPath = path.join(stagedTask, 'instruction.md');
  const canonicalInstruction = (await readFile(instructionPath, 'utf8')).trimEnd();
  const treatment = arm === 'forge'
    ? `## Evaluation arm: forge\n\nUse the installed Forge CLI and Forge workflow for this task. Announce that you are using Forge, triage the request, and for substantial work start a session with \`forge new <slug>\`. Follow a tracked plan, use test-driven red/green evidence, then verify and review before completion. Preserve Forge process artifacts in the working repository.`
    : `## Evaluation arm: baseline\n\nComplete this task using the agent's normal workflow.`;
  await writeFile(instructionPath, `${canonicalInstruction}\n\n---\n\n${treatment}\n`);

  if (arm === 'forge') {
    const dockerfilePath = path.join(stagedTask, 'environment', 'Dockerfile');
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    const occurrences = dockerfile.split(installMarker).length - 1;
    if (occurrences !== 1) throw new Error(`Forgekit install marker must occur exactly once (found ${occurrences})`);
    const install = `RUN npm install --global @izkac/forgekit@${version}`;
    await writeFile(dockerfilePath, dockerfile.replace(installMarker, install));
  }
}

function harborArgv({ stagedTask, agent, model, trialOutput, trialId, arm }) {
  const argv = [
    'run', '--path', stagedTask,
    '--agent', agent,
    '--model', model,
    '--jobs-dir', trialOutput,
    '--job-name', trialId,
    '--n-concurrent', '1',
    '--yes',
  ];
  if (arm === 'forge') argv.push('--artifact', '/app/.forge');
  return argv;
}

function spawnHarbor(argv, stdout, stderr) {
  return new Promise((resolve, reject) => {
    const child = spawn('harbor', argv, {
      shell: false,
      stdio: ['ignore', stdout, stderr],
      env: process.env,
    });
    child.on('error', (error) => reject(new Error(`failed to invoke Harbor: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Harbor exited ${signal ? `with signal ${signal}` : `with code ${code}`}`));
    });
  });
}

function captureProcess(executable, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`failed to invoke ${executable}: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} exited ${signal ? `with signal ${signal}` : `with code ${code}`}: ${stderr.trim()}`));
    });
  });
}

async function findEntries(directory, predicate, found = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (predicate(entry, child)) found.push(child);
    if (entry.isDirectory()) await findEntries(child, predicate, found);
  }
  return found;
}

async function summarizeForgeArtifacts(trial) {
  if (trial.arm !== 'forge') return null;
  const directories = await findEntries(
    trial.trialOutput,
    (entry) => entry.isDirectory() && entry.name === '.forge',
  );
  if (directories.length === 0) return null;
  const artifactPath = directories[0];
  const files = await findEntries(artifactPath, (entry) => entry.isFile());
  const summaryPath = path.join(trial.trialDirectory, 'forge-summary.json');
  await writeFile(summaryPath, `${JSON.stringify({
    artifactPath,
    files: files.map((file) => path.relative(artifactPath, file)).sort(),
  }, null, 2)}
`);
  return summaryPath;
}

async function existingFile(candidate) {
  try {
    return (await stat(candidate)).isFile() ? candidate : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function normalizeTrial(trial) {
  const rewards = await findEntries(
    trial.trialOutput,
    (entry, file) => entry.isFile()
      && entry.name === 'reward.json'
      && path.basename(path.dirname(file)) === 'verifier'
      && !path.relative(trial.trialOutput, file).split(path.sep).includes('artifacts'),
  );
  if (rewards.length !== 1) {
    throw new Error(`expected exactly one verifier reward.json, found ${rewards.length}`);
  }
  const trialResultDirectory = path.dirname(path.dirname(rewards[0]));
  const harborTrialResult = await existingFile(path.join(trialResultDirectory, 'result.json'));
  const harborJobResult = await existingFile(path.join(path.dirname(trialResultDirectory), 'result.json'));
  const forgeSummary = await summarizeForgeArtifacts(trial);
  const normalizedResult = path.join(trial.trialDirectory, 'normalized-result.json');
  const argv = [
    normalizer,
    '--reward', rewards[0],
    '--arm', trial.arm,
    '--task', trial.manifestData.task,
    '--trial', String(trial.repetition),
  ];
  if (forgeSummary) argv.push('--forge-summary', forgeSummary);
  if (harborTrialResult) argv.push('--harbor-result', harborTrialResult);
  if (harborJobResult) argv.push('--harbor-job-result', harborJobResult);
  const result = await captureProcess(process.execPath, argv);
  await writeFile(normalizedResult, result.stdout);
  trial.manifestData.reward = rewards[0];
  trial.manifestData.harborResult = harborTrialResult;
  trial.manifestData.harborJobResult = harborJobResult;
  if (harborTrialResult) {
    try {
      const parsedTrialResult = JSON.parse(await readFile(harborTrialResult, 'utf8'));
      trial.manifestData.resolvedAgent = parsedTrialResult.agent_info || null;
    } catch {
      trial.manifestData.resolvedAgent = null;
    }
  }
  trial.manifestData.forgeSummary = forgeSummary;
  trial.manifestData.normalizedResult = normalizedResult;
  return normalizedResult;
}

async function writeManifest(trial) {
  await writeFile(trial.manifest, `${JSON.stringify(trial.manifestData, null, 2)}\n`);
}

async function executeTrial(trial) {
  trial.status = 'running';
  trial.manifestData.status = 'running';
  await writeManifest(trial);
  const stdout = await open(path.join(trial.trialDirectory, 'harbor.stdout.log'), 'w');
  const stderr = await open(path.join(trial.trialDirectory, 'harbor.stderr.log'), 'w');
  try {
    await spawnHarbor(trial.harborArgv, stdout.fd, stderr.fd);
    await normalizeTrial(trial);
    trial.status = 'verified';
    trial.manifestData.status = 'verified';
  } catch (error) {
    trial.status = 'failed';
    trial.manifestData.status = 'failed';
    trial.manifestData.error = error.message;
    throw error;
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
    await writeManifest(trial);
  }
}

async function runWithConcurrency(items, limit, action) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await action(items[index]);
    }
  });
  await Promise.all(workers);
}

async function main(argv) {
  const config = parseArgs(argv);
  if (config.help) {
    process.stdout.write(usage());
    return;
  }

  const canonicalTask = path.join(canonicalRoot, config.task);
  await assertCanonicalTask(canonicalTask);
  const revision = await hashDirectory(canonicalTask);
  const harnessRevision = await hashHarness();
  const runId = runIdFor(config);
  const runDirectory = path.join(runsRoot, runId);
  if (config.dryRun) await rm(runDirectory, { recursive: true, force: true });
  await mkdir(path.join(runDirectory, 'arms'), { recursive: true });

  const arms = selectedArms(config.arm);
  const stagedTasks = {};
  for (const arm of arms) {
    const stagedTask = path.join(runDirectory, 'arms', arm);
    await stageArm(canonicalTask, stagedTask, arm, config.forgekitVersion);
    stagedTasks[arm] = stagedTask;
  }

  const images = {
    agent: await baseImageFrom(path.join(canonicalTask, 'environment', 'Dockerfile')),
    verifier: await baseImageFrom(path.join(canonicalTask, 'tests', 'Dockerfile')),
  };

  const harborVersion = config.dryRun
    ? null
    : (await captureProcess('harbor', ['--version'])).stdout.trim();

  const trials = [];
  for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
    for (const arm of arms) {
      const trialId = `${config.task}-${arm}-${String(repetition).padStart(3, '0')}`;
      const trialDirectory = path.join(runDirectory, 'trials', trialId);
      const trialOutput = path.join(trialDirectory, 'harbor');
      await mkdir(trialDirectory, { recursive: true });
      const argvForHarbor = harborArgv({
        stagedTask: stagedTasks[arm], agent: config.agent, model: config.model, trialOutput, trialId, arm,
      });
      const manifest = path.join(trialDirectory, 'manifest.json');
      const manifestData = {
        schemaVersion: 1,
        runId,
        trialId,
        task: config.task,
        taskRevision: revision,
        harnessRevision,
        arm,
        repetition,
        agent: config.agent,
        model: config.model,
        forgekitVersion: config.forgekitVersion,
        resolvedAgent: null,
        images,
        settings: { repetitions: config.repetitions, concurrency: config.concurrency },
        canonicalTask,
        stagedTask: stagedTasks[arm],
        status: config.dryRun ? 'dry-run' : 'planned',
        harbor: {
          executable: 'harbor',
          version: harborVersion,
          versionSource: config.dryRun ? 'not-probed-dry-run' : 'harbor --version',
          argv: argvForHarbor,
        },
      };
      const trial = {
        trialId, arm, repetition, trialDirectory, trialOutput, manifest, harborArgv: argvForHarbor,
        status: manifestData.status, manifestData,
      };
      await writeManifest(trial);
      trials.push(trial);
    }
  }

  if (!config.dryRun) await runWithConcurrency(trials, config.concurrency, executeTrial);

  const plan = {
    schemaVersion: 1,
    runId,
    runDirectory,
    dryRun: config.dryRun,
    task: config.task,
    taskRevision: revision,
    harnessRevision,
    images,
    settings: {
      arm: config.arm,
      repetitions: config.repetitions,
      concurrency: config.concurrency,
      agent: config.agent,
      model: config.model,
      forgekitVersion: config.forgekitVersion,
    },
    arms: arms.map((arm) => ({ arm, stagedTask: stagedTasks[arm] })),
    trials: trials.map(({ manifestData, ...trial }) => trial),
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`run.mjs: ${error.message}\n`);
  process.exitCode = 1;
});
