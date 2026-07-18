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
  --overlay         Also run \`forge overlay\` (OpenSpec vendor patches)
  --force, -f       Overwrite existing template files
  --cwd <path>      Project root (default: cwd)
  --help

Requires the Forge skill already installed (\`forge install\`) for agents
to load skill content. Init only adds project-local wiring.
`);
}

/**
 * @returns {string}
 */
export function resolveTemplatesRoot() {
  const fromEnv = process.env.FORGEKIT_ROOT
    ? path.join(process.env.FORGEKIT_ROOT, 'templates', 'project')
    : null;
  const fromRepo = path.resolve(__dirname, '..', '..', '..', 'templates', 'project');
  for (const c of [fromEnv, fromRepo].filter(Boolean)) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('templates/project not found under forgekit root');
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
  const body = `# Forge session scratch — keep layout docs if you add a README
*
!.gitignore
!README.md
`;
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, body, 'utf8');
    return 'written';
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
      'Merge into .cursor/hooks.json. Requires a shell runner that can execute forge-session-start.sh (or call `forge reminder --format cursor`).',
    version: 1,
    hooks: {
      sessionStart: [
        {
          command: '.cursor/hooks/forge-session-start.sh',
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
 * @param {{ cwd: string, force?: boolean, overlay?: boolean, templatesRoot?: string }} opts
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

  const report = initProject(selected, opts);
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
