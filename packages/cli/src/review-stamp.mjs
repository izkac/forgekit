/**
 * The on-disk shape of the review dispatch stamp: `<sessionDir>/reviews/dispatches.json`.
 *
 * `forge review-label` (task 1.2) writes one stamp here at the moment a
 * reviewer subagent is dispatched; `reviewCensus` (task 2.1) reads them back
 * as the source of the `finalReviewEvidence: 'recorded'` grade. The shape
 * lives in one module so the writer and the reader cannot drift apart —
 * that drift is the exact failure class this file exists to close.
 *
 * Deliberately dumb: no policy, no gate logic, structure validation only.
 * The asymmetry between the two exports is the whole design:
 *
 * - `readStamps` NEVER REFUSES WORK. It feeds `forge phase done`'s money/auth
 *   gate, and a directory it cannot make sense of — missing, unreadable,
 *   truncated, the wrong shape — must read exactly like "no stamps here", so
 *   the census falls back to the review file's prose rather than throwing
 *   through a gate that must never block on telemetry.
 * - `writeStamp` NEVER DESTROYS EVIDENCE. An existing `dispatches.json` that
 *   cannot be read or parsed is left on disk untouched, and the write is
 *   refused with a reason instead of being silently replaced by a
 *   fresh document holding only the new stamp — that would discard
 *   whatever recoverable stamps the file held, in the one file that decides
 *   a gate. Losing the new stamp is a bounded, visible failure (surfaced on
 *   stderr, task 1.2); silently discarding old ones is not.
 */

import fs from 'node:fs';
import path from 'node:path';

/** @param {unknown} value @returns {value is string} non-empty string */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A stamp `readStamps` will hand back: the four identity fields present and
 * non-empty. `model` is not part of this check — see the module comment on
 * `readStamps` below.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isStructurallyValidStamp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isNonEmptyString(value.unit) &&
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.at)
  );
}

/** @param {string} sessionDir @returns {string} */
function stampFile(sessionDir) {
  return path.join(sessionDir, 'reviews', 'dispatches.json');
}

/**
 * The structurally valid stamps recorded for a session, oldest first.
 *
 * Never throws. A missing file, an unreadable one, invalid JSON, or JSON
 * whose root is not `{ stamps: [...] }` all answer `[]` — the same "nothing
 * here" a caller cannot tell apart from "no reviewer was ever dispatched",
 * which is correct: this module's job is to make that failure mode as safe
 * as the ordinary one, not to distinguish them (that is `reviewEvidence`'s
 * discipline, over a different record).
 *
 * `model` is carried through as whatever the document holds — including
 * `undefined` if the key is absent, or a shape that is not a plain object —
 * without validation. It is informative context for a human reading the
 * stamp, never load-bearing for the census, so there is nothing to enforce.
 *
 * @param {string} sessionDir
 * @returns {Record<string, any>[]}
 */
export function readStamps(sessionDir) {
  try {
    const raw = fs.readFileSync(stampFile(sessionDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    if (!Array.isArray(parsed.stamps)) return [];
    return parsed.stamps.filter(isStructurallyValidStamp);
  } catch {
    return [];
  }
}

/**
 * Read the existing stamp file for `writeStamp`, distinguishing "nothing
 * there yet" (fine — start a fresh document) from "there is a document and
 * it could not be understood" (a refusal — see the module comment).
 *
 * Individual malformed stamps inside an otherwise-readable document are
 * dropped here the same way `readStamps` drops them: that is not evidence of
 * a broken file, just of an entry that never should have passed shape
 * validation, and the surviving stamps are exactly what must be preserved.
 *
 * @param {string} file
 * @returns {{ stamps: Record<string, any>[] } | { error: string }}
 */
function readExistingForWrite(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { stamps: [] };
    return { error: `existing stamp file could not be read: ${error?.code ?? error?.message ?? error}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `existing stamp file is not valid JSON: ${error?.message ?? error}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.stamps)) {
    return { error: 'existing stamp file is not the expected shape (an object with a stamps array)' };
  }
  return { stamps: parsed.stamps.filter(isStructurallyValidStamp) };
}

/**
 * Append one dispatch stamp to `<sessionDir>/reviews/dispatches.json`,
 * creating the directory and file as needed.
 *
 * Never throws. `at` is stamped here (`new Date().toISOString()`) rather
 * than accepted from the caller, so every writer of this file times its
 * stamps the same way. `model` is stored exactly as given when it is a
 * plain object, and as `null` otherwise — a failed or malformed model
 * resolution must not cost the stamp itself, only the informative field.
 *
 * @param {string} sessionDir
 * @param {{ unit: string, label: string, sessionId: string, model?: unknown }} stamp
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function writeStamp(sessionDir, { unit, label, sessionId, model } = {}) {
  const dir = path.join(sessionDir, 'reviews');
  const file = stampFile(sessionDir);
  try {
    const existing = readExistingForWrite(file);
    if ('error' in existing) return { ok: false, reason: existing.error };

    const entry = {
      unit,
      label,
      sessionId,
      at: new Date().toISOString(),
      model: model !== null && typeof model === 'object' && !Array.isArray(model) ? model : null,
    };

    fs.mkdirSync(dir, { recursive: true });
    const doc = { version: 1, stamps: [...existing.stamps, entry] };
    const temporaryFile = `${file}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryFile, file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}
