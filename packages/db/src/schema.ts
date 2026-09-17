import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ScriptHeader } from "@scriptoria/contracts";

/**
 * The metadata database. Relational with real foreign keys; script headers and
 * run detail as JSONB.
 *
 * What is *not* here is as deliberate as what is. There is no account table and
 * no group table — the platform is never authoritative for either (NFR-03,
 * NFR-04), and a table here would become a second truth the moment somebody
 * deleted an account in the directory. Groups appear only as names the root
 * account mapped onto an area, and usernames appear only as strings in run and
 * audit records, which are history rather than identity.
 */

export const areaCategory = pgEnum("area_category", ["one-off", "recurring"]);
export const criticality = pgEnum("criticality", ["read-only", "modifying", "unknown"]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "aborted",
]);
export const runTrigger = pgEnum("run_trigger", ["manual", "scheduled"]);
export const runEventKind = pgEnum("run_event_kind", [
  "queued",
  "claimed",
  "connected",
  "pty_opened",
  "started",
  "abort_requested",
  "abort_signalled",
  "exited",
  "collected",
  "error",
]);
export const abortStage = pgEnum("abort_stage", ["sigint", "sigterm", "sigkill"]);
export const auditOutcome = pgEnum("audit_outcome", ["success", "failure"]);

// ── Areas ────────────────────────────────────────────────────────────────────

export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: areaCategory("category").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("areas_name_key").on(table.name)],
);

/**
 * FA-11.2 — an area's scripts, by host and path.
 *
 * Normally every area points at the same script VM and differs only in its
 * directory. The host is still part of the mapping rather than a global setting,
 * because NFR-07 allows a second script VM where two sets of scripts need
 * runtimes that cannot coexist — and a global setting would have to be unpicked
 * to allow it.
 */
export const scriptSources = pgTable(
  "script_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull(),
    scriptPath: text("script_path").notNull(),
    outputPath: text("output_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("script_sources_area_idx").on(table.areaId),
    uniqueIndex("script_sources_unique").on(table.areaId, table.host, table.scriptPath),
  ],
);

/**
 * FA-11.3/11.4 — a *reference* to a directory group by name. No member list is
 * stored and none ever will be: membership is resolved from the directory at
 * every login.
 */
export const areaEntitlements = pgTable(
  "area_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    directoryGroup: text("directory_group").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("area_entitlements_area_idx").on(table.areaId),
    // Lower-cased, because directories are case-insensitive about group names
    // and a duplicate that differs only in case is a duplicate.
    uniqueIndex("area_entitlements_unique").on(table.areaId, sql`lower(${table.directoryGroup})`),
  ],
);

/**
 * Which directory groups hold the root account. A table rather than an
 * environment variable because `make db-seed` has to put the first one there and
 * because changing who can administer the platform must be an audited act, not a
 * redeploy.
 */
export const rootGroups = pgTable(
  "root_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    directoryGroup: text("directory_group").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("root_groups_unique").on(sql`lower(${table.directoryGroup})`)],
);

// ── Catalog ──────────────────────────────────────────────────────────────────

/**
 * The scanner's cache (ADR-004). The script VM's filesystem is the truth; this
 * is what was last read from it, so the catalog renders without an SSH round
 * trip per page load.
 */
export const scripts = pgTable(
  "scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => scriptSources.id, { onDelete: "cascade" }),

    fileName: text("file_name").notNull(),
    absolutePath: text("absolute_path").notNull(),

    /** Exactly what the header block declared, or null when it declared nothing. */
    header: jsonb("header").$type<ScriptHeader | null>(),

    /** An admin's correction. Null means the header decides (ADR-004). */
    criticalityOverride: criticality("criticality_override"),
    criticalityOverrideReason: text("criticality_override_reason"),

    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * A script that disappeared from the directory is kept, not deleted — its
     * run history references it, and FA-12 wants that history to stay readable.
     */
    presentAt: timestamp("present_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scripts_area_idx").on(table.areaId),
    uniqueIndex("scripts_source_file_key").on(table.sourceId, table.fileName),
  ],
);

// ── Runs ─────────────────────────────────────────────────────────────────────

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "restrict" }),
    scriptId: uuid("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "restrict" }),

    /**
     * Denormalised on purpose. A run list must render without the catalog, and
     * the criticality recorded here is the one that applied *at start time* —
     * a later override must not rewrite what the operator was warned about.
     */
    scriptFileName: text("script_file_name").notNull(),
    scriptTitle: text("script_title").notNull(),
    criticality: criticality("criticality").notNull(),
    host: text("host").notNull(),
    outputPath: text("output_path").notNull(),

    status: runStatus("status").notNull().default("queued"),
    trigger: runTrigger("trigger").notNull().default("manual"),

    /** The AD account. FA-12.1's "who". */
    startedBy: text("started_by").notNull(),

    /** Which worker holds the PTY, so an orphan is attributable. */
    workerId: text("worker_id"),

    cols: integer("cols").notNull().default(80),
    rows: integer("rows").notNull().default(24),

    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    exitCode: integer("exit_code"),
    failureReason: text("failure_reason"),

    /** How far the stream got, so a reconnecting client knows where to resume. */
    lastStreamId: text("last_stream_id"),

    abortRequestedBy: text("abort_requested_by"),
    abortRequestedAt: timestamp("abort_requested_at", { withTimezone: true }),
    /** The stage the escalation actually reached (ADR-003). */
    abortStage: abortStage("abort_stage"),

    resultCount: integer("result_count"),
  },
  (table) => [
    index("runs_area_queued_idx").on(table.areaId, table.queuedAt),
    index("runs_script_idx").on(table.scriptId),
    index("runs_status_idx").on(table.status),
    index("runs_started_by_idx").on(table.startedBy),
  ],
);

/** What the *platform* did, as opposed to what the process printed. */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: runEventKind("kind").notNull(),
    stage: abortStage("stage"),
    message: text("message").notNull().default(""),
  },
  (table) => [index("run_events_run_idx").on(table.runId, table.at)],
);

/**
 * ADR-006 — the terminal history, persisted once when the run ends so the capped
 * Redis stream may expire without taking FA-07.2's scrollback with it.
 *
 * Base64 in a text column, because the payload is PTY bytes. Storing it as text
 * would mean decoding it, and decoding a byte stream that contains ANSI escapes
 * and arbitrary UTF-8 boundaries is the exact corruption ADR-006 exists to
 * prevent — it would just happen on the way into the database instead of on the
 * way to the browser.
 */
export const runTranscripts = pgTable("run_transcripts", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  /** True when the run outran STREAM_MAXLEN and the head was trimmed. */
  truncated: boolean("truncated").notNull().default(false),
  persistedAt: timestamp("persisted_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the collector found in the output directory. A record, not the file —
 * the files stay on the script VM and are streamed through SFTP on request.
 */
export const runResults = pgTable(
  "run_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    contentType: text("content_type").notNull(),
    modifiedAt: timestamp("modified_at", { withTimezone: true }).notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("run_results_unique").on(table.runId, table.path)],
);

// ── Audit ────────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    subject: text("subject").notNull().default(""),
    areaId: uuid("area_id").references(() => areas.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    outcome: auditOutcome("outcome").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    sourceIp: text("source_ip"),
  },
  (table) => [
    index("audit_log_at_idx").on(table.at),
    index("audit_log_actor_idx").on(table.actor),
    index("audit_log_action_idx").on(table.action),
    index("audit_log_run_idx").on(table.runId),
  ],
);

// ── Relations ────────────────────────────────────────────────────────────────

export const areasRelations = relations(areas, ({ many }) => ({
  sources: many(scriptSources),
  entitlements: many(areaEntitlements),
  scripts: many(scripts),
}));

export const scriptSourcesRelations = relations(scriptSources, ({ one, many }) => ({
  area: one(areas, { fields: [scriptSources.areaId], references: [areas.id] }),
  scripts: many(scripts),
}));

export const areaEntitlementsRelations = relations(areaEntitlements, ({ one }) => ({
  area: one(areas, { fields: [areaEntitlements.areaId], references: [areas.id] }),
}));

export const scriptsRelations = relations(scripts, ({ one, many }) => ({
  area: one(areas, { fields: [scripts.areaId], references: [areas.id] }),
  source: one(scriptSources, { fields: [scripts.sourceId], references: [scriptSources.id] }),
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  area: one(areas, { fields: [runs.areaId], references: [areas.id] }),
  script: one(scripts, { fields: [runs.scriptId], references: [scripts.id] }),
  events: many(runEvents),
  results: many(runResults),
  transcript: one(runTranscripts, {
    fields: [runs.id],
    references: [runTranscripts.runId],
  }),
}));

export const runEventsRelations = relations(runEvents, ({ one }) => ({
  run: one(runs, { fields: [runEvents.runId], references: [runs.id] }),
}));

export const runResultsRelations = relations(runResults, ({ one }) => ({
  run: one(runs, { fields: [runResults.runId], references: [runs.id] }),
}));

export type AreaRow = typeof areas.$inferSelect;
export type ScriptSourceRow = typeof scriptSources.$inferSelect;
export type AreaEntitlementRow = typeof areaEntitlements.$inferSelect;
export type ScriptRow = typeof scripts.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type RunResultRow = typeof runResults.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
