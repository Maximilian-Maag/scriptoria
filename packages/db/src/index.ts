/**
 * The only package that speaks SQL.
 *
 * It is a package rather than a folder inside the control plane because two
 * processes write to this database: the control plane, and the runner. The
 * runner is the one that knows when a PTY opened, when the process behind it
 * exited and what the output directory contained afterwards — so the run state
 * transitions, the run events and the result records are written there (see the
 * Runner components in docs/architecture/workspace.dsl).
 *
 * Everything above this package takes and returns contract types, so a schema
 * change stops here.
 */
export { db, closeDb, schema, type Database } from "./client";

export * as areaRepository from "./repositories/areaRepository";
export * as auditRepository from "./repositories/auditRepository";
export * as runRepository from "./repositories/runRepository";
export * as scriptRepository from "./repositories/scriptRepository";
export * as resultRepository from "./repositories/resultRepository";

export type { AuditInput } from "./repositories/auditRepository";
export type { ScannedScript } from "./repositories/scriptRepository";
export type { CollectedFile } from "./repositories/resultRepository";
