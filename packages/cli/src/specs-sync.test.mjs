import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDeltaToMain,
  deltaSpecTemplate,
  listDeltaCapabilities,
  mergeChangeDeltas,
  parseDeltaSections,
  splitRequirements,
} from './specs-sync.mjs';

test('parseDeltaSections extracts ADDED/MODIFIED/REMOVED', () => {
  const body = `# Delta for Auth

## ADDED Requirements

### Requirement: Two-Factor
The system MUST require 2FA.

## MODIFIED Requirements

### Requirement: Session Timeout
The system SHALL expire after 30m.

## REMOVED Requirements

### Requirement: Remember Me
`;
  const parsed = parseDeltaSections(body);
  assert.match(parsed.preamble, /Delta for Auth/);
  assert.match(parsed.added, /Two-Factor/);
  assert.match(parsed.modified, /Session Timeout/);
  assert.match(parsed.removed, /Remember Me/);
});

test('splitRequirements parses ### Requirement blocks', () => {
  const blocks = splitRequirements(`### Requirement: A
Body A

### Requirement: B
Body B
`);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, 'A');
  assert.match(blocks[1].block, /### Requirement: B/);
});

test('applyDeltaToMain merges ADDED into empty main', () => {
  const delta = deltaSpecTemplate('auth');
  const main = applyDeltaToMain('auth', '', delta);
  assert.match(main, /# Auth Spec/);
  assert.match(main, /## Requirements/);
  assert.match(main, /### Requirement: Auth behavior/);
});

test('applyDeltaToMain MODIFIED replaces and REMOVED deletes', () => {
  const existing = `# Auth Spec

## Purpose

Auth.

## Requirements

### Requirement: Login
Old login.

### Requirement: Logout
Keep me.
`;
  const delta = `# Delta

## MODIFIED Requirements

### Requirement: Login
New login.

## REMOVED Requirements

### Requirement: Logout
`;
  const main = applyDeltaToMain('auth', existing, delta);
  assert.match(main, /New login/);
  assert.doesNotMatch(main, /Old login/);
  assert.doesNotMatch(main, /### Requirement: Logout/);
});

test('mergeChangeDeltas writes main catalog from change deltas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-sync-'));
  try {
    const changeDir = path.join(root, 'changes', 'add-auth');
    const mainSpecs = path.join(root, 'specs');
    fs.mkdirSync(path.join(changeDir, 'specs', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir, 'specs', 'auth', 'spec.md'),
      deltaSpecTemplate('auth'),
      'utf8',
    );
    assert.deepEqual(listDeltaCapabilities(changeDir), ['auth']);
    const results = mergeChangeDeltas(changeDir, mainSpecs);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'created');
    assert.ok(fs.existsSync(path.join(mainSpecs, 'auth', 'spec.md')));
    assert.match(
      fs.readFileSync(path.join(mainSpecs, 'auth', 'spec.md'), 'utf8'),
      /Auth behavior/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
