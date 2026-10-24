import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readLeaseConfig, matchLease, matchingLeases, hasMatchPatterns } from './lib/lease-config.mjs';

const DEFAULT_WAIT_MS = 540000;

function project(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-leasecfg-')));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.forge', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

test('no config file, or no leases key: empty config, no warnings, nothing matches', () => {
  for (const dir of [project(), project({ plan: { engine: 'specs' } })]) {
    const cfg = readLeaseConfig(dir);
    assert.deepEqual(cfg, { leases: [], warnings: [] });
    assert.equal(hasMatchPatterns(cfg), false);
    assert.equal(matchLease('npm test', cfg), null);
  }
});

test('unparseable config.json: empty leases and a warning', () => {
  const cfg = readLeaseConfig(project('{not json'));
  assert.deepEqual(cfg.leases, []);
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /config\.json/);
});

test('leases are read with compiled regexes, source patterns and waitMs, sorted by name', () => {
  const cfg = readLeaseConfig(
    project({
      leases: {
        web: { match: ['^npm run e2e', 'playwright'], waitMs: 1234 },
        db: { match: ['docker compose up'] },
        scripted: {},
      },
    }),
  );
  assert.deepEqual(cfg.warnings, []);
  assert.deepEqual(
    cfg.leases.map((l) => l.name),
    ['db', 'scripted', 'web'],
  );
  const byName = Object.fromEntries(cfg.leases.map((l) => [l.name, l]));
  assert.deepEqual(byName.web.patterns, ['^npm run e2e', 'playwright']);
  assert.equal(byName.web.match.length, 2);
  assert.ok(byName.web.match.every((r) => r instanceof RegExp));
  assert.deepEqual(
    byName.web.match.map((r) => r.source),
    byName.web.patterns,
  );
  assert.equal(byName.web.waitMs, 1234);
  assert.equal(byName.db.waitMs, DEFAULT_WAIT_MS);
  assert.deepEqual(byName.scripted, { name: 'scripted', match: [], patterns: [], waitMs: DEFAULT_WAIT_MS });
  assert.equal(hasMatchPatterns(cfg), true);
});

test('hasMatchPatterns is false when every lease is script-only', () => {
  const cfg = readLeaseConfig(project({ leases: { a: {}, b: { match: [] } } }));
  assert.equal(cfg.leases.length, 2);
  assert.equal(hasMatchPatterns(cfg), false);
});

test('a match entry that does not compile is skipped with a warning naming lease and pattern; the others still apply', () => {
  const bad = '(unclosed';
  const cfg = readLeaseConfig(project({ leases: { db: { match: [bad, 'psql'] } } }));
  assert.equal(cfg.leases.length, 1);
  assert.deepEqual(cfg.leases[0].patterns, ['psql']);
  assert.equal(cfg.leases[0].match.length, 1);
  assert.equal(cfg.warnings.length, 1);
  assert.ok(cfg.warnings[0].includes('db'), cfg.warnings[0]);
  assert.ok(cfg.warnings[0].includes(bad), cfg.warnings[0]);
  assert.deepEqual(matchLease('psql -c select', cfg), { name: 'db', pattern: 'psql' });
});

test('a lease whose every pattern is invalid is kept with no patterns', () => {
  const cfg = readLeaseConfig(project({ leases: { db: { match: ['(x'] } } }));
  assert.deepEqual(
    cfg.leases.map((l) => [l.name, l.patterns]),
    [['db', []]],
  );
  assert.equal(hasMatchPatterns(cfg), false);
  assert.equal(cfg.warnings.length, 1);
});

test('non-string match entries and a non-array match are ignored with warnings', () => {
  const cfg = readLeaseConfig(project({ leases: { aaa: { match: [42, 'ok'] }, bbb: { match: 'oops' } } }));
  const byName = Object.fromEntries(cfg.leases.map((l) => [l.name, l]));
  assert.deepEqual(byName.aaa.patterns, ['ok']);
  assert.deepEqual(byName.bbb.patterns, []);
  assert.equal(cfg.warnings.length, 2);
  assert.ok(cfg.warnings.some((w) => w.includes('aaa')));
  assert.ok(cfg.warnings.some((w) => w.includes('bbb')));
});

test('waitMs: non-positive, non-finite or non-number falls back to the default with a warning', () => {
  const values = { zero: 0, negative: -5, text: '60000', nothing: null, infinite: 'Infinity' };
  const cfg = readLeaseConfig(project({ leases: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { waitMs: v }])) }));
  assert.equal(cfg.leases.length, Object.keys(values).length);
  for (const l of cfg.leases) assert.equal(l.waitMs, DEFAULT_WAIT_MS, l.name);
  assert.equal(cfg.warnings.length, Object.keys(values).length);
  for (const k of Object.keys(values)) assert.ok(cfg.warnings.some((w) => w.includes(k)), `no warning for ${k}`);
});

test('a tier3 entry and invalid names are ignored with a warning', () => {
  const cfg = readLeaseConfig(
    project({
      leases: {
        tier3: { match: ['x'] },
        'Bad Name': { match: ['y'] },
        _slots: { match: ['z'] },
        '-x': {},
        good: { match: ['g'] },
      },
    }),
  );
  assert.deepEqual(
    cfg.leases.map((l) => l.name),
    ['good'],
  );
  assert.equal(cfg.warnings.length, 4);
  for (const n of ['tier3', 'Bad Name', '_slots', '-x']) assert.ok(cfg.warnings.some((w) => w.includes(n)), `no warning for ${n}`);
});

test('leases that is not an object is ignored with a warning', () => {
  for (const leases of [[], 'db', 7]) {
    const cfg = readLeaseConfig(project({ leases }));
    assert.deepEqual(cfg.leases, []);
    assert.equal(cfg.warnings.length, 1, JSON.stringify(leases));
  }
});

test('matchLease: first lease in name order, then first pattern in order, tested against the whole command', () => {
  const cfg = readLeaseConfig(
    project({
      leases: {
        zeta: { match: ['shared'] },
        alpha: { match: ['nomatch-here', 'shared'] },
        mid: { match: ['^cd app && npm test$'] },
      },
    }),
  );
  // Both alpha and zeta match: alpha wins by name, and names its own matching pattern.
  assert.deepEqual(matchLease('run shared thing', cfg), { name: 'alpha', pattern: 'shared' });
  // The regex runs against the whole command string, including parts after a shell operator.
  assert.deepEqual(matchLease('cd app && npm test', cfg), { name: 'mid', pattern: '^cd app && npm test$' });
  assert.equal(matchLease('echo unrelated', cfg), null);
  // Repeated calls are stable (no stateful /g regex).
  assert.deepEqual(matchLease('run shared thing', cfg), { name: 'alpha', pattern: 'shared' });
  assert.deepEqual(matchLease('run shared thing', cfg), { name: 'alpha', pattern: 'shared' });
});

test('matchLease: a command already wrapped in forge lease or forge evidence never matches', () => {
  const cfg = readLeaseConfig(project({ leases: { db: { match: ['psql', 'npm'] } } }));
  assert.deepEqual(matchLease('psql -c 1', cfg), { name: 'db', pattern: 'psql' });
  assert.equal(matchLease('forge lease run db -- psql -c 1', cfg), null);
  assert.equal(matchLease('cd x && forge lease run db -- npm test', cfg), null);
  assert.equal(matchLease('forge evidence --tier3 -- npm test', cfg), null);
  // Only the exact wrappers exempt a command, not look-alikes.
  assert.deepEqual(matchLease('forge status && npm test', cfg), { name: 'db', pattern: 'npm' });
});

test('matchingLeases: every lease with a hitting pattern, in name order, with its waitMs and first hitting pattern', () => {
  const cfg = readLeaseConfig(
    project({
      leases: {
        zeta: { match: ['no-hit', 'shared'], waitMs: 111 },
        alpha: { match: ['shared'], waitMs: 222 },
        mid: { match: ['unrelated'] },
        beta: { match: ['(', 'thing$', 'shared'] },
      },
    }),
  );
  assert.deepEqual(matchingLeases('run shared thing', cfg), [
    { name: 'alpha', pattern: 'shared', waitMs: 222 },
    { name: 'beta', pattern: 'thing$', waitMs: DEFAULT_WAIT_MS },
    { name: 'zeta', pattern: 'shared', waitMs: 111 },
  ]);
  assert.deepEqual(matchingLeases('echo unrelated only', cfg), [{ name: 'mid', pattern: 'unrelated', waitMs: DEFAULT_WAIT_MS }]);
  assert.deepEqual(matchingLeases('echo nada', cfg), []);
  assert.deepEqual(matchingLeases('anything', { leases: [], warnings: [] }), []);
});

test('matchingLeases has no already-wrapped exemption: the evidence inner command is what matters', () => {
  const cfg = readLeaseConfig(project({ leases: { db: { match: ['psql'] } } }));
  assert.equal(matchLease('forge lease db -- psql -c 1', cfg), null, 'matchLease still exempts a wrapped command');
  assert.deepEqual(matchingLeases('forge lease db -- psql -c 1', cfg), [{ name: 'db', pattern: 'psql', waitMs: DEFAULT_WAIT_MS }]);
  assert.deepEqual(matchingLeases('forge evidence --tier3 -- psql -c 1', cfg), [{ name: 'db', pattern: 'psql', waitMs: DEFAULT_WAIT_MS }]);
});

test('list and check are reserved lease names: skipped with a warning naming them, other leases still read', () => {
  const cfg = readLeaseConfig(
    project({ leases: { list: { match: ['x'] }, check: { match: ['y'] }, good: { match: ['g'] } } }),
  );
  assert.deepEqual(
    cfg.leases.map((l) => l.name),
    ['good'],
  );
  assert.equal(cfg.warnings.length, 2);
  for (const n of ['list', 'check']) {
    assert.ok(cfg.warnings.some((w) => w.includes(`"${n}"`) && /reserved/.test(w)), `no reserved warning for ${n}: ${cfg.warnings}`);
  }
  // A skipped reserved lease can never match: the guard cannot tell the agent to run `forge lease list -- …`.
  assert.equal(matchLease('x y', cfg), null);
});
