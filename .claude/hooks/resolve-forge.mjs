/**
 * Resolve a `forge` invocation that never needs a shell.
 *
 * Windows `forge` on PATH is a `.cmd` shim; CreateProcess cannot run it
 * without cmd.exe. We find the real `forge.mjs` and spawn
 * `node <forge.mjs> …` with `shell: false` on every platform, so hook argv
 * (prompts, file paths, session ids) is never joined into a cmd.exe string.
 *
 * Override: set `FORGE_HOOK_FORGE_CMD` (or pass `override`) to a
 * space-quoted command, e.g. `"node" "/path/to/forge.mjs"`.
 */

import fs from 'node:fs';
import path from 'node:path';

const FORGE_MJS = 'forge.mjs';

/**
 * @param {unknown} override
 * @returns {{ cmd: string, baseArgs: string[], shell: false } | null}
 */
export function parseQuotedCommand(override) {
  if (typeof override !== 'string' || !override.trim()) return null;
  const tokens = override.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const parts = tokens.map((t) =>
    t.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'),
  );
  if (parts.length === 0) return null;
  return { cmd: parts[0], baseArgs: parts.slice(1), shell: false };
}

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string[]} names
 * @param {string} [pathEnv]
 * @returns {string | null}
 */
function firstPathHit(names, pathEnv) {
  const dirs = String(pathEnv ?? process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsFile(candidate)) return candidate;
    }
  }
  return null;
}

function readShebang(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(80);
    const n = fs.readSync(fd, buf, 0, 80, 0);
    fs.closeSync(fd);
    const line = buf.toString('utf8', 0, n).split(/\r?\n/, 1)[0] || '';
    return line.startsWith('#!') ? line : '';
  } catch {
    return '';
  }
}

function looksLikeNodeScript(file) {
  if (/\.(mjs|cjs|js)$/i.test(file)) return true;
  return /node/i.test(readShebang(file));
}

/**
 * Read an npm `forge.cmd` shim and return the `forge.mjs` it points at.
 * @param {string} cmdPath
 * @returns {string | null}
 */
export function resolveFromCmdShim(cmdPath) {
  let body;
  try {
    body = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);
  for (const match of body.matchAll(/["']([^"']*forge\.mjs)["']/gi)) {
    let rel = match[1].replace(/\\/g, '/');
    rel = rel.replace(/^%~dp0\/?/, '').replace(/^%dp0%\/?/, '');
    const abs = path.isAbsolute(rel) ? rel : path.join(dir, ...rel.split('/').filter(Boolean));
    if (existsFile(abs)) return abs;
  }
  const relatives = [
    path.join(dir, 'node_modules', '@izkac', 'forgekit', 'bin', FORGE_MJS),
    path.join(dir, '..', '@izkac', 'forgekit', 'bin', FORGE_MJS),
    path.join(dir, '..', 'lib', 'node_modules', '@izkac', 'forgekit', 'bin', FORGE_MJS),
    path.join(dir, '..', '..', 'packages', 'cli', 'bin', FORGE_MJS),
  ];
  for (const candidate of relatives) {
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {{ path?: string }} [opts]
 * @returns {string | null}
 */
export function resolveForgeMjs(opts = {}) {
  const pathEnv = opts.path ?? process.env.PATH;
  const names =
    process.platform === 'win32'
      ? [FORGE_MJS, 'forge.cmd', 'forge.exe', 'forge']
      : ['forge', FORGE_MJS];

  const found = firstPathHit(names, pathEnv);
  if (!found) return null;

  try {
    const real = fs.realpathSync(found);
    if (looksLikeNodeScript(real)) return real;
  } catch {
    // fall through to shim / shebang checks on the unresolved path
  }

  if (/\.(cmd|bat)$/i.test(found)) {
    const fromShim = resolveFromCmdShim(found);
    if (fromShim) return fromShim;
  }

  if (looksLikeNodeScript(found)) return found;
  return null;
}

/**
 * @param {{ override?: string | null, path?: string }} [opts]
 * @returns {{ cmd: string, baseArgs: string[], shell: false }}
 */
export function resolveForgeInvocation(opts = {}) {
  const override = opts.override ?? process.env.FORGE_HOOK_FORGE_CMD ?? null;
  const parsed = parseQuotedCommand(override);
  if (parsed) return parsed;

  const script = resolveForgeMjs(opts);
  if (script) return { cmd: process.execPath, baseArgs: [script], shell: false };
  return { cmd: 'forge', baseArgs: [], shell: false };
}
