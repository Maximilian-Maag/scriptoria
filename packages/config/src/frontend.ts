import { z } from "zod";
import { defineConfig, intFromEnv } from "./load";
import { sharedSchema } from "./shared";

/**
 * The frontend's server side. Note what is NOT here: no database, no Redis, no
 * LDAP. The frontend holds the session cookie and proxies; every privileged
 * thing lives in the backend and nowhere else.
 */
export const frontendSchema = sharedSchema.extend({
  FRONTEND_PORT: intFromEnv({ min: 1, max: 65_535 }).default(3000),

  /** Server-to-server. The browser never sees this address. */
  BACKEND_INTERNAL_URL: z.string().url().default("http://localhost:3001"),

  /**
   * The browser DOES see this one: the terminal WebSocket bypasses the proxy and
   * connects to the backend directly, because a route handler cannot hold a
   * socket open for the life of a run (ADR-007).
   */
  NEXT_PUBLIC_TERMINAL_WS_URL: z.string().url().default("ws://localhost:3001"),

  PROXY_TIMEOUT_MS: intFromEnv({ min: 1000 }).default(30_000),
});

export const loadFrontendConfig = defineConfig("frontend", frontendSchema);
export type FrontendConfig = z.infer<typeof frontendSchema>;
