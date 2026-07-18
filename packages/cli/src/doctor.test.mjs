import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  OPENSPEC_INSTALL_CMD,
  checkOpenSpecCli,
  checkOpenSpecProject,
  runDoctor,
  runDoctorChecks,
  warnIfDoctorFails,
} from './doctor.mjs';

function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, text: () => text };
}

test('checkOpenSpecProject ok when config exists', () => {
  const result = checkOpenSpecProject({
    cwd: '/repo',
    existsSync: (p) => p.replace(/\\/g, '/') === '/repo/openspec/config.yaml',
  });
  assert.equal(result.ok, true);
});

test('checkOpenSpecProject fails when missing', () => {
  const result = checkOpenSpecProject({
    cwd: '/repo',
    existsSync: () => false,
  });
  assert.equal(result.ok, false);
});

test('checkOpenSpecCli ok when version exits 0', () => {
  const result = checkOpenSpecCli({
    runCommand: () => ({ status: 0, stdout: '1.2.0\n', stderr: '' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.0');
});

test('checkOpenSpecCli missing offers install', () => {
  const result = checkOpenSpecCli({
    runCommand: () => ({ status: 1, stdout: '', stderr: 'not found' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /@fission-ai\/openspec/);
  assert.equal(result.installCommand, OPENSPEC_INSTALL_CMD);
});

test('runDoctorChecks aggregates', () => {
  const report = runDoctorChecks({
    cwd: '/repo',
    existsSync: () => true,
    runCommand: () => ({ status: 0, stdout: '1.0.0', stderr: '' }),
  });
  assert.equal(report.ok, true);
});

test('runDoctor --warn-only exits 0 on failure', () => {
  const out = capture();
  const err = capture();
  const code = runDoctor(['--warn-only'], {
    cwd: '/repo',
    stdout: out.stream,
    stderr: err.stream,
    existsSync: () => true,
    runCommand: () => ({ status: 1, stdout: '', stderr: 'missing' }),
  });
  assert.equal(code, 0);
  assert.match(out.text(), /FAIL|not found|Install/i);
});

test('runDoctor exits 1 when CLI missing', () => {
  const out = capture();
  const err = capture();
  const code = runDoctor([], {
    cwd: '/repo',
    stdout: out.stream,
    stderr: err.stream,
    existsSync: () => true,
    runCommand: () => ({ status: 1, stdout: '', stderr: 'missing' }),
  });
  assert.equal(code, 1);
  assert.match(out.text(), /npm install -g @fission-ai\/openspec/);
});

test('warnIfDoctorFails writes to stderr', () => {
  const err = capture();
  const report = warnIfDoctorFails({
    cwd: '/repo',
    stderr: err.stream,
    existsSync: () => false,
    runCommand: () => ({ status: 1, stdout: '', stderr: '' }),
  });
  assert.equal(report.ok, false);
  assert.match(err.text(), /forge:doctor/);
  assert.match(err.text(), /install/i);
});

test('path join uses openspec/config.yaml', () => {
  const result = checkOpenSpecProject({
    cwd: path.join('S:', 'Projects', 'janus'),
    existsSync: (p) => p.endsWith(path.join('openspec', 'config.yaml')),
  });
  assert.equal(result.ok, true);
});
