import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildExitCheckHelpText,
  factsFromExitCheckArgs,
  parseExitCheckArgs,
  runExitCheck,
} from './exit-check.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exit-check.mjs');

// --- parseExitCheckArgs ----------------------------------------------------

test('parses the three count flags, --high-risk and --json', () => {
  const opts = parseExitCheckArgs([
    '--tasks', '2', '--capabilities', '1', '--spine-rows', '0', '--high-risk', '--json',
  ]);
  assert.equal(opts.tasks, '2');
  assert.equal(opts.capabilities, '1');
  assert.equal(opts.spineRows, '0');
  assert.equal(opts.highRisk, true);
  assert.equal(opts.json, true);
});

test('a flag with nothing after it at the end of argv is left unset, not a crash', () => {
  const opts = parseExitCheckArgs(['--capabilities', '1', '--tasks']);
  assert.equal(opts.tasks, null);
  assert.equal(opts.capabilities, '1');
});

test('a flag whose "value" is itself another recognized flag still fails closed downstream', () => {
  // The parser does not special-case this (no flag parser in this codebase
  // does), but the safety property must hold anyway: a non-numeric "value"
  // — including one that looks like a flag name — is rejected by
  // factsFromExitCheckArgs, so this can never misread as a real task count.
  const opts = parseExitCheckArgs(['--tasks', '--capabilities', '1']);
  assert.equal(factsFromExitCheckArgs(opts).readable, false);
});

// --- factsFromExitCheckArgs: the fail-closed decision on bad input --------

test('facts: three valid counts and no --high-risk read closed', () => {
  const facts = factsFromExitCheckArgs(parseExitCheckArgs(['--tasks', '2', '--capabilities', '1', '--spine-rows', '0']));
  assert.deepEqual(facts, { readable: true, tasks: 2, capabilities: 1, spineRows: 0, highRisk: false });
});

test('facts: a missing flag fails closed (readable: false), never a silent zero', () => {
  const facts = factsFromExitCheckArgs(parseExitCheckArgs(['--capabilities', '1', '--spine-rows', '0']));
  assert.equal(facts.readable, false);
});

test('facts: a non-numeric flag fails closed', () => {
  const facts = factsFromExitCheckArgs(
    parseExitCheckArgs(['--tasks', 'two', '--capabilities', '1', '--spine-rows', '0']),
  );
  assert.equal(facts.readable, false);
});

test('facts: an empty-string flag value fails closed, not Number("")===0', () => {
  const facts = factsFromExitCheckArgs(
    parseExitCheckArgs(['--tasks', '', '--capabilities', '1', '--spine-rows', '0']),
  );
  assert.equal(facts.readable, false);
});

test('facts: a negative or non-integer count fails closed', () => {
  assert.equal(
    factsFromExitCheckArgs(parseExitCheckArgs(['--tasks', '-1', '--capabilities', '1', '--spine-rows', '0'])).readable,
    false,
  );
  assert.equal(
    factsFromExitCheckArgs(parseExitCheckArgs(['--tasks', '2.5', '--capabilities', '1', '--spine-rows', '0'])).readable,
    false,
  );
});

// --- runExitCheck: the whole rule, without reimplementing it --------------
//
// These exercise the exact same resolver 4.1 already proved discriminates —
// runExitCheck must not reimplement suggestExitFromPlan's decision, only
// build its input from flags and print/exit accordingly.

test('a qualifying shape exits 0 and prints the resolved-shape reason', () => {
  const { exitCode, qualifies, reason, output } = runExitCheck([
    '--tasks', '2', '--capabilities', '1', '--spine-rows', '0',
  ]);
  assert.equal(exitCode, 0);
  assert.equal(qualifies, true);
  assert.equal(reason, '2 task(s), single capability, no spine rows — small enough to leave Forge');
  assert.equal(output, `${reason}\n`);
});

test('a too-large shape exits 1', () => {
  const { exitCode, qualifies, reason } = runExitCheck([
    '--tasks', '8', '--capabilities', '2', '--spine-rows', '0',
  ]);
  assert.equal(exitCode, 1);
  assert.equal(qualifies, false);
  assert.match(reason, /too large to leave Forge/);
});

test('a high-risk shape never qualifies, however small — exits 1', () => {
  const { exitCode, qualifies, reason } = runExitCheck([
    '--tasks', '1', '--capabilities', '1', '--spine-rows', '0', '--high-risk',
  ]);
  assert.equal(exitCode, 1);
  assert.equal(qualifies, false);
  assert.equal(reason, 'high-risk change — no exit offered, however small');
});

test('a wired spine row never qualifies — exits 1', () => {
  const { exitCode, qualifies } = runExitCheck(['--tasks', '1', '--capabilities', '1', '--spine-rows', '1']);
  assert.equal(exitCode, 1);
  assert.equal(qualifies, false);
});

test('missing flags fail closed to exit 1, not a silent qualifying 0', () => {
  const { exitCode, qualifies, reason } = runExitCheck([]);
  assert.equal(exitCode, 1);
  assert.equal(qualifies, false);
  assert.equal(reason, 'could not read the plan — failing closed, no exit offered');
});

test('--json prints {qualifies, reason} agreeing with the plain-text run', () => {
  const argv = ['--tasks', '2', '--capabilities', '1', '--spine-rows', '0'];
  const plain = runExitCheck(argv);
  const json = runExitCheck([...argv, '--json']);
  const parsed = JSON.parse(json.output);
  assert.deepEqual(parsed, { qualifies: plain.qualifies, reason: plain.reason });
});

test('--help exits 0 and documents the exit-code contract', () => {
  const { exitCode, output } = runExitCheck(['--help']);
  assert.equal(exitCode, 0);
  assert.match(output, /exit-check/);
  assert.match(output, /0 {3}the shape qualifies|0.*qualifies/i);
  assert.match(output, /forge phase skipped --exit-reason/);
});

test('help text is what buildExitCheckHelpText produces — one source, not two copies', () => {
  assert.equal(runExitCheck(['--help']).output, buildExitCheckHelpText());
});

// --- the real binary: main()/isDirect wiring, not just the exported core --

test('CLI: a qualifying shape run as a real process exits 0 and prints the reason on stdout', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--tasks', '2', '--capabilities', '1', '--spine-rows', '0'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /small enough to leave Forge/);
});

test('CLI: a too-large shape run as a real process exits 1', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--tasks', '9', '--capabilities', '2', '--spine-rows', '0'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /too large to leave Forge/);
});

test('CLI: --json is valid JSON on stdout', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--tasks', '2', '--capabilities', '1', '--spine-rows', '0', '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.qualifies, true);
});

// ---------------------------------------------------------------------------
// Fix round: the parser must fail closed structurally, not by accident of
// `Number()`. Two rules: (1) a value that is itself flag-shaped (`--…`) is
// never a valid count, so it is never consumed — the flag is left as if no
// value were given, and the token it would have swallowed is parsed as its
// own flag on the next iteration. (2) a flag given more than once is
// ambiguous input, so it is forced back to unset regardless of what
// valid-looking values it collected — never "last one wins".
// ---------------------------------------------------------------------------

test('a flag-shaped "value" is never consumed — the flag it belongs to is parsed normally afterward', () => {
  // `--tasks --high-risk` must not read "--high-risk" as the task count and
  // discard it; --high-risk must still be seen as its own flag.
  const opts = parseExitCheckArgs(['--tasks', '--high-risk']);
  assert.equal(opts.tasks, null);
  assert.equal(opts.highRisk, true);
});

test('a repeated count flag is ambiguous and fails closed, never "last one wins"', () => {
  const opts = parseExitCheckArgs(['--tasks', '2', '--tasks', '5']);
  assert.equal(opts.tasks, null, 'two well-formed values for the same flag must not silently pick one');
});

test('a count flag given once, normally, is unaffected by the ambiguity rule', () => {
  const opts = parseExitCheckArgs(['--tasks', '2', '--capabilities', '1', '--spine-rows', '0']);
  assert.equal(opts.tasks, '2');
  assert.equal(opts.capabilities, '1');
  assert.equal(opts.spineRows, '0');
});

test('the exact reported reproduction: a duplicate --tasks swallowing --high-risk must no longer offer an exit', () => {
  // Reported by the group reviewer and reproduced by the coordinator against
  // the real binary: `forge exit-check --tasks --high-risk --tasks 3
  // --capabilities 1 --spine-rows 0` used to silently drop --high-risk and
  // exit 0 (qualifies) for high-risk work — the one invariant the ramp may
  // never break ("however small", the capability spec's own wording).
  const argv = ['--tasks', '--high-risk', '--tasks', '3', '--capabilities', '1', '--spine-rows', '0'];

  // Parsed shape: --high-risk is seen (not swallowed), and --tasks — given
  // twice — is ambiguous and forced closed, even though its second sighting
  // was a well-formed "3".
  const opts = parseExitCheckArgs(argv);
  assert.equal(opts.highRisk, true, '--high-risk must be seen, not swallowed as --tasks\' value');
  assert.equal(opts.tasks, null, 'a duplicate --tasks must fail closed, not keep the later value');

  const { exitCode, qualifies } = runExitCheck(argv);
  assert.equal(exitCode, 1, 'must never exit 0 (qualify) for this input');
  assert.equal(qualifies, false);
});

test('CLI: the exact reported reproduction exits 1 through the real binary', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--tasks', '--high-risk', '--tasks', '3', '--capabilities', '1', '--spine-rows', '0'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1, r.stderr);
});

// --- tasks === 0: decided to require at least one task to qualify ---------

test('a shape asserting zero tasks does not qualify through the CLI — wiring reaches suggestExitFromPlan\'s new rule', () => {
  const { exitCode, qualifies } = runExitCheck(['--tasks', '0', '--capabilities', '1', '--spine-rows', '0']);
  assert.equal(exitCode, 1);
  assert.equal(qualifies, false);
});
