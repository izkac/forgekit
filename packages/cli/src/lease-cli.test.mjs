import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leasePathFor } from './lib/lease.mjs';
import { buildWindowsCommand } from './lease-cli.mjs';

const BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./lib/lease.mjs', import.meta.url))).href;
const HOLD_MS = 6000;
const SESSION = 'sess-lease-cli';
const SLUG = 'lease-cli-slug';
const NAME_RULE = '^[a-z0-9][a-z0-9-]*$';

/** A temp git project with an active Forge session (so the holder carries a slug). */
function makeProject(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-leasecli-')));
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const sessionDir = path.join(dir, '.forge', 'sessions', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId: SESSION }), 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ id: SESSION, slug: SLUG }), 'utf8');
  if (config !== undefined) fs.writeFileSync(path.join(dir, '.forge', 'config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

/** Run `forge <args>` from `dir`; `env` is merged over the parent env. */
function forge(dir, args, env = {}, timeout = 60000) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
  });
}

/** A node one-liner (as argv) that writes `marker` and exits with `code`. No quotes inside: the marker path comes from the env. */
function markerCommand(code = 0) {
  return [process.execPath, '-e', `require('fs').writeFileSync(process.env.MARKER,'ran');process.exit(${code})`];
}

/** Another process takes lease `name` through the module and keeps it for HOLD_MS. */
function holdFromChild(cwd, name = 'db', slug = 'child-holder') {
  const code = `
    import(${JSON.stringify(MODULE_URL)}).then(({ acquireLease }) => {
      const release = acquireLease({ cwd: ${JSON.stringify(cwd)}, name: ${JSON.stringify(name)}, sessionId: 'child-sess', slug: ${JSON.stringify(slug)}, pollMs: 25, notify: () => {} });
      console.log('held');
      setTimeout(() => { release(); }, ${HOLD_MS});
    });
  `;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('held')) resolve();
    });
    child.on('exit', () => reject(new Error('child exited before holding the lease')));
  });
  return { child, held, exited };
}

test('exit code passes through, the command ran under the lease, and the lease file is gone afterwards', () => {
  const dir = makeProject();
  const marker = path.join(dir, 'ran');
  const lock = leasePathFor(dir, 'db');
  const seen = path.join(dir, 'holder-seen.json');
  // The command records the lease file as it sees it, then exits 3.
  const probe = [
    process.execPath,
    '-e',
    `require('fs').copyFileSync(process.env.LOCK,process.env.SEEN);require('fs').writeFileSync(process.env.MARKER,'ran');process.exit(3)`,
  ];
  const res = forge(dir, ['lease', 'db', '--', ...probe], { MARKER: marker, LOCK: lock, SEEN: seen });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', 'the command did not run');
  const holder = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(holder.name, 'db');
  assert.equal(holder.sessionId, SESSION);
  assert.equal(holder.slug, SLUG);
  assert.equal(fs.existsSync(lock), false, 'lease file must be released after the command exits');
});

test('exit 0 passes through and an arg with spaces and quotes reaches the command intact', () => {
  const dir = makeProject();
  const out = path.join(dir, 'arg.txt');
  const tricky = 'two words & "quoted" (x)';
  const res = forge(dir, [
    'lease',
    'db',
    '--',
    process.execPath,
    '-e',
    'require("fs").writeFileSync(process.env.OUT, process.argv[1])',
    tricky,
  ], { OUT: out });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), tricky);
});

test('a lease held past --wait-ms exits 75, names the lease and holder pid, and never runs the command', async () => {
  const dir = makeProject();
  const marker = path.join(dir, 'ran');
  const { child, held } = holdFromChild(dir, 'db');
  await held;
  const t0 = Date.now();
  const res = forge(dir, ['lease', 'db', '--wait-ms', '300', '--', ...markerCommand(0)], { MARKER: marker });
  const elapsed = Date.now() - t0;
  try {
    assert.equal(res.status, 75, res.stderr);
    assert.match(res.stderr, /lease db busy/);
    assert.ok(res.stderr.includes('child-holder'), res.stderr);
    assert.ok(res.stderr.includes(`pid ${child.pid}`), res.stderr);
    assert.equal(fs.existsSync(marker), false, 'the command ran although the lease was busy');
    assert.ok(elapsed < HOLD_MS, `waited ${elapsed}ms: as long as the holder held it`);
    assert.equal(JSON.parse(fs.readFileSync(leasePathFor(dir, 'db'), 'utf8')).pid, child.pid, 'holder is untouched');
  } finally {
    child.kill();
  }
});

test('without --wait-ms the configured waitMs for that lease bounds the wait; --wait-ms overrides it', async () => {
  const configured = makeProject({ leases: { db: { match: ['prisma'], waitMs: 300 } } });
  const overridden = makeProject({ leases: { db: { match: ['prisma'], waitMs: 600000 } } });
  const a = holdFromChild(configured, 'db');
  const b = holdFromChild(overridden, 'db');
  await Promise.all([a.held, b.held]);
  try {
    const markerA = path.join(configured, 'ran');
    // Past the 540000 default this would hit the spawn timeout instead of exiting 75.
    const resA = forge(configured, ['lease', 'db', '--', ...markerCommand()], { MARKER: markerA }, 30000);
    assert.equal(resA.status, 75, `${resA.error ?? ''}${resA.stderr}`);
    assert.equal(fs.existsSync(markerA), false);

    const markerB = path.join(overridden, 'ran');
    const resB = forge(overridden, ['lease', 'db', '--wait-ms', '300', '--', ...markerCommand()], { MARKER: markerB }, 30000);
    assert.equal(resB.status, 75, `${resB.error ?? ''}${resB.stderr}`);
    assert.equal(fs.existsSync(markerB), false);
  } finally {
    a.child.kill();
    b.child.kill();
  }
});

test('an invalid or reserved name exits 2 naming the allowed pattern, and the command does not run', () => {
  const dir = makeProject();
  for (const name of ['../etc', 'Db', '-x', 'a/b', 'tier3', '_slots', 'list', 'check']) {
    const marker = path.join(dir, `ran-${name.replace(/\W/g, '_')}`);
    const res = forge(dir, ['lease', name, '--', ...markerCommand()], { MARKER: marker });
    assert.equal(res.status, 2, `${name}: ${res.stderr}`);
    assert.ok(res.stderr.includes(NAME_RULE), `${name}: ${res.stderr}`);
    assert.equal(fs.existsSync(marker), false, `${name}: the command ran`);
  }
  assert.equal(fs.existsSync(path.join(dir, '.git', 'forge', 'leases')), false, 'no lease dir for a refused name');
});

test('a missing -- or empty command, and a bad --wait-ms, are usage errors (exit 2) that run nothing', () => {
  const dir = makeProject();
  const marker = path.join(dir, 'ran');
  const cases = [
    ['lease', 'db'],
    ['lease', 'db', '--'],
    ['lease', 'db', ...markerCommand()],
    ['lease', 'db', '--wait-ms', 'soon', '--', ...markerCommand()],
    ['lease', 'db', '--wait-ms', '-5', '--', ...markerCommand()],
    ['lease', 'db', '--wait-ms', '1.5', '--', ...markerCommand()],
  ];
  for (const args of cases) {
    const res = forge(dir, args, { MARKER: marker });
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`);
    assert.match(res.stderr, /Usage|--wait-ms/i, args.join(' '));
  }
  assert.equal(fs.existsSync(marker), false, 'a usage error must not run the command');
});

test('lease list --json shows a held lease as alive with its holder; no leases prints a plain line', async () => {
  const dir = makeProject();
  const empty = forge(dir, ['lease', 'list']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), 'no leases');
  assert.deepEqual(JSON.parse(forge(dir, ['lease', 'list', '--json']).stdout), []);

  const { child, held } = holdFromChild(dir, 'db', 'list-holder');
  await held;
  try {
    const res = forge(dir, ['lease', 'list', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const rows = JSON.parse(res.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'db');
    assert.equal(rows[0].alive, true);
    assert.equal(rows[0].holder.pid, child.pid);
    assert.equal(rows[0].holder.slug, 'list-holder');

    const human = forge(dir, ['lease', 'list']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^db {2}held by list-holder \(pid \d+, alive, since \S+\)$/m);
    assert.ok(human.stdout.includes(`pid ${child.pid}`), human.stdout);
  } finally {
    child.kill();
  }
});

test('buildWindowsCommand quotes args with whitespace or cmd metacharacters and doubles inner quotes', () => {
  assert.equal(buildWindowsCommand(['npm', 'test']), 'npm test');
  assert.equal(buildWindowsCommand(['echo', 'a b']), 'echo "a b"');
  assert.equal(buildWindowsCommand(['echo', 'say "hi"']), 'echo "say ""hi"""');
  assert.equal(buildWindowsCommand(['node', '-e', 'process.exit(3)']), 'node -e "process.exit(3)"');
  for (const meta of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', '(a)']) {
    assert.equal(buildWindowsCommand(['x', meta]), `x "${meta}"`, meta);
  }
  assert.equal(buildWindowsCommand(['x', '']), 'x ""', 'an empty arg must survive');
  assert.equal(buildWindowsCommand(['C:\\Program Files\\nodejs\\node.exe', '-v']), '"C:\\Program Files\\nodejs\\node.exe" -v');
  assert.equal(buildWindowsCommand(['plain-arg_1.2/x:y=z']), 'plain-arg_1.2/x:y=z');
  // Backslashes only matter before a quote: double the run before every " and before the closing quote.
  assert.equal(buildWindowsCommand(['x', 'C:\\my dir\\']), 'x "C:\\my dir\\\\"');
  assert.equal(buildWindowsCommand(['x', 'a\\"b c']), 'x "a\\\\""b c"');
  assert.equal(buildWindowsCommand(['x', 'C:\\dir\\']), 'x C:\\dir\\', 'no quoting needed, no change');
});

function check(dir, command, extra = []) {
  return forge(dir, ['lease', 'check', '--command', command, ...extra]);
}

test('lease check denies a configured match with the lease, the pattern and a rerun-under-the-lease reason', () => {
  const pattern = 'prisma migrate';
  const dir = makeProject({ leases: { db: { match: [pattern] } } });
  const command = 'npx prisma migrate dev';
  const res = check(dir, command, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.action, 'deny');
  assert.equal(out.lease, 'db');
  assert.equal(out.pattern, pattern);
  assert.ok(out.reason.includes(`forge lease db -- ${command}`), out.reason);
  assert.ok(out.reason.includes(pattern), 'the reason names the matching pattern');
  assert.match(out.reason, /10 minutes/);
  assert.match(out.reason, /background/);

  // Without --json the output is the reason line itself.
  const plain = check(dir, command);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), out.reason);
});

test('lease check says none for an already-wrapped command, an unrelated command, and a project with no config', () => {
  const dir = makeProject({ leases: { db: { match: ['prisma migrate'] } } });
  for (const command of ['forge lease db -- npx prisma migrate dev', 'npm test', 'forge evidence --tier3 -- npx prisma migrate dev']) {
    const res = check(dir, command, ['--json']);
    assert.equal(res.status, 0, `${command}: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout), { action: 'none' }, command);
    assert.equal(check(dir, command).stdout.trim(), 'none', command);
  }
  const bare = makeProject();
  const res = check(bare, 'npx prisma migrate dev', ['--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { action: 'none' });
});

test('lease check: an invalid pattern is skipped with a warning naming it, and the valid pattern still denies', () => {
  const dir = makeProject({ leases: { db: { match: ['(', 'prisma migrate'] } } });
  const res = check(dir, 'npx prisma migrate dev', ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.action, 'deny');
  assert.equal(out.lease, 'db');
  assert.equal(out.pattern, 'prisma migrate');
  assert.ok(res.stderr.includes(JSON.stringify('(')), `warning must name the bad pattern: ${res.stderr}`);
  assert.equal(res.stdout.trim().startsWith('{'), true, 'warnings go to stderr, stdout stays JSON');
});

test('lease check names the first matching lease in name order', () => {
  const dir = makeProject({ leases: { zeta: { match: ['shared'] }, alpha: { match: ['shared'] } } });
  const out = JSON.parse(check(dir, 'run shared thing', ['--json']).stdout);
  assert.equal(out.lease, 'alpha');
  assert.ok(out.reason.includes('forge lease alpha -- run shared thing'), out.reason);
});

test('lease check without --command is a usage error (exit 2)', () => {
  const dir = makeProject({ leases: { db: { match: ['prisma'] } } });
  const res = forge(dir, ['lease', 'check', '--json']);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /--command/);
});

test('list and check followed by -- exit 2 with a reserved-name message and never run the command', () => {
  const dir = makeProject({ leases: { db: { match: ['prisma'] } } });
  for (const name of ['list', 'check']) {
    const marker = path.join(dir, `ran-${name}`);
    for (const args of [['lease', name, '--', ...markerCommand()], ['lease', name, '--wait-ms', '5', '--', ...markerCommand()]]) {
      const res = forge(dir, args, { MARKER: marker });
      assert.equal(res.status, 2, `${args.slice(0, 4).join(' ')}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`"${name}".*reserved`), res.stderr);
      assert.equal(fs.existsSync(marker), false, `${name}: the command ran`);
    }
  }
});

test('a spawn failure exits 1, not a special code', () => {
  const dir = makeProject();
  const res = forge(dir, ['lease', 'db', '--', 'definitely-not-a-real-command-xyz']);
  assert.equal(res.status, 1, res.stderr);
});

test('args with trailing backslashes, backslash-quote runs and quotes reach the command byte for byte', () => {
  const dir = makeProject();
  const out = path.join(dir, 'argv.json');
  const args = ['C:\\my dir\\', 'next', 'x\\"y z', 'a\\\\"b c', 'end\\\\', 'q"', '', 'plain'];
  const res = forge(dir, [
    'lease',
    'db',
    '--',
    process.execPath,
    '-e',
    'require("fs").writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(1)))',
    ...args,
  ], { OUT: out });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), args);
});

test('the wrapped command runs in the directory forge lease was invoked from, while the lease stays at the project root', () => {
  const dir = makeProject();
  const pkg = path.join(dir, 'packages', 'api');
  fs.mkdirSync(pkg, { recursive: true });
  const out = path.join(dir, 'where.json');
  const lock = leasePathFor(dir, 'db');
  const probe = [
    process.execPath,
    '-e',
    `const fs=require('fs');fs.writeFileSync(process.env.OUT,JSON.stringify({cwd:process.cwd(),lockExists:fs.existsSync(process.env.LOCK)}))`,
  ];
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

  const fromPkg = forge(pkg, ['lease', 'db', '--', ...probe], { OUT: out, LOCK: lock });
  assert.equal(fromPkg.status, 0, fromPkg.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(norm(seen.cwd), norm(pkg), 'the command must run in packages/api, not at the repo root');
  assert.equal(seen.lockExists, true, 'the lease lives under the root git common dir (.git/forge/leases)');
  assert.equal(fs.existsSync(path.join(pkg, '.forge')), false, 'no stray .forge in the package');
  assert.equal(fs.existsSync(lock), false);

  const fromRoot = forge(dir, ['lease', 'db', '--', ...probe], { OUT: out, LOCK: lock });
  assert.equal(fromRoot.status, 0, fromRoot.stderr);
  assert.equal(norm(JSON.parse(fs.readFileSync(out, 'utf8')).cwd), norm(dir));
});

test('lease check on a chained command says to wrap only the part that needs the lease, not the whole chain', () => {
  const dir = makeProject({ leases: { db: { match: ['prisma migrate'] } } });
  for (const command of ['npm ci && npx prisma migrate dev', 'npx prisma migrate dev; echo done', 'echo x | npx prisma migrate dev', 'false || npx prisma migrate dev']) {
    const res = check(dir, command, ['--json']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.action, 'deny', command);
    assert.equal(out.lease, 'db');
    assert.ok(!out.reason.includes(`forge lease db -- ${command}`), `must not tell the agent to lease the whole chain: ${out.reason}`);
    assert.match(out.reason, /only the part/i, command);
    assert.ok(out.reason.includes(command), `the reason must quote the blocked command verbatim: ${out.reason}`);
    assert.match(out.reason, /script/i, command);
    assert.match(out.reason, /forge lease db -- </, 'shows the wrapping form');
    assert.match(out.reason, /10 minutes/);
    assert.match(out.reason, /background/);
  }
  // A plain command keeps the rerun-the-whole-command reason.
  const plain = JSON.parse(check(dir, 'npx prisma migrate dev', ['--json']).stdout);
  assert.ok(plain.reason.includes('forge lease db -- npx prisma migrate dev'), plain.reason);
  assert.doesNotMatch(plain.reason, /only the part/i);
});
