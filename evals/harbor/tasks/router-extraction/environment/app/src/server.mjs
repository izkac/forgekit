import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

function sendText(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createServer() {
  return createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      sendText(response, 200, "router-fixture\n");
      return;
    }

    if (request.method === "GET" && request.url === "/status") {
      sendJson(response, 200, { status: "ready" });
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
