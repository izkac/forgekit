import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLedger } from './ledger.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const WORKERS = 4;
const ROUNDS = 15;

// Each worker hammers the three project-level ledgers two forge sessions
// share: findings.jsonl (id minting), known-false.jsonl (ledger.mjs
// appendLines) and scorecards.jsonl (score.mjs). Every write is keyed
// uniquely, so a lost update shows up as a missing line or a duplicate id.
const WORKER = `
import fs from 'node:fs';
import path from 'node:path';
import { addFinding } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'findings.mjs')).href)};
import { appendKnownFalseLedger } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'ledger.mjs')).href)};
import { appendScorecardLedger } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'score.mjs')).href)};
const [forgeDir, worker, rounds] = process.argv.slice(2);
for (let i = 0; i < Number(rounds); i++) {
  const id = 'w' + worker + '-' + i;
  addFinding({ forgeDir, text: id, kind: 'idea', severity: 'note' });
  const sessionDir = path.join(forgeDir, 'sessions', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'known-false.jsonl'), JSON.stringify({ id: 'K1', claim: id }) + '\\n');
  if (appendKnownFalseLedger({ sessionDir, session: { id } }) !== 1) throw new Error('known-false append dropped');
  appendScorecardLedger(sessionDir, { sessionId: id, checks: [] });
}
`;

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
  });
}

test('concurrent sessions lose no ledger lines and mint no duplicate finding ids', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-ledger-race-')));
  try {
    const forgeDir = path.join(root, '.forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    const script = path.join(root, 'worker.mjs');
    fs.writeFileSync(script, WORKER);

    await Promise.all(Array.from({ length: WORKERS }, (_, w) => run(script, [forgeDir, String(w), String(ROUNDS)])));

    const total = WORKERS * ROUNDS;
    const findings = readLedger(path.join(forgeDir, 'findings.jsonl'));
    assert.equal(findings.length, total, 'findings lost');
    assert.equal(new Set(findings.map((f) => f.id)).size, total, 'duplicate finding ids');
    assert.equal(new Set(findings.map((f) => f.text)).size, total);
    assert.equal(readLedger(path.join(forgeDir, 'known-false.jsonl')).length, total, 'known-false lines lost');
    assert.equal(readLedger(path.join(forgeDir, 'scorecards.jsonl')).length, total, 'scorecard lines lost');
    assert.deepEqual(
      fs.readdirSync(forgeDir).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')),
      [],
      'lock / temp files left behind',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
