#!/bin/sh

set -eu

node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const appDir = process.env.HARBOR_APP_DIR || "/app";
writeFileSync(`${appDir}/src/router.mjs`, `function sendText(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createRouter() {
  return (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      sendText(response, 200, "router-fixture\\n");
      return;
    }

    if (request.method === "GET" && request.url === "/status") {
      sendJson(response, 200, { status: "ready" });
      return;
    }

    if (request.method === "GET") {
      const { pathname } = new URL(request.url, "http://localhost");
      const segments = pathname.split("/");
      if (segments.length === 3 && segments[1] === "items" && segments[2].length > 0) {
        try {
          const itemId = decodeURIComponent(segments[2]);
          if (itemId.length > 0) {
            sendJson(response, 200, { itemId });
            return;
          }
        } catch {
          // Invalid percent encoding is not a route match.
        }
      }
    }

    sendText(response, 404, "Not found\\n");
  };
}
`);

writeFileSync(`${appDir}/src/server.mjs`, `import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createRouter } from "./router.mjs";

export function createServer() {
  return createHttpServer(createRouter());
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const server = createServer();
  server.listen(port, "0.0.0.0");
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
`);

writeFileSync(`${appDir}/src/router.test.mjs`, `import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createServer } from "./server.mjs";

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseURL = \`http://127.0.0.1:\${port}\`;

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

test("GET /items/:itemId routes a percent-decoded parameter", async () => {
  const item = await fetch(\`\${baseURL}/items/blue%20widget\`);
  assert.equal(item.status, 200);
  assert.equal(item.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await item.json(), { itemId: "blue widget" });

  for (const pathname of ["/items", "/items/", "/items/a/b"]) {
    const missing = await fetch(baseURL + pathname);
    assert.equal(missing.status, 404);
  }
});
`);
NODE
