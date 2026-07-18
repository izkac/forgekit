import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADR_SKILLS,
  DEFAULT_ADR_DIR,
  decisionsDocFor,
  decisionsRelFromAdrReadme,
  disableProjectAdr,
  loadProjectConfig,
  loadUserConfig,
  normalizeAdrDir,
  resolveProjectAdr,
  saveUserConfig,
  scaffoldAdr,
} from './adr.mjs';
import {
  applyAdrSkills,
  inferAdrFromSkills,
  parseArgs,
  installSkillsToAgents,
  SKILL_IDS,
} from './install.mjs';
import { initProject, parseArgs as parseInitArgs } from './init.mjs';

test('normalizeAdrDir defaults and rejects escapes', () => {
  assert.equal(normalizeAdrDir(''), DEFAULT_ADR_DIR);
  assert.equal(normalizeAdrDir('docs/adr'), 'docs/adr');
  assert.equal(normalizeAdrDir('docs\\architecture\\adr\\'), 'docs/architecture/adr');
  assert.throws(() => normalizeAdrDir('../outside'), /relative path/);
  assert.throws(() => normalizeAdrDir('/abs'), /relative path/);
});

test('decisionsDocFor derives sibling decisions.md', () => {
  assert.equal(decisionsDocFor('docs/adr'), 'docs/decisions.md');
  assert.equal(decisionsDocFor('architecture/decisions'), 'architecture/decisions.md');
});

test('decisionsRelFromAdrReadme', () => {
  assert.equal(decisionsRelFromAdrReadme('docs/adr', 'docs/decisions.md'), '../decisions.md');
});

test('user config round-trip', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-adr-user-'));
  try {
    saveUserConfig({ adr: { enabled: true, dir: 'arch/adr' } }, home);
    const loaded = loadUserConfig(home);
    assert.equal(loaded.adr.enabled, true);
    assert.equal(loaded.adr.dir, 'arch/adr');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scaffoldAdr writes decisions, index, config, hooks', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-adr-proj-'));
  try {
    const result = scaffoldAdr(cwd, { dir: 'docs/adr', force: true });
    assert.equal(result.dir, 'docs/adr');
    assert.equal(result.decisionsDoc, 'docs/decisions.md');
    assert.ok(fs.existsSync(path.join(cwd, 'docs', 'decisions.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'docs', 'adr', 'README.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.forge', 'config.json')));
    assert.ok(
      fs.existsSync(path.join(cwd, 'scripts', 'hooks', 'check-pending-adrs.sh')),
    );
    const cfg = loadProjectConfig(cwd);
    assert.equal(cfg.adr.enabled, true);
    assert.equal(cfg.adr.dir, 'docs/adr');
    const decisions = fs.readFileSync(path.join(cwd, 'docs', 'decisions.md'), 'utf8');
    assert.match(decisions, /docs\/adr/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('scaffoldAdr custom dir', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-adr-custom-'));
  try {
    scaffoldAdr(cwd, { dir: 'architecture/adr', force: true });
    assert.ok(fs.existsSync(path.join(cwd, 'architecture', 'decisions.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'architecture', 'adr', 'README.md')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('disableProjectAdr', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-adr-off-'));
  try {
    scaffoldAdr(cwd, { force: true });
    disableProjectAdr(cwd);
    assert.equal(loadProjectConfig(cwd).adr.enabled, false);
    assert.equal(resolveProjectAdr(cwd).enabled, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('applyAdrSkills / inferAdrFromSkills', () => {
  assert.deepEqual(
    applyAdrSkills(['forge'], true).sort(),
    ['archive-to-adr', 'forge', 'git-resolve-adr-conflict'].sort(),
  );
  assert.deepEqual(applyAdrSkills(['forge', 'archive-to-adr'], false), ['forge']);
  assert.equal(inferAdrFromSkills(['forge'], null), null);
  assert.equal(inferAdrFromSkills(['archive-to-adr'], null), true);
  assert.equal(inferAdrFromSkills(['forge'], false), false);
  assert.equal(inferAdrFromSkills(['forge'], true), true);
  assert.ok(ADR_SKILLS.every((id) => SKILL_IDS.includes(id)));
});

test('parseArgs adr flags', () => {
  const opts = parseArgs([
    '--skills',
    'forge',
    '--adr',
    '--adr-dir',
    'arch/adr',
    '--adr-project',
  ]);
  assert.equal(opts.adr, true);
  assert.equal(opts.adrDir, 'arch/adr');
  assert.equal(opts.adrProject, true);
  assert.equal(parseArgs(['--no-adr']).adr, false);
});

test('install with --adr installs ADR skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-adr-inst-'));
  try {
    const results = installSkillsToAgents(
      applyAdrSkills(['forge'], true),
      ['cursor'],
      { home, force: true },
    );
    assert.ok(results.some((r) => r.skill === 'archive-to-adr'));
    assert.ok(
      fs.existsSync(path.join(home, '.cursor', 'skills', 'archive-to-adr', 'SKILL.md')),
    );
    assert.ok(
      fs.existsSync(
        path.join(home, '.cursor', 'skills', 'git-resolve-adr-conflict', 'SKILL.md'),
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('initProject --adr scaffolds and allows config.json in gitignore', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-adr-'));
  try {
    const report = initProject(['codex'], {
      cwd,
      force: true,
      adr: true,
      adrDir: 'docs/adr',
    });
    assert.ok(report.adr);
    assert.ok(fs.existsSync(path.join(cwd, '.forge', 'config.json')));
    const gi = fs.readFileSync(path.join(cwd, '.forge', '.gitignore'), 'utf8');
    assert.match(gi, /!config\.json/);
    assert.equal(parseInitArgs(['--adr', '--adr-dir', 'x/y']).adr, true);
    assert.equal(parseInitArgs(['--no-adr']).adr, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
