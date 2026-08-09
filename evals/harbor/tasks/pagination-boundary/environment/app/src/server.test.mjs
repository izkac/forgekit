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

/* BEGIN PRE-EXISTING VISIBLE TEST */
test("root, first page, validation, and missing routes remain stable", async () => {
  const root = await fetch(`${baseURL}/`);
  assert.equal(root.status, 200);
  assert.equal(await root.text(), "pagination-fixture\n");

  const first = await fetch(`${baseURL}/items?page=1`);
  assert.equal(first.status, 200);
  const payload = await first.json();
  assert.deepEqual(payload.items.map(({ id }) => id), [1, 2, 3]);
  assert.equal(payload.page, 1);
  assert.equal(payload.pageSize, 3);
  assert.equal(payload.totalItems, 6);

  const invalid = await fetch(`${baseURL}/items?page=0`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "page must identify an available positive page"
  });

  const missing = await fetch(`${baseURL}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found\n");
});
/* END PRE-EXISTING VISIBLE TEST */
