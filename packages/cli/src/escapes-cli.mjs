#!/usr/bin/env node
/**
 * `forge escapes` — Escape candidates for this repository's done sessions, the
 * operator's verdict on each, and the Escape rate across the fleet.
 *
 * Usage:
 *   forge escapes [list] [--json] [--rev <ref>]   candidates still undecided
 *                                                  (bare, on a terminal: decide one keystroke each)
 *   forge escapes confirm <session> <commit> [--test <path>]
 *   forge escapes dismiss <session> <commit> [--reason <text>]
 *   forge escapes report [--json]                  Escape rate per month of done, fleet-wide
 */

import readline from 'node:readline';
import { decide, doneSessions, escapeReport, pendingCandidates, WINDOW_DAYS } from './escapes.mjs';

const USAGE = `Usage:
  forge escapes [list] [--json] [--rev <ref>]
  forge escapes confirm <session> <commit> [--test <path>]
  forge escapes dismiss <session> <commit> [--reason <text>]
  forge escapes report [--json]
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const cwd = process.cwd();
const json = args.includes('--json');
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--rev', '--test', '--reason'].includes(args[i - 1]));
const [sub = null, ...rest] = positional;

/** @param {string} needle */
function findSession(needle) {
  const sessions = doneSessions({ cwd });
  const exact = sessions.filter((s) => s.sessionId === needle || s.slug === needle);
  const matches = exact.length ? exact : sessions.filter((s) => s.sessionId.includes(needle));
  if (matches.length === 1) return matches[0];
  process.stderr.write(
    matches.length === 0
      ? `No done session matches "${needle}" in this repository. Try: forge escapes list\n`
      : `Ambiguous "${needle}": ${matches.map((m) => m.sessionId).join(', ')}\n`,
  );
  process.exit(1);
}

/**
 * @param {{ sessionId: string, slug: string | null }} session
 * @param {string} commit
 * @param {'confirmed' | 'dismissed'} decision
 * @param {{ replayTest?: string | null, reason?: string | null }} [extra]
 */
function record(session, commit, decision, extra = {}) {
  const res = decide({ cwd, sessionId: session.sessionId, slug: session.slug, commit, decision, ...extra });
  if (!res.ok) {
    process.stderr.write(`${res.error}\n`);
    return false;
  }
  const what = decision === 'confirmed' ? `Escape confirmed (replay test: ${res.entry.replayTest})` : 'dismissed';
  process.stdout.write(`${session.sessionId} ${res.entry.commit.slice(0, 7)}: ${what}\n`);
  return true;
}

function printReport() {
  const report = escapeReport({ cwd });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const pct = (r) => `${(r * 100).toFixed(0)}%`.padStart(5);
  const lines = [
    `Escape rate — done Forge sessions with ≥1 confirmed Escape, by month of done (${report.projects.length} project(s))`,
    '',
    'MONTH     DONE  ESCAPED  RATE  OPEN',
    ...report.months.map(
      (m) => `${m.month}  ${String(m.done).padStart(4)}  ${String(m.escaped).padStart(7)}  ${pct(m.rate)}  ${String(m.open).padStart(4)}`,
    ),
    `total     ${String(report.total.done).padStart(4)}  ${String(report.total.escaped).padStart(7)}  ${pct(report.total.rate)}  ${String(report.total.open).padStart(4)}`,
    '',
    `OPEN = ${WINDOW_DAYS}-day window still running; that month's rate can still rise.`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** @param {ReturnType<typeof pendingCandidates>} sessions */
function printList(sessions) {
  const out = [];
  let count = 0;
  for (const s of sessions) {
    if (s.skipped) {
      out.push(`${s.sessionId}: skipped — ${s.skipped}`);
      continue;
    }
    const range = `${s.range?.base.slice(0, 7)}..${s.range?.head.slice(0, 7)}${s.inferred ? ' (inferred)' : ''}`;
    out.push(`${s.sessionId} (${s.slug ?? '?'}, done ${String(s.doneAt).slice(0, 10)}, ${range}): ${s.candidates.length} candidate(s)`);
    for (const c of s.candidates) {
      count += 1;
      out.push(`  ${c.commit.slice(0, 7)} ${c.at.slice(0, 10)} ${c.subject}  [${c.lines} line(s): ${c.files.join(', ')}]`);
    }
  }
  out.push('', `${count} undecided candidate(s). Decide: forge escapes confirm|dismiss <session> <commit>`);
  process.stdout.write(`${out.join('\n')}\n`);
}

/** One keystroke from the terminal, lower-cased; Ctrl-C reads as quit. */
function key() {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (d) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const k = d.toString().toLowerCase();
      resolve(k === '\u0003' ? 'q' : k);
    });
  });
}

/** @param {string} prompt */
function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** @param {ReturnType<typeof pendingCandidates>} sessions */
async function interactive(sessions) {
  const queue = sessions.flatMap((s) => s.candidates.map((c) => ({ s, c })));
  for (const s of sessions) if (s.skipped) process.stdout.write(`${s.sessionId}: skipped — ${s.skipped}\n`);
  if (queue.length === 0) {
    process.stdout.write('No undecided Escape candidates.\n');
    return;
  }
  let n = 0;
  for (const { s, c } of queue) {
    n += 1;
    process.stdout.write(
      `\n[${n}/${queue.length}] ${s.sessionId} (${s.slug ?? '?'}, done ${String(s.doneAt).slice(0, 10)})\n` +
        `  ${c.commit.slice(0, 7)} ${c.at.slice(0, 10)} ${c.subject}\n` +
        `  rewrites ${c.lines} line(s) the change added: ${c.files.join(', ')}\n` +
        '  [c]onfirm Escape  [d]ismiss  [s]kip  [q]uit > ',
    );
    for (;;) {
      const k = await key();
      if (k === 'q') {
        process.stdout.write('quit\n');
        return;
      }
      if (k === 's') {
        process.stdout.write('skipped\n');
        break;
      }
      if (k === 'd') {
        process.stdout.write('\n');
        record(s, c.commit, 'dismissed');
        break;
      }
      if (k === 'c') {
        process.stdout.write('\n');
        if (record(s, c.commit, 'confirmed')) break;
        const test = await ask('  replay test path (blank to skip): ');
        if (test) record(s, c.commit, 'confirmed', { replayTest: test });
        break;
      }
    }
  }
}

if (sub === 'report') {
  printReport();
} else if (sub === 'confirm' || sub === 'dismiss') {
  const [needle, commit] = rest;
  if (!needle || !commit) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const session = findSession(needle);
  const ok =
    sub === 'confirm'
      ? record(session, commit, 'confirmed', { replayTest: flag('--test') })
      : record(session, commit, 'dismissed', { reason: flag('--reason') });
  process.exit(ok ? 0 : 1);
} else if (sub === null || sub === 'list') {
  const sessions = pendingCandidates({ cwd, rev: flag('--rev') ?? 'HEAD' });
  if (json) {
    process.stdout.write(`${JSON.stringify({ sessions }, null, 2)}\n`);
  } else if (sub === null && process.stdin.isTTY && process.stdout.isTTY) {
    await interactive(sessions);
  } else {
    printList(sessions);
  }
} else {
  process.stderr.write(`Unknown subcommand: ${sub}\n${USAGE}`);
  process.exit(1);
}
