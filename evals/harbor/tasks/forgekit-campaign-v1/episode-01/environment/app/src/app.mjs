import http from "node:http";

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function createApplication() {
  const server = http.createServer(async (_request, response) => {
    sendJson(response, 501, { error: "not_implemented" });
  });
  return { server };
}
