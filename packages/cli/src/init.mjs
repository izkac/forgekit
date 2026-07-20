#!/usr/bin/env node
/**
 * Wire Forge into a project: commands, thin rules, hooks, .forge gitignore.
 *
 * Usage:
 *   forge init                     # interactive agent picker
 *   forge init --cursor --claude
 *   forge init --all
 *   forge init --overlay           # also apply OpenSpec vendor overlays
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkbox, confirm, input } from '@inquirer/prompts';
import {
  DEFAULT_ADR_DIR,
  disableProjectAdr,
  loadUserConfig,
  normalizeAdrDir,
  scaffoldAdr,
} from './adr.mjs';
import {
  DEFAULT_SPECS_DIR,
  hasOpenSpecConfig,
  loadUserPlanEngine,
  scaffoldSpecs,
  setupOpenSpec,
  writeProjectPlanConfig,
} from './plan-engine.mjs';
import { resolveAsset } from './paths.mjs';
import { AGENT_IDS, AGENTS, installedManagedPairs } from './install.mjs';

// Environments with project-local command/rule/hook templates. Others are
// driven by the globally-installed skill alone (no per-project wiring).
const WIRED_AGENTS = Object.freeze(['cursor', 'claude', 'codex']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    all: false,
    help: false,
    force: false,
    overlay: false,
    agents: /** @type {string[]} */ ([]),
    cwd: process.cwd(),
    /** @type {boolean | null} */
    adr: /** @type {boolean | null} */ (null),
    adrDir: /** @type {string | null} */ (null),
    /** @type {boolean | null} true=openspec, false=specs, null=detect/prompt */
    openspec: /** @type {boolean | null} */ (null),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--overlay') opts.overlay = true;
    else if (arg === '--cwd') opts.cwd = argv[++i];
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
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: forge init [options]

Wire Forge commands, thin rules, and hooks into the current project.

Options:
  --cursor          Cursor (.cursor/commands, rules, hooks)
  --claude          Claude Code (.claude/commands, rules, hooks)
  --codex           Codex CLI (.codex/rules)
  --copilot/--gemini/--windsurf/--opencode
                    Offered in the picker for parity with \`forgekit install\`;
                    driven by the global skill (no per-project wiring yet)
  --all             Every offered environment
  --openspec        Plan with OpenSpec (offer install + \`openspec init\` if missing)
  --no-openspec     Plan with the built-in specs engine (${DEFAULT_SPECS_DIR}/changes/)
  --adr             Enable ADRs (scaffold decisions.md + ADR dir + hooks)
  --no-adr          Disable ADRs for this project
  --adr-dir <path>  ADR directory (default: ${DEFAULT_ADR_DIR} or ~/.forgekit preference)
  --overlay         Also run \`forge overlay\` (OpenSpec vendor patches)
  --force, -f       Force re-scaffold of ADR/specs docs (managed command,
                    rule, and hook files always refresh to the latest template)
  --cwd <path>      Project root (default: cwd)
  --help

Requires the Forge skill already installed (\`forge install\`) for agents
to load skill content. Init only adds project-local wiring.

Interactive (TTY): the environment picker matches \`forgekit install\` and is
pre-checked with what you installed there (saved in ~/.forgekit/config.json),
so you don't pick twice. When --openspec/--no-openspec omitted and OpenSpec is
not already set up, offers to install + set it up (decline = built-in specs
engine). When --adr/--no-adr omitted, asks whether to use ADRs (default Yes)
and for the directory inside the repo.
`);
}

/**
 * @returns {string}
 */
export function resolveTemplatesRoot() {
  return resolveAsset('templates/project');
}

/**
 * Copy a forgekit-managed template file. These are regenerated pointers
 * (forge-* commands/rules/hooks) with no user-owned content, so re-running
 * `forge init` refreshes them in place — that's how template fixes propagate.
 * @param {string} src
 * @param {string} dest
 * @param {{ force?: boolean }} _opts
 */
function copyFile(src, dest, _opts) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const next = fs.readFileSync(src);
  if (fs.existsSync(dest)) {
    if (fs.readFileSync(dest).equals(next)) return 'unchanged';
    fs.writeFileSync(dest, next);
    return 'updated';
  }
  fs.writeFileSync(dest, next);
  return 'written';
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {{ force?: boolean }} opts
 */
function copyDirFiles(srcDir, destDir, opts) {
  /** @type {{ file: string, status: string }[]} */
  const out = [];
  if (!fs.existsSync(srcDir)) return out;
  for (const name of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    if (!fs.statSync(from).isFile()) continue;
    const to = path.join(destDir, name);
    out.push({ file: path.relative(opts.cwd ?? destDir, to) || to, status: copyFile(from, to, opts) });
  }
  return out;
}

/**
 * Ensure .forge/.gitignore exists.
 * @param {string} cwd
 */
export function ensureForgeGitignore(cwd) {
  const forgeDir = path.join(cwd, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const gi = path.join(forgeDir, '.gitignore');
  const body = `# Forge session scratch — keep layout docs + committed project config
*
!.gitignore
!README.md
!config.json
`;
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, body, 'utf8');
    return 'written';
  }
  // Upgrade older scaffolds that omit config.json
  const existing = fs.readFileSync(gi, 'utf8');
  if (!existing.includes('!config.json')) {
    const next = existing.trimEnd().endsWith('!README.md')
      ? `${existing.trimEnd()}\n!config.json\n`
      : `${existing.trimEnd()}\n!config.json\n`;
    fs.writeFileSync(gi, next, 'utf8');
    return 'updated';
  }
  return 'exists';
}

/**
 * Write a short project README under .forge/ if missing.
 * @param {string} cwd
 */
export function ensureForgeReadme(cwd) {
  const readme = path.join(cwd, '.forge', 'README.md');
  if (fs.existsSync(readme)) return 'exists';
  fs.writeFileSync(
    readme,
    `# \`.forge/\` — Forge session scratch

Per-checkout, **gitignored** workspace for Forge session orchestration.
Canonical specs live in \`openspec/\`; this directory holds session-local artefacts only.

\`\`\`bash
forge new <slug>
forge status
forge prefs
forge models
forge cleanup
\`\`\`

See the Forge skill and forgekit docs for the full workflow.
`,
    'utf8',
  );
  return 'written';
}

/**
 * Append hook registrations into Claude settings.json if present / create stub note.
 * @param {string} cwd
 * @param {{ force?: boolean }} opts
 */
export function ensureClaudeHookHints(cwd, opts) {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const notePath = path.join(cwd, '.claude', 'forge-hooks.snippet.json');
  const snippet = {
    _comment:
      'Merge these hooks into .claude/settings.json (SessionStart + UserPromptSubmit). Paths assume forge CLI is on PATH.',
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-session-start.mjs"',
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-triage-hook.mjs"',
            },
            {
              type: 'command',
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-prompt-hook.mjs"',
            },
          ],
        },
      ],
    },
  };
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  if (!fs.existsSync(notePath) || opts.force) {
    fs.writeFileSync(notePath, `${JSON.stringify(snippet, null, 2)}\n`, 'utf8');
  }
  return {
    settingsExists: fs.existsSync(settingsPath),
    snippet: notePath,
  };
}

/**
 * Write Cursor hooks.json snippet.
 * @param {string} cwd
 * @param {{ force?: boolean }} opts
 */
export function ensureCursorHookHints(cwd, opts) {
  const notePath = path.join(cwd, '.cursor', 'forge-hooks.snippet.json');
  const snippet = {
    _comment:
      'Merge into .cursor/hooks.json. Requires Node on PATH (forge-session-start.mjs).',
    version: 1,
    hooks: {
      sessionStart: [
        {
          command: 'node .cursor/hooks/forge-session-start.mjs',
        },
      ],
    },
  };
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  if (!fs.existsSync(notePath) || opts.force) {
    fs.writeFileSync(notePath, `${JSON.stringify(snippet, null, 2)}\n`, 'utf8');
  }
  return notePath;
}

/**
 * @param {string[]} selected
 * @param {{ cwd: string, force?: boolean, overlay?: boolean, templatesRoot?: string, adr?: boolean | null, adrDir?: string | null, home?: string, planEngine?: string | null }} opts
 */
export function initProject(selected, opts) {
  const templates = opts.templatesRoot ?? resolveTemplatesRoot();
  const cwd = opts.cwd;
  /** @type {Record<string, unknown>} */
  const report = {
    cwd,
    gitignore: ensureForgeGitignore(cwd),
    readme: ensureForgeReadme(cwd),
    files: /** @type {{ file: string, status: string }[]} */ ([]),
  };

  const copyOpts = { force: opts.force, cwd };

  if (selected.includes('cursor')) {
    report.files.push(
      ...copyDirFiles(
        path.join(templates, 'cursor', 'commands'),
        path.join(cwd, '.cursor', 'commands'),
        copyOpts,
      ),
      ...copyDirFiles(
        path.join(templates, 'cursor', 'rules'),
        path.join(cwd, '.cursor', 'rules'),
        copyOpts,
      ),
      ...copyDirFiles(
        path.join(templates, 'cursor', 'hooks'),
        path.join(cwd, '.cursor', 'hooks'),
        copyOpts,
      ),
    );
    report.cursorHookSnippet = ensureCursorHookHints(cwd, copyOpts);
  }

  if (selected.includes('claude')) {
    report.files.push(
      ...copyDirFiles(
        path.join(templates, 'claude', 'commands'),
        path.join(cwd, '.claude', 'commands'),
        copyOpts,
      ),
      ...copyDirFiles(
        path.join(templates, 'claude', 'rules'),
        path.join(cwd, '.claude', 'rules'),
        copyOpts,
      ),
      ...copyDirFiles(
        path.join(templates, 'claude', 'hooks'),
        path.join(cwd, '.claude', 'hooks'),
        copyOpts,
      ),
    );
    report.claudeHooks = ensureClaudeHookHints(cwd, copyOpts);
  }

  if (selected.includes('codex')) {
    report.files.push(
      ...copyDirFiles(
        path.join(templates, 'codex', 'rules'),
        path.join(cwd, '.codex', 'rules'),
        copyOpts,
      ),
    );
  }

  // Selected environments without project-wiring templates: the globally
  // installed skill is their interface — nothing to scaffold per project.
  report.skillOnly = selected.filter((id) => !WIRED_AGENTS.includes(id));

  if (opts.planEngine === 'specs') {
    const scaffold = scaffoldSpecs(cwd, { force: opts.force });
    const config = writeProjectPlanConfig(cwd, {
      engine: 'specs',
      dir: scaffold.dir,
    });
    report.plan = { engine: 'specs', dir: scaffold.dir, files: scaffold.files, config };
  } else if (opts.planEngine === 'openspec') {
    const config = writeProjectPlanConfig(cwd, { engine: 'openspec' });
    report.plan = {
      engine: 'openspec',
      configured: hasOpenSpecConfig(cwd),
      config,
    };
  }

  if (opts.adr === true) {
    const user = loadUserConfig(opts.home);
    const dir = normalizeAdrDir(
      opts.adrDir ?? user.adr?.dir ?? DEFAULT_ADR_DIR,
    );
    report.adr = scaffoldAdr(cwd, {
      dir,
      force: opts.force,
      hooks: true,
    });
  } else if (opts.adr === false) {
    report.adr = { config: disableProjectAdr(cwd), enabled: false };
  }

  if (opts.overlay) {
    const overlayScript = path.join(__dirname, 'vendor-openspec-overlays.mjs');
    const r = spawnSync(process.execPath, [overlayScript], {
      cwd,
      encoding: 'utf8',
    });
    report.overlay = {
      status: r.status,
      stdout: r.stdout?.trim() || '',
      stderr: r.stderr?.trim() || '',
    };
  }

  return report;
}

/**
 * Environments this project already has Forge wiring for (marker dir present).
 * @param {string} cwd
 * @returns {Set<string>}
 */
function wiredAgents(cwd) {
  const markers = {
    cursor: path.join(cwd, '.cursor', 'commands'),
    claude: path.join(cwd, '.claude', 'commands'),
    codex: path.join(cwd, '.codex', 'rules'),
  };
  return new Set(
    Object.entries(markers)
      .filter(([, dir]) => fs.existsSync(dir))
      .map(([id]) => id),
  );
}

/**
 * Environments to pre-check: those chosen during `forgekit install`
 * (saved in ~/.forgekit/config.json), plus what is already installed or wired.
 * @param {string} cwd
 * @param {string} [home]
 * @returns {Set<string>}
 */
export function rememberedAgents(cwd, home) {
  const user = loadUserConfig(home);
  return new Set([
    ...(Array.isArray(user.agents) ? user.agents : []),
    ...installedManagedPairs(home).map((p) => p.agent),
    ...wiredAgents(cwd),
  ]);
}

/** @param {string} cwd */
async function promptAgents(cwd) {
  const remembered = rememberedAgents(cwd);
  return checkbox({
    message: 'Init Forge project wiring for which environments?',
    choices: AGENT_IDS.map((id) => ({
      value: id,
      name: AGENTS[id].label,
      checked: remembered.has(id),
    })),
    required: true,
  });
}

/**
 * Offer to install + set up OpenSpec in this project.
 * @returns {Promise<boolean>} true = user accepted OpenSpec setup
 */
async function promptOpenSpecSetup() {
  return confirm({
    message:
      'OpenSpec is not set up in this project. Install and set it up now? (No = built-in specs engine)',
    default: true,
  });
}

/**
 * Resolve the planning engine for `forge init`, offering OpenSpec setup when needed.
 * @param {{ cwd: string, openspec: boolean | null, agents?: string[] }} opts
 * @returns {Promise<string>} 'openspec' | 'specs'
 */
async function resolveInitPlanEngine(opts) {
  const configured = hasOpenSpecConfig(opts.cwd);
  const tools = opts.agents;

  if (opts.openspec === false) return 'specs';

  if (opts.openspec === true) {
    if (!configured && process.stdin.isTTY) {
      const setup = setupOpenSpec(opts.cwd, { tools });
      for (const s of setup.steps) {
        process.stdout.write(`  [${s.ok ? 'ok' : 'FAIL'}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}\n`);
      }
      if (!setup.ok) {
        process.stderr.write(
          'OpenSpec setup failed — engine recorded as openspec; re-run `forge doctor --install` or `openspec init` manually.\n',
        );
      }
    }
    return 'openspec';
  }

  if (configured) return 'openspec';

  const userDefault = loadUserPlanEngine();
  if (userDefault === 'specs') return 'specs';

  // Default (or user prefers openspec) but project has no OpenSpec yet
  if (!process.stdin.isTTY) {
    return userDefault === 'openspec' ? 'openspec' : 'specs';
  }

  const accepted = await promptOpenSpecSetup();
  if (!accepted) return 'specs';

  const setup = setupOpenSpec(opts.cwd, { tools });
  for (const s of setup.steps) {
    process.stdout.write(`  [${s.ok ? 'ok' : 'FAIL'}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}\n`);
  }
  if (!setup.ok) {
    process.stderr.write(
      'OpenSpec setup failed — falling back to the built-in specs engine. You can switch later with `forge init --openspec --force`.\n',
    );
    return 'specs';
  }
  return 'openspec';
}

/**
 * @param {string} [defaultDir]
 * @param {boolean} [defaultEnabled]
 * @returns {Promise<{ enabled: boolean, dir: string }>}
 */
async function promptAdrForInit(defaultDir = DEFAULT_ADR_DIR, defaultEnabled = true) {
  const enabled = await confirm({
    message: 'Use Architecture Decision Records (ADRs) in this project?',
    default: defaultEnabled,
  });
  if (!enabled) return { enabled: false, dir: defaultDir };
  const dir = await input({
    message: 'ADR directory inside the repo',
    default: defaultDir,
  });
  return { enabled: true, dir: normalizeAdrDir(dir.trim() || defaultDir) };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  let selected = opts.all ? [...AGENT_IDS] : [...new Set(opts.agents)];
  if (selected.length === 0) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'No agents specified. Pass --cursor/--claude/--codex/--copilot/--gemini/--windsurf/--opencode/--all, or run in a TTY.\n',
      );
      return 1;
    }
    selected = await promptAgents(opts.cwd);
  }

  for (const id of selected) {
    if (!AGENTS[id]) {
      process.stderr.write(`Unknown environment: ${id}. Known: ${AGENT_IDS.join(', ')}\n`);
      return 1;
    }
  }

  const planEngine = await resolveInitPlanEngine({
    cwd: opts.cwd,
    openspec: opts.openspec,
    agents: selected,
  });

  let adr = opts.adr;
  let adrDir = opts.adrDir;
  if (adr === null) {
    const user = loadUserConfig();
    const defaultDir = user.adr?.dir ?? DEFAULT_ADR_DIR;
    if (process.stdin.isTTY) {
      // Default Yes, unless the user globally opted out of ADRs.
      const picked = await promptAdrForInit(defaultDir, user.adr?.enabled !== false);
      adr = picked.enabled;
      adrDir = picked.dir;
    } else if (user.adr?.enabled === true) {
      adr = true;
      adrDir = user.adr.dir ?? DEFAULT_ADR_DIR;
    } else {
      adr = false;
    }
  }

  const report = initProject(selected, { ...opts, adr, adrDir, planEngine });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (Array.isArray(report.skillOnly) && report.skillOnly.length) {
    const labels = report.skillOnly.map((id) => AGENTS[id].label).join(', ');
    process.stdout.write(
      `\nNo project wiring for: ${labels} — they use the globally installed Forge skill directly (run \`forgekit install\` if not yet installed).\n`,
    );
  }
  process.stdout.write(
    `\nMerge hook snippets into settings if needed, ensure \`forge\` is on PATH, then open the project in your agent.\n`,
  );
  return 0;
}

const isDirect =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err?.name === 'ExitPromptError') process.exit(130);
      process.stderr.write(`${err.message || err}\n`);
      process.exit(1);
    });
}
