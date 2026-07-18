#!/usr/bin/env node
/**
 * Re-apply Forge overlays to vendor OpenSpec skills and opsx:apply commands.
 *
 *   forge overlay
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveOverlayDir() {
  const fromEnv = process.env.FORGEKIT_ROOT
    ? path.join(process.env.FORGEKIT_ROOT, 'packages', 'cli', 'src', 'openspec-overlays')
    : null;
  const nextToSrc = path.join(__dirname, 'openspec-overlays');
  for (const c of [fromEnv, nextToSrc].filter(Boolean)) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('openspec-overlays directory not found');
}

const OVERLAY_START = '<!-- forgekit:openspec-overlay:start -->';
const OVERLAY_END = '<!-- forgekit:openspec-overlay:end -->';
const LEGACY_START = '<!-- janus-forge:openspec-overlay:start -->';
const LEGACY_END = '<!-- janus-forge:openspec-overlay:end -->';
const STEP_MARKER = 'REQUIRED (Forge):';
const LEGACY_STEP_MARKER = 'REQUIRED (Janus Forge):';

const AGENT_PATHS = {
  cursor: {
    skillRoot: '.cursor/skills/forge',
    opsxApply: '.cursor/commands/opsx-apply.md',
    applySkill: '.cursor/skills/openspec-apply-change/SKILL.md',
  },
  claude: {
    skillRoot: '.claude/skills/forge',
    opsxApply: '.claude/commands/opsx/apply.md',
    applySkill: '.claude/skills/openspec-apply-change/SKILL.md',
  },
  codex: {
    skillRoot: '.codex/skills/forge',
    opsxApply: null,
    applySkill: '.codex/skills/openspec-apply-change/SKILL.md',
  },
};

function readOverlay(overlayDir, name) {
  return fs.readFileSync(path.join(overlayDir, name), 'utf8');
}

export function renderOverlay(template, agentKey) {
  const root = AGENT_PATHS[agentKey].skillRoot;
  return template
    .replaceAll('{{PHASES_IMPLEMENT}}', `${root}/phases/implement.md`)
    .replaceAll('{{PHASES_VERIFY}}', `${root}/phases/verify.md`)
    .replaceAll('{{PHASES_REVIEW}}', `${root}/phases/review.md`)
    .replaceAll('{{SKILL_ROOT}}', root);
}

export function stripOverlayBlock(content) {
  let out = content;
  for (const [start, end] of [
    [OVERLAY_START, OVERLAY_END],
    [LEGACY_START, LEGACY_END],
  ]) {
    const blockRe = new RegExp(
      `(\\r?\\n---\\r?\\n\\r?\\n)?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\r?\\n?`,
      'g',
    );
    out = out.replace(blockRe, '\n');
  }
  return `${out.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applySkillFooter(content, agentKey, overlayDir = resolveOverlayDir()) {
  const footer = renderOverlay(
    readOverlay(overlayDir, 'openspec-apply-change-footer.md'),
    agentKey,
  );
  let out = stripOverlayBlock(content);
  if (!out.endsWith('\n')) out += '\n';
  return out + footer;
}

const STEP6_RE =
  /(6\. \*\*Implement tasks \(loop until done or blocked\)\*\*\r?\n\r?\n)([\s\S]*?)(\r?\n\r?\n   \*\*Pause if:\*\*)/;

export function patchOpsxApplyContent(content, agentKey, overlayDir = resolveOverlayDir()) {
  if (!STEP6_RE.test(content)) {
    return { content, status: 'no-match' };
  }

  const implementStep = renderOverlay(
    readOverlay(overlayDir, 'opsx-apply-implement-step.md'),
    agentKey,
  );
  let out = content.replace(STEP6_RE, `$1${implementStep}$3`);

  const completionLine = renderOverlay(
    readOverlay(overlayDir, 'opsx-apply-completion-step.md'),
    agentKey,
  ).trimEnd();

  if (/   - If all done:.*\r?\n/.test(out)) {
    out = out.replace(/   - If all done:.*\r?\n/, `${completionLine}\r\n`);
  } else {
    out = out.replace(
      /(7\. \*\*On completion or pause, show status\*\*\r?\n\r?\n   Display:\r?\n)/,
      `$1${completionLine}\r\n`,
    );
  }

  const already =
    content.includes(STEP_MARKER) || content.includes(LEGACY_STEP_MARKER);
  const status = already ? 're-patched' : 'patched';
  return { content: out, status };
}

function patchFile(relPath, transform, label) {
  const abs = path.join(process.cwd(), relPath);
  if (!fs.existsSync(abs)) {
    process.stdout.write(`skip (missing): ${relPath}\n`);
    return 'missing';
  }
  const before = fs.readFileSync(abs, 'utf8');
  const after = transform(before);
  if (after === before) {
    process.stdout.write(`unchanged: ${relPath}\n`);
    return 'unchanged';
  }
  fs.writeFileSync(abs, after, 'utf8');
  process.stdout.write(`${label}: ${relPath}\n`);
  return label;
}

function main() {
  const overlayDir = resolveOverlayDir();

  for (const [agentKey, paths] of Object.entries(AGENT_PATHS)) {
    if (paths.opsxApply) {
      patchFile(
        paths.opsxApply,
        (content) => patchOpsxApplyContent(content, agentKey, overlayDir).content,
        'patched-opsx-apply',
      );
    }

    patchFile(
      paths.applySkill,
      (content) => applySkillFooter(content, agentKey, overlayDir),
      'patched-skill-footer',
    );
  }

  process.stdout.write('\nDone. Forge-owned /forge:apply commands are not modified.\n');
  process.stdout.write('After OpenSpec upgrade: forge overlay\n');
}

const isDirect =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message || err}\n`);
    process.exit(1);
  }
}
