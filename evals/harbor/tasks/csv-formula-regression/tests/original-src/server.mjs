import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

const RECORDS = [
  ["Ada", "ada@example.test", "Quarterly, reviewer"],
  ["Equals", "equals@example.test", "=2+3"],
  ["Plus", "plus@example.test", "+SUM(1,1)"],
  ["Minus", "minus@example.test", "-10+20"],
  ["At", "at@example.test", "@SUM(1:2)"],
  ["Safe", "safe@example.test", "reference=2+3"]
];

function csvCell(value) {
  const cell = String(value);
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

function exportCsv() {
  return [
    ["name", "email", "note"],
    ...RECORDS
  ].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function createServer() {
  return createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/export.csv") {
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      response.end(exportCsv());
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
