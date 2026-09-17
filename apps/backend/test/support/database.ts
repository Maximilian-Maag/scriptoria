import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { loadEnvFile } from "@scriptoria/config";

/**
 * A real Postgres, on its own database, created on first use.
 *
 * Real rather than mocked, because what these tests are for is the part a mock
 * would have to assume: that the *query* is bounded by the caller's areas. A
 * repository stubbed to return the right rows proves that the service returns
 * what the stub returned. The one bug worth catching here — a `where` clause
 * that quietly stops filtering — is invisible to that.
 *
 * One database per working directory, so a second checkout running its own
 * suite cannot truncate this one's tables mid-test. `make test-db-prune` drops
 * them by that prefix.
 */

loadEnvFile();

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5433/scriptoria";

const suffix = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8);
export const TEST_DATABASE = `scriptoria_test_${suffix}`;

const base = process.env["DATABASE_URL"] ?? DEFAULT_URL;
const urlFor = (name: string): string => base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);

export const TEST_DATABASE_URL = urlFor(TEST_DATABASE);

/**
 * Creating a database cannot happen inside a connection to it, so this one
 * connects to the cluster's own `postgres` database to ask.
 */
async function ensureDatabase(): Promise<void> {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    const [existing] = await admin`select 1 from pg_database where datname = ${TEST_DATABASE}`;
    if (!existing) {
      // Identifiers cannot be parameterised; the name is a hash of a local path
      // and matches the same pattern the Makefile prunes by.
      await admin.unsafe(`create database "${TEST_DATABASE}"`);
    }
  } catch (cause) {
    throw new Error(
      `could not reach Postgres at ${urlFor("postgres").replace(/:[^:@]+@/, ":***@")}. ` +
        "The backend suite needs the dev stack: `make dev`.",
      { cause },
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export async function prepareDatabase(): Promise<void> {
  await ensureDatabase();

  // Every service resolves its connection through this, lazily, so setting it
  // before the first query is enough — nothing has opened a pool yet.
  process.env["DATABASE_URL"] = TEST_DATABASE_URL;

  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const migrationsFolder = fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    );
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Empties every table between tests. `truncate … cascade` rather than deleting
 * in dependency order: the order is a fact about the schema, and a test helper
 * that has to be updated when a foreign key is added is a test helper that will
 * not be.
 */
export async function truncateAll(): Promise<void> {
  const { db } = await import("@scriptoria/db");
  const rows = await db().execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  const names = [...rows].map((row) => `"${row.tablename}"`).join(", ");
  if (names) await db().execute(sql.raw(`truncate table ${names} restart identity cascade`));
}
