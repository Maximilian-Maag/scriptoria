import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadBackendConfig } from "@scriptoria/config";
import { loadEnvFile } from "@scriptoria/config";

loadEnvFile();

/**
 * Applies pending migrations and exits. Run by `make db-migrate` and by the
 * deployment unit before the app starts — never by the app itself, so that two
 * replicas coming up at once cannot race each other through the same DDL.
 */
const config = loadBackendConfig();
const client = postgres(config.DATABASE_URL, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
} finally {
  await client.end();
}
