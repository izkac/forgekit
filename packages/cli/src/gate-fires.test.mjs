import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GATE_IDS, firesLogPath, readGateFires, recordGateFire, summarizeGateFires } from './gate-fires.mjs';

/** Point the fleet registry at a fresh `<tmp>/sessions` for the duration of `fn`. */
function withFleet(fn) {
  const prev = process.env.FORGEKIT_FLEET_DIR;
  const home = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-'));
  process.env.FORGEKIT_FLEET_DIR = path.join(home, 'sessions');
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
}

test('the fires log sits beside the fleet registry dir', () => {
  withFleet((home) => {
    assert.equal(firesLogPath(), path.join(home, 'gate-fires.jsonl'));
  });
});

test('recordGateFire appends one line per fire with gate, session, project and time', () => {
  withFleet(() => {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-proj-'));
    assert.equal(recordGateFire('test-guard', { sessionId: 's1', cwd }), true);
    assert.equal(recordGateFire('done:tasks', { sessionId: 's2', cwd, detail: 'tasks incomplete (1/2)' }), true);
    const fires = readGateFires();
    assert.equal(fires.length, 2);
    assert.deepEqual(
      fires.map((f) => [f.gate, f.sessionId, f.project]),
      [
        ['test-guard', 's1', path.resolve(cwd)],
        ['done:tasks', 's2', path.resolve(cwd)],
      ],
    );
    assert.ok(!Number.isNaN(Date.parse(fires[0].at)));
    assert.equal(fires[1].detail, 'tasks incomplete (1/2)');
  });
});

test('a corrupt line does not hide the others', () => {
  withFleet(() => {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-proj-'));
    recordGateFire('brief', { sessionId: 'a', cwd });
    fs.appendFileSync(firesLogPath(), '{"gate": "half\n');
    recordGateFire('brief', { sessionId: 'b', cwd });
    assert.deepEqual(readGateFires().map((f) => f.sessionId), ['a', 'b']);
  });
});

test('scratch projects under the temp dir are not logged into the real registry', () => {
  const prev = process.env.FORGEKIT_FLEET_DIR;
  delete process.env.FORGEKIT_FLEET_DIR;
  try {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-scratch-'));
    assert.equal(recordGateFire('brief', { sessionId: 'x', cwd }), false);
  } finally {
    if (prev !== undefined) process.env.FORGEKIT_FLEET_DIR = prev;
  }
});

test('an unwritable log never throws', () => {
  const prev = process.env.FORGEKIT_FLEET_DIR;
  const blocker = path.join(fs.mkdtempSync(path.join(tmpdir(), 'forge-fires-block-')), 'file');
  fs.writeFileSync(blocker, 'x');
  // dirname(fleetDir()) is a regular file, so the log cannot be created.
  process.env.FORGEKIT_FLEET_DIR = path.join(blocker, 'sessions');
  try {
    assert.equal(recordGateFire('brief', { sessionId: 'x', cwd: tmpdir() }), false);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
});

test('summary counts per gate, lists every known gate at zero, keeps unknown ids, honours since', () => {
  const fires = [
    { gate: 'test-guard', sessionId: 'a', at: '2026-10-01T00:00:00.000Z' },
    { gate: 'test-guard', sessionId: 'a', at: '2026-10-02T00:00:00.000Z' },
    { gate: 'test-guard', sessionId: 'b', at: '2026-10-03T00:00:00.000Z' },
    { gate: 'some-future-gate', sessionId: 'c', at: '2026-10-04T00:00:00.000Z' },
  ];
  const rows = summarizeGateFires(fires);
  const byGate = Object.fromEntries(rows.map((r) => [r.gate, r]));
  assert.equal(byGate['test-guard'].fires, 3);
  assert.equal(byGate['test-guard'].sessions, 2);
  assert.equal(byGate['test-guard'].lastAt, '2026-10-03T00:00:00.000Z');
  assert.equal(byGate['some-future-gate'].fires, 1, 'ids not in GATE_IDS still appear');
  for (const id of GATE_IDS.filter((g) => g !== 'test-guard')) {
    assert.equal(byGate[id].fires, 0, `${id} listed at zero`);
  }
  assert.equal(rows[0].gate, 'test-guard', 'most-fired first');

  const recent = Object.fromEntries(
    summarizeGateFires(fires, { since: '2026-10-02T12:00:00.000Z' }).map((r) => [r.gate, r.fires]),
  );
  assert.equal(recent['test-guard'], 1);
});
