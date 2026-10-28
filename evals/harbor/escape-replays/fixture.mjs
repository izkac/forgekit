/**
 * Test support for the escape-replay exporter: temp git repos and a scratch project whose ledger,
 * sessions and archived change line up with a nested repository. Not used at runtime.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DAY = 86400000;
export const T0 = Date.parse('2026-10-01T12:00:00Z');

export const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

export const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/** A git repository at `dir` with fixed identity and LF checkout; `commit` writes files, commits, returns the sha. */
export function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args, at = T0, input) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      input,
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) git(['config', k, v]);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) {
        fs.rmSync(path.join(dir, rel), { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  return { commit, git };
}

/**
 * A scratch project root holding a nested repo `web/` and the Forge records that point at it:
 * one done session whose window covers the session commits, one confirmed escape per fix commit,
 * a replay rule and an archived change for the session's slug.
 *
 * The nested repo's history, oldest first: `baseFiles` (before the session window), one commit
 * per `sessionFiles` entry (inside the window), then one fix commit per `fixes` entry (a day
 * later). Each fix is `{ files, test }`; `test` is the replayTest path the escape records (a fix without one is an ordinary later commit).
 *
 * @param {import('node:test').TestContext} t
 * @param {{ slug?: string, baseFiles: Record<string, string | null>, sessionFiles: Array<Record<string, string | null>>,
 *   fixes: Array<{ files: Record<string, string | null>, test?: string, subject?: string }>, rules?: unknown[],
 *   spec?: boolean, extra?: (r: ReturnType<typeof repo>, web: string) => void }} o
 */
export function scratchProject(t, { slug = 'order-refunds', baseFiles, sessionFiles, fixes, rules, spec = true, extra }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-export-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const web = path.join(root, 'web');
  const r = repo(web);
  extra?.(r, web);
  const base = r.commit(baseFiles, 'chore: base', T0 - DAY);
  const session = sessionFiles.map((files, i) => r.commit(files, `feat: session ${i + 1}`, T0 + 600000 * (i + 1)));
  const fixShas = fixes.map((f, i) => r.commit(f.files, f.subject ?? `fix: ${i + 1}`, T0 + DAY + 60000 * i));

  const sessionId = 'sess-1';
  write(
    path.join(root, '.forge', 'sessions.jsonl'),
    jsonl([{ phase: 'done', sessionId, slug, startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 2 * 3600000).toISOString() }]),
  );
  write(
    path.join(root, '.forge', 'escapes.jsonl'),
    jsonl(fixes.flatMap((f, i) => (f.test ? [{ sessionId, slug, commit: fixShas[i], repo: 'web', replayTest: f.test, decision: 'confirmed', command: 'node --test x' }] : []))),
  );
  write(
    path.join(root, '.forge', 'config.json'),
    JSON.stringify({ escapes: { replay: rules ?? [{ match: 'web/server/test/**', cwd: 'web/server', command: 'node --test {file}', copy: ['.env'] }] } }),
  );
  if (spec) {
    const archive = path.join(root, 'specs', 'changes', 'archive', `2026-10-02-${slug}`);
    write(path.join(archive, 'proposal.md'), '## Why\n\nPROPOSAL-MARKER refunds are missing.\n');
    write(path.join(archive, 'specs', 'refunds', 'spec.md'), '### Requirement: Refund\n\nSPEC-MARKER refunds restock.\n');
    write(path.join(archive, 'design.md'), 'DESIGN-MARKER use a ledger.\n');
  }
  const out = `${root}-out`;
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return { root, web, out, repo: r, shas: { base, session, fixes: fixShas }, sessionId, slug };
}
