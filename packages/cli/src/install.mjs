#!/usr/bin/env node
/**
 * Install forgekit skills into user-level agent skill directories.
 *
 * Canonical entry: `forgekit install`
 * Aliases: `forge install` → --skills forge
 *          `review install` → --skills thorough-code-review
 *
 * Usage:
 *   forgekit install
 *   forgekit install --skills forge,thorough-code-review --agents cursor,claude
 *   forgekit install --all-skills --all-agents --force
 *   forgekit list
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADR_SKILLS,
  DEFAULT_ADR_DIR,
  isGitRepo,
  normalizeAdrDir,
  saveUserConfig,
  scaffoldAdr,
  disableProjectAdr,
} from './adr.mjs';
import { saveUserPlanEngine } from './plan-engine.mjs';
import { cliPackageRoot, hashDirectory, packageVersion, resolveAsset } from './paths.mjs';

export const FORGEKIT_STAMP = '.forgekit.json';

/**
 * Lazy: `@inquirer/prompts` is a real amount of code that most importers of
 * this module never need — e.g. `forge doctor --install` reaches
 * `installedManagedPairs`/`AGENTS` through here but never prompts. Load it
 * only where a prompt actually runs.
 */
function loadPrompts() {
  return import('@inquirer/prompts');
}

/** @type {Record<string, { label: string, nextHint: string }>} */
export const SKILLS = {
  forge: {
    label: 'Forge',
    nextHint:
      'Forge: in each project, run `forge init` to add /forge commands, rules, and hooks.',
  },
  'thorough-code-review': {
    label: 'Thorough Code Review',
    nextHint:
      'Thorough Code Review: invoke the skill explicitly (no auto-load). CLI: `review new|render|export|…`.',
  },
  'archive-to-adr': {
    label: 'Archive → ADR',
    nextHint:
      'ADRs: after OpenSpec archive, run archive-to-adr (or stamp “No ADR”). Project path from `.forge/config.json`.',
  },
  'git-resolve-adr-conflict': {
    label: 'Git: resolve ADR number conflict',
    nextHint:
      'ADR conflicts: invoke git-resolve-adr-conflict when two authors collide on the same NNNN.',
  },
  'plain-language': {
    label: 'Plain Language',
    nextHint:
      'Plain Language: always-on style for dev tasks. For every-session enforcement, paste PORTABLE-RULES.md into the agent’s global instructions (CLAUDE.md / AGENTS.md).',
  },
};

export const SKILL_IDS = Object.freeze(Object.keys(SKILLS));

/**
 * Real files always land at `~/.agents/skills/<skill>/`.
 * Harnesses that do not discover that root get a directory symlink at
 * `vendorLink` (Claude Code, Windsurf). Native `.agents` tools get no extra path.
 * @param {string} home
 * @param {string} skillId
 */
function agentsSkillDir(home, skillId) {
  return path.join(home, '.agents', 'skills', skillId);
}

/**
 * Supported environments and their user-level skills directory.
 * @type {Record<string, { label: string, skillDir: (home: string, skillId: string) => string, vendorLink?: (home: string, skillId: string) => string }>}
 */
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    skillDir: agentsSkillDir,
    vendorLink: (home, skillId) => path.join(home, '.claude', 'skills', skillId),
  },
  cursor: {
    label: 'Cursor',
    skillDir: agentsSkillDir,
  },
  codex: {
    label: 'Codex CLI',
    skillDir: agentsSkillDir,
  },
  copilot: {
    label: 'GitHub Copilot',
    skillDir: agentsSkillDir,
  },
  gemini: {
    label: 'Gemini CLI',
    skillDir: agentsSkillDir,
  },
  windsurf: {
    label: 'Windsurf',
    skillDir: agentsSkillDir,
    vendorLink: (home, skillId) =>
      path.join(home, '.codeium', 'windsurf', 'skills', skillId),
  },
  opencode: {
    label: 'opencode',
    skillDir: agentsSkillDir,
  },
};

export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));

/** Harnesses that discover `~/.agents/skills/` natively (picker defaults). */
export const AGENTS_SHARING_AGENTS_ROOT = Object.freeze([
  'cursor',
  'codex',
  'copilot',
  'gemini',
  'opencode',
]);

/** Harnesses that need a vendor-path symlink to the canonical dest. */
export const AGENTS_WITH_VENDOR_LINK = Object.freeze(
  AGENT_IDS.filter((id) => typeof AGENTS[id].vendorLink === 'function'),
);

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    skills: /** @type {string[]} */ ([]),
    agents: /** @type {string[]} */ ([]),
    allSkills: false,
    allAgents: false,
    /** @deprecated use --all-agents; kept for forge/review install aliases */
    all: false,
    list: false,
    help: false,
    force: false,
    prune: false,
    update: false,
    uninstall: false,
    /** Skip `npm i -g` when running `forgekit update`. */
    noPkg: false,
    /** @type {boolean | null} null = unset (prompt / infer) */
    adr: /** @type {boolean | null} */ (null),
    adrDir: /** @type {string | null} */ (null),
    /** @type {boolean | null} null = unset (prompt on TTY) */
    openspec: /** @type {boolean | null} */ (null),
    /** When true, also scaffold ADR files into cwd if it looks like a project */
    adrProject: false,
    noAdrProject: false,
    cwd: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skills' || arg === '--skill') {
      opts.skills.push(...splitList(argv[++i]));
    } else if (arg === '--agents' || arg === '--agent') {
      opts.agents.push(...splitList(argv[++i]));
    } else if (arg === '--all-skills') opts.allSkills = true;
    else if (arg === '--all-agents') opts.allAgents = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--update') opts.update = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--no-pkg' || arg === '--skip-package') opts.noPkg = true;
    else if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--prune') opts.prune = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--shared') {
      throw new Error(
        '--shared is not a flag; install with a harness that maps to ~/.agents/skills (e.g. --cursor or --codex)',
      );
    }
    else if (arg === '--cursor') opts.agents.push('cursor');
    else if (arg === '--claude' || arg === '--claude-code') opts.agents.push('claude');
    else if (arg === '--codex') opts.agents.push('codex');
    else if (arg === '--copilot') opts.agents.push('copilot');
    else if (arg === '--gemini') opts.agents.push('gemini');
    else if (arg === '--windsurf') opts.agents.push('windsurf');
    else if (arg === '--opencode') opts.agents.push('opencode');
    else if (arg === '--adr') opts.adr = true;
    else if (arg === '--no-adr') opts.adr = false;
    else if (arg === '--adr-dir') opts.adrDir = argv[++i];
    else if (arg === '--openspec') opts.openspec = true;
    else if (arg === '--no-openspec') opts.openspec = false;
    else if (arg === '--adr-project') opts.adrProject = true;
    else if (arg === '--no-adr-project') opts.noAdrProject = true;
    else if (arg === '--cwd') opts.cwd = argv[++i];
    else if (
      arg === 'forge' ||
      arg === 'thorough-code-review' ||
      arg === 'archive-to-adr' ||
      arg === 'git-resolve-adr-conflict'
    ) {
      opts.skills.push(arg);
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  opts.skills = [...new Set(opts.skills)];
  opts.agents = [...new Set(opts.agents)];
  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: forgekit install [options]

Install one or more skills into ~/.agents/skills/ (one copy per skill).
Claude Code and Windsurf get a directory symlink from their vendor skill
path to that folder. Cursor, Codex, Copilot, Gemini, and OpenCode read
~/.agents/skills/ directly.

Options:
  --skills <ids>    Comma list: ${SKILL_IDS.join(', ')}
  --agents <ids>    Comma list: ${AGENT_IDS.join(', ')}
  --all-skills      Install every known skill
  --all-agents      Install for every agent environment
  --cursor/--claude/--codex/--copilot/--gemini/--windsurf/--opencode
                    Shorthand agent flags (same as --agents)
  --prune           Reconcile: also remove installed skill×env pairs
                    outside the selection (implied by the full picker)
  --openspec        Prefer OpenSpec as the planning engine (save user default)
  --no-openspec     Prefer the built-in specs engine (save user default)
  --adr             Enable ADRs (install ADR skills; save user default)
  --no-adr          Disable ADRs (skip ADR skills; save user default)
  --adr-dir <path>  Default ADR directory inside repos (default: ${DEFAULT_ADR_DIR})
  --adr-project     Also scaffold ADR docs into --cwd when it is a git repo
  --no-adr-project  Never scaffold into cwd
  --cwd <path>      Project root for optional ADR scaffold (default: cwd)
  --list            Show installed vs missing (and outdated) for each unique dest
  --update          Reinstall outdated skills; install a newer global
                    @izkac/forgekit from npm when one is published
  --no-pkg          With --update: refresh skills only (do not npm i -g)
  --uninstall       Remove dests whose recorded harnesses are all selected
  --force, -f       Overwrite existing skill directories
  --help

Interactive (TTY) when skills and/or agents are omitted: arrow-key pickers
(space to toggle, <a> for all) pre-checked with what you already have
installed. Choosing the full set reconciles — newly picked pairs install,
deselected ones are removed. You are also asked whether to plan with OpenSpec
(vs the built-in specs engine). ADRs are enabled by picking an ADR skill; the
ADR path (default ${DEFAULT_ADR_DIR}) is only asked then.

Aliases:
  forge install […]   → forgekit install --skills forge […]
  review install […]  → forgekit install --skills thorough-code-review […]

Examples:
  forgekit install
  forgekit install --skills forge,thorough-code-review --agents cursor --adr
  forgekit install --all-skills --all-agents --force
  forgekit list
  forgekit update
  forgekit uninstall --skills forge --agents cursor
`);
}

/**
 * @param {string} skillId
 * @returns {string}
 */
export function resolveSkillSource(skillId) {
  if (!SKILLS[skillId]) {
    throw new Error(`Unknown skill: ${skillId}. Known: ${SKILL_IDS.join(', ')}`);
  }
  return resolveAsset(path.join('skills', skillId), { requireFile: 'SKILL.md' });
}

/**
 * Write version + content hash stamp into an installed skill directory.
 * @param {string} dest
 * @param {string} skillId
 * @param {string} skillSource
 * @param {string[]} [agentIds] harnesses that own this dest after the write
 */
export function writeInstallStamp(dest, skillId, skillSource, agentIds = []) {
  const prev = readInstallStamp(dest);
  const prevAgents = Array.isArray(prev?.agents) ? prev.agents : [];
  const agents = [...new Set([...prevAgents, ...agentIds])].filter((id) =>
    AGENT_IDS.includes(id),
  );
  const stamp = {
    skill: skillId,
    version: packageVersion(),
    contentHash: hashDirectory(skillSource),
    installedAt: new Date().toISOString(),
    ...(agents.length ? { agents } : {}),
  };
  fs.writeFileSync(
    path.join(dest, FORGEKIT_STAMP),
    `${JSON.stringify(stamp, null, 2)}\n`,
    'utf8',
  );
  return stamp;
}

/**
 * @param {string} dest
 * @returns {{ skill?: string, version?: string, contentHash?: string, agents?: string[] } | null}
 */
export function readInstallStamp(dest) {
  const p = path.join(dest, FORGEKIT_STAMP);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} skillId
 * @param {string} dest
 * @returns {'missing' | 'present' | 'outdated' | 'unversioned'}
 */
export function skillInstallStatus(skillId, dest) {
  if (!fs.existsSync(dest)) return 'missing';
  const stamp = readInstallStamp(dest);
  if (!stamp?.contentHash) return 'unversioned';
  try {
    const source = resolveSkillSource(skillId);
    const current = hashDirectory(source);
    if (stamp.contentHash !== current || stamp.version !== packageVersion()) {
      return 'outdated';
    }
  } catch {
    return 'present';
  }
  return 'present';
}

/**
 * @param {string} src
 * @param {string} dest
 */
export function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * @param {string} dir
 */
function removeDirRecursive(dir) {
  const st = lstatOrNull(dir);
  if (!st) return;
  if (st.isSymbolicLink()) fs.unlinkSync(dir);
  else fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * @param {string} p
 * @returns {fs.Stats | null}
 */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Directory symlink. On Windows, try a real dir symlink first; if the OS
 * refuses (no Developer Mode), fall back to a junction so install still works.
 * @param {string} target
 * @param {string} linkPath
 */
export function createDirSymlink(target, linkPath) {
  const absTarget = path.resolve(target);
  try {
    fs.symlinkSync(absTarget, linkPath, 'dir');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP')
    ) {
      fs.symlinkSync(absTarget, linkPath, 'junction');
      return;
    }
    throw err;
  }
}

/**
 * Point `linkPath` at the canonical skill dest. Replaces a stamped real copy.
 * Leaves an unstamped directory alone (foreign skill).
 * @param {string} targetDir
 * @param {string} linkPath
 * @returns {{ status: 'ok' | 'linked' | 'foreign' }}
 */
export function ensureVendorLink(targetDir, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const st = lstatOrNull(linkPath);
  if (st) {
    if (st.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      if (path.normalize(resolved) === path.normalize(path.resolve(targetDir))) {
        return { status: 'ok' };
      }
      fs.unlinkSync(linkPath);
    } else if (readInstallStamp(linkPath)) {
      removeDirRecursive(linkPath);
    } else {
      return { status: 'foreign' };
    }
  }
  createDirSymlink(targetDir, linkPath);
  return { status: 'linked' };
}

/**
 * @param {string} home
 * @param {string} skillId
 * @param {string} dest
 * @param {string[]} agentIds
 */
function ensureVendorLinks(home, skillId, dest, agentIds) {
  if (!readInstallStamp(dest)) return;
  for (const id of agentIds) {
    const linkFn = AGENTS[id]?.vendorLink;
    if (!linkFn) continue;
    ensureVendorLink(dest, linkFn(home, skillId));
  }
}

/**
 * @param {string} home
 * @param {string} skillId
 * @param {string[]} agentIds
 */
function removeVendorLinks(home, skillId, agentIds) {
  for (const id of agentIds) {
    const linkFn = AGENTS[id]?.vendorLink;
    if (!linkFn) continue;
    const linkPath = linkFn(home, skillId);
    const st = lstatOrNull(linkPath);
    if (!st) continue;
    if (st.isSymbolicLink()) fs.unlinkSync(linkPath);
    else if (readInstallStamp(linkPath)) removeDirRecursive(linkPath);
  }
}

/** Previous vendor layouts for harnesses that now share `~/.agents/skills`. */
const PREVIOUS_VENDOR_SKILL_DIRS = Object.freeze([
  (home, skillId) => path.join(home, '.cursor', 'skills', skillId),
  (home, skillId) => path.join(home, '.codex', 'skills', skillId),
  (home, skillId) => path.join(home, '.copilot', 'skills', skillId),
  (home, skillId) => path.join(home, '.gemini', 'skills', skillId),
  (home, skillId) => path.join(home, '.config', 'opencode', 'skills', skillId),
]);

/**
 * @param {string} home
 * @param {string} skillId
 * @param {string} dest
 */
function retireStampedVendorLeftovers(home, skillId, dest) {
  if (dest !== path.join(home, '.agents', 'skills', skillId)) return;
  for (const skillDir of PREVIOUS_VENDOR_SKILL_DIRS) {
    const vendorDest = skillDir(home, skillId);
    if (vendorDest === dest) continue;
    if (readInstallStamp(vendorDest)) removeDirRecursive(vendorDest);
  }
}

/**
 * Fold a stamped real copy at a vendor-link path into the canonical dest
 * and replace it with a symlink. Unstamped vendor dirs are left alone.
 * @param {string} home
 * @param {string} skillId
 * @param {string} dest
 */
function migrateStampedLinkedVendors(home, skillId, dest) {
  if (dest !== path.join(home, '.agents', 'skills', skillId)) return;
  if (!readInstallStamp(dest)) return;
  const extra = [];
  for (const id of AGENTS_WITH_VENDOR_LINK) {
    const vendor = AGENTS[id].vendorLink(home, skillId);
    const st = lstatOrNull(vendor);
    if (!st || st.isSymbolicLink()) continue;
    if (!readInstallStamp(vendor)) continue;
    extra.push(id);
    ensureVendorLink(dest, vendor);
  }
  if (extra.length) {
    persistStampAgents(dest, [...destOwners(home, skillId, dest), ...extra]);
  }
}

/**
 * @param {string} home
 * @param {string} skillId
 * @param {string} dest
 * @returns {string[]}
 */
function agentsMappingToDest(home, skillId, dest) {
  return AGENT_IDS.filter((id) => AGENTS[id].skillDir(home, skillId) === dest);
}

/**
 * Harnesses recorded as owning this dest. Legacy stamps without `agents`
 * fall back to every AGENTS entry that maps here.
 * @param {string} home
 * @param {string} skillId
 * @param {string} dest
 * @returns {string[]}
 */
function destOwners(home, skillId, dest) {
  const stamp = readInstallStamp(dest);
  const recorded = Array.isArray(stamp?.agents)
    ? stamp.agents.filter((id) => typeof id === 'string')
    : [];
  const known = recorded.filter(
    (id) => AGENT_IDS.includes(id) && AGENTS[id].skillDir(home, skillId) === dest,
  );
  if (known.length) return known;
  return agentsMappingToDest(home, skillId, dest).filter((id) => {
    const linkFn = AGENTS[id].vendorLink;
    if (!linkFn) return true;
    const st = lstatOrNull(linkFn(home, skillId));
    return Boolean(st?.isSymbolicLink());
  });
}

/**
 * Stamped real copy or symlink at a linked harness's vendor path.
 * @param {string} home
 * @param {string} skillId
 * @param {string} agentId
 */
function stampedVendorOwner(home, skillId, agentId) {
  const linkFn = AGENTS[agentId]?.vendorLink;
  if (!linkFn) return false;
  const vendor = linkFn(home, skillId);
  const st = lstatOrNull(vendor);
  if (!st) return false;
  if (st.isSymbolicLink()) return true;
  return Boolean(readInstallStamp(vendor));
}

/**
 * @param {string} dest
 * @param {string[]} agentIds
 */
function persistStampAgents(dest, agentIds) {
  const stamp = readInstallStamp(dest);
  if (!stamp) return;
  stamp.agents = [...new Set(agentIds)].filter((id) => AGENT_IDS.includes(id));
  fs.writeFileSync(
    path.join(dest, FORGEKIT_STAMP),
    `${JSON.stringify(stamp, null, 2)}\n`,
    'utf8',
  );
}

/**
 * @param {string[]} skillIds
 * @param {string[]} agentIds
 * @param {{ force?: boolean, home?: string }} [opts]
 */
export function installSkillsToAgents(skillIds, agentIds, opts = {}) {
  const home = opts.home ?? os.homedir();
  /** @type {{ skill: string, agent: string, dest: string, status: string, message?: string, skillSource?: string }[]} */
  const results = [];

  for (const skillId of skillIds) {
    const skillSource = resolveSkillSource(skillId);
    /** @type {Map<string, string[]>} */
    const destAliases = new Map();
    for (const agentId of agentIds) {
      const agent = AGENTS[agentId];
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      const dest = agent.skillDir(home, skillId);
      const aliases = destAliases.get(dest);
      if (aliases) aliases.push(agentId);
      else destAliases.set(dest, [agentId]);
    }
    for (const [dest, aliases] of destAliases) {
      const agentId = aliases[0];
      const exists = Boolean(lstatOrNull(dest));
      if (exists && !opts.force) {
        const stamp = readInstallStamp(dest);
        if (stamp) {
          persistStampAgents(dest, [...(stamp.agents ?? []), ...aliases]);
          ensureVendorLinks(home, skillId, dest, aliases);
          migrateStampedLinkedVendors(home, skillId, dest);
        }
        results.push({
          skill: skillId,
          agent: agentId,
          dest,
          status: 'exists',
          message: 'already installed (use --force)',
          skillSource,
        });
        continue;
      }
      const prevAgents = readInstallStamp(dest)?.agents ?? [];
      const owners = [...new Set([...prevAgents, ...aliases])];
      if (exists) removeDirRecursive(dest);
      copyDirRecursive(skillSource, dest);
      writeInstallStamp(dest, skillId, skillSource, owners);
      retireStampedVendorLeftovers(home, skillId, dest);
      migrateStampedLinkedVendors(home, skillId, dest);
      ensureVendorLinks(home, skillId, dest, owners);
      results.push({
        skill: skillId,
        agent: agentId,
        dest,
        status: 'installed',
        skillSource,
      });
    }
  }

  return results;
}

/**
 * @param {string[]} skillIds
 * @param {string[]} agentIds
 * @param {{ home?: string }} [opts]
 */
export function uninstallSkillsFromAgents(skillIds, agentIds, opts = {}) {
  const home = opts.home ?? os.homedir();
  /** @type {{ skill: string, agent: string, dest: string, status: string }[]} */
  const results = [];
  const requested = new Set(agentIds);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const skillId of skillIds) {
    for (const agentId of agentIds) {
      const agent = AGENTS[agentId];
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      const dest = agent.skillDir(home, skillId);
      const key = `${skillId}\0${dest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fs.existsSync(dest)) {
        if (stampedVendorOwner(home, skillId, agentId)) {
          removeVendorLinks(home, skillId, [...requested]);
          results.push({ skill: skillId, agent: agentId, dest, status: 'removed' });
        } else {
          results.push({ skill: skillId, agent: agentId, dest, status: 'missing' });
        }
        continue;
      }
      const owners = destOwners(home, skillId, dest);
      const remaining = owners.filter((id) => !requested.has(id));
      removeVendorLinks(home, skillId, [...requested]);
      if (remaining.length) {
        persistStampAgents(dest, remaining);
        results.push({ skill: skillId, agent: agentId, dest, status: 'kept' });
        continue;
      }
      removeVendorLinks(home, skillId, AGENT_IDS);
      removeDirRecursive(dest);
      results.push({ skill: skillId, agent: agentId, dest, status: 'removed' });
    }
  }
  return results;
}

/**
 * Every forgekit-managed skill×agent install currently on disk (has our stamp).
 * This is the "memory" of what was installed — no separate state file needed.
 * @param {string} [home]
 * @returns {{ skill: string, agent: string, dest: string }[]}
 */
export function installedManagedPairs(home = os.homedir()) {
  /** @type {{ skill: string, agent: string, dest: string }[]} */
  const pairs = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const skill of SKILL_IDS) {
    for (const agent of AGENT_IDS) {
      const dest = AGENTS[agent].skillDir(home, skill);
      const key = `${skill}\0${dest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (fs.existsSync(dest) && readInstallStamp(dest)) {
        for (const owner of destOwners(home, skill, dest)) {
          pairs.push({ skill, agent: owner, dest });
        }
        continue;
      }
      for (const linked of AGENTS_WITH_VENDOR_LINK) {
        if (stampedVendorOwner(home, skill, linked)) {
          pairs.push({ skill, agent: linked, dest });
        }
      }
    }
  }
  return pairs;
}

/**
 * Install the selected skills×agents and, when pruning, remove any managed
 * install that falls outside the new selection.
 * @param {string[]} skillIds
 * @param {string[]} agentIds
 * @param {{ home?: string, force?: boolean, prune?: boolean }} [opts]
 */
export function reconcileInstall(skillIds, agentIds, opts = {}) {
  const home = opts.home ?? os.homedir();
  const desired = new Set();
  for (const s of skillIds) for (const a of agentIds) desired.add(`${s}::${a}`);
  /** @type {{ skill: string, agent: string, dest: string, status: string }[]} */
  const removed = [];
  if (opts.prune) {
    /** @type {Map<string, Set<string>>} */
    const dropBySkill = new Map();
    for (const p of installedManagedPairs(home)) {
      if (desired.has(`${p.skill}::${p.agent}`)) continue;
      if (!dropBySkill.has(p.skill)) dropBySkill.set(p.skill, new Set());
      dropBySkill.get(p.skill).add(p.agent);
    }
    for (const [skill, agents] of dropBySkill) {
      for (const r of uninstallSkillsFromAgents([skill], [...agents], { home })) {
        if (r.status === 'removed' || r.status === 'kept') {
          removed.push({
            skill: r.skill,
            agent: r.agent,
            dest: r.dest,
            status: r.status,
          });
        }
      }
    }
  }
  const results = installSkillsToAgents(skillIds, agentIds, {
    home,
    force: opts.force ?? true,
  });
  return { results, removed };
}

/**
 * Reinstall skills that are outdated or unversioned for agents that already have them.
 * @param {{ home?: string, skills?: string[], agents?: string[] }} [opts]
 */
export function updateOutdatedSkills(opts = {}) {
  const home = opts.home ?? os.homedir();
  const skillFilter = opts.skills?.length ? new Set(opts.skills) : null;
  const agentFilter = opts.agents?.length ? new Set(opts.agents) : null;
  /** @type {Map<string, Set<string>>} */
  const bySkill = new Map();

  /** @param {string} skillId @param {string} agentId */
  const add = (skillId, agentId) => {
    if (agentFilter && !agentFilter.has(agentId)) return;
    if (!bySkill.has(skillId)) bySkill.set(skillId, new Set());
    bySkill.get(skillId).add(agentId);
  };

  for (const skillId of SKILL_IDS) {
    if (skillFilter && !skillFilter.has(skillId)) continue;
    const dest = AGENTS.cursor.skillDir(home, skillId);
    const status = skillInstallStatus(skillId, dest);
    const inAgentsSkills = dest.includes(path.join('.agents', 'skills'));
    const recorded =
      fs.existsSync(dest) && readInstallStamp(dest)
        ? destOwners(home, skillId, dest)
        : [];
    const leftoverLinked = AGENTS_WITH_VENDOR_LINK.filter((id) =>
      isStampedRealVendor(home, skillId, id),
    );
    const needsCopy =
      status === 'outdated' || (status === 'unversioned' && !inAgentsSkills);

    if (needsCopy) {
      const owners = recorded.length ? recorded : [...AGENTS_SHARING_AGENTS_ROOT];
      for (const id of owners) add(skillId, id);
      for (const id of leftoverLinked) add(skillId, id);
    } else if (leftoverLinked.length) {
      for (const id of recorded) add(skillId, id);
      for (const id of leftoverLinked) add(skillId, id);
    } else if (status === 'present') {
      migrateStampedLinkedVendors(home, skillId, dest);
      ensureVendorLinks(home, skillId, dest, recorded);
    }
  }

  /** @type {{ skill: string, agent: string, dest: string, status: string }[]} */
  const results = [];
  /** @type {string[]} */
  const skills = [];
  /** @type {string[]} */
  const agents = [];
  for (const [skillId, agentIds] of bySkill) {
    skills.push(skillId);
    const list = [...agentIds];
    for (const id of list) agents.push(id);
    results.push(
      ...installSkillsToAgents([skillId], list, { home, force: true }),
    );
  }
  return { results, skills, agents: [...new Set(agents)] };
}

/**
 * @param {string} home
 * @param {string} skillId
 * @param {string} agentId
 */
function isStampedRealVendor(home, skillId, agentId) {
  const linkFn = AGENTS[agentId]?.vendorLink;
  if (!linkFn) return false;
  const vendor = linkFn(home, skillId);
  const st = lstatOrNull(vendor);
  return Boolean(st && !st.isSymbolicLink() && readInstallStamp(vendor));
}

/**
 * @param {{ home?: string }} [opts]
 */
export function listInstallStatus(opts = {}) {
  const home = opts.home ?? os.homedir();
  /** @type {{ skill: string, dest: string, status: string, agents: string[] }[]} */
  const rows = [];
  for (const skillId of SKILL_IDS) {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const agentId of AGENT_IDS) {
      const dest = AGENTS[agentId].skillDir(home, skillId);
      if (seen.has(dest)) continue;
      seen.add(dest);
      rows.push({
        skill: skillId,
        dest,
        status: skillInstallStatus(skillId, dest),
        agents: agentsMappingToDest(home, skillId, dest),
      });
    }
  }
  return rows;
}

/**
 * @param {string} message
 * @param {string[]} ids
 * @param {string[]} [checkedIds] pre-selected (remembered from prior install)
 * @returns {Promise<string[]>}
 */
async function promptMulti(message, ids, checkedIds = []) {
  const { checkbox } = await loadPrompts();
  const checked = new Set(checkedIds);
  return checkbox({
    message,
    choices: ids.map((id) => ({
      value: id,
      name: SKILLS[id]?.label ?? AGENTS[id]?.label ?? id,
      checked: checked.has(id),
    })),
    required: true,
  });
}

/** @param {string[]} [checkedIds] */
async function promptSkills(checkedIds) {
  // First run (nothing installed): default to all skills, so <enter> = install everything.
  const defaults = checkedIds?.length ? checkedIds : [...SKILL_IDS];
  return promptMulti('Install which skills?', SKILL_IDS, defaults);
}

/** @param {string[]} [checkedIds] */
async function promptAgents(checkedIds) {
  return promptMulti('Install for which environments?', AGENT_IDS, checkedIds ?? []);
}

/**
 * Environments to pre-check in the interactive picker: every harness that
 * maps to `~/.agents/skills`, even on a first run with nothing installed,
 * then any already-installed/remembered environment, deduped. Claude is
 * included only when already installed or remembered.
 * @param {string[]} installedAgents
 * @returns {string[]}
 */
export function defaultAgentSelection(installedAgents) {
  return [...new Set([...AGENTS_SHARING_AGENTS_ROOT, ...installedAgents])];
}

/**
 * @param {string} [defaultDir]
 * @returns {Promise<string>}
 */
export async function promptAdrDir(defaultDir = DEFAULT_ADR_DIR) {
  const { input } = await loadPrompts();
  const dir = await input({
    message: 'ADR directory inside each repo',
    default: defaultDir,
  });
  return normalizeAdrDir(dir.trim() || defaultDir);
}

/**
 * @returns {Promise<boolean>} true = OpenSpec, false = built-in specs engine
 */
export async function promptOpenSpec() {
  const { select } = await loadPrompts();
  return select({
    message: 'Planning engine?',
    choices: [
      { value: true, name: 'OpenSpec (vendor CLI)' },
      { value: false, name: 'Built-in specs engine' },
    ],
  });
}

/**
 * Merge ADR skills into the skill list when ADRs are enabled.
 * @param {string[]} skills
 * @param {boolean} adrEnabled
 * @returns {string[]}
 */
export function applyAdrSkills(skills, adrEnabled) {
  const next = [...skills];
  if (adrEnabled) {
    for (const id of ADR_SKILLS) {
      if (!next.includes(id)) next.push(id);
    }
    return next;
  }
  return next.filter((id) => !ADR_SKILLS.includes(id));
}

/**
 * Infer ADR enablement from explicit skill picks when --adr/--no-adr omitted.
 * @param {string[]} skills
 * @param {boolean | null} adrFlag
 * @returns {boolean | null} null = still unknown
 */
export function inferAdrFromSkills(skills, adrFlag) {
  if (adrFlag !== null) return adrFlag;
  if (skills.some((id) => ADR_SKILLS.includes(id))) return true;
  return null;
}

/**
 * The `adr` slice of the user-config patch, or nothing at all.
 *
 * `null` means the user expressed no preference — no `--adr`, no `--no-adr`, no
 * ADR skill in the selection — and a run that says nothing must not overwrite
 * what they chose before. `forgekit install --skills forge` used to persist
 * `enabled: false` and announce "ADR preference saved: disabled", silently
 * changing the default for every future `forge init`.
 *
 * The `agents` key in the same `saveUserConfig` call already works this way:
 * written only when deliberately chosen, so narrow flag runs do not clobber it.
 *
 * @param {boolean | null} enabled
 * @param {string} dir
 * @returns {Record<string, unknown>} `{}` when there is nothing to record
 */
export function adrConfigPatch(enabled, dir) {
  return enabled === null ? {} : { adr: { enabled, dir } };
}

/**
 * Resolve ADR enablement + directory. ADRs turn on when an ADR skill is picked
 * (or --adr); the path is only asked when enabled — never a standalone prompt.
 *
 * `enabled` is tri-state on purpose: `null` is "the user said nothing", and
 * collapsing it to `false` is what let a skill refresh rewrite a stored
 * preference. Callers deciding whether to *install* ADR skills should test
 * `=== true`; callers deciding whether to *persist* must not treat null as no.
 *
 * @param {{ adr: boolean | null, adrDir: string | null, skills: string[] }} opts
 * @returns {Promise<{ enabled: boolean | null, dir: string }>}
 */
export async function resolveAdrInstallOptions(opts) {
  const inferred = inferAdrFromSkills(opts.skills, opts.adr);
  if (inferred !== true) {
    return {
      enabled: inferred,
      dir: opts.adrDir ? normalizeAdrDir(opts.adrDir) : DEFAULT_ADR_DIR,
    };
  }
  const dir = opts.adrDir
    ? normalizeAdrDir(opts.adrDir)
    : process.stdin.isTTY
      ? await promptAdrDir(DEFAULT_ADR_DIR)
      : DEFAULT_ADR_DIR;
  return { enabled: true, dir };
}

/**
 * @param {string[]} skillsIn
 * @param {string[]} agentsIn
 * @returns {Promise<{ skills: string[], agents: string[], skillsPrompted: boolean, agentsPrompted: boolean } | number>}
 */
async function resolveSkillsAndAgents(skillsIn, agentsIn) {
  let skills = [...skillsIn];
  let agents = [...agentsIn];
  let skillsPrompted = false;
  let agentsPrompted = false;
  const installed = installedManagedPairs();

  if (skills.length === 0) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'No skills specified. Pass --skills / --all-skills, or run in a TTY.\n',
      );
      return 1;
    }
    skills = await promptSkills([...new Set(installed.map((p) => p.skill))]);
    skillsPrompted = true;
  }

  for (const id of skills) {
    if (!SKILLS[id]) {
      process.stderr.write(`Unknown skill: ${id}. Known: ${SKILL_IDS.join(', ')}\n`);
      return 1;
    }
  }

  if (agents.length === 0) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'No agents specified. Pass --agents / --all-agents / --cursor…, or run in a TTY.\n',
      );
      return 1;
    }
    agents = await promptAgents(defaultAgentSelection(installed.map((p) => p.agent)));
    agentsPrompted = true;
  }

  for (const id of agents) {
    if (!AGENTS[id]) {
      process.stderr.write(`Unknown agent: ${id}. Known: ${AGENT_IDS.join(', ')}\n`);
      return 1;
    }
  }

  return { skills, agents, skillsPrompted, agentsPrompted };
}

/**
 * @param {string} latest
 * @param {string} current
 */
export function versionIsNewer(latest, current) {
  const pa = String(latest).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(current).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/** True when this CLI is running from the forgekit git checkout, not a published tarball. */
export function runningFromMonorepo() {
  const repoRoot = path.resolve(cliPackageRoot(), '..', '..');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return (
      pkg.name === 'forgekit' &&
      fs.existsSync(path.join(repoRoot, 'skills', 'forge', 'SKILL.md'))
    );
  } catch {
    return false;
  }
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * @param {string} [pkg]
 * @returns {string | null}
 */
export function fetchRegistryVersion(pkg = '@izkac/forgekit') {
  try {
    const out = execFileSync(npmBin(), ['view', pkg, 'version'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const v = String(out).trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Install a newer global `@izkac/forgekit` when npm has one.
 * Skipped in a git checkout (`runningFromMonorepo`) and when `opts.skip`.
 * @param {{ skip?: boolean }} [opts]
 * @returns {{ status: 'skipped' | 'current' | 'upgraded' | 'offline' | 'failed', latest?: string, current: string, message?: string }}
 */
export function maybeUpdateGlobalPackage(opts = {}) {
  const current = packageVersion();
  if (opts.skip || runningFromMonorepo()) {
    return { status: 'skipped', current };
  }
  const latest = fetchRegistryVersion();
  if (!latest) return { status: 'offline', current };
  if (!versionIsNewer(latest, current)) return { status: 'current', latest, current };
  const r = spawnSync(npmBin(), ['i', '-g', `@izkac/forgekit@${latest}`], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0) {
    return { status: 'failed', latest, current, message: 'npm i -g failed' };
  }
  return { status: 'upgraded', latest, current };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runInstall(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.list) {
    for (const row of listInstallStatus()) {
      process.stdout.write(
        `${row.skill.padEnd(28)} ${row.agents.join(',').padEnd(40)} ${row.status.padEnd(12)} ${row.dest}\n`,
      );
    }
    return 0;
  }

  if (opts.update) {
    const pkg = maybeUpdateGlobalPackage({ skip: opts.noPkg });
    if (pkg.status === 'offline') {
      process.stderr.write(
        'Could not reach npm; updating skills with this package version.\n',
      );
    } else if (pkg.status === 'failed') {
      process.stderr.write(
        `Global package update failed; updating skills with ${pkg.current}.\n`,
      );
    } else if (pkg.status === 'upgraded') {
      const rest = argv.filter(
        (a) => a !== '--update' && a !== '--no-pkg' && a !== '--skip-package',
      );
      const bin = process.platform === 'win32' ? 'forgekit.cmd' : 'forgekit';
      const rerun = spawnSync(bin, ['update', '--no-pkg', ...rest], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      return rerun.status ?? 1;
    } else if (pkg.status === 'current') {
      process.stdout.write(`@izkac/forgekit ${pkg.current} is the latest on npm.\n`);
    }

    const updated = updateOutdatedSkills({
      skills: opts.skills.length ? opts.skills : undefined,
      agents: opts.agents.length || opts.allAgents || opts.all ? (
        opts.allAgents || opts.all ? [...AGENT_IDS] : opts.agents
      ) : undefined,
    });
    if (updated.results.length === 0) {
      process.stdout.write('All installed skills are up to date.\n');
      return 0;
    }
    for (const r of updated.results) {
      process.stdout.write(
        `${r.skill} × ${r.agent}: ${r.status} → ${r.dest}\n`,
      );
    }
    return 0;
  }

  let skills = opts.allSkills ? [...SKILL_IDS] : [...opts.skills];
  let agents =
    opts.allAgents || opts.all ? [...AGENT_IDS] : [...opts.agents];

  const resolved = await resolveSkillsAndAgents(skills, agents);
  if (typeof resolved === 'number') return resolved;
  skills = resolved.skills;
  agents = resolved.agents;
  // Reconcile (add new, drop deselected) only when the user chose the full set
  // via the pickers — flag-scoped runs (e.g. `forge install`) stay additive.
  const prune =
    opts.prune || (resolved.skillsPrompted && resolved.agentsPrompted);

  if (opts.uninstall) {
    const results = uninstallSkillsFromAgents(skills, agents);
    for (const r of results) {
      process.stdout.write(`${r.skill} × ${r.agent}: ${r.status} → ${r.dest}\n`);
    }
    return 0;
  }

  /** @type {boolean | null} */
  let useOpenSpec = opts.openspec;
  if (useOpenSpec === null && skills.includes('forge') && process.stdin.isTTY) {
    useOpenSpec = await promptOpenSpec();
  }
  if (useOpenSpec !== null) {
    saveUserPlanEngine(useOpenSpec ? 'openspec' : 'specs');
  }

  const adrOpts = await resolveAdrInstallOptions({
    adr: opts.adr,
    adrDir: opts.adrDir,
    skills,
  });

  skills = applyAdrSkills(skills, adrOpts.enabled === true);

  saveUserConfig({
    ...adrConfigPatch(adrOpts.enabled, adrOpts.dir),
    // Remember the environment set so `forge init` can pre-check it. Only when
    // deliberately chosen (picker or --all-agents) — narrow flag runs don't clobber it.
    ...(resolved.agentsPrompted || opts.allAgents || opts.all ? { agents } : {}),
  });

  const { results, removed } = prune
    ? reconcileInstall(skills, agents, { force: true, prune: true })
    : { results: installSkillsToAgents(skills, agents, { force: opts.force }), removed: [] };
  const sources = new Map();
  for (const r of results) {
    if (r.skillSource) sources.set(r.skill, r.skillSource);
  }
  for (const [skill, src] of sources) {
    process.stdout.write(`Skill ${skill}: ${src}\n`);
  }
  for (const r of removed) {
    process.stdout.write(`${r.skill} × ${r.agent}: removed (deselected) → ${r.dest}\n`);
  }
  for (const r of results) {
    process.stdout.write(
      `${r.skill} × ${r.agent}: ${r.status}${r.message ? ` — ${r.message}` : ''} → ${r.dest}\n`,
    );
  }

  if (useOpenSpec !== null) {
    process.stdout.write(
      `\nPlanning engine saved (~/.forgekit/config.json): ${
        useOpenSpec ? 'openspec' : 'specs (built-in)'
      } — per-project setup happens at \`forge init\`.\n`,
    );
  }
  if (adrOpts.enabled !== null) {
    process.stdout.write(
      `${useOpenSpec !== null ? '' : '\n'}ADR preference saved (~/.forgekit/config.json): ${
        adrOpts.enabled ? `enabled, dir=${adrOpts.dir}` : 'disabled'
      }\n`,
    );
  }

  const inRepo = isGitRepo(opts.cwd);
  const shouldScaffold =
    !opts.noAdrProject &&
    adrOpts.enabled === true &&
    (opts.adrProject || (inRepo && process.stdin.isTTY));

  if (shouldScaffold) {
    const scaffold = scaffoldAdr(opts.cwd, {
      dir: adrOpts.dir,
      force: opts.force,
      hooks: true,
    });
    process.stdout.write(
      `ADR project scaffold in ${opts.cwd}: ${scaffold.decisionsDoc}, ${scaffold.dir}/README.md, .forge/config.json\n`,
    );
    for (const f of scaffold.files) {
      process.stdout.write(`  ${f.status.padEnd(8)} ${f.file}\n`);
    }
  } else if (inRepo && !adrOpts.enabled && opts.adr === false) {
    disableProjectAdr(opts.cwd);
    process.stdout.write(
      `ADRs disabled in project (.forge/config.json) under ${opts.cwd}\n`,
    );
  } else if (adrOpts.enabled) {
    process.stdout.write(
      `Tip: in each repo run \`forge init --adr\` (or \`forgekit install --adr --adr-project\`) to scaffold ${adrOpts.dir}/ and decisions.md.\n`,
    );
  }

  const hints = [...new Set(skills.map((id) => SKILLS[id].nextHint))];
  process.stdout.write(`\n${hints.join('\n')}\n`);
  return 0;
}

const isDirect =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  runInstall()
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err?.name === 'ExitPromptError') process.exit(130);
      process.stderr.write(`${err.message || err}\n`);
      process.exit(1);
    });
}
