import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatSlotEnv, readSlotEnvConfig, renderSlotEnv } from './lib/slots.mjs';

const BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function forge(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
}

function writeConfig(dir, config) {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
}

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A repo with one commit and `count` linked worktrees (creation order = slot order). */
function makeRepo(count = 2) {
  const base = tempDir('forge-slotcli-');
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 'slots@example.test']);
  git(main, ['config', 'user.name', 'slots']);
  git(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const worktrees = [];
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(base, `w${i + 1}`);
    git(main, ['worktree', 'add', '-q', '-b', `branch-${i + 1}`, dir]);
    worktrees.push(dir);
  }
  return { main, worktrees };
}

const TEMPLATES = { PORT: '{3000+slot}', DATABASE_URL: 'postgres://localhost/app_{slot}' };

// --- renderSlotEnv ---

test('renderSlotEnv: {N+slot} adds N to the slot and FORGE_SLOT comes first', () => {
  const slot = 2;
  const { vars, warnings } = renderSlotEnv({ PORT: '{3000+slot}' }, slot);
  assert.deepEqual(vars, [
    ['FORGE_SLOT', String(slot)],
    ['PORT', String(3000 + slot)],
  ]);
  assert.deepEqual(warnings, []);
});

test('renderSlotEnv: {slot} is replaced inside a longer value', () => {
  const slot = 7;
  const { vars } = renderSlotEnv({ DATABASE_URL: 'postgres://localhost:5432/app_{slot}?x=1' }, slot);
  assert.deepEqual(vars[1], ['DATABASE_URL', `postgres://localhost:5432/app_${slot}?x=1`]);
});

test('renderSlotEnv: several expressions in one value are all replaced', () => {
  const slot = 3;
  const { vars } = renderSlotEnv({ URL: 'http://h:{8000+slot}/{slot}' }, slot);
  assert.deepEqual(vars[1], ['URL', `http://h:${8000 + slot}/${slot}`]);
});

test('renderSlotEnv: an unsupported expression stays verbatim and warns with its name', () => {
  const { vars, warnings } = renderSlotEnv({ NAME: 'a-{x}-{slot}', NEG: '{-1+slot}', SPACED: '{3000 + slot}' }, 4);
  assert.deepEqual(vars[1], ['NAME', 'a-{x}-4']);
  assert.deepEqual(vars[2], ['NEG', '{-1+slot}']);
  assert.deepEqual(vars[3], ['SPACED', '{3000 + slot}']);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /\{x\}/);
  assert.match(warnings[0], /NAME/);
  assert.match(warnings[1], /\{-1\+slot\}/);
});

test('renderSlotEnv: FORGE_SLOT is present with no templates, and a template cannot replace it', () => {
  assert.deepEqual(renderSlotEnv({}, 5).vars, [['FORGE_SLOT', '5']]);
  const { vars, warnings } = renderSlotEnv({ FORGE_SLOT: '99' }, 5);
  assert.deepEqual(vars, [['FORGE_SLOT', '5']]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /FORGE_SLOT/);
});

test('renderSlotEnv: invalid variable names are skipped with a warning', () => {
  const { vars, warnings } = renderSlotEnv({ 'BAD-NAME': '1', '1ST': '2', OK_1: '3', '': '4' }, 1);
  assert.deepEqual(
    vars.map(([name]) => name),
    ['FORGE_SLOT', 'OK_1'],
  );
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /BAD-NAME/);
});

// --- formatSlotEnv ---

const TRICKY = `it's a "q" \\ #x`;

test('formatSlotEnv dotenv: plain values bare, risky values double-quoted with " and \\ escaped', () => {
  const lines = formatSlotEnv(
    [
      ['PLAIN', 'http://localhost:3002/a=b'],
      ['SPACED', 'two words'],
      ['HASHED', 'a#b'],
      ['QUOTED', 'say "hi"'],
      ['APOS', "it's"],
      ['TRICKY', TRICKY],
      ['EMPTY', ''],
    ],
    'dotenv',
  ).split('\n');
  assert.deepEqual(lines.slice(0, 7), [
    'PLAIN=http://localhost:3002/a=b',
    'SPACED="two words"',
    'HASHED="a#b"',
    'QUOTED="say \\"hi\\""',
    'APOS="it\'s"',
    'TRICKY="it\'s a \\"q\\" \\\\ #x"',
    'EMPTY=',
  ]);
});

test('formatSlotEnv bash: single-quoted, each apostrophe becomes \'\\\'\'', () => {
  const out = formatSlotEnv(
    [
      ['A', 'x'],
      ['B', TRICKY],
    ],
    'bash',
  );
  assert.equal(out, `export A='x'\nexport B='it'\\''s a "q" \\ #x'\n`);
});

test('formatSlotEnv powershell: single-quoted, each apostrophe doubled', () => {
  const out = formatSlotEnv(
    [
      ['A', 'x'],
      ['B', TRICKY],
    ],
    'powershell',
  );
  assert.equal(out, `$env:A = 'x'\n$env:B = 'it''s a "q" \\ #x'\n`);
});

test('formatSlotEnv powershell: typographic single quotes U+2018 to U+201B are doubled like an apostrophe', () => {
  for (const quote of ['‘', '’', '‚', '‛']) {
    const out = formatSlotEnv([['A', `it${quote}s`]], 'powershell');
    assert.equal(out, `$env:A = 'it${quote}${quote}s'\n`, `U+${quote.codePointAt(0).toString(16)}`);
  }
});

test('formatSlotEnv: an unknown shell throws', () => {
  assert.throws(() => formatSlotEnv([['A', '1']], 'fish'), /fish/);
});

// --- readSlotEnvConfig ---

test('readSlotEnvConfig: missing file, missing slots, and missing env all mean not configured', () => {
  const dir = tempDir('forge-slotcfg-');
  assert.deepEqual(readSlotEnvConfig(dir), { env: null, warnings: [] });
  writeConfig(dir, {});
  assert.deepEqual(readSlotEnvConfig(dir), { env: null, warnings: [] });
  writeConfig(dir, { slots: {} });
  assert.deepEqual(readSlotEnvConfig(dir), { env: null, warnings: [] });
});

test('readSlotEnvConfig: returns the configured templates; an empty object still counts as configured', () => {
  const dir = tempDir('forge-slotcfg-');
  writeConfig(dir, { slots: { env: TEMPLATES } });
  assert.deepEqual(readSlotEnvConfig(dir), { env: TEMPLATES, warnings: [] });
  writeConfig(dir, { slots: { env: {} } });
  assert.deepEqual(readSlotEnvConfig(dir), { env: {}, warnings: [] });
});

test('readSlotEnvConfig: non-string values are skipped with a warning; a non-object env is ignored with one', () => {
  const dir = tempDir('forge-slotcfg-');
  writeConfig(dir, { slots: { env: { GOOD: '{slot}', NUM: 3000, NUL: null, ARR: ['x'] } } });
  const bad = readSlotEnvConfig(dir);
  assert.deepEqual(bad.env, { GOOD: '{slot}' });
  assert.equal(bad.warnings.length, 3);
  assert.match(bad.warnings.join('\n'), /NUM/);
  for (const env of ['PORT=1', ['PORT'], 5]) {
    writeConfig(dir, { slots: { env } });
    const res = readSlotEnvConfig(dir);
    assert.equal(res.env, null);
    assert.equal(res.warnings.length, 1);
  }
  writeConfig(dir, '{ not json');
  const broken = readSlotEnvConfig(dir);
  assert.equal(broken.env, null);
  assert.equal(broken.warnings.length, 1);
});

// --- the CLI ---

test('forge slot prints the slot of each worktree: 0 for main, creation order for linked ones', () => {
  const repo = makeRepo(2);
  const main = forge(repo.main, ['slot']);
  assert.equal(main.status, 0, main.stderr);
  assert.equal(main.stdout, '0\n');
  repo.worktrees.forEach((dir, i) => {
    const res = forge(dir, ['slot']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${i + 1}\n`);
  });
});

test('forge slot env: dotenv by default, bash and powershell on request, values from the slot', () => {
  const repo = makeRepo(2);
  repo.worktrees.forEach((dir) => writeConfig(dir, { slots: { env: TEMPLATES } }));
  repo.worktrees.forEach((dir, i) => {
    const slot = i + 1;
    const dotenv = forge(dir, ['slot', 'env']);
    assert.equal(dotenv.status, 0, dotenv.stderr);
    assert.equal(dotenv.stdout, `FORGE_SLOT=${slot}\nPORT=${3000 + slot}\nDATABASE_URL=postgres://localhost/app_${slot}\n`);

    const bash = forge(dir, ['slot', 'env', '--shell', 'bash']);
    assert.equal(bash.status, 0, bash.stderr);
    assert.equal(
      bash.stdout,
      `export FORGE_SLOT='${slot}'\nexport PORT='${3000 + slot}'\nexport DATABASE_URL='postgres://localhost/app_${slot}'\n`,
    );

    const ps = forge(dir, ['slot', 'env', '--shell', 'powershell']);
    assert.equal(ps.status, 0, ps.stderr);
    assert.match(ps.stdout, new RegExp(`^\\$env:PORT = '${3000 + slot}'$`, 'm'));
    assert.match(ps.stdout, new RegExp(`^\\$env:FORGE_SLOT = '${slot}'$`, 'm'));
  });
});

test('forge slot env without slots.env still prints FORGE_SLOT', () => {
  const repo = makeRepo(1);
  const res = forge(repo.worktrees[0], ['slot', 'env']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'FORGE_SLOT=1\n');
});

test('forge slot env: an unsupported template warns on stderr and keeps stdout clean', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: { ODD: 'v-{nope}' } } });
  const res = forge(dir, ['slot', 'env']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'FORGE_SLOT=1\nODD=v-{nope}\n');
  assert.match(res.stderr, /\{nope\}/);
});

test('forge slot env: a bad --shell exits 2 and prints nothing on stdout', () => {
  const repo = makeRepo(1);
  const res = forge(repo.worktrees[0], ['slot', 'env', '--shell', 'fish']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /fish/);
  const missing = forge(repo.worktrees[0], ['slot', 'env', '--shell']);
  assert.equal(missing.status, 2);
});

test('forge slot with an unknown argument exits 2', () => {
  const repo = makeRepo(1);
  assert.equal(forge(repo.worktrees[0], ['slot', 'nonsense']).status, 2);
});
