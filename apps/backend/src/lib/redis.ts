import Redis from "ioredis";
import { loadBackendConfig } from "@scriptoria/config";
import { redisKeys } from "@scriptoria/contracts";

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

/**
 * A fresh connection, for anything that will block: subscriber mode, `XREAD` on
 * a run's stream, or a `BLPOP` waiting for the runner to answer.
 *
 * `maxRetriesPerRequest: null` because a blocking read that has been waiting
 * quietly for a minute is working, not stuck, and must not be failed by a retry
 * counter.
 */
export function blockingConnection(): Redis {
  return new Redis(loadBackendConfig().REDIS_URL, { maxRetriesPerRequest: null });
}

/** The gateway's name for the same thing: a connection that will only listen. */
export const redisSubscriber = blockingConnection;

export async function closeRedis(): Promise<void> {
  await commands?.quit();
  commands = undefined;
}

// ── Key layout ───────────────────────────────────────────────────────────────
// Owned by @scriptoria/contracts, because the runner writes to half of these
// keys and reads the other half. Two processes agreeing on a string is a
// contract whether or not anybody writes it down.

export const keys = redisKeys;
