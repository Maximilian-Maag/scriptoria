import { createServer } from "node:http";
import next from "next";
import { loadBackendConfig, loadEnvFile } from "@scriptoria/config";
import { handleUpgrade } from "./src/lib/stream/gateway";
import { startDispatchSweep } from "./src/lib/services/runDispatch";
import { startRetentionSweep } from "./src/lib/services/runRetention";
import { closeDb } from "@scriptoria/db";
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
 * O-7 / ADR-013 — the dispatch sweep.
 *
 * Started after the listener so a slow first sweep cannot delay the health check,
 * and it is the only thing that starts a queued run whose script VM was busy when
 * somebody asked for it. Runs queued while this process was down are dispatched
 * by its first pass.
 */
const stopDispatchSweep = startDispatchSweep();

/**
 * O-5 / ADR-014 — the transcript retention sweep.
 *
 * Hours apart, and its first pass is the one that matters: a database that has been
 * collecting transcripts without this gets its window applied as the process comes
 * up, rather than one interval later. Nothing else about a run is touched — the
 * record, its events and the audit trail stay.
 */
const stopRetentionSweep = startRetentionSweep();

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

    // Only the sweep stops. A queued run is dispatched when a script VM frees up,
    // and a control plane that is going away is not going to be the one to do it —
    // the next process dispatches it on boot.
    stopDispatchSweep();
    stopRetentionSweep();

    server.close(() => {
      void Promise.allSettled([closeDb(), closeRedis(), app.close()]).then(() => process.exit(0));
    });

    // A client sitting on an open terminal would otherwise hold the process
    // open indefinitely, which turns a deploy into a hang.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
