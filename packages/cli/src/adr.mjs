#!/usr/bin/env node
/**
 * ADR project/user config + scaffolding for forgekit.
 *
 * User defaults:  ~/.forgekit/config.json  → { adr: { enabled, dir } }
 * Project:        <repo>/.forge/config.json → { adr: { enabled, dir, decisionsDoc } }
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  loadProjectConfig,
  loadUserConfig,
  saveProjectConfig,
  saveUserConfig as saveUserConfigBase,
  userConfigPath,
  projectConfigPath,
} from './config.mjs';
import { resolveAsset } from './paths.mjs';

export {
  loadProjectConfig,
  loadUserConfig,
  userConfigPath,
  projectConfigPath,
};

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
 * @param {{ adr?: { enabled?: boolean, dir?: string } }} patch
 * @param {string} [home]
 */
export function saveUserConfig(patch, home) {
  return saveUserConfigBase(patch, home);
}

/**
 * @param {string} cwd
 * @param {{ adr: { enabled: boolean, dir?: string, decisionsDoc?: string } }} patch
 */
export function writeProjectAdrConfig(cwd, patch) {
  const current = loadProjectConfig(cwd);
  const enabled = Boolean(patch.adr.enabled);
  /** @type {{ enabled: boolean, dir?: string, decisionsDoc?: string }} */
  const adr = { enabled };
  if (enabled) {
    const curAdr =
      current.adr && typeof current.adr === 'object'
        ? /** @type {{ dir?: string, decisionsDoc?: string }} */ (current.adr)
        : {};
    const dir = normalizeAdrDir(patch.adr.dir ?? curAdr.dir ?? DEFAULT_ADR_DIR);
    adr.dir = dir;
    adr.decisionsDoc =
      patch.adr.decisionsDoc ?? curAdr.decisionsDoc ?? decisionsDocFor(dir);
  }
  return saveProjectConfig(cwd, { adr });
}

/**
 * @returns {string}
 */
export function resolveAdrTemplatesRoot() {
  return resolveAsset('templates/adr');
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
  write(decisionsDoc, renderTemplate(decisionsTpl, { ADR_DIR: dir }));

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
        write(path.posix.join(hooksDestRel, name), fs.readFileSync(from, 'utf8'));
      }
    }
  }

  const config = writeProjectAdrConfig(cwd, {
    adr: { enabled: true, dir, decisionsDoc },
  });

  return { dir, decisionsDoc, files, config };
}

/**
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
 * @param {string} cwd
 * @param {{ home?: string }} [opts]
 * @returns {{ enabled: boolean, dir: string, decisionsDoc: string, source: string }}
 */
export function resolveProjectAdr(cwd, opts = {}) {
  const project = loadProjectConfig(cwd);
  const projectAdr =
    project.adr && typeof project.adr === 'object'
      ? /** @type {{ enabled?: boolean, dir?: string, decisionsDoc?: string }} */ (project.adr)
      : null;
  if (projectAdr && typeof projectAdr.enabled === 'boolean') {
    const dir = normalizeAdrDir(projectAdr.dir ?? DEFAULT_ADR_DIR);
    return {
      enabled: projectAdr.enabled,
      dir,
      decisionsDoc: projectAdr.decisionsDoc ?? decisionsDocFor(dir),
      source: 'project',
    };
  }
  const user = loadUserConfig(opts.home);
  const userAdr =
    user.adr && typeof user.adr === 'object'
      ? /** @type {{ enabled?: boolean, dir?: string }} */ (user.adr)
      : null;
  if (userAdr && typeof userAdr.enabled === 'boolean') {
    const dir = normalizeAdrDir(userAdr.dir ?? DEFAULT_ADR_DIR);
    return {
      enabled: userAdr.enabled,
      dir,
      decisionsDoc: decisionsDocFor(dir),
      source: 'user',
    };
  }
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
