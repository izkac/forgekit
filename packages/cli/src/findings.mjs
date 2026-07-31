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
export const KINDS = ['bug', 'debt', 'tradeoff', 'idea', 'process'];

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

/** @param {unknown} ids */
function normalizeDependencyIds(ids) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) throw new Error('Dependencies must be an array of finding ids.');
  const normalized = ids.map((id) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Dependency ids must not be empty.');
    }
    return id.trim();
  });
  return [...new Set(normalized)];
}

/**
 * @param {Record<string, any>[]} entries
 * @param {string[]} ids
 */
function requireKnownDependencies(entries, ids) {
  for (const id of ids) {
    if (!entries.some((entry) => entry.id === id)) {
      throw new Error(`No finding with id ${id}. See: forge finding list --all`);
    }
  }
}

/**
 * @param {{ forgeDir: string, text: string, kind: string, severity: string, change?: string | null,
 *           dependsOn?: string[], session?: { sessionId?: string | null, slug?: string | null },
 *           now?: () => Date }} opts
 */
export function addFinding(opts) {
  const text = String(opts.text ?? '').trim();
  if (!text) throw new Error('A finding needs text: forge finding add "<text>"');
  const kind = opts.kind;
  if (!kind) {
    throw new Error(`A finding needs kind (expected ${KINDS.join(' | ')}).`);
  }
  if (!KINDS.includes(kind)) {
    throw new Error(`Unknown kind "${kind}" (expected ${KINDS.join(' | ')}).`);
  }
  const severity = opts.severity;
  if (!severity) throw new Error(`A finding needs severity (expected ${SEVERITIES.join(' | ')}).`);
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`Unknown severity "${severity}" (expected ${SEVERITIES.join(' | ')}).`);
  }
  const entries = readFindings(opts.forgeDir);
  const dependsOn = normalizeDependencyIds(opts.dependsOn);
  requireKnownDependencies(entries, dependsOn);
  const entry = {
    id: nextFindingId(entries),
    text,
    kind,
    severity,
    status: 'open',
    change: opts.change ?? null,
    sessionId: opts.session?.sessionId ?? null,
    slug: opts.session?.slug ?? null,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
  writeAll(opts.forgeDir, [...entries, entry]);
  return entry;
}

/**
 * @param {{ forgeDir: string, id: string, dependsOn: string[] }} opts
 */
export function linkFinding(opts) {
  const entries = readFindings(opts.forgeDir);
  const idx = entries.findIndex((entry) => entry.id === opts.id);
  if (idx < 0) throw new Error(`No finding with id ${opts.id}. See: forge finding list --all`);
  const dependsOn = normalizeDependencyIds(opts.dependsOn);
  requireKnownDependencies(entries, dependsOn);
  const existing = normalizeDependencyIds(entries[idx].dependsOn);
  entries[idx] = {
    ...entries[idx],
    dependsOn: [...new Set([...existing, ...dependsOn])],
  };
  writeAll(opts.forgeDir, entries);
  return entries[idx];
}

/**
 * @param {{ forgeDir: string, id: string, note?: string | null, now?: () => Date }} opts
 */
export function resolveFinding(opts) {
  const entries = readFindings(opts.forgeDir);
  const idx = entries.findIndex((e) => e.id === opts.id);
  if (idx < 0) throw new Error(`No finding with id ${opts.id}. See: forge finding list --all`);
  if (entries[idx].status !== 'open') {
    // AMENDING A RESOLUTION NOTE IS THE POINT, NOT AN EDGE CASE. Refusing
    // outright is what this used to do, and the cost is on the record: F31's
    // note kept its round-1 text through three attempted corrections, and F52
    // exists **only** because F49's note could not be amended — a second
    // finding filed to carry a correction to the first. That is F42.
    //
    // A bare re-resolve is still refused: with nothing to add it is either a
    // mistake or a no-op, and answering "fine" to both is how the silence
    // started. `resolvedAt` keeps its original value — the finding was resolved
    // then, not now — and the superseded note is kept rather than overwritten,
    // because a durable record that quietly loses its previous text is the same
    // defect one layer down.
    const amended = typeof opts.note === 'string' && opts.note.trim() !== '';
    if (!amended) {
      throw new Error(
        `Finding ${opts.id} is already ${entries[idx].status}. ` +
          'To correct its note: forge finding resolve ' +
          `${opts.id} --note "<text>"`,
      );
    }
    const previous = entries[idx].note;
    entries[idx] = {
      ...entries[idx],
      note: opts.note,
      noteHistory: [
        ...(Array.isArray(entries[idx].noteHistory) ? entries[idx].noteHistory : []),
        ...(typeof previous === 'string' && previous.trim() !== '' ? [previous] : []),
      ],
      amendedAt: (opts.now?.() ?? new Date()).toISOString(),
    };
    writeAll(opts.forgeDir, entries);
    return { entry: entries[idx], dependents: [] };
  }
  const dependents = entries.filter(
    (entry) => entry.status === 'open' && Array.isArray(entry.dependsOn) && entry.dependsOn.includes(opts.id),
  );
  entries[idx] = {
    ...entries[idx],
    status: 'resolved',
    note: opts.note ?? entries[idx].note ?? null,
    resolvedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  writeAll(opts.forgeDir, entries);
  return { entry: entries[idx], dependents };
}
