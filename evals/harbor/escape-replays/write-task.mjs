/**
 * Write one calibrated escape-replay candidate as a Harbor task, modelled on
 * `evals/harbor/tasks/pagination-boundary/` (specs/changes/escape-replays).
 *
 * The agent environment is the base snapshot (already extracted under `environment/app/`) with its
 * dependencies installed. The separate, no-network verifier receives the agent's /app as an
 * artifact, so those dependencies, and the MongoDB binary `mongodb-memory-server` would download
 * at first use, travel with it. The hidden tests and the regression set live only in `tests/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeReplaysCorpusId } from '../corpus-selection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The node image every checked-in task uses, pinned by digest. */
const NODE_IMAGE = 'node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a';

/** Must match `installMarker` in run.mjs exactly: the Forge arm replaces this line. */
const INSTALL_MARKER = '# FORGEKIT_INSTALL_MARKER: the Forge arm may replace this line with its pinned Forgekit install command.';

/** One folder for the MongoDB binary, inside /app so it reaches the verifier with the agent's tree. */
const MONGO_BINARIES = '/app/.mongodb-binaries';

const PER_TEST_TIMEOUT_SEC = 240;
const MAX_VERIFIER_TIMEOUT_SEC = 3600;

const TEST_SH = `#!/bin/sh

reward_dir=\${HARBOR_REWARD_DIR:-/logs/verifier}
reward_file=\${HARBOR_REWARD_FILE:-$reward_dir/reward.json}
grader_file=\${HARBOR_TESTS_DIR:-/tests}/grader.mjs
fallback='{"functional":0,"regression":0,"tests_unchanged":0,"shippable":0}'

if ! mkdir -p "$reward_dir"; then
  exit 125
fi

if node "$grader_file"; then
  status=0
else
  status=$?
fi

if [ ! -f "$reward_file" ]; then
  if ! printf '%s
' "$fallback" > "$reward_file"; then
    exit 125
  fi
  if [ "$status" -eq 0 ]; then
    status=125
  fi
fi

exit "$status"
`;

const SOLVE_SH = `#!/bin/sh
set -eu

# The reference: the escaped head plus the fix commits' source changes, without the hidden tests.
app_dir=\${HARBOR_APP_DIR:-/app}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$app_dir"
if command -v git >/dev/null 2>&1; then
  git apply --whitespace=nowarn "$here/reference.patch"
else
  patch -p1 < "$here/reference.patch"
fi
`;

/** A TOML basic string. JSON string escapes are valid TOML ones. */
const str = (/** @type {unknown} */ value) => JSON.stringify(String(value));
const list = (/** @type {string[]} */ values) => `[${values.map(str).join(', ')}]`;

/** @param {string} file @returns {Record<string, any> | null} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The shell lines that install one folder's dependencies, picked by its lockfile. */
function installLine(dir) {
  const has = (/** @type {string} */ name) => fs.existsSync(path.join(dir, name));
  if (has('package-lock.json')) return 'RUN npm ci';
  if (has('yarn.lock')) return 'RUN yarn install --frozen-lockfile';
  if (has('pnpm-lock.yaml')) return 'RUN corepack enable && pnpm install --frozen-lockfile';
  return 'RUN npm install';
}

/** Which MongoDB test-server package (if any) a package.json depends on. */
function mongoPackage(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return ['mongodb-memory-server', 'mongodb-memory-server-core'].find((name) => name in deps) ?? null;
}

/**
 * The agent image: the snapshot, then dependencies in every folder a hidden or regression test
 * runs from, then the MongoDB binary where a folder depends on `mongodb-memory-server`.
 *
 * @param {{ appDir: string, withins: string[] }} o
 */
export function agentDockerfile({ appDir, withins }) {
  const folders = withins
    .map((within) => ({ within, dir: path.join(appDir, within), pkg: readJson(path.join(appDir, within, 'package.json')) }))
    .filter((f) => f.pkg !== null);
  const usesMongo = folders.some((f) => mongoPackage(f.pkg));
  const lines = [`FROM ${NODE_IMAGE}`, '', 'COPY app/ /app/'];
  if (usesMongo) lines.push(`ENV MONGOMS_DOWNLOAD_DIR=${MONGO_BINARIES}`);
  for (const f of folders) {
    lines.push('', `WORKDIR ${f.within === '.' ? '/app' : `/app/${f.within}`}`, installLine(f.dir));
    const mongo = mongoPackage(f.pkg);
    if (mongo) lines.push(`RUN node -e "require('${mongo}').MongoMemoryServer.create().then((s) => s.stop())"`);
  }
  lines.push('', 'WORKDIR /app', '', INSTALL_MARKER, '');
  return lines.join('\n');
}

function verifierDockerfile({ usesMongo }) {
  return [
    `FROM ${NODE_IMAGE}`,
    '',
    'WORKDIR /app',
    'COPY test.sh /tests/test.sh',
    'COPY grader.mjs /tests/grader.mjs',
    'COPY hidden.json /tests/hidden.json',
    'COPY hidden/ /tests/hidden/',
    'COPY regression/ /tests/regression/',
    '# Only the root grader may read hidden verifier sources and write rewards.',
    '# Agent-controlled application code and tests always execute as nobody.',
    `ENV HARBOR_UNTRUSTED_UID=65534 \\`,
    `    HARBOR_UNTRUSTED_GID=65534${usesMongo ? ` \\\n    MONGOMS_DOWNLOAD_DIR=${MONGO_BINARIES}` : ''}`,
    'RUN chmod +x /tests/test.sh \\',
    '  && chmod -R 700 /tests \\',
    '  && mkdir -p /logs/verifier \\',
    '  && chmod 700 /logs/verifier',
    '',
  ].join('\n');
}

function taskToml({ task, hiddenCount, verifierTimeoutSec }) {
  const first = task.slug ?? task.taskId;
  return `schema_version = "1.4"

artifacts = [
  "/app/",
]

[task]
name = ${str(`${escapeReplaysCorpusId}/${task.taskId}`)}
version = "1.0.0"
description = ${str(`Implement the change specified for ${first}; the hidden tests are the fix commits' tests.`)}
authors = []
keywords = ["escape-replay", "real-bug"]

[metadata]
difficulty = "real"
category = "programming"
benchmark_category = "escape"
tags = ["escape-replay"]
difficulty_explanation = "A change that Forge shipped with a bug a later fix commit caught; the verifier runs that fix's tests."
source_session = ${str(task.sessionId)}
source_slug = ${str(task.slug ?? '')}
source_repo = ${str(task.repo)}
inferred = ${task.inferred ? 'true' : 'false'}
base_commit = ${str(task.base)}
head_commit = ${str(task.head)}
fix_commits = ${list(task.fixes.map((f) => f.commit))}
hidden_tests = ${hiddenCount}

[agent]
timeout_sec = 1800.0

[verifier]
timeout_sec = ${verifierTimeoutSec.toFixed(1)}
environment_mode = "separate"

[verifier.environment]
os = "linux"
network_mode = "no-network"
build_timeout_sec = 600.0
cpus = 2
memory_mb = 4096
storage_mb = 10240

[environment]
os = "linux"
network_mode = "public"
build_timeout_sec = 1800.0
cpus = 2
memory_mb = 4096
storage_mb = 20480
`;
}

/** @param {string} file @param {string | Buffer} content */
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * @param {{ out: string, task: Record<string, any>, calibration: { patch: Buffer, hidden: Array<Record<string, any>>, regression: Array<Record<string, any>> } }} o
 * @returns {string} the task directory
 */
export function writeTask({ out, task, calibration }) {
  const dir = path.join(out, 'tasks', task.taskId);
  const appDir = path.join(dir, 'environment', 'app');
  const { hidden, regression, patch } = calibration;
  const withins = [...new Set([...hidden, ...regression].map((t) => t.cwd))].sort();
  const entry = (/** @type {Record<string, any>} */ t) => ({ path: t.path, sha256: t.sha256, argv: t.argv, cwd: t.cwd });
  const verifierTimeoutSec = Math.min(MAX_VERIFIER_TIMEOUT_SEC, 120 + PER_TEST_TIMEOUT_SEC * (hidden.length + regression.length));

  put(path.join(dir, 'task.toml'), taskToml({ task, hiddenCount: hidden.length, verifierTimeoutSec }));
  put(path.join(dir, 'instruction.md'), task.instruction);
  put(path.join(dir, 'environment', 'Dockerfile'), agentDockerfile({ appDir, withins }));

  const usesMongo = withins.some((within) => mongoPackage(readJson(path.join(appDir, within, 'package.json'))));
  put(path.join(dir, 'tests', 'Dockerfile'), verifierDockerfile({ usesMongo }));
  put(path.join(dir, 'tests', 'test.sh'), TEST_SH);
  fs.copyFileSync(path.join(here, 'grader.mjs'), path.join(dir, 'tests', 'grader.mjs'));
  put(
    path.join(dir, 'tests', 'hidden.json'),
    `${JSON.stringify({ timeout_sec: PER_TEST_TIMEOUT_SEC, budget_sec: verifierTimeoutSec - 60, hidden: hidden.map(entry), regression: regression.map(entry) }, null, 2)}\n`,
  );
  // An empty folder does not survive being copied or tarred; the grader reads hidden.json, not the listing.
  put(path.join(dir, 'tests', 'hidden', '.keep'), '');
  put(path.join(dir, 'tests', 'regression', '.keep'), '');
  for (const t of hidden) put(path.join(dir, 'tests', 'hidden', t.path), t.bytes);
  for (const t of regression) put(path.join(dir, 'tests', 'regression', t.path), t.bytes);

  put(path.join(dir, 'solution', 'solve.sh'), SOLVE_SH);
  put(path.join(dir, 'solution', 'reference.patch'), patch);
  return dir;
}

/**
 * The corpus manifest, in the shape of the checked-in `corpora/*.json`.
 *
 * @param {Array<{ taskId: string }>} kept
 */
export function corpusManifest(kept) {
  return {
    schema_version: 1,
    corpus_id: escapeReplaysCorpusId,
    description: 'Real escapes: changes Forge shipped that a later fix commit corrected, graded by the fix commits\' own tests. Exported locally from a private project.',
    tasks: kept.map((t) => ({
      id: t.taskId,
      version: '1.0.0',
      category: 'escape',
      difficulty: 'real',
      task_path: path.posix.join('local', escapeReplaysCorpusId, 'tasks', t.taskId),
    })),
  };
}
