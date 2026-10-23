import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, runRecordEvidence } from './record-evidence.mjs';

const FIXED_NOW = () => new Date('2026-06-05T15:04:22.000Z');
const SESSION = 'sess-scope';

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-scope-'));
  const sessionDir = path.join(dir, '.forge', 'sessions', SESSION);
  fs.mkdirSync(path.join(sessionDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId: SESSION }), 'utf8');
  return { dir, ledger: path.join(sessionDir, 'verify-runs.jsonl') };
}

/** Tier-3 opts running a node one-liner; `marker` is a file the command creates, so a spawn is observable. */
function tier3Opts(overrides, marker) {
  return {
    task: null,
    command: null,
    exit: null,
    summary: null,
    tier: null,
    session: null,
    allowFail: false,
    forgeDir: null,
    noTdd: false,
    reason: null,
    help: false,
    tier3: true,
    cmdArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    env: { ...process.env, FORGEKIT_ALLOW_EXEC: '1' },
    confirm: false,
    ...overrides,
  };
}

function readStamps(ledger) {
  return fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('parseArgs reads --scope, and defaults it to unset', () => {
  assert.equal(parseArgs(['--tier3', '--scope', 'failed-only', '--', 'x']).scope, 'failed-only');
  assert.equal(parseArgs(['--tier3', '--', 'x']).scope ?? null, null);
});

test('default scope: a tier-3 stamp records scope "full"', () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran-default');
  const res = runRecordEvidence(tier3Opts({}, marker), dir, FIXED_NOW);
  assert.equal(res.exitCode, 0, res.message);
  const stamps = readStamps(ledger);
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].scope, 'full');
});

for (const scope of ['full', 'failed-only', 'fix', 'group']) {
  test(`--scope ${scope} is recorded in the stamp and shown in the receipt`, () => {
    const { dir, ledger } = makeFixture();
    const res = runRecordEvidence(tier3Opts({ scope }, path.join(dir, 'ran')), dir, FIXED_NOW);
    assert.equal(res.exitCode, 0, res.message);
    assert.equal(readStamps(ledger)[0].scope, scope);
    assert.ok(res.message.includes(`- **Scope:** ${scope}`), res.message);
  });
}

test('unknown scope is a usage error and spawns nothing', () => {
  const { dir, ledger } = makeFixture();
  const marker = path.join(dir, 'ran-bad');
  const res = runRecordEvidence(tier3Opts({ scope: 'everything' }, marker), dir, FIXED_NOW);
  assert.notEqual(res.exitCode, 0);
  assert.match(res.message, /--scope/);
  assert.match(res.message, /full\|failed-only\|fix\|group/);
  assert.equal(fs.existsSync(marker), false, 'command must not have been spawned');
  assert.equal(fs.existsSync(ledger), false, 'no stamp must be written');
});

test('--scope without --tier3 is a usage error and spawns nothing', () => {
  const { dir } = makeFixture();
  const marker = path.join(dir, 'ran-notier3');
  const res = runRecordEvidence(
    tier3Opts({ scope: 'fix', tier3: false, task: '01-x' }, marker),
    dir,
    FIXED_NOW,
  );
  assert.notEqual(res.exitCode, 0);
  assert.match(res.message, /--scope.*--tier3|--tier3.*--scope/);
  assert.equal(fs.existsSync(marker), false, 'command must not have been spawned');
});
