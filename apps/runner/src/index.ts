import { hostname } from "node:os";
import { loadEnvFile, loadRunnerConfig } from "@scriptoria/config";
import { closeDb } from "@scriptoria/db";
import { QueueConsumer } from "./queue/consumer";
import { RpcServer } from "./rpc/server";
import { loadCredentials } from "./ssh/credentials";
import { closeRedis } from "./redis";
import { describeError, log } from "./log";

/**
 * The runner worker.
 *
 * It listens on no port and serves no page — which is the one thing to know
 * about it. It is the only component holding SSH keys and the only one that
 * reaches the script VM, so the boundary in every deployment is drawn around
 * this process rather than around a frontend that holds no credentials at all.
 *
 * It does two jobs: it runs claimed jobs on a PTY, and it answers the control
 * plane's requests to read the script VM's filesystem. Both arrive through
 * Redis, because nothing can connect to it.
 */

loadEnvFile();
const config = loadRunnerConfig();

const workerId = config.RUNNER_ID || `${hostname()}:${process.pid}`;

// Read before anything else starts: a missing key must stop the process now,
// not produce a run that fails five minutes from now with "Permission denied".
loadCredentials();

const consumer = new QueueConsumer(workerId);
const rpc = new RpcServer();

log.info("runner starting", {
  workerId,
  concurrency: config.RUNNER_CONCURRENCY,
  environment: config.NODE_ENV,
});

/**
 * A stray error must not take the PTYs down with it.
 *
 * Node's default for an unhandled error is to end the process — which here
 * means ending every script this worker is running, including one that is
 * partway through modifying hundreds of systems. That is the exact failure the
 * runner was separated into its own process to prevent, and it would be absurd
 * to reintroduce it over a socket that closed in an unusual order.
 *
 * So these are logged at full volume and the worker keeps going. The runs it
 * holds are individually guarded: one that genuinely broke reaches a terminal
 * state through its own error path, and a run whose worker is gone is reaped by
 * the control plane.
 */
process.on("uncaughtException", (cause) => {
  log.error("uncaught exception — worker continuing", {
    error: describeError(cause),
    stack: cause instanceof Error ? cause.stack : undefined,
  });
});

process.on("unhandledRejection", (cause) => {
  log.error("unhandled rejection — worker continuing", { error: describeError(cause) });
});

const work = Promise.all([consumer.start(config.RUNNER_CONCURRENCY), rpc.start()]);

/**
 * Shutdown drains rather than kills.
 *
 * This process exists so that deploying the web tier cannot end a run (ADR-007
 * and the Container view both say so) — and it would be a poor answer to that
 * if deploying *this* tier killed every PTY it held. So a signal stops the
 * worker taking new work and then waits for the scripts it is already running.
 *
 * The wait is bounded: an interactive script blocking on a prompt nobody is
 * going to answer would otherwise hold a deployment open indefinitely.
 */
const DRAIN_TIMEOUT_MS = 5 * 60_000;

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      log.warn("second signal — exiting now", { signal });
      process.exit(1);
    }
    shuttingDown = true;

    log.info(`${signal} — draining`, { activeRuns: consumer.activeRuns });
    consumer.stop();
    rpc.stop();

    const deadline = setTimeout(() => {
      log.warn("drain timed out — exiting with runs still in flight", {
        activeRuns: consumer.activeRuns,
      });
      process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    deadline.unref();

    void work
      .catch((cause: unknown) => log.error("worker stopped", { error: describeError(cause) }))
      .finally(async () => {
        consumer.close();
        rpc.close();
        await Promise.allSettled([closeRedis(), closeDb()]);
        log.info("runner stopped");
        process.exit(0);
      });
  });
}

try {
  await work;
} catch (cause) {
  log.error("runner failed", { error: describeError(cause) });
  process.exit(1);
}
