#!/usr/bin/env node
/**
 * ADR project/user config + scaffolding for forgekit.
 *
 * User defaults:  ~/.forgekit/config.json  → { adr: { enabled, dir } }
 * Project:        <repo>/.forge/config.json → { adr: { enabled, dir, decisionsDoc } }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ADR_DIR = 'docs/adr';
export const ADR_SKILLS = Object.freeze(['archive-to-adr', 'git-resolve-adr-conflict']);

/**
 * @param {string} adrDir posix-ish relative path
 * @returns {string}
 */
export function decisionsDocFor(adrDir) {
  const normalized = normalizeAdrDir(adrDir);
  const parent = path.posix.dirname(normalized);
  if (!parent || parent === '.') return 'decisions.md';
  return path.posix.join(parent, 'decisions.md');
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeAdrDir(raw) {
  let s = String(raw ?? '')
    .trim()
    .replace(/\\/g, '/');
  if (!s) s = DEFAULT_ADR_DIR;
  s = s.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!s) s = DEFAULT_ADR_DIR;
  if (path.isAbsolute(s) || s.startsWith('..') || s.split('/').includes('..')) {
    throw new Error(
      `ADR directory must be a relative path inside the repo (got: ${raw})`,
    );
  }
  return s;
}

/**
 * @param {string} [home]
 * @returns {string}
 */
export function userConfigPath(home = os.homedir()) {
  return path.join(home, '.forgekit', 'config.json');
}

/**
 * @param {string} [home]
 * @returns {{ adr?: { enabled?: boolean, dir?: string } }}
 */
export function loadUserConfig(home = os.homedir()) {
  const p = userConfigPath(home);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {{ adr?: { enabled?: boolean, dir?: string } }} patch
 * @param {string} [home]
 */
export function saveUserConfig(patch, home = os.homedir()) {
  const dir = path.dirname(userConfigPath(home));
  fs.mkdirSync(dir, { recursive: true });
  const current = loadUserConfig(home);
  const next = {
    ...current,
    ...patch,
    adr: {
      ...(current.adr ?? {}),
      ...(patch.adr ?? {}),
    },
  };
  fs.writeFileSync(userConfigPath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function projectConfigPath(cwd) {
  return path.join(cwd, '.forge', 'config.json');
}

/**
 * @param {string} cwd
 * @returns {{ adr?: { enabled?: boolean, dir?: string, decisionsDoc?: string } }}
 */
export function loadProjectConfig(cwd) {
  const p = projectConfigPath(cwd);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {string} cwd
 * @param {{ adr: { enabled: boolean, dir?: string, decisionsDoc?: string } }} patch
 * @param {{ force?: boolean }} [opts]
 */
export function writeProjectAdrConfig(cwd, patch, opts = {}) {
  const p = projectConfigPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const current = loadProjectConfig(cwd);
  const enabled = Boolean(patch.adr.enabled);
  /** @type {{ enabled: boolean, dir?: string, decisionsDoc?: string }} */
  const adr = { enabled };
  if (enabled) {
    const dir = normalizeAdrDir(patch.adr.dir ?? current.adr?.dir ?? DEFAULT_ADR_DIR);
    adr.dir = dir;
    adr.decisionsDoc =
      patch.adr.decisionsDoc ??
      current.adr?.decisionsDoc ??
      decisionsDocFor(dir);
  }
  const next = { ...current, adr };
  if (fs.existsSync(p) && !opts.force) {
    // merge write always allowed for config — callers pass force for scaffold files
  }
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * @returns {string}
 */
export function resolveAdrTemplatesRoot() {
  const fromEnv = process.env.FORGEKIT_ROOT
    ? path.join(process.env.FORGEKIT_ROOT, 'templates', 'adr')
    : null;
  const fromRepo = path.resolve(__dirname, '..', '..', '..', 'templates', 'adr');
  for (const c of [fromEnv, fromRepo].filter(Boolean)) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('templates/adr not found under forgekit root');
}

/**
 * @param {string} template
 * @param {Record<string, string>} vars
 */
function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/**
 * Relative link from adr README to decisions doc.
 * @param {string} adrDir
 * @param {string} decisionsDoc
 */
export function decisionsRelFromAdrReadme(adrDir, decisionsDoc) {
  const fromDir = adrDir.replace(/\/+$/, '');
  const target = decisionsDoc.replace(/\\/g, '/');
  // both relative to repo root — compute posix relative
  const rel = path.posix.relative(fromDir, target);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Scaffold decisions.md, adr README, optional hooks.
 * @param {string} cwd
 * @param {{ dir?: string, decisionsDoc?: string, force?: boolean, hooks?: boolean }} opts
 */
export function scaffoldAdr(cwd, opts = {}) {
  const dir = normalizeAdrDir(opts.dir ?? DEFAULT_ADR_DIR);
  const decisionsDoc = opts.decisionsDoc ?? decisionsDocFor(dir);
  const templates = resolveAdrTemplatesRoot();
  const force = Boolean(opts.force);
  /** @type {{ file: string, status: string }[]} */
  const files = [];

  const write = (relPath, body) => {
    const dest = path.join(cwd, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && !force) {
      files.push({ file: relPath, status: 'skipped' });
      return;
    }
    fs.writeFileSync(dest, body, 'utf8');
    files.push({ file: relPath, status: 'written' });
  };

  const decisionsTpl = fs.readFileSync(path.join(templates, 'decisions.md'), 'utf8');
  write(
    decisionsDoc,
    renderTemplate(decisionsTpl, { ADR_DIR: dir }),
  );

  const readmeTpl = fs.readFileSync(path.join(templates, 'README.md'), 'utf8');
  write(
    path.posix.join(dir, 'README.md'),
    renderTemplate(readmeTpl, {
      ADR_DIR: dir,
      DECISIONS_REL: decisionsRelFromAdrReadme(dir, decisionsDoc),
    }),
  );

  if (opts.hooks !== false) {
    const hooksSrc = path.join(templates, 'hooks');
    if (fs.existsSync(hooksSrc)) {
      const hooksDestRel = 'scripts/hooks';
      for (const name of fs.readdirSync(hooksSrc)) {
        const from = path.join(hooksSrc, name);
        if (!fs.statSync(from).isFile()) continue;
        const rel = path.posix.join(hooksDestRel, name);
        const body = fs.readFileSync(from, 'utf8');
        write(rel, body);
      }
    }
  }

  const config = writeProjectAdrConfig(
    cwd,
    { adr: { enabled: true, dir, decisionsDoc } },
    { force },
  );

  return { dir, decisionsDoc, files, config };
}

/**
 * Disable ADRs in the project (config only; does not delete existing docs).
 * @param {string} cwd
 */
export function disableProjectAdr(cwd) {
  return writeProjectAdrConfig(cwd, { adr: { enabled: false } });
}

/**
 * @param {string} cwd
 * @returns {boolean}
 */
export function isGitRepo(cwd) {
  return fs.existsSync(path.join(cwd, '.git'));
}

/**
 * Effective ADR settings for a project.
 * @param {string} cwd
 * @param {{ home?: string }} [opts]
 * @returns {{ enabled: boolean, dir: string, decisionsDoc: string, source: string }}
 */
export function resolveProjectAdr(cwd, opts = {}) {
  const project = loadProjectConfig(cwd);
  if (project.adr && typeof project.adr.enabled === 'boolean') {
    const dir = normalizeAdrDir(project.adr.dir ?? DEFAULT_ADR_DIR);
    return {
      enabled: project.adr.enabled,
      dir,
      decisionsDoc: project.adr.decisionsDoc ?? decisionsDocFor(dir),
      source: 'project',
    };
  }
  const user = loadUserConfig(opts.home);
  if (user.adr && typeof user.adr.enabled === 'boolean') {
    const dir = normalizeAdrDir(user.adr.dir ?? DEFAULT_ADR_DIR);
    return {
      enabled: user.adr.enabled,
      dir,
      decisionsDoc: decisionsDocFor(dir),
      source: 'user',
    };
  }
  // Heuristic: existing adr tree
  if (fs.existsSync(path.join(cwd, DEFAULT_ADR_DIR))) {
    return {
      enabled: true,
      dir: DEFAULT_ADR_DIR,
      decisionsDoc: decisionsDocFor(DEFAULT_ADR_DIR),
      source: 'heuristic',
    };
  }
  return {
    enabled: false,
    dir: DEFAULT_ADR_DIR,
    decisionsDoc: decisionsDocFor(DEFAULT_ADR_DIR),
    source: 'default',
  };
}
