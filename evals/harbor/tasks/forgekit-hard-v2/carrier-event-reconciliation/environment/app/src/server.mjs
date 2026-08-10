import { createApplication } from "./app.mjs";

const application = createApplication();
const port = Number(process.env.PORT ?? 3000);
application.server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`carrier reconciliation listening on ${port}\n`);
});
