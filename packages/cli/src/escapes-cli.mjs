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
 *   forge escapes verify [--all | <session> <commit>] [--json]
 *                                                  replay each candidate's fix test on the fix's parent and on
 *                                                  the fix (needs an `escapes.replay` rule and the exec opt-in)
 *   forge escapes report [--json]                  Escape rate per month of done and per pace, fleet-wide
 */

import path from 'node:path';
import readline from 'node:readline';
import { loadProjectConfig } from './config.mjs';
import { candidateOrigin, decide, doneSessions, escapeReport, pendingCandidates, replayTestFor, tagCandidate, WINDOW_DAYS } from './escapes.mjs';
import { DEFAULT_REPLAY_TIMEOUT_SEC, recordReplay, replayArgv, resolveReplayRule, runReplay, splitArgv } from './escapes-replay.mjs';
import { resolveCallerExecGate } from './exec-gate.mjs';

const USAGE = `Usage:
  forge escapes [list] [--json] [--rev <ref>]
  forge escapes confirm <session> <commit> [--test <path>]
  forge escapes dismiss <session> <commit> [--reason <text>]
  forge escapes verify [--all | <session> <commit>] [--json]
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
 * @param {{ repo?: string, inferred?: string }} [candidate] the listed candidate, when the caller has it; else looked up
 */
function record(session, commit, decision, extra = {}, candidate = undefined) {
  const { repo, inferred } = candidate
    ? { repo: candidate.repo ?? '.', inferred: candidate.inferred ?? null }
    : candidateOrigin({ cwd, sessionId: session.sessionId, commit });
  const res = decide({ cwd, sessionId: session.sessionId, slug: session.slug, commit, decision, repo, inferred, ...extra });
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
    `Escape rate — done Forge sessions with ≥1 confirmed Escape, by month of done and by pace (${report.projects.length} project(s))`,
    '',
    'MONTH     DONE  ESCAPED  RATE  OPEN',
    ...report.months.map(
      (m) => `${m.month}  ${String(m.done).padStart(4)}  ${String(m.escaped).padStart(7)}  ${pct(m.rate)}  ${String(m.open).padStart(4)}`,
    ),
    `total     ${String(report.total.done).padStart(4)}  ${String(report.total.escaped).padStart(7)}  ${pct(report.total.rate)}  ${String(report.total.open).padStart(4)}`,
    '',
    'PACE      DONE  ESCAPED  RATE  OPEN',
    ...report.byPace.map(
      (p) => `${p.pace.padEnd(10)}${String(p.done).padStart(4)}  ${String(p.escaped).padStart(7)}  ${pct(p.rate)}  ${String(p.open).padStart(4)}`,
    ),
    '',
    `Inferred (time-window, sessions recorded before per-repository ranges): ${report.inferred.escaped} of the ${report.total.escaped} escaped session(s) rest only on inferred ranges.`,
    `OPEN = ${WINDOW_DAYS}-day window still running; that month's rate can still rise.`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Which repository a candidate lives in (empty for the root), and whether its range was inferred. @param {{ repo?: string, inferred?: string }} c */
const repoTag = (c) => `${c.repo && c.repo !== '.' ? `repo ${c.repo}: ` : ''}${c.inferred ? `inferred ${c.inferred}: ` : ''}`;

/** What `forge escapes verify` found out about a candidate it could not confirm. @param {{ tag?: { tag: string, reason: string | null } }} c */
const verifyTag = (c) => (c.tag ? `  (verify: ${c.tag.tag}${c.tag.reason ? `: ${c.tag.reason}` : ''})` : '');

/** F16: hit files the change's own plan never names. @param {string[]} files */
const sweepLine = (files) => `  outside plan: ${files.join(', ')} — possible sweep (F16)`;

/** @param {ReturnType<typeof pendingCandidates>} sessions */
function printList(sessions) {
  const out = [];
  let count = 0;
  for (const s of sessions) {
    if (s.skipped) {
      out.push(`${s.sessionId}: skipped — ${s.skipped}`);
      continue;
    }
    const range = s.range ? `${s.range.base.slice(0, 7)}..${s.range.head.slice(0, 7)}${s.inferred ? ' (inferred)' : ''}` : 'nested repos only';
    out.push(`${s.sessionId} (${s.slug ?? '?'}, done ${String(s.doneAt).slice(0, 10)}, ${range}): ${s.candidates.length} candidate(s)`);
    for (const c of s.candidates) {
      count += 1;
      out.push(`  ${c.commit.slice(0, 7)} ${c.at.slice(0, 10)} ${c.subject}  [${repoTag(c)}${c.lines} line(s): ${c.files.join(', ')}]${verifyTag(c)}`);
      if (c.outsidePlan.length) out.push(sweepLine(c.outsidePlan));
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
        `  rewrites ${c.lines} line(s) the change added: ${repoTag(c)}${c.files.join(', ')}\n` +
        (c.outsidePlan.length ? `${sweepLine(c.outsidePlan)}\n` : '') +
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
        record(s, c.commit, 'dismissed', {}, c);
        break;
      }
      if (k === 'c') {
        process.stdout.write('\n');
        if (record(s, c.commit, 'confirmed', {}, c)) break;
        const test = await ask('  replay test path (blank to skip): ');
        if (test) record(s, c.commit, 'confirmed', { replayTest: test }, c);
        break;
      }
    }
  }
}

/**
 * Replay every pending candidate (or the named one): its fix commit's test on the
 * fix's parent and on the fix, classify, record. Executes project commands, so it
 * passes the same gate as `forge evidence -- <cmd>` before anything is created.
 */
async function verify() {
  const all = args.includes('--all');
  const [needle, commitArg] = rest;
  if (!all && !(needle && commitArg)) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const rev = flag('--rev') ?? 'HEAD';
  let sessions;
  if (all) sessions = pendingCandidates({ cwd, rev });
  else {
    const session = findSession(needle);
    sessions = pendingCandidates({ cwd, rev, sessionId: session.sessionId }).map((s) => ({
      ...s,
      candidates: s.candidates.filter((c) => c.commit.startsWith(commitArg)),
    }));
    if (!sessions.some((s) => s.candidates.length)) {
      process.stderr.write(`No undecided candidate ${commitArg} in ${session.sessionId}. Try: forge escapes list\n`);
      process.exit(1);
    }
  }

  const config = /** @type {any} */ (loadProjectConfig(cwd));
  const configured = config.escapes?.replayTimeoutSec;
  const timeoutSec = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REPLAY_TIMEOUT_SEC;
  const work = sessions.flatMap((s) =>
    s.candidates.map((c) => {
      const repo = c.repo ?? '.';
      const testPath = replayTestFor({ cwd: repo === '.' ? cwd : path.join(cwd, repo), commit: c.commit });
      const rule = testPath ? resolveReplayRule(config, repo === '.' ? testPath : `${repo}/${testPath}`) : null;
      return { s, c, repo, testPath, rule };
    }),
  );

  for (const command of new Set(work.flatMap((w) => (w.rule ? [w.rule.command] : [])))) {
    const gate = resolveCallerExecGate({ command: 'forge escapes verify', cmdArgv: splitArgv(command), cwd, forgeDir: path.join(cwd, '.forge') });
    if (!gate.allowed) {
      process.stderr.write(gate.message ?? 'forge escapes verify: execution refused\n');
      process.exit(1);
    }
  }

  const results = [];
  for (const { s, c, repo, testPath, rule } of work) {
    const undecided = (/** @type {string} */ reason) => {
      tagCandidate({ cwd, sessionId: s.sessionId, commit: c.commit, repo, tag: 'undecided', reason });
      return { outcome: 'undecided', reason };
    };
    let res;
    if (!testPath) res = undecided('no-test');
    else if (!rule) res = undecided('no-rule');
    else {
      try {
        const runs = await runReplay({ projectRoot: cwd, repo, fixSha: c.commit, testPath, rule, timeoutSec });
        const command = replayArgv({ repo, testPath, rule }).join(' ');
        res = recordReplay({ cwd, sessionId: s.sessionId, slug: s.slug, candidate: c, testPath, command, ...runs });
      } catch (e) {
        res = undecided(`error: ${e instanceof Error ? e.message : e}`);
      }
    }
    results.push({ session: s.sessionId, commit: c.commit, repo, ...res });
  }

  const count = (/** @type {string} */ outcome) => results.filter((r) => r.outcome === outcome).length;
  const summary = {
    total: results.length,
    confirmed: count('confirmed'),
    environment: count('environment'),
    notReproduced: count('not-reproduced'),
    undecided: count('undecided'),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ results, summary }, null, 2)}\n`);
    return;
  }
  const verdict = (/** @type {{ outcome: string, reason: string | null }} */ r) =>
    r.outcome === 'confirmed' ? 'confirmed (auto)' : r.outcome === 'undecided' ? `undecided: ${r.reason}` : r.outcome;
  const out = results.map((r) => `${r.session} ${r.commit.slice(0, 7)} ${r.repo}: ${verdict(r)}`);
  out.push(
    `${summary.total} candidate(s): ${summary.confirmed} confirmed, ${summary.environment} environment, ${summary.notReproduced} not-reproduced, ${summary.undecided} undecided`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
}

if (sub === 'report') {
  printReport();
} else if (sub === 'verify') {
  await verify();
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
