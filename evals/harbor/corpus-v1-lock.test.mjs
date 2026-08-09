import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, 'corpus.json');
const tasksRoot = path.join(here, 'tasks');
const lockPath = path.join(here, 'corpus-v1.lock.json');

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
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
      else if (entry.isFile()) hash.update(await readFile(child));
      else assert.fail(`v1 task contains unsupported entry: ${childRelative}`);
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

test('published forgekit-held-out-v1 manifest and task revisions match the checked-in lock', async () => {
  const [manifestBytes, lockBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(lockPath),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);

  assert.equal(lock.schema_version, 1);
  assert.equal(lock.corpus_id, 'forgekit-held-out-v1');
  assert.equal(manifest.corpus_id, lock.corpus_id);
  assert.equal(lock.manifest.path, 'corpus.json');
  assert.equal(lock.manifest.sha256, await hashFile(manifestPath));

  const manifestTaskIds = manifest.tasks.map(({ id }) => id).sort();
  const lockedTaskIds = Object.keys(lock.tasks).sort();
  assert.deepEqual(lockedTaskIds, manifestTaskIds);
  assert.deepEqual(lockedTaskIds, [
    'audit-log-wiring',
    'csv-formula-regression',
    'encoded-path-traversal',
    'node-health-endpoint',
    'pagination-boundary',
    'router-extraction',
  ]);
  for (const taskId of lockedTaskIds) {
    assert.match(lock.tasks[taskId], /^[a-f0-9]{64}$/);
    assert.equal(await hashDirectory(path.join(tasksRoot, taskId)), lock.tasks[taskId], taskId);
  }
});
