#!/usr/bin/env node
/**
 * `forge analyze` — read the durable ledgers back as numbers (see analyze.mjs).
 *
 * Prints and writes nothing. `/forge:analyze` is the narrative command and owns
 * `.forge/reports/`; it calls this for its quantitative source, so two writers
 * never compete for the same file.
 *
 * Exit 0 even with an empty history: "no sessions have finished yet" is an
 * answer, not a failure.
 *
 * Usage:
 *   forge analyze [--json] [--limit <n>] [--since <date>]
 */

import { REPO_ROOT } from './lib.mjs';
import { buildAnalysis, formatAnalysis } from './analyze.mjs';

function usage(stream = process.stderr) {
  stream.write(
    `Usage: forge analyze [--json] [--limit <n>] [--since <date>]
  Aggregates .forge/sessions.jsonl, scorecards.jsonl and any surviving
  metrics.json into coverage, per-model and per-phase totals, and the
  model-policy skip rate. Read-only.
    --json         emit the raw object instead of the table
    --limit <n>    only the n most recent finished sessions
    --since <date> only sessions that ended on or after this date
`,
  );
}

const argv = process.argv.slice(2);
let asJson = false;
let limit = null;
let since = null;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--help' || arg === '-h') {
    usage(process.stdout);
    process.exit(0);
  } else if (arg === '--json') asJson = true;
  else if (arg === '--limit' && argv[i + 1]) limit = Number(argv[(i += 1)]);
  else if (arg === '--since' && argv[i + 1]) since = argv[(i += 1)];
  else {
    process.stderr.write(`Unknown argument: ${arg}\n`);
    usage();
    process.exit(1);
  }
}

const analysis = buildAnalysis({ cwd: REPO_ROOT, limit, since });
process.stdout.write(asJson ? `${JSON.stringify(analysis, null, 2)}\n` : formatAnalysis(analysis));
process.exit(0);
