/**
 * Shared numbered-menu selection (one, many, or all).
 */

/**
 * Parse a menu answer into selected ids.
 * Accepts one number, several (comma/space), or the All option.
 *
 * @param {string} answer
 * @param {Record<string, string>} map  number → id
 * @param {string[]} allIds
 * @param {string} allNum
 * @returns {{ ok: true, ids: string[] } | { ok: false, error: string }}
 */
export function parseMenuSelection(answer, map, allIds, allNum) {
  const raw = String(answer ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      error: `Enter one or more numbers (e.g. 1 or 1,3) or ${allNum} for all`,
    };
  }
  if (raw === allNum || /^all$/i.test(raw)) {
    return { ok: true, ids: [...allIds] };
  }
  const tokens = raw.split(/[,\s]+/).filter(Boolean);
  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const bad = [];
  for (const t of tokens) {
    if (t === allNum || /^all$/i.test(t)) {
      return { ok: true, ids: [...allIds] };
    }
    const id = map[t];
    if (!id) bad.push(t);
    else if (!ids.includes(id)) ids.push(id);
  }
  if (bad.length) {
    return {
      ok: false,
      error: `Unknown choice(s): ${bad.join(', ')}. Use listed numbers or ${allNum} for all`,
    };
  }
  if (ids.length === 0) {
    return { ok: false, error: 'Nothing selected' };
  }
  return { ok: true, ids };
}
