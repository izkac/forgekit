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
import { assertSafeTaskTree, defaultCorpusId, parseCampaign, selectCorpus } from './corpus-selection.mjs';
import { CARRYOVER_MARKER } from './tasks/forgekit-campaign-v1/shared/carryover-precondition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalsRoot = path.resolve(here, '..');
const runsRoot = process.env.FORGEKIT_EVAL_RUNS_ROOT
  ? path.resolve(process.env.FORGEKIT_EVAL_RUNS_ROOT)
  : path.join(evalsRoot, '.runs');
const normalizer = path.join(here, 'normalize-results.mjs');
const corpusSelector = path.join(here, 'corpus-selection.mjs');
const installMarker = '# FORGEKIT_INSTALL_MARKER: the Forge arm may replace this line with its pinned Forgekit install command.';
const valueOptions = new Set([
  '--task', '--arm', '--repetitions', '--concurrency', '--agent', '--model', '--seed',
  '--forgekit-version', '--forgekit-tarball', '--progress-interval-seconds', '--corpus',
]);

function usage() {
  return `Usage: node evals/harbor/run.mjs (--task <id> | --corpus forgekit-campaign-v1) --arm <baseline|forge|both>\n  --repetitions <positive-int> --concurrency <positive-int>\n  --agent <agent> --model <model-id> [--seed <safe-identifier>]\n  [--corpus <forgekit-held-out-v1|forgekit-hard-v2|forgekit-campaign-v1>]\n  (--forgekit-version <published-version> | --forgekit-tarball <path>) [--dry-run]\n  [--progress-interval-seconds <non-negative-int; default 30>]\n  Campaign corpora omit --task; --task remains required for non-campaign corpora.\n`;
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

  const required = ['--agent', '--model'];
  for (const option of required) {
    if (!Object.hasOwn(raw, option)) throw new Error(`${option} is required`);
  }

  const config = {
    task: raw['--task'] ?? null,
    arm: raw['--arm'] ?? 'both',
    repetitions: parsePositiveInteger(raw['--repetitions'] ?? '1', 'repetitions'),
    concurrency: parsePositiveInteger(raw['--concurrency'] ?? '1', 'concurrency'),
    agent: raw['--agent'],
    model: raw['--model'],
    seed: raw['--seed'] ?? 'default',
    corpusId: raw['--corpus'] ?? defaultCorpusId,
    forgekitVersion: raw['--forgekit-version'] ?? null,
    forgekitTarball: raw['--forgekit-tarball'] ?? null,
    progressIntervalSeconds: parseProgressInterval(raw['--progress-interval-seconds'] ?? '30'),
    dryRun,
  };
  validate(config);
  selectCorpus(config.corpusId);
  return config;
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function parseProgressInterval(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)
    || !Number.isSafeInteger(Number(value))
    || Number(value) > 86_400) {
    throw new Error('progress-interval-seconds must be an integer between 0 and 86400');
  }
  return Number(value);
}

function emitProgress(fields) {
  const values = Object.entries(fields).map(([name, value]) => `${name}=${value}`);
  process.stderr.write(`[eval-progress] ${values.join(' ')}\n`);
}

function validate(config) {
  if (config.task !== null && !/^[a-z0-9][a-z0-9-]*$/.test(config.task)) {
    throw new Error('task must be a safe task id containing lowercase letters, digits, and hyphens');
  }
  if (!['baseline', 'forge', 'both'].includes(config.arm)) {
    throw new Error('arm must be one of: baseline, forge, both');
  }
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._@/:+-]*$/;
  if (!identifier.test(config.agent)) throw new Error('agent must be a non-empty identifier');
  if (!identifier.test(config.model)) throw new Error('model must be a non-empty identifier');
  if (config.seed.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.seed)) {
    throw new Error('seed must be a safe identifier of at most 128 letters, digits, dots, underscores, or hyphens');
  }
  if ((config.forgekitVersion === null) === (config.forgekitTarball === null)) {
    throw new Error('exactly one of --forgekit-version and --forgekit-tarball is required');
  }
  const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (config.forgekitVersion !== null && !semver.test(config.forgekitVersion)) {
    throw new Error('forgekit-version must be a published semantic version (for example, 0.3.37)');
  }
}

async function loadCorpusTask(selection, task) {
  const manifestName = path.basename(selection.manifestPath);
  let bytes;
  let parsed;
  try {
    bytes = await readFile(selection.manifestPath);
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`${manifestName} must be readable valid JSON`);
  }
  if (!Number.isSafeInteger(parsed.schema_version)
    || parsed.corpus_id !== selection.id
    || !Array.isArray(parsed.tasks)) {
    throw new Error(`${manifestName} has invalid identity or task catalog`);
  }
  const matches = parsed.tasks.filter((entry) => entry?.id === task);
  if (matches.length !== 1) throw new Error(`task is not listed exactly once in ${manifestName}: ${task}`);
  const [entry] = matches;
  if (typeof entry.category !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.category)) {
    throw new Error(`corpus category must be safe for task: ${task}`);
  }
  const expectedTaskPath = path.posix.join(selection.taskRootLocator, task);
  if (entry.task_path !== undefined && entry.task_path !== expectedTaskPath) {
    throw new Error(`corpus task_path does not match its allowlisted root for task: ${task}`);
  }
  if (entry.version !== undefined && !/^\d+\.\d+\.\d+$/.test(entry.version)) {
    throw new Error(`corpus task version must be semantic for task: ${task}`);
  }
  return {
    category: entry.category,
    manifestTaskVersion: entry.version ?? null,
    corpus: {
      id: parsed.corpus_id,
      schemaVersion: parsed.schema_version,
      revision: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

async function loadCorpusIdentity(selection) {
  const manifestName = path.basename(selection.manifestPath);
  let bytes;
  let parsed;
  try {
    bytes = await readFile(selection.manifestPath);
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`${manifestName} must be readable valid JSON`);
  }
  if (!Number.isSafeInteger(parsed.schema_version) || parsed.corpus_id !== selection.id) {
    throw new Error(`${manifestName} has invalid identity or task catalog`);
  }
  return {
    id: parsed.corpus_id,
    schemaVersion: parsed.schema_version,
    revision: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function resolveRunUnits(config, selection) {
  const campaign = await parseCampaign(selection);
  if (campaign.episodes !== null) {
    if (config.task !== null) throw new Error('--task is not valid for a campaign corpus');
    const corpus = await loadCorpusIdentity(selection);
    const units = [];
    for (const episode of campaign.episodes) {
      await assertCanonicalTask(episode.resolvedPath);
      const taskVersion = await taskVersionFrom(episode.resolvedPath);
      if (episode.version !== undefined && episode.version !== taskVersion) {
        throw new Error(`corpus and task.toml versions disagree for episode: ${episode.id}`);
      }
      units.push({
        id: episode.id,
        canonicalPath: episode.resolvedPath,
        taskVersion,
        taskRevision: await hashDirectory(episode.resolvedPath),
        canonicalLocator: path.posix.join(selection.taskRootLocator, episode.id),
        stagedRelative: (arm, repetition) => `arms/${arm}/r${String(repetition).padStart(3, '0')}/${episode.id}`,
        episodeId: episode.id,
        episodeIndex: episode.index,
      });
    }
    return {
      campaign: {
        id: campaign.id,
        episodes: campaign.episodes.map((episode) => ({ id: episode.id, index: episode.index })),
      },
      category: 'campaign',
      corpus,
      units,
      planTask: campaign.id,
      planTaskVersion: units[0].taskVersion,
      planTaskRevision: await hashDirectory(selection.taskRoot),
    };
  }

  if (config.task === null) throw new Error('--task is required');
  const { category, corpus, manifestTaskVersion } = await loadCorpusTask(selection, config.task);
  const canonicalTask = await assertSafeTaskTree(selection.taskRoot, config.task);
  await assertCanonicalTask(canonicalTask);
  const taskVersion = await taskVersionFrom(canonicalTask);
  if (manifestTaskVersion !== null && manifestTaskVersion !== taskVersion) {
    throw new Error(`corpus and task.toml versions disagree for task: ${config.task}`);
  }
  const revision = await hashDirectory(canonicalTask);
  return {
    campaign: null,
    category,
    corpus,
    units: [{
      id: config.task,
      canonicalPath: canonicalTask,
      taskVersion,
      taskRevision: revision,
      canonicalLocator: path.posix.join(selection.taskRootLocator, config.task),
      stagedRelative: (arm) => `arms/${arm}`,
      episodeId: null,
      episodeIndex: null,
    }],
    planTask: config.task,
    planTaskVersion: taskVersion,
    planTaskRevision: revision,
  };
}

async function prepareForgekitTreatment(config) {
  if (config.forgekitVersion !== null) {
    return {
      metadata: { kind: 'published-version', version: config.forgekitVersion },
      bytes: null,
    };
  }

  let handle;
  try {
    handle = await open(path.resolve(config.forgekitTarball), 'r');
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    const bytes = await handle.readFile();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      metadata: {
        kind: 'local-tarball',
        sha256,
        byteSize: bytes.length,
        stagedFilename: `forgekit-treatment-${sha256}.tgz`,
      },
      bytes,
    };
  } catch {
    throw new Error('forgekit-tarball must be a readable regular file');
  } finally {
    await handle?.close();
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

async function taskVersionFrom(taskDirectory) {
  const source = await readFile(path.join(taskDirectory, 'task.toml'), 'utf8');
  const taskSection = source.match(/^\[task\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  const version = taskSection?.match(/^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
  if (version === undefined) throw new Error('task.toml [task] version must be semantic');
  return version;
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
  for (const file of [fileURLToPath(import.meta.url), normalizer, corpusSelector]) {
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

function scheduleFor(config, taskRevision, scheduleIdentity = config.task) {
  if (config.arm !== 'both') {
    return {
      strategy: 'single-arm',
      seed: config.seed,
      startHash: null,
      startingArm: null,
      armOrders: Array.from({ length: config.repetitions }, () => [config.arm]),
      firstArmCounts: {
        baseline: config.arm === 'baseline' ? config.repetitions : 0,
        forge: config.arm === 'forge' ? config.repetitions : 0,
      },
      imbalance: null,
    };
  }

  const startHash = createHash('sha256')
    .update(`${config.seed}\0${scheduleIdentity}\0${taskRevision}`)
    .digest('hex');
  const startingArm = Number.parseInt(startHash.slice(0, 2), 16) % 2 === 0
    ? 'baseline'
    : 'forge';
  const otherArm = startingArm === 'baseline' ? 'forge' : 'baseline';
  const armOrders = Array.from({ length: config.repetitions }, (_, index) => (
    index % 2 === 0 ? [startingArm, otherArm] : [otherArm, startingArm]
  ));
  const firstArmCounts = { baseline: 0, forge: 0 };
  for (const [firstArm] of armOrders) firstArmCounts[firstArm] += 1;
  const firstPositionDifference = Math.abs(firstArmCounts.baseline - firstArmCounts.forge);
  return {
    strategy: 'seeded-counterbalanced-pairs',
    seed: config.seed,
    startHash,
    startingArm,
    armOrders,
    firstArmCounts,
    imbalance: {
      present: firstPositionDifference !== 0,
      firstPositionDifference,
      favoredArm: firstPositionDifference === 0 ? null : startingArm,
    },
  };
}

function runIdFor(config, forgekitTreatment) {
  if (config.dryRun) {
    const { corpusId, ...legacyConfig } = config;
    const selectedConfig = corpusId === defaultCorpusId
      ? legacyConfig
      : { ...legacyConfig, corpusId };
    const identity = { ...selectedConfig, forgekitTarball: undefined, progressIntervalSeconds: undefined, forgekitTreatment };
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
    return `dry-run-${digest}`;
  }
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function inheritCampaignApp(previousApp, stagedTask) {
  const destApp = path.join(stagedTask, 'environment', 'app');
  await rm(destApp, { recursive: true, force: true });
  await cp(previousApp, destApp, { recursive: true });
  await writeFile(path.join(destApp, CARRYOVER_MARKER), 'inherited\n');
}

async function findAppArtifact(trialOutput) {
  const matches = await findEntries(
    trialOutput,
    (entry, file) => entry.isDirectory()
      && entry.name === 'app'
      && path.basename(path.dirname(file)) === 'artifacts',
  );
  return matches[0] ?? null;
}

async function carryCampaignOutput(trial, nextTrial) {
  if (nextTrial === undefined || trial.status !== 'verified') return;
  const appOutput = await findAppArtifact(trial.trialOutput);
  if (appOutput === null) return;
  await inheritCampaignApp(appOutput, path.join(trial.runDirectory, nextTrial.manifestData.stagedTask));
}

async function stageArm(canonicalTask, stagedTask, arm, treatment) {
  await cp(canonicalTask, stagedTask, { recursive: true, force: true });
  const instructionPath = path.join(stagedTask, 'instruction.md');
  const canonicalInstruction = (await readFile(instructionPath, 'utf8')).trimEnd();
  const treatmentInstructions = arm === 'forge'
    ? `## Evaluation arm: forge\n\nUse the installed Forge CLI and Forge workflow for this task. Announce that you are using Forge, triage the request, and for substantial work start a session with \`forge new <slug>\`. Follow a tracked plan, use test-driven red/green evidence, then verify and review before completion. Preserve Forge process artifacts in the working repository.\n\nThis trial is unattended. There is no human operator. Never end your turn with a clarifying question or wait for confirmation. Pick a reasonable default and continue. If a requirement cannot be met without breaking an established one, write BLOCKED.md as the task instruction already allows — that is the only allowed stop.`
    : `## Evaluation arm: baseline\n\nComplete this task using the agent's normal workflow.`;
  await writeFile(instructionPath, `${canonicalInstruction}\n\n---\n\n${treatmentInstructions}\n`);

  if (arm === 'forge') {
    const dockerfilePath = path.join(stagedTask, 'environment', 'Dockerfile');
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    const occurrences = dockerfile.split(installMarker).length - 1;
    if (occurrences !== 1) throw new Error(`Forgekit install marker must occur exactly once (found ${occurrences})`);
    let install;
    if (treatment.metadata.kind === 'published-version') {
      install = `RUN npm install --global @izkac/forgekit@${treatment.metadata.version}`;
    } else {
      const { sha256, stagedFilename } = treatment.metadata;
      const environmentDirectory = path.dirname(dockerfilePath);
      await writeFile(path.join(environmentDirectory, stagedFilename), treatment.bytes);
      install = [
        `COPY ${stagedFilename} /tmp/forgekit-treatment.tgz`,
        `RUN echo '${sha256}  /tmp/forgekit-treatment.tgz' | sha256sum --check --strict && npm install --global --ignore-scripts --no-audit --no-fund /tmp/forgekit-treatment.tgz && rm -f /tmp/forgekit-treatment.tgz`,
      ].join('\n');
    }
    await writeFile(dockerfilePath, dockerfile.replace(installMarker, install));
  }
}

function harborArgv({ stagedTask, agent, model, trialOutput, trialId, arm, campaign }) {
  const argv = [
    'run', '--path', stagedTask,
    '--agent', agent,
    '--model', model,
    '--jobs-dir', trialOutput,
    '--job-name', trialId,
    '--n-concurrent', '1',
    '--yes',
  ];
  if (!campaign && arm === 'forge') argv.push('--artifact', '/app/.forge');
  return argv;
}

function spawnHarbor(argv, stdout, stderr, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('harbor', argv, {
      shell: false,
      stdio: ['ignore', stdout, stderr],
      env: process.env,
      cwd,
    });
    child.on('error', () => reject(new Error('Harbor failed to start')));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Harbor exited ${signal ? `with signal ${signal}` : `with code ${code}`}`));
    });
  });
}

function captureProcess(executable, argv, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => reject(new Error(`${label} failed to start`)));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${label} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`);
      Object.defineProperty(error, 'capturedStderr', { value: stderr, enumerable: false });
      reject(error);
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
  const artifactLocator = path.relative(trial.trialOutput, artifactPath).split(path.sep).join('/');
  await writeFile(summaryPath, `${JSON.stringify({
    artifactLocator,
    files: files.map((file) => path.relative(artifactPath, file).split(path.sep).join('/')).sort(),
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

function resolvedAgentIdentity(manifestData, rawAgentInfo) {
  const safeIdentity = (value, pattern) => (
    typeof value === 'string' && pattern.test(value) ? value : null
  );
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
  const name = safeIdentity(rawAgentInfo?.name, identifier);
  const modelName = safeIdentity(rawAgentInfo?.model_info?.name, identifier);
  const provider = safeIdentity(rawAgentInfo?.model_info?.provider, identifier);
  const requestedModel = provider === null ? modelName : `${provider}/${modelName}`;
  if (name !== manifestData.agent || requestedModel !== manifestData.model) return null;
  return {
    name,
    version: safeIdentity(rawAgentInfo?.version, /^\d+\.\d+\.\d+$/),
    model_info: { name: modelName, provider },
  };
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
  let result;
  try {
    result = await captureProcess(process.execPath, argv, 'result normalizer');
  } catch (error) {
    if (typeof error.capturedStderr === 'string') {
      await writeFile(
        path.join(trial.trialDirectory, 'normalizer.stderr.log'),
        error.capturedStderr.slice(0, 65_536),
      ).catch(() => {});
    }
    throw new Error('result normalization failed; inspect trial-local normalizer.stderr.log');
  }
  await writeFile(normalizedResult, result.stdout);
  trial.manifestData.reward = path.relative(trial.runDirectory, rewards[0]);
  trial.manifestData.harborResult = harborTrialResult ? path.relative(trial.runDirectory, harborTrialResult) : null;
  trial.manifestData.harborJobResult = harborJobResult ? path.relative(trial.runDirectory, harborJobResult) : null;
  if (harborTrialResult) {
    try {
      const parsedTrialResult = JSON.parse(await readFile(harborTrialResult, 'utf8'));
      trial.manifestData.resolvedAgent = resolvedAgentIdentity(
        trial.manifestData,
        parsedTrialResult.agent_info,
      );
    } catch {
      trial.manifestData.resolvedAgent = null;
    }
  }
  trial.manifestData.forgeSummary = forgeSummary ? path.relative(trial.runDirectory, forgeSummary) : null;
  trial.manifestData.normalizedResult = path.relative(trial.runDirectory, normalizedResult);
  return normalizedResult;
}

async function writeManifest(trial) {
  await writeFile(trial.manifest, `${JSON.stringify(trial.manifestData, null, 2)}\n`);
}

async function recordNotAttempted(trial) {
  trial.status = 'not-attempted';
  trial.manifestData.status = 'not-attempted';
  await writeManifest(trial);
}

function sanitizeTrialError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Harbor exited (?:with signal [A-Za-z0-9]+|with code \d+)$/.test(message)) return message;
  if (message === 'Harbor failed to start') return message;
  if (/^expected exactly one verifier reward\.json, found \d+$/.test(message)) return message;
  if (message === 'result normalization failed; inspect trial-local normalizer.stderr.log') return message;
  return 'trial execution failed; inspect trial-local logs';
}

async function recordPrivateTrialError(trial, error) {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  await writeFile(
    path.join(trial.trialDirectory, 'runner-error.log'),
    `${detail.slice(0, 65_536)}\n`,
  ).catch(() => {});
}

async function executeTrial(trial, progressIntervalSeconds, ordinal, totalTrials) {
  trial.status = 'running';
  trial.startedAt = new Date().toISOString();
  trial.manifestData.status = 'running';
  trial.manifestData.startedAt = trial.startedAt;
  const progressStartedAt = performance.now();
  emitProgress({
    run: trial.manifestData.runId,
    event: 'trial-start',
    arm: trial.arm,
    ordinal: `${ordinal}/${totalTrials}`,
    trial: trial.trialId,
  });
  const heartbeat = progressIntervalSeconds === 0 ? null : setInterval(() => {
    emitProgress({
      run: trial.manifestData.runId,
      event: 'trial-heartbeat',
      arm: trial.arm,
      status: 'running',
      elapsedSeconds: Math.max(1, Math.floor((performance.now() - progressStartedAt) / 1000)),
      trial: trial.trialId,
    });
  }, progressIntervalSeconds * 1000);
  heartbeat?.unref();

  let stdout;
  let stderr;
  let failure = null;
  try {
    await writeManifest(trial);
    stdout = await open(path.join(trial.trialDirectory, 'harbor.stdout.log'), 'w');
    stderr = await open(path.join(trial.trialDirectory, 'harbor.stderr.log'), 'w');
    await spawnHarbor(trial.harborArgv, stdout.fd, stderr.fd, trial.runDirectory);
    await normalizeTrial(trial);
    trial.status = 'verified';
    trial.manifestData.status = 'verified';
  } catch (error) {
    failure = error;
    await recordPrivateTrialError(trial, error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    const closes = await Promise.allSettled([stdout?.close(), stderr?.close()]);
    if (failure === null) {
      const rejectedClose = closes.find((result) => result.status === 'rejected');
      if (rejectedClose) failure = rejectedClose.reason;
    }
    if (failure !== null) {
      const publicError = sanitizeTrialError(failure);
      trial.status = 'failed';
      trial.error = publicError;
      trial.manifestData.status = 'failed';
      trial.manifestData.error = publicError;
      await recordPrivateTrialError(trial, failure);
    }
    trial.finishedAt = new Date().toISOString();
    trial.manifestData.finishedAt = trial.finishedAt;
    try {
      await writeManifest(trial);
    } catch (error) {
      if (failure === null) failure = error;
      const publicError = sanitizeTrialError(failure);
      trial.status = 'failed';
      trial.error = publicError;
      trial.manifestData.status = 'failed';
      trial.manifestData.error = publicError;
      await recordPrivateTrialError(trial, error);
    }
    emitProgress({
      run: trial.manifestData.runId,
      event: trial.status === 'verified' ? 'trial-verified' : 'trial-failed',
      arm: trial.arm,
      elapsedSeconds: Math.max(0, Math.round((performance.now() - progressStartedAt) / 1000)),
      trial: trial.trialId,
    });
  }

  if (failure !== null) throw new Error(trial.error);
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

function trialPlanData(trial) {
  return {
    trialId: trial.trialId,
    arm: trial.arm,
    repetition: trial.repetition,
    scheduleIndex: trial.scheduleIndex,
    executionIndex: trial.executionIndex,
    armOrder: trial.armOrder,
    armOrdinal: trial.armOrdinal,
    manifest: trial.manifestRelative,
    harborArgv: trial.manifestData.harbor.argv,
    startedAt: trial.startedAt,
    finishedAt: trial.finishedAt,
    status: trial.status,
    ...(trial.episodeId !== undefined && trial.episodeId !== null
      ? { episodeId: trial.episodeId, episodeIndex: trial.episodeIndex }
      : {}),
    ...(trial.error ? { error: trial.error } : {}),
  };
}

function publicPlanData(plan) {
  const { runDirectory, ...data } = plan;
  return data;
}

async function persistPlan(plan, trials) {
  plan.trials = trials.map(trialPlanData);
  await writeFile(path.join(plan.runDirectory, 'plan.json'), `${JSON.stringify(publicPlanData(plan), null, 2)}\n`);
}

function validatedHarborVersion(output) {
  const match = /^(?:harbor )?(\d+\.\d+\.\d+)$/.exec(output.trim());
  if (match === null) {
    throw new Error('Harbor version probe returned unrecognized output');
  }
  return match[1];
}

async function main(argv) {
  const config = parseArgs(argv);
  if (config.help) {
    process.stdout.write(usage());
    return;
  }

  const selection = selectCorpus(config.corpusId);
  const resolved = await resolveRunUnits(config, selection);
  const {
    campaign, category, corpus, units, planTask, planTaskVersion, planTaskRevision,
  } = resolved;
  const forgekitTreatment = await prepareForgekitTreatment(config);
  const harnessRevision = await hashHarness();
  const scheduleIdentity = campaign ? campaign.id : config.task;
  const schedule = scheduleFor(config, planTaskRevision, scheduleIdentity);
  const runId = runIdFor(config, forgekitTreatment.metadata);
  const runDirectory = path.join(runsRoot, runId);
  if (config.dryRun) await rm(runDirectory, { recursive: true, force: true });
  await mkdir(path.join(runDirectory, 'arms'), { recursive: true });

  const arms = selectedArms(config.arm);
  const stagedTasks = {};
  for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
    for (const arm of arms) {
      for (const unit of units) {
        const stagedRelative = unit.stagedRelative(arm, repetition);
        const stagedTask = path.join(runDirectory, stagedRelative);
        await stageArm(unit.canonicalPath, stagedTask, arm, forgekitTreatment);
        stagedTasks[`${arm}:${repetition}:${unit.id}`] = stagedTask;
      }
    }
  }
  if (campaign) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      for (const arm of arms) {
        for (let index = 1; index < units.length; index += 1) {
          const previousApp = path.join(
            stagedTasks[`${arm}:${repetition}:${units[index - 1].id}`],
            'environment',
            'app',
          );
          await inheritCampaignApp(previousApp, stagedTasks[`${arm}:${repetition}:${units[index].id}`]);
        }
      }
    }
  }

  const images = {
    agent: await baseImageFrom(path.join(units[0].canonicalPath, 'environment', 'Dockerfile')),
    verifier: await baseImageFrom(path.join(units[0].canonicalPath, 'tests', 'Dockerfile')),
  };

  const harborVersion = config.dryRun
    ? null
    : validatedHarborVersion(
      (await captureProcess('harbor', ['--version'], 'Harbor version probe')).stdout,
    );

  const trials = [];
  let scheduleIndex = 0;
  for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
    const armOrder = schedule.armOrders[repetition - 1];
    for (let armIndex = 0; armIndex < armOrder.length; armIndex += 1) {
      const arm = armOrder[armIndex];
      const armOrdinal = armIndex + 1;
      for (const unit of units) {
        scheduleIndex += 1;
        const trialId = `${unit.id}-${arm}-${String(repetition).padStart(3, '0')}`;
        const trialDirectory = path.join(runDirectory, 'trials', trialId);
        const trialOutput = path.join(trialDirectory, 'harbor');
        await mkdir(trialDirectory, { recursive: true });
        const stagedRelative = unit.stagedRelative(arm, repetition);
        const argvForHarbor = harborArgv({
          stagedTask: stagedTasks[`${arm}:${repetition}:${unit.id}`],
          agent: config.agent,
          model: config.model,
          trialOutput,
          trialId,
          arm,
          campaign: Boolean(campaign),
        });
        const portableHarborArgv = [...argvForHarbor];
        portableHarborArgv[portableHarborArgv.indexOf('--path') + 1] = stagedRelative;
        portableHarborArgv[portableHarborArgv.indexOf('--jobs-dir') + 1] = `trials/${trialId}/harbor`;
        const manifest = path.join(trialDirectory, 'manifest.json');
        const manifestData = {
          schemaVersion: 1,
          runId,
          trialId,
          task: planTask,
          taskVersion: unit.taskVersion,
          category,
          corpus,
          taskRevision: unit.taskRevision,
          harnessRevision,
          seed: config.seed,
          arm,
          repetition,
          scheduleIndex,
          executionIndex: null,
          armOrder,
          armOrdinal,
          agent: config.agent,
          model: config.model,
          forgekitVersion: config.forgekitVersion,
          forgekitTreatment: forgekitTreatment.metadata,
          resolvedAgent: null,
          images,
          settings: { repetitions: config.repetitions, concurrency: config.concurrency, seed: config.seed },
          canonicalTask: unit.canonicalLocator,
          stagedTask: stagedRelative,
          startedAt: null,
          finishedAt: null,
          status: config.dryRun ? 'dry-run' : 'planned',
          harbor: {
            executable: 'harbor',
            version: harborVersion,
            versionSource: config.dryRun ? 'not-probed-dry-run' : 'harbor --version',
            argv: portableHarborArgv,
          },
        };
        if (unit.episodeId !== null) {
          manifestData.episodeId = unit.episodeId;
          manifestData.episodeIndex = unit.episodeIndex;
        }
        const trial = {
          trialId,
          arm,
          repetition,
          scheduleIndex,
          executionIndex: null,
          armOrder,
          armOrdinal,
          episodeId: unit.episodeId,
          episodeIndex: unit.episodeIndex,
          runDirectory,
          trialDirectory,
          trialOutput,
          manifest,
          manifestRelative: path.relative(runDirectory, manifest),
          harborArgv: portableHarborArgv,
          startedAt: null,
          finishedAt: null,
          status: manifestData.status,
          manifestData,
        };
        await writeManifest(trial);
        trials.push(trial);
      }
    }
  }

  const plan = {
    schemaVersion: 1,
    runId,
    runDirectory,
    dryRun: config.dryRun,
    status: config.dryRun ? 'dry-run' : 'planned',
    task: planTask,
    taskVersion: planTaskVersion,
    category,
    corpus,
    taskRevision: planTaskRevision,
    harnessRevision,
    seed: config.seed,
    schedule,
    images,
    settings: {
      arm: config.arm,
      repetitions: config.repetitions,
      concurrency: config.concurrency,
      seed: config.seed,
      agent: config.agent,
      model: config.model,
      forgekitVersion: config.forgekitVersion,
      forgekitTreatment: forgekitTreatment.metadata,
    },
    arms: arms.map((arm) => ({ arm, stagedTask: `arms/${arm}` })),
    startedAt: null,
    finishedAt: null,
    trials: [],
    ...(campaign ? { campaign } : {}),
  };
  await persistPlan(plan, trials);

  const failures = [];
  if (!config.dryRun) {
    let executionIndex = 0;
    plan.status = 'running';
    plan.startedAt = new Date().toISOString();
    const progressStartedAt = performance.now();
    await persistPlan(plan, trials);
    emitProgress({ run: runId, event: 'run-start', task: planTask, trials: trials.length });
    const attempt = async (trial) => {
      executionIndex += 1;
      trial.executionIndex = executionIndex;
      trial.manifestData.executionIndex = executionIndex;
      try {
        await executeTrial(
          trial, config.progressIntervalSeconds, executionIndex, trials.length,
        );
      } catch (error) {
        failures.push({ trialId: trial.trialId, error: error.message });
      }
    };

    if (campaign) {
      const repetitionBlocks = Array.from({ length: config.repetitions }, (_, index) => (
        trials.filter((trial) => trial.repetition === index + 1)
      ));
      await runWithConcurrency(repetitionBlocks, config.concurrency, async (repTrials) => {
        const armIds = [...new Set(repTrials.map((trial) => trial.arm))];
        await Promise.all(armIds.map(async (arm) => {
          const armTrials = repTrials
            .filter((trial) => trial.arm === arm)
            .sort((left, right) => left.episodeIndex - right.episodeIndex);
          let stopArm = false;
          for (const trial of armTrials) {
            if (stopArm) {
              await recordNotAttempted(trial);
              continue;
            }
            await attempt(trial);
            if (trial.status === 'failed') {
              stopArm = true;
              continue;
            }
            const nextTrial = armTrials.find((candidate) => candidate.episodeIndex === trial.episodeIndex + 1);
            await carryCampaignOutput(trial, nextTrial);
          }
        }));
      });
    } else if (config.arm === 'both') {
      const pairBlocks = Array.from({ length: config.repetitions }, (_, index) => (
        trials.filter((trial) => trial.repetition === index + 1)
      ));
      await runWithConcurrency(pairBlocks, config.concurrency, async (pair) => {
        for (const trial of pair) await attempt(trial);
      });
    } else {
      await runWithConcurrency(trials, config.concurrency, attempt);
    }
    plan.finishedAt = new Date().toISOString();
    plan.status = failures.length === 0 ? 'completed' : 'completed-with-failures';
    await persistPlan(plan, trials);
    emitProgress({
      run: runId,
      event: 'run-completed',
      status: plan.status,
      verified: trials.filter((trial) => trial.status === 'verified').length,
      failed: failures.length,
      elapsedSeconds: Math.max(0, Math.round((performance.now() - progressStartedAt) / 1000)),
    });
  }

  process.stdout.write(`${JSON.stringify(publicPlanData(plan), null, 2)}\n`);
  if (failures.length !== 0) {
    const details = failures.map(({ trialId, error }) => `${trialId}: ${error}`).join('; ');
    throw new Error(`${failures.length} trial(s) failed; see persisted plan and manifests: ${details}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`run.mjs: ${error.message}\n`);
  process.exitCode = 1;
});
