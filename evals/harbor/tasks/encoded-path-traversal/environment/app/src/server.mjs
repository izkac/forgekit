import { readFile } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

function decodePath(rawPath) {
  let decoded = rawPath;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  return decoded;
}

export function createServer() {
  return createHttpServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    const rawPath = (request.url || "/").split(/[?#]/, 1)[0];
    const decodedPath = decodePath(rawPath).replaceAll("\\", "/");
    const relativePath = decodedPath.startsWith("/") ? decodedPath.slice(1) : decodedPath;
    const filePath = path.resolve(PUBLIC_DIR, relativePath);

    readFile(filePath, (error, body) => {
      if (error) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(body);
    });
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
