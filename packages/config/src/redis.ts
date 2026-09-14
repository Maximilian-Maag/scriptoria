import { z } from "zod";
import { intFromEnv } from "./load";

/**
 * Redis does three unrelated jobs (sessions, run streams, the job queue) behind
 * one connection string, so the schema is shared by the backend and the runner
 * rather than duplicated into both.
 */
export const redisSchema = z.object({
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  /**
   * MAXLEN on a run's terminal stream. NFR-09 wants the full run available for
   * scrollback; an unbounded stream wants the whole of Redis. 50 000 entries of
   * PTY chunks is a long run and a bounded memory cost.
   */
  STREAM_MAXLEN: intFromEnv({ min: 1000 }).default(50_000),

  /**
   * How long a finished run's stream survives, so a browser that reconnects
   * after the process exited still gets the tail rather than an empty terminal.
   */
  STREAM_TTL_SECONDS: intFromEnv({ min: 60 }).default(86_400),
});

export type RedisConfig = z.infer<typeof redisSchema>;
