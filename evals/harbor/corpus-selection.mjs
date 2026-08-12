import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
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
  ['forgekit-campaign-v1', {
    manifestPath: path.join(here, 'corpora', 'forgekit-campaign-v1.json'),
    taskRoot: path.join(here, 'tasks', 'forgekit-campaign-v1'),
    taskRootLocator: 'tasks/forgekit-campaign-v1',
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

export async function parseCampaign(selection) {
  const parsed = JSON.parse(await readFile(selection.manifestPath, 'utf8'));
  if (!Array.isArray(parsed.episodes)) {
    return { id: parsed.corpus_id, episodes: null };
  }
  const seenIds = new Set();
  for (const entry of parsed.episodes) {
    if (seenIds.has(entry.id)) throw new Error(`duplicate episode id: ${entry.id}`);
    seenIds.add(entry.id);
  }
  for (let i = 0; i < parsed.episodes.length; i += 1) {
    const entry = parsed.episodes[i];
    if (entry.index === i + 1) continue;
    if (i === 0) throw new Error(`episode index must start at 1: ${entry.id}`);
    throw new Error(`non-contiguous episode index: ${entry.id}`);
  }
  for (const entry of parsed.episodes) {
    const expectedTaskPath = path.posix.join(selection.taskRootLocator, entry.id);
    if (entry.task_path !== undefined && entry.task_path !== expectedTaskPath) {
      throw new Error(`corpus task_path does not match its allowlisted root for episode: ${entry.id}`);
    }
  }
  const episodes = [];
  for (const entry of parsed.episodes) {
    let resolvedPath;
    try {
      resolvedPath = await assertSafeTaskTree(selection.taskRoot, entry.id);
    } catch (error) {
      if (error.message.startsWith('unknown task:')) {
        throw new Error(`missing episode directory: ${entry.id}`);
      }
      throw error;
    }
    episodes.push({
      id: entry.id,
      index: entry.index,
      taskPath: entry.task_path,
      version: entry.version,
      resolvedPath,
    });
  }
  return { id: parsed.corpus_id, episodes };
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
