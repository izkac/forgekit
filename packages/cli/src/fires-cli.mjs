#!/usr/bin/env node
/**
 * `forge fires [--json] [--since <iso>]` — Gate fire counts per gate across
 * the fleet, from the machine-level log (see gate-fires.mjs). Every known gate
 * is listed, zeros included: on 2027-04-24 a gate with no fire is cut or moved
 * behind thorough pace, so the zeros are the answer this report exists for.
 */

import { GATE_IDS, firesLogPath, readGateFires, summarizeGateFires } from './gate-fires.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: forge fires [--json] [--since <iso date>]\n');
  process.exit(0);
}
const json = args.includes('--json');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
if (sinceIdx >= 0 && Number.isNaN(Date.parse(since ?? ''))) {
  process.stderr.write(`--since needs a date, got: ${since ?? '(missing)'}\n`);
  process.exit(1);
}

const log = firesLogPath();
const fires = readGateFires(log).filter((f) => !since || Date.parse(f.at) >= Date.parse(since));
const gates = summarizeGateFires(fires);
const unfired = gates.filter((g) => g.fires === 0).map((g) => g.gate);
const projects = new Set(fires.map((f) => f.project).filter(Boolean)).size;

if (json) {
  process.stdout.write(`${JSON.stringify({ log, since, total: fires.length, projects, gates, unfired }, null, 2)}\n`);
  process.exit(0);
}

const width = Math.max(...gates.map((g) => g.gate.length), 4);
const lines = [
  `Gate fires — ${fires.length} across ${projects} project(s)${since ? ` since ${since}` : ''} (${log})`,
  '',
  `${'GATE'.padEnd(width)}  FIRES  SESSIONS  LAST`,
  ...gates.map(
    (g) => `${g.gate.padEnd(width)}  ${String(g.fires).padStart(5)}  ${String(g.sessions).padStart(8)}  ${g.lastAt ?? '—'}`,
  ),
  '',
  `Never fired (${unfired.length}/${GATE_IDS.length} known): ${unfired.join(', ') || 'none'}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
