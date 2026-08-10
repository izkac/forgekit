import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
function identity() {
  const uid = process.env.HARBOR_UNTRUSTED_UID, gid = process.env.HARBOR_UNTRUSTED_GID;
  if (uid === undefined && gid === undefined) return {};
  if (!/^[0-9]+$/.test(uid || "") || !/^[0-9]+$/.test(gid || "") || typeof process.getuid !== "function" || process.getuid() !== 0) throw new Error("invalid worker identity");
  return { uid: Number(uid), gid: Number(gid) };
}
const WORKER = String.raw`
import { createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
const root = process.env.HARBOR_APP_DIR || "/app";
const nonce = "__NONCE__";
const prefix = "CARRIER_WORKER_" + nonce + " ";
const send = (value) => writeSync(4, prefix + JSON.stringify(value) + "\n");
const clone = structuredClone;
const NativePromise = Promise;
let createApplication;
let AppendOnlyEventStore;
let ShipmentProjectionStore;
try {
  ({ createApplication } = await import(pathToFileURL(root + "/src/app.mjs")));
  ({ AppendOnlyEventStore } = await import(pathToFileURL(root + "/src/event-store.mjs")));
  ({ ShipmentProjectionStore } = await import(pathToFileURL(root + "/src/shipment-store.mjs")));
} catch (error) { send({ type: "bootstrapError", message: String(error?.message || error) }); process.exit(1); }
let app;
let server;
function reset() {
  const log = [];
  const realEvents = new AppendOnlyEventStore();
  const realShipments = new ShipmentProjectionStore();
  const eventStore = {
    async append(event) { log.push(["append", event.carrier, event.eventId]); return realEvents.append(event); },
    entries: () => realEvents.entries(),
    size: () => realEvents.size(),
  };
  const shipmentStore = {
    async project(event) { log.push(["project", event.carrier, event.eventId]); return realShipments.project(event); },
    get: (id) => realShipments.get(id),
    entries: () => realShipments.entries(),
  };
  app = createApplication({ eventStore, shipmentStore });
  app.__hidden = { log, eventStore, shipmentStore };
  send({ type: "reset" });
}
function reconcile(command) { NativePromise.resolve(app.reconciliationService.reconcile(command.carrier, clone(command.payload))).then((value) => send({ type: "result", callId: command.callId, ok: true, value: clone(value) }), (error) => send({ type: "result", callId: command.callId, ok: false, error: { code: error?.code, message: error?.message } })); }
async function handle(command) {
  if (command.type === "reset") return reset();
  if (command.type === "reconcile") return reconcile(command);
  if (command.type === "snapshot") return send({ type: "snapshot", log: clone(app.__hidden.log), events: clone(app.__hidden.eventStore.entries()), projections: clone(app.__hidden.shipmentStore.entries()) });
  if (command.type === "startHttp") { server = app.server; await new NativePromise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return send({ type: "started", port: server.address().port }); }
  if (command.type === "stopHttp") { if (server) await new NativePromise((resolve) => server.close(resolve)); server = undefined; return send({ type: "stopped" }); }
}
const input = createInterface({ input: createReadStream(null, { fd: 3, autoClose: false }) });
input.on("line", (line) => { let command; try { command = JSON.parse(line); } catch { return send({ type: "protocolError" }); } NativePromise.resolve(handle(command)).catch((error) => send({ type: "workerError", message: String(error?.message || error) })); });
send({ type: "ready", uid: typeof process.getuid === "function" ? process.getuid() : null });
`;
class Worker {
  constructor() {
    this.nonce = randomBytes(24).toString("hex"); this.prefix = `CARRIER_WORKER_${this.nonce} `; this.inbox = []; this.waiters = [];
    this.child = spawn(process.execPath, ["--input-type=module"], { cwd: APP_DIR, env: { PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8", HARBOR_APP_DIR: APP_DIR }, stdio: ["pipe", "ignore", "ignore", "pipe", "pipe"], ...identity() });
    this.child.stdin.end(WORKER.replace("__NONCE__", this.nonce));
    createInterface({ input: this.child.stdio[4] }).on("line", (line) => { if (!line.startsWith(this.prefix)) return; try { this.accept(JSON.parse(line.slice(this.prefix.length))); } catch { /* ignored */ } });
    this.child.on("error", (error) => this.fail(error)); this.child.on("close", (code) => { if (code !== 0) this.fail(new Error(`worker exited ${code}`)); });
  }
  accept(message) { const at = this.waiters.findIndex((entry) => entry.predicate(message)); if (at >= 0) { const [{ resolve, timer }] = this.waiters.splice(at, 1); clearTimeout(timer); resolve(message); } else this.inbox.push(message); }
  fail(error) { for (const item of this.waiters.splice(0)) { clearTimeout(item.timer); item.reject(error); } }
  send(command) { this.child.stdio[3].write(`${JSON.stringify(command)}\n`); }
  wait(predicate, timeout = 5_000) { const at = this.inbox.findIndex(predicate); if (at >= 0) return Promise.resolve(this.inbox.splice(at, 1)[0]); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("worker timeout")), timeout); this.waiters.push({ predicate, resolve, reject, timer }); }); }
  stop() { this.child.kill("SIGKILL"); }
}
const dhl = ({ event, id, shipment, sequence, occurredAt }) => ({ event, event_id: id, tracking_number: shipment, sequence, occurred_at: occurredAt });
const fedex = ({ state, id, shipment, sequence, occurredAt }) => ({ state, id, trackingCode: shipment, providerSequence: sequence, timestamp: occurredAt });
async function call(worker, carrier, payload, callId) { worker.send({ type: "reconcile", carrier, payload, callId }); return worker.wait((m) => m.type === "result" && m.callId === callId); }
async function snap(worker) { worker.send({ type: "snapshot" }); return worker.wait((m) => m.type === "snapshot"); }
async function runContract() {
  const worker = new Worker();
  try {
    const ready = await worker.wait((m) => m.type === "ready"); const expectedUid = process.env.HARBOR_UNTRUSTED_UID === undefined ? process.getuid?.() : Number(process.env.HARBOR_UNTRUSTED_UID); assert.equal(ready.uid, expectedUid); worker.send({ type: "reset" }); await worker.wait((m) => m.type === "reset");
    const dhlCollision = dhl({ event: "in_transit", id: "shared-hidden", shipment: "DHL-HIDDEN", sequence: 2, occurredAt: "2026-08-10T10:02:00.000Z" });
    const fedexCollision = fedex({ state: "DELIVERED", id: "shared-hidden", shipment: "FEDEX-HIDDEN", sequence: 9, occurredAt: "2026-08-10T10:09:00.000Z" });
    assert.equal((await call(worker, "dhl", dhlCollision, "dhl")).value.accepted, true);
    assert.equal((await call(worker, "fedex", fedexCollision, "fedex")).value.accepted, true);
    let state = await snap(worker); assert.equal(state.events.length, 2); assert.deepEqual(state.log.slice(0, 4).map(([kind]) => kind), ["append", "project", "append", "project"]);
    const duplicate = await call(worker, "dhl", dhlCollision, "dup"); assert.equal(duplicate.value.accepted, false); state = await snap(worker); assert.equal(state.events.length, 2); assert.equal(state.log.length, 4);

    worker.send({ type: "reset" }); await worker.wait((m) => m.type === "reset");
    await call(worker, "dhl", dhl({ event: "in_transit", id: "newer", shipment: "LATE-HIDDEN", sequence: 4, occurredAt: "2026-08-10T10:04:00.000Z" }), "newer");
    await call(worker, "dhl", dhl({ event: "delivered", id: "terminal", shipment: "LATE-HIDDEN", sequence: 6, occurredAt: "2026-08-10T10:06:00.000Z" }), "terminal");
    await call(worker, "dhl", dhl({ event: "out_for_delivery", id: "older", shipment: "LATE-HIDDEN", sequence: 5, occurredAt: "2026-08-10T10:05:00.000Z" }), "older");
    await call(worker, "dhl", dhl({ event: "out_for_delivery", id: "later-terminal", shipment: "LATE-HIDDEN", sequence: 7, occurredAt: "2026-08-10T10:07:00.000Z" }), "later-terminal");
    state = await snap(worker); assert.equal(state.events.length, 4); assert.equal(state.projections[0].status, "delivered"); assert.deepEqual(state.log.map(([kind]) => kind), ["append", "project", "append", "project", "append", "append"]);

    worker.send({ type: "reset" }); await worker.wait((m) => m.type === "reset");
    await call(worker, "dhl", dhl({ event: "in_transit", id: "equal-old", shipment: "EQUAL-HIDDEN", sequence: 10, occurredAt: "2026-08-10T10:00:00.000Z" }), "equal-old");
    await call(worker, "dhl", dhl({ event: "delivered", id: "equal-new", shipment: "EQUAL-HIDDEN", sequence: 10, occurredAt: "2026-08-10T10:01:00.000Z" }), "equal-new");
    await call(worker, "dhl", dhl({ event: "out_for_delivery", id: "equal-late", shipment: "EQUAL-HIDDEN", sequence: 10, occurredAt: "2026-08-10T09:59:00.000Z" }), "equal-late");
    state = await snap(worker); assert.equal(state.events.length, 3); assert.equal(state.projections[0].status, "delivered"); assert.deepEqual(state.log.map(([kind]) => kind), ["append", "project", "append", "project", "append"]);

    const before = state.log.length; const unknown = await call(worker, "ups", dhlCollision, "unknown"); assert.equal(unknown.ok, false); assert.equal(unknown.error.code, "unknown_carrier"); const malformed = await call(worker, "dhl", { event_id: "broken" }, "malformed"); assert.equal(malformed.ok, false); assert.equal(malformed.error.code, "malformed_event"); state = await snap(worker); assert.equal(state.log.length, before);

    worker.send({ type: "startHttp" }); const started = await worker.wait((m) => m.type === "started"); try { const response = await fetch(`http://127.0.0.1:${started.port}/webhooks/fedex`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fedex({ state: "IN_TRANSIT", id: "http-hidden", shipment: "HTTP-HIDDEN", sequence: 1, occurredAt: "2026-08-10T12:00:00.000Z" })) }); assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true); } finally { worker.send({ type: "stopHttp" }); await worker.wait((m) => m.type === "stopped"); }
  } finally { worker.stop(); }
}
try { await runContract(); } catch { process.exitCode = 1; }
