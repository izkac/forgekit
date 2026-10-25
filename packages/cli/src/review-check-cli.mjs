#!/usr/bin/env node
/**
 * `forge review-check <file> [--json]` — list each blocking item of a review as
 * backed (with its evidence form) or downgraded to Minor, then print the
 * effective verdict. Exit 0 always for a readable file; exit 2 with usage when
 * the file is missing or unreadable. The rules live in `review-check.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkReview } from './review-check.mjs';

const USAGE = 'Usage: forge review-check <file> [--json]\n';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const json = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  process.stderr.write(`forge review-check: a review file is required\n${USAGE}`);
  process.exit(2);
}

// The bin re-roots to the project root; a relative path means what the caller typed.
const resolved = path.resolve(process.env.FORGE_INVOKED_FROM ?? process.cwd(), file);
let body;
try {
  body = fs.readFileSync(resolved, 'utf8');
} catch (err) {
  process.stderr.write(`forge review-check: cannot read ${file}: ${/** @type {Error} */ (err).message}\n${USAGE}`);
  process.exit(2);
}

const result = checkReview(body);
if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const summary = (/** @type {string} */ text) => {
  const first = text.split('\n')[0].trim();
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
};
const lines = result.items.map((i) =>
  i.backed ? `backed (${i.form}): ${summary(i.text)}` : `downgraded to Minor: ${summary(i.text)}`,
);
if (result.note) lines.unshift(result.note);
lines.push(`effective verdict: ${result.effectiveVerdict}`);
process.stdout.write(`${lines.join('\n')}\n`);
