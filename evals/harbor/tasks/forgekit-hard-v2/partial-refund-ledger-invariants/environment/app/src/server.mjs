import { createApplication } from "./app.mjs";

const app = createApplication();
const port = Number(process.env.PORT ?? 3000);
app.server.listen(port, "0.0.0.0", () => {
  console.log(`refund-service listening on ${port}`);
});
