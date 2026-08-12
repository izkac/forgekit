#!/usr/bin/env node
/**
 * Product loop for the recalibrated prompt-time triage filter (D1b).
 *
 * `forge triage --check` no longer decides whether a prompt is substantial —
 * it decides one thing only: whether to ASK the agent. Exit 0 means "ask the
 * agent to decide"; exit 1 means "suppressed, this prompt carries no work
 * content". The agent (not this filter) judges substantiality.
 *
 * The five "trivial" prompts below are one each from the suppression classes
 * `packages/cli/src/triage-prompt.mjs` actually implements — read from its own
 * `buildTriageHelpText()`, not guessed from this brief: "empty, /forge:skip, a
 * bare conversational reply, a read-only question, or a stated trivial edit".
 * The four "real work" prompts are ordinary feature/bugfix/refactor asks that
 * must all reach the agent as a question.
 *
 * Drives the SHIPPED binary (packages/cli/bin/forge.mjs) as a child process —
 * a script that imported `hasWorkContent`/`shouldForgeTriage` directly would
 * pass even if the `triage` subcommand were never wired into `bin/forge.mjs`,
 * which is exactly the class of defect this change found in group 4 (the exit
 * ramp was library-only until someone drove the binary).
 *
 * `--substantial` switches from the trivial fixture set to the real-work one.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

/**
 * `forge triage --check "<prompt>"` through the real binary.
 * `input: ''` closes stdin immediately — deterministic even for the empty
 * prompt, which would otherwise fall into `triage-prompt.mjs`'s stdin-read
 * fallback and depend on TTY detection in the harness process.
 *
 * @param {string} prompt
 */
function triageCheck(prompt) {
  const r = spawnSync(process.execPath, [FORGE_BIN, 'triage', '--check', prompt], {
    cwd: REPO,
    encoding: 'utf8',
    input: '',
    timeout: 10_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// One prompt per documented suppression class. Do not add a sixth "obviously
// trivial" prompt here on a hunch — if it does not map to a class
// `triage-prompt.mjs` implements, it proves nothing about this change.
const TRIVIAL = [
  { label: 'empty prompt', prompt: '' },
  { label: '/forge:skip', prompt: '/forge:skip handling this myself' },
  { label: 'stated trivial edit', prompt: 'Fix a typo in the README, no behaviour change' },
  { label: 'read-only question', prompt: 'What does the pace resolver do?' },
  { label: 'bare conversational reply', prompt: 'thanks' },
];

const SUBSTANTIAL = [
  { label: 'feature request', prompt: 'Add support for exporting the review-yield table to CSV' },
  {
    label: 'bug fix',
    prompt: 'Fix the race condition in the pace resolver when two sessions run concurrently',
  },
  { label: 'new endpoint', prompt: 'Implement a new endpoint for triggering campaign benchmarks' },
  { label: 'refactor', prompt: 'Refactor the review census module to track partial host bindings' },
];

const substantialMode = process.argv.includes('--substantial');

if (!substantialMode) {
  const mismatches = [];
  for (const { label, prompt } of TRIVIAL) {
    const { code, out } = triageCheck(prompt);
    if (code !== 1) {
      mismatches.push(
        `${label} (${JSON.stringify(prompt)}): expected exit 1 (suppressed), got exit ${code}${out ? `\n${out}` : ''}`,
      );
    }
  }
  if (mismatches.length) {
    fail(
      `${mismatches.length}/${TRIVIAL.length} trivial prompts were NOT suppressed`,
      mismatches.join('\n---\n'),
    );
  }
  process.stdout.write(`trivial prompts skipped: ${TRIVIAL.length}/${TRIVIAL.length}\n`);
} else {
  const mismatches = [];
  for (const { label, prompt } of SUBSTANTIAL) {
    const { code, out } = triageCheck(prompt);
    if (code !== 0) {
      mismatches.push(
        `${label} (${JSON.stringify(prompt)}): expected exit 0 (ask the agent), got exit ${code}${out ? `\n${out}` : ''}`,
      );
    }
  }
  if (mismatches.length) {
    fail(
      `${mismatches.length}/${SUBSTANTIAL.length} real-work prompts were NOT caught`,
      mismatches.join('\n---\n'),
    );
  }
  process.stdout.write(`substantial prompts caught: ${SUBSTANTIAL.length}/${SUBSTANTIAL.length}\n`);
}
