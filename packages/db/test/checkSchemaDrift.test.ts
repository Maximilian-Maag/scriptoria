import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { findSchemaDrift } from "../src/checkSchemaDrift";
import type { Database } from "../src/client";
import * as schema from "../src/schema";

/**
 * The regression test for the schema drift check.
 *
 * `checkSchemaDrift.ts` used to ask only whether an index *name* existed, so a
 * UNIQUE index replaced by a plain one of the same name passed, and so did an
 * enum whose value had been renamed — both of which the check exists to catch,
 * and both of which surface as a runtime `PostgresError` rather than at
 * `make db-check`. These cases build a database from the real migrations, make
 * one of those mutations by hand, and assert that the check reports it.
 *
 * The database is built per case and dropped afterwards, so nothing here
 * touches the database `DATABASE_URL` names — it is only the server to create
 * a scratch database on. Needs a Postgres superuser, which is what CI's
 * service container and the dev stack both provide; skipped when there is no
 * `DATABASE_URL` at all.
 */

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run the schema drift suite");
  return url;
}

/** The same server and credentials, a different database. */
function scratchUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

let sequence = 0;

/**
 * Run `check` against a database freshly built by the migrations, then drop it.
 * Each case starts from the schema the migrations actually produce, so a case
 * cannot be rescued by a mutation another case left behind.
 */
async function withMigratedDatabase(check: (database: Database) => Promise<void>): Promise<void> {
  const url = baseUrl();
  const name = `scriptoria_drift_${process.pid}_${sequence++}`;

  const admin = postgres(url, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const client = postgres(scratchUrl(url, name), { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    await check(drizzle(client, { schema }));
  } finally {
    await client.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase("schema drift check", () => {
  it("agrees with a database the migrations built", async () => {
    await withMigratedDatabase(async (database) => {
      expect(await findSchemaDrift(database)).toEqual([]);
    });
  });

  it("catches a UNIQUE index replaced by a plain one of the same name", async () => {
    await withMigratedDatabase(async (database) => {
      await database.execute(sql`DROP INDEX areas_name_key`);
      await database.execute(sql`CREATE INDEX areas_name_key ON areas (name)`);

      const drift = await findSchemaDrift(database);
      expect(drift.join("\n")).toContain(
        "areas: index areas_name_key is declared UNIQUE, the database has it without UNIQUE",
      );
    });
  });

  it("catches an index moved to another column", async () => {
    await withMigratedDatabase(async (database) => {
      await database.execute(sql`DROP INDEX runs_status_idx`);
      await database.execute(sql`CREATE INDEX runs_status_idx ON runs (started_by)`);

      const drift = await findSchemaDrift(database);
      expect(drift.join("\n")).toContain(
        "runs: index runs_status_idx is declared on (status), the database has it on (started_by)",
      );
    });
  });

  it("catches a renamed enum value", async () => {
    await withMigratedDatabase(async (database) => {
      await database.execute(sql`ALTER TYPE run_event_kind RENAME VALUE 'pty_opened' TO 'ptyopened'`);

      const drift = await findSchemaDrift(database);
      const reported = drift.join("\n");
      expect(reported).toContain("enum run_event_kind");
      expect(reported).toContain("pty_opened");
      expect(reported).toContain("ptyopened");
    });
  });

  it("still catches a dropped index", async () => {
    await withMigratedDatabase(async (database) => {
      await database.execute(sql`DROP INDEX run_events_run_idx`);

      const drift = await findSchemaDrift(database);
      expect(drift.join("\n")).toContain(
        "run_events: index run_events_run_idx is declared but missing from the database",
      );
    });
  });
});
