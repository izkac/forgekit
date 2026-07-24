#!/usr/bin/env node
/**
 * Merge OpenSpec-format delta specs into the main capability catalog.
 *
 * Delta:  <change>/specs/<capability>/spec.md  (## ADDED / MODIFIED / REMOVED)
 * Main:   <plan.dir>/specs/<capability>/spec.md
 *
 * Format matches OpenSpec (Fission-AI) — there is no `deltas/` directory name.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} body
 * @returns {{ added: string, modified: string, removed: string, preamble: string }}
 */
export function parseDeltaSections(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const markers = [
    { key: 'added', re: /^##\s+ADDED\s+Requirements\s*$/im },
    { key: 'modified', re: /^##\s+MODIFIED\s+Requirements\s*$/im },
    { key: 'removed', re: /^##\s+REMOVED\s+Requirements\s*$/im },
  ];

  /** @type {{ key: string, index: number, headerLen: number }[]} */
  const hits = [];
  for (const m of markers) {
    const match = m.re.exec(text);
    if (match) hits.push({ key: m.key, index: match.index, headerLen: match[0].length });
  }
  hits.sort((a, b) => a.index - b.index);

  /** @type {{ added: string, modified: string, removed: string, preamble: string }} */
  const out = { added: '', modified: '', removed: '', preamble: text };
  if (hits.length === 0) return out;

  out.preamble = text.slice(0, hits[0].index).trimEnd();
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index + hits[i].headerLen;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    out[/** @type {'added'|'modified'|'removed'} */ (hits[i].key)] = text
      .slice(start, end)
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  }
  return out;
}

/**
 * Split a requirements body into `### Requirement: …` blocks.
 * @param {string} body
 * @returns {{ title: string, block: string }[]}
 */
export function splitRequirements(body) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const parts = text.split(/^###\s+Requirement:\s*/m);
  /** @type {{ title: string, block: string }[]} */
  const out = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nl = trimmed.indexOf('\n');
    const title = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
    const rest = nl === -1 ? '' : trimmed.slice(nl + 1).replace(/^\n/, '');
    out.push({
      title,
      block: `### Requirement: ${title}${rest ? `\n${rest}` : ''}`.trimEnd(),
    });
  }
  return out;
}

/**
 * @param {string} title
 */
function titleKey(title) {
  return title.trim().toLowerCase();
}

/**
 * Ensure a main capability spec has Purpose + Requirements scaffolding.
 * @param {string} capability
 * @param {string} [existing]
 */
export function ensureMainSpecSkeleton(capability, existing = '') {
  const body = String(existing || '').replace(/\r\n/g, '\n').trim();
  if (body) return body.endsWith('\n') ? body : `${body}\n`;
  const label = capability
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `# ${label} Spec\n\n## Purpose\n\nDescribe this capability.\n\n## Requirements\n`;
}

/**
 * Apply one delta file onto a main capability spec body.
 * @param {string} capability
 * @param {string} mainBody
 * @param {string} deltaBody
 * @returns {string}
 */
export function applyDeltaToMain(capability, mainBody, deltaBody) {
  const delta = parseDeltaSections(deltaBody);
  let main = ensureMainSpecSkeleton(capability, mainBody);

  // Locate ## Requirements section; append after it if missing.
  if (!/^##\s+Requirements\s*$/m.test(main)) {
    main = `${main.trimEnd()}\n\n## Requirements\n`;
  }

  const reqMatch = /^##\s+Requirements\s*$/m.exec(main);
  const reqHeaderEnd = reqMatch ? reqMatch.index + reqMatch[0].length : main.length;
  const before = main.slice(0, reqHeaderEnd);
  const afterReq = main.slice(reqHeaderEnd);
  // Stop at next ## section if any
  const nextSection = /^##\s+/m.exec(afterReq.replace(/^\n/, ''));
  // Simpler: treat everything after ## Requirements as the requirements body
  // until EOF (OpenSpec main specs usually end there).
  let reqBody = afterReq.replace(/^\n+/, '');
  const trailingMatch = /\n##\s+(?!Requirements).*$/m.exec(`\n${reqBody}`);
  let trailing = '';
  if (trailingMatch && trailingMatch.index > 0) {
    trailing = reqBody.slice(trailingMatch.index);
    reqBody = reqBody.slice(0, trailingMatch.index).replace(/\n+$/, '');
  }

  let reqs = splitRequirements(reqBody);
  const byKey = new Map(reqs.map((r) => [titleKey(r.title), r]));

  for (const r of splitRequirements(delta.added)) {
    if (!byKey.has(titleKey(r.title))) {
      reqs.push(r);
      byKey.set(titleKey(r.title), r);
    } else {
      // Already present — treat ADDED as upsert
      const idx = reqs.findIndex((x) => titleKey(x.title) === titleKey(r.title));
      reqs[idx] = r;
      byKey.set(titleKey(r.title), r);
    }
  }

  for (const r of splitRequirements(delta.modified)) {
    const idx = reqs.findIndex((x) => titleKey(x.title) === titleKey(r.title));
    if (idx >= 0) {
      reqs[idx] = r;
      byKey.set(titleKey(r.title), r);
    } else {
      reqs.push(r);
      byKey.set(titleKey(r.title), r);
    }
  }

  for (const r of splitRequirements(delta.removed)) {
    reqs = reqs.filter((x) => titleKey(x.title) !== titleKey(r.title));
  }

  const mergedReqs = reqs.map((r) => r.block).join('\n\n');
  const next = `${before.replace(/\n+$/, '\n')}\n${mergedReqs}${
    mergedReqs ? '\n' : ''
  }${trailing}`;
  return next.endsWith('\n') ? next : `${next}\n`;
}

/**
 * List capability ids that have a delta spec.md under changeDir/specs/.
 * @param {string} changeDir
 * @returns {string[]}
 */
export function listDeltaCapabilities(changeDir) {
  const specsRoot = path.join(changeDir, 'specs');
  if (!fs.existsSync(specsRoot)) return [];
  return fs
    .readdirSync(specsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(specsRoot, name, 'spec.md')))
    .sort();
}

/**
 * Merge all deltas from a change folder into `<mainSpecsDir>/<cap>/spec.md`.
 * @param {string} changeDir absolute path to the change folder
 * @param {string} mainSpecsDir absolute path to `<plan.dir>/specs`
 * @returns {{ capability: string, status: string, file: string }[]}
 */
export function mergeChangeDeltas(changeDir, mainSpecsDir) {
  /** @type {{ capability: string, status: string, file: string }[]} */
  const results = [];
  fs.mkdirSync(mainSpecsDir, { recursive: true });

  for (const capability of listDeltaCapabilities(changeDir)) {
    const deltaPath = path.join(changeDir, 'specs', capability, 'spec.md');
    const mainPath = path.join(mainSpecsDir, capability, 'spec.md');
    const deltaBody = fs.readFileSync(deltaPath, 'utf8');
    const hadMain = fs.existsSync(mainPath);
    const mainBody = hadMain ? fs.readFileSync(mainPath, 'utf8') : '';
    const next = applyDeltaToMain(capability, mainBody, deltaBody);
    fs.mkdirSync(path.dirname(mainPath), { recursive: true });
    fs.writeFileSync(mainPath, next, 'utf8');
    results.push({
      capability,
      status: hadMain ? 'updated' : 'created',
      file: mainPath,
    });
  }
  return results;
}

/**
 * OpenSpec-format delta stub for a new capability.
 * @param {string} capability
 */
export function deltaSpecTemplate(capability) {
  const label = capability
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `# Delta for ${label}

## ADDED Requirements

### Requirement: ${label} behavior
The system SHALL …

#### Scenario: Happy path
- GIVEN …
- WHEN …
- THEN …
`;
}
