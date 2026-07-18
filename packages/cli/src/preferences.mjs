/**
 * Forge pace preferences — load, merge, auto-resolve, hard floors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS_PATH = path.join(__dirname, 'preferences.defaults.json');

export const PACES = Object.freeze(['auto', 'thorough', 'standard', 'brisk', 'lite']);
export const CONCRETE_PACES = Object.freeze(['thorough', 'standard', 'brisk', 'lite']);

export const REVIEW_PER_TASK = Object.freeze([
  'always',
  'per-group',
  'high-risk-only',
  'never',
]);
export const REVIEW_FINAL = Object.freeze(['always', 'high-risk-only', 'never']);
export const REVIEW_DEPTH = Object.freeze(['full', 'spec-only']);
export const TIER3 = Object.freeze(['full-workspace', 'affected-only', 'audit-tier2-only']);
export const MODEL_BIAS = Object.freeze(['default', 'prefer-fast']);
export const BRAINSTORM_DEPTH = Object.freeze(['full', 'short', 'minimal']);

/** Signals that force thorough (order does not matter; any match wins). */
const THOROUGH_RE =
  /\b(money|payment|payments|stripe|billing|invoice|refund|auth|oauth|oidc|hmac|secret|secrets|credential|migrat(?:e|ion|ions)|contract|contracts|gdpr|pci|wallet|checkout)\b/i;

/** Signals that suggest standard (multi-surface / API / platform / orchestration). */
const STANDARD_RE =
  /\b(ecosystem|cross-workspace|multi-file|openapi|api\b|shared[- ]package|public api|wire contract|worker|workers|job queue|job queues|queue|pipeline|etl|service|services|platform|orchestration|openspec|forge:apply|harmonization)\b/i;

/** Signals that suggest lite. */
const LITE_RE =
  /\b(docs?|readme|rename|typo|scaffold|wording|comment|comments|cosmetic|changelog)\b/i;

/** Explicitly small / localized work — only these resolve to brisk under auto. */
const SMALL_WORK_RE =
  /\b(fix|tweak|button|toolbar|style|styles|css|padding|alignment|copy|label|typo|cosmetic)\b/i;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} overlay
 */
export function deepMerge(base, overlay) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(
        /** @type {Record<string, unknown>} */ (out[key]),
        /** @type {Record<string, unknown>} */ (value),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {string} filePath
 */
export function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * @param {{ defaultsPath?: string, forgeDir?: string, cwd?: string }} [paths]
 */
export function preferencesLocalPath(paths = {}) {
  const cwd = paths.cwd ?? process.cwd();
  const forgeDir = paths.forgeDir ?? path.join(cwd, '.forge');
  return path.join(forgeDir, 'preferences.local.json');
}

/**
 * @param {{ defaultsPath?: string, forgeDir?: string, cwd?: string }} [paths]
 */
export function loadPreferencesDefaults(paths = {}) {
  const defaultsPath = paths.defaultsPath ?? DEFAULTS_PATH;
  return loadJsonFile(defaultsPath);
}

/**
 * @param {{ defaultsPath?: string, forgeDir?: string, cwd?: string }} [paths]
 */
export function loadLocalPreferences(paths = {}) {
  const localPath = preferencesLocalPath(paths);
  if (!fs.existsSync(localPath)) return { localPath, local: null };
  return { localPath, local: loadJsonFile(localPath) };
}

/**
 * @param {string} pace
 */
export function assertPace(pace) {
  if (!PACES.includes(pace)) {
    throw new Error(`Unknown pace "${pace}". Expected one of: ${PACES.join(', ')}`);
  }
}

/**
 * @param {string} pace
 */
export function assertConcretePace(pace) {
  if (!CONCRETE_PACES.includes(pace)) {
    throw new Error(`Expected concrete pace, got "${pace}". Expected one of: ${CONCRETE_PACES.join(', ')}`);
  }
}

/**
 * Suggest a concrete pace from free-text signals (stricter wins).
 * Unrecognized scope fails closed to **standard** (not brisk).
 * @param {string} [signalText]
 * @returns {{ pace: string, reason: string }}
 */
export function suggestPaceFromSignals(signalText = '') {
  const text = String(signalText || '').trim();
  if (!text) {
    return { pace: 'standard', reason: 'no signals; fail closed to standard' };
  }
  if (THOROUGH_RE.test(text)) {
    return { pace: 'thorough', reason: 'high-risk signals (money/auth/contracts/migrations/secrets)' };
  }
  if (STANDARD_RE.test(text)) {
    return { pace: 'standard', reason: 'multi-surface / API / ecosystem / orchestration signals' };
  }
  if (LITE_RE.test(text) && !STANDARD_RE.test(text) && !SMALL_WORK_RE.test(text)) {
    return { pace: 'lite', reason: 'docs/mechanical signals without high-risk terms' };
  }
  if (SMALL_WORK_RE.test(text) && !STANDARD_RE.test(text) && !THOROUGH_RE.test(text)) {
    return { pace: 'brisk', reason: 'explicitly small/localized work signals' };
  }
  return { pace: 'standard', reason: 'unrecognized scope — failing closed' };
}

/**
 * @param {string} text
 */
export function isHighRiskText(text = '') {
  return THOROUGH_RE.test(String(text || ''));
}

/**
 * Expand a concrete pace + optional overrides into effective knobs.
 * @param {{
 *   pace: string,
 *   overrides?: Record<string, unknown>,
 *   defaults?: Record<string, unknown>,
 * }} opts
 */
export function expandPace(opts) {
  const pace = opts.pace;
  assertConcretePace(pace);
  const defaults = opts.defaults ?? loadPreferencesDefaults();
  const presets = /** @type {Record<string, Record<string, unknown>>} */ (defaults.presets || {});
  const preset = presets[pace];
  if (!preset) {
    throw new Error(`Missing preset expansion for pace "${pace}" in defaults`);
  }
  const overrides = opts.overrides && isPlainObject(opts.overrides) ? opts.overrides : {};
  /** @type {Record<string, unknown>} */
  const knobOverrides = {};
  for (const key of ['review', 'verify', 'models', 'brainstorm']) {
    if (isPlainObject(overrides[key])) {
      knobOverrides[key] = overrides[key];
    }
  }
  // Also allow dotted top-level keys already nested in local file without pace key collision
  const expanded = deepMerge(structuredClone(preset), knobOverrides);
  return {
    pace,
    review: /** @type {Record<string, unknown>} */ (expanded.review),
    verify: /** @type {Record<string, unknown>} */ (expanded.verify),
    models: /** @type {Record<string, unknown>} */ (expanded.models),
    brainstorm: /** @type {Record<string, unknown>} */ (expanded.brainstorm),
  };
}

/**
 * @param {{
 *   defaultsPath?: string,
 *   forgeDir?: string,
 *   cwd?: string,
 *   session?: Record<string, unknown> | null,
 *   signalText?: string,
 * }} [opts]
 */
export function resolveEffectivePreferences(opts = {}) {
  const defaults = loadPreferencesDefaults(opts);
  const { localPath, local } = loadLocalPreferences(opts);
  const session = opts.session && isPlainObject(opts.session) ? opts.session : null;

  /** @type {Record<string, unknown>} */
  const localPrefs = local && isPlainObject(local) ? local : {};

  let requestedPace =
    typeof localPrefs.pace === 'string' && PACES.includes(localPrefs.pace)
      ? localPrefs.pace
      : typeof defaults.pace === 'string' && PACES.includes(defaults.pace)
        ? defaults.pace
        : 'auto';

  let source = local ? 'preferences.local.json' : 'defaults';

  if (session?.preferencesOverride && isPlainObject(session.preferencesOverride)) {
    const o = /** @type {Record<string, unknown>} */ (session.preferencesOverride);
    if (typeof o.pace === 'string' && PACES.includes(o.pace)) {
      requestedPace = o.pace;
      source = 'session.preferencesOverride';
    }
  } else if (typeof session?.pace === 'string' && PACES.includes(session.pace) && session.pace !== 'auto') {
    // Session may pin a concrete pace without a full override object
    if (session.pacePinned === true) {
      requestedPace = session.pace;
      source = 'session.pace';
    }
  }

  /** @type {Record<string, unknown>} */
  const overrides = { ...localPrefs };
  delete overrides.pace;
  delete overrides.presets;
  if (session?.preferencesOverride && isPlainObject(session.preferencesOverride)) {
    const o = /** @type {Record<string, unknown>} */ (session.preferencesOverride);
    for (const key of ['review', 'verify', 'models', 'brainstorm']) {
      if (isPlainObject(o[key])) {
        overrides[key] = isPlainObject(overrides[key])
          ? deepMerge(
              /** @type {Record<string, unknown>} */ (overrides[key]),
              /** @type {Record<string, unknown>} */ (o[key]),
            )
          : o[key];
      }
    }
  }

  let resolvedPace = requestedPace;
  let paceReason = 'explicit pace';
  if (requestedPace === 'auto') {
    if (typeof session?.resolvedPace === 'string' && CONCRETE_PACES.includes(session.resolvedPace)) {
      resolvedPace = session.resolvedPace;
      paceReason =
        typeof session.paceReason === 'string' && session.paceReason
          ? session.paceReason
          : 'session.resolvedPace';
    } else {
      const signal =
        opts.signalText ||
        (typeof session?.paceSignal === 'string' ? session.paceSignal : '') ||
        (typeof session?.slug === 'string' ? session.slug : '');
      const suggested = suggestPaceFromSignals(signal);
      resolvedPace = suggested.pace;
      paceReason = suggested.reason;
    }
  }

  const expanded = expandPace({ pace: resolvedPace, overrides, defaults });

  /** @type {Record<string, unknown>} */
  const integrityDefaults =
    defaults.integrity && isPlainObject(defaults.integrity)
      ? /** @type {Record<string, unknown>} */ (defaults.integrity)
      : {};
  /** @type {Record<string, unknown>} */
  const integrityLocal =
    localPrefs.integrity && isPlainObject(localPrefs.integrity)
      ? /** @type {Record<string, unknown>} */ (localPrefs.integrity)
      : {};
  const integrity = deepMerge(integrityDefaults, integrityLocal);

  return {
    requestedPace,
    resolvedPace,
    paceReason,
    source,
    localPath,
    localExists: Boolean(local),
    effective: expanded,
    integrity,
    shouldRunPerTaskReview: (ctx = {}) =>
      shouldRunPerTaskReview(expanded, ctx),
    shouldRunFinalReview: (ctx = {}) => shouldRunFinalReview(expanded, ctx),
  };
}

/**
 * Whether to dispatch a reviewer *now* (after the current task / group boundary).
 *
 * @param {Record<string, unknown>} effective
 * @param {{
 *   highRisk?: boolean,
 *   signalText?: string,
 *   groupComplete?: boolean,
 * }} [ctx]
 *   `groupComplete` — true when the just-finished task closes an OpenSpec
 *   `tasks.md` section (top-level heading group). Required for `per-group`
 *   cadence on low-risk work.
 */
export function shouldRunPerTaskReview(effective, ctx = {}) {
  const highRisk = Boolean(ctx.highRisk) || isHighRiskText(ctx.signalText);
  const perTask = effective.review?.perTask;
  if (perTask === 'always') return true;
  if (perTask === 'per-group') {
    // Hard floor: money/auth/contracts/… still get an immediate per-task review.
    if (highRisk) return true;
    return Boolean(ctx.groupComplete);
  }
  if (perTask === 'high-risk-only') return highRisk;
  if (perTask === 'never') return highRisk; // hard floor
  return true;
}

/**
 * @param {Record<string, unknown>} effective
 * @param {{ highRisk?: boolean, signalText?: string }} [ctx]
 */
export function shouldRunFinalReview(effective, ctx = {}) {
  const highRisk = Boolean(ctx.highRisk) || isHighRiskText(ctx.signalText);
  const final = effective.review?.final;
  if (final === 'always') return true;
  if (final === 'high-risk-only') return highRisk;
  if (final === 'never') return highRisk; // hard floor
  return true;
}

/**
 * @param {string} dottedPath
 * @param {unknown} value
 * @param {Record<string, unknown>} target
 */
export function setDotted(target, dottedPath, value) {
  const parts = dottedPath.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('Empty path');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = /** @type {Record<string, unknown>} */ (cur[key]);
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Parse `review.perTask=always` style assignments.
 * @param {string} assignment
 */
export function parseAssignment(assignment) {
  const eq = assignment.indexOf('=');
  if (eq <= 0) throw new Error(`Invalid --set value "${assignment}" (expected path=value)`);
  const key = assignment.slice(0, eq).trim();
  let raw = assignment.slice(eq + 1).trim();
  let value;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  else if (/^\d+$/.test(raw)) value = Number(raw);
  else value = raw;
  return { key, value };
}

/**
 * @param {{ forgeDir: string, patch: Record<string, unknown> }} opts
 */
export function writeLocalPreferences(opts) {
  fs.mkdirSync(opts.forgeDir, { recursive: true });
  const localPath = path.join(opts.forgeDir, 'preferences.local.json');
  /** @type {Record<string, unknown>} */
  let existing = {};
  if (fs.existsSync(localPath)) {
    existing = loadJsonFile(localPath);
  }
  const next = deepMerge(existing, opts.patch);
  if (typeof next.pace === 'string') assertPace(next.pace);
  fs.writeFileSync(localPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { localPath, preferences: next };
}

/**
 * Build session pace fields for a new or updated session.
 * @param {{
 *   slug?: string,
 *   signalText?: string,
 *   defaultsPath?: string,
 *   forgeDir?: string,
 *   cwd?: string,
 *   paceOverride?: string | null,
 * }} opts
 */
export function resolveSessionPaceFields(opts = {}) {
  const { local } = loadLocalPreferences(opts);
  const defaults = loadPreferencesDefaults(opts);
  const requestedFromLocal =
    local && typeof local.pace === 'string' && PACES.includes(local.pace)
      ? local.pace
      : typeof defaults.pace === 'string'
        ? defaults.pace
        : 'auto';

  const requestedPace =
    typeof opts.paceOverride === 'string' && PACES.includes(opts.paceOverride)
      ? opts.paceOverride
      : requestedFromLocal;

  const signal = opts.signalText || opts.slug || '';
  if (requestedPace === 'auto') {
    const suggested = suggestPaceFromSignals(signal);
    return {
      pace: 'auto',
      resolvedPace: suggested.pace,
      paceReason: suggested.reason,
      paceSignal: signal || null,
      pacePinned: false,
      preferencesOverride: null,
    };
  }

  assertConcretePace(requestedPace);
  return {
    pace: requestedPace,
    resolvedPace: requestedPace,
    paceReason: 'explicit pace',
    paceSignal: signal || null,
    pacePinned: true,
    preferencesOverride: null,
  };
}
