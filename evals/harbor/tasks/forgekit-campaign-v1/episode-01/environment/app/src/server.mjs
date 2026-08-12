import { createApplication } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
const nowMs = process.env.NOW_MS === undefined ? Date.now() : Number(process.env.NOW_MS);
const app = createApplication({ nowMs: () => nowMs });
const server = app.server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`listening on ${address.port}`);
});
