import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSafeTaskTree } from './corpus-selection.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-corpus-tree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createSymlinkOrSkip(t, target, link, type) {
  try {
    await symlink(target, link, type);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

test('rejects an allowlisted task root that is itself a symlink', async (t) => {
  const directory = await fixture(t);
  const actualRoot = path.join(directory, 'actual-root');
  await mkdir(path.join(actualRoot, 'safe-task'), { recursive: true });
  const linkedRoot = path.join(directory, 'linked-root');
  if (!await createSymlinkOrSkip(t, actualRoot, linkedRoot, 'dir')) return;

  await assert.rejects(
    assertSafeTaskTree(linkedRoot, 'safe-task'),
    /task root.*symbolic link/i,
  );
});

test('rejects a task directory that is a symlink outside its allowlisted root', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'root');
  const outside = path.join(directory, 'outside-task');
  await Promise.all([mkdir(root), mkdir(outside)]);
  if (!await createSymlinkOrSkip(t, outside, path.join(root, 'safe-task'), 'dir')) return;

  await assert.rejects(
    assertSafeTaskTree(root, 'safe-task'),
    /task directory.*symbolic link/i,
  );
});

test('recursively rejects an internal symlink before task staging', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'root');
  const task = path.join(root, 'safe-task');
  const outside = path.join(directory, 'outside-secret');
  await mkdir(path.join(task, 'environment'), { recursive: true });
  await writeFile(outside, 'outside');
  if (!await createSymlinkOrSkip(t, outside, path.join(task, 'environment', 'escape'), 'file')) return;

  await assert.rejects(
    assertSafeTaskTree(root, 'safe-task'),
    /task tree contains a symbolic link.*environment\/escape/i,
  );
});
