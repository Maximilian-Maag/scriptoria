import Redis from "ioredis";
import { loadBackendConfig } from "@scriptoria/config";

/**
 * Redis does three unrelated jobs here — sessions, the per-run terminal streams
 * and the job queue — and they need different connections.
 *
 * A connection in subscriber mode cannot issue ordinary commands, so the gateway
 * gets its own. Sharing one would work right up until the first stdin keystroke,
 * and then fail in a way that looks like a dead terminal.
 */

let commands: Redis | undefined;

export function redis(): Redis {
  if (!commands) {
    commands = new Redis(loadBackendConfig().REDIS_URL, {
      maxRetriesPerRequest: 3,
      // A run outlives a deploy; a reconnect should be quiet rather than fatal.
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return commands;
}

/** A fresh connection, for anything that will enter subscriber mode. */
export function redisSubscriber(): Redis {
  return new Redis(loadBackendConfig().REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis(): Promise<void> {
  await commands?.quit();
  commands = undefined;
}

// ── Key layout ───────────────────────────────────────────────────────────────
// One namespace, so a `KEYS scriptoria:*` in an incident tells an operator
// everything this platform is holding.

export const keys = {
  session: (id: string) => `scriptoria:session:${id}`,
  /** The capped stream of PTY bytes for one run (ADR-006). */
  runStream: (runId: string) => `scriptoria:run:${runId}:stream`,
  /** Keystrokes, published to whichever worker holds this run's PTY. */
  runStdin: (runId: string) => `scriptoria:run:${runId}:stdin`,
  /** Abort requests, on the same route as stdin and for the same reason. */
  runControl: (runId: string) => `scriptoria:run:${runId}:control`,
  /** The job queue the runner's consumer blocks on. */
  runQueue: "scriptoria:runs:queue",
  /** Set by the worker that claimed a run, so a second one cannot. */
  runClaim: (runId: string) => `scriptoria:run:${runId}:claim`,
} as const;
