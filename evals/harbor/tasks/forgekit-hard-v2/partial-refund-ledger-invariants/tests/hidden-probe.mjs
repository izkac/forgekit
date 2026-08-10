import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";

function configuredIdentity() {
  const uidText = process.env.HARBOR_UNTRUSTED_UID;
  const gidText = process.env.HARBOR_UNTRUSTED_GID;
  if (uidText === undefined && gidText === undefined) return {};
  if (!/^[0-9]+$/.test(uidText || "") || !/^[0-9]+$/.test(gidText || "")) {
    throw new Error("invalid worker identity");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("worker privilege drop requires root");
  }
  return { uid: Number(uidText), gid: Number(gidText) };
}

const WORKER_SOURCE = String.raw`
import { writeSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
const nonce = "__NONCE__";
const prefix = "HARBOR_WORKER_" + nonce + " ";
const safeWrite = writeSync.bind(null);
const safeStringify = JSON.stringify.bind(JSON);
const safeParse = JSON.parse.bind(JSON);
const safeClone = structuredClone;
const NativePromise = Promise;
const safeImmediate = setImmediate;
function send(value) { safeWrite(4, prefix + safeStringify(value) + "\n"); }
function errorValue(error) {
  return { code: error && error.code, name: error && error.name, message: error && error.message };
}
const root = process.env.HARBOR_APP_DIR || "/app";
let createApplication;
let MemoryChargeStore;
let AppendOnlyRefundLedger;
try {
  ({ createApplication } = await import(pathToFileURL(root + "/src/app.mjs")));
  ({ MemoryChargeStore } = await import(pathToFileURL(root + "/src/charge-store.mjs")));
  ({ AppendOnlyRefundLedger } = await import(pathToFileURL(root + "/src/refund-ledger.mjs")));
} catch (error) {
  send({ type: "bootstrapError", error: errorValue(error) });
  process.exit(1);
}
let app;
let ledger;
let gateway;
let server;
function reset(command) {
  const calls = [];
  const failCalls = new Set(command.failCalls || []);
  gateway = {
    calls,
    async refund(request) {
      calls.push({ ...request });
      if (failCalls.has(calls.length)) throw new Error("hidden gateway failure");
      return { refundId: "hidden-" + calls.length, amountCents: request.amountCents };
    },
  };
  ledger = new AppendOnlyRefundLedger();
  app = createApplication({
    chargeStore: new MemoryChargeStore(command.charges.map((value) => safeClone(value))),
    ledger,
    refundGateway: gateway,
  });
  send({ type: "reset" });
}
function settleRefund(command) {
  NativePromise.resolve().then(
    () => app.refundService.refund(command.chargeId, command.amountCents, command.idempotencyKey),
  ).then(
    (value) => send({ type: "refundResult", callId: command.callId, ok: true, value: safeClone(value) }),
    (error) => send({ type: "refundResult", callId: command.callId, ok: false, error: errorValue(error) }),
  );
}
async function handle(command) {
  if (command.type === "barrier") {
    await new NativePromise((resolve) => safeImmediate(resolve));
    return send({ type: "barrier", barrierId: command.barrierId });
  }
  if (command.type === "reset") return reset(command);
  if (command.type === "refund") return settleRefund(command);
  if (command.type === "snapshot") {
    return send({
      type: "snapshot",
      entries: safeClone(ledger.entries()),
      calls: safeClone(gateway.calls),
    });
  }
  if (command.type === "startHttp") {
    server = app.server;
    await new NativePromise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return send({ type: "serverStarted", port: server.address().port });
  }
  if (command.type === "stopHttp") {
    if (server) await new NativePromise((resolve) => server.close(resolve));
    server = undefined;
    return send({ type: "serverStopped" });
  }
}
const input = createInterface({ input: createReadStream(null, { fd: 3, autoClose: false }) });
input.on("line", (line) => {
  let command;
  try { command = safeParse(line); }
  catch (error) { send({ type: "protocolError", error: errorValue(error) }); return; }
  NativePromise.resolve(handle(command)).catch((error) => send({ type: "workerError", error: errorValue(error) }));
});
send({ type: "ready" });
`;

class CandidateWorker {
  constructor() {
    this.nonce = randomBytes(24).toString("hex");
    this.prefix = `HARBOR_WORKER_${this.nonce} `;
    this.inbox = [];
    this.history = [];
    this.waiters = [];
    const source = WORKER_SOURCE.replace("__NONCE__", this.nonce);
    this.child = spawn(process.execPath, ["--input-type=module"], {
      cwd: APP_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp",
        LANG: process.env.LANG || "C.UTF-8",
        HARBOR_APP_DIR: APP_DIR,
      },
      stdio: ["pipe", "ignore", "ignore", "pipe", "pipe"],
      ...configuredIdentity(),
    });
    this.child.stdin.end(source);
    const lines = createInterface({ input: this.child.stdio[4] });
    lines.on("line", (line) => {
      if (!line.startsWith(this.prefix)) return;
      try { this.#accept(JSON.parse(line.slice(this.prefix.length))); } catch { /* ignored */ }
    });
    this.child.on("error", (error) => this.#fail(error));
    this.child.on("close", (code) => {
      if (code !== 0) this.#fail(new Error(`candidate worker exited ${code}`));
    });
  }

  #accept(message) {
    this.history.push(message);
    const index = this.waiters.findIndex(({ predicate }) => predicate(message));
    if (index >= 0) {
      const [{ resolve, timer }] = this.waiters.splice(index, 1);
      clearTimeout(timer);
      resolve(message);
    } else this.inbox.push(message);
  }

  #fail(error) {
    for (const { reject, timer } of this.waiters.splice(0)) {
      clearTimeout(timer);
      reject(error);
    }
  }

  send(command) {
    this.child.stdio[3].write(`${JSON.stringify(command)}\n`);
  }

  wait(predicate, timeout = 5_000) {
    const index = this.inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((entry) => entry.resolve === resolve);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("candidate worker timeout"));
      }, timeout);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  stop() {
    this.child.kill("SIGKILL");
  }
}

const charge = { id: "hidden-charge", amountCents: 14_209 };
const sequence = [1_117, 3_208, 9_884];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const successfulTotal = (snapshot, chargeId) => snapshot.entries
  .filter((entry) => entry.chargeId === chargeId && entry.status === "succeeded")
  .reduce((total, entry) => total + entry.amountCents, 0);

async function reset(worker, failCalls = []) {
  worker.send({ type: "reset", charges: [charge], failCalls });
  await worker.wait((message) => message.type === "reset");
}
async function refund(worker, callId, amountCents, idempotencyKey) {
  worker.send({ type: "refund", callId, chargeId: charge.id, amountCents, idempotencyKey });
  return worker.wait((message) => message.type === "refundResult" && message.callId === callId);
}
async function snapshot(worker) {
  worker.send({ type: "snapshot" });
  return worker.wait((message) => message.type === "snapshot");
}
function assertOk(result, amountCents) {
  assert.equal(result.ok, true);
  assert.equal(result.value.amountCents, amountCents);
}
function assertError(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
}

async function runContract() {
  const worker = new CandidateWorker();
  try {
    await worker.wait((message) => message.type === "ready");
    await reset(worker);
    assertOk(await refund(worker, "first", sequence[0], "hidden-first"), sequence[0]);
    assertOk(await refund(worker, "second", sequence[1], "hidden-second"), sequence[1]);
    const exactRemaining = charge.amountCents - sum(sequence.slice(0, 2));
    assert.equal(exactRemaining, sequence[2]);
    assertOk(await refund(worker, "final", exactRemaining, "hidden-final"), sequence[2]);
    assertError(await refund(worker, "over", sequence[0], "hidden-over"), "refund_exceeds_charge");
    const complete = await snapshot(worker);
    assert.equal(successfulTotal(complete, charge.id), charge.amountCents);
    assert.deepEqual(complete.entries.map((entry) => entry.amountCents), sequence);
    assert.ok(complete.entries.every((entry) => entry.status === "succeeded"));
    assert.equal(complete.calls.length, 3);

    await reset(worker, [1]);
    assertError(await refund(worker, "failure", sequence[0], "hidden-failure"), "gateway_failed");
    let failed = await snapshot(worker);
    assert.equal(successfulTotal(failed, charge.id), 0);
    assert.equal(failed.entries.filter((entry) => entry.status === "failed").length, 1);
    assertOk(await refund(worker, "retry", sequence[0], "hidden-retry"), sequence[0]);
    failed = await snapshot(worker);
    assert.equal(successfulTotal(failed, charge.id), sequence[0]);
    assert.equal(failed.calls.length, 2);

    await reset(worker);
    const original = await refund(worker, "original", sequence[1], "hidden-key");
    const replayResult = await refund(worker, "replay", sequence[1], "hidden-key");
    assert.equal(replayResult.ok, true);
    assert.deepEqual(replayResult.value, original.value);
    const replay = await snapshot(worker);
    assert.equal(replay.calls.length, 1);
    assert.equal(replay.entries.length, 1);
    const beforeConflict = replay;
    assertError(await refund(worker, "conflict", sequence[1] + 1, "hidden-key"), "idempotency_conflict");
    const afterConflict = await snapshot(worker);
    assert.deepEqual(afterConflict.entries, beforeConflict.entries);
    assert.deepEqual(afterConflict.calls, beforeConflict.calls);

    for (const amountCents of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
      const beforeInvalid = await snapshot(worker);
      assertError(await refund(worker, `invalid-${String(amountCents)}`, amountCents, `hidden-invalid-${String(amountCents)}`), "invalid_amount");
      const afterInvalid = await snapshot(worker);
      assert.deepEqual(afterInvalid.entries, beforeInvalid.entries);
      assert.deepEqual(afterInvalid.calls, beforeInvalid.calls);
    }

    await reset(worker);
    worker.send({ type: "startHttp" });
    const started = await worker.wait((message) => message.type === "serverStarted");
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/charges/${charge.id}/refunds`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "hidden-http" },
        body: JSON.stringify({ amountCents: sequence[0] }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).amountCents, sequence[0]);
    } finally {
      worker.send({ type: "stopHttp" });
      await worker.wait((message) => message.type === "serverStopped");
    }
    return true;
  } finally {
    worker.stop();
  }
}

try {
  await runContract();
} catch {
  process.exitCode = 1;
}
