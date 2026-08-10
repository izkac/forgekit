import http from "node:http";

import { DocumentError } from "./errors.mjs";

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DocumentError("invalid_request", "Request body must be JSON", 400);
  }
}

function requireTenant(request, routeTenant) {
  const authenticatedTenant = request.headers["x-tenant-id"];
  if (typeof authenticatedTenant !== "string" || authenticatedTenant !== routeTenant) {
    throw new DocumentError("tenant_mismatch", "Authenticated tenant does not match the route", 403);
  }
}

function attachmentName(fileName) {
  return fileName.replace(/["\\\r\n]/g, "_");
}

function parseExpiresAt(searchParams) {
  const rawExpiresAt = searchParams.get("expiresAt");
  if (typeof rawExpiresAt !== "string" || !/^(?:0|[1-9]\d*)$/.test(rawExpiresAt)) {
    throw new DocumentError("invalid_capability", "The download capability is invalid", 403);
  }
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAt)) {
    throw new DocumentError("invalid_capability", "The download capability is invalid", 403);
  }
  return expiresAt;
}

export function createHttpServer({ capabilityService, documentStore }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://documents.local");
      const match = /^\/tenants\/([^/]+)\/documents\/([^/]+)\/(capabilities|download)$/.exec(url.pathname);
      if (!match) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const tenantId = decodeURIComponent(match[1]);
      const documentId = decodeURIComponent(match[2]);
      requireTenant(request, tenantId);

      if (request.method === "POST" && match[3] === "capabilities") {
        const body = await readJson(request);
        if (!Number.isSafeInteger(body.expiresAt)) {
          throw new DocumentError("invalid_request", "expiresAt must be an integer", 400);
        }
        documentStore.get(tenantId, documentId);
        sendJson(response, 201, capabilityService.issue({ tenantId, documentId, expiresAt: body.expiresAt }));
        return;
      }

      if (request.method === "GET" && match[3] === "download") {
        const expiresAt = parseExpiresAt(url.searchParams);
        const signature = url.searchParams.get("signature");
        capabilityService.verify({ tenantId, documentId, expiresAt, signature });
        const document = documentStore.get(tenantId, documentId);
        response.writeHead(200, {
          "content-type": document.contentType,
          "content-disposition": `attachment; filename="${attachmentName(document.fileName)}"`,
          "content-length": document.bytes.length
        });
        response.end(document.bytes);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DocumentError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });
}
