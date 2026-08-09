#!/bin/sh

set -eu

node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const appDir = process.env.HARBOR_APP_DIR || "/app";
const serverPath = `${appDir}/src/server.mjs`;
let server = readFileSync(serverPath, "utf8");
server = server.replace(
  "const orders = createOrderService({ orderStore });",
  "const orders = createOrderService({ orderStore, auditSink });"
);
writeFileSync(serverPath, server);

writeFileSync(`${appDir}/src/audit.test.mjs`, `import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createServer } from "./server.mjs";

const effects = [];
const orderStore = {
  async save(input) {
    effects.push(["persist", input]);
    return { id: "order-test", ...input };
  }
};
const auditSink = {
  async append(entry) {
    effects.push(["audit", entry]);
  }
};
const server = createServer({ orderStore, auditSink });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

test("POST /orders persists before writing the auditSink entry", async () => {
  const response = await fetch(\`http://127.0.0.1:\${port}/orders\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "blue-widget", quantity: 2 })
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    id: "order-test", sku: "blue-widget", quantity: 2
  });
  assert.deepEqual(effects, [
    ["persist", { sku: "blue-widget", quantity: 2 }],
    ["audit", { action: "order.created", orderId: "order-test", sku: "blue-widget" }]
  ]);
});
`);
NODE
