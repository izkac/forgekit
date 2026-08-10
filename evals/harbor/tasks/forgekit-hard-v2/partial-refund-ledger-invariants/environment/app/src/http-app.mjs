import http from "node:http";
import { RefundError } from "./errors.mjs";

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RefundError("invalid_json", "Request body must be JSON", 400);
  }
}

export function createHttpServer({ refundService, chargeStore }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://refund.local");
      const chargeMatch = /^\/charges\/([^/]+)$/.exec(url.pathname);
      const refundMatch = /^\/charges\/([^/]+)\/refunds$/.exec(url.pathname);
      if (request.method === "GET" && chargeMatch) {
        const charge = chargeStore.get(decodeURIComponent(chargeMatch[1]));
        if (!charge) throw new RefundError("charge_not_found", "Charge was not found", 404);
        sendJson(response, 200, charge);
        return;
      }
      if (request.method === "POST" && refundMatch) {
        const body = await readJson(request);
        const result = await refundService.refund(
          decodeURIComponent(refundMatch[1]),
          body.amountCents,
          request.headers["idempotency-key"] ?? body.idempotencyKey,
        );
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof RefundError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });
}
