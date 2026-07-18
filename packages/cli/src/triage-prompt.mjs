#!/usr/bin/env node
/**
 * Heuristics for Forge auto-triage on agent UserPromptSubmit hooks.
 * Mirrors references/substantial-work.md — err toward Forge when unsure.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isForgeSkip(prompt) {
  return /^\s*\/forge:skip\b/i.test((prompt || '').trim());
}

export function isForgeInvocation(prompt) {
  return /^\s*\/forge(?::|\s|$)/i.test((prompt || '').trim());
}

export function isTrivialEdit(prompt) {
  const p = (prompt || '').trim();
  if (!p) return true;
  return (
    /\b(typo|formatting only|whitespace only|comment only|rename only|no behavior change|zero behavior)\b/i.test(p)
    || /^\s*fix(ed)?\s+(a|the)?\s*typo\b/i.test(p)
  );
}

export function isReadOnlyQuestion(prompt) {
  const p = (prompt || '').trim();
  if (!p) return true;

  const implementVerb =
    /\b(add|build|implement|create|fix|update|wire|integrate|migrate|refactor|change|modify|delete|remove|make|enable|support|debug|investigate)\b/i;
  const diagnosticFix =
    /\b(doesn'?t|does not|isn'?t|not)\s+(seem to|work|fire|load|trigger|run)\b/i.test(p)
    || /\b(wired correctly|not wired|broken wiring|misconfigured)\b/i.test(p);

  if (diagnosticFix) return false;

  const questionLead =
    /^(what|how does|how do|why|where|when|who|explain|describe|tell me about|can you explain|is there|are there|does the|do we|show me|list|summarize)\b/i;
  if (questionLead.test(p) && !implementVerb.test(p)) return true;

  if (/\?\s*$/.test(p) && !implementVerb.test(p) && !/\b(check if|verify that|audit)\b/i.test(p)) {
    return true;
  }

  return false;
}

export function isSubstantialWork(prompt) {
  const p = (prompt || '').trim();
  if (!p) return false;
  if (isForgeSkip(p)) return false;
  if (isForgeInvocation(p)) return true;
  if (isTrivialEdit(p)) return false;
  if (isReadOnlyQuestion(p)) return false;

  const patterns = [
    /^\s*(please\s+)?(add|build|create|implement|develop|wire|integrate|migrate|port|enable|support|make|change|modify|update|remove|delete|refactor|fix|debug|investigate|set up|setup)\b/i,
    /\b(add|build|implement|create|wire up|hook up)\s+(a|an|the|new)\b/i,
    /\b(doesn'?t|does not|isn'?t)\s+(seem to|work|fire|load|trigger|run)\b/i,
    /\b(bug|regression|broken|misconfigured|not wired)\b/i,
    /\bnew feature\b/i,
    /\bcheck if\b.*\b(wired|configured|working|hook)\b/i,
    /\b(ensure|make sure)\b.*\b(wired|configured|working|fires?)\b/i,
  ];

  return patterns.some((re) => re.test(p));
}

export function shouldForgeTriage(prompt) {
  if (isForgeInvocation(prompt)) return false;
  return isSubstantialWork(prompt);
}

export function buildForgeTriageMessage(options = {}) {
  const {
    hasActiveSession = false,
    skillPath = 'forge skill (SKILL.md)',
    sessionLines = [],
  } = options;

  const lines = [];
  lines.push('[forge] Substantial work detected — triage before implementation.');
  lines.push('');
  lines.push(`1. Read the Forge skill (\`${skillPath}\`) and follow triage (references/substantial-work.md).`);
  if (!hasActiveSession) {
    lines.push('2. If entering Forge: `forge new <slug>` then continue the current phase.');
  } else if (sessionLines.length > 0) {
    lines.push('2. Active session:');
    for (const line of sessionLines) lines.push(`   ${line}`);
  }
  lines.push('3. Skip Forge for this task only: `/forge:skip`');
  lines.push('Guide: Forge skill + forgekit docs/forge.md');
  return lines.join('\n');
}

/**
 * CLI:
 *   forge triage --check "<prompt>"     exit 0 if should triage, else 1
 *   forge triage --message "<prompt>"   print triage reminder (always)
 *   forge triage --message --has-session "<prompt>"
 */
function parseTriageArgs(argv) {
  const opts = {
    check: false,
    message: false,
    hasSession: false,
    help: false,
    prompt: '',
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--message') opts.message = true;
    else if (arg === '--has-session') opts.hasSession = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else rest.push(arg);
  }
  opts.prompt = rest.join(' ').trim();
  return opts;
}

function printTriageHelp() {
  process.stdout.write(`Usage:
  forge triage --check "<prompt>"
  forge triage --message [--has-session] "<prompt>"
`);
}

async function triageMain(argv = process.argv.slice(2)) {
  const opts = parseTriageArgs(argv);
  if (opts.help || (!opts.check && !opts.message)) {
    printTriageHelp();
    return opts.help ? 0 : 1;
  }

  let prompt = opts.prompt;
  if (!prompt && !process.stdin.isTTY) {
    prompt = await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => {
        data += c;
      });
      process.stdin.on('end', () => resolve(data.trim()));
      setTimeout(() => resolve(data.trim()), 1000);
    });
  }

  if (opts.check) {
    return shouldForgeTriage(prompt) ? 0 : 1;
  }

  process.stdout.write(
    `${buildForgeTriageMessage({
      hasActiveSession: opts.hasSession,
      sessionLines: [],
    })}\n`,
  );
  return 0;
}

const isDirect =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  triageMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err.message || err}\n`);
      process.exit(1);
    });
}
