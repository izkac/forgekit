#!/usr/bin/env node
/**
 * Known-false ledger — negative memory for a session.
 *
 * A reviewer REJECT, a red gate, or a failed tier-3 run refutes something the
 * implementer believed. Until now that refutation lived in prose
 * (`task-review.md`, a fix-round brief) and a re-dispatched implementer — or a
 * fresh context after compaction — could propose the same wrong assumption
 * again. This records each refuted claim as one JSON line the next brief can
 * carry verbatim, the way reverify keeps `KNOWN FALSE` beside its verified
 * facts: nothing unverified goes in, only what a judge actually contradicted.
 *
 * Usage:
 *   forge refute add --task <nn-slug> --claim "<what was believed>" --actual "<what the evidence showed>"
 *                    [--source reviewer|gate|e2e|tier3|tdd|operator] [--session <id>]
 *   forge refute list [--task <nn-slug>] [--json|--md] [--session <id>]
 *
 * Ledger: `.forge/sessions/<id>/known-false.jsonl`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSessionOrExit, sessionPath } from './lib.mjs';

export const SOURCES = ['reviewer', 'gate', 'e2e', 'tier3', 'tdd', 'operator'];
export const KNOWN_FALSE_FILE = 'known-false.jsonl';

/** @param {string} sessionDir */
export function knownFalsePath(sessionDir) {
  return path.join(sessionDir, KNOWN_FALSE_FILE);
}

/**
 * @param {string} sessionDir
 * @returns {Record<string, any>[]}
 */
export function readRefutations(sessionDir) {
  const file = knownFalsePath(sessionDir);
  if (!fs.existsSync(file)) return [];
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written line must not hide the rest.
    }
  }
  return out;
}

/**
 * @param {string} sessionDir
 * @param {{ task: string, claim: string, actual: string, source?: string }} entry
 * @param {() => Date} [now]
 */
export function addRefutation(sessionDir, entry, now = () => new Date()) {
  for (const field of ['task', 'claim', 'actual']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new Error(`--${field} is required`);
    }
  }
  const source = entry.source ?? 'reviewer';
  if (!SOURCES.includes(source)) {
    throw new Error(`--source must be one of ${SOURCES.join('|')}, got: ${source}`);
  }
  const existing = readRefutations(sessionDir);
  const record = {
    id: `KF${existing.length + 1}`,
    task: entry.task.trim(),
    claim: entry.claim.trim(),
    actual: entry.actual.trim(),
    source,
    at: now().toISOString(),
  };
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.appendFileSync(knownFalsePath(sessionDir), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * @param {string} sessionDir
 * @param {{ task?: string | null }} [opts]
 */
export function listRefutations(sessionDir, opts = {}) {
  const all = readRefutations(sessionDir);
  return opts.task ? all.filter((r) => r.task === opts.task) : all;
}

/**
 * The block a coordinator pastes into an implementer brief's `{KNOWN_FALSE}`.
 * @param {Record<string, any>[]} entries
 */
export function renderKnownFalseMd(entries) {
  if (entries.length === 0) return 'none recorded';
  return entries
    .map((r) => `- ${r.id} [${r.source}, ${r.task}]: ${r.claim} → **actual:** ${r.actual}`)
    .join('\n');
}

function usage() {
  process.stderr.write(
    `Usage:
  forge refute add --task <nn-slug> --claim "<what was believed>" --actual "<what the evidence showed>" [--source ${SOURCES.join('|')}] [--session <id>]
  forge refute list [--task <nn-slug>] [--json|--md] [--session <id>]
`,
  );
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { sub: argv[0] ?? null, task: null, claim: null, actual: null, source: null, session: null, json: false, md: false, help: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--task') opts.task = argv[++i];
    else if (a === '--claim') opts.claim = argv[++i];
    else if (a === '--actual') opts.actual = argv[++i];
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--md') opts.md = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`forge refute: ${/** @type {Error} */ (err).message}\n`);
    usage();
    process.exit(1);
  }
  if (opts.help || opts.sub === '--help' || opts.sub === '-h') {
    usage();
    process.exit(0);
  }
  if (opts.sub !== 'add' && opts.sub !== 'list') {
    usage();
    process.exit(1);
  }
  const sessionId = resolveSessionOrExit(opts.session, { command: 'forge refute', strict: false });
  const sessionDir = sessionPath(sessionId);
  try {
    if (opts.sub === 'add') {
      const record = addRefutation(sessionDir, {
        task: opts.task,
        claim: opts.claim,
        actual: opts.actual,
        source: opts.source ?? undefined,
      });
      process.stdout.write(`${record.id} recorded in ${knownFalsePath(sessionDir)}\n`);
      return;
    }
    const entries = listRefutations(sessionDir, { task: opts.task });
    if (opts.json) process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    else process.stdout.write(`${renderKnownFalseMd(entries)}\n`);
  } catch (err) {
    process.stderr.write(`forge refute: ${/** @type {Error} */ (err).message}\n`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) main();
