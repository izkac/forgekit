#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-/app}
cat > "$app_dir/src/capability-service.mjs" <<'EOF_SERVICE'
import { createHmac, timingSafeEqual } from "node:crypto";

import { DocumentError } from "./errors.mjs";

const invalid = () => new DocumentError("invalid_capability", "The download capability is invalid", 403);

function canonicalTuple(tenantId, documentId, expiresAt) {
  return JSON.stringify([tenantId, documentId, expiresAt]);
}

export class CapabilityService {
  constructor(dependencies) {
    this.clock = dependencies.clock;
    this.keys = dependencies.signingKeys;
  }

  issue(input) {
    return { expiresAt: input.expiresAt, signature: this.#mac(input) };
  }

  verify(input) {
    if (!Number.isSafeInteger(input.expiresAt)) throw invalid();
    if (this.clock.now() >= input.expiresAt) {
      throw new DocumentError("expired_capability", "The download capability has expired", 403);
    }
    if (typeof input.signature !== "string" || !/^[a-f\d]{64}$/.test(input.signature)) throw invalid();
    const supplied = Buffer.from(input.signature, "hex");
    const calculated = Buffer.from(this.#mac(input), "hex");
    if (!timingSafeEqual(supplied, calculated)) throw invalid();
    return true;
  }

  #mac({ tenantId, documentId, expiresAt }) {
    const key = this.keys.get(tenantId);
    if (typeof key !== "string") {
      throw new DocumentError("unknown_tenant", "The tenant is not configured", 404);
    }
    const tuple = canonicalTuple(tenantId, documentId, expiresAt);
    return createHmac("sha256", key).update(tuple, "utf8").digest("hex");
  }
}
EOF_SERVICE
cat > "$app_dir/src/tenant-isolation.test.mjs" <<'EOF_TEST'
import assert from "node:assert/strict";
import { test } from "node:test";

import { CapabilityService } from "./capability-service.mjs";
import { ManualClock } from "./clock.mjs";

const signingKeys = new Map([["tenant/a", "shared-key"], ["tenant:b", "shared-key"]]);

test("canonical capability tuples distinguish tenants sharing a key and colliding document id", () => {
  const service = new CapabilityService({ clock: new ManualClock(700), signingKeys });
  const atlas = service.issue({ tenantId: "tenant/a", documentId: "document:7", expiresAt: 900 });
  const boreal = service.issue({ tenantId: "tenant:b", documentId: "document:7", expiresAt: 900 });
  assert.notEqual(atlas.signature, boreal.signature);
  assert.throws(
    () => service.verify({ tenantId: "tenant:b", documentId: "document:7", ...atlas }),
    (error) => error.code === "invalid_capability" && error.status === 403,
  );
});
EOF_TEST
