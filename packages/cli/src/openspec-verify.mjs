/**
 * OpenSpec verify-change presence and the done/review gate over its report.
 *
 * Vendor OpenSpec ships `openspec-verify-change` / `/opsx:verify` only in the
 * expanded profile. Forge runs that sweep at the end of verify (before the
 * final reviewer) when the skill or slash command is on disk, then demands a
 * session report that attests leftover findings were fixed — including files
 * `tasks.md` never listed. Specs-engine sessions skip this even if a leftover
 * skill file is present.
 */

import fs from 'node:fs';
import path from 'node:path';

export const OPENSPEC_VERIFY_BASENAME = 'openspec-verify.md';

/** Project-local skill / command paths OpenSpec writes for the verify workflow. */
export const OPENSPEC_VERIFY_SKILL_PATHS = Object.freeze([
  '.cursor/skills/openspec-verify-change/SKILL.md',
  '.claude/skills/openspec-verify-change/SKILL.md',
  '.agents/skills/openspec-verify-change/SKILL.md',
  '.codex/skills/openspec-verify-change/SKILL.md',
  '.cursor/commands/openspec-verify-change.md',
  '.cursor/commands/opsx-verify.md',
  '.cursor/commands/opsx-verify-change.md',
  '.claude/commands/openspec-verify-change.md',
  '.claude/commands/opsx-verify.md',
  '.claude/commands/opsx/verify.md',
]);

const REMAINING_NONE_RE = /^\s*(?:[-*]|\d+\.)?\s*Remaining:\s*none\s*$/im;

/**
 * @param {string} cwd
 * @param {{ existsSync?: typeof fs.existsSync }} [opts]
 * @returns {string | null} first matching repo-relative path
 */
export function findOpenSpecVerifySkill(cwd, opts = {}) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  for (const rel of OPENSPEC_VERIFY_SKILL_PATHS) {
    if (existsSync(path.join(cwd, rel))) return rel;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} session
 * @returns {boolean}
 */
export function sessionNeedsOpenSpecVerify(session) {
  return session?.planType === 'openspec';
}

/**
 * The vendor report can say "ready for archive" while still listing
 * SUGGESTION leftovers. Forge's gate reads only this explicit line.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function remainingFindingsCleared(content) {
  return REMAINING_NONE_RE.test(String(content || ''));
}

/**
 * @param {{
 *   cwd: string,
 *   sessionDir: string,
 *   session: Record<string, unknown>,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 * }} opts
 * @returns {{
 *   required: boolean,
 *   ok: boolean,
 *   skillPath: string | null,
 *   reportPath: string,
 *   problem: string | null,
 * }}
 */
export function checkOpenSpecVerifyArtifact(opts) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  const readFileSync = opts.readFileSync ?? fs.readFileSync;
  const reportPath = path.join(opts.sessionDir, OPENSPEC_VERIFY_BASENAME);
  const skillPath = sessionNeedsOpenSpecVerify(opts.session)
    ? findOpenSpecVerifySkill(opts.cwd, { existsSync })
    : null;

  if (!skillPath) {
    return { required: false, ok: true, skillPath: null, reportPath, problem: null };
  }

  if (!existsSync(reportPath)) {
    return {
      required: true,
      ok: false,
      skillPath,
      reportPath,
      problem:
        `missing ${OPENSPEC_VERIFY_BASENAME} — run openspec-verify-change / /opsx:verify, ` +
        'fix every finding (including files not in tasks.md), then write Remaining: none',
    };
  }

  const content = readFileSync(reportPath, 'utf8');
  if (!remainingFindingsCleared(content)) {
    return {
      required: true,
      ok: false,
      skillPath,
      reportPath,
      problem:
        `${OPENSPEC_VERIFY_BASENAME} still has leftover findings — fix them ` +
        '(including files not in tasks.md) or record a design-decision skip, then set Remaining: none',
    };
  }

  return { required: true, ok: true, skillPath, reportPath, problem: null };
}
