import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Scratch forge layout under `dir`: active.json + a session with session.json.
 * set-phase.mjs resolves `.forge` from cwd, so tests run it as a child
 * process with cwd set here.
 *
 * @param {string} dir
 * @param {string} sessionId
 * @returns {string} the session.json path
 */
function makeForgeFixture(dir, sessionId) {
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const sessionFile = path.join(sessionDir, 'session.json');
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify(
      {
        id: sessionId,
        slug: 'fixture',
        createdAt: now,
        updatedAt: now,
        phase: 'plan',
        planType: null,
        openspecChange: null,
        forgeSkipped: false,
        cursorChatId: null,
        tasksTotal: 0,
        tasksComplete: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    'utf8',
  );
  return sessionFile;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function runSetPhase(cwd, args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('--subagents stores subagentsDispatched on the session', () => {
  const dir = tmp('forge-set-phase-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-a');
    const stdout = runSetPhase(dir, ['implement', '--subagents', '3']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'implement');
    assert.equal(session.subagentsDispatched, 3);
    assert.equal(JSON.parse(stdout).session.subagentsDispatched, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--subagents is absolute — a later value replaces the earlier one', () => {
  const dir = tmp('forge-set-phase-abs-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-a');
    runSetPhase(dir, ['implement', '--subagents', '2']);
    runSetPhase(dir, ['implement', '--subagents', '5']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.subagentsDispatched, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omitting --subagents leaves subagentsDispatched untouched', () => {
  const dir = tmp('forge-set-phase-omit-');
  try {
    const sessionFile = makeForgeFixture(dir, 'sess-a');
    runSetPhase(dir, ['implement', '--subagents', '4']);
    runSetPhase(dir, ['verify', '--tasks-complete', '4']);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.phase, 'verify');
    assert.equal(session.tasksComplete, 4);
    assert.equal(session.subagentsDispatched, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
