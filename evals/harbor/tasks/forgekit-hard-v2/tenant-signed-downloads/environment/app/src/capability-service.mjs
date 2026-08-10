import { createHmac, timingSafeEqual } from "node:crypto";

import { DocumentError } from "./errors.mjs";

function frame(value) {
  const text = String(value);
  return `${Buffer.byteLength(text, "utf8")}:${text}`;
}

function payload(documentId, expiresAt) {
  return `${frame(documentId)}${frame(expiresAt)}`;
}

export class CapabilityService {
  constructor({ clock, signingKeys }) {
    this.clock = clock;
    this.signingKeys = signingKeys;
  }

  issue({ tenantId, documentId, expiresAt }) {
    return {
      expiresAt,
      signature: this.#signature(tenantId, documentId, expiresAt)
    };
  }

  verify({ tenantId, documentId, expiresAt, signature }) {
    if (!Number.isSafeInteger(expiresAt)) {
      throw new DocumentError("invalid_capability", "The download capability is invalid", 403);
    }
    if (this.clock.now() >= expiresAt) {
      throw new DocumentError("expired_capability", "The download capability has expired", 403);
    }
    const expected = this.#signature(tenantId, documentId, expiresAt);
    const presented = typeof signature === "string" && /^[0-9a-f]{64}$/.test(signature)
      ? Buffer.from(signature, "hex")
      : Buffer.alloc(0);
    const expectedBytes = Buffer.from(expected, "hex");
    if (presented.length !== expectedBytes.length || !timingSafeEqual(presented, expectedBytes)) {
      throw new DocumentError("invalid_capability", "The download capability is invalid", 403);
    }
    return true;
  }

  #signature(tenantId, documentId, expiresAt) {
    const key = this.signingKeys.get(tenantId);
    if (typeof key !== "string") {
      throw new DocumentError("unknown_tenant", "The tenant is not configured", 404);
    }
    return createHmac("sha256", key).update(payload(documentId, expiresAt)).digest("hex");
  }
}
