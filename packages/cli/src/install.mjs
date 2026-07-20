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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkbox, input, select } from '@inquirer/prompts';
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
import { hashDirectory, packageVersion, resolveAsset } from './paths.mjs';

export const FORGEKIT_STAMP = '.forgekit.json';

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
};

export const SKILL_IDS = Object.freeze(Object.keys(SKILLS));

/**
 * Supported environments and their user-level skills directory.
 * Paths follow each tool's global Agent-Skills (SKILL.md) convention.
 * @type {Record<string, { label: string, skillDir: (home: string, skillId: string) => string }>}
 */
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    skillDir: (home, skillId) => path.join(home, '.claude', 'skills', skillId),
  },
  cursor: {
    label: 'Cursor',
    skillDir: (home, skillId) => path.join(home, '.cursor', 'skills', skillId),
  },
  codex: {
    label: 'Codex CLI',
    skillDir: (home, skillId) => path.join(home, '.codex', 'skills', skillId),
  },
  copilot: {
    label: 'GitHub Copilot',
    skillDir: (home, skillId) => path.join(home, '.copilot', 'skills', skillId),
  },
  gemini: {
    label: 'Gemini CLI',
    skillDir: (home, skillId) => path.join(home, '.gemini', 'skills', skillId),
  },
  windsurf: {
    label: 'Windsurf',
    skillDir: (home, skillId) =>
      path.join(home, '.codeium', 'windsurf', 'skills', skillId),
  },
  opencode: {
    label: 'opencode',
    skillDir: (home, skillId) =>
      path.join(home, '.config', 'opencode', 'skills', skillId),
  },
};

export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));

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
    else if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--prune') opts.prune = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
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

Install one or more skills into user-level agent skill directories.

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
  --list            Show installed vs missing (and outdated) for all skill×agent pairs
  --update          Reinstall outdated installed skills (same agents as present)
  --uninstall       Remove installed skill dirs for selected skills×agents
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
 */
export function writeInstallStamp(dest, skillId, skillSource) {
  const stamp = {
    skill: skillId,
    version: packageVersion(),
    contentHash: hashDirectory(skillSource),
    installedAt: new Date().toISOString(),
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
 * @returns {{ skill?: string, version?: string, contentHash?: string } | null}
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
  fs.rmSync(dir, { recursive: true, force: true });
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
    for (const agentId of agentIds) {
      const agent = AGENTS[agentId];
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      const dest = agent.skillDir(home, skillId);
      const exists = fs.existsSync(dest);
      if (exists && !opts.force) {
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
      if (exists) removeDirRecursive(dest);
      copyDirRecursive(skillSource, dest);
      writeInstallStamp(dest, skillId, skillSource);
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
  for (const skillId of skillIds) {
    for (const agentId of agentIds) {
      const agent = AGENTS[agentId];
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      const dest = agent.skillDir(home, skillId);
      if (!fs.existsSync(dest)) {
        results.push({ skill: skillId, agent: agentId, dest, status: 'missing' });
        continue;
      }
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
  for (const skill of SKILL_IDS) {
    for (const agent of AGENT_IDS) {
      const dest = AGENTS[agent].skillDir(home, skill);
      if (fs.existsSync(dest) && readInstallStamp(dest)) {
        pairs.push({ skill, agent, dest });
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
    for (const p of installedManagedPairs(home)) {
      if (!desired.has(`${p.skill}::${p.agent}`)) {
        removeDirRecursive(p.dest);
        removed.push({ ...p, status: 'removed' });
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
  /** @type {string[]} */
  const skills = [];
  /** @type {string[]} */
  const agents = [];
  /** @type {Set<string>} */
  const skillSet = new Set();
  /** @type {Set<string>} */
  const agentSet = new Set();

  for (const skillId of SKILL_IDS) {
    if (skillFilter && !skillFilter.has(skillId)) continue;
    for (const agentId of AGENT_IDS) {
      if (agentFilter && !agentFilter.has(agentId)) continue;
      const dest = AGENTS[agentId].skillDir(home, skillId);
      const status = skillInstallStatus(skillId, dest);
      if (status === 'outdated' || status === 'unversioned') {
        skillSet.add(skillId);
        agentSet.add(agentId);
      }
    }
  }
  skills.push(...skillSet);
  agents.push(...agentSet);
  if (skills.length === 0) return { results: [], skills, agents };
  const results = installSkillsToAgents(skills, agents, { home, force: true });
  return { results, skills, agents };
}

/**
 * @param {{ home?: string }} [opts]
 */
export function listInstallStatus(opts = {}) {
  const home = opts.home ?? os.homedir();
  /** @type {{ skill: string, agent: string, dest: string, status: string }[]} */
  const rows = [];
  for (const skillId of SKILL_IDS) {
    for (const agentId of AGENT_IDS) {
      const dest = AGENTS[agentId].skillDir(home, skillId);
      rows.push({
        skill: skillId,
        agent: agentId,
        dest,
        status: skillInstallStatus(skillId, dest),
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
 * @param {string} [defaultDir]
 * @returns {Promise<string>}
 */
export async function promptAdrDir(defaultDir = DEFAULT_ADR_DIR) {
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
 * Resolve ADR enablement + directory. ADRs turn on when an ADR skill is picked
 * (or --adr); the path is only asked when enabled — never a standalone prompt.
 * @param {{ adr: boolean | null, adrDir: string | null, skills: string[] }} opts
 * @returns {Promise<{ enabled: boolean, dir: string }>}
 */
export async function resolveAdrInstallOptions(opts) {
  const enabled = inferAdrFromSkills(opts.skills, opts.adr) === true;
  if (!enabled) {
    return {
      enabled: false,
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
    agents = await promptAgents([...new Set(installed.map((p) => p.agent))]);
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
        `${row.skill.padEnd(28)} ${row.agent.padEnd(8)} ${row.status.padEnd(12)} ${row.dest}\n`,
      );
    }
    return 0;
  }

  if (opts.update) {
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

  skills = applyAdrSkills(skills, adrOpts.enabled);

  saveUserConfig({
    adr: { enabled: adrOpts.enabled, dir: adrOpts.dir },
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
  process.stdout.write(
    `${useOpenSpec !== null ? '' : '\n'}ADR preference saved (~/.forgekit/config.json): ${
      adrOpts.enabled ? `enabled, dir=${adrOpts.dir}` : 'disabled'
    }\n`,
  );

  const inRepo = isGitRepo(opts.cwd);
  const shouldScaffold =
    !opts.noAdrProject &&
    adrOpts.enabled &&
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
