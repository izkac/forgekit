#!/usr/bin/env node
/**
 * `forge metrics` — harvest how a session actually ran (see metrics/collect.mjs).
 *
 * `forge phase finish|done` collects automatically; this is the same collector
 * on demand, for a session still in flight or one whose numbers you want
 * refreshed without ending it. It is also the only way to look at a *past*
 * session's metrics before `forge cleanup` deletes the directory — after that
 * only the compact digest in `.forge/sessions.jsonl` survives.
 *
 * `available: false` is not an error. Running outside a host agent, or against
 * a transcript the host has pruned, is an ordinary outcome and exits 0 with the
 * reason recorded in the file — the same document `forge phase done` would
 * write. Non-zero is reserved for genuine misuse: no session, unknown id, bad
 * flag. Anything else would make telemetry able to fail a phase transition,
 * which is exactly what this whole subsystem promises never to do.
 *
 * Usage:
 *   forge metrics collect [--session <id>] [--json] [--force]
 */

import path from 'node:path';
import { REPO_ROOT, loadSession, readActive } from './lib.mjs';
import { collectMetrics, writeMetrics } from './metrics/collect.mjs';

/** Asked-for help goes to stdout; usage shown because of a mistake goes to stderr. */
function usage(stream = process.stderr) {
  stream.write(
    `Usage:
  forge metrics collect [--session <id>] [--json] [--force]
     Read the host transcripts this session is bound to and write
     metrics.json into the session directory.
     --session <id>  collect a session other than the active one
     --json          print the whole document instead of a one-line summary
     --force         replace an existing document even when this collection
                     produced no numbers (a pruned transcript, say)
`,
  );
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** @param {number} n */
function count(n) {
  return n.toLocaleString('en-US');
}

/**
 * One line that answers "what did this session cost", or why it cannot say.
 *
 * @param {Record<string, any>} doc
 * @param {string} sessionId
 * @returns {string}
 */
function summarise(doc, sessionId) {
  if (doc.available !== true) return `No metrics for ${sessionId}: ${doc.reason}`;
  const t = doc.tokens ?? {};
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreate ?? 0);
  const models = Object.keys(doc.byModel ?? {}).sort();
  const errors = doc.errors ?? {};
  return (
    `${sessionId}: ${count(doc.requests ?? 0)} requests, ${count(total)} tokens ` +
    `(${count(t.output ?? 0)} out), ${count((doc.subagents ?? []).length)} subagents, ` +
    `${errors.errorResults ?? 0}/${errors.toolResults ?? 0} tool calls failed` +
    `${models.length ? ` — ${models.join(', ')}` : ''}`
  );
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage(cmd ? process.stdout : process.stderr);
  process.exit(cmd ? 0 : 1);
}

if (cmd !== 'collect') {
  usage();
  fail(`Unknown subcommand: ${cmd}`);
}

let sessionId = null;
let asJson = false;
let force = false;
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--session' && argv[i + 1]) sessionId = argv[(i += 1)];
  else if (argv[i] === '--session') fail('--session needs a session id');
  else if (argv[i] === '--json') asJson = true;
  else if (argv[i] === '--force') force = true;
  else fail(`Unknown argument: ${argv[i]}`);
}

if (!sessionId) sessionId = readActive()?.sessionId ?? null;
if (!sessionId) fail('No active session. Run forge new first, or pass --session <id>.');

let dir;
let session;
try {
  ({ dir, session } = loadSession(sessionId));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const doc = collectMetrics({ session, sessionDir: dir, env: process.env });
const { written, kept, file, error } = writeMetrics({ sessionDir: dir, doc, force });

process.stdout.write(
  asJson ? `${JSON.stringify(doc, null, 2)}\n` : `${summarise(doc, sessionId)}\n`,
);
const where = path.relative(REPO_ROOT, file) || file;
if (written) process.stderr.write(`Wrote ${where}\n`);
else if (kept) {
  process.stderr.write(
    `Kept the existing ${where} — it holds real numbers and this collection could not. ` +
      'Re-run with --force to replace it.\n',
  );
} else {
  process.stderr.write(`[forge] Warning: could not write ${where}: ${error}\n`);
}
process.exit(0);
