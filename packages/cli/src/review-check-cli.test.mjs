import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkReview } from './review-check.mjs';

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

const CMD = 'npm test -- foo';
const BACKED = `- Foo breaks.\n  Command: ${CMD} → exit 1`;
const BARE = '- Vague worry about the design.';
const REVIEW = ['**Verdict: REJECTED**', '', '## Important', '', BACKED, BARE, '', '## Minor', '', '- nit', ''].join('\n');

/** A scratch project (with a `.forge` dir so the bin roots there) holding `review.md`. */
function fixture(body = REVIEW) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forge-review-check-'));
  fs.mkdirSync(path.join(root, '.forge'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'review.md'), body);
  return root;
}

function forge(cwd, args) {
  return spawnSync(process.execPath, [FORGE, 'review-check', ...args], { cwd, encoding: 'utf8' });
}

test('prints one line per blocking item (backed / downgraded) and the effective verdict; exit 0', () => {
  const root = fixture();
  const expected = checkReview(REVIEW);
  const r = forge(root, [path.join(root, 'review.md')]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, expected.items.length + 1);
  assert.match(lines[0], /backed \(command\)/);
  assert.match(lines[0], /Foo breaks/);
  assert.match(lines[1], /downgraded to Minor/);
  assert.match(lines[1], /Vague worry/);
  assert.equal(lines.at(-1), `effective verdict: ${expected.effectiveVerdict}`);
  assert.equal(expected.effectiveVerdict, 'REJECTED');
});

test('an unbacked-only REJECTED review prints effective verdict: APPROVED and still exits 0', () => {
  const root = fixture(['**Verdict: REJECTED**', '', '## Critical', '', BARE, ''].join('\n'));
  const r = forge(root, ['review.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /downgraded to Minor/);
  assert.match(r.stdout.trim().split('\n').at(-1), /^effective verdict: APPROVED$/);
});

test('--json prints the checkReview result', () => {
  const root = fixture();
  const r = forge(root, ['review.md', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), checkReview(REVIEW));
});

test('a relative file path resolves against where the command was typed, not the project root', () => {
  const root = fixture();
  const r = forge(path.join(root, 'sub'), ['../review.md', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).originalVerdict, 'REJECTED');
});

test('missing file argument or unreadable file exits 2 with usage', () => {
  const root = fixture();
  const none = forge(root, []);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Usage: forge review-check/);
  const missing = forge(root, ['no-such-review.md']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage: forge review-check/);
  assert.match(missing.stderr, /no-such-review\.md/);
  const dir = forge(root, ['sub']);
  assert.equal(dir.status, 2);
});

test('--help exits 0 with usage', () => {
  const r = forge(fixture(), ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: forge review-check/);
});

test('REJECTED with no parseable blocking list items prints the unparsed line and stays REJECTED', () => {
  const root = fixture(['**Verdict: REJECTED**', '', '## Critical', '', '### 1. Foo breaks', '', 'It crashes.', ''].join('\n'));
  const r = forge(root, ['review.md']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /REJECTED but no blocking list items found — treated as REJECTED/);
  assert.equal(lines.at(-1), 'effective verdict: REJECTED');
  assert.equal(JSON.parse(forge(root, ['review.md', '--json']).stdout).unparsed, true);
});
