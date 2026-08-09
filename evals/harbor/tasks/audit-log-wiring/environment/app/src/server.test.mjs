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
test("existing root and missing routes remain stable", async () => {
  const root = await fetch(`${baseURL}/`);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await root.text(), "audit-wiring-fixture\n");

  const missing = await fetch(`${baseURL}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await missing.text(), "Not found\n");
});
/* END PRE-EXISTING VISIBLE TEST */
