import http from "node:http";
import { CarrierEventError } from "./errors.mjs";

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) throw new CarrierEventError("malformed_event", "Request body must be JSON");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CarrierEventError("malformed_event", "Request body must be JSON");
  }
}

export function createHttpServer({ reconciliationService }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://carrier.local");
      const webhookMatch = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && webhookMatch) {
        const carrier = decodeURIComponent(webhookMatch[1]);
        const payload = await readJson(request);
        const result = await reconciliationService.reconcile(carrier, payload);
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof CarrierEventError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });
}
