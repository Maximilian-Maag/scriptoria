import Redis from "ioredis";
import { loadRunnerConfig } from "@scriptoria/config";
import { redisKeys } from "@scriptoria/contracts";

/**
 * The runner's three kinds of Redis connection, and the reason there are three.
 *
 * A connection in subscriber mode cannot issue ordinary commands, and a
 * connection sitting in a blocking `BRPOP` cannot either — so the consumer, the
 * per-run stdin subscribers and everything else each get their own. Sharing one
 * works right up until the first keystroke, and then fails in a way that looks
 * like a dead terminal.
 */

let commands: Redis | undefined;

export function redis(): Redis {
  if (!commands) {
    commands = new Redis(loadRunnerConfig().REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return commands;
}

/**
 * A connection of its own, for anything that blocks: the queue consumer, the
 * RPC consumer, and every per-run subscriber.
 *
 * `maxRetriesPerRequest: null` because a blocking read that has been waiting
 * quietly for ten minutes is working, not stuck, and must not be failed by a
 * retry counter.
 */
export function blockingConnection(): Redis {
  return new Redis(loadRunnerConfig().REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis(): Promise<void> {
  await commands?.quit();
  commands = undefined;
}

export const keys = redisKeys;
