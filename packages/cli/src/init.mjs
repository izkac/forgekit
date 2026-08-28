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
import {
  DEFAULT_ADR_DIR,
  disableProjectAdr,
  loadUserConfig,
  normalizeAdrDir,
  scaffoldAdr,
} from './adr.mjs';
import {
  DEFAULT_SPECS_DIR,
  PLAN_ENGINES,
  hasOpenSpecConfig,
  loadUserPlanEngine,
  scaffoldSpecs,
  setupOpenSpec,
  writeProjectPlanConfig,
} from './plan-engine.mjs';
import { loadProjectConfig } from './config.mjs';
import { resolveAsset } from './paths.mjs';
import {
  AGENT_IDS,
  AGENTS,
  installedManagedPairs,
  promptOpenSpec,
  readInstallStamp,
} from './install.mjs';
import {
  collectHookCommands,
  commandBasename,
  isCommandReferenced,
  RETIRED_CLAUDE_HOOK_BASENAMES,
  stripRetiredHookCommands,
} from './hooks.mjs';

// Environments with project-local command/rule/hook templates. Others are
// driven by the globally-installed skill alone (no per-project wiring).
const WIRED_AGENTS = Object.freeze(['cursor', 'claude', 'codex']);

/**
 * Environments `forge init` offers (picker, `--all`, known-list).
 * Same set as install now that the `agents` target is gone. Leftover
 * `'agents'` in user config is still dropped by `rememberedAgents`.
 * @returns {string[]}
 */
export function initAgentIds() {
  return [...AGENT_IDS];
}

/**
 * Lazy: `@inquirer/prompts` is a real amount of code that most importers of
 * this module never need — e.g. `forge doctor --install` reaches
 * `ensureClaudeHookHints` through here but never prompts. Load it only
 * where a prompt actually runs.
 */
function loadPrompts() {
  return import('@inquirer/prompts');
}

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
    /** @type {string | null} specs-engine root (plan.dir) */
    planDir: /** @type {string | null} */ (null),
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
    else if (arg === '--agents') {
      throw new Error(
        '--agents is no longer a project init target; skills are user-global now. Run `forgekit install` (pick Cursor, Codex, …).',
      );
    }
    else if (arg === '--adr') opts.adr = true;
    else if (arg === '--no-adr') opts.adr = false;
    else if (arg === '--adr-dir') opts.adrDir = argv[++i];
    else if (arg === '--openspec') opts.openspec = true;
    else if (arg === '--no-openspec') opts.openspec = false;
    else if (arg === '--plan-dir') opts.planDir = argv[++i];
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
  --plan-dir <path> Specs-engine root (plan.dir). Default: ${DEFAULT_SPECS_DIR}.
                    Use \`openspec\` to reuse an existing OpenSpec tree without moving files.
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

Interactive (TTY): the environment picker is pre-checked with what you
installed via \`forgekit install\` (saved in ~/.forgekit/config.json).
Skills stay user-global; init does not copy them.
When --openspec/--no-openspec omitted: uses the user
default from install when set; otherwise asks Planning engine?. Choosing
OpenSpec always writes plan.engine=openspec (setup failure or declining
immediate \`openspec init\` does not fall back to the built-in specs engine).
When --adr/--no-adr omitted, asks whether to use ADRs (default Yes) and for
the directory inside the repo.
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
 * @param {unknown} value
 */
function deepCloneJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Clone `group` with its `hooks[]` narrowed down to the entries whose
 * command is not already referenced (per `existingCommands`), keeping the
 * group's other keys (`matcher`, …) intact. Returns `null` when every entry
 * is already wired — the group is fully present, skip it, no duplicate to
 * add. A group shaped unlike `{ hooks: [...] }` is cloned as-is: we can't
 * tell what it wires, so we don't silently drop it.
 * @param {unknown} group
 * @param {Set<string>} existingCommands
 */
function filterMissingGroupCommands(group, existingCommands) {
  if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
    return deepCloneJson(group);
  }
  const missingLeaves = group.hooks.filter((leaf) => {
    const basename = commandBasename(/** @type {{ command?: unknown }} */ (leaf)?.command);
    return !basename || !isCommandReferenced(basename, existingCommands);
  });
  if (missingLeaves.length === 0) return null;
  const clone = deepCloneJson(group);
  clone.hooks = deepCloneJson(missingLeaves);
  return clone;
}

/**
 * Structurally merge a generated hooks snippet into a Claude `settings.json`
 * document. For each event key in the snippet (`SessionStart`,
 * `UserPromptSubmit`, `PreToolUse`, …), individual hook entries whose
 * command is not already referenced *anywhere* in the surface's wiring —
 * across every event in `settings`, and in `localSettings` too (Claude
 * reads `settings.local.json` the same as `settings.json`, and so does
 * `checkHookWiring` in doctor.mjs) — are appended, keeping their matcher
 * group; a group left with nothing missing is skipped entirely, so no
 * duplicates appear. `localSettings` is read-only input: it informs
 * "already wired" but is never itself written to or returned.
 *
 * Existing groups in `settings` are never reordered. Forge-owned retired
 * hook basenames (`RETIRED_CLAUDE_HOOK_BASENAMES`) are stripped after merge
 * by `writeMergedClaudeSettings` — that is the only removal. Unrelated
 * user entries and unrelated top-level keys (`permissions`, `env`, …) pass
 * through untouched. Pure merge: no filesystem access, and neither
 * `settings`, `snippet`, nor `localSettings` is mutated.
 *
 * Refuses (rather than silently discarding) a `settings.hooks` that is
 * present but not a plain object — `ok: false`, `settings` returned
 * unchanged. An event in `settings.hooks` whose value is present but not an
 * array is left untouched and named in `warnings` rather than silently
 * counted as merged.
 *
 * @param {{
 *   settings: Record<string, unknown> | null | undefined,
 *   snippet: { hooks?: Record<string, unknown[]> },
 *   localSettings?: Record<string, unknown> | null,
 * }} args
 * @returns {{ ok: boolean, settings: Record<string, unknown>, warnings: string[], error?: string }}
 */
export function mergeHooksIntoSettings({ settings, snippet, localSettings }) {
  const rawSettings = settings && typeof settings === 'object' ? settings : {};
  const hooksValue = rawSettings.hooks;
  const hooksValueUsable =
    hooksValue === undefined ||
    (typeof hooksValue === 'object' && hooksValue !== null && !Array.isArray(hooksValue));
  if (!hooksValueUsable) {
    return {
      ok: false,
      settings: deepCloneJson(rawSettings),
      warnings: [],
      error: `.hooks must be an object, found ${Array.isArray(hooksValue) ? 'an array' : typeof hooksValue}`,
    };
  }

  const merged = deepCloneJson(rawSettings);
  if (!merged.hooks) merged.hooks = {};

  // Doctor's notion of "wired" doesn't care which event a command lives
  // under, and it also reads settings.local.json — mirror both scopes here
  // so the merge never re-adds what doctor already calls wired.
  const existingCommands = new Set();
  collectHookCommands(merged.hooks, existingCommands);
  const localHooks = localSettings?.hooks;
  if (localHooks && typeof localHooks === 'object' && !Array.isArray(localHooks)) {
    collectHookCommands(localHooks, existingCommands);
  }

  const snippetHooks =
    snippet?.hooks && typeof snippet.hooks === 'object' ? snippet.hooks : {};
  const warnings = [];

  for (const [eventKey, groups] of Object.entries(snippetHooks)) {
    if (!Array.isArray(groups)) continue;

    const existingValue = merged.hooks[eventKey];
    if (existingValue !== undefined && !Array.isArray(existingValue)) {
      warnings.push(
        `hooks.${eventKey} is not an array — left untouched; the snippet's ${eventKey} hooks were not merged`,
      );
      continue;
    }
    const existingGroups = Array.isArray(existingValue) ? existingValue : [];

    const toAppend = [];
    for (const group of groups) {
      const missingGroup = filterMissingGroupCommands(group, existingCommands);
      if (!missingGroup) continue;
      toAppend.push(missingGroup);
      collectHookCommands(missingGroup, existingCommands);
    }

    merged.hooks[eventKey] = [...existingGroups, ...toAppend];
  }

  return { ok: true, settings: merged, warnings };
}

/**
 * Merge the hooks snippet into `.claude/settings.json` on disk. Creates the
 * file when missing. Reads `.claude/settings.local.json` (if present) only
 * to learn what's already wired — it is never written to. When
 * `settings.json` exists but cannot be parsed as JSON, or its `hooks` value
 * is present but not an object, the merge is refused and the file is left
 * byte-identical; the caller reports the problem, `forge init` does not
 * fail.
 * @param {string} settingsPath
 * @param {{ hooks?: Record<string, unknown[]> }} snippet
 */
function writeMergedClaudeSettings(settingsPath, snippet) {
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      existing = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      return {
        merged: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const localPath = path.join(path.dirname(settingsPath), 'settings.local.json');
  /** @type {Record<string, unknown> | undefined} */
  let localSettings;
  const warnings = [];
  if (fs.existsSync(localPath)) {
    try {
      const rawLocal = fs.readFileSync(localPath, 'utf8');
      localSettings = rawLocal.trim() ? JSON.parse(rawLocal) : {};
    } catch (err) {
      warnings.push(
        `${localPath} could not be parsed (${err instanceof Error ? err.message : String(err)}) — treated as empty when checking what's already wired`,
      );
    }
  }

  const result = mergeHooksIntoSettings({ settings: existing, snippet, localSettings });
  if (!result.ok) {
    return { merged: false, error: result.error };
  }

  const stripped = stripRetiredHookCommands(result.settings);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8');
  return { merged: true, warnings: [...warnings, ...result.warnings] };
}

/**
 * Delete retired Claude hook files and strip their commands from
 * settings.local.json when that file parses. settings.json is stripped in
 * writeMergedClaudeSettings; this covers the leftover file and local overlay.
 * @param {string} cwd
 */
function retireClaudeTriageHook(cwd) {
  const hooksDir = path.join(cwd, '.claude', 'hooks');
  for (const name of RETIRED_CLAUDE_HOOK_BASENAMES) {
    const file = path.join(hooksDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const localPath = path.join(cwd, '.claude', 'settings.local.json');
  if (!fs.existsSync(localPath)) return;
  try {
    const raw = fs.readFileSync(localPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const stripped = stripRetiredHookCommands(parsed);
    fs.writeFileSync(localPath, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8');
  } catch {
    // Leave an unparseable local file byte-identical (same posture as merge).
  }
}

/**
 * Append hook registrations into Claude settings.json if present / create stub note.
 * @param {string} cwd
 * @param {{ force?: boolean }} opts
 */
export function ensureClaudeHookHints(cwd, opts) {
  void opts;
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const notePath = path.join(cwd, '.claude', 'forge-hooks.snippet.json');
  const snippet = {
    _comment:
      'Merge these hooks into .claude/settings.json (SessionStart + UserPromptSubmit + PreToolUse + Stop). Paths assume forge CLI is on PATH. The model-policy PreToolUse hook is inert until .forge/models.local.json exists; the test-guard PreToolUse hook is inert without an active Forge session in implement/verify/review/finish; the Stop hook is inert without an active Forge session claiming completion.',
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
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-prompt-hook.mjs"',
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Agent|Task',
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-model-hook.mjs"',
              statusMessage: 'Checking subagent model policy',
            },
          ],
        },
        {
          matcher: 'Edit|Write|NotebookEdit|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-test-guard.mjs"',
              statusMessage: 'Checking test-guard policy',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-stop-hook.mjs"',
            },
          ],
        },
      ],
    },
  };
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  const settingsExisted = fs.existsSync(settingsPath);
  fs.writeFileSync(notePath, `${JSON.stringify(snippet, null, 2)}\n`, 'utf8');

  const mergeResult = writeMergedClaudeSettings(settingsPath, snippet);
  retireClaudeTriageHook(cwd);

  return {
    settingsExists: settingsExisted,
    snippet: notePath,
    settingsPath,
    ...mergeResult,
  };
}

/**
 * Write Cursor hooks snippet + ensure `.cursor/hooks.json` has forge sessionStart.
 * @param {string} cwd
 * @param {{ force?: boolean }} opts
 */
export function ensureCursorHookHints(cwd, opts) {
  const notePath = path.join(cwd, '.cursor', 'forge-hooks.snippet.json');
  const hooksPath = path.join(cwd, '.cursor', 'hooks.json');
  const forgeStart = {
    command: 'node .cursor/hooks/forge-session-start.mjs',
  };
  const snippet = {
    _comment:
      'Also written into .cursor/hooks.json by forge init. Requires Node on PATH.',
    version: 1,
    hooks: {
      sessionStart: [forgeStart],
    },
  };
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  if (!fs.existsSync(notePath) || opts.force) {
    fs.writeFileSync(notePath, `${JSON.stringify(snippet, null, 2)}\n`, 'utf8');
  }

  /** @type {{ version?: number, hooks?: Record<string, Array<{ command?: string }>> }} */
  let hooksDoc = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      hooksDoc = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    } catch {
      hooksDoc = { version: 1, hooks: {} };
    }
  }
  if (!hooksDoc || typeof hooksDoc !== 'object') hooksDoc = { version: 1, hooks: {} };
  if (typeof hooksDoc.version !== 'number') hooksDoc.version = 1;
  if (!hooksDoc.hooks || typeof hooksDoc.hooks !== 'object') hooksDoc.hooks = {};
  const starts = Array.isArray(hooksDoc.hooks.sessionStart)
    ? [...hooksDoc.hooks.sessionStart]
    : [];
  const hasForge = starts.some((h) =>
    String(h?.command ?? '').includes('forge-session-start'),
  );
  if (!hasForge) starts.push(forgeStart);
  hooksDoc.hooks.sessionStart = starts;
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooksDoc, null, 2)}\n`, 'utf8');

  return { snippet: notePath, hooks: hooksPath };
}

/**
 * @param {string[]} selected
 * @param {{ cwd: string, force?: boolean, overlay?: boolean, templatesRoot?: string, adr?: boolean | null, adrDir?: string | null, home?: string, planEngine?: string | null, planDir?: string | null }} opts
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

  const agentsSkillDest = path.join(cwd, '.agents', 'skills', 'forge');
  if (fs.existsSync(agentsSkillDest) && readInstallStamp(agentsSkillDest)) {
    fs.rmSync(agentsSkillDest, { recursive: true, force: true });
    report.agentsSkillRetired = {
      dest: '.agents/skills/forge',
      status: 'retired',
    };
  }

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
    report.cursorHooks = report.cursorHookSnippet;
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
    const scaffold = scaffoldSpecs(cwd, {
      force: opts.force,
      dir: opts.planDir ?? undefined,
    });
    const config = writeProjectPlanConfig(cwd, {
      engine: 'specs',
      dir: scaffold.dir,
    });
    report.plan = { engine: 'specs', dir: scaffold.dir, files: scaffold.files, config };
  } else if (opts.planEngine === 'openspec') {
    if (opts.planDir) {
      process.stderr.write(
        'Note: --plan-dir applies to the built-in specs engine; ignoring for openspec.\n',
      );
    }
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
  const allowed = new Set(initAgentIds());
  const user = loadUserConfig(home);
  return new Set(
    [
      ...(Array.isArray(user.agents) ? user.agents : []),
      ...installedManagedPairs(home).map((p) => p.agent),
      ...wiredAgents(cwd),
    ].filter((id) => allowed.has(id)),
  );
}

/** @param {string} cwd */
async function promptAgents(cwd) {
  const { checkbox } = await loadPrompts();
  const remembered = rememberedAgents(cwd);
  return checkbox({
    message: 'Init Forge project wiring for which environments?',
    choices: initAgentIds().map((id) => ({
      value: id,
      name: AGENTS[id].label,
      checked: remembered.has(id),
    })),
    required: true,
  });
}

/**
 * Offer to install + set up OpenSpec in this project (engine already chosen).
 * @returns {Promise<boolean>} true = user accepted OpenSpec setup now
 */
async function promptOpenSpecSetup() {
  const { confirm } = await loadPrompts();
  return confirm({
    message: 'OpenSpec is not set up in this project. Install and set it up now?',
    default: true,
  });
}

/**
 * Resolve the planning engine for `forge init`, offering OpenSpec setup when needed.
 *
 * Choosing OpenSpec (flag, user default, or interactive pick) always records
 * `plan.engine: openspec`. Immediate `openspec init` is best-effort — failure
 * or declining setup must not fall back to the built-in specs engine.
 *
 * Precedence, highest first: explicit flag; the project's own recorded
 * `plan.engine` (`.forge/config.json`); an on-disk OpenSpec signal
 * (`configured`); the user default; the prompt / non-TTY fallback. A project
 * with no recorded `plan.engine` falls through unchanged.
 *
 * @param {{
 *   cwd: string,
 *   openspec: boolean | null,
 *   agents?: string[],
 *   home?: string,
 *   isTTY?: boolean,
 *   confirmSetup?: () => Promise<boolean>,
 *   promptEngine?: () => Promise<boolean>,
 *   setup?: typeof setupOpenSpec,
 *   loadUser?: (home?: string) => string | null,
 * }} opts
 * @returns {Promise<string>} 'openspec' | 'specs'
 */
export async function resolveInitPlanEngine(opts) {
  const configured = hasOpenSpecConfig(opts.cwd);
  const tools = opts.agents;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  const runSetup = opts.setup ?? setupOpenSpec;
  const loadUser = opts.loadUser ?? ((home) => loadUserPlanEngine(home));
  const confirmSetup = opts.confirmSetup ?? promptOpenSpecSetup;
  const promptEngine = opts.promptEngine ?? promptOpenSpec;

  const reportSetup = (setup) => {
    for (const s of setup.steps) {
      process.stdout.write(
        `  [${s.ok ? 'ok' : 'FAIL'}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}\n`,
      );
    }
    if (!setup.ok) {
      process.stderr.write(
        'OpenSpec setup failed — engine recorded as openspec; re-run `forge doctor --install` or `openspec init` manually.\n',
      );
    }
  };

  /** Best-effort setup; never changes the chosen engine. */
  const ensureOpenSpecSetup = async ({ ask }) => {
    if (configured) return;
    if (!isTTY) return;
    if (ask) {
      const accepted = await confirmSetup();
      if (!accepted) {
        process.stdout.write(
          'OpenSpec engine recorded; run `openspec init` (or `forge doctor --install`) when ready.\n',
        );
        return;
      }
    }
    reportSetup(runSetup(opts.cwd, { tools }));
  };

  if (opts.openspec === false) return 'specs';

  if (opts.openspec === true) {
    // Flag means engine=openspec; attempt setup without a second prompt.
    await ensureOpenSpecSetup({ ask: false });
    return 'openspec';
  }

  // The project's own settled decision outranks the on-disk `configured`
  // signal and the user default — but only when `plan.engine` is actually
  // present. `loadProjectConfig` returns `{}` when absent, which must fall
  // through, not be mistaken for a recorded value.
  const recordedEngine = loadProjectConfig(opts.cwd).plan?.engine;
  if (PLAN_ENGINES.includes(recordedEngine)) {
    if (recordedEngine === 'openspec') {
      await ensureOpenSpecSetup({ ask: false });
    }
    return recordedEngine;
  }

  if (configured) return 'openspec';

  const userDefault = loadUser(opts.home);
  if (userDefault === 'specs') return 'specs';

  if (userDefault === 'openspec') {
    await ensureOpenSpecSetup({ ask: true });
    return 'openspec';
  }

  // No user default — ask on TTY, otherwise leave project on built-in specs.
  if (!isTTY) return 'specs';

  const wantOpenSpec = await promptEngine();
  if (!wantOpenSpec) return 'specs';

  await ensureOpenSpecSetup({ ask: true });
  return 'openspec';
}

/**
 * @param {string} [defaultDir]
 * @param {boolean} [defaultEnabled]
 * @returns {Promise<{ enabled: boolean, dir: string }>}
 */
async function promptAdrForInit(defaultDir = DEFAULT_ADR_DIR, defaultEnabled = true) {
  const { confirm, input } = await loadPrompts();
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

  let selected = opts.all ? initAgentIds() : [...new Set(opts.agents)];
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
      process.stderr.write(`Unknown environment: ${id}. Known: ${initAgentIds().join(', ')}\n`);
      return 1;
    }
  }

  const planEngine = await resolveInitPlanEngine({
    cwd: opts.cwd,
    openspec: opts.openspec,
    agents: selected,
  });

  // No --plan-dir on the command line: a recorded specs root is the
  // project's settled decision and outranks the built-in default. Absent
  // stays absent (first run still gets DEFAULT_SPECS_DIR downstream).
  let planDir = opts.planDir;
  if (planDir === null && planEngine === 'specs') {
    const recordedDir = loadProjectConfig(opts.cwd).plan?.dir;
    if (typeof recordedDir === 'string' && recordedDir) {
      planDir = recordedDir;
    }
  }

  let adr = opts.adr;
  let adrDir = opts.adrDir;
  if (adr === null) {
    // A recorded adr.enabled is the project's settled decision — it outranks
    // the user default and the prompt. Absent falls through unchanged.
    const recordedAdr = loadProjectConfig(opts.cwd).adr;
    if (recordedAdr && typeof recordedAdr.enabled === 'boolean') {
      adr = recordedAdr.enabled;
      adrDir = recordedAdr.dir ?? DEFAULT_ADR_DIR;
    } else {
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
  }

  const report = initProject(selected, {
    ...opts,
    adr,
    adrDir,
    planEngine,
    planDir,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.agentsSkillRetired) {
    process.stdout.write(
      `\nRetired leftover project copy: ${report.agentsSkillRetired.dest}\n`,
    );
  }
  if (Array.isArray(report.skillOnly) && report.skillOnly.length) {
    const labels = report.skillOnly.map((id) => AGENTS[id].label).join(', ');
    process.stdout.write(
      `\nNo project wiring for: ${labels} — they use the globally installed Forge skill directly (run \`forgekit install\` if not yet installed).\n`,
    );
  }
  if (report.claudeHooks && report.claudeHooks.merged === false) {
    process.stdout.write(
      `\n${report.claudeHooks.settingsPath} could not be merged — left untouched (${report.claudeHooks.error}).\n` +
        `Merge ${report.claudeHooks.snippet} into it by hand.\n`,
    );
  }
  if (report.claudeHooks?.warnings?.length) {
    for (const warning of report.claudeHooks.warnings) {
      process.stdout.write(`\nWarning: ${warning}\n`);
    }
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
