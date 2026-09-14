import { z } from "zod";

/**
 * FA-12 / NFR-05. Who started what, where, when, with what outcome, what was
 * aborted and what was downloaded — plus every administrative change to areas,
 * path mappings and group entitlements.
 */

export const auditActionSchema = z.enum([
  "login_succeeded",
  "login_failed",
  "logout",

  "run_started",
  "run_aborted",
  "run_finished",

  "result_downloaded",
  "result_archive_downloaded",

  "area_created",
  "area_updated",
  "area_deleted",
  "source_added",
  "source_removed",
  "entitlement_granted",
  "entitlement_revoked",
  "script_criticality_overridden",
  "schedule_updated",
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  at: z.string().datetime({ offset: true }),

  /** The AD account. Never an internal id — this log is read by people. */
  actor: z.string(),
  action: auditActionSchema,

  /** What was acted on, in the caller's own vocabulary: an area name, a file name. */
  subject: z.string(),
  areaId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),

  outcome: z.enum(["success", "failure"]),

  /**
   * Action-specific detail — the abort stage, the downloaded file count, the old
   * and new criticality. JSONB in the database; never used for filtering, only
   * for reading back what happened.
   */
  detail: z.record(z.unknown()).default({}),

  /** From the reverse proxy. Part of "where" in FA-12.1. */
  sourceIp: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditQuerySchema = z.object({
  actor: z.string().trim().max(256).optional(),
  action: auditActionSchema.optional(),
  areaId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
