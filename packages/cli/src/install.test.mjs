import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  defaultAgentSelection,
  installSkillsToAgents,
  reconcileInstall,
  installedManagedPairs,
  listInstallStatus,
  uninstallSkillsFromAgents,
  updateOutdatedSkills,
  readInstallStamp,
  adrConfigPatch,
  resolveAdrInstallOptions,
  runInstall,
  FORGEKIT_STAMP,
  SKILL_IDS,
  AGENT_IDS,
  AGENTS,
  versionIsNewer,
  runningFromMonorepo,
} from './install.mjs';
import * as installApi from './install.mjs';
import { loadUserConfig, saveUserConfig } from './config.mjs';

function assertVendorLink(home, agentId, skillId = 'forge') {
  const dest = AGENTS[agentId].skillDir(home, skillId);
  const linkFn = AGENTS[agentId].vendorLink;
  assert.ok(linkFn, `${agentId} should have a vendorLink`);
  const link = linkFn(home, skillId);
  const st = fs.lstatSync(link);
  assert.ok(st.isSymbolicLink(), `${agentId} vendor path should be a symlink`);
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')));
  const resolved = path.resolve(path.dirname(link), fs.readlinkSync(link));
  assert.equal(path.normalize(resolved), path.normalize(path.resolve(dest)));
}

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

test('AGENTS has no selectable agents key; every harness shares ~/.agents/skills', () => {
  assert.equal(AGENTS.agents, undefined);
  assert.ok(!AGENT_IDS.includes('agents'));
  const home = '/home/u';
  const shared = path.join(home, '.agents', 'skills', 'forge');
  for (const id of AGENT_IDS) {
    assert.equal(AGENTS[id].skillDir(home, 'forge'), shared);
  }
  assert.equal(
    AGENTS.claude.vendorLink(home, 'forge'),
    path.join(home, '.claude', 'skills', 'forge'),
  );
  assert.equal(
    AGENTS.windsurf.vendorLink(home, 'forge'),
    path.join(home, '.codeium', 'windsurf', 'skills', 'forge'),
  );
  assert.equal(AGENTS.cursor.vendorLink, undefined);
});

test('AGENTS_SHARING_AGENTS_ROOT is the five native .agents ids, frozen', () => {
  assert.ok(installApi.AGENTS_SHARING_AGENTS_ROOT);
  assert.deepEqual([...installApi.AGENTS_SHARING_AGENTS_ROOT], [
    'cursor',
    'codex',
    'copilot',
    'gemini',
    'opencode',
  ]);
  assert.ok(Object.isFrozen(installApi.AGENTS_SHARING_AGENTS_ROOT));
});

test('AGENTS_WITH_VENDOR_LINK is claude and windsurf', () => {
  assert.deepEqual([...installApi.AGENTS_WITH_VENDOR_LINK], ['claude', 'windsurf']);
});

test('parseArgs --shared throws naming --cursor and --codex', () => {
  assert.throws(() => parseArgs(['--shared']), (err) => {
    assert.match(String(err.message), /--cursor/);
    assert.match(String(err.message), /--codex/);
    return true;
  });
});

test('parseArgs --shared throws even when combined with other shorthands', () => {
  assert.throws(() => parseArgs(['--claude', '--shared']), /--cursor/);
});

test('installSkillsToAgents rejects the retired agents id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-unknown-agent-'));
  try {
    assert.throws(
      () => installSkillsToAgents(['forge'], ['agents'], { home }),
      /Unknown agent: agents/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('defaultAgentSelection pre-checks .agents-capable harnesses on first run, not claude', () => {
  const selected = defaultAgentSelection([]);
  assert.deepEqual(selected, [...installApi.AGENTS_SHARING_AGENTS_ROOT]);
  assert.ok(!selected.includes('claude'));
});

test('defaultAgentSelection unions installed agents and dedupes', () => {
  const sharing = [...installApi.AGENTS_SHARING_AGENTS_ROOT];
  assert.deepEqual(defaultAgentSelection(['claude']), [...sharing, 'claude']);
  assert.deepEqual(
    defaultAgentSelection(['codex', 'claude', 'codex']),
    [...sharing, 'claude'],
  );
  assert.deepEqual(defaultAgentSelection(['cursor']), sharing);
  assert.deepEqual(defaultAgentSelection(['windsurf']), [...sharing, 'windsurf']);
});

test('parseArgs --all-skills / --all-agents / --update / --uninstall / --no-pkg', () => {
  const opts = parseArgs(['--all-skills', '--all-agents', '--update']);
  assert.equal(opts.allSkills, true);
  assert.equal(opts.allAgents, true);
  assert.equal(opts.update, true);
  assert.equal(parseArgs(['--uninstall']).uninstall, true);
  assert.equal(parseArgs(['--update', '--no-pkg']).noPkg, true);
});

test('installSkillsToAgents installs and stamps .forgekit.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-install-'));
  try {
    const results = installSkillsToAgents(['forge'], ['cursor', 'claude'], {
      home,
      force: true,
    });
    assert.equal(results.length, 1);
    assert.ok(results.every((r) => r.status === 'installed'));
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dest, FORGEKIT_STAMP)));
    assert.ok(!fs.existsSync(path.join(home, '.cursor', 'skills', 'forge')));
    assertVendorLink(home, 'claude');
    const stamp = readInstallStamp(dest);
    assert.equal(stamp.skill, 'forge');
    assert.ok(stamp.contentHash);
    assert.ok(stamp.version);
    assert.ok(stamp.agents.includes('cursor'));
    assert.ok(stamp.agents.includes('claude'));

    const again = installSkillsToAgents(['forge'], ['cursor'], { home });
    assert.equal(again[0].status, 'exists');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('listInstallStatus reports unique dests with the agent ids that map there', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-list-'));
  try {
    const rows = listInstallStatus({ home });
    assert.equal(rows.length, SKILL_IDS.length, 'one row per skill (shared dest)');
    assert.equal(
      new Set(rows.map((r) => `${r.skill}\0${r.dest}`)).size,
      rows.length,
      'no duplicate dest lines',
    );
    assert.ok(rows.every((r) => r.status === 'missing'));
    assert.ok(rows.every((r) => Array.isArray(r.agents) && r.agents.length > 0));

    const sharedDest = path.join(home, '.agents', 'skills', 'forge');
    const shared = rows.find((r) => r.skill === 'forge' && r.dest === sharedDest);
    assert.ok(shared, 'shared .agents dest is listed once');
    assert.deepEqual(shared.agents.sort(), [...AGENT_IDS].sort());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install --help --list line does not say skill×agent pairs', async () => {
  let text = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    text += String(chunk);
    return true;
  };
  try {
    const code = await runInstall(['--help']);
    assert.equal(code, 0);
    const listLine = text.split('\n').find((line) => /^\s*--list\b/.test(line));
    assert.ok(listLine, '--list is still documented');
    assert.doesNotMatch(listLine, /skill×agent pairs/);
  } finally {
    process.stdout.write = origWrite;
  }
});

test('forgekit --help names ~/.agents/skills and unique dests', () => {
  const bin = fileURLToPath(new URL('../bin/forgekit.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /~\/\.agents\/skills/);
  assert.doesNotMatch(result.stdout, /~\/\.cursor\|claude\|codex\/skills/);
  assert.doesNotMatch(result.stdout, /skill × agent/);
});

test('uninstallSkillsFromAgents removes installed dirs and the vendor symlink', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-uninst-'));
  try {
    installSkillsToAgents(['forge'], ['claude'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    const results = uninstallSkillsFromAgents(['forge'], ['claude'], { home });
    assert.equal(results[0].status, 'removed');
    assert.ok(!fs.existsSync(dest));
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'forge')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('expanded environments resolve to the shared ~/.agents dest; claude/windsurf have vendorLink', () => {
  const home = '/home/u';
  assert.ok(AGENT_IDS.includes('copilot'));
  assert.ok(AGENT_IDS.includes('windsurf'));
  const shared = path.join(home, '.agents', 'skills', 'forge');
  assert.equal(AGENTS.copilot.skillDir(home, 'forge'), shared);
  assert.equal(AGENTS.windsurf.skillDir(home, 'forge'), shared);
  assert.equal(AGENTS.opencode.skillDir(home, 'forge'), shared);
  assert.equal(
    AGENTS.windsurf.vendorLink(home, 'forge'),
    path.join(home, '.codeium', 'windsurf', 'skills', 'forge'),
  );
});

test('reconcileInstall prunes deselected linked harness and keeps shared dest', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recon-'));
  try {
    reconcileInstall(['forge'], ['claude', 'windsurf'], { home, prune: true });
    let managed = installedManagedPairs(home);
    assert.equal(managed.length, 2);
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.ok(fs.existsSync(dest));
    assertVendorLink(home, 'claude');
    assertVendorLink(home, 'windsurf');

    const { removed } = reconcileInstall(['forge'], ['claude'], {
      home,
      prune: true,
    });
    assert.ok(removed.some((r) => r.agent === 'windsurf'));
    managed = installedManagedPairs(home);
    assert.deepEqual(
      managed.map((p) => `${p.skill}:${p.agent}`),
      ['forge:claude'],
    );
    assert.ok(fs.existsSync(dest), 'claude still owns the shared dest');
    assertVendorLink(home, 'claude');
    assert.ok(
      !fs.existsSync(path.join(home, '.codeium', 'windsurf', 'skills', 'forge')),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reconcileInstall without prune is additive (no removals)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recon2-'));
  try {
    reconcileInstall(['forge'], ['claude', 'windsurf'], { home, prune: true });
    const { removed } = reconcileInstall(['forge'], ['claude'], { home });
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

test('cursor install lands on ~/.agents/skills and does not create ~/.cursor/skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-agents-'));
  try {
    const results = installSkillsToAgents(['forge'], ['cursor'], { home });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'installed');
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.equal(results[0].dest, dest);
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dest, FORGEKIT_STAMP)));
    assert.ok(!fs.existsSync(path.join(home, '.cursor', 'skills', 'forge')));
    const row = listInstallStatus({ home }).find(
      (r) => r.skill === 'forge' && r.dest === dest,
    );
    assert.ok(row);
    assert.ok(Array.isArray(row.agents), 'row lists harness aliases for the dest');
    assert.ok(row.agents.includes('cursor'));
    assert.equal(row.status, 'present');
    assert.equal(row.dest, dest);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cursor and codex install once to ~/.agents/skills/forge, not vendor dirs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-shareddest-'));
  try {
    installSkillsToAgents(['forge'], ['cursor', 'codex'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(home, '.cursor', 'skills', 'forge')));
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', 'forge')));
    assert.deepEqual(fs.readdirSync(path.join(home, '.agents', 'skills')), ['forge']);
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

test('updateOutdatedSkills refreshes stamped outdated installs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-upd-'));
  try {
    installSkillsToAgents(['forge'], ['claude'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    const stamp = readInstallStamp(dest);
    stamp.contentHash = 'stale';
    fs.writeFileSync(
      path.join(dest, FORGEKIT_STAMP),
      `${JSON.stringify(stamp, null, 2)}\n`,
      'utf8',
    );
    const { results } = updateOutdatedSkills({ home });
    assert.ok(results.some((r) => r.skill === 'forge' && r.status === 'installed'));
    assert.notEqual(readInstallStamp(dest).contentHash, 'stale');
    assertVendorLink(home, 'claude');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updateOutdatedSkills does not add unrecorded linked harnesses', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-upd-no-windsurf-'));
  try {
    installSkillsToAgents(['forge'], ['cursor', 'claude'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    const stamp = readInstallStamp(dest);
    stamp.contentHash = 'stale';
    fs.writeFileSync(
      path.join(dest, FORGEKIT_STAMP),
      `${JSON.stringify(stamp, null, 2)}\n`,
      'utf8',
    );
    updateOutdatedSkills({ home });
    assert.deepEqual(readInstallStamp(dest).agents.sort(), ['claude', 'cursor']);
    assert.ok(
      !fs.existsSync(path.join(home, '.codeium', 'windsurf', 'skills', 'forge')),
      'windsurf was never recorded, so no vendor link',
    );
    assertVendorLink(home, 'claude');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installSkillsToAgents copies a shared dest once (cursor+codex force)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-dedupe-'));
  try {
    const results = installSkillsToAgents(['forge'], ['cursor', 'codex'], {
      home,
      force: true,
    });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.equal(
      results.filter((r) => r.status === 'installed').length,
      1,
      'one filesystem write per dest',
    );
    assert.equal(new Set(results.map((r) => r.dest)).size, 1);
    assert.equal(results[0].dest, dest);

    fs.writeFileSync(path.join(dest, 'MARKER'), 'keep', 'utf8');
    installSkillsToAgents(['forge'], ['cursor', 'codex'], { home });
    assert.equal(
      fs.readFileSync(path.join(dest, 'MARKER'), 'utf8'),
      'keep',
      'second pass without --force must not recopy the shared dest',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall cursor keeps shared dest while other aliases still map there', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-uninst-keep-'));
  try {
    installSkillsToAgents(['forge'], ['cursor', 'codex'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    const results = uninstallSkillsFromAgents(['forge'], ['cursor'], { home });
    assert.ok(fs.existsSync(dest), 'codex still maps to this dest');
    assert.ok(results.every((r) => r.status !== 'removed'));
    assert.deepEqual(readInstallStamp(dest).agents, ['codex']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall cursor removes shared dest when it was the only recorded owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-uninst-solo-'));
  try {
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    const results = uninstallSkillsFromAgents(['forge'], ['cursor'], { home });
    assert.ok(results.some((r) => r.status === 'removed' && r.dest === dest));
    assert.ok(!fs.existsSync(dest));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install without --force still records a second alias on the shared dest', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-uninst-merge-'));
  try {
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    installSkillsToAgents(['forge'], ['codex'], { home });
    assert.deepEqual(readInstallStamp(dest).agents.sort(), ['codex', 'cursor']);
    uninstallSkillsFromAgents(['forge'], ['cursor'], { home });
    assert.ok(fs.existsSync(dest));
    assert.deepEqual(readInstallStamp(dest).agents, ['codex']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall of native .agents aliases keeps dest while claude remains', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-uninst-all-'));
  try {
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    installSkillsToAgents(['forge'], ['claude'], { home, force: true });

    const results = uninstallSkillsFromAgents(
      ['forge'],
      [...installApi.AGENTS_SHARING_AGENTS_ROOT],
      { home },
    );
    assert.ok(results.some((r) => r.status === 'kept' && r.dest === dest));
    assert.ok(fs.existsSync(dest), 'claude still owns the dest');
    assertVendorLink(home, 'claude');
    assert.deepEqual(readInstallStamp(dest).agents, ['claude']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reconcileInstall prune keeps dest if another desired harness maps there', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recon-share-'));
  try {
    reconcileInstall(['forge'], ['cursor', 'codex'], { home, prune: true });
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.ok(fs.existsSync(dest));

    const { removed } = reconcileInstall(['forge'], ['cursor'], {
      home,
      prune: true,
    });
    assert.ok(fs.existsSync(dest), 'cursor still desired for this dest');
    assert.deepEqual(readInstallStamp(dest).agents, ['cursor']);
    assert.ok(!removed.some((r) => r.status === 'removed' && r.dest === dest));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stamped vendor leftover is retired when installing to ~/.agents/skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-stamp-'));
  try {
    const vendor = path.join(home, '.cursor', 'skills', 'forge');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(vendor, 'SKILL.md'), 'old vendor copy\n', 'utf8');
    fs.writeFileSync(
      path.join(vendor, FORGEKIT_STAMP),
      `${JSON.stringify({ skill: 'forge', contentHash: 'stale' })}\n`,
      'utf8',
    );

    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });

    assert.ok(!fs.existsSync(vendor), 'stamped leftover retired');
    assert.ok(
      fs.existsSync(path.join(home, '.agents', 'skills', 'forge', FORGEKIT_STAMP)),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unstamped vendor leftover survives an install to ~/.agents/skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-keep-'));
  try {
    const vendor = path.join(home, '.cursor', 'skills', 'forge');
    fs.mkdirSync(vendor, { recursive: true });
    const body = 'hand-written vendor skill\n';
    fs.writeFileSync(path.join(vendor, 'SKILL.md'), body, 'utf8');

    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });

    assert.equal(fs.readFileSync(path.join(vendor, 'SKILL.md'), 'utf8'), body);
    assert.ok(!fs.existsSync(path.join(vendor, FORGEKIT_STAMP)));
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'forge', 'SKILL.md')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cursor install does not create a Claude vendor path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-no-claude-link-'));
  try {
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'forge')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stamped Claude vendor copy is replaced with a symlink on install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-claude-migrate-'));
  try {
    const vendor = path.join(home, '.claude', 'skills', 'forge');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(vendor, 'SKILL.md'), 'old claude copy\n', 'utf8');
    fs.writeFileSync(
      path.join(vendor, FORGEKIT_STAMP),
      `${JSON.stringify({ skill: 'forge', contentHash: 'stale', agents: ['claude'] })}\n`,
      'utf8',
    );

    installSkillsToAgents(['forge'], ['claude'], { home, force: true });

    assertVendorLink(home, 'claude');
    const dest = path.join(home, '.agents', 'skills', 'forge');
    assert.ok(readInstallStamp(dest).agents.includes('claude'));
    assert.notEqual(
      fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'),
      'old claude copy\n',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unstamped Claude vendor directory is not replaced by a symlink', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-claude-foreign-'));
  try {
    const vendor = path.join(home, '.claude', 'skills', 'forge');
    fs.mkdirSync(vendor, { recursive: true });
    const body = 'hand-written claude skill\n';
    fs.writeFileSync(path.join(vendor, 'SKILL.md'), body, 'utf8');

    installSkillsToAgents(['forge'], ['claude'], { home, force: true });

    assert.equal(fs.readFileSync(path.join(vendor, 'SKILL.md'), 'utf8'), body);
    assert.ok(!fs.lstatSync(vendor).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'forge', 'SKILL.md')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updateOutdatedSkills migrates a stamped Claude vendor copy to a symlink', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-upd-migrate-'));
  try {
    const dest = path.join(home, '.agents', 'skills', 'forge');
    installSkillsToAgents(['forge'], ['cursor'], { home, force: true });
    const vendor = path.join(home, '.claude', 'skills', 'forge');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(vendor, 'SKILL.md'), 'stale vendor\n', 'utf8');
    fs.writeFileSync(
      path.join(vendor, FORGEKIT_STAMP),
      `${JSON.stringify({ skill: 'forge', contentHash: 'stale' })}\n`,
      'utf8',
    );

    const { results } = updateOutdatedSkills({ home });
    assert.ok(results.length > 0);
    assertVendorLink(home, 'claude');
    assert.ok(readInstallStamp(dest).agents.includes('claude'));
    assert.ok(readInstallStamp(dest).agents.includes('cursor'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('versionIsNewer compares dotted versions', () => {
  assert.equal(versionIsNewer('0.3.53', '0.3.52'), true);
  assert.equal(versionIsNewer('0.3.52', '0.3.52'), false);
  assert.equal(versionIsNewer('0.3.51', '0.3.52'), false);
  assert.equal(versionIsNewer('1.0.0', '0.9.9'), true);
});

test('runningFromMonorepo is true in this checkout', () => {
  assert.equal(runningFromMonorepo(), true);
});
