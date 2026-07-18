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
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
};

export const SKILL_IDS = Object.freeze(Object.keys(SKILLS));

/** @type {Record<string, { label: string, skillDir: (home: string, skillId: string) => string }>} */
export const AGENTS = {
  cursor: {
    label: 'Cursor',
    skillDir: (home, skillId) => path.join(home, '.cursor', 'skills', skillId),
  },
  claude: {
    label: 'Claude Code',
    skillDir: (home, skillId) => path.join(home, '.claude', 'skills', skillId),
  },
  codex: {
    label: 'Codex CLI',
    skillDir: (home, skillId) => path.join(home, '.codex', 'skills', skillId),
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
    else if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--cursor') opts.agents.push('cursor');
    else if (arg === '--claude' || arg === '--claude-code') opts.agents.push('claude');
    else if (arg === '--codex') opts.agents.push('codex');
    else if (arg === 'forge' || arg === 'thorough-code-review') opts.skills.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
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
  --cursor/--claude/--codex
                    Shorthand agent flags (same as --agents)
  --list            Show installed vs missing for all skill×agent pairs
  --force, -f       Overwrite existing skill directories
  --help

Interactive (TTY) when skills and/or agents are omitted.

Aliases:
  forge install […]   → forgekit install --skills forge […]
  review install […]  → forgekit install --skills thorough-code-review […]

Examples:
  forgekit install
  forgekit install --skills forge,thorough-code-review --agents cursor
  forgekit install --all-skills --all-agents --force
  forgekit list
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
  const fromEnv = process.env.FORGEKIT_ROOT
    ? path.join(process.env.FORGEKIT_ROOT, 'skills', skillId)
    : null;
  const fromRepo = path.resolve(__dirname, '..', '..', '..', 'skills', skillId);
  const candidates = [fromEnv, fromRepo].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'SKILL.md'))) return c;
  }
  throw new Error(
    `Skill source not found for "${skillId}". Expected skills/${skillId}/SKILL.md under forgekit root.\nTried: ${candidates.join(', ')}`,
  );
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
        status: fs.existsSync(dest) ? 'present' : 'missing',
      });
    }
  }
  return rows;
}

/**
 * @param {string} question
 * @param {Record<string, string>} map  number → id
 * @param {string[]} allIds
 * @returns {Promise<string[]>}
 */
async function promptMulti(question, map, allIds) {
  const rl = readline.createInterface({ input, output });
  try {
    process.stdout.write(`${question}\n`);
    const entries = Object.entries(map);
    for (const [num, id] of entries) {
      const label =
        SKILLS[id]?.label ?? AGENTS[id]?.label ?? id;
      process.stdout.write(`  ${num}) ${label}\n`);
    }
    const allNum = String(entries.length + 1);
    process.stdout.write(`  ${allNum}) All\n`);
    process.stdout.write(
      `Enter numbers separated by commas (e.g. 1,2) or ${allNum} for all: `,
    );
    const answer = (await rl.question('')).trim();
    if (!answer || answer === allNum) return [...allIds];
    const picked = [
      ...new Set(
        answer
          .split(/[,\s]+/)
          .map((s) => map[s.trim()])
          .filter(Boolean),
      ),
    ];
    if (picked.length === 0) throw new Error('Nothing selected');
    return picked;
  } finally {
    rl.close();
  }
}

async function promptSkills() {
  const map = Object.fromEntries(SKILL_IDS.map((id, i) => [String(i + 1), id]));
  return promptMulti('Install which skills?', map, SKILL_IDS);
}

async function promptAgents() {
  const map = Object.fromEntries(AGENT_IDS.map((id, i) => [String(i + 1), id]));
  return promptMulti('Install for which environments?', map, AGENT_IDS);
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
        `${row.skill.padEnd(24)} ${row.agent.padEnd(8)} ${row.status.padEnd(8)} ${row.dest}\n`,
      );
    }
    return 0;
  }

  let skills = opts.allSkills ? [...SKILL_IDS] : [...opts.skills];
  let agents =
    opts.allAgents || opts.all ? [...AGENT_IDS] : [...opts.agents];

  if (skills.length === 0) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'No skills specified. Pass --skills / --all-skills, or run in a TTY.\n',
      );
      return 1;
    }
    skills = await promptSkills();
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
    agents = await promptAgents();
  }

  for (const id of agents) {
    if (!AGENTS[id]) {
      process.stderr.write(`Unknown agent: ${id}. Known: ${AGENT_IDS.join(', ')}\n`);
      return 1;
    }
  }

  const results = installSkillsToAgents(skills, agents, { force: opts.force });
  const sources = new Map();
  for (const r of results) {
    if (r.skillSource) sources.set(r.skill, r.skillSource);
  }
  for (const [skill, src] of sources) {
    process.stdout.write(`Skill ${skill}: ${src}\n`);
  }
  for (const r of results) {
    process.stdout.write(
      `${r.skill} × ${r.agent}: ${r.status}${r.message ? ` — ${r.message}` : ''} → ${r.dest}\n`,
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
      process.stderr.write(`${err.message || err}\n`);
      process.exit(1);
    });
}
