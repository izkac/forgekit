import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(path.join(here, 'corpus-selection.mjs')).href;
const corpusId = 'forgekit-escape-replays-v1';
let loads = 0;

/** The registry is built at module load, so each case loads a fresh copy under its own local root. */
async function loadWithLocalRoot(t, withManifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgekit-local-corpus-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (withManifest) {
    await mkdir(path.join(root, corpusId), { recursive: true });
    await writeFile(path.join(root, corpusId, 'corpus.json'), JSON.stringify({ corpus_id: corpusId }));
  }
  const previous = process.env.FORGEKIT_EVALS_LOCAL_ROOT;
  process.env.FORGEKIT_EVALS_LOCAL_ROOT = root;
  try {
    loads += 1;
    return { root, mod: await import(`${moduleUrl}?local=${loads}`) };
  } finally {
    if (previous === undefined) delete process.env.FORGEKIT_EVALS_LOCAL_ROOT;
    else process.env.FORGEKIT_EVALS_LOCAL_ROOT = previous;
  }
}

test('the escape-replays corpus is unknown without its local manifest', async (t) => {
  const { mod } = await loadWithLocalRoot(t, false);
  assert.throws(() => mod.selectCorpus(corpusId), /unknown corpus: forgekit-escape-replays-v1/);
});

test('the escape-replays corpus is selected when its local manifest exists', async (t) => {
  const { root, mod } = await loadWithLocalRoot(t, true);
  const selected = mod.selectCorpus(corpusId);
  assert.equal(selected.id, corpusId);
  assert.equal(selected.manifestPath, path.join(root, corpusId, 'corpus.json'));
  assert.equal(selected.taskRoot, path.join(root, corpusId, 'tasks'));
  assert.equal(selected.taskRootLocator, `local/${corpusId}/tasks`);
});

test('the checked-in corpora stay selectable whether or not the local corpus exists', async (t) => {
  const { mod } = await loadWithLocalRoot(t, false);
  for (const id of ['forgekit-held-out-v1', 'forgekit-hard-v2', 'forgekit-campaign-v1']) {
    assert.equal(mod.selectCorpus(id).id, id);
  }
});

test('the local corpus directory is ignored by git', async () => {
  const ignore = await readFile(path.join(here, '..', '..', '.gitignore'), 'utf8');
  assert.ok(ignore.split(/\r?\n/).includes('evals/harbor/local/'));
});
