import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock } from "./clock.mjs";
import { CapabilityService } from "./capability-service.mjs";

const signingKeys = new Map([
  ["tenant-a", "fixed-shared-test-key"],
  ["tenant-b", "fixed-shared-test-key"]
]);

test("an unchanged document capability verifies and a different document is rejected", () => {
  const service = new CapabilityService({
    clock: new ManualClock(1_000),
    signingKeys
  });
  const capability = service.issue({
    tenantId: "tenant-a",
    documentId: "document-17",
    expiresAt: 1_100
  });

  assert.equal(service.verify({
    tenantId: "tenant-a",
    documentId: "document-17",
    ...capability
  }), true);
  assert.throws(
    () => service.verify({
      tenantId: "tenant-a",
      documentId: "document-18",
      ...capability
    }),
    (error) => error.code === "invalid_capability"
  );
});

test("expiry is an integer deadline and malformed capabilities fail closed", () => {
  const clock = new ManualClock(2_000);
  const service = new CapabilityService({ clock, signingKeys });

  const expired = service.issue({
    tenantId: "tenant-a",
    documentId: "document-17",
    expiresAt: 2_000
  });
  assert.throws(
    () => service.verify({
      tenantId: "tenant-a",
      documentId: "document-17",
      ...expired
    }),
    (error) => error.code === "expired_capability"
  );

  for (const malformed of [
    { expiresAt: "2100", signature: expired.signature },
    { expiresAt: Number.NaN, signature: expired.signature },
    { expiresAt: 2_100, signature: "not-hex" }
  ]) {
    assert.throws(
      () => service.verify({
        tenantId: "tenant-a",
        documentId: "document-17",
        ...malformed
      }),
      (error) => error.code === "invalid_capability"
    );
  }
});
