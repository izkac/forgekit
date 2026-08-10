import { createApplication } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
const { server } = createApplication();
server.listen(port, "0.0.0.0", () => {
  console.log(`tenant document service listening on ${port}`);
});
