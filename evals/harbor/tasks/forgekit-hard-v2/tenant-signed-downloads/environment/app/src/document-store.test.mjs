import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryTenantDocumentStore } from "./document-store.mjs";

test("documents with the same id remain scoped to their tenant", () => {
  const store = new MemoryTenantDocumentStore([
    {
      tenantId: "tenant-a",
      id: "shared-report",
      bytes: Buffer.from("alpha report"),
      contentType: "text/plain; charset=utf-8",
      fileName: "alpha.txt"
    },
    {
      tenantId: "tenant-b",
      id: "shared-report",
      bytes: Buffer.from("beta report"),
      contentType: "text/plain; charset=utf-8",
      fileName: "beta.txt"
    }
  ]);

  assert.equal(store.get("tenant-a", "shared-report").bytes.toString(), "alpha report");
  assert.equal(store.get("tenant-b", "shared-report").bytes.toString(), "beta report");
  assert.throws(
    () => store.get("tenant-a", "missing"),
    (error) => error.code === "document_not_found"
  );
});
