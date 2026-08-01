/**
 * Shared helpers for the implement.md closed-list ↔ reviewCensus doc contract (F36).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { reviewCensus } from './review-census.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the implement-phase guidance that publishes the closed phrase list.
 * Monorepo checkout first; packed npm layout second.
 *
 * @returns {string}
 */
export function resolveImplementMd() {
  const candidates = [
    // packages/cli/src → repo root skills/
    path.resolve(HERE, '../../../skills/forge/phases/implement.md'),
    // packed layout: packages/cli/vendor/skills/
    path.resolve(HERE, '../vendor/skills/forge/phases/implement.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `implement.md not found; tried:\n${candidates.map((c) => `  ${c}`).join('\n')}`,
  );
}

/**
 * Extract backtick-wrapped tokens after `list is **closed**:` until the
 * paragraph ends (blank line).
 *
 * @param {string} md
 * @returns {string[]}
 */
export function extractClosedListPhrases(md) {
  const marker = 'list is **closed**:';
  const at = md.indexOf(marker);
  if (at < 0) throw new Error(`closed-list marker not found: ${marker}`);
  const after = md.slice(at + marker.length);
  const paraEnd = after.search(/\n\s*\n/);
  const para = paraEnd < 0 ? after : after.slice(0, paraEnd);
  const phrases = [...para.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (phrases.length === 0) {
    throw new Error('closed list yielded no backtick-wrapped phrases');
  }
  return phrases;
}

/**
 * Plant a final-review body so `phrase` sits in the attribution region
 * (opening two paragraphs).
 *
 * @param {string} phrase
 * @returns {string}
 */
export function reviewBodyForPhrase(phrase) {
  const asOwnLine =
    /^Reviewer:/i.test(phrase) ||
    /^APPROVED \(pace/i.test(phrase) ||
    /^SKIPPED \(pace/i.test(phrase) ||
    /^reviewed by the /i.test(phrase);
  const head = asOwnLine ? phrase : `Reviewer: ${phrase}`;
  return `${head}\n\nAPPROVED\n`;
}

/**
 * @param {string} finalBody
 * @returns {string} session dir
 */
function sessionWithFinal(finalBody) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-doc-contract-'));
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews', 'final-review.md'), finalBody, 'utf8');
  return dir;
}

/**
 * Run the contract: each published phrase → finalReview === 'self'.
 *
 * @returns {{ phrases: string[], self: number }}
 */
export function runDocContract() {
  const md = fs.readFileSync(resolveImplementMd(), 'utf8');
  const phrases = extractClosedListPhrases(md);
  let self = 0;
  for (const phrase of phrases) {
    const dir = sessionWithFinal(reviewBodyForPhrase(phrase));
    const census = reviewCensus(dir);
    if (census.finalReview === 'self') self += 1;
    else {
      throw new Error(
        `phrase ${JSON.stringify(phrase)} graded finalReview=${JSON.stringify(census.finalReview)} (expected self)`,
      );
    }
  }
  return { phrases, self };
}
