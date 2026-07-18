#!/usr/bin/env node
/**
 * Get or set checkout-local Forge pace preferences.
 *
 * Usage:
 *   forge set-prefs                         # print effective
 *   forge set-prefs brisk                   # set pace
 *   forge set-prefs --set review.perTask=always
 *   forge set-prefs --session-set lite      # pin active session
 *   forge set-prefs --resolve --signal "…"  # resolve auto now
 *
 * Options:
 *   --forge-dir <path>
 *   --defaults <path>
 *   --json
 *   --help
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS_PATH,
  PACES,
  parseAssignment,
  resolveEffectivePreferences,
  resolveSessionPaceFields,
  setDotted,
  suggestPaceFromSignals,
  writeLocalPreferences,
} from './preferences.mjs';
import {
  loadSession,
  readActive,
  saveSession,
} from './lib.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    pace: null,
    sets: [],
    sessionSet: null,
    resolve: false,
    signal: null,
    forgeDir: null,
    defaults: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--forge-dir') opts.forgeDir = argv[++i];
    else if (arg === '--defaults') opts.defaults = argv[++i];
    else if (arg === '--set') opts.sets.push(argv[++i]);
    else if (arg === '--session-set') opts.sessionSet = argv[++i];
    else if (arg === '--resolve') opts.resolve = true;
    else if (arg === '--signal') opts.signal = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--') continue;
    else if (!arg.startsWith('-') && opts.pace === null) opts.pace = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: forge set-prefs [pace] [options]

Get or set Forge pace (thoroughness) preferences.

Paces: ${PACES.join(', ')}  (default: auto)

  forge prefs
      Print effective pace + knobs — does NOT create .forge/preferences.local.json
      unless you also pass a pace or --set. local=(none) means committed defaults.

  forge prefs brisk
      Write/update .forge/preferences.local.json (gitignored, per-checkout).

  forge prefs --session-set lite
      Pin pace on the active session only (no local file write).

  forge prefs -- --set review.perTask=always
  forge prefs -- --resolve --signal "add stripe refund"

Defaults: preferences.defaults.json
Local overlay: .forge/preferences.local.json (appears only after a set)
Matrix: .cursor/skills/forge/references/pace.md

Options:
  --set path=value   Nested override (repeatable)
  --session-set      Pin pace on active session only
  --resolve          Re-resolve auto for active session
  --signal <text>    Signals for auto / --resolve
  --json             JSON stdout
  --forge-dir <path>
  --defaults <path>
  --help
`);
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 */
export function runSetPrefs(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`${msg}\n`);
    return 2;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  const forgeDir = opts.forgeDir ?? path.join(cwd, '.forge');
  const defaultsPath = opts.defaults ?? DEFAULTS_PATH;

  try {
    if (opts.sessionSet != null) {
      if (!PACES.includes(opts.sessionSet)) {
        throw new Error(`Unknown pace "${opts.sessionSet}". Expected one of: ${PACES.join(', ')}`);
      }
      const active = readActive();
      if (!active?.sessionId) {
        throw new Error('No active Forge session. Run forge:new first.');
      }
      const { dir, session } = loadSession(active.sessionId);
      if (opts.sessionSet === 'auto') {
        const fields = resolveSessionPaceFields({
          forgeDir,
          defaultsPath,
          cwd,
          slug: session.slug,
          signalText: opts.signal || session.paceSignal || session.slug,
          paceOverride: 'auto',
        });
        Object.assign(session, fields);
      } else {
        session.pace = opts.sessionSet;
        session.resolvedPace = opts.sessionSet;
        session.paceReason = 'session override';
        session.pacePinned = true;
        session.preferencesOverride = { pace: opts.sessionSet };
      }
      saveSession(dir, session);
      if (opts.json) {
        stdout.write(`${JSON.stringify({ sessionId: session.id, pace: session }, null, 2)}\n`);
      } else {
        stdout.write(`session ${session.id}: pace=${session.pace} resolved=${session.resolvedPace}\n`);
      }
      return 0;
    }

    if (opts.resolve) {
      const active = readActive();
      if (!active?.sessionId) {
        throw new Error('No active Forge session. Run forge:new first.');
      }
      const { dir, session } = loadSession(active.sessionId);
      const signal = opts.signal || session.paceSignal || session.slug || '';
      const fields = resolveSessionPaceFields({
        forgeDir,
        defaultsPath,
        cwd,
        slug: session.slug,
        signalText: signal,
        paceOverride: typeof session.pace === 'string' ? session.pace : 'auto',
      });
      // Force re-resolve even if concrete: when --resolve with auto requested
      if ((session.pace ?? 'auto') === 'auto' || fields.pace === 'auto') {
        const suggested = suggestPaceFromSignals(signal);
        session.pace = 'auto';
        session.resolvedPace = suggested.pace;
        session.paceReason = suggested.reason;
        session.paceSignal = signal || null;
        session.pacePinned = false;
        session.preferencesOverride = null;
      } else {
        Object.assign(session, fields);
      }
      saveSession(dir, session);
      if (opts.json) {
        stdout.write(
          `${JSON.stringify({
            sessionId: session.id,
            requestedPace: session.pace,
            resolvedPace: session.resolvedPace,
            paceReason: session.paceReason,
          }, null, 2)}\n`,
        );
      } else {
        stdout.write(
          `resolved ${session.resolvedPace} (${session.paceReason})\n`,
        );
      }
      return 0;
    }

    if (opts.pace != null || opts.sets.length > 0) {
      /** @type {Record<string, unknown>} */
      const patch = {};
      if (opts.pace != null) {
        if (!PACES.includes(opts.pace)) {
          throw new Error(`Unknown pace "${opts.pace}". Expected one of: ${PACES.join(', ')}`);
        }
        patch.pace = opts.pace;
      }
      for (const assignment of opts.sets) {
        if (!assignment) throw new Error('--set requires path=value');
        const { key, value } = parseAssignment(assignment);
        setDotted(patch, key, value);
      }
      const written = writeLocalPreferences({ forgeDir, patch });
      if (opts.json) {
        stdout.write(`${JSON.stringify(written, null, 2)}\n`);
      } else {
        stdout.write(`wrote ${written.localPath}\n`);
        if (patch.pace) stdout.write(`pace=${patch.pace}\n`);
        for (const a of opts.sets) stdout.write(`set ${a}\n`);
      }
      return 0;
    }

    let session = null;
    const active = readActive();
    if (active?.sessionId) {
      try {
        session = loadSession(active.sessionId).session;
      } catch {
        session = null;
      }
    }

    const effective = resolveEffectivePreferences({
      forgeDir,
      defaultsPath,
      cwd,
      session,
      signalText: opts.signal || undefined,
    });

    if (opts.json) {
      stdout.write(`${JSON.stringify(effective, null, 2)}\n`);
    } else {
      stdout.write(`pace=${effective.requestedPace}\n`);
      stdout.write(`resolved=${effective.resolvedPace}\n`);
      stdout.write(`reason=${effective.paceReason}\n`);
      stdout.write(`source=${effective.source}\n`);
      stdout.write(`review.perTask=${effective.effective.review.perTask}\n`);
      stdout.write(`review.final=${effective.effective.review.final}\n`);
      stdout.write(`review.depth=${effective.effective.review.depth}\n`);
      stdout.write(`review.maxRounds=${effective.effective.review.maxRounds}\n`);
      stdout.write(`verify.tier3=${effective.effective.verify.tier3}\n`);
      stdout.write(`models.bias=${effective.effective.models.bias}\n`);
      stdout.write(`brainstorm.depth=${effective.effective.brainstorm.depth}\n`);
      if (effective.localExists) {
        stdout.write(`local=${effective.localPath}\n`);
      } else {
        stdout.write(`local=(none — using preferences.defaults.json)\n`);
        stdout.write(
          `hint: forge prefs -- auto|thorough|standard|brisk|lite  # writes .forge/preferences.local.json\n`,
        );
      }
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`${msg}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = runSetPrefs(process.argv.slice(2));
}
