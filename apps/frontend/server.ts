import { createServer } from "node:http";
import next from "next";
import { loadEnvFile, loadFrontendConfig } from "@scriptoria/config";

/**
 * The frontend's entrypoint.
 *
 * Unlike the control plane's (ADR-007) there is nothing unusual here: no
 * WebSocket, no upgrade handler, no privileged connection of any kind. It
 * exists so that both web tiers are started the same way and read their
 * configuration through the same schema — the frontend holds the session cookie
 * and proxies, and that is all it is trusted with.
 */
loadEnvFile();
const config = loadFrontendConfig();

const dev = config.NODE_ENV !== "production";
const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(config.FRONTEND_PORT, () => {
  console.log(`frontend on :${config.FRONTEND_PORT} (${dev ? "development" : "production"})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void app.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
