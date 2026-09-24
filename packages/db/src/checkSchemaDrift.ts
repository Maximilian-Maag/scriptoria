import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { closeDb, db, schema, type Database } from "./client";
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
 * Run by `make db-check` against a database that has been migrated. What is
 * compared is the shape that a rename, a forgotten migration or a hand-edited
 * schema actually changes: table and column names, nullability, index
 * *uniqueness* and the keys an index is on, and the labels of every enum — in
 * order, because a value inserted in the middle sorts differently even though
 * the set is the same. `areas_name_key` declared UNIQUE but created without
 * `UNIQUE` is drift, and so is `run_event_kind` missing a label `schema.ts`
 * names; both used to pass, and both surface as a runtime `PostgresError`.
 *
 * Column *types* are deliberately not compared — Postgres renders them back in
 * its own words (`timestamp with time zone`, `character varying`) and a string
 * match there would fail for reasons that are not drift.
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

interface IndexRow {
  index_name: string;
  is_unique: boolean;
  definition: string;
  [column: string]: unknown;
}

interface EnumRow {
  enum_name: string;
  labels: string[];
  [column: string]: unknown;
}

/**
 * A key of an index as `schema.ts` declares it: a plain column, which drizzle
 * wraps in an `IndexedColumn` carrying just its name, or a `sql` fragment.
 */
interface ColumnLike {
  name: string;
}

function isColumn(value: unknown): value is ColumnLike {
  const candidate = value as Partial<ColumnLike> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.name === "string";
}

/**
 * A `uniqueIndex(...)` key is either a column — which knows its own name — or a
 * `sql` fragment such as `lower(${table.directoryGroup})`. Rendering both to the
 * form Postgres writes in `pg_get_indexdef` is what makes the declared and the
 * live index comparable at all: `["area_id", "lower(directory_group)"]`.
 */
function renderIndexKey(key: unknown): string {
  if (isColumn(key)) return key.name;
  return renderSqlChunks(key);
}

function renderSqlChunks(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return "";
  return chunks.map(renderChunk).join("");
}

function renderChunk(chunk: unknown): string {
  if (isColumn(chunk)) return chunk.name;
  const value = (chunk as { value?: unknown } | null)?.value;
  if (Array.isArray(value)) return value.map(String).join("");
  return renderSqlChunks(chunk);
}

/**
 * Postgres quotes identifiers, writes its own spacing, and lower-cases what it
 * stores; none of that is a difference worth failing a build over, so both
 * sides are flattened before they are compared.
 */
function normalise(fragment: string): string {
  return fragment.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The key list out of `pg_get_indexdef`. Scanned rather than split on the last
 * parentheses because an expression key brings its own — `lower(directory_group)`
 * — so the list is the first balanced pair after `USING <method>`, and the
 * commas that separate keys are the ones at depth zero.
 */
function indexKeysFromDefinition(definition: string): string[] {
  const using = /USING\s+\w+\s*\(/i.exec(definition);
  if (!using) return [];
  const start = definition.indexOf("(", using.index);

  let end = -1;
  let depth = 0;
  for (let i = start; i < definition.length; i++) {
    if (definition[i] === "(") depth++;
    else if (definition[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];

  const keys: string[] = [];
  let current = "";
  let nested = 0;
  for (const character of definition.slice(start + 1, end)) {
    if (character === "(") nested++;
    if (character === ")") nested--;
    if (character === "," && nested === 0) {
      keys.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  keys.push(current);

  return keys.map(normalise).filter((key) => key.length > 0);
}

/**
 * Every enum the checked tables use, read off the columns that use it rather
 * than kept as a second list next to `TABLES` — a list here would be one more
 * thing a new enum could be forgotten in, which is the class of mistake this
 * file exists to catch.
 */
function declaredEnums(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const table of TABLES) {
    for (const column of getTableConfig(table).columns) {
      const node = column as unknown as { enum?: { enumName: string; enumValues: string[] } };
      if (node.enum) found.set(node.enum.enumName, node.enum.enumValues);
    }
  }
  return found;
}

/** Everything about the migrated database that `schema.ts` makes a promise about. */
export async function findSchemaDrift(database: Database): Promise<string[]> {
  const columnRows = await database.execute<ColumnRow>(sql`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);

  const live = new Map<string, Map<string, ColumnRow>>();
  for (const row of columnRows) {
    const table = live.get(row.table_name) ?? new Map<string, ColumnRow>();
    table.set(row.column_name, row);
    live.set(row.table_name, table);
  }

  const indexRows = await database.execute<IndexRow>(sql`
    SELECT c.relname AS index_name,
           i.indisunique AS is_unique,
           pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT i.indisprimary
  `);
  const liveIndexes = new Map(indexRows.map((row) => [row.index_name, row]));

  const enumRows = await database.execute<EnumRow>(sql`
    SELECT t.typname AS enum_name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
  `);
  const liveEnums = new Map(enumRows.map((row) => [row.enum_name, row.labels]));

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

      const present = liveIndexes.get(name);
      if (!present) {
        drift.push(`${config.name}: index ${name} is declared but missing from the database`);
        continue;
      }

      const declaredUnique = index.config.unique === true;
      const actualUnique = present.is_unique === true;
      if (declaredUnique !== actualUnique) {
        drift.push(
          `${config.name}: index ${name} is declared ${declaredUnique ? "UNIQUE" : "without UNIQUE"}, ` +
            `the database has it ${actualUnique ? "UNIQUE" : "without UNIQUE"}`,
        );
      }

      const declaredKeys = index.config.columns.map(renderIndexKey).map(normalise);
      const actualKeys = indexKeysFromDefinition(present.definition);
      if (declaredKeys.join(",") !== actualKeys.join(",")) {
        drift.push(
          `${config.name}: index ${name} is declared on (${declaredKeys.join(", ")}), ` +
            `the database has it on (${actualKeys.join(", ")})`,
        );
      }
    }
  }

  for (const [name, labels] of declaredEnums()) {
    const actualLabels = liveEnums.get(name);
    if (!actualLabels) {
      drift.push(`enum ${name}: the code declares it, the database has no such type`);
      continue;
    }
    if (labels.join(",") !== actualLabels.join(",")) {
      drift.push(
        `enum ${name}: declared (${labels.join(", ")}), the database has (${actualLabels.join(", ")})`,
      );
    }
  }

  return drift;
}

async function main(): Promise<number> {
  const drift = await findSchemaDrift(db());

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

// Only when this file is the entrypoint: the regression suite in
// `test/checkSchemaDrift.test.ts` imports `findSchemaDrift` and drives it
// against a database of its own making.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } finally {
    await closeDb();
  }
}
