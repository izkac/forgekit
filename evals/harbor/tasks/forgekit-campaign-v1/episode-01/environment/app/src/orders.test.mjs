import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(appRoot, "src", "server.mjs")], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port), NOW_MS: "1700000000000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server start timed out"));
    }, 10_000);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (/listening on \d+/.test(stdout)) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(child);
      }
    });
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${stdout}`));
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", onExit);
  });
}

let port;
let serverProcess;

before(async () => {
  port = await freePort();
  serverProcess = await startServer(port);
});

after(() => {
  if (serverProcess) serverProcess.kill("SIGKILL");
});

async function request(method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text.length === 0 ? null : JSON.parse(text);
  return { status: response.status, json };
}

const sampleItems = [
  { sku: "SKU-RED", quantity: 2, unitPriceCents: 400 },
  { sku: "SKU-BLUE", quantity: 1, unitPriceCents: 200 },
];
const sampleTotal = sampleItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

test("creates an order in pending with a computed total", async () => {
  const created = await request("POST", "/orders", { customerId: "cust-visible", items: sampleItems });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "pending");
  assert.equal(created.json.totalCents, sampleTotal);
  assert.equal(created.json.chargedCents, 0);
  assert.equal(created.json.customerId, "cust-visible");
  assert.equal(typeof created.json.id, "string");
  assert.ok(created.json.id.length > 0);
});

test("charges, ships, and delivers along the happy path", async () => {
  const created = await request("POST", "/orders", { customerId: "cust-flow", items: sampleItems });
  const id = created.json.id;

  const charged = await request("POST", `/orders/${id}/charge`, { amountCents: sampleTotal });
  assert.equal(charged.status, 200);
  assert.equal(charged.json.status, "paid");
  assert.equal(charged.json.chargedCents, sampleTotal);

  const shipped = await request("POST", `/orders/${id}/ship`);
  assert.equal(shipped.status, 200);
  assert.equal(shipped.json.status, "shipped");

  const delivered = await request("POST", `/orders/${id}/deliver`);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.json.status, "delivered");
});

test("cancels a pending order", async () => {
  const created = await request("POST", "/orders", { customerId: "cust-cancel", items: sampleItems });
  const cancelled = await request("POST", `/orders/${created.json.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, "cancelled");
});

test("rejects shipping a pending order", async () => {
  const created = await request("POST", "/orders", { customerId: "cust-skip", items: sampleItems });
  const shipped = await request("POST", `/orders/${created.json.id}/ship`);
  assert.equal(shipped.status, 409);
});
