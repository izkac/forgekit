import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { pruneExtraneous } from '../scripts/prepack.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

test('pruneExtraneous makes the vendor tree a mirror, not just a copy', () => {
  // prepack copies skills/ into vendor/ and, on Windows, falls back to
  // "overwrite in place" when it cannot empty the directory first. Copying
  // never removes a file DELETED from source: a reference doc dropped from the
  // thorough-code-review skill shipped in 0.3.57 regardless, because nothing
  // pruned it. This is the half that makes the copy a mirror.
  const root = tmp('prepack-prune-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(path.join(src, 'skill', 'reference'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'skill', 'reference'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'retired-skill'), { recursive: true });

    fs.writeFileSync(path.join(src, 'skill', 'SKILL.md'), 'live\n');
    fs.writeFileSync(path.join(dest, 'skill', 'SKILL.md'), 'live\n');
    fs.writeFileSync(path.join(dest, 'skill', 'reference', 'stale.md'), 'deleted upstream\n');
    fs.writeFileSync(path.join(dest, 'retired-skill', 'SKILL.md'), 'whole skill removed\n');

    const { removed, failed } = pruneExtraneous(src, dest);
    assert.deepEqual(removed.map((p) => p.split(path.sep).join('/')).sort(), [
      'retired-skill',
      'skill/reference/stale.md',
    ]);
    assert.deepEqual(failed, []);

    // Live files survive; stale ones are gone, directories included.
    assert.equal(fs.existsSync(path.join(dest, 'skill', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(dest, 'skill', 'reference', 'stale.md')), false);
    assert.equal(fs.existsSync(path.join(dest, 'retired-skill')), false);

    // Idempotent: a second pass finds nothing, which is what the publish gate reads.
    assert.deepEqual(pruneExtraneous(src, dest), { removed: [], failed: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruneExtraneous on a missing destination is a no-op', () => {
  const root = tmp('prepack-prune-missing-');
  try {
    assert.deepEqual(pruneExtraneous(root, path.join(root, 'nope')), { removed: [], failed: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale file that cannot be deleted is reported, not thrown', () => {
  // The publish gate needs to say WHICH file would ship and how to clear it.
  // A raw EPERM out of the walk buries that under a stack trace — which is
  // exactly what happened on the machine that shipped 0.3.57.
  const root = tmp('prepack-prune-locked-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'stale.md'), 'x\n');

    const realRm = fs.rmSync;
    fs.rmSync = () => {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    };
    let result;
    try {
      result = pruneExtraneous(src, dest);
    } finally {
      fs.rmSync = realRm;
    }

    assert.deepEqual(result, { removed: [], failed: ['stale.md'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
