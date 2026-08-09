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
