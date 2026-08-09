import { createApplication } from "./app.mjs";

const { server } = createApplication();
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`reservation service listening on ${port}`);
});
