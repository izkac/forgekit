import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  installSkillsToAgents,
  listInstallStatus,
  uninstallSkillsFromAgents,
  updateOutdatedSkills,
  readInstallStamp,
  FORGEKIT_STAMP,
  SKILL_IDS,
  AGENT_IDS,
} from './install.mjs';

test('parseArgs supports multi skills and agents', () => {
  const opts = parseArgs([
    '--skills',
    'forge,thorough-code-review',
    '--agents',
    'cursor,claude',
    '--force',
  ]);
  assert.deepEqual(opts.skills, ['forge', 'thorough-code-review']);
  assert.deepEqual(opts.agents, ['cursor', 'claude']);
  assert.equal(opts.force, true);
});

test('parseArgs accepts --skill singular and shorthand agents', () => {
  const opts = parseArgs(['--skill', 'forge', '--cursor', '--codex']);
  assert.deepEqual(opts.skills, ['forge']);
  assert.deepEqual(opts.agents, ['cursor', 'codex']);
});

test('parseArgs --all-skills / --all-agents / --update / --uninstall', () => {
  const opts = parseArgs(['--all-skills', '--all-agents', '--update']);
  assert.equal(opts.allSkills, true);
  assert.equal(opts.allAgents, true);
  assert.equal(opts.update, true);
  assert.equal(parseArgs(['--uninstall']).uninstall, true);
});

test('installSkillsToAgents installs and stamps .forgekit.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-install-'));
  try {
    const results = installSkillsToAgents(['forge'], ['cursor', 'claude'], {
      home,
      force: true,
    });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'installed'));
    const dest = path.join(home, '.cursor', 'skills', 'forge');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dest, FORGEKIT_STAMP)));
    const stamp = readInstallStamp(dest);
    assert.equal(stamp.skill, 'forge');
    assert.ok(stamp.contentHash);
    assert.ok(stamp.version);

    const again = installSkillsToAgents(['forge'], ['cursor'], { home });
    assert.equal(again[0].status, 'exists');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('listInstallStatus covers every skill×agent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-list-'));
  try {
    const rows = listInstallStatus({ home });
    assert.equal(rows.length, SKILL_IDS.length * AGENT_IDS.length);
    assert.ok(rows.every((r) => r.status === 'missing'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstallSkillsFromAgents removes installed dirs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-uninst-'));
  try {
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    const results = uninstallSkillsFromAgents(['forge'], ['cursor'], { home });
    assert.equal(results[0].status, 'removed');
    assert.ok(!fs.existsSync(path.join(home, '.cursor', 'skills', 'forge')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updateOutdatedSkills refreshes unversioned installs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-upd-'));
  try {
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    const dest = path.join(home, '.cursor', 'skills', 'forge');
    fs.unlinkSync(path.join(dest, FORGEKIT_STAMP));
    const { results } = updateOutdatedSkills({ home });
    assert.ok(results.some((r) => r.skill === 'forge' && r.status === 'installed'));
    assert.ok(fs.existsSync(path.join(dest, FORGEKIT_STAMP)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
