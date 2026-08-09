#!/bin/sh

set -eu

node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const appDir = process.env.HARBOR_APP_DIR || "/app";
const serverPath = `${appDir}/src/server.mjs`;
let server = readFileSync(serverPath, "utf8");
const existingRoute = `    if (request.method === "GET" && request.url === "/") {`;
const healthRoute = `    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8"
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

`;

if (!server.includes('request.url === "/health"')) {
  server = server.replace(existingRoute, healthRoute + existingRoute);
  writeFileSync(serverPath, server);
}

const testPath = `${appDir}/src/health.test.mjs`;
const healthTest = `import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createServer } from "./server.mjs";

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

test("health endpoint", async () => {
  const health = await fetch(\`http://127.0.0.1:\${port}/health\`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});
`;
writeFileSync(testPath, healthTest);
NODE
