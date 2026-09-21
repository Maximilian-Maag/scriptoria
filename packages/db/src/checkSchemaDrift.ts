import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { closeDb, db, schema } from "./client";
import { loadEnvFile } from "@scriptoria/config";

/**
 * Does the database the migrations build match the database the code believes in?
 *
 * `schema.ts` and `drizzle/*.sql` are two descriptions of one database, and
 * nothing else compares them. They drifted once already: the directory-group
 * columns were renamed in the schema with no migration to follow, so a database
 * built by `make db-migrate` had `admin_groups.ad_group` where every query read
 * `root_groups.directory_group`. Nothing failed until somebody tried to sign in
 * — the login path is what reads both tables — and by then the answer was a
 * `PostgresError` from a route handler.
 *
 * So this asks the database itself, after the migrations have run. That is the
 * question that matters: not "is the snapshot committed" but "does the thing the
 * application will talk to have the shape the application expects".
 *
 * Run by `make db-check` against a database that has been migrated. Column
 * *types* are deliberately not compared — Postgres renders them back in its own
 * words (`timestamp with time zone`, `character varying`) and a string match
 * there would fail for reasons that are not drift. Names, nullability and
 * indexes are what a rename, a forgotten migration or a hand-edited schema
 * actually change.
 */

loadEnvFile();

const TABLES: PgTable[] = [
  schema.areas,
  schema.scriptSources,
  schema.areaEntitlements,
  schema.rootGroups,
  schema.scripts,
  schema.runs,
  schema.runEvents,
  schema.runTranscripts,
  schema.runResults,
  schema.auditLog,
];

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: string;
  [column: string]: unknown;
}

async function main(): Promise<number> {
  const rows = await db().execute<ColumnRow>(sql`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);

  const live = new Map<string, Map<string, ColumnRow>>();
  for (const row of rows) {
    const table = live.get(row.table_name) ?? new Map<string, ColumnRow>();
    table.set(row.column_name, row);
    live.set(row.table_name, table);
  }

  const drift: string[] = [];

  for (const table of TABLES) {
    const config = getTableConfig(table);
    const actual = live.get(config.name);

    if (!actual) {
      drift.push(`table ${config.name}: the code declares it, the database has no such table`);
      continue;
    }

    const declared = new Set(config.columns.map((column) => column.name));

    for (const column of config.columns) {
      const found = actual.get(column.name);
      if (!found) {
        drift.push(
          `${config.name}.${column.name}: the code declares it, the database has no such column`,
        );
        continue;
      }
      const nullable = found.is_nullable === "YES";
      if (nullable === column.notNull) {
        drift.push(
          `${config.name}.${column.name}: declared ${column.notNull ? "NOT NULL" : "nullable"}, ` +
            `the database says ${nullable ? "nullable" : "NOT NULL"}`,
        );
      }
    }

    for (const name of actual.keys()) {
      if (!declared.has(name)) {
        drift.push(`${config.name}.${name}: in the database, not in schema.ts`);
      }
    }

    for (const index of config.indexes) {
      const name = index.config.name;
      if (!name) continue;
      const present = await db().execute(
        sql`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`,
      );
      if (present.length === 0) {
        drift.push(`${config.name}: index ${name} is declared but missing from the database`);
      }
    }
  }

  if (drift.length > 0) {
    console.error("schema.ts and the migrated database disagree:");
    for (const line of drift) console.error(`  ${line}`);
    console.error(
      "\nThe migrations are what build a deployment's database, so a difference here is drift to " +
        "resolve in `drizzle/`: run `make db-generate`, review what it writes, and commit it.",
    );
    return 1;
  }

  console.log(`schema.ts and the migrated database agree (${TABLES.length} tables checked)`);
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  await closeDb();
}
