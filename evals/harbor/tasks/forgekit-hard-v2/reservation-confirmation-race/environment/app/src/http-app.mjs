import http from "node:http";
import { ReservationError } from "./errors.mjs";

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
    throw new ReservationError("invalid_json", "Request body must be JSON", 400);
  }
}

export function createHttpServer({ confirmationService, reservationStore }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://reservation.local");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("reservation-service\n");
        return;
      }
      const match = /^\/reservations\/([^/]+)(\/confirm)?$/.exec(url.pathname);
      if (match && request.method === "GET" && !match[2]) {
        sendJson(response, 200, reservationStore.get(decodeURIComponent(match[1])));
        return;
      }
      if (match && request.method === "POST" && match[2]) {
        const body = await readJson(request);
        const result = await confirmationService.confirm(
          decodeURIComponent(match[1]),
          request.headers["idempotency-key"] ?? body.idempotencyKey
        );
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ReservationError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });
}
