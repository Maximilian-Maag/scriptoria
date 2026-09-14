import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadBackendConfig } from "@scriptoria/config";
import * as schema from "./schema";

/**
 * One pool per process, created lazily.
 *
 * Lazily because the backend is a Next.js app and its modules are imported by
 * the build as well as by the server; opening a socket at import time turns a
 * `next build` into something that needs a database.
 */

let client: postgres.Sql | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function db() {
  if (!database) {
    const config = loadBackendConfig();
    client = postgres(config.DATABASE_URL, {
      max: config.DATABASE_POOL_MAX,
      // The runner holds the long-lived connections in this system; nothing here
      // should sit on a database socket waiting for a PTY.
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
    database = drizzle(client, { schema });
  }
  return database;
}

/** For tests and for the shutdown path in server.ts. */
export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
  database = undefined;
}

export { schema };
export type Database = ReturnType<typeof db>;
