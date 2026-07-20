#!/usr/bin/env node
/**
 * Operator brief core — a plain-language, self-contained HTML explanation of
 * what will be built, written by the agent at the end of the plan phase into
 * `<changeDir>/brief.html`. CLI in brief-cli.mjs (`forge brief`).
 *
 * Freshness: `stampBrief` records a hash of proposal.md/design.md/tasks.md
 * inside brief.html. When the specs change afterwards the brief goes stale and
 * the hard gate in `forge phase implement` refuses until it is rewritten and
 * re-stamped — same executed-evidence philosophy as the e2e gate.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveChangeDir } from './integrity.mjs';

export const BRIEF_FILE = 'brief.html';
const HASH_MARKER = /<!--\s*forge-brief-specs-hash:([a-f0-9]+)\s*-->/;
const SPEC_FILES = ['proposal.md', 'design.md', 'tasks.md'];

/** Hash of the spec sources a brief must reflect (missing files hash as absent). */
export function specsHash(changeDir) {
  const h = crypto.createHash('sha256');
  for (const name of SPEC_FILES) {
    const file = path.join(changeDir, name);
    h.update(name);
    h.update(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<absent>');
  }
  return h.digest('hex').slice(0, 16);
}

export function briefPath(changeDir) {
  return path.join(changeDir, BRIEF_FILE);
}

export function readBriefHash(file) {
  if (!fs.existsSync(file)) return null;
  const match = fs.readFileSync(file, 'utf8').match(HASH_MARKER);
  return match ? match[1] : null;
}

/** Write/replace the freshness marker in brief.html. Returns the stamped hash. */
export function stampBrief(changeDir) {
  const file = briefPath(changeDir);
  if (!fs.existsSync(file)) {
    throw new Error(`No ${BRIEF_FILE} in ${changeDir} — write the operator brief first.`);
  }
  const hash = specsHash(changeDir);
  let html = fs.readFileSync(file, 'utf8');
  const marker = `<!-- forge-brief-specs-hash:${hash} -->`;
  html = HASH_MARKER.test(html) ? html.replace(HASH_MARKER, marker) : `${marker}\n${html}`;
  fs.writeFileSync(file, html, 'utf8');
  return hash;
}

/**
 * Brief status for a session.
 *
 * @param {{ cwd?: string, session: Record<string, any> }} opts
 * @returns {{ ok: boolean, reason: 'not-applicable'|'fresh'|'missing'|'unstamped'|'stale', path: string | null }}
 */
export function checkBrief(opts) {
  const { session } = opts;
  const changeDir = resolveChangeDir(opts);
  // Brief only applies to tracked-change plans; direct/throwaway have no specs
  // for an operator to review.
  if (!changeDir || session.planType === 'direct' || session.planType === 'throwaway') {
    return { ok: true, reason: 'not-applicable', path: null };
  }
  const file = briefPath(changeDir);
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing', path: file };
  const stamped = readBriefHash(file);
  if (!stamped) return { ok: false, reason: 'unstamped', path: file };
  if (stamped !== specsHash(changeDir)) return { ok: false, reason: 'stale', path: file };
  return { ok: true, reason: 'fresh', path: file };
}

/** Human-readable problem line for a failed check, null when ok. */
export function briefProblem(result) {
  switch (result.reason) {
    case 'missing':
      return `operator brief missing — write ${result.path} (plain-language HTML, see forge references/operator-brief.md), then run forge brief stamp`;
    case 'unstamped':
      return 'operator brief not stamped — run forge brief stamp (records specs hash + opens it for the operator)';
    case 'stale':
      return `operator brief is stale — specs changed after it was written; update ${result.path} and re-run forge brief stamp`;
    default:
      return null;
  }
}

/** Open a file with the OS default handler (fire-and-forget). */
export function openInBrowser(file) {
  const target = path.resolve(file);
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
