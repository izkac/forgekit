import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { provenFacts, provenLine, UNVERIFIED_SOURCES } from './proven.mjs';
import { addRefutation } from './refute.mjs';
import { RECORDED_BY_EXECUTED } from './record-evidence.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'forge-proven-'));
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(path.join(sessionDir, 'tasks', '01-a'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'tasks', '02-b'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', '01-a', 'test-evidence.md'),
    ['# Test evidence', '- **Exit code:** 0', `- **Recorded by:** ${RECORDED_BY_EXECUTED}`, ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', '02-b', 'test-evidence.md'),
    ['# Test evidence', '- **Exit code:** 1', ''].join('\n'),
  );
  return { cwd, sessionDir, session: { id: 's1', features: { tddEvidence: false } } };
}

test('provenFacts counts executed evidence, tier-3 stamps and refutations; names unverified sources', () => {
  const f = fixture();
  const stamp = { command: 'npm test', exit: 0, ok: true, startedAt: 'now' };
  fs.writeFileSync(path.join(f.sessionDir, 'verify-runs.jsonl'), `${JSON.stringify(stamp)}\n`);
  addRefutation(f.sessionDir, { task: '02-b', claim: 'c', actual: 'a' });
  const p = provenFacts(f);
  assert.deepEqual([p.tasks.ok, p.tasks.total], [1, 2]);
  assert.match(p.tasks.rows[0].detail, /^executed/);
  assert.match(p.tasks.rows[1].detail, /UNVERIFIED/);
  assert.equal(p.tier3.ok, true);
  assert.equal(p.knownFalse, 1);
  assert.deepEqual(p.unverified, [...UNVERIFIED_SOURCES]);
  assert.equal(p.e2e.state, 'not green');
  const line = provenLine(p);
  assert.match(line, /tasks 1\/2/);
  assert.match(line, /tier3 exit 0/);
  assert.match(line, /known-false 1/);
  assert.match(line, /UNVERIFIED/);
});

test('provenLine says when tier 3 was never stamped', () => {
  const p = provenFacts(fixture());
  assert.equal(p.tier3, null);
  assert.match(provenLine(p), /tier3 not stamped/);
  assert.doesNotMatch(provenLine(p), /known-false/);
});
