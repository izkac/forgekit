#!/usr/bin/env node
/**
 * Product loop for thorough-re-narrowing — pin F11 qualifier+\s+ policy:
 * public-contract + hard-wrapped public\\ncontract stay risky; bare
 * "must never block work" contract is benign; corpus fixture all match.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHighRiskText } from '../../packages/cli/src/preferences.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = path.join(REPO, 'packages', 'cli', 'src', 'fixtures', 'thorough-re-corpus.json');

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const f11 = isHighRiskText('alters the public contract of the /v1/orders endpoint');
const wrap = isHighRiskText('alters the public\ncontract of the /v1/orders endpoint');
const bare = isHighRiskText('byte-identical (the existing "must never block work" contract)');

if (!f11) fail('expected F11 public-contract → risky');
if (!wrap) fail('expected hard-wrapped public\\ncontract → risky');
if (bare) fail('expected bare "must never block work" contract → benign');

const doc = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const mismatches = [];
for (const row of doc.sentences) {
  const actual = isHighRiskText(row.text) ? 'risky' : 'benign';
  if (actual !== row.expect) {
    mismatches.push(`${row.id}: expect ${row.expect}, got ${actual}`);
  }
}
if (mismatches.length) fail(`corpus drift:\n${mismatches.join('\n')}`);

process.stdout.write('NARROWING f11=risky wrap=risky bare=benign corpus=ok\n');
