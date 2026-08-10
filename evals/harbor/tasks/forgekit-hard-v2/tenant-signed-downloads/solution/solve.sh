#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-/app}
cat > "$app_dir/src/capability-service.mjs" <<'EOF_SERVICE'
import { createHmac, timingSafeEqual } from "node:crypto";

import { DocumentError } from "./errors.mjs";

function frame(value) {
  const text = String(value);
  return `${Buffer.byteLength(text, "utf8")}:${text}`;
}

function payload(tenantId, documentId, expiresAt) {
  return `${frame(tenantId)}${frame(documentId)}${frame(expiresAt)}`;
}

export class CapabilityService {
  constructor({ clock, signingKeys }) {
    this.clock = clock;
    this.signingKeys = signingKeys;
  }

  issue({ tenantId, documentId, expiresAt }) {
    return { expiresAt, signature: this.#signature(tenantId, documentId, expiresAt) };
  }

  verify({ tenantId, documentId, expiresAt, signature }) {
    if (!Number.isSafeInteger(expiresAt)) {
      throw new DocumentError("invalid_capability", "The download capability is invalid", 403);
    }
    if (this.clock.now() >= expiresAt) {
      throw new DocumentError("expired_capability", "The download capability has expired", 403);
    }
    const expected = Buffer.from(this.#signature(tenantId, documentId, expiresAt), "hex");
    const presented = typeof signature === "string" && /^[0-9a-f]{64}$/.test(signature)
      ? Buffer.from(signature, "hex")
      : Buffer.alloc(0);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new DocumentError("invalid_capability", "The download capability is invalid", 403);
    }
    return true;
  }

  #signature(tenantId, documentId, expiresAt) {
    const key = this.signingKeys.get(tenantId);
    if (typeof key !== "string") {
      throw new DocumentError("unknown_tenant", "The tenant is not configured", 404);
    }
    return createHmac("sha256", key).update(payload(tenantId, documentId, expiresAt)).digest("hex");
  }
}
EOF_SERVICE
cat > "$app_dir/src/tenant-isolation.test.mjs" <<'EOF_TEST'
import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock } from "./clock.mjs";
import { CapabilityService } from "./capability-service.mjs";
import { MemoryTenantDocumentStore } from "./document-store.mjs";
import { createHttpServer } from "./http-app.mjs";

const sharedKey = "tenant-isolation-shared-key";

test("a capability issued for one tenant cannot download the colliding document of another tenant", async () => {
  const capabilityService = new CapabilityService({
    clock: new ManualClock(10_000),
    signingKeys: new Map([["atlas", sharedKey], ["boreal", sharedKey]]),
  });
  const documentStore = new MemoryTenantDocumentStore([
    { tenantId: "atlas", id: "same", bytes: Buffer.from("atlas bytes\n"), contentType: "text/plain", fileName: "atlas.txt" },
    { tenantId: "boreal", id: "same", bytes: Buffer.from("boreal secret bytes\n"), contentType: "text/plain", fileName: "boreal.txt" },
  ]);
  const server = createHttpServer({ capabilityService, documentStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const issued = await fetch(`${base}/tenants/atlas/documents/same/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": "atlas" },
      body: JSON.stringify({ expiresAt: 10_100 }),
    });
    assert.equal(issued.status, 201);
    const capability = await issued.json();
    const query = new URLSearchParams(capability);
    const replay = await fetch(`${base}/tenants/boreal/documents/same/download?${query}`, {
      headers: { "x-tenant-id": "boreal" },
    });
    const body = await replay.text();
    assert.equal(replay.status, 403);
    assert.deepEqual(JSON.parse(body), {
      error: "invalid_capability",
      message: "The download capability is invalid",
    });
    assert.notEqual(body, "boreal secret bytes\n");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
EOF_TEST
