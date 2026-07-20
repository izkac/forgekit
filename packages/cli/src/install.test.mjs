import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  installSkillsToAgents,
  reconcileInstall,
  installedManagedPairs,
  listInstallStatus,
  uninstallSkillsFromAgents,
  updateOutdatedSkills,
  readInstallStamp,
  resolveAdrInstallOptions,
  FORGEKIT_STAMP,
  SKILL_IDS,
  AGENT_IDS,
  AGENTS,
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

test('expanded environments resolve to their global skills dirs', () => {
  const home = '/home/u';
  assert.ok(AGENT_IDS.includes('copilot'));
  assert.ok(AGENT_IDS.includes('windsurf'));
  assert.equal(
    AGENTS.copilot.skillDir(home, 'forge'),
    path.join(home, '.copilot', 'skills', 'forge'),
  );
  assert.equal(
    AGENTS.windsurf.skillDir(home, 'forge'),
    path.join(home, '.codeium', 'windsurf', 'skills', 'forge'),
  );
  assert.equal(
    AGENTS.opencode.skillDir(home, 'forge'),
    path.join(home, '.config', 'opencode', 'skills', 'forge'),
  );
});

test('reconcileInstall prunes deselected pairs and remembers installs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recon-'));
  try {
    // Start: forge on cursor + claude.
    reconcileInstall(['forge'], ['cursor', 'claude'], { home, prune: true });
    let managed = installedManagedPairs(home);
    assert.equal(managed.length, 2);

    // Re-select: forge on cursor only → claude pair pruned.
    const { removed } = reconcileInstall(['forge'], ['cursor'], {
      home,
      prune: true,
    });
    assert.equal(removed.length, 1);
    assert.equal(removed[0].agent, 'claude');
    managed = installedManagedPairs(home);
    assert.deepEqual(
      managed.map((p) => `${p.skill}:${p.agent}`),
      ['forge:cursor'],
    );
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'forge')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reconcileInstall without prune is additive (no removals)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recon2-'));
  try {
    reconcileInstall(['forge'], ['cursor', 'claude'], { home, prune: true });
    const { removed } = reconcileInstall(['forge'], ['cursor'], { home });
    assert.equal(removed.length, 0);
    assert.equal(installedManagedPairs(home).length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveAdrInstallOptions: no ADR skill selected → disabled, no path prompt', async () => {
  const off = await resolveAdrInstallOptions({
    adr: null,
    adrDir: null,
    skills: ['forge'],
  });
  assert.equal(off.enabled, false);
  const on = await resolveAdrInstallOptions({
    adr: null,
    adrDir: 'docs/decisions',
    skills: ['forge', 'archive-to-adr'],
  });
  assert.equal(on.enabled, true);
  assert.equal(on.dir, 'docs/decisions');
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
