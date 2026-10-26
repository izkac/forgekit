/**
 * Write one calibrated escape-replay candidate as a Harbor task, modelled on
 * `evals/harbor/tasks/pagination-boundary/` (specs/changes/escape-replays).
 *
 * The agent environment is the base snapshot (already extracted under `environment/app/`) with its
 * dependencies installed. The separate, no-network verifier receives the agent's /app as an
 * artifact, but not its dependencies: the verifier image installs its own, from copies of the base
 * manifests and lockfiles in `tests/deps/<cwd>/`, and the grader runs the tests against those. The
 * artifact is still `/app/` whole (the Forge arm's `.forge/` travels with it), so the agent's
 * `node_modules` come along unused: the grader removes every `node_modules` under it, then links the verifier's. The hidden tests and the regression
 * set live only in `tests/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPLAY_TIMEOUT_SEC } from '../../../packages/cli/src/escapes-replay.mjs';
import { escapeReplaysCorpusId } from '../corpus-selection.mjs';
import { LOCKFILES, PROTECTED_NAME, RC_NAME, folderAndAncestors, installCommand, isRcName, mongoPackage } from './deps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The node image every checked-in task uses, pinned by digest. */
const NODE_IMAGE = 'node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a';

/** Must match `installMarker` in run.mjs exactly: the Forge arm replaces this line. */
const INSTALL_MARKER = '# FORGEKIT_INSTALL_MARKER: the Forge arm may replace this line with its pinned Forgekit install command.';

/** The agent image's MongoDB binary: outside /app, so the agent's artifact does not carry it. */
const AGENT_MONGO_BINARIES = '/opt/mongodb-binaries';

/** The verifier's installed dependencies: a folder the untrusted user can read, unlike /tests. */
const VERIFIER_DEPS = '/opt/verifier-deps';

/** The grader's total time: this much slack, plus one per-test timeout for every test file. */
const VERIFIER_SLACK_SEC = 120;
const MAX_VERIFIER_TIMEOUT_SEC = 7200;

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

/** @param {Buffer | undefined} bytes @returns {Record<string, any> | null} */
function parseJson(bytes) {
  try {
    return JSON.parse(String(bytes));
  } catch {
    return null;
  }
}

/** @typedef {{ path: string, cwd: string, sha256: string, bytes: Buffer }} ProtectedFile */

/**
 * The folders dependencies are installed in, from the base's own manifests: one per rule cwd that
 * has a `package.json`, with the file names the install needs.
 *
 * @param {ProtectedFile[]} files
 * @returns {Array<{ cwd: string, files: ProtectedFile[], pkg: Record<string, any> | null }>}
 */
function installFolders(files) {
  const needed = new Set(['package.json', ...LOCKFILES]);
  /** @type {Map<string, ProtectedFile[]>} */
  const byCwd = new Map();
  for (const f of files) {
    if (!needed.has(path.posix.basename(f.path))) continue;
    byCwd.set(f.cwd, [...(byCwd.get(f.cwd) ?? []), f]);
  }
  return [...byCwd]
    .map(([cwd, fs_]) => ({ cwd, files: fs_, pkg: parseJson(fs_.find((f) => path.posix.basename(f.path) === 'package.json')?.bytes) }))
    .filter((f) => f.files.some((x) => path.posix.basename(x.path) === 'package.json'))
    .sort((a, b) => a.cwd.localeCompare(b.cwd));
}

const folderIn = (/** @type {string} */ root, /** @type {string} */ cwd) => (cwd === '.' ? root : `${root}/${cwd}`);
const names = (/** @type {ProtectedFile[]} */ files) => files.map((f) => path.posix.basename(f.path));

/**
 * The agent image: the snapshot, then dependencies in every folder a hidden or regression test
 * runs from, then the MongoDB binary where a folder depends on `mongodb-memory-server`.
 *
 * @param {{ protectedFiles: ProtectedFile[] }} o
 */
export function agentDockerfile({ protectedFiles }) {
  const folders = installFolders(protectedFiles);
  const usesMongo = folders.some((f) => mongoPackage(f.pkg));
  const lines = [`FROM ${NODE_IMAGE}`, '', 'COPY app/ /app/'];
  if (usesMongo) lines.push(`ENV MONGOMS_DOWNLOAD_DIR=${AGENT_MONGO_BINARIES}`);
  for (const f of folders) {
    lines.push('', `WORKDIR ${folderIn('/app', f.cwd)}`, `RUN ${installCommand(names(f.files))}`);
    const mongo = mongoPackage(f.pkg);
    if (mongo) lines.push(`RUN node -e "require('${mongo}').MongoMemoryServer.create().then((s) => s.stop())"`);
  }
  lines.push('', 'WORKDIR /app', '', INSTALL_MARKER, '');
  return lines.join('\n');
}

/**
 * The verifier image: the hidden files, then its own dependencies, installed from the base
 * manifests and lockfiles exactly as the agent image installs them, and readable by the untrusted
 * user. No-network at run time, so the MongoDB binary is fetched here too.
 *
 * ponytail: unproven until the first paid run, like the agent image. It assumes Harbor builds the
 * verifier image with network, and that `npm ci` works without the rest of the source: a
 * package.json whose lifecycle scripts need other files breaks the build, loudly.
 *
 * @param {{ protectedFiles: ProtectedFile[] }} o
 */
export function verifierDockerfile({ protectedFiles }) {
  const folders = installFolders(protectedFiles);
  const usesMongo = folders.some((f) => mongoPackage(f.pkg));
  const lines = [
    `FROM ${NODE_IMAGE}`,
    '',
    'WORKDIR /app',
    'COPY test.sh /tests/test.sh',
    'COPY grader.mjs /tests/grader.mjs',
    'COPY outcome.mjs /tests/outcome.mjs',
    'COPY hidden.json /tests/hidden.json',
    'COPY hidden/ /tests/hidden/',
    'COPY regression/ /tests/regression/',
    '',
    '# The verifier installs its own dependencies from the base manifests; the grader runs the tests',
    '# against these and never against the ones the agent left in /app.',
    `COPY deps/ ${VERIFIER_DEPS}/`,
  ];
  if (usesMongo) lines.push(`ENV MONGOMS_DOWNLOAD_DIR=${VERIFIER_DEPS}/.mongodb-binaries`);
  for (const f of folders) {
    lines.push(`WORKDIR ${folderIn(VERIFIER_DEPS, f.cwd)}`, `RUN ${installCommand(names(f.files))}`);
    const mongo = mongoPackage(f.pkg);
    if (mongo) lines.push(`RUN node -e "require('${mongo}').MongoMemoryServer.create().then((s) => s.stop())"`);
  }
  lines.push(
    'WORKDIR /app',
    '# Only the root grader may read hidden verifier sources and write rewards.',
    '# Agent-controlled application code and tests always execute as nobody, who reads the',
    '# dependencies but cannot change them.',
    `ENV HARBOR_UNTRUSTED_UID=65534 \\`,
    `    HARBOR_UNTRUSTED_GID=65534 \\`,
    `    HARBOR_DEPS_DIR=${VERIFIER_DEPS}`,
    'RUN chmod +x /tests/test.sh \\',
    '  && chmod -R 700 /tests \\',
    `  && chmod -R a+rX ${VERIFIER_DEPS} \\`,
    '  && mkdir -p /logs/verifier \\',
    '  && chmod 700 /logs/verifier',
    '',
  );
  return lines.join('\n');
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
build_timeout_sec = 1800.0
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
 * @param {{ out: string, task: Record<string, any>, timeoutSec?: number,
 *   calibration: { patch: Buffer, hidden: Array<Record<string, any>>, regression: Array<Record<string, any>>, protectedFiles: ProtectedFile[] } }} o
 *   `timeoutSec` is the per-test timeout calibration ran with; the grader runs every test under the same one
 * @returns {string} the task directory
 */
export function writeTask({ out, task, calibration, timeoutSec = DEFAULT_REPLAY_TIMEOUT_SEC }) {
  const dir = path.join(out, 'tasks', task.taskId);
  const { hidden, regression, patch, protectedFiles } = calibration;
  const folders = installFolders(protectedFiles);
  const entry = (/** @type {Record<string, any>} */ t) => ({ path: t.path, sha256: t.sha256, argv: t.argv, cwd: t.cwd });
  const verifierTimeoutSec = Math.min(MAX_VERIFIER_TIMEOUT_SEC, VERIFIER_SLACK_SEC + timeoutSec * (hidden.length + regression.length));

  put(path.join(dir, 'task.toml'), taskToml({ task, hiddenCount: hidden.length, verifierTimeoutSec }));
  put(path.join(dir, 'instruction.md'), task.instruction);
  put(path.join(dir, 'environment', 'Dockerfile'), agentDockerfile({ protectedFiles }));

  put(path.join(dir, 'tests', 'Dockerfile'), verifierDockerfile({ protectedFiles }));
  put(path.join(dir, 'tests', 'test.sh'), TEST_SH);
  fs.copyFileSync(path.join(here, 'grader.mjs'), path.join(dir, 'tests', 'grader.mjs'));
  fs.copyFileSync(path.join(here, 'outcome.mjs'), path.join(dir, 'tests', 'outcome.mjs'));
  put(
    path.join(dir, 'tests', 'hidden.json'),
    `${JSON.stringify(
      {
        timeout_sec: timeoutSec,
        budget_sec: verifierTimeoutSec - 60,
        // The files the agent must leave as they are: hashes of the base's, and the names that may not appear anew.
        protected_name: PROTECTED_NAME,
        protected_dirs: [...new Set([...hidden, ...regression].map((t) => t.cwd))].sort(),
        // Package-manager rc files are held to the base from each rule cwd up to the repository root.
        rc_name: RC_NAME,
        rc_dirs: [...new Set([...hidden, ...regression].flatMap((t) => folderAndAncestors(t.cwd)))].sort(),
        protected: protectedFiles.map((f) => ({ path: f.path, sha256: f.sha256 })),
        deps: folders.map((f) => ({ cwd: f.cwd })),
        hidden: hidden.map(entry),
        regression: regression.map(entry),
      },
      null,
      2,
    )}\n`,
  );
  // An empty folder does not survive being copied or tarred; the grader reads hidden.json, not the listing.
  put(path.join(dir, 'tests', 'hidden', '.keep'), '');
  put(path.join(dir, 'tests', 'regression', '.keep'), '');
  put(path.join(dir, 'tests', 'deps', '.keep'), '');
  for (const t of hidden) put(path.join(dir, 'tests', 'hidden', t.path), t.bytes);
  for (const t of regression) put(path.join(dir, 'tests', 'regression', t.path), t.bytes);
  for (const f of folders) for (const file of f.files) put(path.join(dir, 'tests', 'deps', f.cwd, path.posix.basename(file.path)), file.bytes);
  // The base's .npmrc/.yarnrc files of the cwd and its ancestors, at their repo-relative paths: the verifier's install reads them.
  for (const file of protectedFiles) if (isRcName(path.posix.basename(file.path))) put(path.join(dir, 'tests', 'deps', file.path), file.bytes);

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
