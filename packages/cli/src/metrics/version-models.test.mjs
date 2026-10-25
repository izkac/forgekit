/**
 * The digest's `forgekitVersion` and `models: { coordinator, subagents }`
 * (escape-gaps 3.1): which release wrote the session line, and which models
 * the coordinator and the subagents ran on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from './collect.mjs';
import { appendSessionDigest, readLedger } from '../ledger.mjs';
import { DEFAULT_HOST_ID, assistantLine, plantHost } from './test-host-tree.mjs';

const CLI_PACKAGE_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

const NOW = () => new Date('2026-07-27T11:00:00.000Z');

/** Out of alphabetical order and repeated, so sorting and de-duplication both show. */
const COORDINATOR_MODELS = ['claude-opus-5', 'claude-fable-5', 'claude-opus-5'];
const SUBAGENT_MODELS = ['claude-sonnet-5', 'claude-haiku-5', 'claude-sonnet-5', 'claude-haiku-5'];

const unique = (models) => [...new Set(models)].sort();

function session() {
  return {
    id: '20260727T100000Z-demo-abc123',
    createdAt: '2026-07-27T10:00:00.000Z',
    host: { agent: 'claude-code', sessionIds: [DEFAULT_HOST_ID], boundAt: '2026-07-27T10:00:00.000Z' },
  };
}

/** Coordinator requests on COORDINATOR_MODELS, one subagent whose requests run on SUBAGENT_MODELS. */
function plant({ sidechainMarked = true } = {}) {
  const at = (i) => `2026-07-27T10:${String(10 + i).padStart(2, '0')}:00.000Z`;
  const parent = COORDINATOR_MODELS.map((model, i) =>
    assistantLine({ requestId: `p${i}`, at: at(i), model, tokens: { input: 10 + i } }),
  );
  const sub = SUBAGENT_MODELS.map((model, i) =>
    assistantLine({ requestId: `s${i}`, at: at(20 + i), model, tokens: { input: 100 + i }, isSidechain: true, agentId: 'aaa111' }),
  );
  const strip = (line) => {
    const copy = { ...line };
    delete copy.isSidechain;
    return copy;
  };
  return plantHost({
    lines: sidechainMarked ? parent : parent.map(strip),
    subagents: {
      aaa111: {
        meta: { agentType: 'general-purpose', description: 'work', toolUseId: 'toolu_x', spawnDepth: 1, model: 'opus' },
        lines: sidechainMarked ? sub : sub.map(strip),
      },
    },
  });
}

/** Collect metrics for `configDir`, write the digest, and return its one line. */
function digestFor(configDir) {
  const doc = collectMetrics({ session: session(), now: NOW, configDir });
  const root = tmp('forge-version-models-');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'metrics.json'), `${JSON.stringify(doc)}\n`, 'utf8');
  const stored = { id: 's1', slug: 'demo', createdAt: doc.window.from, updatedAt: doc.collectedAt, phase: 'done' };
  appendSessionDigest({ cwd: root, sessionDir, session: stored, card: { score: 90, grade: 'A' } });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));
  return { doc, entry };
}

test('the digest lists the coordinator and subagent models separately, sorted and de-duplicated', () => {
  const { doc, entry } = digestFor(plant());

  assert.equal(doc.available, true);
  assert.deepEqual(entry.models, { coordinator: unique(COORDINATOR_MODELS), subagents: unique(SUBAGENT_MODELS) });
  assert.notDeepEqual(entry.models.coordinator, entry.models.subagents);
  assert.deepEqual(doc.coordinator.models, unique(COORDINATOR_MODELS));
});

test('a host whose transcripts do not mark subagent requests has null models on both sides', () => {
  const { doc, entry } = digestFor(plant({ sidechainMarked: false }));

  assert.equal(doc.available, true);
  assert.equal(doc.coordinator, null, 'fixture: the host is not separable');
  assert.deepEqual(entry.models, { coordinator: null, subagents: null });
});

test('a session with no collected metrics has null models', () => {
  const root = tmp('forge-version-models-none-');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stored = { id: 's1', slug: 'demo', createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T11:00:00.000Z', phase: 'done' };

  appendSessionDigest({ cwd: root, sessionDir, session: stored, card: { score: 90, grade: 'A' } });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));

  assert.deepEqual(entry.models, { coordinator: null, subagents: null });
});

test('forgekitVersion is the version of the CLI package that wrote the digest', () => {
  const expected = JSON.parse(fs.readFileSync(CLI_PACKAGE_JSON, 'utf8')).version;
  assert.match(expected, /^\d+\.\d+\.\d+/, 'fixture: the package has a version');

  const { entry } = digestFor(plant());

  assert.equal(entry.forgekitVersion, expected);
});

test('forgekitVersion resolves from the module, not the working directory', () => {
  const expected = JSON.parse(fs.readFileSync(CLI_PACKAGE_JSON, 'utf8')).version;
  const elsewhere = tmp('forge-version-cwd-');
  fs.writeFileSync(path.join(elsewhere, 'package.json'), JSON.stringify({ name: 'other', version: '0.0.0-other' }));
  const before = process.cwd();
  process.chdir(elsewhere);
  try {
    const { entry } = digestFor(plant());
    assert.equal(entry.forgekitVersion, expected);
  } finally {
    process.chdir(before);
  }
});
