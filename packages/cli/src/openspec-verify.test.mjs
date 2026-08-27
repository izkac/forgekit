import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkOpenSpecVerifyArtifact,
  findOpenSpecVerifySkill,
  remainingFindingsCleared,
  sessionNeedsOpenSpecVerify,
} from './openspec-verify.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

test('findOpenSpecVerifySkill: cursor skill path wins when present', () => {
  const cwd = tmp('osv-skill-');
  try {
    const rel = path.join('.cursor', 'skills', 'openspec-verify-change', 'SKILL.md');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), 'skill\n');
    assert.equal(findOpenSpecVerifySkill(cwd), '.cursor/skills/openspec-verify-change/SKILL.md');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('findOpenSpecVerifySkill: claude nested /opsx:verify command counts', () => {
  const cwd = tmp('osv-opsx-');
  try {
    const rel = path.join('.claude', 'commands', 'opsx', 'verify.md');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), 'cmd\n');
    assert.equal(findOpenSpecVerifySkill(cwd), '.claude/commands/opsx/verify.md');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('findOpenSpecVerifySkill: missing is null', () => {
  const cwd = tmp('osv-none-');
  try {
    assert.equal(findOpenSpecVerifySkill(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sessionNeedsOpenSpecVerify: only planType openspec', () => {
  assert.equal(sessionNeedsOpenSpecVerify({ planType: 'openspec' }), true);
  assert.equal(sessionNeedsOpenSpecVerify({ planType: 'specs' }), false);
  assert.equal(sessionNeedsOpenSpecVerify({ planType: null }), false);
  assert.equal(sessionNeedsOpenSpecVerify({}), false);
});

test('remainingFindingsCleared: only an explicit Remaining: none line', () => {
  assert.equal(remainingFindingsCleared('## Forge disposition\n\n- Remaining: none\n'), true);
  assert.equal(remainingFindingsCleared('Remaining: none\n'), true);
  assert.equal(remainingFindingsCleared('1. Remaining: none\n'), true);
  assert.equal(remainingFindingsCleared('Remaining: None\n'), true);
  assert.equal(
    remainingFindingsCleared('No critical issues. Ready for archive (with noted improvements).\n'),
    false,
  );
  assert.equal(remainingFindingsCleared('Remaining: none of the tests\n'), false);
  assert.equal(remainingFindingsCleared('Remaining: 2 suggestions\n'), false);
  assert.equal(remainingFindingsCleared(''), false);
});

test('checkOpenSpecVerifyArtifact: specs-engine skips even with the skill present', () => {
  const cwd = tmp('osv-specs-');
  try {
    const rel = path.join('.cursor', 'commands', 'opsx-verify.md');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), 'cmd\n');
    const result = checkOpenSpecVerifyArtifact({
      cwd,
      sessionDir: path.join(cwd, 'sess'),
      session: { planType: 'specs' },
    });
    assert.equal(result.required, false);
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkOpenSpecVerifyArtifact: openspec without skill is not required', () => {
  const cwd = tmp('osv-noskill-');
  try {
    const result = checkOpenSpecVerifyArtifact({
      cwd,
      sessionDir: path.join(cwd, 'sess'),
      session: { planType: 'openspec' },
    });
    assert.equal(result.required, false);
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkOpenSpecVerifyArtifact: required but missing report', () => {
  const cwd = tmp('osv-miss-');
  try {
    const rel = path.join('.cursor', 'skills', 'openspec-verify-change', 'SKILL.md');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), 'skill\n');
    const sessionDir = path.join(cwd, 'sess');
    fs.mkdirSync(sessionDir);
    const result = checkOpenSpecVerifyArtifact({
      cwd,
      sessionDir,
      session: { planType: 'openspec' },
    });
    assert.equal(result.required, true);
    assert.equal(result.ok, false);
    assert.match(result.problem, /missing openspec-verify\.md/);
    assert.match(result.problem, /tasks\.md/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkOpenSpecVerifyArtifact: vendor ready-for-archive is not enough', () => {
  const cwd = tmp('osv-vendor-');
  try {
    const rel = path.join('.cursor', 'commands', 'openspec-verify-change.md');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), 'cmd\n');
    const sessionDir = path.join(cwd, 'sess');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(
      path.join(sessionDir, 'openspec-verify.md'),
      'No critical issues. Y warning(s) to consider. Ready for archive (with noted improvements).\n',
    );
    const result = checkOpenSpecVerifyArtifact({
      cwd,
      sessionDir,
      session: { planType: 'openspec' },
    });
    assert.equal(result.ok, false);
    assert.match(result.problem, /leftover findings/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkOpenSpecVerifyArtifact: Remaining: none passes', () => {
  const cwd = tmp('osv-ok-');
  try {
    const rel = path.join('.agents', 'skills', 'openspec-verify-change', 'SKILL.md');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), 'skill\n');
    const sessionDir = path.join(cwd, 'sess');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(
      path.join(sessionDir, 'openspec-verify.md'),
      '# Verification Report\n\n## Forge disposition\n\n- Fixed: leftover HMAC in ops script\n- Skipped: Dockerfile apk vs spec wording — design decision 6\n- Remaining: none\n',
    );
    const result = checkOpenSpecVerifyArtifact({
      cwd,
      sessionDir,
      session: { planType: 'openspec' },
    });
    assert.equal(result.required, true);
    assert.equal(result.ok, true);
    assert.equal(result.problem, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
