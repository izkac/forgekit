import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const defaultCorpusId = 'forgekit-held-out-v1';

const registry = new Map([
  [defaultCorpusId, {
    manifestPath: path.join(here, 'corpus.json'),
    taskRoot: path.join(here, 'tasks'),
    taskRootLocator: 'tasks',
  }],
  ['forgekit-hard-v2', {
    manifestPath: path.join(here, 'corpora', 'forgekit-hard-v2.json'),
    taskRoot: path.join(here, 'tasks', 'forgekit-hard-v2'),
    taskRootLocator: 'tasks/forgekit-hard-v2',
  }],
]);

export function selectCorpus(corpusId = defaultCorpusId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(corpusId)) {
    throw new Error('corpus must be a safe corpus id containing lowercase letters, digits, and hyphens');
  }
  const selected = registry.get(corpusId);
  if (selected === undefined) throw new Error(`unknown corpus: ${corpusId}`);
  return { id: corpusId, ...selected };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function inspectTaskTree(directory, containmentRoot, relative = '') {
  const entries = await readdir(directory);
  entries.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const name of entries) {
    const child = path.join(directory, name);
    const childRelative = path.posix.join(relative, name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      throw new Error(`task tree contains a symbolic link: ${childRelative}`);
    }
    const resolved = await realpath(child);
    if (!isInside(containmentRoot, resolved)) {
      throw new Error(`task tree entry resolves outside its allowlisted root: ${childRelative}`);
    }
    if (info.isDirectory()) await inspectTaskTree(child, containmentRoot, childRelative);
    else if (!info.isFile()) throw new Error(`task tree contains an unsupported entry: ${childRelative}`);
  }
}

export async function assertSafeTaskTree(taskRoot, taskId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) throw new Error('task must be a safe task id');
  let rootInfo;
  try {
    rootInfo = await lstat(taskRoot);
  } catch (error) {
    throw new Error(`could not inspect allowlisted task root: ${error.message}`);
  }
  if (rootInfo.isSymbolicLink()) throw new Error('allowlisted task root must not be a symbolic link');
  if (!rootInfo.isDirectory()) throw new Error('allowlisted task root must be a directory');

  const rootReal = await realpath(taskRoot);
  const taskDirectory = path.join(taskRoot, taskId);
  let taskInfo;
  try {
    taskInfo = await lstat(taskDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`unknown task: ${taskId}`);
    throw new Error(`could not inspect task directory: ${error.message}`);
  }
  if (taskInfo.isSymbolicLink()) throw new Error('task directory must not be a symbolic link');
  if (!taskInfo.isDirectory()) throw new Error(`task is not a directory: ${taskId}`);
  const taskReal = await realpath(taskDirectory);
  if (!isInside(rootReal, taskReal)) throw new Error('task directory resolves outside its allowlisted root');
  await inspectTaskTree(taskDirectory, rootReal);
  return taskDirectory;
}
