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
function send(value) { safeWrite(4, prefix + safeStringify(value) + "\n"); }
function errorValue(error) {
  return { code: error && error.code, name: error && error.name, message: error && error.message };
}
const root = process.env.HARBOR_APP_DIR || "/app";
let ConfirmationService;
let createHttpServer;
try {
  ({ ConfirmationService } = await import(pathToFileURL(root + "/src/confirmation-service.mjs")));
  ({ createHttpServer } = await import(pathToFileURL(root + "/src/http-app.mjs")));
} catch (error) {
  send({ type: "bootstrapError", error: errorValue(error) });
  process.exit(1);
}
let now = 0;
let state = new Map();
let gatewaySequence = 0;
let pendingCharges = new Map();
let service;
let store;
let server;
function domainError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
function reset(command) {
  now = command.now;
  state = new Map(command.reservations.map((value) => [value.id, { ...safeClone(value), status: value.status || "held" }]));
  gatewaySequence = 0;
  pendingCharges = new Map();
  store = Object.freeze({
    get(id) {
      const value = state.get(id);
      if (!value) throw domainError("not_found", "Reservation not found", 404);
      return safeClone(value);
    },
    markConfirmed(id, details) {
      const current = state.get(id);
      if (!current) throw domainError("not_found", "Reservation not found", 404);
      if (current.status === "confirmed") {
        if (current.idempotencyKey !== details.idempotencyKey) {
          throw domainError("already_confirmed", "Reservation was confirmed by another request", 409);
        }
        return safeClone(current);
      }
      const value = { ...current, status: "confirmed", ...safeClone(details) };
      state.set(id, value);
      send({ type: "stored", reservation: safeClone(value) });
      return safeClone(value);
    }
  });
  const gateway = Object.freeze({
    charge(input) {
      const chargeId = "charge-" + (++gatewaySequence);
      return new NativePromise((resolve, reject) => {
        pendingCharges.set(chargeId, { resolve, reject });
        send({ type: "charge", chargeId, input: safeClone(input) });
      });
    }
  });
  const clock = Object.freeze({ now: () => now });
  service = new ConfirmationService({ reservationStore: store, paymentGateway: gateway, clock });
  send({ type: "reset" });
}
function settleConfirm(command) {
  NativePromise.resolve().then(
    () => service.confirm(command.reservationId, command.key)
  ).then(
    (value) => send({ type: "confirmResult", callId: command.callId, ok: true, value: safeClone(value) }),
    (error) => send({ type: "confirmResult", callId: command.callId, ok: false, error: errorValue(error) })
  );
}
async function handle(command) {
  if (command.type === "barrier") return send({ type: "barrier", barrierId: command.barrierId });
  if (command.type === "reset") return reset(command);
  if (command.type === "confirm") return settleConfirm(command);
  if (command.type === "setClock") { now = command.now; return send({ type: "clockSet" }); }
  if (command.type === "gatewayResolve" || command.type === "gatewayReject") {
    const pending = pendingCharges.get(command.chargeId);
    if (!pending) throw new Error("unknown charge");
    pendingCharges.delete(command.chargeId);
    if (command.type === "gatewayResolve") pending.resolve({ paymentId: command.paymentId });
    else pending.reject(domainError(command.code || "declined", command.message || "declined", 402));
    return;
  }
  if (command.type === "snapshot") {
    return send({ type: "snapshot", reservations: [...state.values()].map((value) => safeClone(value)) });
  }
  if (command.type === "startHttp") {
    server = createHttpServer({ confirmationService: service, reservationStore: store });
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
        HARBOR_APP_DIR: APP_DIR
      },
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      ...configuredIdentity()
    });
    this.child.stdin.end(source);
    const lines = createInterface({ input: this.child.stdio[4] });
    lines.on("line", (line) => {
      if (!line.startsWith(this.prefix)) return;
      try { this.#accept(JSON.parse(line.slice(this.prefix.length))); } catch {
        // Invalid or candidate-forged protocol lines are ignored.
      }
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
      }, timeout);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  count(type, since = 0) {
    return this.history.slice(since).filter((message) => message.type === type).length;
  }

  stop() {
    this.child.kill("SIGKILL");
  }
}

function held(id = "hidden-reservation", amount = 9187, expiresAt = 200) {
  return { id, amount, expiresAt, status: "held" };
}

async function reset(worker, reservations = [held()], now = 100) {
  const start = worker.history.length;
  worker.send({ type: "reset", reservations, now });
  await worker.wait((message) => message.type === "reset");
  return start;
}

async function confirmation(worker, callId) {
  return worker.wait((message) => message.type === "confirmResult" && message.callId === callId);
}

async function runContract() {
  const worker = new CandidateWorker();
  try {
    await worker.wait((message) => message.type === "ready");

    let since = await reset(worker);
    worker.send({ type: "confirm", callId: "same-1", reservationId: "hidden-reservation", key: "same-key" });
    const charge = await worker.wait((message) => message.type === "charge");
    worker.send({ type: "confirm", callId: "same-2", reservationId: "hidden-reservation", key: "same-key" });
    worker.send({ type: "barrier", barrierId: "same" });
    await worker.wait((message) => message.type === "barrier" && message.barrierId === "same");
    assert.equal(worker.count("charge", since), 1);
    worker.send({ type: "gatewayResolve", chargeId: charge.chargeId, paymentId: "same-payment" });
    const same = await Promise.all([confirmation(worker, "same-1"), confirmation(worker, "same-2")]);
    assert.ok(same.every((entry) => entry.ok && entry.value.paymentId === "same-payment"));
    worker.send({ type: "snapshot" });
    const snapshot = await worker.wait((message) => message.type === "snapshot");
    assert.equal(snapshot.reservations[0].status, "confirmed");

    since = await reset(worker);
    worker.send({ type: "confirm", callId: "winner", reservationId: "hidden-reservation", key: "winner-key" });
    const winnerCharge = await worker.wait((message) => message.type === "charge");
    worker.send({ type: "confirm", callId: "loser", reservationId: "hidden-reservation", key: "loser-key" });
    worker.send({ type: "barrier", barrierId: "different" });
    await worker.wait((message) => message.type === "barrier" && message.barrierId === "different");
    assert.equal(worker.count("charge", since), 1);
    worker.send({ type: "gatewayResolve", chargeId: winnerCharge.chargeId, paymentId: "winner-payment" });
    const [loser, winner] = await Promise.all([confirmation(worker, "loser"), confirmation(worker, "winner")]);
    assert.equal(loser.ok, false);
    assert.equal(loser.error.code, "already_confirmed");
    assert.equal(winner.ok, true);

    since = await reset(worker);
    worker.send({ type: "confirm", callId: "failure-1", reservationId: "hidden-reservation", key: "retry-key" });
    const failedCharge = await worker.wait((message) => message.type === "charge");
    worker.send({ type: "confirm", callId: "failure-2", reservationId: "hidden-reservation", key: "retry-key" });
    worker.send({ type: "barrier", barrierId: "failure" });
    await worker.wait((message) => message.type === "barrier" && message.barrierId === "failure");
    assert.equal(worker.count("charge", since), 1);
    worker.send({ type: "gatewayReject", chargeId: failedCharge.chargeId, code: "declined", message: "declined" });
    const failures = await Promise.all([confirmation(worker, "failure-1"), confirmation(worker, "failure-2")]);
    assert.ok(failures.every((entry) => !entry.ok && entry.error.code === "declined"));
    assert.equal(worker.count("charge", since), 1);
    worker.send({ type: "confirm", callId: "retry", reservationId: "hidden-reservation", key: "retry-key" });
    const retryCharge = await worker.wait((message) => message.type === "charge" && message.chargeId !== failedCharge.chargeId);
    worker.send({ type: "gatewayResolve", chargeId: retryCharge.chargeId, paymentId: "retry-payment" });
    assert.equal((await confirmation(worker, "retry")).value.paymentId, "retry-payment");

    since = await reset(worker, [held()], 200);
    worker.send({ type: "confirm", callId: "expired", reservationId: "hidden-reservation", key: "expired-key" });
    const expired = await confirmation(worker, "expired");
    assert.equal(expired.ok, false);
    assert.equal(expired.error.code, "expired");
    assert.equal(worker.count("charge", since), 0);

    since = await reset(worker, [held()], 199);
    worker.send({ type: "confirm", callId: "admitted", reservationId: "hidden-reservation", key: "admitted-key" });
    const admittedCharge = await worker.wait((message) => message.type === "charge");
    worker.send({ type: "setClock", now: 500 });
    await worker.wait((message) => message.type === "clockSet");
    worker.send({ type: "gatewayResolve", chargeId: admittedCharge.chargeId, paymentId: "admitted-payment" });
    assert.equal((await confirmation(worker, "admitted")).value.paymentId, "admitted-payment");

    since = await reset(worker, [held("one", 10), held("two", 20)], 100);
    worker.send({ type: "confirm", callId: "one", reservationId: "one", key: "one-key" });
    const oneCharge = await worker.wait((message) => message.type === "charge" && message.input.reservationId === "one");
    worker.send({ type: "confirm", callId: "two", reservationId: "two", key: "two-key" });
    const twoCharge = await worker.wait((message) => message.type === "charge" && message.input.reservationId === "two");
    assert.equal(worker.count("charge", since), 2);
    worker.send({ type: "gatewayResolve", chargeId: twoCharge.chargeId, paymentId: "two-payment" });
    assert.equal((await confirmation(worker, "two")).value.paymentId, "two-payment");
    worker.send({ type: "gatewayResolve", chargeId: oneCharge.chargeId, paymentId: "one-payment" });
    assert.equal((await confirmation(worker, "one")).value.paymentId, "one-payment");

    since = await reset(worker, [held("http-reservation")], 100);
    worker.send({ type: "startHttp" });
    const started = await worker.wait((message) => message.type === "serverStarted");
    const base = `http://127.0.0.1:${started.port}`;
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(await root.text(), "reservation-service\n");
    const shown = await fetch(`${base}/reservations/http-reservation`);
    assert.equal(shown.status, 200);
    assert.equal((await shown.json()).id, "http-reservation");
    const responsePromise = fetch(`${base}/reservations/http-reservation/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-hidden-key" },
      body: "{}"
    });
    const httpCharge = await worker.wait((message) => message.type === "charge" && message.input.reservationId === "http-reservation");
    worker.send({ type: "gatewayResolve", chargeId: httpCharge.chargeId, paymentId: "http-hidden-payment" });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).paymentId, "http-hidden-payment");
    assert.equal(worker.count("charge", since), 1);
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    worker.send({ type: "stopHttp" });
    await worker.wait((message) => message.type === "serverStopped");
    return true;
  } finally {
    worker.stop();
  }
}

let functional = false;
try {
  functional = await runContract();
} catch (_error) {
  functional = false;
}
console.log(`HARBOR_TRUSTED_RESERVATION ${JSON.stringify({ functional })}`);
