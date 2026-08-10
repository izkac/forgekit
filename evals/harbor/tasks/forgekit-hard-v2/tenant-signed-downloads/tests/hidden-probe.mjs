import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const ATLAS_BYTES = "atlas hidden quarterly bytes\n";
const BOREAL_BYTES = "boreal hidden confidential bytes\n";
const OTHER_BYTES = "atlas hidden appendix bytes\n";

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
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
const nonce = "__NONCE__";
const prefix = "HARBOR_WORKER_" + nonce + " ";
const safeWrite = writeSync.bind(null);
const safeStringify = JSON.stringify.bind(JSON);
const safeParse = JSON.parse.bind(JSON);
const safeFetch = fetch.bind(globalThis);
const SafeSearchParams = URLSearchParams;
function send(value) { safeWrite(4, prefix + safeStringify(value) + "\n"); }
function errorValue(error) { return { name: error && error.name, code: error && error.code, message: error && error.message }; }
const root = process.env.HARBOR_APP_DIR || "/app";
let createApplication;
let ManualClock;
let MemoryTenantDocumentStore;
try {
  ({ createApplication } = await import(pathToFileURL(root + "/src/app.mjs")));
  ({ ManualClock } = await import(pathToFileURL(root + "/src/clock.mjs")));
  ({ MemoryTenantDocumentStore } = await import(pathToFileURL(root + "/src/document-store.mjs")));
} catch (error) {
  send({ type: "bootstrapError", error: errorValue(error) });
  process.exit(1);
}
const clock = new ManualClock(10000);
const signingKeys = new Map([
  ["atlas", "hidden-shared-signing-key"],
  ["boreal", "hidden-shared-signing-key"],
]);
const documentStore = new MemoryTenantDocumentStore([
  { tenantId: "atlas", id: "quarterly", bytes: Buffer.from("atlas hidden quarterly bytes\n"), contentType: "text/plain; charset=utf-8", fileName: "atlas-hidden.txt" },
  { tenantId: "boreal", id: "quarterly", bytes: Buffer.from("boreal hidden confidential bytes\n"), contentType: "text/plain; charset=utf-8", fileName: "boreal-hidden.txt" },
  { tenantId: "atlas", id: "appendix", bytes: Buffer.from("atlas hidden appendix bytes\n"), contentType: "application/octet-stream", fileName: "atlas-appendix.bin" },
]);
const application = createApplication({ clock, signingKeys, documentStore });
const server = application.server;
async function request(base, pathname, options = {}) {
  const response = await safeFetch(base + pathname, options);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
    contentLength: response.headers.get("content-length"),
    body: await response.text(),
  };
}
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const issue = await request(base, "/tenants/atlas/documents/quarterly/capabilities", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant-id": "atlas" },
    body: safeStringify({ expiresAt: 10100 }),
  });
  const capability = safeParse(issue.body);
  const query = new SafeSearchParams({ expiresAt: String(capability.expiresAt), signature: capability.signature }).toString();
  const observations = {
    issue,
    capability,
    valid: await request(base, "/tenants/atlas/documents/quarterly/download?" + query, { headers: { "x-tenant-id": "atlas" } }),
    tenantMismatch: await request(base, "/tenants/atlas/documents/quarterly/download?" + query, { headers: { "x-tenant-id": "boreal" } }),
    crossTenant: await request(base, "/tenants/boreal/documents/quarterly/download?" + query, { headers: { "x-tenant-id": "boreal" } }),
    documentReplay: await request(base, "/tenants/atlas/documents/appendix/download?" + query, { headers: { "x-tenant-id": "atlas" } }),
    expiryReplay: await request(base, "/tenants/atlas/documents/quarterly/download?" + new SafeSearchParams({ expiresAt: "10101", signature: capability.signature }), { headers: { "x-tenant-id": "atlas" } }),
  };
  clock.set(10100);
  observations.expiresAtEquality = await request(base, "/tenants/atlas/documents/quarterly/download?" + query, { headers: { "x-tenant-id": "atlas" } });
  clock.set(10000);
  observations.malformedExpiry = [];
  for (const expiresAt of ["010100", "10100.0", "-1", "9007199254740992", ""]) {
    const malformed = new SafeSearchParams({ expiresAt, signature: capability.signature });
    observations.malformedExpiry.push(await request(base, "/tenants/atlas/documents/quarterly/download?" + malformed, { headers: { "x-tenant-id": "atlas" } }));
  }
  observations.malformedSignature = [];
  for (const signature of ["", "not-hex", capability.signature.toUpperCase(), capability.signature.slice(1)]) {
    const malformed = new SafeSearchParams({ expiresAt: "10100", signature });
    observations.malformedSignature.push(await request(base, "/tenants/atlas/documents/quarterly/download?" + malformed, { headers: { "x-tenant-id": "atlas" } }));
  }
  await new Promise((resolve) => server.close(resolve));
  send({ type: "probeResult", observations });
} catch (error) {
  try { await new Promise((resolve) => server.close(resolve)); } catch {}
  send({ type: "probeError", error: errorValue(error) });
  process.exitCode = 1;
}
`;

class CandidateWorker {
  constructor() {
    this.nonce = randomBytes(24).toString("hex");
    this.prefix = `HARBOR_WORKER_${this.nonce} `;
    this.inbox = [];
    this.waiters = [];
    const source = WORKER_SOURCE.replace("__NONCE__", this.nonce);
    this.child = spawn(process.execPath, ["--input-type=module"], {
      cwd: APP_DIR,
      env: { PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8", HARBOR_APP_DIR: APP_DIR },
      stdio: ["pipe", "ignore", "ignore", "ignore", "pipe"],
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
    const index = this.waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) this.inbox.push(message);
    else {
      const [{ resolve, timer }] = this.waiters.splice(index, 1);
      clearTimeout(timer);
      resolve(message);
    }
  }

  #fail(error) {
    for (const { reject, timer } of this.waiters.splice(0)) {
      clearTimeout(timer);
      reject(error);
    }
  }

  wait(predicate, timeout = 15_000) {
    const index = this.inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((entry) => entry.resolve === resolve);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("candidate worker timed out"));
      }, timeout);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  stop() { this.child.kill("SIGKILL"); }
}

function errorBody(code, message) {
  return JSON.stringify({ error: code, message });
}

function assertInvalid(observation, expectedBody) {
  assert.equal(observation.status, 403);
  assert.equal(observation.contentType, "application/json; charset=utf-8");
  assert.equal(observation.body, expectedBody);
  for (const documentBytes of [ATLAS_BYTES, BOREAL_BYTES, OTHER_BYTES]) {
    assert.equal(observation.body.includes(documentBytes), false);
  }
}

async function runContract() {
  const worker = new CandidateWorker();
  try {
    const message = await worker.wait((value) => value.type === "probeResult" || value.type === "probeError");
    assert.equal(message.type, "probeResult");
    const result = message.observations;
    assert.equal(result.issue.status, 201);
    assert.equal(result.issue.contentType, "application/json; charset=utf-8");
    assert.equal(result.capability.expiresAt, 10_100);
    assert.match(result.capability.signature, /^[0-9a-f]{64}$/);

    assert.equal(result.valid.status, 200);
    assert.equal(result.valid.contentType, "text/plain; charset=utf-8");
    assert.equal(result.valid.contentDisposition, 'attachment; filename="atlas-hidden.txt"');
    assert.equal(result.valid.contentLength, String(Buffer.byteLength(ATLAS_BYTES)));
    assert.equal(result.valid.body, ATLAS_BYTES);

    assertInvalid(result.tenantMismatch, errorBody("tenant_mismatch", "Authenticated tenant does not match the route"));
    const invalidCapability = errorBody("invalid_capability", "The download capability is invalid");
    assertInvalid(result.crossTenant, invalidCapability);
    assertInvalid(result.documentReplay, invalidCapability);
    assertInvalid(result.expiryReplay, invalidCapability);
    assertInvalid(result.expiresAtEquality, errorBody("expired_capability", "The download capability has expired"));
    for (const observation of result.malformedExpiry) assertInvalid(observation, invalidCapability);
    for (const observation of result.malformedSignature) assertInvalid(observation, invalidCapability);
    return true;
  } finally {
    worker.stop();
  }
}

let functional = false;
try {
  functional = await runContract();
} catch {
  functional = false;
}
console.log(`HARBOR_TRUSTED_SIGNED_DOWNLOADS ${JSON.stringify({ functional })}`);
