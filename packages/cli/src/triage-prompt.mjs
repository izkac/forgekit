#!/usr/bin/env node
/**
 * Prompt classification for Forge invocation and the optional `forge triage`
 * CLI. Auto-triage on every UserPromptSubmit is retired — this module no
 * longer drives a per-prompt hook. `isForgeInvocation` is the on-switch
 * (`/forge` or natural-language "use Forge"). references/substantial-work.md
 * is Step 0 after that invoke, not a filter that starts Forge on its own.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isForgeSkip(prompt) {
  return /^\s*\/forge:skip\b/i.test((prompt || '').trim());
}

export function isForgeInvocation(prompt) {
  const p = (prompt || '').trim();
  if (!p) return false;
  if (/^\s*\/forge(?::|\s|$)/i.test(p)) return true;
  // Any ask-for-Forge-by-name phrasing: "use Forge", "with Forge",
  // "do forge work", "run the forge workflow". `\bforge\b` does not match
  // "forgekit". Keep in sync with
  // templates/project/claude/hooks/forge-prompt-hook.mjs
  return /\b(?:use|using|with|via|start|run|do)\s+(?:the\s+)?forge\b|\bforge\s+(?:work(?:flow)?|pipeline|session)\b/i.test(p);
}

// I1-R (round 3, final review round 2): the previous split gated
// `changelog`/`docs-only`/`documentation-only`/`rename-only` on the ABSENCE
// of a creation verb (add/build/create/implement/…), and left
// `comment-only`/`no behaviour change`/`zero behaviour` unconditional on the
// theory that "there is no plausible reading where they describe something
// new being built". Both were falsified — not by the five prompts that
// motivated them, but by the verb families neither list named: `fix`,
// `remove`, `rewrite`, `refactor`, `port`, `migrate`, `delete` all describe
// real work too, and a payments bug fix carrying an incidental
// "rename-only" aside silenced with `Fix` exactly as it did with `Implement`.
// A verb allowlist can only ever be as complete as the list of verbs someone
// thought to write down.
//
// The fix does not look at the verb at all. Every one of these markers is an
// assertion about the NATURE of an edit (a rename, a comment tweak, a
// formatting pass, a doc-only change) — genuinely trivial when the prompt
// has nothing else in it, but the same words are equally at home as
// modifiers on a named mechanism ("a rename-only migration TOOL", "the
// documentation-only GUARD", "a rename-only change to the refund HANDLER").
// When the prompt also names a mechanism/artifact — something with its own
// behaviour to build, remove, port or fix, not a passive piece of text — the
// marker is describing what was done TO or WITH that mechanism, and the
// prompt is substantial regardless of which verb introduced it.
//
// I1-R (round 4, final review round 3): putting every marker behind that
// mechanism veto regressed the single most common trivial prompt there is.
// `typo`, `formatting-only` and `whitespace-only` are unconditional before
// this change on main; the round-3 reviewer measured 16 prompts (e.g.
// "Correct a typo in the User class docstring") that suppress on main and
// every round before round 3, but ASK at round 3's HEAD — a class or file
// name sitting anywhere else in the sentence was enough to veto them. Unlike
// `docs-only`/`rename-only`/etc., these three describe an edit whose nature
// is fixed no matter what else the sentence names — a typo fix is a typo fix
// whichever file, class or service it lands in — so they move back to
// unconditional, out from behind NAMED_MECHANISM.
//
// Separately, `changelog` is dropped from the marker list entirely. Unlike
// every other marker here, it is not an assertion about an edit's nature —
// it is a plain noun naming a file. Agentive nouns built from any verb
// (`changelog emailer`, `changelog importer`, `changelog generator`,
// `changelog indexer`, …) describe the same "names a mechanism" shape as
// NAMED_MECHANISM's list, but can never be fully enumerated there — the
// round-3 reviewer measured this as the sole cause of 16 of 22 dangerous
// suppressions. Dropping the marker removes the false-suppress class
// outright instead of chasing it noun by noun; `update the changelog` now
// asks, which is the fail-safe direction this filter is designed to prefer.
//
// `docs-only`, `documentation-only`, `rename-only`, `comment-only`, `no
// behaviour change` and `zero behaviour` stay behind the NAMED_MECHANISM
// veto — the same agentive-noun gap applies to them, but it is being
// tracked, not fixed, in this round.
const UNCONDITIONAL_TRIVIAL_MARKERS =
  /\b(typo|formatting[\s-]only|whitespace[\s-]only)\b/i;

const GATED_TRIVIAL_MARKERS =
  /\b(comment[\s-]only|no behaviou?r change|zero behaviou?r|docs[\s-]only|documentation[\s-]only|rename[\s-]only)\b/i;

// A named mechanism/artifact: something that has behaviour of its own,
// rather than being passive text content (a changelog file, a doc page, a
// comment, a rename by itself). Deliberately verb-independent — it does not
// matter whether the prompt fixes, removes, builds, ports, migrates or
// deletes one of these; naming it alongside a trivial marker means the
// marker is a modifier on real work, not the whole of the request.
const NAMED_MECHANISM =
  /\b(tool|generator|pipeline|parser|guard|script|module|adapter|handler|refactor(?:ing)?|migration|endpoint|workflow|engine|plugin|service|function|class|component|job|site|stripp(?:er|ing)|bug|feature|microservice|widget|bot|webhook|middleware|library|package|extension|dashboard|console|worker|daemon|server|route|controller|schema|database|tables?)\b/i;

export function isTrivialEdit(prompt) {
  const p = (prompt || '').trim();
  if (!p) return true;
  if (/^\s*fix(ed)?\s+(a|the)?\s*typo\b/i.test(p)) return true;
  if (UNCONDITIONAL_TRIVIAL_MARKERS.test(p)) return true;
  return GATED_TRIVIAL_MARKERS.test(p) && !NAMED_MECHANISM.test(p);
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
 *
 * `--` ends flag parsing: everything after it is prompt text, so a prompt
 * that is literally `--help` (or `--check`, …) is treated as content, not as
 * forge's own option (F105). The triage hook always passes `--`.
 */
export function parseTriageArgs(argv) {
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
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
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

Everything after \`--\` is prompt text, even if it looks like a flag:
  forge triage --check -- "--help"

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
