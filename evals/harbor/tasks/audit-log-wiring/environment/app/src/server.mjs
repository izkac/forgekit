import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createMemoryAuditSink, createMemoryOrderStore } from "./adapters.mjs";
import { createOrderService } from "./order-service.mjs";

const ROOT_BODY = "audit-wiring-fixture\n";

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendText(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createServer({
  orderStore = createMemoryOrderStore(),
  auditSink = createMemoryAuditSink()
} = {}) {
  // The HTTP integration accidentally omitted one of the service's adapters.
  void auditSink;
  const orders = createOrderService({ orderStore });

  return createHttpServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      sendText(response, 200, ROOT_BODY);
      return;
    }

    if (request.method === "POST" && request.url === "/orders") {
      let input;
      try {
        input = await readJson(request);
      } catch {
        sendJson(response, 400, { error: "Invalid JSON" });
        return;
      }
      if (!input || typeof input.sku !== "string" || input.sku.length === 0
          || !Number.isInteger(input.quantity) || input.quantity < 1) {
        sendJson(response, 400, { error: "Invalid order" });
        return;
      }
      try {
        const order = await orders.create(input);
        sendJson(response, 201, order);
      } catch {
        sendJson(response, 500, { error: "Could not create order" });
      }
      return;
    }

    sendText(response, 404, "Not found\n");
  });
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const server = createServer();
  server.listen(port, "0.0.0.0");
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
