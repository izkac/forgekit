#!/usr/bin/env node
/**
 * Product loop for findings-ledger-routing — drive the shipped forge binary
 * against a scratch project: plant an open bug → forge new matches it;
 * backdate another → forge status lists it as stale.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-findings-routing-'));

function forge(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet') };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CURSOR_CONVERSATION_ID;
  delete env.CURSOR_TRACE_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

fs.mkdirSync(path.join(SCRATCH, 'project', '.forge'), { recursive: true });
const cwd = path.join(SCRATCH, 'project');

// Produce: an open bug tied to the slug we are about to start.
const add = forge(cwd, [
  'finding',
  'add',
  'parser drops empty flags',
  '--kind',
  'bug',
  '--severity',
  'major',
  '--change',
  'fix-parser',
]);
if (add.code !== 0) fail(`finding add failed: ${add.stderr}`);

// Consume: forge new on that slug must surface it without blocking.
const created = forge(cwd, ['new', 'fix-parser', '--signal', 'fix parser empty flags']);
if (created.code !== 0) fail(`forge new failed: ${created.stderr}`);
let out;
try {
  out = JSON.parse(created.stdout);
} catch {
  fail(`forge new stdout not JSON: ${created.stdout.slice(0, 200)}`);
}
if (!Array.isArray(out.relatedFindings) || out.relatedFindings.length < 1) {
  fail(`expected relatedFindings, got ${JSON.stringify(out.relatedFindings)}`);
}
if (!created.stderr.includes(out.relatedFindings[0].id)) {
  fail(`stderr should name ${out.relatedFindings[0].id}: ${created.stderr}`);
}

// Stale path: backdate the ledger row, then status must list it.
const ledger = path.join(cwd, '.forge', 'findings.jsonl');
const rows = fs
  .readFileSync(ledger, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
rows[0].createdAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
fs.writeFileSync(ledger, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

const status = forge(cwd, ['status']);
if (status.code !== 0) fail(`forge status failed: ${status.stderr}`);
const st = JSON.parse(status.stdout);
if (!Array.isArray(st.staleFindings) || st.staleFindings.length < 1) {
  fail(`expected staleFindings, got ${JSON.stringify(st.staleFindings)}`);
}
if (st.staleFindings[0].ageDays < 7) fail(`ageDays ${st.staleFindings[0].ageDays} < 7`);

process.stdout.write(
  'FINDINGS routing related=ok stale=ok ' +
    `related=${out.relatedFindings[0].id} stale=${st.staleFindings[0].id}\n`,
);
fs.rmSync(SCRATCH, { recursive: true, force: true });
