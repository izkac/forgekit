#!/bin/sh
set -eu

app_dir=${HARBOR_APP_DIR:-/app}
server="$app_dir/src/server.mjs"
node --input-type=module - "$server" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
let source = readFileSync(file, "utf8");
source = source.replace(
  "const totalPages = Math.floor(ITEMS.length / PAGE_SIZE) + 1;",
  "const totalPages = Math.ceil(ITEMS.length / PAGE_SIZE);"
);
writeFileSync(file, source);
NODE

cat > "$app_dir/src/pagination-boundary.test.mjs" <<'NODE'
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

test("an exact multiple has no phantom page", async () => {
  const last = await fetch(`${baseURL}/items?page=2`);
  assert.equal(last.status, 200);
  const payload = await last.json();
  assert.deepEqual(payload.items.map(({ id }) => id), [4, 5, 6]);
  assert.equal(payload.totalPages, 2);

  const beyond = await fetch(`${baseURL}/items?page=3`);
  assert.equal(beyond.status, 400);
  assert.deepEqual(await beyond.json(), {
    error: "page must identify an available positive page"
  });
});
NODE
