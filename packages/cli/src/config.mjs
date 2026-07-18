#!/usr/bin/env node
/**
 * Shared user (~/.forgekit/config.json) and project (.forge/config.json) config IO.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} [home]
 * @returns {string}
 */
export function userConfigPath(home = os.homedir()) {
  return path.join(home, '.forgekit', 'config.json');
}

/**
 * @param {string} [home]
 * @returns {Record<string, unknown>}
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
 * Deep-merge top-level keys; nested objects under named keys are shallow-merged.
 * @param {Record<string, unknown>} patch
 * @param {string} [home]
 * @param {string[]} [mergeKeys] keys to shallow-merge instead of replace
 */
export function saveUserConfig(patch, home = os.homedir(), mergeKeys = ['adr', 'plan']) {
  const dir = path.dirname(userConfigPath(home));
  fs.mkdirSync(dir, { recursive: true });
  const current = loadUserConfig(home);
  /** @type {Record<string, unknown>} */
  const next = { ...current, ...patch };
  for (const key of mergeKeys) {
    if (patch[key] && typeof patch[key] === 'object') {
      next[key] = {
        ...((current[key] && typeof current[key] === 'object' ? current[key] : {})),
        .../** @type {Record<string, unknown>} */ (patch[key]),
      };
    }
  }
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
 * @returns {Record<string, unknown>}
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
 * Merge-write project config. Nested mergeKeys are shallow-merged unless listed in replaceKeys.
 * @param {string} cwd
 * @param {Record<string, unknown>} patch
 * @param {{ mergeKeys?: string[], replaceKeys?: string[] }} [opts]
 */
export function saveProjectConfig(cwd, patch, opts = {}) {
  const mergeKeys = opts.mergeKeys ?? ['adr', 'plan'];
  const replaceKeys = new Set(opts.replaceKeys ?? []);
  const p = projectConfigPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const current = loadProjectConfig(cwd);
  /** @type {Record<string, unknown>} */
  const next = { ...current, ...patch };
  for (const key of mergeKeys) {
    if (replaceKeys.has(key)) continue;
    if (patch[key] && typeof patch[key] === 'object') {
      next[key] = {
        ...((current[key] && typeof current[key] === 'object' ? current[key] : {})),
        .../** @type {Record<string, unknown>} */ (patch[key]),
      };
    }
  }
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
