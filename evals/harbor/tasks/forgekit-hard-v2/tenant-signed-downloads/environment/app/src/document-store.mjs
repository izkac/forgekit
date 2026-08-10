import { DocumentError } from "./errors.mjs";

export class MemoryTenantDocumentStore {
  constructor(documents = []) {
    this.documentsByTenant = new Map();
    for (const document of documents) {
      let tenantDocuments = this.documentsByTenant.get(document.tenantId);
      if (!tenantDocuments) {
        tenantDocuments = new Map();
        this.documentsByTenant.set(document.tenantId, tenantDocuments);
      }
      tenantDocuments.set(document.id, document);
    }
  }

  get(tenantId, documentId) {
    const document = this.documentsByTenant.get(tenantId)?.get(documentId);
    if (!document) {
      throw new DocumentError("document_not_found", "Document not found", 404);
    }
    return document;
  }
}
