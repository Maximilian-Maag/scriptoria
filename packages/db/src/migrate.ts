import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadDatabaseConfig, loadEnvFile } from "@scriptoria/config";

loadEnvFile();

/**
 * Applies pending migrations and exits. Run by `make db-migrate` and by the
 * deployment unit before the app starts — never by the app itself, so that two
 * replicas coming up at once cannot race each other through the same DDL.
 */
const config = loadDatabaseConfig();
const client = postgres(config.DATABASE_URL, { max: 1 });

try {
  // Resolved against this file rather than the working directory: the
  // deployment unit runs this before the app starts, from wherever the service
  // manager happens to put it.
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(drizzle(client), { migrationsFolder });
  console.log("migrations applied");
} finally {
  await client.end();
}
