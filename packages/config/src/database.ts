import { z } from "zod";
import { defineConfig, intFromEnv } from "./load";

/**
 * Two processes speak SQL — the control plane and the runner. The runner writes
 * run state transitions, run events and result records, because it is the only
 * process that knows when a PTY opened and when the process behind it exited.
 *
 * So the connection schema lives here rather than in `backend.ts`, and
 * `@scriptoria/db` loads it directly. A package that reached for
 * `loadBackendConfig()` would be a package that cannot be imported by the runner.
 */
export const databaseSchema = z.object({
  DATABASE_URL: z.string().url().default("postgres://postgres:postgres@localhost:5432/scriptoria"),
  DATABASE_POOL_MAX: intFromEnv({ min: 1 }).default(10),
});

export const loadDatabaseConfig = defineConfig("database", databaseSchema);
export type DatabaseConfig = z.infer<typeof databaseSchema>;
