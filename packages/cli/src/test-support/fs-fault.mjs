import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalized(value) {
  if (value instanceof URL) return path.resolve(fileURLToPath(value));
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  return path.resolve(String(value));
}

function matches(candidate, fault) {
  const actual = normalized(candidate);
  const target = normalized(fault.path);
  return fault.descendants
    ? actual === target || actual.startsWith(`${target}${path.sep}`)
    : actual === target;
}

export function installFsFaults(faults) {
  const byMethod = new Map();
  for (const fault of faults) {
    if (typeof fs[fault.method] !== 'function') throw new Error(`unknown fs method: ${fault.method}`);
    const entries = byMethod.get(fault.method) ?? [];
    entries.push(fault);
    byMethod.set(fault.method, entries);
  }

  const originals = new Map();
  for (const [method, entries] of byMethod) {
    const original = fs[method];
    originals.set(method, original);
    fs[method] = function faultInjected(candidate, ...args) {
      const fault = entries.find((entry) => matches(candidate, entry));
      if (fault) {
        const error = new Error(`${fault.code ?? 'EACCES'}: injected ${method} fault, ${normalized(candidate)}`);
        error.code = fault.code ?? 'EACCES';
        error.path = normalized(candidate);
        error.syscall = method;
        throw error;
      }
      return Reflect.apply(original, this, [candidate, ...args]);
    };
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [method, original] of originals) fs[method] = original;
  };
}

export function fsFaultEnv(faults, baseEnv = process.env) {
  const preload = new URL('./fs-fault-preload.mjs', import.meta.url).href;
  return {
    ...baseEnv,
    FORGEKIT_TEST_FS_FAULTS: JSON.stringify(faults),
    NODE_OPTIONS: [baseEnv.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
  };
}
