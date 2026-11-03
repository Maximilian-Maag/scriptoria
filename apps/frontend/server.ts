import { createServer } from "node:http";
import next from "next";
import { loadEnvFile, loadFrontendConfig } from "@scriptoria/config";
import { clientAddressFor } from "./src/lib/http/clientAddress";

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
  // FA-12.1's "where" is settled here, before Next sees the request, because
  // this is the last point at which the socket the request arrived on is still
  // visible. `x-forwarded-for` is *replaced* rather than forwarded: the proxy
  // route and the control plane behind it can only read headers, so whatever is
  // left here is what the audit trail records, and a client-supplied value is not
  // an address. `x-real-ip` is dropped for the same reason — nothing sets it in
  // this deployment, and anything that arrives on it was written by the caller.
  const clientAddress = clientAddressFor(
    request.headers["x-forwarded-for"],
    request.socket.remoteAddress,
    { trustedReverseProxy: config.TRUSTED_REVERSE_PROXY },
  );
  if (clientAddress === null) delete request.headers["x-forwarded-for"];
  else request.headers["x-forwarded-for"] = clientAddress;
  delete request.headers["x-real-ip"];

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
