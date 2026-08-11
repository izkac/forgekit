#!/usr/bin/env node
/**
 * Suppression filter for Forge auto-triage on agent UserPromptSubmit hooks.
 * references/substantial-work.md holds the agent's judgment criteria for
 * whether work is substantial — this module does not decide that. It only
 * decides whether to ask: it suppresses prompts that carry no work content
 * and lets everything else reach the agent as a question, not a verdict.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isForgeSkip(prompt) {
  return /^\s*\/forge:skip\b/i.test((prompt || '').trim());
}

export function isForgeInvocation(prompt) {
  return /^\s*\/forge(?::|\s|$)/i.test((prompt || '').trim());
}

// Unconditional trivial markers: whenever these words appear, the prompt is
// describing an edit to existing trivial content (typo, whitespace, a
// comment, or an explicit "no behaviour change" claim) — there is no
// plausible reading where they describe something new being built.
const TRIVIAL_MARKERS =
  /\b(typo|formatting[\s-]only|whitespace[\s-]only|comment[\s-]only|no behaviou?r change|zero behaviou?r)\b/i;

// Conditional trivial markers: `changelog`, `docs-only`, `documentation-only`
// and `rename-only` are ambiguous on their own. "Update the changelog" and
// "Fix docs-only sections of the guide" use the marker as the direct object
// of an edit — genuinely trivial. "Add a changelog generator" and "Build a
// docs-only publishing pipeline" use the identical word as a modifier inside
// a compound noun naming something new being BUILT — a feature request, not
// an edit, and `changelog` in particular is a plain noun with no assertion
// about the edit's nature at all. The two readings share no reliable lexical
// boundary, but they do share a verb: an edit-only prompt never pairs the
// marker with a creation verb (add/build/create/implement/…), because there
// is nothing new to add/build/create — only something existing to fix.
const NARROW_TRIVIAL_MARKERS = /\b(changelog|docs[\s-]only|documentation[\s-]only|rename[\s-]only)\b/i;
const CREATION_VERB =
  /\b(add(?:s|ed|ing)?|build(?:s|ing)?|built|creat(?:e|es|ed|ing)|implement(?:s|ed|ing)?|develop(?:s|ed|ing)?|writ(?:e|es|ing)|wrote|design(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|mak(?:e|es|ing)|made)\b/i;

export function isTrivialEdit(prompt) {
  const p = (prompt || '').trim();
  if (!p) return true;
  if (TRIVIAL_MARKERS.test(p)) return true;
  if (NARROW_TRIVIAL_MARKERS.test(p) && !CREATION_VERB.test(p)) return true;
  return /^\s*fix(ed)?\s+(a|the)?\s*typo\b/i.test(p);
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

// Bare acknowledgments and procedural asks that keep an existing
// conversation moving without requesting new work. The fail-closed default
// in hasWorkContent must not let the filter ask the agent about every reply
// in a live session — only prompts that could plausibly be a work request
// should reach the agent as a question.
// "run the tests" is included: it invokes existing tooling and asks for no
// code change, the same posture isReadOnlyQuestion already gives read-only
// asks. A prompt that also asks for a change on top ("run the tests and fix
// what's failing") is longer than this exact-match list and falls through
// to the fail-closed default untouched.
const CONVERSATIONAL_REPLIES = new Set([
  'continue', 'ok', 'okay', 'yes', 'no', 'sure', 'thanks', 'thank you',
  'great', 'nice', 'cool', 'got it', 'sounds good', 'go ahead',
  'ok go ahead', 'okay go ahead', 'alright', 'yep', 'yup', 'nope',
  'hmm', 'hm', 'k', 'kk', 'please continue', 'keep going',
]);

const RUN_TESTS_ONLY = /^\s*(please\s+)?run\s+(the\s+)?tests?\s*[.!]?\s*$/i;

export function isConversationalReply(prompt) {
  const p = (prompt || '').trim();
  if (!p) return false;
  const normalized = p.toLowerCase().replace(/[!.?,]+$/g, '').trim();
  if (CONVERSATIONAL_REPLIES.has(normalized)) return true;
  return RUN_TESTS_ONLY.test(p);
}

export function hasWorkContent(prompt) {
  const p = (prompt || '').trim();
  if (!p) return false;
  if (isForgeSkip(p)) return false;
  if (isForgeInvocation(p)) return true;
  if (isTrivialEdit(p)) return false;
  if (isReadOnlyQuestion(p)) return false;
  if (isConversationalReply(p)) return false;

  // Fail closed: anything left is not an empty prompt, not a /forge:skip,
  // not a trivial edit, not a read-only question, and not a conversational
  // or procedural reply — unclear scope errs toward Forge rather than
  // skipping it by default.
  return true;
}

export function shouldForgeTriage(prompt) {
  if (isForgeInvocation(prompt)) return false;
  return hasWorkContent(prompt);
}

export function buildForgeTriageMessage(options = {}) {
  const {
    hasActiveSession = false,
    skillPath = 'forge skill (SKILL.md)',
    sessionLines = [],
  } = options;

  const lines = [];
  lines.push('[forge] Decide: does this prompt need Forge before you implement?');
  lines.push('');
  lines.push(`1. Read the Forge skill (\`${skillPath}\`) and follow triage (references/substantial-work.md).`);
  if (!hasActiveSession) {
    lines.push('2. If entering Forge: `forge new <slug>` then continue the current phase.');
  } else if (sessionLines.length > 0) {
    lines.push('2. Active session:');
    for (const line of sessionLines) lines.push(`   ${line}`);
  }
  lines.push('3. Skip Forge for this task only: `/forge:skip`');
  lines.push('Guide: Forge skill + docs/forge.md (under the installed forge skill)');
  return lines.join('\n');
}

/**
 * CLI:
 *   forge triage --check "<prompt>"     exit 0: ask the agent to decide;
 *                                        exit 1: prompt suppressed (no work
 *                                        content) — the agent is never asked
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

export function buildTriageHelpText() {
  return `Usage:
  forge triage --check "<prompt>"
  forge triage --message [--has-session] "<prompt>"

--check exit codes:
  0   ask the agent to decide whether this prompt needs Forge
  1   prompt suppressed — no work content (empty, /forge:skip, a bare
      conversational reply, a read-only question, or a stated trivial edit)
`;
}

function printTriageHelp() {
  process.stdout.write(buildTriageHelpText());
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
