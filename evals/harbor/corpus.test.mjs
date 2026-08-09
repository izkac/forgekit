import assert from 'node:assert/strict';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksRoot = path.join(here, 'tasks');
const requiredCategories = ['bug', 'feature', 'integration', 'refactor', 'security', 'tests'];

async function assertNoSymlinks(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    assert.equal(info.isSymbolicLink(), false, `symlink forbidden in canonical task: ${target}`);
    if (info.isDirectory()) await assertNoSymlinks(target);
    else assert.equal(info.isFile(), true, `non-regular task entry: ${target}`);
  }
}

test('held-out corpus catalogs exactly one self-contained task per required category', async () => {
  const corpus = JSON.parse(await readFile(path.join(here, 'corpus.json'), 'utf8'));
  assert.equal(corpus.schema_version, 1);
  assert.match(corpus.corpus_id, /^[a-z0-9][a-z0-9-]*$/);
  assert.deepEqual([...corpus.tasks.map((entry) => entry.category)].sort(), requiredCategories);
  assert.equal(new Set(corpus.tasks.map((entry) => entry.id)).size, corpus.tasks.length);

  for (const entry of corpus.tasks) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(['easy', 'medium', 'hard'].includes(entry.difficulty));
    assert.match(entry.visible_test, /^[a-zA-Z0-9._/-]+$/);
    assert.equal(entry.visible_test.includes('..'), false);
    const directory = path.join(tasksRoot, entry.id);
    assert.equal((await stat(directory)).isDirectory(), true, entry.id);
    for (const relative of [
      'task.toml', 'instruction.md', 'environment/Dockerfile', 'environment/app/package.json',
      `environment/app/${entry.visible_test}`, 'tests/Dockerfile', 'tests/test.sh',
      'tests/grader.mjs', 'solution/solve.sh',
    ]) assert.equal((await stat(path.join(directory, relative))).isFile(), true, `${entry.id}: ${relative}`);

    await assertNoSymlinks(directory);
    const metadata = await readFile(path.join(directory, 'task.toml'), 'utf8');
    assert.match(metadata, /schema_version = "1\.4"/);
    assert.match(metadata, new RegExp(`benchmark_category = "${entry.category}"`));
    assert.match(metadata, /environment_mode = "separate"/);
    const agentDockerfile = await readFile(path.join(directory, 'environment/Dockerfile'), 'utf8');
    const verifierDockerfile = await readFile(path.join(directory, 'tests/Dockerfile'), 'utf8');
    assert.match(agentDockerfile, /^FROM node:22-bookworm@sha256:[a-f0-9]{64}$/m);
    assert.equal(agentDockerfile.split('FORGEKIT_INSTALL_MARKER').length - 1, 1);
    assert.doesNotMatch(agentDockerfile, /grader\.mjs|COPY \..*tests/i);
    assert.match(verifierDockerfile, /^FROM node:22-bookworm@sha256:[a-f0-9]{64}$/m);
    assert.match(verifierDockerfile, /COPY grader\.mjs \/tests\/grader\.mjs/);
  }
});
