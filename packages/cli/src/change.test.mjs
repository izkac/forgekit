import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertChangeName,
  assertCapabilityName,
  archiveSpecsChange,
  createSpecsChange,
  parseArgs,
  runChange,
} from './change.mjs';
import { writeProjectPlanConfig, scaffoldSpecs } from './plan-engine.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-change-'));
}

test('assertChangeName accepts kebab-case', () => {
  assert.equal(assertChangeName('add-auth'), 'add-auth');
  assert.throws(() => assertChangeName('Add Auth'), /kebab-case/);
  assert.throws(() => assertChangeName('UPPER'), /kebab-case/);
});

test('assertCapabilityName accepts kebab-case', () => {
  assert.equal(assertCapabilityName('auth'), 'auth');
  assert.throws(() => assertCapabilityName('Auth'), /kebab-case/);
});

test('parseArgs new and archive with capabilities', () => {
  assert.deepEqual(parseArgs(['new', 'foo', '--force']).action, 'new');
  assert.equal(parseArgs(['new', 'foo']).name, 'foo');
  assert.equal(parseArgs(['archive', 'foo', '--date', '2026-01-02']).date, '2026-01-02');
  assert.deepEqual(
    parseArgs(['new', 'foo', '--capability', 'auth', '--cap', 'payments']).capabilities,
    ['auth', 'payments'],
  );
  assert.equal(parseArgs(['archive', 'foo', '--no-sync']).noSync, true);
});

test('createSpecsChange writes OpenSpec-parity artefacts including deltas', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    const result = createSpecsChange(cwd, 'add-refunds', {
      force: true,
      capabilities: ['payments'],
    });
    assert.ok(fs.existsSync(path.join(result.changeDir, 'proposal.md')));
    assert.ok(fs.existsSync(path.join(result.changeDir, 'design.md')));
    assert.ok(fs.existsSync(path.join(result.changeDir, 'tasks.md')));
    assert.ok(fs.existsSync(path.join(result.changeDir, 'specs', 'payments', 'spec.md')));
    const proposal = fs.readFileSync(path.join(result.changeDir, 'proposal.md'), 'utf8');
    assert.match(proposal, /## Capabilities/);
    assert.match(proposal, /`payments`/);
    const delta = fs.readFileSync(
      path.join(result.changeDir, 'specs', 'payments', 'spec.md'),
      'utf8',
    );
    assert.match(delta, /## ADDED Requirements/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('createSpecsChange rejects openspec engine', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'openspec' });
    assert.throws(() => createSpecsChange(cwd, 'x'), /not "specs"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('createSpecsChange honors custom plan.dir', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs', dir: 'openspec' });
    scaffoldSpecs(cwd, { dir: 'openspec' });
    const result = createSpecsChange(cwd, 'reuse-tree', {
      force: true,
      capabilities: ['auth'],
    });
    assert.equal(result.dir, 'openspec');
    assert.ok(
      fs.existsSync(path.join(cwd, 'openspec', 'changes', 'reuse-tree', 'specs', 'auth', 'spec.md')),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('archiveSpecsChange merges deltas then moves to dated archive', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    createSpecsChange(cwd, 'ship-it', { force: true, capabilities: ['auth'] });
    const archived = archiveSpecsChange(cwd, 'ship-it', { date: '2026-07-18' });
    assert.equal(archived.to, 'specs/changes/archive/2026-07-18-ship-it');
    assert.ok(!fs.existsSync(path.join(cwd, 'specs', 'changes', 'ship-it')));
    assert.ok(
      fs.existsSync(
        path.join(cwd, 'specs', 'changes', 'archive', '2026-07-18-ship-it', 'proposal.md'),
      ),
    );
    assert.ok(fs.existsSync(path.join(cwd, 'specs', 'specs', 'auth', 'spec.md')));
    assert.equal(archived.synced.length, 1);
    assert.equal(archived.synced[0].capability, 'auth');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('archiveSpecsChange --no-sync skips main catalog merge', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    createSpecsChange(cwd, 'no-merge', { force: true, capabilities: ['auth'] });
    const archived = archiveSpecsChange(cwd, 'no-merge', {
      date: '2026-07-18',
      noSync: true,
    });
    assert.deepEqual(archived.synced, []);
    assert.ok(!fs.existsSync(path.join(cwd, 'specs', 'specs', 'auth', 'spec.md')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runChange new prints next steps', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    const code = runChange(['new', 'demo-feat', '--cwd', cwd, '--capability', 'demo']);
    assert.equal(code, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
