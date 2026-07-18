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
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
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
  --all             All of the above
  --openspec        Plan with OpenSpec (offer install + \`openspec init\` if missing)
  --no-openspec     Plan with the built-in specs engine (${DEFAULT_SPECS_DIR}/changes/)
  --adr             Enable ADRs (scaffold decisions.md + ADR dir + hooks)
  --no-adr          Disable ADRs for this project
  --adr-dir <path>  ADR directory (default: ${DEFAULT_ADR_DIR} or ~/.forgekit preference)
  --overlay         Also run \`forge overlay\` (OpenSpec vendor patches)
  --force, -f       Overwrite existing template files
  --cwd <path>      Project root (default: cwd)
  --help

Requires the Forge skill already installed (\`forge install\`) for agents
to load skill content. Init only adds project-local wiring.

Interactive (TTY): when --openspec/--no-openspec omitted and OpenSpec is not
already set up, offers to install + set it up (decline = built-in specs
engine). When --adr/--no-adr omitted, asks whether to use ADRs and for the
directory inside the repo.
`);
}

/**
 * @returns {string}
 */
export function resolveTemplatesRoot() {
  return resolveAsset('templates/project');
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {{ force?: boolean }} opts
 */
function copyFile(src, dest, opts) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && !opts.force) {
    return 'skipped';
  }
  fs.copyFileSync(src, dest);
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

async function promptAgents() {
  const rl = readline.createInterface({ input, output });
  try {
    process.stdout.write(`Init Forge project wiring for which environments?\n`);
    process.stdout.write(`  1) Cursor\n`);
    process.stdout.write(`  2) Claude Code\n`);
    process.stdout.write(`  3) Codex CLI\n`);
    process.stdout.write(`  4) All\n`);
    process.stdout.write(`Enter numbers separated by commas (e.g. 1,2) or 4 for all: `);
    const answer = (await rl.question('')).trim();
    if (!answer || answer === '4') return ['cursor', 'claude', 'codex'];
    const map = { 1: 'cursor', 2: 'claude', 3: 'codex' };
    const picked = [
      ...new Set(
        answer
          .split(/[,\s]+/)
          .map((s) => map[s.trim()])
          .filter(Boolean),
      ),
    ];
    if (picked.length === 0) throw new Error('No agents selected');
    return picked;
  } finally {
    rl.close();
  }
}

/**
 * Offer to install + set up OpenSpec in this project.
 * @returns {Promise<boolean>} true = user accepted OpenSpec setup
 */
async function promptOpenSpecSetup() {
  const rl = readline.createInterface({ input, output });
  try {
    const yn = (
      await rl.question(
        'OpenSpec is not set up in this project. Install and set it up now? [Y/n] (n = built-in specs engine) ',
      )
    )
      .trim()
      .toLowerCase();
    return !(yn === 'n' || yn === 'no');
  } finally {
    rl.close();
  }
}

/**
 * Resolve the planning engine for `forge init`, offering OpenSpec setup when needed.
 * @param {{ cwd: string, openspec: boolean | null }} opts
 * @returns {Promise<string>} 'openspec' | 'specs'
 */
async function resolveInitPlanEngine(opts) {
  const configured = hasOpenSpecConfig(opts.cwd);

  if (opts.openspec === false) return 'specs';

  if (opts.openspec === true) {
    if (!configured && process.stdin.isTTY) {
      const setup = setupOpenSpec(opts.cwd);
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

  const setup = setupOpenSpec(opts.cwd);
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
 * @returns {Promise<{ enabled: boolean, dir: string }>}
 */
async function promptAdrForInit(defaultDir = DEFAULT_ADR_DIR) {
  const rl = readline.createInterface({ input, output });
  let enabled = false;
  try {
    const yn = (
      await rl.question(
        'Use Architecture Decision Records (ADRs) in this project? [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
    enabled = yn === 'y' || yn === 'yes';
    if (!enabled) return { enabled: false, dir: defaultDir };
    const dirAnswer = (
      await rl.question(`ADR directory inside the repo [${defaultDir}]: `)
    ).trim();
    return { enabled: true, dir: normalizeAdrDir(dirAnswer || defaultDir) };
  } finally {
    rl.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  let selected = opts.all ? ['cursor', 'claude', 'codex'] : [...new Set(opts.agents)];
  if (selected.length === 0) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'No agents specified. Pass --cursor/--claude/--codex/--all, or run in a TTY.\n',
      );
      return 1;
    }
    selected = await promptAgents();
  }

  const planEngine = await resolveInitPlanEngine({
    cwd: opts.cwd,
    openspec: opts.openspec,
  });

  let adr = opts.adr;
  let adrDir = opts.adrDir;
  if (adr === null) {
    const user = loadUserConfig();
    const defaultDir = user.adr?.dir ?? DEFAULT_ADR_DIR;
    if (process.stdin.isTTY) {
      const picked = await promptAdrForInit(defaultDir);
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
      process.stderr.write(`${err.message || err}\n`);
      process.exit(1);
    });
}
