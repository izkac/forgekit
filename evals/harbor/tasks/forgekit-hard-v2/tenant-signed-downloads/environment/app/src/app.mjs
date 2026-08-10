import { CapabilityService } from "./capability-service.mjs";
import { SystemClock } from "./clock.mjs";
import { MemoryTenantDocumentStore } from "./document-store.mjs";
import { createHttpServer } from "./http-app.mjs";

export const TENANT_SIGNING_KEYS = new Map([
  ["atlas", "forgekit-fixed-download-key-2026"],
  ["boreal", "forgekit-fixed-download-key-2026"]
]);

export function createApplication({
  clock = new SystemClock(),
  signingKeys = TENANT_SIGNING_KEYS,
  documentStore = new MemoryTenantDocumentStore([
    {
      tenantId: "atlas",
      id: "quarterly-report",
      bytes: Buffer.from("atlas quarterly report\n"),
      contentType: "text/plain; charset=utf-8",
      fileName: "atlas-quarterly.txt"
    },
    {
      tenantId: "boreal",
      id: "quarterly-report",
      bytes: Buffer.from("boreal confidential forecast\n"),
      contentType: "text/plain; charset=utf-8",
      fileName: "boreal-quarterly.txt"
    }
  ])
} = {}) {
  const capabilityService = new CapabilityService({ clock, signingKeys });
  return {
    clock,
    signingKeys,
    documentStore,
    capabilityService,
    server: createHttpServer({ capabilityService, documentStore })
  };
}
