import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertChangeName,
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

test('parseArgs new and archive', () => {
  assert.deepEqual(parseArgs(['new', 'foo', '--force']).action, 'new');
  assert.equal(parseArgs(['new', 'foo']).name, 'foo');
  assert.equal(parseArgs(['archive', 'foo', '--date', '2026-01-02']).date, '2026-01-02');
});

test('createSpecsChange writes proposal and tasks', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    const result = createSpecsChange(cwd, 'add-refunds', { force: true });
    assert.ok(fs.existsSync(path.join(result.changeDir, 'proposal.md')));
    assert.ok(fs.existsSync(path.join(result.changeDir, 'tasks.md')));
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

test('archiveSpecsChange moves to dated archive', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    createSpecsChange(cwd, 'ship-it', { force: true });
    const archived = archiveSpecsChange(cwd, 'ship-it', { date: '2026-07-18' });
    assert.equal(archived.to, 'specs/changes/archive/2026-07-18-ship-it');
    assert.ok(!fs.existsSync(path.join(cwd, 'specs', 'changes', 'ship-it')));
    assert.ok(
      fs.existsSync(
        path.join(cwd, 'specs', 'changes', 'archive', '2026-07-18-ship-it', 'proposal.md'),
      ),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runChange new prints next steps', () => {
  const cwd = tmp();
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    scaffoldSpecs(cwd);
    const code = runChange(['new', 'demo-feat', '--cwd', cwd]);
    assert.equal(code, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
