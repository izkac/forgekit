#!/bin/sh

set -eu

app_dir=${HARBOR_APP_DIR:-/app}

cat > "$app_dir/src/server.mjs" <<'NODE'
import { readFile } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

function missing(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
}

function isUnsafePath(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("/") || normalized.startsWith("//") || normalized.includes("\0")) {
    return true;
  }
  const body = normalized.slice(1);
  return /^[A-Za-z]:\//.test(body)
    || body.split("/").some((segment) => segment === "." || segment === "..");
}

function safePublicPath(rawPath) {
  let decoded = rawPath;
  for (let pass = 0; pass < 4; pass += 1) {
    if (isUnsafePath(decoded)) return null;
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      if (pass === 0) return null;
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (isUnsafePath(decoded)) return null;

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const normalized = requestedPath.replaceAll("\\", "/");
  const resolved = path.resolve(PUBLIC_DIR, normalized.slice(1));
  const relative = path.relative(PUBLIC_DIR, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export function createServer() {
  return createHttpServer((request, response) => {
    if (request.method !== "GET") {
      missing(response);
      return;
    }

    const rawPath = (request.url || "/").split(/[?#]/, 1)[0];
    const filePath = safePublicPath(rawPath);
    if (!filePath) {
      missing(response);
      return;
    }

    readFile(filePath, (error, body) => {
      if (error) {
        missing(response);
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(body);
    });
  });
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const server = createServer();
  server.listen(port, "0.0.0.0");
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
NODE

cat > "$app_dir/src/traversal.test.mjs" <<'NODE'
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createServer } from "./server.mjs";

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseURL = `http://127.0.0.1:${port}`;

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

test("encoded and double-encoded traversal cannot read the protected file", async () => {
  const attempts = [
    "/%2e%2e%2fsecret.txt",
    "/%252e%252e%252fsecret.txt"
  ];

  for (const pathname of attempts) {
    const response = await fetch(`${baseURL}${pathname}`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found\n");
  }
});
NODE
