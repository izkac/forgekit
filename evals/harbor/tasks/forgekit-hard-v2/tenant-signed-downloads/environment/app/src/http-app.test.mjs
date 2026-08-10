import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock } from "./clock.mjs";
import { CapabilityService } from "./capability-service.mjs";
import { MemoryTenantDocumentStore } from "./document-store.mjs";
import { createHttpServer } from "./http-app.mjs";

const signingKeys = new Map([
  ["tenant-a", "fixed-shared-test-key"],
  ["tenant-b", "fixed-shared-test-key"]
]);

function fixture() {
  const clock = new ManualClock(5_000);
  const documentStore = new MemoryTenantDocumentStore([
    {
      tenantId: "tenant-a",
      id: "shared-report",
      bytes: Buffer.from([0, 1, 2, 250, 255]),
      contentType: "application/octet-stream",
      fileName: "quarterly.bin"
    },
    {
      tenantId: "tenant-b",
      id: "shared-report",
      bytes: Buffer.from("private beta bytes"),
      contentType: "text/plain; charset=utf-8",
      fileName: "beta.txt"
    }
  ]);
  const capabilityService = new CapabilityService({ clock, signingKeys });
  const server = createHttpServer({ capabilityService, documentStore });
  return { clock, documentStore, capabilityService, server };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTP issues a same-tenant capability and preserves document bytes and headers", async () => {
  const { server } = fixture();
  const baseUrl = await listen(server);
  try {
    const issueResponse = await fetch(`${baseUrl}/tenants/tenant-a/documents/shared-report/capabilities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": "tenant-a"
      },
      body: JSON.stringify({ expiresAt: 5_100 })
    });
    assert.equal(issueResponse.status, 201);
    const capability = await issueResponse.json();

    const query = new URLSearchParams({
      expiresAt: String(capability.expiresAt),
      signature: capability.signature
    });
    const downloadResponse = await fetch(`${baseUrl}/tenants/tenant-a/documents/shared-report/download?${query}`, {
      headers: { "x-tenant-id": "tenant-a" }
    });

    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "application/octet-stream");
    assert.equal(downloadResponse.headers.get("content-disposition"), 'attachment; filename="quarterly.bin"');
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), Buffer.from([0, 1, 2, 250, 255]));
  } finally {
    await close(server);
  }
});

test("HTTP rejects an authenticated tenant that differs from the route tenant", async () => {
  const { server } = fixture();
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/tenants/tenant-b/documents/shared-report/capabilities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": "tenant-a"
      },
      body: JSON.stringify({ expiresAt: 5_100 })
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "tenant_mismatch",
      message: "Authenticated tenant does not match the route"
    });
  } finally {
    await close(server);
  }
});

test("HTTP rejects malformed capability input without returning document bytes", async () => {
  const { capabilityService, server } = fixture();
  const capability = capabilityService.issue({
    tenantId: "tenant-a",
    documentId: "shared-report",
    expiresAt: 5_100
  });
  const baseUrl = await listen(server);
  try {
    for (const malformedExpiry of [
      `${capability.expiresAt}trailing`,
      "0x13ec",
      "5.1e3",
      " 5100 ",
      "05100",
      "+5100"
    ]) {
      const query = new URLSearchParams({
        expiresAt: malformedExpiry,
        signature: capability.signature
      });
      const response = await fetch(`${baseUrl}/tenants/tenant-a/documents/shared-report/download?${query}`, {
        headers: { "x-tenant-id": "tenant-a" }
      });

      assert.equal(response.status, 403, `accepted malformed expiry ${JSON.stringify(malformedExpiry)}`);
      assert.match(response.headers.get("content-type"), /^application\/json/);
      const body = await response.json();
      assert.equal(body.error, "invalid_capability");
      assert.equal(JSON.stringify(body).includes("private beta bytes"), false);
    }
  } finally {
    await close(server);
  }
});
