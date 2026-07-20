#!/usr/bin/env node
/**
 * Fleet control terminal — see and command every forge session on this
 * machine, across projects and engines.
 *
 * Usage:
 *   forge fleet list [--json]
 *   forge fleet watch [--interval <sec>]
 *   forge fleet view <session> [--transcript [N]]
 *   forge fleet send <session>|--all <message...>
 *
 * <session> matches by sessionId, slug, or project name; must be unique.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  PHASE_ORDER,
  listFleet,
  newestTranscript,
  peekInbox,
  queueMessage,
  sessionDirFor,
} from './lib/fleet.mjs';

function usage() {
  process.stderr.write(
    `Usage:
  forge fleet list [--json]
  forge fleet watch [--interval <sec>]
  forge fleet view <session> [--transcript [N]]
  forge fleet send <session>|--all <message...>
`,
  );
  process.exit(1);
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '?';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function phaseBar(phase) {
  const idx = PHASE_ORDER.indexOf(phase);
  if (phase === 'skipped') return 'skipped';
  if (idx < 0) return phase;
  const total = PHASE_ORDER.length - 1; // done = full bar
  return `${'█'.repeat(idx)}${'░'.repeat(total - idx)} ${phase}`;
}

function tasksCell(entry) {
  const total = Number(entry.tasksTotal) || 0;
  if (total === 0) return '—';
  const complete = Number(entry.tasksComplete) || 0;
  const width = 8;
  const filled = Math.round((complete / total) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${complete}/${total}`;
}

function pad(str, len) {
  const s = String(str ?? '');
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function renderTable(entries) {
  if (entries.length === 0) return 'No fleet sessions. Start one with `forge new <slug>`.\n';
  const header = `${pad('PROJECT', 18)} ${pad('SESSION', 26)} ${pad('ENGINE', 7)} ${pad('PHASE', 18)} ${pad('TASKS', 13)} ${pad('PACE', 9)} ${pad('AGE', 4)} MSGS`;
  const lines = [header, '-'.repeat(header.length)];
  for (const e of entries) {
    const pending = e.missing ? 0 : peekInbox(sessionDirFor(e)).length;
    lines.push(
      `${pad(e.projectName, 18)} ${pad(e.slug, 26)} ${pad(e.engine ?? '—', 7)} ${pad(
        e.missing ? 'missing' : phaseBar(e.phase),
        18,
      )} ${pad(tasksCell(e), 13)} ${pad(e.pace ?? '—', 9)} ${pad(relTime(e.updatedAt), 4)} ${
        pending > 0 ? `✉ ${pending}` : ''
      }`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Resolve a user-supplied needle to exactly one fleet entry. */
function findEntry(needle) {
  const entries = listFleet();
  const matches = entries.filter(
    (e) =>
      e.sessionId === needle ||
      e.sessionId.includes(needle) ||
      e.slug === needle ||
      e.projectName === needle,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    process.stderr.write(`No fleet session matches "${needle}". Try: forge fleet list\n`);
  } else {
    process.stderr.write(
      `Ambiguous "${needle}" — matches:\n${matches
        .map((m) => `  ${m.sessionId} (${m.projectName})`)
        .join('\n')}\n`,
    );
  }
  process.exit(1);
}

function cmdList(args) {
  const entries = listFleet();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(entries));
  }
}

function cmdWatch(args) {
  const i = args.indexOf('--interval');
  const interval = Math.max(1, Number(i >= 0 ? args[i + 1] : 3) || 3) * 1000;
  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`forge fleet — ${new Date().toLocaleTimeString()} (Ctrl+C to exit)\n\n`);
    process.stdout.write(renderTable(listFleet()));
  };
  render();
  setInterval(render, interval);
}

/**
 * ponytail: transcript view is best-effort — newest jsonl in the project's
 * Claude dir, not a verified session link. Upgrade path: SessionStart hook
 * records claudeSessionId in the registry entry.
 */
function tailTranscript(entry, count) {
  const file = newestTranscript(entry.project);
  if (!file) {
    process.stdout.write('No Claude Code transcript found for this project.\n');
    return;
  }
  process.stdout.write(`Transcript (newest in project): ${file}\n\n`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const turns = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[tool: ${c.name}]` : ''))
        .filter(Boolean)
        .join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) turns.push(`${rec.type === 'user' ? '>' : '<'} ${text.slice(0, 300)}`);
  }
  process.stdout.write(`${turns.slice(-count).join('\n\n')}\n`);
}

function cmdView(args) {
  if (!args[0]) usage();
  const entry = findEntry(args[0]);
  const ti = args.indexOf('--transcript');
  const sessionDir = sessionDirFor(entry);

  process.stdout.write(`${entry.projectName} · ${entry.slug}\n`);
  process.stdout.write(`  Session:  ${entry.sessionId}\n`);
  process.stdout.write(`  Project:  ${entry.project}\n`);
  process.stdout.write(`  Engine:   ${entry.engine ?? 'unknown'}\n`);
  process.stdout.write(`  Phase:    ${phaseBar(entry.phase)}\n`);
  process.stdout.write(`  Tasks:    ${tasksCell(entry)}\n`);
  process.stdout.write(`  Pace:     ${entry.pace ?? '—'}\n`);
  process.stdout.write(`  Change:   ${entry.openspecChange ?? '—'} (${entry.planType ?? 'pending'})\n`);
  const rel = relTime(entry.updatedAt);
  process.stdout.write(`  Updated:  ${entry.updatedAt}${rel === 'now' ? '' : ` (${rel} ago)`}\n`);

  const pending = entry.missing ? [] : peekInbox(sessionDir);
  if (pending.length > 0) {
    process.stdout.write(`\n  Pending fleet messages (${pending.length}):\n`);
    for (const m of pending) process.stdout.write(`    • ${m.text.split('\n')[0]}\n`);
  }
  const evidence = path.join(sessionDir, 'verify-evidence.md');
  if (fs.existsSync(evidence)) process.stdout.write(`  Evidence: ${evidence}\n`);

  if (ti >= 0) {
    const count = Number(args[ti + 1]) || 20;
    process.stdout.write('\n');
    tailTranscript(entry, count);
  }
}

function cmdSend(args) {
  const all = args[0] === '--all';
  const message = (all ? args.slice(1) : args.slice(1)).join(' ').trim();
  if (!args[0] || !message) usage();

  const targets = all ? listFleet().filter((e) => !e.missing) : [findEntry(args[0])];
  for (const entry of targets) {
    const file = queueMessage(sessionDirFor(entry), message);
    process.stdout.write(
      `Queued for ${entry.projectName}/${entry.slug} → delivered on its next turn (${file})\n`,
    );
  }
  if (targets.length === 0) process.stdout.write('No reachable fleet sessions.\n');
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list':
    cmdList(rest);
    break;
  case 'watch':
    cmdWatch(rest);
    break;
  case 'view':
    cmdView(rest);
    break;
  case 'send':
    cmdSend(rest);
    break;
  default:
    usage();
}
