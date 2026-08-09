import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

const ROOT_BODY = "node-health-fixture\n";

export function createServer() {
  return createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8"
      });
      response.end(ROOT_BODY);
      return;
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8"
    });
    response.end("Not found\n");
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
