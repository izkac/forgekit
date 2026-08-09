import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

const ITEMS = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  name: `Item ${index + 1}`
}));
const PAGE_SIZE = 3;

function invalidPage(response) {
  response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "page must identify an available positive page" }));
}

export function createServer() {
  return createHttpServer((request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("pagination-fixture\n");
      return;
    }

    if (request.method === "GET" && url.pathname === "/items") {
      const pageText = url.searchParams.get("page") || "1";
      if (!/^[1-9]\d*$/.test(pageText)) {
        invalidPage(response);
        return;
      }

      const page = Number(pageText);
      // BUG: exact multiples get one extra, empty page.
      const totalPages = Math.floor(ITEMS.length / PAGE_SIZE) + 1;
      if (page > totalPages) {
        invalidPage(response);
        return;
      }

      const start = (page - 1) * PAGE_SIZE;
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        items: ITEMS.slice(start, start + PAGE_SIZE),
        page,
        pageSize: PAGE_SIZE,
        totalPages,
        totalItems: ITEMS.length
      }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
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
