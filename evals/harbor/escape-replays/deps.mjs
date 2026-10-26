/**
 * What an escape-replay task treats as its dependency and runner contract (specs/changes/escape-replays):
 * the files the verifier installs from and the files the agent must leave alone. Shared by
 * calibration (to drop a reference that changes them), the task writer (Dockerfiles, `hidden.json`)
 * and, through `hidden.json`, the grader.
 */

/** Lockfiles, in the order that picks the install command. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

/**
 * Files in a rule's cwd that decide which dependencies and which runner configuration the hidden
 * tests run under. The agent may not change, add or remove them; a reference that changes one is
 * not a task. The `jest` field of `package.json` is covered by the manifest's hash.
 *
 * ponytail: top-level files of the rule's cwd only. A config that extends or imports a file
 * elsewhere (`tsconfig.base.json`, `jest.setup.js`) is only as protected as that file is.
 */
export const PROTECTED_NAME = String.raw`^(?:package\.json|${LOCKFILES.map((n) => n.replace(/\./g, '\\.')).join('|')}|(?:jest|vitest|vite|babel)\.config\.[A-Za-z0-9]+|\.babelrc(?:\..*)?|tsconfig[^/\\]*\.json)$`;

export const isProtectedName = (/** @type {string} */ name) => new RegExp(PROTECTED_NAME).test(name);

/** The install command for a folder, picked by the lockfile it has. @param {Iterable<string>} names the folder's file names */
export function installCommand(names) {
  const has = new Set(names);
  if (has.has('package-lock.json') || has.has('npm-shrinkwrap.json')) return 'npm ci';
  if (has.has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (has.has('pnpm-lock.yaml')) return 'corepack enable && pnpm install --frozen-lockfile';
  return 'npm install';
}

/** Which MongoDB test-server package (if any) a package.json depends on. */
export function mongoPackage(/** @type {any} */ pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return ['mongodb-memory-server', 'mongodb-memory-server-core'].find((name) => name in deps) ?? null;
}
