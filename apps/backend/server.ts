import { createServer } from "node:http";
import next from "next";
import { loadBackendConfig, loadEnvFile } from "@scriptoria/config";
import { handleUpgrade } from "./src/lib/stream/gateway";
import { closeDb } from "./src/lib/db/client";
import { closeRedis } from "./src/lib/redis";

/**
 * ADR-007 — the backend is a Next.js application served through a custom Node
 * server.
 *
 * The reason is one line long: a Next.js route handler cannot hold a WebSocket
 * open for the life of a run, and the terminal is the product's critical path.
 * Everything else here is ordinary — Next.js handles every HTTP request exactly
 * as it would on its own; the only thing this file adds is an `upgrade`
 * listener that the framework has no place for.
 *
 * The alternative was a second service just for the socket. That would have
 * meant a second deployment unit, a second place to configure TLS and a second
 * thing to get the session cookie to, in exchange for avoiding thirty lines.
 */

loadEnvFile();
const config = loadBackendConfig();

const dev = config.NODE_ENV !== "production";
const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((request, response) => {
  void handle(request, response);
});

server.on("upgrade", (request, socket, head) => {
  // Anything that is not the terminal path gets its socket destroyed rather
  // than left hanging. Next.js's own HMR socket in development is the one
  // exception, and it arrives on a different path that it handles itself.
  if (!handleUpgrade(request, socket, head)) {
    if (dev && request.url?.startsWith("/_next")) return;
    socket.destroy();
  }
});

server.listen(config.BACKEND_PORT, () => {
  console.log(
    `control plane on :${config.BACKEND_PORT} (${dev ? "development" : "production"})`,
  );
});

/**
 * A shutdown closes the HTTP listener and the pools, and nothing else. It does
 * NOT try to stop running scripts: the PTYs belong to the runner, and a control
 * plane restart that killed them would be the exact failure the runner was
 * separated out to prevent.
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} — shutting down`);

    server.close(() => {
      void Promise.allSettled([closeDb(), closeRedis(), app.close()]).then(() => process.exit(0));
    });

    // A client sitting on an open terminal would otherwise hold the process
    // open indefinitely, which turns a deploy into a hang.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
