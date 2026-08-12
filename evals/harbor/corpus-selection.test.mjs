import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSafeTaskTree, parseCampaign, selectCorpus } from './corpus-selection.mjs';

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

test('accepts a well-formed campaign manifest and resolves every episode directory', async (t) => {
  const directory = await fixture(t);
  const locator = 'tasks/fixture-campaign';
  const taskRoot = path.join(directory, ...locator.split('/'));
  const declared = [
    { id: 'orders-charging', index: 1 },
    { id: 'partial-refunds', index: 2 },
    { id: 'refund-trap', index: 3 },
    { id: 'idempotency-keys', index: 4 },
    { id: 'handler-refactor', index: 5 },
    { id: 'expiry-trap', index: 6 },
  ].map((episode) => ({
    ...episode,
    task_path: `${locator}/${episode.id}`,
  }));
  await Promise.all(declared.map((episode) => mkdir(path.join(taskRoot, episode.id), { recursive: true })));
  const manifestPath = path.join(directory, 'campaign.json');
  const corpusId = 'fixture-campaign';
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    corpus_id: corpusId,
    episodes: declared,
  })}\n`);

  const campaign = await parseCampaign({
    id: corpusId,
    manifestPath,
    taskRoot,
    taskRootLocator: locator,
  });

  assert.equal(campaign.id, corpusId);
  assert.equal(campaign.episodes.length, declared.length);
  assert.deepEqual(
    campaign.episodes.map((episode) => episode.id),
    declared.map((episode) => episode.id),
  );
  assert.deepEqual(
    campaign.episodes.map((episode) => episode.index),
    declared.map((episode) => episode.index),
  );
  for (const [i, episode] of campaign.episodes.entries()) {
    assert.equal(episode.taskPath, declared[i].task_path);
    assert.equal(episode.resolvedPath, path.join(taskRoot, declared[i].id));
  }
});

async function campaignFixture(t, episodes, { omitIds = [] } = {}) {
  const directory = await fixture(t);
  const locator = 'tasks/fixture-campaign';
  const taskRoot = path.join(directory, ...locator.split('/'));
  const declared = episodes.map((episode) => ({
    ...episode,
    task_path: episode.task_path ?? `${locator}/${episode.id}`,
  }));
  await Promise.all(
    declared
      .filter((episode) => !omitIds.includes(episode.id))
      .map((episode) => mkdir(path.join(taskRoot, episode.id), { recursive: true })),
  );
  const manifestPath = path.join(directory, 'campaign.json');
  const corpusId = 'fixture-campaign';
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    corpus_id: corpusId,
    episodes: declared,
  })}\n`);
  return { id: corpusId, manifestPath, taskRoot, taskRootLocator: locator };
}

test('rejects a campaign whose episode ids are not unique', async (t) => {
  const duplicateId = 'partial-refunds';
  const selection = await campaignFixture(t, [
    { id: 'orders-charging', index: 1 },
    { id: duplicateId, index: 2 },
    { id: duplicateId, index: 3 },
  ]);

  await assert.rejects(
    parseCampaign(selection),
    (error) => {
      assert.match(error.message, new RegExp(`duplicate episode id: ${duplicateId}`));
      return true;
    },
  );
});

test('rejects a campaign whose episode indices skip a value', async (t) => {
  const offendingId = 'idempotency-keys';
  const selection = await campaignFixture(t, [
    { id: 'orders-charging', index: 1 },
    { id: 'partial-refunds', index: 2 },
    { id: offendingId, index: 4 },
  ]);

  await assert.rejects(
    parseCampaign(selection),
    (error) => {
      assert.match(error.message, new RegExp(`non-contiguous episode index: ${offendingId}`));
      return true;
    },
  );
});

test('rejects a campaign whose episode indices do not start at one', async (t) => {
  const offendingId = 'partial-refunds';
  const selection = await campaignFixture(t, [
    { id: offendingId, index: 2 },
    { id: 'refund-trap', index: 3 },
    { id: 'idempotency-keys', index: 4 },
  ]);

  await assert.rejects(
    parseCampaign(selection),
    (error) => {
      assert.match(error.message, new RegExp(`episode index must start at 1: ${offendingId}`));
      return true;
    },
  );
});

test('rejects a campaign whose episode directory is missing', async (t) => {
  const missingId = 'refund-trap';
  const selection = await campaignFixture(t, [
    { id: 'orders-charging', index: 1 },
    { id: 'partial-refunds', index: 2 },
    { id: missingId, index: 3 },
  ], { omitIds: [missingId] });

  await assert.rejects(
    parseCampaign(selection),
    (error) => {
      assert.match(error.message, new RegExp(`missing episode directory: ${missingId}`));
      return true;
    },
  );
});

test('rejects a campaign whose episode task_path does not match its allowlisted root', async (t) => {
  const offendingId = 'partial-refunds';
  const selection = await campaignFixture(t, [
    { id: 'orders-charging', index: 1 },
    { id: offendingId, index: 2, task_path: 'tasks/other-corpus/partial-refunds' },
    { id: 'refund-trap', index: 3 },
  ]);

  await assert.rejects(
    parseCampaign(selection),
    (error) => {
      assert.match(
        error.message,
        new RegExp(`task_path does not match its allowlisted root for episode: ${offendingId}`),
      );
      return true;
    },
  );
});

test('parses a tasks-only manifest as having no campaign episodes', async (t) => {
  const directory = await fixture(t);
  const locator = 'tasks/fixture-tasks';
  const taskRoot = path.join(directory, ...locator.split('/'));
  const corpusId = 'fixture-tasks';
  const manifestPath = path.join(directory, 'corpus.json');
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    corpus_id: corpusId,
    tasks: [
      {
        id: 'reservation-confirmation-race',
        version: '1.0.1',
        task_path: `${locator}/reservation-confirmation-race`,
      },
    ],
  })}\n`);

  const campaign = await parseCampaign({
    id: corpusId,
    manifestPath,
    taskRoot,
    taskRootLocator: locator,
  });

  assert.equal(campaign.id, corpusId);
  assert.equal(campaign.episodes, null);
});

test('loads the checked-in campaign manifest and resolves every episode path', async () => {
  const selection = selectCorpus('forgekit-campaign-v1');
  const declared = JSON.parse(await readFile(selection.manifestPath, 'utf8'));
  const campaign = await parseCampaign(selection);

  assert.equal(campaign.id, declared.corpus_id);
  assert.equal(selection.taskRootLocator, 'tasks/forgekit-campaign-v1');
  assert.equal(campaign.episodes.length, declared.episodes.length);
  assert.deepEqual(
    campaign.episodes.map((episode) => episode.id),
    declared.episodes.map((episode) => episode.id),
  );
  assert.deepEqual(
    campaign.episodes.map((episode) => episode.index),
    declared.episodes.map((episode) => episode.index),
  );
  assert.deepEqual(
    campaign.episodes.map((episode) => episode.version),
    declared.episodes.map((episode) => episode.version),
  );
  for (const [i, episode] of campaign.episodes.entries()) {
    assert.equal(episode.taskPath, declared.episodes[i].task_path);
    assert.equal(episode.resolvedPath, path.join(selection.taskRoot, declared.episodes[i].id));
  }
});
