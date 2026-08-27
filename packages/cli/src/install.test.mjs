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
  adrConfigPatch,
  resolveAdrInstallOptions,
  FORGEKIT_STAMP,
  SKILL_IDS,
  AGENT_IDS,
  AGENTS,
} from './install.mjs';
import { loadUserConfig, saveUserConfig } from './config.mjs';

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

test('resolveAdrInstallOptions: saying nothing is not saying no', async () => {
  // `forgekit install --skills forge` expresses no ADR preference. Collapsing
  // that to `false` and persisting it overwrote a user's stored `enabled: true`
  // and announced "ADR preference saved: disabled" — from a command whose whole
  // job was refreshing one skill. inferAdrFromSkills is tri-state precisely so
  // "unknown" survives; it was being flattened one line later.
  const unstated = await resolveAdrInstallOptions({
    adr: null,
    adrDir: null,
    skills: ['forge'],
  });
  assert.equal(unstated.enabled, null, 'no signal must stay null, not become false');

  const off = await resolveAdrInstallOptions({
    adr: false,
    adrDir: null,
    skills: ['forge'],
  });
  assert.equal(off.enabled, false, '--no-adr is a real preference');
  const on = await resolveAdrInstallOptions({
    adr: null,
    adrDir: 'docs/decisions',
    skills: ['forge', 'archive-to-adr'],
  });
  assert.equal(on.enabled, true);
  assert.equal(on.dir, 'docs/decisions');
});

test('a run that states no ADR preference leaves the stored one alone', () => {
  // The `agents` key in the same saveUserConfig call already works this way —
  // "narrow flag runs don't clobber it". The `adr` key did not.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-adrpref-'));
  try {
    saveUserConfig({ adr: { enabled: true, dir: 'docs/adr' } }, home);

    saveUserConfig(adrConfigPatch(null, 'docs/adr'), home);
    assert.equal(loadUserConfig(home).adr.enabled, true, 'silence must not disable');

    saveUserConfig(adrConfigPatch(false, 'docs/adr'), home);
    assert.equal(loadUserConfig(home).adr.enabled, false, 'an explicit --no-adr still lands');

    saveUserConfig(adrConfigPatch(true, 'docs/decisions'), home);
    assert.deepEqual(loadUserConfig(home).adr, { enabled: true, dir: 'docs/decisions' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('agents environment installs to ~/.agents/skills with stamp', () => {
  assert.ok(AGENT_IDS.includes('agents'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-agents-'));
  try {
    const results = installSkillsToAgents(['forge'], ['agents'], { home });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'installed');
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dest, FORGEKIT_STAMP)));
    const row = listInstallStatus({ home }).find(
      (r) => r.skill === 'forge' && r.agent === 'agents',
    );
    assert.equal(row.status, 'present');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updateOutdatedSkills never clobbers a foreign unstamped skill under ~/.agents', () => {
  // ~/.agents/skills/ is a shared root: an unstamped dir at a managed path
  // there belongs to another tool or a human, not forgekit. The stamp is the
  // ownership marker — update must leave the foreign copy byte-identical.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-foreign-'));
  try {
    const dest = path.join(home, '.agents', 'skills', 'forge');
    fs.mkdirSync(dest, { recursive: true });
    const foreignBody = "# someone else's forge skill\n";
    fs.writeFileSync(path.join(dest, 'SKILL.md'), foreignBody, 'utf8');

    const { results } = updateOutdatedSkills({ home });

    assert.equal(
      fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'),
      foreignBody,
      'foreign unstamped copy left byte-identical',
    );
    assert.ok(
      !fs.existsSync(path.join(dest, FORGEKIT_STAMP)),
      'no ownership stamp planted on a foreign dir',
    );
    assert.ok(
      !results.some((r) => r.agent === 'agents'),
      'no install targeted the agents environment',
    );
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
