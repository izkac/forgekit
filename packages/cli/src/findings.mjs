#!/usr/bin/env node
/**
 * Findings ledger — give an observation a home the day it is written.
 *
 * Analysis reports kept re-listing the same unactioned items ("untick 6.2",
 * "the e2e parallel race", "grouping.ts D1 extraction") because nothing turned
 * a report line into tracked work: prose in a gitignored report is not a
 * queue. A finding either becomes a change, a deferral, or an edit made on the
 * spot — or it is a note, and should be labelled one.
 *
 * Library half (`findings-cli.mjs` is the command). Ledger:
 * `.forge/findings.jsonl`, durable across session cleanup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readLedger } from './ledger.mjs';

export const SEVERITIES = ['blocker', 'major', 'minor', 'note'];

/** @param {string} forgeDir */
export function findingsPath(forgeDir) {
  return path.join(forgeDir, 'findings.jsonl');
}

/** @param {string} forgeDir */
export function readFindings(forgeDir) {
  return readLedger(findingsPath(forgeDir));
}

/** @param {string} forgeDir */
export function openFindings(forgeDir) {
  return readFindings(forgeDir).filter((f) => f && f.status === 'open');
}

/**
 * Next id: F1, F2, … Stable across resolves so a report can cite one.
 * @param {Record<string, any>[]} entries
 */
export function nextFindingId(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^F(\d+)$/.exec(String(e?.id ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `F${max + 1}`;
}

/**
 * @param {string} forgeDir
 * @param {Record<string, any>[]} entries
 */
function writeAll(forgeDir, entries) {
  const file = findingsPath(forgeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

/**
 * @param {{ forgeDir: string, text: string, severity?: string, change?: string | null,
 *           session?: { sessionId?: string | null, slug?: string | null }, now?: () => Date }} opts
 */
export function addFinding(opts) {
  const text = String(opts.text ?? '').trim();
  if (!text) throw new Error('A finding needs text: forge finding add "<text>"');
  const severity = opts.severity ?? 'major';
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`Unknown severity "${severity}" (expected ${SEVERITIES.join(' | ')}).`);
  }
  const entries = readFindings(opts.forgeDir);
  const entry = {
    id: nextFindingId(entries),
    text,
    severity,
    status: 'open',
    change: opts.change ?? null,
    sessionId: opts.session?.sessionId ?? null,
    slug: opts.session?.slug ?? null,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  writeAll(opts.forgeDir, [...entries, entry]);
  return entry;
}

/**
 * @param {{ forgeDir: string, id: string, note?: string | null, now?: () => Date }} opts
 */
export function resolveFinding(opts) {
  const entries = readFindings(opts.forgeDir);
  const idx = entries.findIndex((e) => e.id === opts.id);
  if (idx < 0) throw new Error(`No finding with id ${opts.id}. See: forge finding list --all`);
  if (entries[idx].status !== 'open') {
    throw new Error(`Finding ${opts.id} is already ${entries[idx].status}.`);
  }
  entries[idx] = {
    ...entries[idx],
    status: 'resolved',
    note: opts.note ?? entries[idx].note ?? null,
    resolvedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  writeAll(opts.forgeDir, entries);
  return entries[idx];
}
